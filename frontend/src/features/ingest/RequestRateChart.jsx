import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../../components/Icon.jsx'
import { formatInt } from '../../lib/format.js'

/** Outcome classes are status (good / warning / critical), so they use the reserved status palette with icon + label. */
const SERIES = [
  { key: 'success', label: 'Accepted (2xx)', color: 'var(--good)', icon: 'checkCircle', tone: 'good' },
  { key: 'retryable', label: 'Retried (429 / 5xx / network)', color: 'var(--warning)', icon: 'retry', tone: 'warning' },
  { key: 'failed', label: 'Refused (400 / other 4xx)', color: 'var(--critical)', icon: 'xCircle', tone: 'critical' },
]

const PLOT_HEIGHT = 190
const MARGIN = { top: 14, right: 70, bottom: 28, left: 34 }
const MIN_BAND = 8
const MAX_BAR = 24
const GAP = 2
const MIN_SECONDS = 10

function bucketize(requests, elapsedMs) {
  let lastMs = elapsedMs
  for (const request of requests) lastMs = Math.max(lastMs, request.sentAtMs + 1)
  const seconds = Math.max(MIN_SECONDS, Math.ceil(lastMs / 1000))
  const buckets = Array.from({ length: seconds }, (_, second) => ({ second, success: 0, retryable: 0, failed: 0, total: 0 }))
  for (const request of requests) {
    const bucket = buckets[Math.min(seconds - 1, Math.floor(request.sentAtMs / 1000))]
    const key = request.outcome === 'success' ? 'success' : request.outcome === 'retryable' ? 'retryable' : 'failed'
    bucket[key] += 1
    bucket.total += 1
  }
  return buckets
}

const yStep = (max) => (max <= 7 ? 1 : max <= 14 ? 2 : max <= 35 ? 5 : 10)

function xLabelEvery(band) {
  for (const every of [1, 2, 5, 10, 15, 30, 60, 120, 300]) if (every * band >= 44) return every
  return 600
}

/** Column segment with a rounded data end (top) and a square base. */
function roundedTopPath(x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height)
  return `M${x},${y + height}V${y + r}Q${x},${y} ${x + r},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${y + height}Z`
}

function stackSegments(bucket, yScale) {
  const segments = []
  let cursor = yScale(0)
  for (const series of SERIES) {
    const count = bucket[series.key]
    if (!count) continue
    const height = yScale(0) - yScale(count)
    segments.push({ series, y: cursor - height, height })
    cursor -= height
  }
  // 2px surface gap between stacked segments: each upper segment gives up its bottom 2px.
  return segments.map((segment, index) => (index === 0 ? segment : { ...segment, height: Math.max(1, segment.height - GAP) }))
}

