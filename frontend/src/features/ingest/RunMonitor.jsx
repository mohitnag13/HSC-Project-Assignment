import { useEffect, useMemo, useState } from 'react'
import { Icon } from '../../components/Icon.jsx'
import { Badge, Callout, Card, EmptyState, RunStatusBadge, Spinner, StatTile } from '../../components/ui.jsx'
import { api } from '../../lib/api.js'
import { formatClock, formatDuration, formatInt, plural } from '../../lib/format.js'
import { RequestRateChart } from './RequestRateChart.jsx'

const STATUS_MEANING = {
  200: ['OK', 'Accepted'],
  201: ['Created', 'Accepted'],
  400: ['Bad Request', 'Invalid records logged to failed_records.json, the rest re-sent (bisection if the API does not name them)'],
  401: ['Unauthorized', 'Run aborted: credentials are wrong'],
  403: ['Forbidden', 'Run aborted: token lacks permission'],
  404: ['Not Found', 'Run aborted: endpoint URL is wrong'],
  408: ['Request Timeout', 'Retried with exponential backoff'],
  413: ['Payload Too Large', 'Logged to failed_records.json'],
  422: ['Unprocessable Entity', 'Handled like 400: invalid records logged, the rest re-sent'],
  429: ['Too Many Requests', 'Backed off (Retry-After honoured), then retried'],
  500: ['Internal Server Error', 'Retried with exponential backoff'],
  502: ['Bad Gateway', 'Retried with exponential backoff'],
  503: ['Service Unavailable', 'Retried with exponential backoff'],
  504: ['Gateway Timeout', 'Retried with exponential backoff'],
  network: ['Network error / timeout', 'Retried with exponential backoff'],
}

const statusTone = (status) => {
  if (status === 'network') return 'warning'
  const code = Number(status)
  if (code < 300) return 'good'
  if (code === 408 || code === 429 || code >= 500) return 'warning'
  return 'critical'
}

const REASON_LABEL = { bad_request: 'Rejected (400)', retries_exhausted: 'Retries exhausted', rejected: 'Refused (4xx)' }

/** Rows rendered in the failed-records table; the download always has all of them. */
const MAX_FAILED_ROWS = 500

/** Wall-clock tick while `active`, so elapsed time keeps moving between events. */
function useNow(active) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return undefined
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

function livePeak(requests) {
  const starts = requests.map((request) => request.sentAtMs).sort((a, b) => a - b)
  let peak = 0
  let first = 0
  for (let last = 0; last < starts.length; last += 1) {
    while (starts[first] <= starts[last] - 1000) first += 1
    peak = Math.max(peak, last - first + 1)
  }
  return peak
}

function ProgressBar({ total, loaded, failed, notAttempted }) {
  const pending = Math.max(0, total - loaded - failed - notAttempted)
  const segments = [
    { key: 'loaded', label: 'Loaded', value: loaded, color: 'var(--good)', icon: 'checkCircle', tone: 'good' },
    { key: 'failed', label: 'Failed', value: failed, color: 'var(--critical)', icon: 'xCircle', tone: 'critical' },
    { key: 'skipped', label: 'Not attempted', value: notAttempted, color: 'var(--muted)', icon: 'stop', tone: 'neutral' },
    { key: 'pending', label: 'Pending', value: pending, color: 'var(--surface-2)', icon: 'clock', tone: 'neutral' },
  ]
  return (
    <div>
      <div
        className="progress"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={loaded + failed + notAttempted}
        aria-label="Records processed"
      >
        {segments
          .filter((segment) => segment.value > 0)
          .map((segment) => (
            <div
              key={segment.key}
              className="progress-seg"
              style={{
                flexBasis: `${(segment.value / Math.max(1, total)) * 100}%`,
                background: segment.color,
                boxShadow: segment.key === 'pending' ? 'inset 0 0 0 1px var(--border)' : undefined,
              }}
            />
          ))}
      </div>
      <div className="legend">
        {segments.map((segment) => (
          <span className="legend-item" key={segment.key}>
            <Icon name={segment.icon} size={13} className={`tone-${segment.tone}`} />
            {segment.label}
            <strong>{formatInt(segment.value)}</strong>
          </span>
        ))}
      </div>
    </div>
  )
}

