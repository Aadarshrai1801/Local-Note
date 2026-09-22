import { EventEmitter } from 'node:events'
import { createLogger } from '../lib/log'
import type { TranscriptSegment, SourceKind, StreamKind } from '../../shared/types'
import { buildSttPrompt, correctText, levenshtein, listDictionary, recordCorrectionHits, type CorrectionResult } from '../db/dictionary'
import { insertSegments, type InsertSegmentInput } from '../db/meetings'
import { getSettings } from '../db/settings'
import type { Sidecar, TranscribeResult } from './sidecar'

const log = createLogger('pipeline')

/**
 * Live transcription pipeline.
 *
 * Audio arrives as finished ~5 second WAV chunks (one per capture stream). Each
 * chunk becomes one transcription job; jobs run strictly one at a time because
 * a single Whisper model instance cannot serve concurrent requests, and running
 * them in parallel would only thrash the CPU.
 *
 * Because the microphone and system-audio streams are captured separately, the
 * app already knows who was speaking before any diarization runs: microphone
 * audio is "You", system audio is the other party. That is a much cheaper and
 * more reliable signal than clustering, and it is the main reason the two
 * streams are kept apart rather than mixed.
 */

export interface ChunkJob {
  stream: StreamKind
  index: number
  path: string
  startMs: number
  rms: number
}

export interface PipelineStats {
  queueDepth: number
  backlogSeconds: number
  transcribed: number
  skipped: number
  failed: number
}

/**
 * Whisper is known to hallucinate plausible-looking text on silence — a chunk
 * of padded quiet can come back as "thanks for watching" or an invented
 * sentence. The model reports its own no-speech probability, so segments that
 * are very likely silence are dropped rather than shown as if they were said.
 */
const NO_SPEECH_REJECT = 0.6

/**
 * Cross-stream echo suppression.
 *
 * When the microphone can hear the speakers (no headphones, or a mic that
 * monitors the output device), every remote utterance is captured twice: once
 * digitally from the system stream and once acoustically from the microphone.
 * Left alone that doubles the transcript and mis-attributes the remote
 * participants' words to "You".
 *
 * Timing is the reliable signal, not text. Bleed arrives essentially
 * simultaneously on both streams, because the microphone hears the speakers
 * with only an acoustic delay, whereas two people speaking take turns. Text
 * similarity alone cannot separate the cases: measured on real output, the same
 * utterance decoded from a degraded microphone stream scored 0.50, while two
 * genuinely different statements ("...option A" versus "...option B") scored
 * 0.98. The distributions overlap, so the window is kept tight and the
 * similarity bar high, which catches bleed without eating real speech.
 *
 * This is a mitigation, not a solution. Headphones remove the problem entirely,
 * which is why the user is told about it when it is detected.
 */
const ECHO_WINDOW_MS = 2500
const ECHO_SIMILARITY = 0.85
/** Below this length, short words like "yes" or "okay" are too ambiguous. */
const ECHO_MIN_LENGTH = 20

/**
 * Rejects segments that carry no meaning.
 *
 * Whisper occasionally emits punctuation-only or heavily repeated output on
 * marginal audio, for example ". . . . . . . . . .", which is noise rather than
 * speech and should never reach the transcript.
 */
function isMeaninglessText(text: string): boolean {
  if (!/[\p{L}\p{N}]/u.test(text)) return true

  const tokens = text.toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length >= 6) {
    const unique = new Set(tokens).size
    if (unique / tokens.length < 0.25) return true
  }
  return false
}

