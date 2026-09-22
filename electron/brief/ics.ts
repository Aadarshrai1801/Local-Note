import { readFileSync } from 'node:fs'
import type { IcsImport } from '../../shared/api'

/**
 * Minimal iCalendar (.ics) reader.
 *
 * Local Note deliberately has no calendar *integration*: no OAuth, no account,
 * no sync. The user exports an .ics file from whatever calendar they use and
 * drops it in, which keeps the app completely offline while still pre-filling
 * the meeting title, time and attendee names.
 */

/** RFC 5545 line folding: continuations start with a space or tab. */
function unfoldLines(raw: string): string[] {
  const lines = raw.split(/\r\n|\n|\r/)
  const unfolded: string[] = []

  for (const line of lines) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && unfolded.length > 0) {
      unfolded[unfolded.length - 1] += line.slice(1)
    } else {
      unfolded.push(line)
    }
  }
  return unfolded
}

/** Unescapes TEXT values per RFC 5545 (\\n, \\, etc.). */
function unescapeText(value: string): string {
  return value
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
    .trim()
}

/**
 * Parses an iCalendar date-time.
 *
 * Three forms appear in practice:
 *   YYYYMMDDTHHMMSSZ  UTC
 *   YYYYMMDDTHHMMSS   floating local time (this is what most desktop clients emit)
 *   YYYYMMDD          all-day
 */
export function parseIcsDate(value: string): number | null {
  const clean = value.trim().replace(/^.*:/, '')

  let match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(clean)
  if (match) {
    const [, year, month, day, hour, minute, second, utc] = match
    const parts = {
      year: Number(year),
      month: Number(month),
      day: Number(day),
      hour: Number(hour),
      minute: Number(minute),
      second: Number(second)
    }
    if (utc) {
      return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
    }
    // Floating time is interpreted as local time, which is what the user sees
    // in their own calendar client.
    return new Date(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second
    ).getTime()
  }

  match = /^(\d{4})(\d{2})(\d{2})$/.exec(clean)
  if (match) {
    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 9, 0, 0).getTime()
  }

  const parsed = Date.parse(clean)
  return Number.isNaN(parsed) ? null : parsed
}

/** Pulls a display name out of a CN=... parameter. */
function extractCommonName(value: string): string | null {
  const match = /CN=("?)([^";]+)\1/i.exec(value)
  if (!match) return null
  const name = match[2].trim()
  return name.length > 0 ? name : null
}

export interface IcsParseResult extends IcsImport {
  /** Every VEVENT found, in file order. */
  events: Array<IcsImport & { uid: string | null }>
}

export function parseIcs(content: string): IcsParseResult {
  const lines = unfoldLines(content)

  const events: IcsParseResult['events'] = []
  let current: (IcsImport & { uid: string | null }) | null = null
  let inEvent = false

  for (const line of lines) {
    const upper = line.toUpperCase()

    if (upper.startsWith('BEGIN:VEVENT')) {
      inEvent = true
      current = {
        uid: null,
        title: null,
        startedAt: null,
        endedAt: null,
        attendees: [],
        description: null,
        location: null
      }
      continue
    }
    if (upper.startsWith('END:VEVENT')) {
      if (current) events.push(current)
      current = null
      inEvent = false
      continue
    }
    if (!inEvent || !current) continue

    const colon = line.indexOf(':')
    if (colon < 0) continue
    const rawName = line.slice(0, colon)
    const value = line.slice(colon + 1)
    const name = rawName.split(';')[0].toUpperCase()

    switch (name) {
      case 'SUMMARY':
        current.title = unescapeText(value)
        break
      case 'DTSTART':
        current.startedAt = parseIcsDate(line)
        break
      case 'DTEND':
        current.endedAt = parseIcsDate(line)
        break
      case 'LOCATION':
        current.location = unescapeText(value)
        break
      case 'DESCRIPTION':
        current.description = unescapeText(value)
        break
      case 'UID':
        current.uid = value.trim()
        break
      case 'ATTENDEE':
      case 'ORGANIZER': {
        const commonName = extractCommonName(rawName)
        if (commonName) {
          current.attendees.push(commonName)
        } else {
          // Fall back to the email local part, which is better than nothing.
          const email = /mailto:([^;,\s]+)/i.exec(value)?.[1] ?? value
          const local = email.split('@')[0]?.replace(/[._-]+/g, ' ').trim()
          if (local && local.length > 0 && !current.attendees.includes(local)) {
            current.attendees.push(local)
          }
        }
        break
      }
      default:
        break
    }
  }

  // Choose the most relevant event: the next upcoming one, else the most recent.
  const now = Date.now()
  const withTime = events.filter((event) => event.startedAt !== null)
  const upcoming = withTime
    .filter((event) => (event.startedAt ?? 0) >= now - 60 * 60 * 1000)
    .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
  const chosen =
    upcoming[0] ??
    withTime.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0] ??
    events[0] ??
    null

  if (!chosen) {
    return {
      title: null,
      startedAt: null,
      endedAt: null,
      attendees: [],
      description: null,
      location: null,
      events: []
    }
  }

  return {
    title: chosen.title,
    startedAt: chosen.startedAt,
    endedAt: chosen.endedAt,
    // De-duplicate attendee names; calendars repeat them across events.
    attendees: [...new Set(chosen.attendees)],
    description: chosen.description,
    location: chosen.location,
    events
  }
}

/** Reads and parses an .ics file from disk. */
export function readIcsFile(path: string): IcsParseResult {
  const content = readFileSync(path, 'utf8')
  return parseIcs(content)
}

/** Renders the calendar event as a one-line context string for prompts. */
export function icsToContext(result: IcsImport): string {
  const parts: string[] = []
  if (result.title) parts.push(result.title)
  if (result.startedAt) parts.push(new Date(result.startedAt).toLocaleString())
  if (result.attendees.length > 0) parts.push(`Attendees: ${result.attendees.join(', ')}`)
  if (result.location) parts.push(`Location: ${result.location}`)
  return parts.join(' | ')
}