function StatusCodes({ byStatus }) {
  const entries = Object.entries(byStatus).sort(([a], [b]) => (a === 'network' ? 1 : b === 'network' ? -1 : Number(a) - Number(b)))
  return (
    <Card title="Responses by status" subtitle="How the pipeline handled every response class.">
      {entries.length === 0 ? (
        <EmptyState icon="send">No responses yet.</EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Handling</th>
                <th className="th-num">Count</th>
              </tr>
            </thead>
            <tbody>
              {entries.map(([status, count]) => {
                const [label, handling] = STATUS_MEANING[status] ?? ['', 'Logged']
                const tone = statusTone(status)
                return (
                  <tr key={status}>
                    <td className="nowrap">
                      <Badge tone={tone} icon={tone === 'good' ? 'checkCircle' : tone === 'warning' ? 'retry' : 'xCircle'}>
                        {status === 'network' ? 'Network' : status}
                      </Badge>{' '}
                      <span className="muted">{label}</span>
                    </td>
                    <td>{handling}</td>
                    <td className="num">{formatInt(count)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

function errorDetail(entry) {
  const errors = entry.error?.errors
  if (Array.isArray(errors) && errors.length > 0) return errors.map((error) => `${error.field}: ${error.message}`).join('; ')
  return entry.message
}

function FailedRecords({ runId, finished, failures }) {
  const [entries, setEntries] = useState(null)
  const failedCount = failures.reduce((sum, failure) => sum + failure.patientIds.length, 0)

  useEffect(() => {
    if (!finished || failedCount === 0) return undefined
    let active = true
    api
      .failedRecords(runId)
      .then((data) => active && setEntries(data))
      .catch(() => active && setEntries(null))
    return () => {
      active = false
    }
  }, [runId, finished, failedCount])

  const rows =
    entries ??
    failures.flatMap((failure) =>
      failure.patientIds.map((patientId) => ({
        patient_id: patientId,
        reason: failure.reason,
        status: failure.status,
        message: failure.message,
        batch_id: failure.batchId,
      })),
    )

  return (
    <Card
      title="failed_records.json"
      subtitle="Records the SHC API refused (only the ones it named, or that bisection isolated) or that could not be delivered after every retry. The pipeline kept going."
      actions={
        <a className="btn btn-sm" href={api.failedRecordsDownloadUrl(runId)} download="failed_records.json">
          <Icon name="download" size={14} />
          Download
        </a>
      }
    >
      {rows.length === 0 ? (
        <EmptyState icon="checkCircle" title="No failed records">
          {finished ? 'Every record was accepted.' : 'Nothing has failed so far.'}
        </EmptyState>
      ) : (
        <div className="table-wrap" style={{ maxHeight: 340 }}>
          <table className="table">
            <thead>
              <tr>
                <th>Patient</th>
                <th>Reason</th>
                <th>Detail</th>
                <th>Batch</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, MAX_FAILED_ROWS).map((row, index) => (
                <tr key={`${row.patient_id}-${index}`}>
                  <td className="mono nowrap">{row.patient_id}</td>
                  <td className="nowrap">
                    <Badge tone={row.reason === 'retries_exhausted' ? 'warning' : 'critical'} icon={row.reason === 'retries_exhausted' ? 'retry' : 'xCircle'}>
                      {REASON_LABEL[row.reason] ?? row.reason}
                    </Badge>
                  </td>
                  <td>{entries ? errorDetail(row) : row.message}</td>
                  <td className="mono nowrap muted">{row.batch_id}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rows.length > MAX_FAILED_ROWS && (
        <p className="muted" style={{ margin: '8px 0 0', fontSize: 12.5 }}>
          Showing the first {formatInt(MAX_FAILED_ROWS)} of {formatInt(rows.length)}; the download has every record.
        </p>
      )}
    </Card>
  )
}

function describeEvent(event) {
  switch (event.type) {
    case 'request_completed': {
      const status = event.status ?? 'network'
      const tone = event.outcome === 'success' ? 'good' : event.outcome === 'retryable' ? 'warning' : 'critical'
      return {
        icon: tone === 'good' ? 'checkCircle' : tone === 'warning' ? 'retry' : 'xCircle',
        tone,
        problem: event.outcome !== 'success',
        text: `POST ${event.batchId} · attempt ${event.attempt} · ${plural(event.size, 'record')} → ${status}`,
        detail: event.outcome === 'success' ? `${event.durationMs} ms` : `${event.message} · ${event.durationMs} ms`,
      }
    }
    case 'retry_scheduled':
      return {
        icon: 'clock',
        tone: 'warning',
        problem: true,
        text: `Backing off ${formatDuration(event.delayMs)} before attempt ${event.nextAttempt} of ${event.batchId}`,
        detail: event.reason,
      }
    case 'records_isolated':
      return {
        icon: 'split',
        tone: 'serious',
        problem: true,
        text: `${event.batchId} (${plural(event.size, 'record')}) rejected; the API named ${plural(event.invalid, 'invalid record')}`,
        detail: event.retryBatchId
          ? `Re-sending the other ${formatInt(event.size - event.invalid)} as ${event.retryBatchId}`
          : 'No other records in the batch',
      }
    case 'batch_bisected':
      return {
        icon: 'split',
        tone: 'serious',
        problem: true,
        text: `${event.batchId} (${plural(event.size, 'record')}) rejected; split into ${event.children.join(' + ')}`,
        detail: 'The API did not say which records were invalid, so the batch is halved until they are isolated',
      }
    case 'records_failed':
      return {
        icon: 'xCircle',
        tone: 'critical',
        problem: true,
        text: `${plural(event.patientIds.length, 'record')} written to failed_records.json (${event.patientIds.slice(0, 3).join(', ')}${event.patientIds.length > 3 ? '…' : ''})`,
        detail: event.message,
      }
    case 'run_aborting':
      return { icon: 'xCircle', tone: 'critical', problem: true, text: 'Aborting the run', detail: event.reason }
    case 'run_finished':
      return { icon: 'checkCircle', tone: 'info', problem: false, text: `Run finished: ${event.summary.status.replaceAll('_', ' ')}`, detail: '' }
    default:
      return null
  }
}

function ActivityLog({ log }) {
  const [problemsOnly, setProblemsOnly] = useState(false)
  const items = useMemo(() => {
    const described = []
    for (let index = log.length - 1; index >= 0 && described.length < 250; index -= 1) {
      const event = log[index]
      const description = describeEvent(event)
      if (description && (!problemsOnly || description.problem)) described.push({ event, ...description })
    }
    return described
  }, [log, problemsOnly])

  return (
    <Card
      title="Activity log"
      subtitle="Newest first. Every request, backoff, bisection and failure, as streamed from the pipeline."
      actions={
        <label className="check">
          <input type="checkbox" checked={problemsOnly} onChange={(event) => setProblemsOnly(event.target.checked)} />
          Problems only
        </label>
      }
    >
      {items.length === 0 ? (
        <EmptyState icon="clock">Nothing to show yet.</EmptyState>
      ) : (
        <div className="table-wrap" style={{ maxHeight: 360 }}>
          <table className="table">
            <thead>
              <tr>
                <th className="th-num">t+</th>
                <th>Event</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {items.map(({ event, icon, tone, text, detail }) => (
                <tr key={event.seq}>
                  <td className="num nowrap muted">{(event.elapsedMs / 1000).toFixed(2)} s</td>
                  <td>
                    <span className="row" style={{ flexWrap: 'nowrap', alignItems: 'flex-start' }}>
                      <Icon name={icon} size={14} className={`tone-${tone}`} />
                      <span>{text}</span>
                    </span>
                  </td>
                  <td className="muted">{detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

export function RunMonitor({ run, runMeta, onCancel, cancelling }) {
  const summary = run.summary
  const live = !summary && !run.lost
  const status = run.lost ? 'lost' : (summary?.status ?? 'running')
  const now = useNow(live)
  const settings = run.started?.settings ?? runMeta?.settings
  const limit = settings?.maxRequestsPerSecond ?? 5
  const total = run.started?.totalRecords ?? runMeta?.transformStats?.recordsReady ?? 0
  const progress = summary
    ? { loaded: summary.records.loaded, failed: summary.records.failed, notAttempted: summary.records.notAttempted }
    : (run.progress ?? { loaded: 0, failed: 0, notAttempted: 0 })
  const peak = summary?.requests.peakPerSecond ?? livePeak(run.requests)
  const byStatus = useMemo(() => {
    if (summary) return summary.requests.byStatus
    const counts = {}
    for (const request of run.requests) {
      const key = request.status === null ? 'network' : String(request.status)
      counts[key] = (counts[key] ?? 0) + 1
    }
    return counts
  }, [summary, run.requests])
  const abortReason = summary?.abortReason ?? run.aborting?.reason ?? null
  const startedAt = run.started ? Date.parse(run.started.at) : null
  const elapsed = summary?.durationMs ?? (live && startedAt ? Math.max(run.elapsedMs, now - startedAt) : run.elapsedMs)
  const reconnecting = live && !run.connected && run.lastSeq > 0

  return (
    <div className="stack">
      <Card
        title={
          <span className="row">
            Run <span className="mono" style={{ fontSize: 13, fontWeight: 500 }}>{run.runId}</span>
          </span>
        }
        subtitle={
          <>
            {runMeta?.fileName ? `${runMeta.fileName} → ` : ''}
            <span className="mono">{run.started?.apiUrl ?? runMeta?.apiUrl ?? ''}</span>
            {runMeta?.createdAt ? ` · started ${formatClock(runMeta.createdAt)}` : ''}
          </>
        }
        actions={
          <>
            {reconnecting && (
              <Badge tone="warning" icon="retry">
                Reconnecting
              </Badge>
            )}
            <RunStatusBadge status={status} />
            {live && (
              <button type="button" className="btn btn-sm btn-danger" onClick={onCancel} disabled={cancelling}>
                {cancelling ? <Spinner /> : <Icon name="stop" size={13} />}
                Cancel
              </button>
            )}
          </>
        }
      >
        <ProgressBar total={total} loaded={progress.loaded} failed={progress.failed} notAttempted={progress.notAttempted} />
        {abortReason && (
          <div style={{ marginTop: 12 }}>
            <Callout tone="critical" title="Run aborted.">
              {abortReason}. No further requests were sent, because every one would fail the same way. Fix the configuration and
              start a new load; the API upserts by patient_id, so a rerun is safe.
            </Callout>
          </div>
        )}
        {status === 'cancelled' && (
          <div style={{ marginTop: 12 }}>
            <Callout tone="warning" title="Run cancelled.">
              In-flight requests were allowed to finish; {plural(summary.records.notAttempted, 'record')} were not sent.
            </Callout>
          </div>
        )}
        {run.lost && (
          <div style={{ marginTop: 12 }}>
            <Callout tone="critical" title="Connection lost.">
              The console backend restarted while this run was in progress, and runs are kept in memory, so its outcome is unknown.
              Start the load again: the SHC API upserts by patient_id, so re-sending records is safe.
            </Callout>
          </div>
        )}
      </Card>

      <div className="stats">
        <StatTile
          label="Records loaded"
          value={`${formatInt(progress.loaded)} / ${formatInt(total)}`}
          icon="checkCircle"
          tone="good"
          sub={total ? `${Math.round((progress.loaded / total) * 100)}% of normalised records` : undefined}
        />
        <StatTile label="Failed records" value={progress.failed} icon="xCircle" tone={progress.failed ? 'critical' : undefined} sub="in failed_records.json" />
        <StatTile label="Requests sent" value={run.requests.length} icon="send" sub={`${formatInt(run.started?.totalBatches ?? 0)} planned batches`} />
        <StatTile label="Retries" value={run.retries} icon="retry" tone={run.retries ? 'warning' : undefined} sub="429 / 5xx / network" />
        <StatTile
          label="Peak request rate"
          value={`${formatInt(peak)}/s`}
          icon={peak <= limit ? 'shield' : 'alert'}
          tone={peak <= limit ? 'good' : 'critical'}
          sub={`limit ${limit}/s`}
        />
        <StatTile
          label="400s isolated"
          value={run.isolations + run.bisections}
          icon="split"
          sub={`${formatInt(run.isolations)} by API details · ${formatInt(run.bisections)} by splitting`}
        />
        <StatTile label="Elapsed" value={formatDuration(elapsed)} icon="clock" sub={live ? 'running' : 'finished'} />
      </div>

      <Card
        title="Requests per second"
        subtitle={`Each column is one second of the run, split by outcome. The client-side limiter keeps every second at or below ${limit} requests, retries included.`}
      >
        <RequestRateChart requests={run.requests} elapsedMs={elapsed} limit={limit} live={live} />
      </Card>

      <FailedRecords runId={run.runId} finished={Boolean(summary)} failures={run.failures} />
      <StatusCodes byStatus={byStatus} />
      <ActivityLog log={run.log} />
    </div>
  )
}