/** Normalises text for comparison: case, punctuation and spacing removed. */
function normaliseForCompare(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Similarity of two normalised strings, 0..1.
 *
 * Uses a cheap containment check before falling back to edit distance, because
 * one stream often captures a slightly longer span than the other.
 */
function textSimilarity(a: string, b: string): number {
  if (a === b) return 1
  const longest = Math.max(a.length, b.length)
  if (longest === 0) return 1

  if (a.length > ECHO_MIN_LENGTH && b.length > ECHO_MIN_LENGTH && (a.includes(b) || b.includes(a))) {
    return Math.min(a.length, b.length) / longest
  }
  return 1 - levenshtein(a, b) / longest
}

export class TranscriptionPipeline extends EventEmitter {
  private queue: ChunkJob[] = []
  private running = false
  private disposed = false

  private transcribed = 0
  private skipped = 0
  private failed = 0

  /** Text of the last segment per stream, used for duplicate suppression. */
  private lastText = new Map<StreamKind, string>()

  /**
   * Recently kept segments per stream, used to detect microphone bleed from the
   * speakers. Bounded because only a few seconds of history is ever consulted.
   */
  private recentSegments: Record<StreamKind, Array<{ text: string; startMs: number }>> = {
    system: [],
    mic: []
  }

  /** Count of segments dropped as speaker bleed, reported to the user once. */
  private echoDrops = 0

  /** Speaker label applied to each stream. */
  private labels: Record<StreamKind, string> = { system: 'Speaker 1', mic: 'You' }

  private dictionaryPrompt = ''

  constructor(
    private readonly sidecar: Sidecar,
    private readonly meetingId: string,
    private readonly model: string,
    /** Extra context for the STT prompt: meeting title, agenda, attendee names. */
    private contextHint: string
  ) {
    super()
    this.refreshDictionary()
  }

  /** Rebuilds the STT biasing prompt (dictionary + meeting context). */
  refreshDictionary(): void {
    this.dictionaryPrompt = buildSttPrompt(this.contextHint)
    log.debug(`STT prompt refreshed (${this.dictionaryPrompt.length} chars)`)
  }

  setSpeakerLabel(stream: StreamKind, label: string): void {
    this.labels[stream] = label
  }

  /**
   * Updates the meeting context used to bias transcription (agenda, attendee
   * names) and rebuilds the prompt. Called when the user edits the brief or the
   * dictionary mid-recording, so the change applies to the current meeting.
   */
  setContextHint(contextHint: string): void {
    this.contextHint = contextHint
    this.refreshDictionary()
  }

  enqueue(job: ChunkJob): void {
    if (this.disposed) return
    this.queue.push(job)
    // Keep the queue shallow during a long meeting: a huge backlog means the
    // user is watching text that is many minutes stale, which is worse than
    // skipping quiet audio.
    if (this.queue.length > 200) {
      const dropped = this.queue.splice(0, this.queue.length - 200)
      this.skipped += dropped.length
      log.warn(`dropped ${dropped.length} chunks to bound the transcription backlog`)
    }
    this.emit('stats', this.stats())
    void this.drain()
  }

  stats(): PipelineStats {
    const backlogMs = this.queue.reduce((total, job) => total + 5000, 0)
    return {
      queueDepth: this.queue.length,
      backlogSeconds: Math.round(backlogMs / 1000),
      transcribed: this.transcribed,
      skipped: this.skipped,
      failed: this.failed
    }
  }

  private async drain(): Promise<void> {
    if (this.running || this.disposed) return
    this.running = true

    try {
      while (this.queue.length > 0 && !this.disposed) {
        const job = this.queue.shift()!
        try {
          await this.process(job)
        } catch (error) {
          this.failed++
          log.warn(`chunk ${job.stream}#${job.index} failed`, error)
          this.emit('error', error)
        }
        this.emit('stats', this.stats())
      }
    } finally {
      this.running = false
    }
  }

  private async process(job: ChunkJob): Promise<void> {
    const settings = getSettings()

    // Silence gate: skipping quiet chunks is the single biggest CPU saving, and
    // Whisper has nothing useful to say about them anyway.
    if (job.rms < settings.silenceThreshold) {
      this.skipped++
      return
    }

    // Give the model continuity with the previous chunk from the same stream,
    // which noticeably reduces mid-sentence breaks at chunk boundaries.
    const previous = this.lastText.get(job.stream) ?? ''
    const prompt = [this.dictionaryPrompt, previous.slice(-200)].filter((part) => part.length > 0).join(' ')

    const started = Date.now()
    const result = await this.sidecar.transcribe({
      path: job.path,
      model: this.model,
      initialPrompt: prompt.slice(0, 800),
      vad: true
    })

    if (this.disposed) return

    const inputs = this.toInsertInputs(result, job)
    if (inputs.length > 0) {
      const created = insertSegments(inputs)
      this.transcribed += created.length

      const last = created[created.length - 1]
      if (last) this.lastText.set(job.stream, last.text)

      for (const segment of created) {
        this.emit('segment', segment)
      }
    }

    log.debug(
      `chunk ${job.stream}#${job.index}: ${result.segments.length} segments in ${Date.now() - started}ms`
    )
  }

  /**
   * Converts sidecar output into database rows, shifting the chunk-relative
   * timestamps onto the meeting timeline.
   */
  private toInsertInputs(result: TranscribeResult, job: ChunkJob): InsertSegmentInput[] {
    const settings = getSettings()
    const dictionary = settings.dictionaryEnabled ? listDictionary() : []
    const source: SourceKind = job.stream
    const inputs: InsertSegmentInput[] = []

    // Whisper timestamps are relative to the chunk, which starts at job.startMs.
    // The padded silence the recorder inserts keeps this mapping accurate.
    const offsetMs = job.startMs

    for (const segment of result.segments) {
      const text = segment.text.trim()
      if (text.length === 0) continue

      // Discard likely hallucinated text on silence.
      if (segment.noSpeechProb > NO_SPEECH_REJECT) {
        this.skipped++
        log.debug(
          `dropped likely hallucination (noSpeechProb=${segment.noSpeechProb.toFixed(2)}): "${text.slice(0, 60)}"`
        )
        continue
      }

      // Discard output that carries no meaning, such as runs of punctuation.
      if (isMeaninglessText(text)) {
        this.skipped++
        log.debug(`dropped meaningless segment: "${text.slice(0, 60)}"`)
        continue
      }

      // Whisper repeats itself at chunk edges; drop an exact repeat from the
      // same stream so the transcript does not stutter.
      const previous = this.lastText.get(job.stream)
      if (previous && previous.toLowerCase() === text.toLowerCase()) continue

      let finalText = text
      let corrected = false
      let correction: CorrectionResult | null = null

      if (dictionary.length > 0) {
        correction = correctText(text, dictionary)
        if (correction.changes.length > 0) {
          finalText = correction.text
          corrected = true
        }
      }

      const startMs = offsetMs + segment.start * 1000
      const endMs = offsetMs + Math.max(segment.end, segment.start + 0.2) * 1000

      // Drop microphone bleed: the same words arriving on the other stream
      // within a few seconds means the mic is hearing the speakers.
      const other: StreamKind = job.stream === 'system' ? 'mic' : 'system'
      const normalised = normaliseForCompare(finalText)
      if (normalised.length >= ECHO_MIN_LENGTH) {
        const isEcho = this.recentSegments[other].some(
          (previous) =>
            Math.abs(previous.startMs - startMs) <= ECHO_WINDOW_MS &&
            textSimilarity(normalised, previous.text) >= ECHO_SIMILARITY
        )
        if (isEcho) {
          this.echoDrops++
          log.debug(`dropped speaker bleed from ${job.stream}: "${finalText.slice(0, 60)}"`)
          // Only report this once; repeating it every few seconds would be noise.
          if (this.echoDrops === 1) this.emit('echo-detected')
          continue
        }
      }

      inputs.push({
        meetingId: this.meetingId,
        speakerLabel: this.labels[job.stream],
        source,
        startMs,
        endMs,
        text: finalText,
        confidence: segment.confidence,
        corrected
      })

      this.remember(job.stream, normalised, startMs)

      if (correction && correction.changes.length > 0) {
        recordCorrectionHits(correction.changes)
      }
    }

    return inputs
  }

  /** Keeps a short rolling window of recent text for echo detection. */
  private remember(stream: StreamKind, normalisedText: string, startMs: number): void {
    const buffer = this.recentSegments[stream]
    buffer.push({ text: normalisedText, startMs })
    if (buffer.length > 12) buffer.splice(0, buffer.length - 12)
  }

  dispose(): void {
    this.disposed = true
    this.queue = []
  }
}
