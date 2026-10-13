import { memo, useMemo, useState } from 'react'
import { Icon } from '../../components/Icon.jsx'
import {
  Badge,
  Callout,
  Card,
  CodeBlock,
  EmptyState,
  ErrorCallout,
  PageHeader,
  RowStatusBadge,
  Spinner,
  StatTile,
} from '../../components/ui.jsx'
import { downloadText } from '../../lib/api.js'
import { formatInt, plural } from '../../lib/format.js'
import { SEVERITY } from '../../lib/severity.js'
import { DatasetPanel } from './DatasetPanel.jsx'
import { RowsTable } from './RowsTable.jsx'

const DUPLICATE_PREVIEW = 4
const DUPLICATE_STEP = 50
const OUTPUT_PREVIEW = 25

function TransformStats({ stats }) {
  return (
    <div className="stats" style={{ '--tile-min': '190px' }}>
      <StatTile label="Rows in file" value={stats.totalRows} icon="file" />
      <StatTile label="Ready to load" value={stats.recordsReady} icon="checkCircle" tone="good" sub="unique patients" />
      <StatTile
        label="Duplicates"
        value={stats.duplicateRowsRemoved}
        icon="layers"
        sub={`superseded across ${plural(stats.patientsWithDuplicates, 'patient')}`}
      />
      <StatTile label="Rows repaired" value={stats.repairedRows} icon="wand" tone="warning" sub="column misalignment" />
      <StatTile
        label="Quarantined"
        value={stats.rejectedRows}
        icon="xCircle"
        tone={stats.rejectedRows > 0 ? 'critical' : undefined}
        sub="unusable rows"
      />
      <StatTile label="Dates normalised" value={stats.datesNormalized} icon="clock" sub={`${formatInt(stats.ambiguousDates)} ambiguous`} />
      <StatTile label="Missing email" value={stats.missingEmail} icon="mail" tone="warning" sub="loaded as null" />
      <StatTile label="Missing phone" value={stats.missingPhone} icon="alert" tone="warning" sub="loaded as null" />
      <StatTile
        label="Balances cleaned"
        value={stats.balancesCleaned}
        icon="sparkles"
        sub={`${formatInt(stats.foreignCurrencyBalances)} non-USD`}
      />
    </div>
  )
}

