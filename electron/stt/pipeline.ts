import { EventEmitter } from 'node:events'
import { createLogger } from '../lib/log'
import type { TranscriptSegment, SourceKind, StreamKind } from '../../shared/types'
import { buildSttPrompt, correctText, listDictionary, recordCorrectionHits, type CorrectionResult } from '../db/dictionary'
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

export class TranscriptionPipeline extends EventEmitter {
  private queue: ChunkJob[] = []
  private running = false
  private disposed = false

  private transcribed = 0
  private skipped = 0
  private failed = 0

  /** Text of the last segment per stream, used for duplicate suppression. */
  private lastText = new Map<StreamKind, string>()

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

      inputs.push({
        meetingId: this.meetingId,
        speakerLabel: this.labels[job.stream],
        source,
        startMs: offsetMs + segment.start * 1000,
        endMs: offsetMs + Math.max(segment.end, segment.start + 0.2) * 1000,
        text: finalText,
        confidence: segment.confidence,
        corrected
      })

      if (correction && correction.changes.length > 0) {
        recordCorrectionHits(correction.changes)
      }
    }

    return inputs
  }

  dispose(): void {
    this.disposed = true
    this.queue = []
  }
}
