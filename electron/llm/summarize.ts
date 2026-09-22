import { createLogger } from '../lib/log'
import type { TranscriptSegment } from '../../shared/types'
import { OllamaClient } from './ollama'
import {
  SYSTEM_NOTETAKER,
  actionItemsPrompt,
  briefPrompt,
  chunkSummaryPrompt,
  crossMeetingQuestionPrompt,
  meetingQuestionPrompt,
  missedPrompt,
  reduceSummaryPrompt,
  repairActionItemsPrompt
} from './prompts'

const log = createLogger('summarize')

/**
 * Turns transcripts into summaries, action items and answers using the local
 * LLM.
 *
 * Two principles run through this file:
 *
 *  1. **Map-reduce for long input.** A one-hour meeting is far larger than a
 *     small model's context window, so the transcript is summarised in parts
 *     and the part-summaries are then merged. Nothing is silently truncated.
 *  2. **Never leave the user with nothing.** Every function has a degraded path
 *     that works without an LLM at all, so the app stays useful when Ollama is
 *     missing.
 */

export interface ProgressUpdate {
  progress: number
  label: string
}

export interface SummarizerOptions {
  client: OllamaClient
  model: string | null
  onProgress?: (update: ProgressUpdate) => void
}

export interface MeetingSummaryResult {
  summary: string
  actionItems: Array<{ text: string; assignee: string | null }>
  /** True when produced without an LLM. */
  degraded: boolean
}