function AnomalyCard({ items, selected, onSelect }) {
  return (
    <Card title="Data anomalies" subtitle="Rows affected per anomaly. Select one to filter the rows below.">
      {items.length === 0 ? (
        <EmptyState icon="checkCircle" title="No anomalies">
          This export is already clean.
        </EmptyState>
      ) : (
        <ul className="anomaly-list">
          {items.map((item) => {
            const severity = SEVERITY[item.severity]
            return (
              <li key={item.code}>
                <button
                  type="button"
                  className="anomaly-item"
                  aria-pressed={selected === item.code}
                  onClick={() => onSelect(selected === item.code ? null : item.code)}
                >
                  <Icon name={severity.icon} size={16} className={`tone-${severity.tone}`} title={severity.label} />
                  <span>
                    <span className="anomaly-title">{item.title}</span>
                    <span className="muted mono" style={{ fontSize: 11.5 }}>
                      {'  '}
                      {item.code}
                    </span>
                    <div className="anomaly-desc">{item.description}</div>
                  </span>
                  <span className="anomaly-count">{formatInt(item.count)}</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}

const DUPLICATE_COLUMNS = ['email', 'phone', 'account_balance', 'dob', 'first_name', 'last_name']

function DuplicatesCard({ groups }) {
  // Revealed in steps: thousands of small tables at once would stall the page.
  const [shown, setShown] = useState(DUPLICATE_PREVIEW)
  const visible = groups.slice(0, shown)
  const expanded = shown > DUPLICATE_PREVIEW
  return (
    <Card
      title="Duplicate resolution"
      subtitle="Patients exported more than once. The version with the latest last_modified wins, wherever it sits in the file."
      actions={
        groups.length > DUPLICATE_PREVIEW && (
          <>
            {shown < groups.length && (
              <button type="button" className="btn btn-sm" onClick={() => setShown(shown + DUPLICATE_STEP)}>
                Show {formatInt(Math.min(DUPLICATE_STEP, groups.length - shown))} more of {formatInt(groups.length)}
              </button>
            )}
            {expanded && (
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setShown(DUPLICATE_PREVIEW)}>
                Show fewer
              </button>
            )}
          </>
        )
      }
    >
      {groups.length === 0 ? (
        <EmptyState icon="checkCircle" title="No duplicates">
          Every patient appears once.
        </EmptyState>
      ) : (
        <div style={{ maxHeight: expanded ? 640 : undefined, overflow: 'auto' }}>
          {visible.map((group) => {
            const columns = DUPLICATE_COLUMNS.filter((column) => group.changedFields.includes(column))
            return (
              <div className="dup-group" key={group.patientId}>
                <div className="dup-head">
                  <strong>{group.patientId}</strong>
                  {group.keptLine !== null ? (
                    <Badge tone="good" icon="checkCircle">
                      Kept line {group.keptLine}
                    </Badge>
                  ) : (
                    <Badge tone="critical" icon="xCircle">
                      Withheld
                    </Badge>
                  )}
                </div>
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th className="th-num">Line</th>
                        <th>last_modified</th>
                        <th>Outcome</th>
                        {columns.map((column) => (
                          <th key={column}>{column}</th>
                        ))}
                        {columns.length === 0 && <th>Changes</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {group.versions.map((version) => (
                        <tr key={version.line}>
                          <td className="num">{version.line}</td>
                          <td className="mono nowrap">{version.lastModified?.replace('.000Z', 'Z') ?? '—'}</td>
                          <td>
                            <RowStatusBadge status={version.status} />
                          </td>
                          {columns.map((column) => (
                            <td key={column} className={column === 'account_balance' ? 'num' : undefined}>
                              <span className="cell-changed">
                                {version.record[column] === null ? 'null' : String(version.record[column] ?? '—')}
                              </span>
                            </td>
                          ))}
                          {columns.length === 0 && <td className="muted">Identical after normalisation</td>}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {group.notes.map((note) => (
                  <div key={note} style={{ marginTop: 8 }}>
                    <Callout tone="warning">{note}</Callout>
                  </div>
                ))}
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}

function OutputCard({ records }) {
  const preview = useMemo(() => JSON.stringify(records.slice(0, OUTPUT_PREVIEW), null, 2), [records])
  return (
    <Card
      title="Normalised output"
      subtitle={`${plural(records.length, 'record')} in the canonical SHC shape: ISO 8601 dates, float balances, null for missing contact data.`}
      actions={
        // The full file (several MB for large exports) is only serialised when asked for.
        <button type="button" className="btn btn-sm" onClick={() => downloadText('normalized_records.json', JSON.stringify(records, null, 2))}>
          <Icon name="download" size={14} />
          Download normalized_records.json
        </button>
      }
    >
      <CodeBlock
        code={records.length > OUTPUT_PREVIEW ? `${preview}\n// … ${formatInt(records.length - OUTPUT_PREVIEW)} more records in the download` : preview}
        maxHeight={360}
      />
    </Card>
  )
}

// Memoised: the app re-renders on every health poll and run-stream flush, and this tree can hold 20k rows.
const TransformResults = memo(function TransformResults({ result, refreshing }) {
  const [codeFilter, setCodeFilter] = useState(null)
  return (
    <div className={`stack${refreshing ? ' is-refreshing' : ''}`} aria-busy={refreshing}>
      <TransformStats stats={result.stats} />
      <div className="grid-2">
        <AnomalyCard items={result.anomalySummary} selected={codeFilter} onSelect={setCodeFilter} />
        <DuplicatesCard groups={result.duplicates} />
      </div>
      <RowsTable rows={result.rows} codeFilter={codeFilter} onCodeFilterChange={setCodeFilter} />
      <OutputCard records={result.records} />
    </div>
  )
})

export function NormalizeView({ dataset, onDatasetChange, transform, onContinue }) {
  const result = transform.result

  return (
    <>
      <PageHeader
        eyebrow="Task 1 · Data extraction and normalisation"
        title="Extract & normalise"
        description="Parse GlobalHealth's legacy CSV, repair malformed rows, normalise dates (ISO 8601), balances (floats) and missing contact data, then keep only the most recently modified version of each patient."
        actions={
          result && (
            <button type="button" className="btn btn-primary" onClick={onContinue} disabled={result.records.length === 0}>
              Load {plural(result.records.length, 'record')} into SHC
              <Icon name="arrowRight" size={15} />
            </button>
          )
        }
      />

      <DatasetPanel dataset={dataset} onChange={onDatasetChange} />

      {transform.status === 'error' && (
        <div className="stack" style={{ gap: 8 }}>
          <ErrorCallout error={transform.error} title="The file could not be normalised." />
          {transform.error?.status === 0 && dataset && (
            <div>
              <button type="button" className="btn btn-sm" onClick={() => onDatasetChange({ ...dataset })}>
                <Icon name="retry" size={14} />
                Retry
              </button>
            </div>
          )}
        </div>
      )}

      {!result && transform.status === 'loading' && (
        <Card>
          <EmptyState icon="wand" title="Normalising…">
            <Spinner />
          </EmptyState>
        </Card>
      )}

      {result && (
        <TransformResults key={dataset?.id} result={result} refreshing={transform.status === 'loading'} />
      )}
    </>
  )
}
