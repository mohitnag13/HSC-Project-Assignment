import { Fragment, useMemo, useState } from 'react'
import { Icon } from '../../components/Icon.jsx'
import { Card, Pagination, RowStatusBadge, SeverityBadge } from '../../components/ui.jsx'
import { formatInt } from '../../lib/format.js'
import { SEVERITY } from '../../lib/severity.js'

const PAGE_SIZE = 25

const STATUS_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'loaded', label: 'Ready to load' },
  { id: 'superseded', label: 'Superseded' },
  { id: 'rejected', label: 'Quarantined' },
]

/** Shows the normalised value, with the raw export value struck through above it when they differ. */
function Change({ raw, value, display = (v) => String(v) }) {
  if (value === undefined) {
    return (
      <span className="row" style={{ gap: 4, flexWrap: 'nowrap' }} title="Could not be normalised">
        <Icon name="xCircle" size={13} className="tone-critical" />
        <span>{raw ? raw : <span className="null">empty</span>}</span>
      </span>
    )
  }
  if (value === null) return <span className="null">null</span>
  const shown = display(value)
  if (raw !== undefined && raw.trim() !== shown) {
    return (
      <span className="change">
        <span className="change-from">{raw || 'empty'}</span>
        <span className="change-to">{shown}</span>
      </span>
    )
  }
  return <span>{shown}</span>
}

function IssueSummary({ issues }) {
  const counts = { error: 0, warning: 0, info: 0 }
  for (const issue of issues) counts[issue.severity] += 1
  const parts = Object.entries(counts).filter(([, count]) => count > 0)
  if (parts.length === 0) return <span className="muted">None</span>
  return (
    <span className="issue-list">
      {parts.map(([severity, count]) => (
        <SeverityBadge key={severity} severity={severity}>
          {count} {SEVERITY[severity].label.toLowerCase()}
          {count === 1 ? '' : 's'}
        </SeverityBadge>
      ))}
    </span>
  )
}

