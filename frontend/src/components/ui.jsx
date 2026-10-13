import { useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { formatInt } from '../lib/format.js'
import { SEVERITY } from '../lib/severity.js'
import { Icon } from './Icon.jsx'

const ROW_STATUS = {
  loaded: { tone: 'good', icon: 'checkCircle', label: 'Ready to load' },
  superseded: { tone: null, icon: 'layers', label: 'Superseded' },
  rejected: { tone: 'critical', icon: 'xCircle', label: 'Quarantined' },
}

const RUN_STATUS = {
  running: { tone: 'info', icon: 'retry', label: 'Running' },
  succeeded: { tone: 'good', icon: 'checkCircle', label: 'Succeeded' },
  completed_with_failures: { tone: 'warning', icon: 'alert', label: 'Completed with failures' },
  aborted: { tone: 'critical', icon: 'xCircle', label: 'Aborted' },
  cancelled: { tone: 'serious', icon: 'stop', label: 'Cancelled' },
  lost: { tone: 'critical', icon: 'alert', label: 'Connection lost' },
}

export function PageHeader({ eyebrow, title, description, actions }) {
  return (
    <header className="page-header">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="row">{actions}</div>}
    </header>
  )
}

export function Card({ title, subtitle, actions, children, className = '' }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <header className="card-header">
          <div>
            {title && <h2 className="card-title">{title}</h2>}
            {subtitle && <p className="card-sub">{subtitle}</p>}
          </div>
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      <div className="card-body">{children}</div>
    </section>
  )
}

export function StatTile({ label, value, sub, icon, tone }) {
  return (
    <div className="stat">
      <div className="stat-label">
        {icon && <Icon name={icon} size={14} className={`tone-${tone ?? 'neutral'}`} />}
        {label}
      </div>
      <div className="stat-value">{typeof value === 'number' ? formatInt(value) : value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  )
}

/** Status is always icon + label, never color alone. */
export function Badge({ tone, icon, children, title }) {
  return (
    <span className={`badge${tone ? ` badge--${tone}` : ''}`} title={title}>
      {icon && <Icon name={icon} size={13} className={`badge-icon tone-${tone ?? 'neutral'}`} />}
      {children}
    </span>
  )
}

export function SeverityBadge({ severity, children, title }) {
  const meta = SEVERITY[severity] ?? SEVERITY.info
  return (
    <Badge tone={meta.tone} icon={meta.icon} title={title}>
      {children ?? meta.label}
    </Badge>
  )
}

export function RowStatusBadge({ status }) {
  const meta = ROW_STATUS[status] ?? ROW_STATUS.rejected
  return (
    <Badge tone={meta.tone} icon={meta.icon}>
      {meta.label}
    </Badge>
  )
}

export function RunStatusBadge({ status }) {
  const meta = RUN_STATUS[status] ?? RUN_STATUS.running
  return (
    <Badge tone={meta.tone} icon={meta.icon}>
      {meta.label}
    </Badge>
  )
}

export function Callout({ tone = 'info', icon, title, children }) {
  const iconName = icon ?? { critical: 'xCircle', warning: 'alert', good: 'checkCircle', info: 'info' }[tone]
  return (
    <div className={`callout callout--${tone}`} role={tone === 'critical' ? 'alert' : undefined}>
      <Icon name={iconName} size={16} className={`tone-${tone}`} />
      <div>
        {title && <strong>{title}</strong>}
        {title && children ? ' ' : null}
        {children}
      </div>
    </div>
  )
}

export function ErrorCallout({ error, title = 'Something went wrong.' }) {
  if (!error) return null
  return (
    <Callout tone="critical" title={title}>
      {error.message}
      {Array.isArray(error.details) && error.details.length > 0 && (
        <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
          {error.details.map((detail) => (
            <li key={detail}>{detail}</li>
          ))}
        </ul>
      )}
    </Callout>
  )
}

export function CopyButton({ text, label = 'Copy' }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }
  return (
    <button type="button" className="btn btn-sm" onClick={copy}>
      <Icon name={copied ? 'check' : 'copy'} size={14} />
      {copied ? 'Copied' : label}
    </button>
  )
}

export function CodeBlock({ code, title, lineNumbers = false, maxHeight }) {
  const lines = code.replace(/\n$/, '').split('\n')
  return (
    <div className="code-block">
      {title && (
        <div className="code-title">
          <span className="mono">{title}</span>
          <CopyButton text={code} />
        </div>
      )}
      <pre className="code" style={maxHeight ? { maxHeight } : undefined}>
        <code>
          {lines.map((line, index) => (
            <span className="code-line" key={index}>
              {lineNumbers && <span className="code-line-no">{index + 1}</span>}
              {line || ' '}
            </span>
          ))}
        </code>
      </pre>
      {!title && (
        <div className="code-copy">
          <CopyButton text={code} />
        </div>
      )}
    </div>
  )
}

export function Pagination({ page, pageSize, total, onChange }) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const first = total === 0 ? 0 : page * pageSize + 1
  const last = Math.min(total, (page + 1) * pageSize)
  return (
    <div className="table-footer">
      <span>
        {formatInt(first)}–{formatInt(last)} of {formatInt(total)}
      </span>
      <div className="row">
        <button type="button" className="btn btn-sm" disabled={page === 0} onClick={() => onChange(page - 1)}>
          <Icon name="chevronLeft" size={14} />
          Previous
        </button>
        <span>
          Page {formatInt(page + 1)} of {formatInt(pageCount)}
        </span>
        <button type="button" className="btn btn-sm" disabled={page >= pageCount - 1} onClick={() => onChange(page + 1)}>
          Next
          <Icon name="chevronRight" size={14} />
        </button>
      </div>
    </div>
  )
}

export function Spinner() {
  return <span className="spinner" aria-hidden="true" />
}

export function EmptyState({ icon = 'info', title, children }) {
  return (
    <div className="empty">
      <Icon name={icon} size={22} />
      {title && <strong style={{ color: 'var(--ink)' }}>{title}</strong>}
      {children && <div>{children}</div>}
    </div>
  )
}

/** `hint` sits beside the label (short values); `help` goes under the control (explanations). */
export function Field({ label, hint, help, htmlFor, children }) {
  return (
    <div className="field">
      <label className="field-label" htmlFor={htmlFor}>
        <span>{label}</span>
        {hint && <span className="field-hint">{hint}</span>}
      </label>
      {children}
      {help && <span className="field-help">{help}</span>}
    </div>
  )
}

export function MarkdownView({ source }) {
  return (
    <div className="markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
        }}
      >
        {source}
      </Markdown>
    </div>
  )
}
