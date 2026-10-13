export class ApiError extends Error {
  constructor(message, status, details = null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.details = details
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

async function request(path, { method = 'GET', body, signal } = {}) {
  let response
  try {
    response = await fetch(`/api${path}`, {
      method,
      signal,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch (error) {
    if (error.name === 'AbortError') throw error
    throw new ApiError('Cannot reach the console API. Start the backend with "npm run dev" in hsc/backend.', 0)
  }
  const text = await response.text()
  const data = text ? parseJson(text) : null
  if (!response.ok) {
    throw new ApiError(data?.message ?? `${response.status} ${response.statusText}`, response.status, data?.details ?? null)
  }
  return data
}

const runPath = (id) => `/runs/${encodeURIComponent(id)}`

export const api = {
  health: () => request('/health'),
  config: () => request('/config'),
  sample: () => request('/sample'),
  generate: (patients, seed) => request('/datasets/generate', { method: 'POST', body: { patients, seed } }),
  transform: (csv, signal) => request('/transform', { method: 'POST', body: { csv }, signal }),
  startRun: (payload) => request('/runs', { method: 'POST', body: payload }),
  runs: () => request('/runs'),
  run: (id) => request(runPath(id)),
  cancelRun: (id) => request(`${runPath(id)}/cancel`, { method: 'POST' }),
  failedRecords: (id) => request(`${runPath(id)}/failed-records`),
  failedRecordsDownloadUrl: (id) => `/api${runPath(id)}/failed-records?download=1`,
  mock: () => request('/mock'),
  updateMockSettings: (settings) => request('/mock/settings', { method: 'PUT', body: settings }),
  mockPatients: ({ offset = 0, limit = 25, query = '' } = {}) => {
    const params = new URLSearchParams({ offset: String(offset), limit: String(limit) })
    if (query) params.set('q', query)
    return request(`/mock/patients?${params}`)
  },
  resetMock: () => request('/mock/patients', { method: 'DELETE' }),
  deliverables: () => request('/deliverables'),
}

/**
 * Subscribes to a run's server-sent events, starting after event `after`.
 * EventSource retries dropped connections itself (sending Last-Event-ID), but
 * gives up for good on an HTTP error such as a 404 for a run the backend no
 * longer knows; `onClosed` reports that case so the caller can recover.
 */
export function streamRunEvents(runId, { after = 0, onEvent, onEnd, onConnectionChange, onClosed, onActivity }) {
  const source = new EventSource(`/api${runPath(runId)}/events${after ? `?after=${after}` : ''}`)
  source.onopen = () => {
    onActivity?.()
    onConnectionChange?.(true)
  }
  source.onmessage = (message) => {
    onActivity?.()
    const event = parseJson(message.data)
    if (event) onEvent(event)
  }
  // Heartbeats prove the stream is alive even while a batch sits in a long backoff.
  source.addEventListener('ping', () => onActivity?.())
  source.addEventListener('end', () => {
    source.close()
    onConnectionChange?.(false)
    onEnd?.()
  })
  source.onerror = () => {
    onConnectionChange?.(false)
    if (source.readyState === EventSource.CLOSED) onClosed?.()
  }
  return () => source.close()
}

/** Saves text as a file in the browser. */
export function downloadText(fileName, text, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const link = Object.assign(document.createElement('a'), { href: url, download: fileName })
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
