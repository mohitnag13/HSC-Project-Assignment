import { useEffect, useState } from 'react'
import { api, streamRunEvents } from './api.js'

const MAX_LOG_ENTRIES = 500

/** The server pings every 10 s; this much silence means the stream is dead even if it looks open. */
const STALL_MS = 25_000

export const EMPTY_RUN_STATE = Object.freeze({
  runId: null,
  started: null,
  progress: null,
  summary: null,
  aborting: null,
  requests: [],
  failures: [],
  log: [],
  retries: 0,
  isolations: 0,
  bisections: 0,
  lastSeq: 0,
  elapsedMs: 0,
  connected: false,
  /** The backend no longer knows this run (it restarted mid-run); runs live in memory. */
  lost: false,
})

function apply(draft, event) {
  // Replays after a reconnect may repeat events; seq makes application idempotent.
  if (event.seq <= draft.lastSeq) return
  draft.lastSeq = event.seq
  draft.elapsedMs = event.elapsedMs
  switch (event.type) {
    case 'run_started':
      draft.started = event
      break
    case 'request_completed':
      draft.requests.push(event)
      draft.log.push(event)
      break
    case 'retry_scheduled':
      draft.retries += 1
      draft.log.push(event)
      break
    case 'records_isolated':
      draft.isolations += 1
      draft.log.push(event)
      break
    case 'batch_bisected':
      draft.bisections += 1
      draft.log.push(event)
      break
    case 'records_failed':
      draft.failures.push(event)
      draft.log.push(event)
      break
    case 'run_aborting':
      draft.aborting = event
      draft.log.push(event)
      break
    case 'progress':
      draft.progress = event
      break
    case 'run_finished':
      draft.summary = event.summary
      draft.log.push(event)
      break
    default:
      break
  }
}

export function applyEvents(state, events) {
  const draft = { ...state, requests: state.requests.slice(), failures: state.failures.slice(), log: state.log.slice() }
  for (const event of events) apply(draft, event)
  if (draft.log.length > MAX_LOG_ENTRIES) draft.log = draft.log.slice(-MAX_LOG_ENTRIES)
  return draft
}

/** Live state of an ingestion run, built from its event stream. Bursts are applied in one render. */
export function useRunStream(runId) {
  const [state, setState] = useState(EMPTY_RUN_STATE)

  useEffect(() => {
    if (!runId) return undefined
    // State from a previous run is discarded as soon as this run's first update lands.
    const own = (previous) => (previous.runId === runId ? previous : { ...EMPTY_RUN_STATE, runId })

    let disposed = false
    let settled = false // the run's outcome is known (stream ended, or recovered as finished or lost)
    let recovering = false
    let lastSeq = 0
    let lastActivity = Date.now()
    let queue = []
    let flushTimer = 0
    let retryTimer = 0
    let closeStream = () => undefined

    const flush = () => {
      flushTimer = 0
      const events = queue
      queue = []
      setState((previous) => applyEvents(own(previous), events))
    }

    // The stream is gone (HTTP error, or silent past STALL_MS): ask the API what became of the run.
    const recover = async () => {
      recovering = true
      closeStream()
      try {
        const view = await api.run(runId)
        if (disposed) return
        if (view.status === 'running') {
          retryTimer = setTimeout(connect, 1000)
        } else {
          settled = true
          setState((previous) => ({ ...own(previous), summary: previous.summary ?? view.summary, connected: false }))
        }
      } catch (error) {
        if (disposed) return
        if (error.status === 404) {
          settled = true
          setState((previous) => ({ ...own(previous), lost: true, connected: false }))
        } else {
          retryTimer = setTimeout(recover, 3000)
        }
      }
    }

    const connect = () => {
      recovering = false
      lastActivity = Date.now()
      closeStream = streamRunEvents(runId, {
        after: lastSeq,
        onEvent: (event) => {
          lastSeq = Math.max(lastSeq, event.seq)
          queue.push(event)
          flushTimer ||= setTimeout(flush, 50)
        },
        onActivity: () => {
          lastActivity = Date.now()
        },
        onEnd: () => {
          settled = true
        },
        onConnectionChange: (connected) => setState((previous) => ({ ...own(previous), connected })),
        onClosed: () => {
          if (!disposed && !recovering) recover()
        },
      })
    }

    // A proxy can keep a dead stream open (no data, no error); silence is the only symptom.
    const watchdog = setInterval(() => {
      if (!settled && !recovering && Date.now() - lastActivity > STALL_MS) recover()
    }, 5000)

    connect()
    return () => {
      disposed = true
      closeStream()
      clearInterval(watchdog)
      clearTimeout(flushTimer)
      clearTimeout(retryTimer)
    }
  }, [runId])

  return state.runId === runId ? state : { ...EMPTY_RUN_STATE, runId }
}
