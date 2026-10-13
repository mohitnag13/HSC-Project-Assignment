import { useEffect, useState } from 'react'
import { Icon } from './components/Icon.jsx'
import { Badge, Callout } from './components/ui.jsx'
import { DeployView } from './features/deploy/DeployView.jsx'
import { DocumentView } from './features/docs/DocumentView.jsx'
import { createIngestForm, toRunPayload } from './features/ingest/ingestForm.js'
import { IngestView } from './features/ingest/IngestView.jsx'
import { NormalizeView } from './features/normalize/NormalizeView.jsx'
import { PlatformView } from './features/platform/PlatformView.jsx'
import { api } from './lib/api.js'
import { useHashRoute, usePolling, useTheme, useTransform } from './lib/hooks.js'
import { useRunStream } from './lib/runStream.js'

const ROUTES = [
  { id: 'normalize', group: 'Pipeline', label: 'Extract & normalise', step: 'Task 1', icon: 'wand' },
  { id: 'ingest', group: 'Pipeline', label: 'Load to SHC API', step: 'Task 2', icon: 'send' },
  { id: 'platform', group: 'Pipeline', label: 'SHC Platform data', step: 'Verify', icon: 'database' },
  { id: 'deploy', group: 'Deliverables', label: 'Containerization', step: 'Task 3', icon: 'box' },
  { id: 'email', group: 'Deliverables', label: 'Client email', step: 'Task 4', icon: 'mail' },
  { id: 'readme', group: 'Deliverables', label: 'README', step: 'Docs', icon: 'book' },
]
const ROUTE_IDS = ROUTES.map((route) => route.id)
const GROUPS = [...new Set(ROUTES.map((route) => route.group))]

const THEMES = [
  { id: 'system', icon: 'monitor', label: 'Use system theme' },
  { id: 'light', icon: 'sun', label: 'Light theme' },
  { id: 'dark', icon: 'moon', label: 'Dark theme' },
]

/** Shape plus colour (check / cross), so the state never depends on colour alone. */
function ConnectionStatus({ label, up }) {
  return (
    <span className="badge" title={`${label}: ${up ? 'reachable' : 'unreachable'}`}>
      <Icon name={up ? 'checkCircle' : 'xCircle'} size={13} className={up ? 'tone-good' : 'tone-critical'} />
      {label}
      <span className="sr-only">{up ? 'reachable' : 'unreachable'}</span>
    </span>
  )
}

let datasetCounter = 0

/** Every loaded dataset gets its own identity, even when it has the same name and size as the last one. */
const withId = (dataset) => ({ ...dataset, id: (datasetCounter += 1) })

