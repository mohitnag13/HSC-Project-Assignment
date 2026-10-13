export const NUMERIC_FIELDS = [
  { key: 'batchSize', label: 'Batch size', help: 'API maximum: 100' },
  { key: 'maxRequestsPerSecond', label: 'Requests / second', help: 'API limit: 5' },
  { key: 'maxRetries', label: 'Max retries', help: 'Per batch (429/5xx)' },
  { key: 'concurrency', label: 'Concurrency', help: 'Batches in flight' },
  { key: 'backoffBaseMs', label: 'Backoff base (ms)', help: 'Doubles each retry' },
  { key: 'backoffMaxMs', label: 'Backoff cap (ms)', help: 'Longest single wait' },
  { key: 'requestTimeoutMs', label: 'Timeout (ms)', help: 'Per request' },
  { key: 'rateLimitSafetyMs', label: 'Safety margin (ms)', help: 'Absorbs network jitter' },
]

export function createIngestForm(config) {
  return {
    target: config?.mockApi ? 'mock' : 'custom',
    mockToken: config?.mockApi?.token ?? '',
    customUrl: config?.defaultApiUrl ?? 'https://api.mock-shc.com/v1/patients',
    customToken: '',
    settings: { ...(config?.ingestion.defaults ?? {}) },
  }
}

/**
 * Converts the form into the POST /api/runs payload (the server re-validates
 * everything). A cleared field is left out so the server applies its default,
 * rather than being sent as 0 (which would mean, say, zero retries).
 */
export function toRunPayload(form, dataset) {
  const settings = { bisectOn400: form.settings.bisectOn400 }
  for (const { key } of NUMERIC_FIELDS) {
    const value = form.settings[key]
    if (value !== '' && value !== null && value !== undefined) settings[key] = Number(value)
  }
  return {
    csv: dataset.csv,
    fileName: dataset.fileName,
    target:
      form.target === 'mock'
        ? { kind: 'mock', apiToken: form.mockToken }
        : { kind: 'custom', apiUrl: form.customUrl, apiToken: form.customToken },
    settings,
  }
}
