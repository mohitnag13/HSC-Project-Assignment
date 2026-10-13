/** Anomaly severities: each maps to a reserved status tone and always renders with an icon and a label. */
export const SEVERITY = {
  error: { tone: 'critical', icon: 'xCircle', label: 'Error' },
  warning: { tone: 'warning', icon: 'alert', label: 'Warning' },
  info: { tone: 'info', icon: 'info', label: 'Info' },
}
