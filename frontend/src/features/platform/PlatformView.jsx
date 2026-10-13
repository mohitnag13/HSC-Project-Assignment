import { useEffect, useState } from 'react'
import { Icon } from '../../components/Icon.jsx'
import { Badge, Card, EmptyState, ErrorCallout, PageHeader, Pagination, Spinner, StatTile } from '../../components/ui.jsx'
import { api } from '../../lib/api.js'
import { formatAmount, formatClock, formatInt } from '../../lib/format.js'
import { usePolling } from '../../lib/hooks.js'

const PAGE_SIZE = 25

const statusTone = (status) => (status < 300 ? 'good' : status === 429 || status >= 500 ? 'warning' : 'critical')
const toneIcon = { good: 'checkCircle', warning: 'retry', critical: 'xCircle' }

export function PlatformView({ runActive }) {
  const fast = runActive ? 1500 : 4000
  const mock = usePolling(api.mock, fast)
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)
  const patients = usePolling(() => api.mockPatients({ offset: page * PAGE_SIZE, limit: PAGE_SIZE, query }), fast + 500)
  const [resetting, setResetting] = useState(false)
  const [resetError, setResetError] = useState(null)
  const refreshPatients = patients.refresh
  const refreshMock = mock.refresh

  useEffect(() => {
    refreshPatients()
  }, [page, query, refreshPatients])

  const reset = async () => {
    if (!window.confirm('Delete every patient stored in the mock SHC Platform and clear its statistics?')) return
    setResetting(true)
    setResetError(null)
    try {
      await api.resetMock()
      setPage(0)
      await Promise.all([refreshMock(), refreshPatients()])
    } catch (error) {
      setResetError(error)
    } finally {
      setResetting(false)
    }
  }

  const state = mock.data
  const stats = state?.stats
  const byStatus = stats?.byStatus ?? {}
  const serverErrors = Object.entries(byStatus)
    .filter(([status]) => Number(status) >= 500)
    .reduce((sum, [, count]) => sum + count, 0)
  const limit = state?.settings.maxRequestsPerSecond ?? 5

  return (
    <>
      <PageHeader
        eyebrow="Verification · mock SHC Platform"
        title="SHC Platform data"
        description="What actually landed on the other side. The mock SHC API keeps every accepted patient (upserted by patient_id, never rolled back to an older version) and measures how fast clients really call it."
        actions={
          <button type="button" className="btn btn-danger" onClick={reset} disabled={resetting || !state}>
            {resetting ? <Spinner /> : <Icon name="trash" size={14} />}
            Reset platform data
          </button>
        }
      />

      {mock.error && !state && <ErrorCallout error={mock.error} title="The mock SHC API is not available." />}
      {resetError && <ErrorCallout error={resetError} title="The platform data could not be reset." />}

      {state && (
        <div className="stats" style={{ '--tile-min': '140px' }}>
          <StatTile label="Patients stored" value={state.patientCount} icon="database" tone="good" />
          <StatTile label="Requests received" value={stats.requests} icon="send" sub={stats.lastRequestAt ? `last at ${formatClock(stats.lastRequestAt)}` : 'none yet'} />
          <StatTile
            label="Records accepted"
            value={stats.recordsAccepted}
            icon="checkCircle"
            sub={`${formatInt(stats.created)} created · ${formatInt(stats.updated)} updated`}
          />
          <StatTile
            label="Peak arrival rate"
            value={`${formatInt(stats.peakArrivalsPerSecond)}/s`}
            icon={stats.peakArrivalsPerSecond <= limit ? 'shield' : 'alert'}
            tone={stats.peakArrivalsPerSecond <= limit ? 'good' : 'critical'}
            sub={`measured server-side · limit ${limit}/s`}
          />
          <StatTile label="Throttled (429)" value={byStatus['429'] ?? 0} icon="retry" tone={byStatus['429'] ? 'warning' : undefined} />
          <StatTile label="Rejected (400)" value={byStatus['400'] ?? 0} icon="xCircle" tone={byStatus['400'] ? 'critical' : undefined} />
          <StatTile label="Server errors (5xx)" value={serverErrors} icon="alert" tone={serverErrors ? 'warning' : undefined} sub="injected faults" />
        </div>
      )}

      <Card
        title="Stored patients"
        subtitle="GET /v1/patients on the mock platform, refreshed automatically."
        actions={
          <input
            className="input"
            type="search"
            placeholder="Search ID, name, email"
            aria-label="Search stored patients"
            value={query}
            style={{ width: 240 }}
            onChange={(event) => {
              setQuery(event.target.value)
              setPage(0)
            }}
          />
        }
      >
        {!patients.data ? (
          patients.error ? <ErrorCallout error={patients.error} /> : <EmptyState icon="database"><Spinner /></EmptyState>
        ) : patients.data.total === 0 ? (
          <EmptyState icon="database" title={query ? 'No matching patients' : 'The platform is empty'}>
            {query ? 'Try another search.' : 'Run a load on the previous page and the accepted patients will appear here.'}
          </EmptyState>
        ) : (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>patient_id</th>
                    <th>Name</th>
                    <th>dob</th>
                    <th>email</th>
                    <th>phone</th>
                    <th className="th-num">account_balance</th>
                    <th>last_modified</th>
                    <th className="th-num">Version</th>
                    <th>Received</th>
                  </tr>
                </thead>
                <tbody>
                  {patients.data.items.map((patient) => (
                    <tr key={patient.patient_id}>
                      <td className="mono nowrap">{patient.patient_id}</td>
                      <td>
                        {patient.first_name} {patient.last_name}
                      </td>
                      <td className="nowrap">{patient.dob}</td>
                      <td>{patient.email ?? <span className="null">null</span>}</td>
                      <td className="nowrap">{patient.phone ?? <span className="null">null</span>}</td>
                      <td className="num">{formatAmount(patient.account_balance)}</td>
                      <td className="mono nowrap">{patient.last_modified.replace('.000Z', 'Z')}</td>
                      <td className="num">{patient.version}</td>
                      <td className="nowrap muted">{formatClock(patient.received_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={page} pageSize={PAGE_SIZE} total={patients.data.total} onChange={setPage} />
          </>
        )}
      </Card>

      <Card title="Recent requests" subtitle="The last 50 requests as the platform saw them, newest first.">
        {!state || state.recentRequests.length === 0 ? (
          <EmptyState icon="send">No requests received yet.</EmptyState>
        ) : (
          <div className="table-wrap" style={{ maxHeight: 380 }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Status</th>
                  <th className="th-num">Records</th>
                  <th className="th-num">Server time</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                {state.recentRequests.map((request) => {
                  const tone = statusTone(request.status)
                  return (
                    <tr key={request.id}>
                      <td className="nowrap mono">{formatClock(request.at)}</td>
                      <td>
                        <Badge tone={tone} icon={toneIcon[tone]}>
                          {request.status}
                        </Badge>
                      </td>
                      <td className="num">{formatInt(request.records)}</td>
                      <td className="num">{request.durationMs} ms</td>
                      <td className="muted">{request.note}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  )
}