export function RequestRateChart({ requests, elapsedMs, limit, live }) {
  const frameRef = useRef(null)
  const [width, setWidth] = useState(760)
  const [active, setActive] = useState(null)
  const [view, setView] = useState('chart')

  useEffect(() => {
    const element = frameRef.current
    if (!element) return undefined
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(320, Math.floor(entry.contentRect.width))))
    observer.observe(element)
    return () => observer.disconnect()
  }, [view])

  const buckets = useMemo(() => bucketize(requests, elapsedMs), [requests, elapsedMs])
  const totals = useMemo(() => {
    const sum = { success: 0, retryable: 0, failed: 0 }
    for (const bucket of buckets) for (const series of SERIES) sum[series.key] += bucket[series.key]
    return sum
  }, [buckets])

  // Window to what fits; the full per-second history stays available in the table view.
  const plotWidth = width - MARGIN.left - MARGIN.right
  const capacity = Math.max(MIN_SECONDS, Math.floor(plotWidth / MIN_BAND))
  const visible = buckets.length > capacity ? buckets.slice(-capacity) : buckets
  const offset = visible[0]?.second ?? 0
  const band = plotWidth / visible.length
  const barWidth = Math.max(2, Math.min(MAX_BAR, band - GAP))
  const peak = visible.reduce((max, bucket) => Math.max(max, bucket.total), 0)
  const step = yStep(Math.max(limit + 1, peak))
  const yTop = Math.ceil(Math.max(limit + 1, peak) / step) * step
  const yScale = (value) => MARGIN.top + PLOT_HEIGHT - (value / yTop) * PLOT_HEIGHT
  const xScale = (second) => MARGIN.left + (second - offset) * band
  const svgHeight = MARGIN.top + PLOT_HEIGHT + MARGIN.bottom
  const labelEvery = xLabelEvery(band)
  const ticks = Array.from({ length: yTop / step + 1 }, (_, index) => index * step)
  const activeBucket = active === null ? null : visible[active]

  const pickFromPointer = (event) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const localX = ((event.clientX - rect.left) / rect.width) * width
    const index = Math.floor((localX - MARGIN.left) / band)
    setActive(index >= 0 && index < visible.length ? index : null)
  }

  const onKeyDown = (event) => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault()
      const delta = event.key === 'ArrowRight' ? 1 : -1
      setActive((current) => Math.min(visible.length - 1, Math.max(0, (current ?? (delta > 0 ? -1 : visible.length)) + delta)))
    } else if (event.key === 'Escape') {
      setActive(null)
    }
  }

  const tooltipLeft = activeBucket ? ((xScale(activeBucket.second) + band / 2) / width) * 100 : 0
  const flip = tooltipLeft > 60

  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
        <div className="legend" style={{ marginTop: 0 }}>
          {SERIES.map((series) => (
            <span className="legend-item" key={series.key}>
              <span className="swatch" style={{ background: series.color }} />
              <Icon name={series.icon} size={13} className={`tone-${series.tone}`} />
              {series.label}
              <strong>{formatInt(totals[series.key])}</strong>
            </span>
          ))}
        </div>
        <div className="segmented" role="group" aria-label="Chart or table">
          <button type="button" aria-pressed={view === 'chart'} onClick={() => setView('chart')}>
            <Icon name="chart" size={14} />
            Chart
          </button>
          <button type="button" aria-pressed={view === 'table'} onClick={() => setView('table')}>
            <Icon name="table" size={14} />
            Table
          </button>
        </div>
      </div>

      {view === 'table' ? (
        <div className="table-wrap" style={{ maxHeight: 280 }}>
          <table className="table">
            <thead>
              <tr>
                <th>Second</th>
                {SERIES.map((series) => (
                  <th key={series.key} className="th-num">
                    {series.label}
                  </th>
                ))}
                <th className="th-num">Requests started</th>
              </tr>
            </thead>
            <tbody>
              {buckets
                .filter((bucket) => bucket.total > 0)
                .map((bucket) => (
                  <tr key={bucket.second}>
                    <td className="nowrap">
                      {bucket.second}–{bucket.second + 1} s
                    </td>
                    {SERIES.map((series) => (
                      <td key={series.key} className="num">
                        {bucket[series.key]}
                      </td>
                    ))}
                    <td className="num">
                      <strong>{bucket.total}</strong>
                      {bucket.total > limit ? ' (over limit)' : ''}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div
          ref={frameRef}
          className="viz"
          tabIndex={0}
          role="group"
          aria-label={`Requests started per second over ${buckets.length} seconds. Peak ${peak} per second against a limit of ${limit}. Use the arrow keys to inspect each second, or switch to the table view.`}
          onKeyDown={onKeyDown}
          onBlur={() => setActive(null)}
        >
          <svg
            viewBox={`0 0 ${width} ${svgHeight}`}
            width={width}
            height={svgHeight}
            onPointerMove={pickFromPointer}
            onPointerLeave={() => setActive(null)}
          >
            {ticks.map((tick) => (
              <g key={tick}>
                {tick > 0 && <line className="viz-grid" x1={MARGIN.left} x2={MARGIN.left + plotWidth} y1={yScale(tick)} y2={yScale(tick)} />}
                <text className="viz-axis-label" x={MARGIN.left - 8} y={yScale(tick) + 4} textAnchor="end">
                  {tick}
                </text>
              </g>
            ))}

            {activeBucket && (
              <rect className="viz-hover-band" x={xScale(activeBucket.second)} y={MARGIN.top} width={band} height={PLOT_HEIGHT} />
            )}

            {visible.map((bucket) =>
              stackSegments(bucket, yScale).map((segment, index, all) => {
                const x = xScale(bucket.second) + (band - barWidth) / 2
                return index === all.length - 1 ? (
                  <path key={segment.series.key + bucket.second} d={roundedTopPath(x, segment.y, barWidth, segment.height, 4)} fill={segment.series.color} />
                ) : (
                  <rect key={segment.series.key + bucket.second} x={x} y={segment.y} width={barWidth} height={segment.height} fill={segment.series.color} />
                )
              }),
            )}

            <line className="viz-baseline" x1={MARGIN.left} x2={MARGIN.left + plotWidth} y1={yScale(0)} y2={yScale(0)} />

            <line className="viz-limit" x1={MARGIN.left} x2={MARGIN.left + plotWidth} y1={yScale(limit)} y2={yScale(limit)} />
            <text className="viz-limit-label" x={MARGIN.left + plotWidth + 8} y={yScale(limit) + 4}>
              Limit {limit}/s
            </text>

            {visible
              .filter((bucket) => bucket.second % labelEvery === 0)
              .map((bucket) => (
                <text
                  key={bucket.second}
                  className="viz-axis-label"
                  x={xScale(bucket.second) + band / 2}
                  y={yScale(0) + 18}
                  textAnchor="middle"
                >
                  {bucket.second}s
                </text>
              ))}
          </svg>

          {activeBucket && (
            <div
              className="viz-tooltip"
              style={{
                top: MARGIN.top,
                left: flip ? undefined : `calc(${tooltipLeft}% + 12px)`,
                right: flip ? `calc(${100 - tooltipLeft}% + 12px)` : undefined,
              }}
            >
              <div className="viz-tooltip-title">
                {activeBucket.second}–{activeBucket.second + 1} s after start
              </div>
              {SERIES.map((series) => (
                <div className="viz-tooltip-row" key={series.key}>
                  <span className="viz-tooltip-key" style={{ background: series.color }} />
                  <strong>{activeBucket[series.key]}</strong>
                  <span className="muted">{series.label}</span>
                </div>
              ))}
              <div className="viz-tooltip-row" style={{ marginTop: 4 }}>
                <strong>{activeBucket.total}</strong>
                <span className="muted">requests started (limit {limit})</span>
              </div>
            </div>
          )}
          <div className="sr-only" aria-live="polite">
            {activeBucket
              ? `Second ${activeBucket.second}: ${activeBucket.total} requests, ${activeBucket.success} accepted, ${activeBucket.retryable} retried, ${activeBucket.failed} refused.`
              : ''}
          </div>
          {requests.length === 0 && !live && <div className="viz-empty" style={{ marginTop: 8 }}>No requests yet.</div>}
          {buckets.length > visible.length && (
            <p className="muted" style={{ margin: '6px 0 0', fontSize: 12 }}>
              Showing the last {visible.length} s of {buckets.length} s. The table view has every second.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