/* ------------------------------------------------------------------ */
/* Transcript formatting                                               */
/* ------------------------------------------------------------------ */

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const pad = (value: number): string => String(value).padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`
}

/** Renders segments as `[mm:ss] Speaker: text`, which models read reliably. */
export function formatTranscript(segments: TranscriptSegment[], withTimestamps = true): string {
  return segments
    .map((segment) => {
      const speaker = segment.speakerLabel ?? (segment.source === 'mic' ? 'You' : 'Speaker')
      const stamp = withTimestamps ? `[${formatClock(segment.startMs)}] ` : ''
      return `${stamp}${speaker}: ${segment.text}`
    })
    .join('\n')
}

/**
 * Splits a transcript into map-phase chunks on segment boundaries, so a chunk
 * never cuts a sentence in half.
 */
export function chunkTranscript(segments: TranscriptSegment[], maxChars: number): string[] {
  const chunks: string[] = []
  let current: string[] = []
  let length = 0

  for (const segment of segments) {
    const speaker = segment.speakerLabel ?? (segment.source === 'mic' ? 'You' : 'Speaker')
    const line = `[${formatClock(segment.startMs)}] ${speaker}: ${segment.text}`

    if (length > 0 && length + line.length > maxChars) {
      chunks.push(current.join('\n'))
      current = []
      length = 0
    }
    current.push(line)
    length += line.length + 1
  }

  if (current.length > 0) chunks.push(current.join('\n'))
  return chunks
}

/* ------------------------------------------------------------------ */
/* Degraded (no-LLM) helpers                                           */
/* ------------------------------------------------------------------ */

const FILLER = new Set([
  'yeah', 'okay', 'ok', 'right', 'sure', 'hmm', 'um', 'uh', 'so', 'well', 'yes', 'no',
  'thanks', 'thank you', 'hello', 'hi', 'bye', 'got it', 'cool', 'nice', 'exactly'
])

function isSubstantive(text: string): boolean {
  const clean = text.trim().toLowerCase().replace(/[.!?,]+$/g, '')
  if (clean.length < 25) return false
  if (FILLER.has(clean)) return false
  return true
}

/**
 * Extractive fallback: picks the longest, most information-dense lines as a
 * stand-in summary. Crude, but honest and immediate.
 */
export function extractiveSummary(segments: TranscriptSegment[], maxPoints = 6): string {
  const scored = segments
    .filter((segment) => isSubstantive(segment.text))
    .map((segment) => {
      const words = segment.text.split(/\s+/).length
      // Reward longer turns, and turns with numbers or decision language.
      let score = words
      if (/\d/.test(segment.text)) score += 4
      if (/\b(decided|agreed|action|deadline|will|need to|budget|next step|let's)\b/i.test(segment.text)) {
        score += 6
      }
      return { segment, score }
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, maxPoints)
    // Restore chronological order so the summary reads sensibly.
    .sort((a, b) => a.segment.startMs - b.segment.startMs)

  if (scored.length === 0) {
    return 'No speech was transcribed for this meeting, so there is nothing to summarise yet.'
  }

  return [
    'KEY POINTS (generated without a language model — install Ollama for a proper summary):',
    ...scored.map((entry) => `- ${entry.segment.text.trim()}`)
  ].join('\n')
}

/** Extractive answer: returns the most relevant-looking lines verbatim. */
export function extractiveAnswer(segments: TranscriptSegment[]): string {
  const useful = segments.filter((segment) => isSubstantive(segment.text)).slice(0, 5)
  if (useful.length === 0) {
    return 'I could not find that in this meeting.'
  }
  return [
    'A language model is not available, so here are the closest transcript passages instead:',
    ...useful.map((segment) => `- [${formatClock(segment.startMs)}] ${segment.text.trim()}`)
  ].join('\n')
}

/* ------------------------------------------------------------------ */
/* Action item parsing                                                 */
/* ------------------------------------------------------------------ */

function coerceAssignee(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const clean = value.trim()
  if (clean.length === 0) return null
  if (clean.toLowerCase() === 'null' || clean.toLowerCase() === 'unknown') return null
  if (clean.length > 60) return null
  return clean
}

/**
 * Parses the model's action-item reply.
 *
 * Small models wrap JSON in prose or fences often enough that this has to be
 * forgiving: it tries strict JSON, then a fenced block, then a line-based
 * fallback before giving up.
 */
export function parseActionItems(raw: string): Array<{ text: string; assignee: string | null }> {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return []

  const tryParse = (candidate: string): Array<{ text: string; assignee: string | null }> | null => {
    try {
      const parsed: unknown = JSON.parse(candidate)
      if (!Array.isArray(parsed)) return null
      const items: Array<{ text: string; assignee: string | null }> = []
      for (const entry of parsed) {
        if (typeof entry === 'string') {
          const text = entry.trim()
          if (text.length > 0) items.push({ text, assignee: null })
          continue
        }
        if (entry && typeof entry === 'object') {
          const record = entry as Record<string, unknown>
          const text = typeof record.text === 'string' ? record.text.trim() : ''
          if (text.length === 0) continue
          items.push({ text, assignee: coerceAssignee(record.assignee ?? record.owner) })
        }
      }
      return items
    } catch {
      return null
    }
  }

  const direct = tryParse(trimmed)
  if (direct) return direct

  // Fenced code block.
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)
  if (fenced) {
    const parsed = tryParse(fenced[1].trim())
    if (parsed) return parsed
  }

  // First bracketed array in the text.
  const start = trimmed.indexOf('[')
  const end = trimmed.lastIndexOf(']')
  if (start >= 0 && end > start) {
    const parsed = tryParse(trimmed.slice(start, end + 1))
    if (parsed) return parsed
  }

  // Line-based fallback: "- do the thing (Alex)".
  const lines = trimmed
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter((line) => line.length > 0 && !/^[[\]{}]/.test(line) && !/^json$/i.test(line))

  const items = lines.map((line) => {
    const match = /^(.*?)\s*[\(\[]([^)\]]{1,60})[)\]]\s*$/.exec(line)
    if (match && match[1].trim().length > 0) {
      return { text: match[1].trim(), assignee: coerceAssignee(match[2]) }
    }
    return { text: line, assignee: null }
  })

  // Drop obvious non-items rather than showing the user garbage.
  return items.filter((item) => item.text.length >= 8 && !/^\{|^\}$/.test(item.text))
}

/* ------------------------------------------------------------------ */
/* Summary orchestration                                               */
/* ------------------------------------------------------------------ */

/** Roughly how much transcript to feed the model per map step. */
const MAP_CHUNK_CHARS = 6000
/** Below this size, skip the map phase and summarise in one shot. */
const SINGLE_PASS_CHARS = 7000

export interface SummarizeInput {
  segments: TranscriptSegment[]
  title: string
  /** Pre-meeting notes, used as extra context for the final summary. */
  briefNotes?: string | null
}

export async function summarizeMeeting(
  options: SummarizerOptions,
  input: SummarizeInput
): Promise<MeetingSummaryResult> {
  const { segments, title } = input
  const usable = segments.filter((segment) => segment.text.trim().length > 0)

  if (usable.length === 0) {
    return {
      summary: 'No speech was transcribed for this meeting.',
      actionItems: [],
      degraded: true
    }
  }

  if (!options.model) {
    return {
      summary: extractiveSummary(usable),
      actionItems: [],
      degraded: true
    }
  }

  const fullText = formatTranscript(usable)
  const report = (progress: number, label: string): void => options.onProgress?.({ progress, label })

  try {
    let summary: string

    if (fullText.length <= SINGLE_PASS_CHARS) {
      report(0.15, 'Summarising transcript…')
      const single = await options.client.generate({
        model: options.model,
        system: SYSTEM_NOTETAKER,
        prompt: reduceSummaryPrompt([fullText], title, input.briefNotes ?? ''),
        temperature: 0.2,
        numCtx: 8192
      })
      summary = single
      report(0.7, 'Summary ready')
    } else {
      // Map phase.
      const chunks = chunkTranscript(usable, MAP_CHUNK_CHARS)
      const partials: string[] = []
      for (let index = 0; index < chunks.length; index++) {
        report(
          0.1 + (index / chunks.length) * 0.65,
          `Summarising part ${index + 1} of ${chunks.length}…`
        )
        const partial = await options.client.generate({
          model: options.model,
          system: SYSTEM_NOTETAKER,
          prompt: chunkSummaryPrompt(chunks[index], `${index + 1} of ${chunks.length}`),
          temperature: 0.2,
          numCtx: 8192
        })
        if (partial.length > 0) partials.push(partial)
      }

      if (partials.length === 0) {
        return { summary: extractiveSummary(usable), actionItems: [], degraded: true }
      }

      // Reduce phase.
      report(0.8, 'Merging part summaries…')
      summary = await options.client.generate({
        model: options.model,
        system: SYSTEM_NOTETAKER,
        prompt: reduceSummaryPrompt(partials, title, input.briefNotes ?? ''),
        temperature: 0.2,
        numCtx: 8192
      })
    }

    // Action items are a separate call so a failure there cannot lose the summary.
    report(0.9, 'Extracting action items…')
    const actionItems = await extractActionItems(options, usable, fullText)

    report(1, 'Done')
    return { summary: summary.trim(), actionItems, degraded: false }
  } catch (error) {
    log.warn('LLM summarisation failed; falling back to extractive summary', error)
    return {
      summary: extractiveSummary(usable),
      actionItems: [],
      degraded: true
    }
  }
}

async function extractActionItems(
  options: SummarizerOptions,
  segments: TranscriptSegment[],
  fullText: string
): Promise<Array<{ text: string; assignee: string | null }>> {
  if (!options.model) return []

  const speakers = [...new Set(segments.map((s) => s.speakerLabel).filter((s): s is string => Boolean(s)))]

  // Keep the action-item prompt inside a small model's context window.
  const transcript = fullText.length > 12_000 ? fullText.slice(-12_000) : fullText

  try {
    const raw = await options.client.generate({
      model: options.model,
      system: SYSTEM_NOTETAKER,
      prompt: actionItemsPrompt(transcript, speakers),
      temperature: 0.1,
      json: false,
      numCtx: 8192
    })

    let items = parseActionItems(raw)
    if (items.length === 0 && raw.trim().length > 0 && !/\[\s*\]/.test(raw)) {
      // One repair attempt for malformed output.
      const repaired = await options.client.generate({
        model: options.model,
        prompt: repairActionItemsPrompt(raw),
        temperature: 0,
        json: true
      })
      items = parseActionItems(repaired)
    }

    // De-duplicate while preserving order.
    const seen = new Set<string>()
    return items.filter((item) => {
      const key = item.text.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  } catch (error) {
    log.warn('action item extraction failed', error)
    return []
  }
}

/* ------------------------------------------------------------------ */
/* "What did I miss?"                                                  */
/* ------------------------------------------------------------------ */

export async function whatDidIMiss(
  options: SummarizerOptions,
  segments: TranscriptSegment[],
  minutes: number
): Promise<string> {
  if (segments.length === 0) {
    return 'Nothing has been transcribed yet.'
  }

  const latest = segments[segments.length - 1].endMs
  const windowStart = latest - minutes * 60_000
  const window = segments.filter((segment) => segment.endMs >= windowStart)

  if (window.length === 0) {
    return `Nothing was transcribed in the last ${minutes} minutes.`
  }

  if (!options.model) {
    return [
      `Ollama is not running, so here are the last ${minutes} minutes verbatim:`,
      ...window.slice(-12).map((segment) => `- ${segment.text.trim()}`)
    ].join('\n')
  }

  try {
    const text = formatTranscript(window, false)
    const answer = await options.client.generate({
      model: options.model,
      system: SYSTEM_NOTETAKER,
      prompt: missedPrompt(text.slice(-8000), minutes),
      temperature: 0.3,
      numCtx: 8192
    })
    return answer.trim() || 'Nothing notable was discussed in that window.'
  } catch (error) {
    log.warn('what-did-i-miss failed', error)
    return (
      'Could not reach the local language model.\n\n' +
      window
        .slice(-8)
        .map((segment) => `- ${segment.text.trim()}`)
        .join('\n')
    )
  }
}

/* ------------------------------------------------------------------ */
/* Q&A over one meeting                                                */
/* ------------------------------------------------------------------ */

export async function answerAboutMeeting(
  options: SummarizerOptions,
  segments: TranscriptSegment[],
  question: string
): Promise<string> {
  if (segments.length === 0) return 'This meeting has no transcript yet.'

  if (!options.model) {
    return extractiveAnswer(segments.slice(-40))
  }

  // A single meeting normally fits; if not, keep the head and tail, which is
  // where decisions and wrap-ups usually sit.
  const full = formatTranscript(segments)
  const context = full.length <= 14_000 ? full : `${full.slice(0, 7000)}\n…\n${full.slice(-7000)}`

  try {
    const answer = await options.client.generate({
      model: options.model,
      system: SYSTEM_NOTETAKER,
      prompt: meetingQuestionPrompt(context, question),
      temperature: 0.2,
      numCtx: 8192
    })
    return answer.trim() || 'I could not find that in this meeting.'
  } catch (error) {
    log.warn('meeting Q&A failed', error)
    return extractiveAnswer(segments)
  }
}

/* ------------------------------------------------------------------ */
/* Q&A across meetings (local RAG)                                     */
/* ------------------------------------------------------------------ */

export interface RetrievedChunk {
  meetingId: string
  /** Meeting title, matching the shape returned by the search layer. */
  title: string
  /** Meeting start time, used to label the excerpt's origin. */
  startedAt: number
  segmentId: string
  startMs: number
  text: string
  score: number
}

export async function answerAcrossMeetings(
  options: SummarizerOptions,
  question: string,
  chunks: RetrievedChunk[]
): Promise<{ answer: string; degraded: boolean }> {
  if (chunks.length === 0) {
    return { answer: 'I could not find that in your meetings.', degraded: false }
  }

  if (!options.model) {
    return {
      answer: [
        'A language model is not running, so here are the most relevant passages:',
        ...chunks
          .slice(0, 6)
          .map(
            (chunk) =>
              `- ${chunk.title} (${new Date(chunk.startedAt).toLocaleDateString()}) ` +
              `[${formatClock(chunk.startMs)}]: ${chunk.text.trim()}`
          )
      ].join('\n'),
      degraded: true
    }
  }

  const context = chunks
    .slice(0, 14)
    .map(
      (chunk) =>
        `--- ${chunk.title} — ${new Date(chunk.startedAt).toLocaleDateString()} ` +
        `[${formatClock(chunk.startMs)}] ---\n${chunk.text}`
    )
    .join('\n')

  try {
    const answer = await options.client.generate({
      model: options.model,
      system: SYSTEM_NOTETAKER,
      prompt: crossMeetingQuestionPrompt(context.slice(0, 14_000), question),
      temperature: 0.2,
      numCtx: 8192
    })
    return { answer: answer.trim() || 'I could not find that in your meetings.', degraded: false }
  } catch (error) {
    log.warn('cross-meeting Q&A failed', error)
    return {
      answer: chunks
        .slice(0, 6)
        .map((chunk) => `- ${chunk.title}: ${chunk.text.trim()}`)
        .join('\n'),
      degraded: true
    }
  }
}

/* ------------------------------------------------------------------ */
/* Pre-meeting brief                                                   */
/* ------------------------------------------------------------------ */

export async function generateBrief(
  options: SummarizerOptions,
  input: { title: string; notes: string; documentText: string; calendar: string }
): Promise<string> {
  const hasMaterial =
    input.notes.trim().length > 0 || input.documentText.trim().length > 0 || input.calendar.trim().length > 0

  if (!hasMaterial) {
    return 'Add an agenda, a calendar invite, or a reference document and Local Note will draft a brief here.'
  }

  if (!options.model) {
    // Still useful without an LLM: echo the structure back to the user.
    return [
      'WHAT THIS IS: (a language model is needed to draft this)',
      '',
      input.calendar ? `CALENDAR: ${input.calendar}` : '',
      input.notes ? `YOUR NOTES:\n${input.notes}` : '',
      input.documentText ? `ATTACHED DOCUMENTS:\n${input.documentText.slice(0, 1200)}` : ''
    ]
      .filter((line) => line.length > 0)
      .join('\n')
  }

  try {
    const brief = await options.client.generate({
      model: options.model,
      system: SYSTEM_NOTETAKER,
      prompt: briefPrompt({
        title: input.title,
        notes: input.notes.slice(0, 4000),
        documents: input.documentText.slice(0, 6000),
        calendar: input.calendar.slice(0, 1000)
      }),
      temperature: 0.3,
      numCtx: 8192
    })
    return brief.trim()
  } catch (error) {
    log.warn('brief generation failed', error)
    return 'Could not reach the local language model to draft a brief.'
  }
}