export default function App() {
  const [route, navigate] = useHashRoute(ROUTE_IDS, 'normalize')
  const [theme, setTheme] = useTheme()
  const health = usePolling(api.health, 5000)
  const [config, setConfig] = useState(null)
  const [dataset, setDataset] = useState(null)
  const transform = useTransform(dataset)
  const [form, setForm] = useState(() => createIngestForm(null))
  const [activeRunId, setActiveRunId] = useState(null)
  const [runMeta, setRunMeta] = useState(null)
  const [starting, setStarting] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [startError, setStartError] = useState(null)
  const run = useRunStream(activeRunId)
  const backendUp = Boolean(health.data) && !health.error
  const runActive = Boolean(run.runId) && !run.summary && !run.lost
  const loadDataset = (next) => setDataset(withId(next))

  // Bootstrap once the backend answers: configuration, the sample export, and the latest run (survives a page refresh).
  // Everything is applied in one update: setting `config` re-runs this effect, and its cleanup
  // would otherwise discard responses that are still in flight.
  useEffect(() => {
    if (!backendUp || config) return undefined
    let active = true
    Promise.all([api.config(), api.sample().catch(() => null), api.runs().catch(() => [])])
      .then(([loaded, sample, runs]) => {
        if (!active) return
        setConfig(loaded)
        setForm((current) => (current.settings.batchSize ? current : createIngestForm(loaded)))
        if (sample) setDataset((current) => current ?? withId({ fileName: sample.fileName, csv: sample.csv, source: 'sample' }))
        if (runs[0]) {
          setRunMeta((current) => current ?? runs[0])
          setActiveRunId((current) => current ?? runs[0].id)
        }
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [backendUp, config])

  const startRun = async () => {
    if (!dataset) return
    setStarting(true)
    setStartError(null)
    try {
      const created = await api.startRun(toRunPayload(form, dataset))
      setRunMeta(created)
      setActiveRunId(created.id)
    } catch (error) {
      setStartError(error)
    } finally {
      setStarting(false)
    }
  }

  const cancelRun = async () => {
    if (!activeRunId) return
    setCancelling(true)
    try {
      await api.cancelRun(activeRunId)
    } catch (error) {
      setStartError(error)
    } finally {
      setCancelling(false)
    }
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">
            <Icon name="layers" size={18} />
          </span>
          <span className="brand-text">
            <div className="brand-title">SHC Migration Console</div>
            <div className="brand-sub">GlobalHealth Corp onboarding</div>
          </span>
        </div>
        <nav className="nav" aria-label="Sections">
          {GROUPS.map((group) => (
            <div className="nav-group" key={group}>
              <div className="nav-group-label">{group}</div>
              {ROUTES.filter((item) => item.group === group).map((item) => (
                <a key={item.id} className="nav-item" href={`#/${item.id}`} aria-current={route === item.id ? 'page' : undefined}>
                  <Icon name={item.icon} size={16} />
                  {item.label}
                  <span className="nav-step">{item.step}</span>
                </a>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-footer">
          <span>FDE technical assessment</span>
          <span>Legacy system integration & deployment</span>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="topbar-context">
            <strong>GlobalHealth Corp</strong>
            <span>legacy export</span>
            <Icon name="arrowRight" size={14} />
            <strong>SHC Platform</strong>
          </div>
          <div className="topbar-actions">
            {runActive && (
              <a href="#/ingest" style={{ textDecoration: 'none' }}>
                <Badge tone="info" icon="retry">
                  Load running
                </Badge>
              </a>
            )}
            <ConnectionStatus label="Console API" up={backendUp} />
            <ConnectionStatus label="Mock SHC API" up={Boolean(health.data?.mockApi)} />
            <div className="segmented" role="group" aria-label="Theme">
              {THEMES.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  aria-pressed={theme === option.id}
                  aria-label={option.label}
                  title={option.label}
                  onClick={() => setTheme(option.id)}
                >
                  <Icon name={option.icon} size={14} />
                </button>
              ))}
            </div>
          </div>
        </header>

        <main className="content">
          {!backendUp && !health.loading && (
            <Callout tone="critical" title="The console API is not reachable.">
              Start the backend with <code>npm run dev</code> in <code>hsc/backend</code> (or <code>npm run dev</code> in{' '}
              <code>hsc</code> to start everything). This page reconnects automatically.
            </Callout>
          )}

          {route === 'normalize' && (
            <NormalizeView dataset={dataset} onDatasetChange={loadDataset} transform={transform} onContinue={() => navigate('ingest')} />
          )}
          {route === 'ingest' && (
            <IngestView
              config={config}
              dataset={dataset}
              transform={transform}
              form={form}
              onFormChange={setForm}
              run={run}
              runMeta={runMeta}
              onStart={startRun}
              onCancel={cancelRun}
              starting={starting}
              cancelling={cancelling}
              startError={startError}
              onNavigate={navigate}
            />
          )}
          {route === 'platform' && <PlatformView runActive={runActive} />}
          {route === 'deploy' && <DeployView config={config} />}
          {route === 'email' && (
            <DocumentView
              docId="client-email"
              asEmail
              eyebrow="Task 4 · Client communication"
              title="Email to the GlobalHealth Corp IT Director"
              description="How to build and run the container, what was wrong with the export and how it was handled, and one upstream change that would make future loads safer. Source: client_communication.md."
            />
          )}
          {route === 'readme' && (
            <DocumentView
              docId="readme"
              eyebrow="Internal documentation"
              title="README"
              description="Architecture decisions, the date-parsing logic, and how to run the tests. Source: README.md."
            />
          )}
        </main>
      </div>
    </div>
  )
}
