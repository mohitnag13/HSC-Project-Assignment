import { Icon } from '../../components/Icon.jsx'
import { Callout, Card, EmptyState, ErrorCallout, PageHeader, Spinner } from '../../components/ui.jsx'
import { plural } from '../../lib/format.js'
import { FaultInjectionPanel } from './FaultInjectionPanel.jsx'
import { IngestSettings } from './IngestSettings.jsx'
import { RunMonitor } from './RunMonitor.jsx'

export function IngestView({ config, dataset, transform, form, onFormChange, run, runMeta, onStart, onCancel, starting, cancelling, startError, onNavigate }) {
  const result = transform.result
  const ready = result?.records.length ?? 0
  const running = Boolean(run.runId) && !run.summary && !run.lost

  return (
    <>
      <PageHeader
        eyebrow="Task 2 · API integration and fault tolerance"
        title="Load to the SHC API"
        description="Batches of up to 100 records, at most 5 requests per second, Bearer authentication, exponential backoff on 429/5xx, and 400s isolated into failed_records.json without stopping the pipeline."
      />

      <div className="split">
        <div className="stack">
          <Card title="Load" subtitle="Normalises the current dataset on the server and streams the load live.">
            <dl className="kv">
              <dt>Dataset</dt>
              <dd className="truncate" title={dataset?.fileName}>
                {dataset ? dataset.fileName : 'None loaded'}
              </dd>
              <dt>Ready to load</dt>
              <dd>
                {transform.status === 'loading' ? 'Normalising…' : result ? plural(ready, 'record') : '—'}
                {result && result.stats.rejectedRows > 0 && (
                  <span className="muted"> ({plural(result.stats.rejectedRows, 'row')} quarantined)</span>
                )}
              </dd>
              <dt>Target</dt>
              <dd className="mono" style={{ fontSize: 12, wordBreak: 'break-all' }}>
                {form.target === 'mock' ? config?.mockApi?.apiUrl : form.customUrl}
              </dd>
            </dl>
            <div className="row" style={{ marginTop: 14 }}>
              {running ? (
                <button type="button" className="btn btn-danger" onClick={onCancel} disabled={cancelling}>
                  {cancelling ? <Spinner /> : <Icon name="stop" size={14} />}
                  Cancel run
                </button>
              ) : (
                <button type="button" className="btn btn-primary" onClick={onStart} disabled={starting || !ready || transform.status === 'loading'}>
                  {starting ? <Spinner /> : <Icon name="play" size={14} />}
                  Start load
                </button>
              )}
              {!dataset && (
                <button type="button" className="btn btn-ghost" onClick={() => onNavigate('normalize')}>
                  Choose a dataset
                  <Icon name="arrowRight" size={14} />
                </button>
              )}
            </div>
            {startError && (
              <div style={{ marginTop: 12 }}>
                <ErrorCallout error={startError} title="The load could not start." />
              </div>
            )}
            {form.target === 'custom' && (
              <div style={{ marginTop: 12 }}>
                <Callout tone="info">
                  The pipeline will call this endpoint from the backend with the token above. The assessment's
                  api.mock-shc.com does not resolve publicly, so expect network errors there; the built-in mock implements the same contract.
                </Callout>
              </div>
            )}
          </Card>

          <IngestSettings form={form} onChange={onFormChange} config={config} disabled={running} />
          {form.target === 'mock' && config?.mockApi && <FaultInjectionPanel />}
        </div>

        <div className="stack">
          {run.runId ? (
            // Keyed by run: nothing (e.g. fetched failed records) may carry over from the previous run.
            <RunMonitor key={run.runId} run={run} runMeta={runMeta} onCancel={onCancel} cancelling={cancelling} />
          ) : (
            <Card>
              <EmptyState icon="send" title="No load has run yet">
                Pick a dataset on the previous page, tune the connection if you like, then start the load. Progress, the request rate,
                retries and failed records stream in here live.
              </EmptyState>
            </Card>
          )}
        </div>
      </div>
    </>
  )
}
