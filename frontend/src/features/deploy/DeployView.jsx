import { useState } from 'react'
import { Icon } from '../../components/Icon.jsx'
import { Badge, Card, CodeBlock, ErrorCallout, PageHeader, Spinner } from '../../components/ui.jsx'
import { useDeliverables } from '../../lib/hooks.js'

const FEATURES = [
  { icon: 'layers', title: 'Multi-stage build', text: 'Dependencies and the TypeScript compile run in throw-away stages; the runtime image carries only compiled JS and production dependencies.' },
  { icon: 'user', title: 'Non-root by default', text: 'Runs as the unprivileged "node" user (uid 1000). Application files are root-owned and read-only to that user.' },
  { icon: 'key', title: 'Secrets stay outside the image', text: 'SHC_API_TOKEN, or SHC_API_TOKEN_FILE for Docker/Kubernetes secrets. The token is never logged.' },
  { icon: 'settings', title: 'Environment-driven', text: 'API URL, file paths, batch size, rate limit, retries and backoff are all environment variables, validated at start-up.' },
  { icon: 'shield', title: 'Hardened at run time', text: 'Works with --read-only, --cap-drop ALL and no-new-privileges; it only writes to the mounted output volume.' },
  { icon: 'terminal', title: 'Scheduler-friendly', text: 'tini as PID 1 for clean signal handling, JSON logs on stdout, and meaningful exit codes for cron or Kubernetes Jobs.' },
]

const COMMANDS = {
  bash: `# 1. Build the image (from the repository root)
docker build -t shc-ingest:1.0.0 ./backend

# 2. Run it against the SHC API
#    --user lets the non-root container write to an output folder you own
mkdir -p output
docker run --rm --user "$(id -u):$(id -g)" \\
  -e SHC_API_URL=https://api.mock-shc.com/v1/patients \\
  -e SHC_API_TOKEN="$SHC_API_TOKEN" \\
  -v "$PWD/backend/data:/data/input:ro" \\
  -v "$PWD/output:/data/output" \\
  --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \\
  shc-ingest:1.0.0

# Dry run: normalise only, no API calls
docker run --rm -e DRY_RUN=true -v "$PWD/backend/data:/data/input:ro" -v "$PWD/output:/data/output" shc-ingest:1.0.0

# Token from a mounted secret file instead of an environment variable
docker run --rm -e SHC_API_TOKEN_FILE=/run/secrets/shc_api_token \\
  -v "$PWD/secrets/shc_api_token:/run/secrets/shc_api_token:ro" ... shc-ingest:1.0.0

# 3. End-to-end locally against the bundled mock SHC API
docker compose up --build --abort-on-container-exit --exit-code-from ingest`,
  powershell: `# 1. Build the image (from the repository root)
docker build -t shc-ingest:1.0.0 ./backend

# 2. Run it against the SHC API
New-Item -ItemType Directory -Force output | Out-Null
docker run --rm \`
  -e SHC_API_URL=https://api.mock-shc.com/v1/patients \`
  -e SHC_API_TOKEN=$env:SHC_API_TOKEN \`
  -v "\${PWD}/backend/data:/data/input:ro" \`
  -v "\${PWD}/output:/data/output" \`
  --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \`
  shc-ingest:1.0.0

# Dry run: normalise only, no API calls
docker run --rm -e DRY_RUN=true -v "\${PWD}/backend/data:/data/input:ro" -v "\${PWD}/output:/data/output" shc-ingest:1.0.0

# 3. End-to-end locally against the bundled mock SHC API
docker compose up --build --abort-on-container-exit --exit-code-from ingest`,
}

const EXIT_CODES = [
  ['0', 'Every normalised record was loaded.'],
  ['1', 'Fatal: invalid configuration, unreadable input or unwritable output, or the run was aborted (redirect, 401/403/404, or the API unreachable for three batches in a row).'],
  ['2', 'Finished, but some records are in failed_records.json.'],
  ['130', 'Cancelled by SIGINT/SIGTERM after in-flight requests completed.'],
]

