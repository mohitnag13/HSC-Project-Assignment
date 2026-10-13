import { useMemo, useRef, useState } from 'react'
import { Icon } from '../../components/Icon.jsx'
import { Card, CodeBlock, ErrorCallout, Field, Spinner } from '../../components/ui.jsx'
import { api } from '../../lib/api.js'
import { countLines, formatBytes, formatInt } from '../../lib/format.js'

// The row-by-row report the browser receives is ~14x the CSV's size, so the console is for
// reviewing exports up to a few MB; larger files belong in the container, which writes to disk.
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024
const MAX_UI_PATIENTS = 20_000
const PREVIEW_LINES = 60

const SOURCE_LABEL = {
  sample: 'GlobalHealth sample (from the assessment brief)',
  upload: 'Uploaded file',
  generated: 'Synthetic dataset',
}

export function DatasetPanel({ dataset, onChange }) {
  const [patients, setPatients] = useState(1000)
  const [seed, setSeed] = useState(42)
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)
  const [isOver, setIsOver] = useState(false)
  const fileInput = useRef(null)

  const run = async (kind, task) => {
    setBusy(kind)
    setError(null)
    try {
      onChange(await task())
    } catch (caught) {
      setError(caught)
    } finally {
      setBusy(null)
    }
  }

  const loadSample = () =>
    run('sample', async () => {
      const sample = await api.sample()
      return { fileName: sample.fileName, csv: sample.csv, source: 'sample' }
    })

  const generate = () =>
    run('generate', async () => {
      const count = Math.min(MAX_UI_PATIENTS, Math.max(1, Math.round(Number(patients) || 1)))
      const dataset = await api.generate(count, Math.round(Number(seed) || 0))
      return { fileName: dataset.fileName, csv: dataset.csv, source: 'generated' }
    })

  const readFile = (file) => {
    if (!file) return
    if (file.size > MAX_UPLOAD_BYTES) {
      setError(
        new Error(
          `${file.name} is ${formatBytes(file.size)}; the console reviews files up to ${formatBytes(MAX_UPLOAD_BYTES)}. Run larger exports through the container (npm run ingest or docker run).`,
        ),
      )
      return
    }
    run('upload', async () => ({ fileName: file.name, csv: await file.text(), source: 'upload' }))
  }

  const onDrop = (event) => {
    event.preventDefault()
    setIsOver(false)
    // One load at a time, otherwise whichever finishes last silently wins.
    if (busy === null) readFile(event.dataTransfer.files?.[0])
  }

  const details = useMemo(() => {
    if (!dataset) return null
    return {
      lines: countLines(dataset.csv),
      bytes: new Blob([dataset.csv]).size,
      preview: dataset.csv.split(/\r\n|\r|\n/, PREVIEW_LINES).join('\n'),
    }
  }, [dataset])

  return (
    <Card
      title="Source data"
      subtitle="The legacy export to normalise: GlobalHealth's sample, your own CSV, or a large synthetic file with the same defects."
    >
      <div
        className={`dropzone${isOver ? ' is-over' : ''}`}
        onDragOver={(event) => {
          event.preventDefault()
          setIsOver(true)
        }}
        onDragLeave={() => setIsOver(false)}
        onDrop={onDrop}
      >
        <div className="dropzone-icon">
          <Icon name="file" size={20} />
        </div>
        <div style={{ minWidth: 0, flex: '1 1 220px' }}>
          <strong>{dataset ? dataset.fileName : 'No file loaded'}</strong>
          <div className="dataset-meta">
            {details ? (
              <>
                <span>{SOURCE_LABEL[dataset.source]}</span>
                <span aria-hidden="true">·</span>
                <span>{formatInt(details.lines)} lines incl. header</span>
                <span aria-hidden="true">·</span>
                <span>{formatBytes(details.bytes)}</span>
              </>
            ) : (
              <span>Drop a CSV here, or pick a source.</span>
            )}
          </div>
        </div>
        <div className="row">
          <button type="button" className="btn" onClick={loadSample} disabled={busy !== null}>
            {busy === 'sample' ? <Spinner /> : <Icon name="file" size={15} />}
            Load sample
          </button>
          <button type="button" className="btn" onClick={() => fileInput.current?.click()} disabled={busy !== null}>
            {busy === 'upload' ? <Spinner /> : <Icon name="upload" size={15} />}
            Upload CSV
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".csv,text/csv"
            hidden
            onChange={(event) => {
              readFile(event.target.files?.[0])
              event.target.value = ''
            }}
          />
        </div>
      </div>

      <div className="divider" />

      <div className="row" style={{ alignItems: 'flex-end', gap: 12 }}>
        <div style={{ width: 150 }}>
          <Field label="Patients" htmlFor="gen-patients">
            <input
              id="gen-patients"
              className="input"
              type="number"
              min={1}
              max={MAX_UI_PATIENTS}
              step={100}
              value={patients}
              onChange={(event) => setPatients(event.target.value)}
            />
          </Field>
        </div>
        <div style={{ width: 110 }}>
          <Field label="Seed" htmlFor="gen-seed">
            <input id="gen-seed" className="input" type="number" value={seed} onChange={(event) => setSeed(event.target.value)} />
          </Field>
        </div>
        <button type="button" className="btn" onClick={generate} disabled={busy !== null}>
          {busy === 'generate' ? <Spinner /> : <Icon name="sparkles" size={15} />}
          Generate synthetic dataset
        </button>
        <p className="muted" style={{ margin: 0, fontSize: 12.5, flex: '1 1 260px' }}>
          Mixed date formats, currency symbols, unquoted thousands separators, out-of-order duplicates, a few impossible
          dates and ~1% malformed emails that the SHC API will reject. Use it to watch batching, rate limiting and retries.
        </p>
      </div>

      {error && (
        <div style={{ marginTop: 12 }}>
          <ErrorCallout error={error} title="Could not load the dataset." />
        </div>
      )}

      {details && (
        <details className="disclosure" style={{ marginTop: 14 }}>
          <summary>
            <Icon name="chevronRight" size={14} />
            Preview raw file{details.lines > PREVIEW_LINES ? ` (first ${PREVIEW_LINES} lines)` : ''}
          </summary>
          <CodeBlock code={details.preview} lineNumbers maxHeight={320} />
        </details>
      )}
    </Card>
  )
}
