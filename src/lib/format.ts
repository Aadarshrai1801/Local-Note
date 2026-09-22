/**
 * Formatting + small pure helpers shared by every view.
 *
 * Nothing in here touches the DOM or the IPC bridge, so it is safe to use from
 * anywhere in the renderer (and easy to unit test later).
 */

/** Join class names, dropping falsy values. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/* ------------------------------------------------------------------ */
/* Durations + timestamps                                              */
/* ------------------------------------------------------------------ */

/**
 * `mm:ss` (or `h:mm:ss` past an hour). Used for transcript timestamps and the
 * live timer, always rendered in monospace.
 */
export function formatClock(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '--:--'
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`
}

/** Human duration: `1h 04m`, `12m 30s`, `48s`. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return '0s'
  const total = Math.round(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}h ${pad2(m)}m`
  if (m > 0) return `${m}m ${pad2(s)}s`
  return `${s}s`
}

/** Compact duration for dense lists: `1h 04m`, `42m`. */
export function formatDurationCompact(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return '—'
  const total = Math.round(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  if (h > 0) return `${h}h ${pad2(m)}m`
  if (m > 0) return `${m}m`
  return `${total}s`
}

/** Seconds → `12s` / `1m 20s`, for the transcription backlog hint. */
export function formatSeconds(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return '0s'
  const whole = Math.round(seconds)
  if (whole < 60) return `${whole}s`
  return `${Math.floor(whole / 60)}m ${pad2(whole % 60)}s`
}

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric'
})
const dateShortFormatter = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false
})
const weekdayFormatter = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  month: 'short',
  day: 'numeric'
})

/** `Sep 12, 2026` */
export function formatDate(ts: number | null | undefined): string {
  if (ts == null || !Number.isFinite(ts)) return '—'
  return dateFormatter.format(new Date(ts))
}

/** `12 Sep` — for dense rows where the year is implied. */
export function formatDateShort(ts: number | null | undefined): string {
  if (ts == null || !Number.isFinite(ts)) return '—'
  return dateShortFormatter.format(new Date(ts))
}

/** `14:32` in 24-hour time. */
export function formatTime(ts: number | null | undefined): string {
  if (ts == null || !Number.isFinite(ts)) return '--:--'
  return timeFormatter.format(new Date(ts))
}

function startOfDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** Day bucket label used to group the meeting list: `Today`, `Yesterday`, `Monday, Sep 15`. */
export function formatDayGroup(
  ts: number | null | undefined,
  now: number = Date.now()
): string {
  if (ts == null || !Number.isFinite(ts)) return 'Unknown date'
  const days = Math.round((startOfDay(now) - startOfDay(ts)) / 86_400_000)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 7) return weekdayFormatter.format(new Date(ts))
  return formatDate(ts)
}

/** `just now`, `24m ago`, `2d ago`. */
export function formatRelative(ts: number | null | undefined, now: number = Date.now()): string {
  if (ts == null || !Number.isFinite(ts)) return '—'
  const diff = now - ts
  if (diff < 60_000) return 'just now'
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return formatDateShort(ts)
}

/** `2.4 GB` — used for model sizes. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const rounded = value >= 10 || unit === 0 ? Math.round(value) : Math.round(value * 10) / 10
  return `${rounded} ${units[unit]}`
}

const numberFormatter = new Intl.NumberFormat()

export function formatCount(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '0'
  return numberFormatter.format(n)
}

/* ------------------------------------------------------------------ */
/* Text helpers                                                        */
/* ------------------------------------------------------------------ */

export function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean.length <= max) return clean
  return `${clean.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

export function plural(n: number, singular: string, pluralForm?: string): string {
  const word = n === 1 ? singular : (pluralForm ?? `${singular}s`)
  return `${formatCount(n)} ${word}`
}

export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'meeting'
  )
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

/** Turn an unknown thrown value into something worth showing a user. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  if (typeof error === 'string') return error
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string') return message
  }
  return 'Something went wrong'
}

/** Split a query into individual search terms worth highlighting. */
export function queryTerms(query: string): string[] {
  return Array.from(
    new Set(
      query
        .toLowerCase()
        .split(/[^\p{L}\p{N}_+-]+/u)
        .map((t) => t.trim())
        .filter((t) => t.length >= 2)
    )
  )
}

export interface HighlightPart {
  text: string
  match: boolean
}

/**
 * Split `text` into parts, flagging the pieces that match any term in `query`
 * so the caller can render them with `<mark>` (or any other styling).
 */
export function splitHighlight(text: string, query: string): HighlightPart[] {
  const terms = queryTerms(query)
  if (terms.length === 0) return [{ text, match: false }]
  const escaped = terms
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')
  const re = new RegExp(`(${escaped})`, 'gi')
  const parts: HighlightPart[] = []
  let last = 0
  for (const match of text.matchAll(re)) {
    const index = match.index ?? 0
    if (index > last) parts.push({ text: text.slice(last, index), match: false })
    parts.push({ text: match[0], match: true })
    last = index + match[0].length
  }
  if (last < text.length) parts.push({ text: text.slice(last), match: false })
  return parts.length > 0 ? parts : [{ text, match: false }]
}

/** Copy to the clipboard, with a fallback for environments without the async API. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fall through to the legacy path below
  }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', 'true')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(area)
    return ok
  } catch {
    return false
  }
}
