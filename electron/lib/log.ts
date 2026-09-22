import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getPaths } from './paths'

/**
 * Local-only logging. Nothing is ever sent anywhere: logs are appended to a
 * file in the user's data directory and shown in Settings > Diagnostics.
 *
 * This doubles as the app's crash log, which is why every entry is written
 * synchronously and defensively.
 */

type Level = 'debug' | 'info' | 'warn' | 'error'

let logFile: string | null = null
let mirrorToConsole = true

function getLogFile(): string {
  if (logFile) return logFile
  const dir = getPaths().logsDir
  const day = new Date().toISOString().slice(0, 10)
  logFile = join(dir, `localnote-${day}.log`)
  return logFile
}

export function setConsoleMirroring(enabled: boolean): void {
  mirrorToConsole = enabled
}

function write(level: Level, scope: string, message: string, detail?: unknown): void {
  const stamp = new Date().toISOString()
  let line = `${stamp} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`

  if (detail !== undefined) {
    line += ' :: ' + safeStringify(detail)
  }

  if (mirrorToConsole) {
    const method = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
    method(line)
  }

  try {
    appendFileSync(getLogFile(), line + '\n', 'utf8')
  } catch {
    // Never let logging failure break the app.
  }
}

function safeStringify(value: unknown): string {
  if (value instanceof Error) {
    return `${value.name}: ${value.message}${value.stack ? '\n' + value.stack : ''}`
  }
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export interface Logger {
  debug(message: string, detail?: unknown): void
  info(message: string, detail?: unknown): void
  warn(message: string, detail?: unknown): void
  error(message: string, detail?: unknown): void
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m, d) => write('debug', scope, m, d),
    info: (m, d) => write('info', scope, m, d),
    warn: (m, d) => write('warn', scope, m, d),
    error: (m, d) => write('error', scope, m, d)
  }
}

/** Returns the last N lines of today's log for the diagnostics panel. */
export function tailLog(lines = 200): string {
  try {
    const file = getLogFile()
    if (!existsSync(file)) return '(no log entries yet)'
    const content = readFileSync(file, 'utf8')
    const all = content.split('\n')
    return all.slice(Math.max(0, all.length - lines)).join('\n')
  } catch (error) {
    return `(could not read log: ${String(error)})`
  }
}

/** Writes a startup banner. Keeps a visible record of app + runtime versions. */
export function logStartupBanner(extra: Record<string, unknown>): void {
  const banner = [
    '='.repeat(72),
    `Local Note starting at ${new Date().toISOString()}`,
    `node ${process.versions.node}  electron ${process.versions.electron ?? 'n/a'}  chrome ${process.versions.chrome ?? 'n/a'}`,
    `platform ${process.platform} ${process.arch}`,
    JSON.stringify(extra, null, 2),
    '='.repeat(72)
  ].join('\n')
  try {
    appendFileSync(getLogFile(), banner + '\n', 'utf8')
  } catch {
    /* ignore */
  }
}

export function ensureLogFile(): void {
  try {
    const file = getLogFile()
    if (!existsSync(file)) writeFileSync(file, '', 'utf8')
  } catch {
    /* ignore */
  }
}
