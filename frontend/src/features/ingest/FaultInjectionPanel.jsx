import { useEffect, useRef, useState } from 'react'
import { Card, ErrorCallout, Field, Spinner } from '../../components/ui.jsx'
import { api } from '../../lib/api.js'

const PRESETS = [
  { id: 'healthy', label: 'Healthy', patch: { failureRate: 0, throttleRate: 0, latencyMinMs: 20, latencyMaxMs: 80 } },
  { id: 'flaky', label: 'Flaky', patch: { failureRate: 0.15, throttleRate: 0.1, latencyMinMs: 50, latencyMaxMs: 250 } },
  { id: 'hostile', label: 'Hostile', patch: { failureRate: 0.35, throttleRate: 0.2, latencyMinMs: 100, latencyMaxMs: 600 } },
]

const TOGGLES = [
  { key: 'enforceRateLimit', label: 'Enforce 5 requests/second', hint: 'Excess requests get 429 + Retry-After' },
  { key: 'validateRecords', label: 'Validate records', hint: 'Invalid records reject the whole batch with 400' },
  { key: 'requireAuth', label: 'Require Bearer token', hint: 'Missing or wrong token gets 401' },
]

const matchesPreset = (settings, preset) => Object.entries(preset.patch).every(([key, value]) => settings[key] === value)

/** Runtime behaviour of the mock SHC API, used to exercise the pipeline's fault tolerance. */
export function FaultInjectionPanel() {
  const [settings, setSettings] = useState(null)
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)
  const timer = useRef(0)
  const unsaved = useRef(null)

  useEffect(() => {
    api
      .mock()
      .then((state) => setSettings(state.settings))
      .catch(setError)
    return () => {
      // Leaving the page within the debounce window must not drop the last change.
      clearTimeout(timer.current)
      if (unsaved.current) api.updateMockSettings(unsaved.current).catch(() => undefined)
    }
  }, [])

  /** Applies a change locally; saves it (debounced) unless `save` is false. */
  const update = (patch, { save = true } = {}) => {
    const next = { ...settings, ...patch }
    setSettings(next)
    clearTimeout(timer.current)
    if (!save) return
    unsaved.current = next
    timer.current = setTimeout(async () => {
      unsaved.current = null
      setSaving(true)
      try {
        setSettings(await api.updateMockSettings(next))
        setError(null)
      } catch (caught) {
        setError(caught)
      } finally {
        setSaving(false)
      }
    }, 250)
  }

  return (
    <Card
      title="Fault injection (mock SHC API)"
      subtitle="Make the API misbehave and watch the pipeline cope. Applies immediately, even mid-run."
      actions={saving && <Spinner />}
    >
      {!settings ? (
        error ? <ErrorCallout error={error} title="Mock API unavailable." /> : <Spinner />
      ) : (
        <div className="stack" style={{ gap: 14 }}>
          <div className="segmented" role="group" aria-label="Presets">
            {PRESETS.map((preset) => (
              <button key={preset.id} type="button" aria-pressed={matchesPreset(settings, preset)} onClick={() => update(preset.patch)}>
                {preset.label}
              </button>
            ))}
          </div>

          <Field label="Server errors (500/502/503)" hint={`${Math.round(settings.failureRate * 100)}% of requests`} htmlFor="failure-rate">
            <input
              id="failure-rate"
              className="range"
              type="range"
              min={0}
              max={60}
              step={5}
              value={Math.round(settings.failureRate * 100)}
              onChange={(event) => update({ failureRate: Number(event.target.value) / 100 })}
            />
          </Field>
          <Field label="Random throttling (429)" hint={`${Math.round(settings.throttleRate * 100)}% of requests`} htmlFor="throttle-rate">
            <input
              id="throttle-rate"
              className="range"
              type="range"
              min={0}
              max={50}
              step={5}
              value={Math.round(settings.throttleRate * 100)}
              onChange={(event) => update({ throttleRate: Number(event.target.value) / 100 })}
            />
          </Field>
          <div className="form-grid">
            <Field label="Latency min" hint="ms" htmlFor="latency-min">
              <input
                id="latency-min"
                className="input"
                type="number"
                min={0}
                max={5000}
                value={settings.latencyMinMs}
                // Saved only while consistent; an inconsistent pair is resolved when the field loses focus,
                // so typing "800" never passes through a clamped "8".
                onChange={(event) => {
                  const value = Number(event.target.value)
                  update({ latencyMinMs: value }, { save: value <= settings.latencyMaxMs })
                }}
                onBlur={() => {
                  if (settings.latencyMinMs > settings.latencyMaxMs) update({ latencyMaxMs: settings.latencyMinMs })
                }}
              />
            </Field>
            <Field label="Latency max" hint="ms" htmlFor="latency-max">
              <input
                id="latency-max"
                className="input"
                type="number"
                min={0}
                max={5000}
                value={settings.latencyMaxMs}
                onChange={(event) => {
                  const value = Number(event.target.value)
                  update({ latencyMaxMs: value }, { save: value >= settings.latencyMinMs })
                }}
                onBlur={() => {
                  if (settings.latencyMaxMs < settings.latencyMinMs) update({ latencyMinMs: settings.latencyMaxMs })
                }}
              />
            </Field>
          </div>
          {TOGGLES.map((toggle) => (
            <label className="check" key={toggle.key}>
              <input type="checkbox" checked={settings[toggle.key]} onChange={(event) => update({ [toggle.key]: event.target.checked })} />
              <span>
                <strong>{toggle.label}</strong>
                <span className="muted" style={{ display: 'block', fontSize: 12.5 }}>
                  {toggle.hint}
                </span>
              </span>
            </label>
          ))}
          {error && <ErrorCallout error={error} title="Could not update the mock API." />}
        </div>
      )}
    </Card>
  )
}
