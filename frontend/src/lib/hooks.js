import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api.js'

const storage = {
  get(key) {
    try {
      return window.localStorage.getItem(key)
    } catch {
      return null
    }
  },
  set(key, value) {
    try {
      window.localStorage.setItem(key, value)
    } catch {
      // Storage can be unavailable (private mode, blocked site data); preferences are optional.
    }
  },
}

/** Tab routing via the URL hash, so a refresh keeps the current page. */
export function useHashRoute(routeIds, fallback) {
  const read = useCallback(() => {
    const id = window.location.hash.replace(/^#\/?/, '')
    return routeIds.includes(id) ? id : fallback
  }, [routeIds, fallback])
  const [route, setRoute] = useState(read)

  useEffect(() => {
    const onChange = () => setRoute(read())
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [read])

  const navigate = useCallback((id) => {
    window.location.hash = `/${id}`
    window.scrollTo({ top: 0 })
  }, [])
  return [route, navigate]
}

/** 'system' | 'light' | 'dark', applied as data-theme on <html>. */
export function useTheme() {
  const [theme, setTheme] = useState(() => storage.get('hsc-theme') ?? 'system')
  useEffect(() => {
    if (theme === 'system') delete document.documentElement.dataset.theme
    else document.documentElement.dataset.theme = theme
    storage.set('hsc-theme', theme)
  }, [theme])
  return [theme, setTheme]
}

/** Calls `load` now and every `intervalMs` while `enabled`. Keeps the last good data on error. */
export function usePolling(load, intervalMs, enabled = true) {
  const [state, setState] = useState({ data: null, error: null, loading: true })
  const loadRef = useRef(load)
  useEffect(() => {
    loadRef.current = load
  })

  const refresh = useCallback(async () => {
    try {
      const data = await loadRef.current()
      setState({ data, error: null, loading: false })
    } catch (error) {
      setState((previous) => ({ ...previous, error, loading: false }))
    }
  }, [])

  useEffect(() => {
    if (!enabled) return undefined
    refresh()
    const timer = setInterval(refresh, intervalMs)
    return () => clearInterval(timer)
  }, [enabled, intervalMs, refresh])

  return { ...state, refresh }
}

/** Runs the Task 1 transform whenever the dataset changes; keeps the previous result while refreshing. */
export function useTransform(dataset) {
  const [state, setState] = useState({ source: null, result: null, error: null })

  useEffect(() => {
    if (!dataset) return undefined
    const controller = new AbortController()
    api
      .transform(dataset.csv, controller.signal)
      .then((result) => setState({ source: dataset, result, error: null }))
      .catch((error) => {
        if (error.name !== 'AbortError') setState({ source: dataset, result: null, error })
      })
    return () => controller.abort()
  }, [dataset])

  const settled = state.source === dataset
  const status = !dataset ? 'idle' : !settled ? 'loading' : state.error ? 'error' : 'ready'
  return { status, result: state.result, error: settled ? state.error : null }
}

let deliverablesPromise = null

/** Deliverable documents (README, email, Dockerfile...) fetched once per session. */
export function useDeliverables() {
  const [state, setState] = useState({ items: null, error: null })
  useEffect(() => {
    let active = true
    deliverablesPromise ??= api.deliverables().catch((error) => {
      deliverablesPromise = null
      throw error
    })
    deliverablesPromise
      .then((items) => active && setState({ items, error: null }))
      .catch((error) => active && setState({ items: null, error }))
    return () => {
      active = false
    }
  }, [])
  return state
}
