// Starts the backend (console API + mock SHC API) and the frontend dev server
// together, with prefixed output. Ctrl+C stops both.
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const isWindows = process.platform === 'win32'

const services = [
  { name: 'backend ', color: 36, cwd: join(root, 'backend') },
  { name: 'frontend', color: 35, cwd: join(root, 'frontend') },
]

// Children write to a pipe, so ask for colour explicitly, unless the user opted out with NO_COLOR.
const childEnv = 'NO_COLOR' in process.env ? process.env : { ...process.env, FORCE_COLOR: '1' }

let stopping = false
const children = services.map(({ name, color, cwd }) => {
  const child = spawn('npm run dev', { cwd, shell: true, detached: !isWindows, env: childEnv })
  const prefix = `\x1b[${color}m[${name}]\x1b[0m `
  for (const [stream, target] of [
    [child.stdout, process.stdout],
    [child.stderr, process.stderr],
  ]) {
    let pending = ''
    stream.on('data', (chunk) => {
      pending += chunk
      const lines = pending.split(/\r?\n/)
      pending = lines.pop() ?? ''
      for (const line of lines) target.write(`${prefix}${line}\n`)
    })
  }
  child.on('exit', (code) => {
    if (!stopping) {
      console.log(`${prefix}exited with code ${code}; stopping the other service`)
      shutdown(code ?? 1)
    }
  })
  return child
})

function shutdown(code) {
  if (stopping) return
  stopping = true
  for (const child of children) {
    if (child.exitCode !== null) continue
    if (isWindows) spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'])
    else {
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch {
        // Already gone.
      }
    }
  }
  setTimeout(() => process.exit(code), 800)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

console.log('Starting the migration console: UI on http://localhost:5173, console API on :4000, mock SHC API on :4010')
