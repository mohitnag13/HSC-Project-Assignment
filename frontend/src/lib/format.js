const integerFormat = new Intl.NumberFormat('en-US')
const compactFormat = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })
const moneyFormat = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export const formatInt = (value) => (value === null || value === undefined ? '–' : integerFormat.format(value))

/** Exact below 10,000; compact (12.9K) above. */
export const formatCompact = (value) =>
  value === null || value === undefined ? '–' : Math.abs(value) >= 10_000 ? compactFormat.format(value) : integerFormat.format(value)

export const formatAmount = (value) => (value === null || value === undefined ? '–' : moneyFormat.format(value))

export function formatDuration(ms) {
  if (ms === null || ms === undefined) return '–'
  if (ms < 1000) return `${Math.round(ms)} ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`
  // Round once, then split, so 119.6 s reads "2 min 0 s" rather than "1 min 60 s".
  const total = Math.round(seconds)
  return `${Math.floor(total / 60)} min ${total % 60} s`
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export const formatClock = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour12: false }) : '–')

export const formatDateTime = (iso) =>
  iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'medium', hour12: false }) : '–'

export const plural = (count, word, pluralWord = `${word}s`) => `${formatInt(count)} ${count === 1 ? word : pluralWord}`

export const countLines = (text) => (text ? text.split(/\r\n|\r|\n/).filter((line) => line.trim() !== '').length : 0)
