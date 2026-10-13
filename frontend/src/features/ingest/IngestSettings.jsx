import { Icon } from '../../components/Icon.jsx'
import { Card, Field } from '../../components/ui.jsx'
import { NUMERIC_FIELDS } from './ingestForm.js'

export function IngestSettings({ form, onChange, config, disabled }) {
  const limits = config?.ingestion.limits ?? {}
  const update = (patch) => onChange({ ...form, ...patch })
  const updateSetting = (key, value) => onChange({ ...form, settings: { ...form.settings, [key]: value } })

  return (
    <Card
      title="Connection & tuning"
      subtitle="Defaults follow the SHC contract: 100 records per request, 5 requests per second."
      actions={
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          disabled={disabled || !config}
          onClick={() => update({ settings: { ...config.ingestion.defaults } })}
        >
          Reset defaults
        </button>
      }
    >
      <fieldset disabled={disabled} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
        <div className="stack" style={{ gap: 12 }}>
          <div className="segmented segmented--block" role="group" aria-label="Target API">
            <button type="button" aria-pressed={form.target === 'mock'} disabled={!config?.mockApi} onClick={() => update({ target: 'mock' })}>
              <Icon name="database" size={14} />
              Mock SHC API
            </button>
            <button
              type="button"
              aria-pressed={form.target === 'custom'}
              disabled={config?.customTargetsAllowed === false}
              title={config?.customTargetsAllowed === false ? 'Disabled on this console (ALLOW_CUSTOM_TARGETS=false)' : undefined}
              onClick={() => update({ target: 'custom' })}
            >
              <Icon name="send" size={14} />
              Custom endpoint
            </button>
          </div>

          {form.target === 'mock' ? (
            <>
              <Field label="Endpoint">
                <div className="input mono" style={{ display: 'flex', alignItems: 'center', background: 'var(--surface-2)', fontSize: 12 }}>
                  POST {config?.mockApi?.apiUrl}
                </div>
              </Field>
              <Field label="Bearer token" help="Change it to watch the run abort on 401." htmlFor="mock-token">
                <input
                  id="mock-token"
                  className="input mono"
                  value={form.mockToken}
                  onChange={(event) => update({ mockToken: event.target.value })}
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>
            </>
          ) : (
            <>
              <Field label="Endpoint URL" htmlFor="custom-url">
                <input
                  id="custom-url"
                  className="input mono"
                  value={form.customUrl}
                  onChange={(event) => update({ customUrl: event.target.value })}
                  spellCheck={false}
                />
              </Field>
              <Field label="Bearer token" htmlFor="custom-token">
                <input
                  id="custom-token"
                  className="input mono"
                  type="password"
                  value={form.customToken}
                  onChange={(event) => update({ customToken: event.target.value })}
                  autoComplete="off"
                />
              </Field>
            </>
          )}

          <div className="form-grid">
            {NUMERIC_FIELDS.map(({ key, label, help }) => (
              <Field key={key} label={label} help={help} htmlFor={`setting-${key}`}>
                <input
                  id={`setting-${key}`}
                  className="input"
                  type="number"
                  min={limits[key]?.min}
                  max={limits[key]?.max}
                  step={limits[key]?.integer === false ? 'any' : 1}
                  value={form.settings[key] ?? ''}
                  onChange={(event) => updateSetting(key, event.target.value)}
                />
              </Field>
            ))}
            <label className="check span-2">
              <input
                type="checkbox"
                checked={Boolean(form.settings.bisectOn400)}
                onChange={(event) => updateSetting('bisectOn400', event.target.checked)}
              />
              <span>
                <strong>Split batches when a 400 doesn't name the bad records</strong>
                <span className="muted" style={{ display: 'block', fontSize: 12.5 }}>
                  When the API lists the invalid records, only those fail and the rest are re-sent. Otherwise the batch is halved
                  until only the offending records fail, so one bad record cannot block 99 good ones.
                </span>
              </span>
            </label>
          </div>
        </div>
      </fieldset>
    </Card>
  )
}
