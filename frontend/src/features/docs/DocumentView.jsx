import { Icon } from '../../components/Icon.jsx'
import { Card, CopyButton, EmptyState, ErrorCallout, MarkdownView, PageHeader, Spinner } from '../../components/ui.jsx'
import { downloadText } from '../../lib/api.js'
import { useDeliverables } from '../../lib/hooks.js'

const HEADER_LINE = /^\*\*(To|From|Cc|Subject):\*\*\s*(.+?)\s*$/

/** Splits "**To:** …" style header lines off an email written in Markdown. */
function parseEmail(markdown) {
  const lines = markdown.split(/\r?\n/)
  const headers = []
  let bodyStart = -1
  for (let index = 0; index < lines.length; index += 1) {
    const match = HEADER_LINE.exec(lines[index])
    if (match) headers.push([match[1], match[2]])
    else if (headers.length > 0 && /^-{3,}\s*$/.test(lines[index])) {
      bodyStart = index + 1
      break
    }
  }
  if (headers.length === 0 || bodyStart === -1) return null
  return { headers, body: lines.slice(bodyStart).join('\n').trim() }
}

export function DocumentView({ docId, eyebrow, title, description, asEmail = false }) {
  const { items, error } = useDeliverables()
  const doc = items?.find((item) => item.id === docId)
  const email = asEmail && doc?.content ? parseEmail(doc.content) : null

  return (
    <>
      <PageHeader
        eyebrow={eyebrow}
        title={title}
        description={description}
        actions={
          doc?.content && (
            <>
              <CopyButton text={doc.content} label="Copy Markdown" />
              <button type="button" className="btn btn-sm" onClick={() => downloadText(doc.title.split('/').pop(), doc.content, 'text/markdown')}>
                <Icon name="download" size={14} />
                Download
              </button>
            </>
          )
        }
      />
      {error && <ErrorCallout error={error} title="Could not load the document." />}
      {!items && !error && (
        <Card>
          <EmptyState icon="file">
            <Spinner />
          </EmptyState>
        </Card>
      )}
      {items && !doc?.content && (
        <Card>
          <EmptyState icon="file" title="Document not found">
            Expected at {doc?.path ?? docId}.
          </EmptyState>
        </Card>
      )}
      {doc?.content &&
        (email ? (
          <div className="email-frame">
            <dl className="email-head">
              {email.headers.map(([name, value]) => (
                <div key={name} style={{ display: 'contents' }}>
                  <dt>{name}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
            <div className="email-body">
              <MarkdownView source={email.body} />
            </div>
          </div>
        ) : (
          <Card subtitle={doc.path}>
            <MarkdownView source={doc.content} />
          </Card>
        ))}
    </>
  )
}