export function RowsTable({ rows, codeFilter, onCodeFilterChange }) {
  const [status, setStatus] = useState('all')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)
  const [expanded, setExpanded] = useState(() => new Set())
  // A filter picked on the anomaly card (outside this table) also starts again from page 1.
  const [seenCodeFilter, setSeenCodeFilter] = useState(codeFilter)
  if (seenCodeFilter !== codeFilter) {
    setSeenCodeFilter(codeFilter)
    setPage(0)
  }

  const counts = useMemo(() => {
    const result = { all: rows.length, loaded: 0, superseded: 0, rejected: 0 }
    for (const row of rows) result[row.status] += 1
    return result
  }, [rows])

  const codes = useMemo(() => [...new Set(rows.flatMap((row) => row.issues.map((issue) => issue.code)))].sort(), [rows])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return rows.filter((row) => {
      if (status !== 'all' && row.status !== status) return false
      if (codeFilter && !row.issues.some((issue) => issue.code === codeFilter)) return false
      if (!needle) return true
      const haystack = [row.patientId, row.record.first_name, row.record.last_name, row.record.email, String(row.line)]
      return haystack.some((value) => value && String(value).toLowerCase().includes(needle))
    })
  }, [rows, status, codeFilter, query])

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const currentPage = Math.min(page, pageCount - 1)
  const pageRows = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE)
  const resetPage = (update) => (value) => {
    update(value)
    setPage(0)
  }
  const toggle = (line) =>
    setExpanded((previous) => {
      const next = new Set(previous)
      if (next.has(line)) next.delete(line)
      else next.add(line)
      return next
    })

  return (
    <Card
      title="Row-by-row results"
      subtitle="Every line of the export: what it said, what it became, and why. Click a row for the full anomaly trail."
    >
      <div className="toolbar">
        <div className="segmented" role="group" aria-label="Filter by status">
          {STATUS_FILTERS.map((filter) => (
            <button
              key={filter.id}
              type="button"
              aria-pressed={status === filter.id}
              onClick={() => resetPage(setStatus)(filter.id)}
            >
              {filter.label}
              <span className="muted">{formatInt(counts[filter.id])}</span>
            </button>
          ))}
        </div>
        <select
          className="select"
          aria-label="Filter by anomaly"
          value={codeFilter ?? ''}
          onChange={(event) => resetPage(onCodeFilterChange)(event.target.value || null)}
        >
          <option value="">All anomalies</option>
          {codes.map((code) => (
            <option key={code} value={code}>
              {code}
            </option>
          ))}
        </select>
        <input
          className="input"
          type="search"
          placeholder="Search patient, name, email, line"
          aria-label="Search rows"
          value={query}
          onChange={(event) => resetPage(setQuery)(event.target.value)}
        />
      </div>

      <div className="table-wrap" style={{ maxHeight: 640 }}>
        <table className="table">
          <thead>
            <tr>
              <th className="th-num">Line</th>
              <th>Status</th>
              <th>Patient</th>
              <th>Name</th>
              <th>Date of birth</th>
              <th>Email</th>
              <th>Phone</th>
              <th className="th-num">Balance</th>
              <th>Last modified (UTC)</th>
              <th>Anomalies</th>
            </tr>
          </thead>
          <tbody>
            {pageRows.length === 0 && (
              <tr>
                <td colSpan={10} className="muted" style={{ textAlign: 'center', padding: 24 }}>
                  No rows match these filters.
                </td>
              </tr>
            )}
            {pageRows.map((row) => {
              const { record, source } = row
              const open = expanded.has(row.line)
              return (
                <Fragment key={row.line}>
                  <tr className={`is-clickable${row.status === 'superseded' ? ' is-dimmed' : ''}`} onClick={() => toggle(row.line)}>
                    <td className="num nowrap">
                      <button
                        type="button"
                        className="row-toggle"
                        aria-expanded={open}
                        aria-label={`${open ? 'Hide' : 'Show'} the anomaly trail for line ${row.line}`}
                        onClick={(event) => {
                          event.stopPropagation()
                          toggle(row.line)
                        }}
                      >
                        <Icon name="chevronRight" size={14} />
                      </button>
                      {row.line}
                    </td>
                    <td>
                      <RowStatusBadge status={row.status} />
                    </td>
                    {source === null ? (
                      <td colSpan={7} className="mono">
                        {row.sourceFields.join(',')}
                      </td>
                    ) : (
                      <>
                        <td className="mono nowrap">
                          <Change raw={source.patient_id} value={record.patient_id} />
                        </td>
                        <td>
                          {record.first_name ?? <span className="null">missing</span>} {record.last_name ?? ''}
                        </td>
                        <td className="nowrap">
                          <Change raw={source.dob} value={record.dob} />
                        </td>
                        <td>
                          <Change raw={source.email} value={record.email} />
                        </td>
                        <td className="nowrap">
                          <Change raw={source.phone} value={record.phone} />
                        </td>
                        <td className="num nowrap">
                          <Change raw={source.account_balance} value={record.account_balance} />
                        </td>
                        <td className="nowrap mono">
                          {record.last_modified ? record.last_modified.replace('.000Z', 'Z') : <Change raw={source.last_modified} value={undefined} />}
                        </td>
                      </>
                    )}
                    <td>
                      <IssueSummary issues={row.issues} />
                    </td>
                  </tr>
                  {open && (
                    <tr className="row-detail">
                      <td />
                      <td colSpan={9}>
                        <ul className="issue-detail">
                          {row.issues.length === 0 && <li className="muted">Clean row: no changes were needed.</li>}
                          {row.issues.map((issue, index) => (
                            <li key={index}>
                              <Icon name={SEVERITY[issue.severity].icon} size={14} className={`tone-${SEVERITY[issue.severity].tone}`} />
                              <span>
                                <span className="mono">{issue.code}</span>
                                {issue.field ? <span className="muted"> · {issue.field}</span> : null} — {issue.message}
                              </span>
                            </li>
                          ))}
                        </ul>
                        <div className="muted mono" style={{ marginTop: 8, fontSize: 12 }}>
                          Source line {row.line}: {row.sourceFields.join(',')}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
      <Pagination page={currentPage} pageSize={PAGE_SIZE} total={filtered.length} onChange={setPage} />
    </Card>
  )
}