const SCOPES = [
  { id: 'pipeline', title: 'Ingestion pipeline (the container)' },
  { id: 'mock-api', title: 'Mock SHC API (local testing)' },
  { id: 'console', title: 'Migration console (this UI)' },
]

export function DeployView({ config }) {
  const [shell, setShell] = useState('bash')
  const { items, error } = useDeliverables()
  const files = ['dockerfile', 'compose', 'env'].map((id) => items?.find((item) => item.id === id)).filter(Boolean)

  return (
    <>
      <PageHeader
        eyebrow="Task 3 · Containerization"
        title="Run it inside GlobalHealth's infrastructure"
        description="The ingestion script ships as a production-hardened container image, so it runs entirely on-premise next to the legacy system. No patient data leaves their network except through the SHC API call itself."
      />

      <Card title="What the image guarantees">
        <ul className="feature-list">
          {FEATURES.map((feature) => (
            <li key={feature.title}>
              <Icon name={feature.icon} size={18} />
              <span>
                <strong>{feature.title}</strong>
                <span className="muted">{feature.text}</span>
              </span>
            </li>
          ))}
        </ul>
      </Card>

      <Card
        title="Build and run"
        subtitle="Mount the export read-only at /data/input; failed_records.json and run_report.json are written to /data/output."
        actions={
          <div className="segmented" role="group" aria-label="Shell">
            <button type="button" aria-pressed={shell === 'bash'} onClick={() => setShell('bash')}>
              Bash
            </button>
            <button type="button" aria-pressed={shell === 'powershell'} onClick={() => setShell('powershell')}>
              PowerShell
            </button>
          </div>
        }
      >
        <CodeBlock code={COMMANDS[shell]} />
      </Card>

      <Card title="Configuration" subtitle="Every setting is an environment variable. Secrets are marked; never bake them into the image.">
        {!config ? (
          <Spinner />
        ) : (
          <div className="stack">
            {SCOPES.map((scope) => (
              <div key={scope.id}>
                <h3 className="section-label">{scope.title}</h3>
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Variable</th>
                        <th>Default</th>
                        <th>Purpose</th>
                      </tr>
                    </thead>
                    <tbody>
                      {config.envVars
                        .filter((variable) => variable.scope === scope.id)
                        .map((variable) => (
                          <tr key={variable.name}>
                            <td className="mono nowrap">
                              {variable.name}{' '}
                              {variable.secret && (
                                <Badge tone="serious" icon="key">
                                  secret
                                </Badge>
                              )}
                            </td>
                            <td className="mono">{variable.defaultValue}</td>
                            <td>{variable.description}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <div className="grid-2">
        <Card title="Exit codes" subtitle="For cron, Kubernetes Jobs or any scheduler.">
          <div className="table-wrap">
            <table className="table">
              <tbody>
                {EXIT_CODES.map(([code, meaning]) => (
                  <tr key={code}>
                    <td className="mono num" style={{ width: 60 }}>
                      {code}
                    </td>
                    <td>{meaning}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
        <Card title="Outputs" subtitle="Written to OUTPUT_DIR (/data/output in the container).">
          <dl className="kv">
            <dt className="mono">failed_records.json</dt>
            <dd>
              Every record the API refused (with the API's error for that record), or that exhausted its retries. Written once at the
              end; while running, failures are journaled to failed_records.json.partial.ndjson so nothing is lost if the process dies.
              A previous file is archived, not overwritten.
            </dd>
            <dt className="mono">run_report.json</dt>
            <dd>Anomaly counts, quarantined rows (line number, code and field), duplicate decisions and the load summary. No patient data.</dd>
            <dt className="mono">normalized_records.json</dt>
            <dd>Dry runs only (DRY_RUN=true or the transform command): the cleaned records, for review before loading.</dd>
          </dl>
        </Card>
      </div>

      {error && <ErrorCallout error={error} title="Could not load the deliverable files." />}
      {files.map((file) => (
        <Card key={file.id} title={file.title} subtitle={file.path}>
          {file.content ? <CodeBlock code={file.content} lineNumbers maxHeight={560} /> : <p className="muted">File not found.</p>}
        </Card>
      ))}
    </>
  )
}
