import { EventEmitter } from 'node:events'
import { existsSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createLogger } from '../lib/log'
import { getPaths } from '../lib/paths'
import { getSettings } from '../db/settings'
import {
  createMeeting,
  clearMeetingAudio,
  deleteMeeting,
  insertSegments,
  listActionItems,
  listSegments,
  meetingsWithAudioOlderThan,
  replaceActionItems,
  updateSegmentSpeakerByIds,
  updateMeetingFields,
  getMeeting,
  type InsertSegmentInput
} from '../db/meetings'
import { indexMissingEmbeddings, resolveEmbedder } from '../llm/embed'
import { OllamaClient } from '../llm/ollama'
import { summarizeMeeting, whatDidIMiss as summarizeMissedWindow } from '../llm/summarize'
import { Recorder } from './recorder'
import { ensureRecorderBuilt } from './recorder-build'
import { TranscriptionPipeline } from '../stt/pipeline'
import type { Sidecar } from '../stt/sidecar'
import type {
  AppSettings,
  LiveSegment,
  SessionState,
  SourceKind,
  StartRecordingOptions,
  StreamKind,
  StreamLevel
} from '../../shared/types'

const log = createLogger('session')

/** How long a stream may deliver nothing before we warn the user. */
const DEAD_STREAM_MS = 10_000

interface LiveBuffers {
  /** Retained so "What did I miss?" does not need a database round trip. */
  segments: LiveSegment[]
}

export interface SessionDeps {
  sidecar: Sidecar
  ollama: OllamaClient
  /** Pushes an event to the renderer. */
  emit: (event: import('../../shared/types').MainEvent) => void
  /** Reported when models are missing so the UI can guide setup. */
  sttAvailable: () => Promise<boolean>
}

/**
 * Owns the lifetime of a recording: capture -> live transcription -> storage ->
 * post-processing (diarization, summary, search index).
 *
 * Only one session can be active at a time. Post-processing runs in the
 * background so a long summary never blocks the user from starting the next
 * meeting.
 */
export class SessionManager extends EventEmitter {
  private recorder: Recorder | null = null
  private pipeline: TranscriptionPipeline | null = null
  private meetingId: string | null = null
  private title = ''
  private startedAt: number | null = null
  private lastLevel: Record<StreamKind, StreamLevel | null> = { system: null, mic: null }
  private firstLevelAt: Record<StreamKind, number> = { system: 0, mic: 0 }
  private deviceNames: Record<StreamKind, string | null> = { system: null, mic: null }
  private warnings: string[] = []
  private live: LiveBuffers = { segments: [] }
  private keepAudio = true
  private ticker: NodeJS.Timeout | null = null
  private error: string | null = null
  private transcribing = false
  private elapsedOverrideMs: number | null = null
  /** Agenda/attendee context used to bias speech recognition. */
  private contextHint = ''

  constructor(private readonly deps: SessionDeps) {
    super()
  }

  /**
   * Updates the STT biasing context for the running session.
   *
   * Called when the user edits the pre-meeting brief while recording, so newly
   * typed attendee names and agenda terms start biasing the model immediately
   * instead of only from the next meeting onwards.
   */
  setPromptContext(_settings: AppSettings, briefNotes?: string): void {
    if (briefNotes !== undefined) {
      this.contextHint = briefNotes.trim()
      this.pipeline?.setContextHint(this.contextHint)
    } else {
      this.pipeline?.refreshDictionary()
    }
  }

  /** Refreshes the dictionary-derived part of the STT prompt. */
  refreshDictionaryPrompt(): void {
    this.pipeline?.refreshDictionary()
  }

  /* ---------------- state ---------------- */

  get isActive(): boolean {
    return this.meetingId !== null
  }

  get activeMeetingId(): string | null {
    return this.meetingId
  }

  getState(): SessionState {
    const stats = this.pipeline?.stats() ?? {
      queueDepth: 0,
      backlogSeconds: 0,
      transcribed: 0,
      skipped: 0,
      failed: 0
    }

    return {
      active: this.isActive,
      meetingId: this.meetingId,
      title: this.title,
      startedAt: this.startedAt,
      elapsedMs: this.elapsedOverrideMs ?? (this.startedAt ? Date.now() - this.startedAt : 0),
      levels: { system: this.lastLevel.system, mic: this.lastLevel.mic },
      error: this.error,
      warnings: [...this.warnings],
      queueDepth: stats.queueDepth,
      backlogSeconds: stats.backlogSeconds
    }
  }

  private pushState(): void {
    this.deps.emit({ type: 'session', state: this.getState() })
  }

  private pushWarning(message: string): void {
    if (this.warnings.includes(message)) return
    this.warnings.push(message)
    log.warn(`session warning: ${message}`)
    this.pushState()
  }

  /* ---------------- start ---------------- */

  async start(options: StartRecordingOptions = {}): Promise<{ meetingId: string }> {
    if (this.isActive) throw new Error('A recording is already running.')
    const settings = getSettings()

    // Make sure the native capture helper exists before we create any state.
    const build = await ensureRecorderBuilt()
    if (!build.ok) {
      throw new Error(
        `Audio capture is unavailable. ${build.message}\n\n` +
          'Local Note needs the C# compiler that ships with Windows to build its audio helper.'
      )
    }

    const targetSystem = options.targets?.system ?? true
    const targetMic = options.targets?.mic ?? settings.captureMic
    if (!targetSystem && !targetMic) {
      throw new Error('At least one audio source must be enabled.')
    }

    const startedAt = Date.now()
    // Name it after the brief's title if one was supplied, else a time stamp.
    const title =
      options.title?.trim() ||
      `Meeting — ${new Date(startedAt).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
      })}`

    const meeting = createMeeting({
      title,
      startedAt,
      briefNotes: options.briefNotes ?? null,
      briefDocs: options.briefDocs ?? []
    })

    this.meetingId = meeting.id
    this.title = title
    this.startedAt = startedAt
    this.warnings = []
    this.error = null
    this.lastLevel = { system: null, mic: null }
    this.firstLevelAt = { system: 0, mic: 0 }
    this.live = { segments: [] }
    this.keepAudio = options.keepAudio ?? settings.keepAudio
    this.elapsedOverrideMs = null

    this.pushState()

    const requestedModel = options.model ?? settings.whisperModel

    // Agenda/attendee names bias recognition, so seed the prompt context now.
    this.contextHint = (options.briefNotes ?? '').trim()

    // Transcription is optional: capture still works without it.
    try {
      const available = await this.deps.sttAvailable()
      if (available) {
        // The configured model may not be the one that is actually installed.
        // Falling back is much friendlier than failing to transcribe at all,
        // as long as the substitution is stated plainly.
        const resolution = await this.resolveModel(requestedModel)
        if (resolution.warning) this.pushWarning(resolution.warning)

        this.pipeline = new TranscriptionPipeline(
          this.deps.sidecar,
          meeting.id,
          resolution.model ?? requestedModel,
          [title, this.contextHint].filter((part) => part.trim().length > 0).join('. ')
        )
        this.pipeline.on('segment', (segment: LiveSegment) => {
          this.live.segments.push(segment)
          // Bound memory on very long meetings.
          if (this.live.segments.length > 6000) this.live.segments.splice(0, 1000)
          this.deps.emit({ type: 'segment', segment })
        })
        this.pipeline.on('stats', () => this.pushState())
        this.pipeline.on('error', (error: unknown) => {
          this.pushWarning(
            `Transcription had a problem: ${error instanceof Error ? error.message : String(error)}`
          )
        })
        this.pipeline.on('echo-detected', () => {
          this.pushWarning(
            'Your microphone is picking up your speakers, so the other participants were being ' +
              'transcribed twice. The duplicate copy has been discarded automatically. ' +
              'Wearing headphones will give cleaner transcripts and correct speaker labels.'
          )
        })
      } else {
        this.pushWarning(
          'Recording audio, but transcription is unavailable because no local speech model is ' +
            'installed. The audio is being saved so you can transcribe it later.'
        )
      }
    } catch (error) {
      log.warn('could not start transcription pipeline', error)
      this.pushWarning(
        'Recording audio, but the transcription engine could not be started. The audio is being saved.'
      )
    }

    // Start capture.
    const recorder = new Recorder()
    this.recorder = recorder

    recorder.on('ready', (info) => {
      for (const stream of info.streams) {
        const kind = stream.name as StreamKind
        this.deviceNames[kind] = stream.device ?? null
        this.firstLevelAt[kind] = Date.now()
      }
      log.info('recorder ready', info.streams)
      this.pushState()
    })

    recorder.on('chunk', (chunk) => {
      this.pipeline?.enqueue({
        stream: chunk.stream,
        index: chunk.index,
        path: chunk.path,
        startMs: chunk.startMs,
        rms: chunk.rms
      })
    })

    recorder.on('level', (level) => {
      const kind = level.stream as StreamKind
      const dead =
        level.packets === 0 &&
        level.ms > DEAD_STREAM_MS &&
        (this.firstLevelAt[kind] === 0 || Date.now() - this.firstLevelAt[kind] > DEAD_STREAM_MS)

      this.lastLevel[kind] = {
        stream: kind,
        ms: level.ms,
        capturedMs: level.capturedMs,
        realMs: level.realMs,
        paddedMs: level.paddedMs,
        packets: level.packets,
        rms: level.rms,
        dead,
        deviceName: this.deviceNames[kind]
      }

      // The captured audio length is the honest measure of elapsed time; the
      // recorder pads silence so this stays in step with the wall clock.
      if (kind === 'system' || this.lastLevel.system === null) {
        this.elapsedOverrideMs = level.capturedMs
      }

      if (dead) this.reportDeadStream(kind)
      this.pushState()
    })

    recorder.on('warning', (warning) => this.pushWarning(warning.message))

    recorder.on('error-event', (event) => {
      this.error = event.message
      this.pushState()
    })

    try {
      await recorder.start({
        sessionId: meeting.id,
        outDir: getPaths().audioDir,
        captureMic: targetMic,
        systemDeviceId: targetSystem ? settings.systemDeviceId : null,
        micDeviceId: targetMic ? settings.micDeviceId : null,
        chunkMs: 5000
      })
    } catch (error) {
      // Roll back the half-created meeting so the list is not polluted.
      this.recorder = null
      this.pipeline?.dispose()
      this.pipeline = null
      const message = error instanceof Error ? error.message : String(error)
      deleteMeeting(meeting.id)
      this.meetingId = null
      this.startedAt = null
      this.error = message
      this.pushState()
      throw new Error(`Could not start audio capture: ${message}`)
    }

    // Drive the on-screen timer even when no audio is flowing.
    this.ticker = setInterval(() => this.pushState(), 1000)
    this.pushState()

    return { meetingId: meeting.id }
  }

  /**
   * Picks the model to actually transcribe with.
   *
   * If the configured model is not installed, the largest installed model is
   * used instead and the substitution is reported, because silently
   * transcribing with a different model (or worse, failing outright) would be
   * confusing. The user is told how to get the model they asked for.
   */
  private async resolveModel(
    requested: string
  ): Promise<{ model: string | null; warning: string | null }> {
    try {
      const status = await this.deps.sidecar.status()
      const present = status.models_present
      if (present.length === 0) return { model: null, warning: null }
      if (present.includes(requested)) return { model: requested, warning: null }

      // Prefer the largest installed model: the user downloaded it on purpose,
      // and larger generally means more accurate.
      const sizeOf = (id: string): number => status.whisper_models[id]?.size ?? 0
      const chosen = [...present].sort((a, b) => sizeOf(b) - sizeOf(a))[0]

      return {
        model: chosen,
        warning:
          `"${requested}" is not downloaded, so "${chosen}" is being used instead. ` +
          `Download "${requested}" from Settings > Models to use it.`
      }
    } catch {
      // If the check itself fails, let the pipeline try the requested model.
      return { model: requested, warning: null }
    }
  }

  private reportDeadStream(kind: StreamKind): void {
    if (kind === 'mic') {
      this.pushWarning(
        'The microphone is capturing no audio at all. Check that the right input device is ' +
          'selected in Windows, that it is not muted, and that Local Note has microphone permission. ' +
          "You can keep recording — only the other participants are being captured right now."
      )
      return
    }

    // The system stream being silent is the single most damaging failure for
    // accuracy: the app then transcribes whatever the microphone overheard,
    // which is far worse audio. Diagnose the likely cause rather than printing
    // a generic hint.
    const device = this.deviceNames.system ?? ''
    const isBluetooth = /bluetooth|hands-free|headset|airpods|buds|wh-|wf-|beats|jabra|bose/i.test(device)

    if (isBluetooth) {
      this.pushWarning(
        `No system audio was captured, and the output device is "${device}", which is a Bluetooth ` +
          'headset. Windows loopback capture is unreliable on Bluetooth audio — it commonly ' +
          'returns silence. Switch the Windows default output to your built-in speakers or wired ' +
          'headphones and record again for a fully accurate transcript.'
      )
      return
    }

    this.pushWarning(
      'No system audio has been detected yet, so only your microphone is being transcribed. ' +
        'That is much less accurate than the digital capture. Check that the app or call playing ' +
        `the audio is using the Windows default output device${device ? ` (currently "${device}")` : ''}.`
    )
  }

  /* ---------------- stop ---------------- */

  async stop(): Promise<{ meetingId: string }> {
    const meetingId = this.meetingId
    if (!meetingId || !this.recorder) {
      throw new Error('No recording is in progress.')
    }

    log.info(`stopping recording for ${meetingId}`)

    if (this.ticker) {
      clearInterval(this.ticker)
      this.ticker = null
    }

    const endedAt = Date.now()
    const durationMs = this.startedAt ? endedAt - this.startedAt : null

    // Let the helper flush its final WAV chunk and patch headers.
    await this.recorder.stop()

    // Finish transcribing whatever is still queued so the transcript is complete.
    if (this.pipeline) {
      this.transcribing = true
      this.pushState()
      await this.waitForPipeline()
      this.transcribing = false
      this.pipeline.dispose()
    }

    const audioDir = join(getPaths().audioDir, meetingId)
    const hasSegments = listSegments(meetingId).length > 0

    // Data-safety guard: never delete audio that produced no transcript, or the
    // recording would be lost entirely.
    const shouldKeepAudio = this.keepAudio || !hasSegments

    updateMeetingFields(meetingId, {
      endedAt,
      durationMs,
      audioPath: existsSync(audioDir) ? audioDir : null,
      summaryStatus: 'pending'
    })

    const finalState: SessionState = {
      ...this.getState(),
      active: false,
      elapsedMs: this.elapsedOverrideMs ?? (durationMs ?? 0)
    }
    this.deps.emit({ type: 'session', state: finalState })

    // Reset live session fields; the meeting now lives in the archive.
    const finishedMeetingId = meetingId
    this.meetingId = null
    this.recorder = null
    this.pipeline = null
    this.startedAt = null
    this.live = { segments: [] }
    this.error = null
    this.warnings = []

    // Everything below is background work; the user can start a new meeting now.
    void this.runPostProcessing(finishedMeetingId, audioDir, shouldKeepAudio)

    return { meetingId: finishedMeetingId }
  }

  /** Waits for the transcription queue to empty, with a bounded wait. */
  private async waitForPipeline(timeoutMs = 300_000): Promise<void> {
    if (!this.pipeline) return
    const deadline = Date.now() + timeoutMs

    for (;;) {
      const stats = this.pipeline.stats()
      if (stats.queueDepth === 0) return
      if (Date.now() > deadline) {
        log.warn(`transcription backlog did not clear within ${timeoutMs}ms; continuing`)
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }

  /* ---------------- post-processing ---------------- */

  private async runPostProcessing(
    meetingId: string,
    audioDir: string,
    keepAudio: boolean
  ): Promise<void> {
    const settings = getSettings()
    const meeting = getMeeting(meetingId)
    if (!meeting) return

    try {
      // 1. Diarization: refine "Speaker 1" into distinct speakers when a local
      //    diarization engine is installed. Best effort only.
      const systemAudio = join(audioDir, 'system', 'full.wav')
      if (existsSync(systemAudio)) {
        await this.tryDiarize(meetingId, systemAudio)
      }

      // 2. Summary + action items from the local LLM.
      const segments = listSegments(meetingId)
      if (segments.length > 0) {
        const status = await this.resolveSummaryModel()
        if (status) {
          this.deps.emit({
            type: 'busy',
            label: 'Generating meeting summary…',
            progress: 0
          })

          const result = await summarizeMeeting(
            {
              client: this.deps.ollama,
              model: status,
              onProgress: (update) =>
                this.deps.emit({ type: 'busy', label: update.label, progress: update.progress })
            },
            { segments, title: meeting.title, briefNotes: meeting.briefNotes }
          )

          updateMeetingFields(meetingId, {
            summary: result.summary,
            summarizedAt: Date.now(),
            summaryStatus: result.degraded ? 'skipped' : 'ok',
            summaryError: result.degraded ? 'Generated without a language model.' : null
          })

          if (result.actionItems.length > 0) {
            replaceActionItems(meetingId, result.actionItems)
            this.deps.emit({ type: 'action-items', meetingId })
          }

          this.deps.emit({
            type: 'summary',
            meetingId,
            status: result.degraded ? 'skipped' : 'ok',
            summary: result.summary
          })
          this.deps.emit({ type: 'busy', label: null, progress: null })
        } else {
          const fallback = await summarizeMeeting(
            { client: this.deps.ollama, model: null },
            { segments, title: meeting.title }
          )
          updateMeetingFields(meetingId, {
            summary: fallback.summary,
            summarizedAt: Date.now(),
            summaryStatus: 'skipped',
            summaryError: 'Ollama was not running, so this is a keyword summary.'
          })
          this.deps.emit({ type: 'summary', meetingId, status: 'skipped', summary: fallback.summary })
        }

        // 3. Embed the transcript so semantic search can find it.
        await this.indexEmbeddings()
      }
    } catch (error) {
      log.error('post-processing failed', error)
      updateMeetingFields(meetingId, {
        summaryStatus: 'failed',
        summaryError: error instanceof Error ? error.message : String(error)
      })
      this.deps.emit({ type: 'summary', meetingId, status: 'failed' })
      this.deps.emit({ type: 'busy', label: null, progress: null })
    } finally {
      // 4. Apply the audio retention choice, once nothing else needs the files.
      if (!keepAudio) {
        this.deleteAudioFor(meetingId, audioDir)
      }
      this.deps.emit({ type: 'segments-updated', meetingId })
    }
  }

  private async resolveSummaryModel(): Promise<string | null> {
    const settings = getSettings()
    const models = await this.deps.ollama.listModels()
    if (models === null) return null

    if (settings.ollamaModel && models.some((model) => model.name === settings.ollamaModel)) {
      return settings.ollamaModel
    }

    const { pickSummaryModel } = await import('../llm/ollama')
    const chosen = pickSummaryModel(models, settings.ollamaModel)
    return chosen ?? null
  }

  /**
   * Runs diarization on the system-audio track and relabels those segments.
   *
   * The microphone track is deliberately excluded: it is known to be the user,
   * and including it would only make the clustering harder.
   */
  private async tryDiarize(meetingId: string, systemAudioPath: string): Promise<void> {
    try {
      const status = await this.deps.sidecar.status()
      if (!status.diarization.available) {
        log.info('diarization engine not installed; keeping stream-based speaker labels')
        return
      }

      this.deps.emit({ type: 'busy', label: 'Identifying speakers…', progress: null })

      const result = await this.deps.sidecar.diarize({ path: systemAudioPath })
      const distinct = [...new Set(result.turns.map((turn) => turn.speaker))]
      if (distinct.length <= 1) {
        log.info('diarization found a single speaker; no relabelling needed')
        return
      }

      // Map engine speaker ids onto readable labels in order of first appearance.
      const labelFor = new Map<string, string>()
      distinct.forEach((speaker, index) => labelFor.set(speaker, `Speaker ${index + 1}`))

      const segments = listSegments(meetingId).filter((segment) => segment.source === 'system')
      const updates: Array<{ id: string; label: string }> = []

      for (const segment of segments) {
        // Assign the speaker whose turn overlaps this segment the most.
        let bestLabel: string | null = null
        let bestOverlap = 0
        for (const turn of result.turns) {
          const start = turn.start * 1000
          const end = turn.end * 1000
          const overlap = Math.min(segment.endMs, end) - Math.max(segment.startMs, start)
          if (overlap > bestOverlap) {
            bestOverlap = overlap
            bestLabel = labelFor.get(turn.speaker) ?? null
          }
        }
        if (bestLabel && bestOverlap > 0 && bestLabel !== segment.speakerLabel) {
          updates.push({ id: segment.id, label: bestLabel })
        }
      }

      if (updates.length > 0) {
        updateSegmentSpeakerByIds(updates)
        log.info(`diarization relabelled ${updates.length} segments`)
        this.deps.emit({ type: 'segments-updated', meetingId })
      }
    } catch (error) {
      log.warn('diarization failed; keeping stream-based labels', error)
    }
  }

  /** Ensures every transcript segment has an embedding for search. */
  async indexEmbeddings(): Promise<{ embedded: number; total: number }> {
    const settings = getSettings()
    const { countEmbeddings, segmentsMissingEmbeddings, upsertEmbeddings } = await import(
      '../db/embeddings'
    )

    let sidecarEmbeddingsAvailable = false
    let sidecarEmbeddingModel = 'all-MiniLM-L6-v2'
    let sidecarEmbeddingDim = 384

    try {
      const status = await this.deps.sidecar.status()
      sidecarEmbeddingsAvailable = status.embeddings.available
      if (status.embeddings.model_present) sidecarEmbeddingModel = 'all-MiniLM-L6-v2'
      sidecarEmbeddingDim = status.embeddings.dim
    } catch {
      /* sidecar not running; fall through to the other tiers */
    }

    const models = (await this.deps.ollama.listModels()) ?? []
    const embedder = resolveEmbedder({
      sidecar: this.deps.sidecar,
      client: this.deps.ollama,
      models,
      configuredEmbeddingModel: settings.embeddingModel,
      sidecarEmbeddingsAvailable,
      sidecarEmbeddingModel,
      sidecarEmbeddingDim
    })

    return indexMissingEmbeddings(embedder, segmentsMissingEmbeddings, upsertEmbeddings, 32)
  }

  /* ---------------- "What did I miss?" ---------------- */

  async whatDidIMiss(minutes?: number): Promise<string> {
    const settings = getSettings()
    const window = minutes ?? settings.missedWindowMinutes
    const meetingId = this.meetingId

    // Prefer the live buffer; fall back to the database after a reload.
    let segments: LiveSegment[]
    if (meetingId && this.live.segments.length > 0) {
      segments = this.live.segments
    } else if (meetingId) {
      segments = listSegments(meetingId)
    } else {
      return 'No meeting is being recorded right now.'
    }

    if (segments.length === 0) {
      return 'Nothing has been transcribed yet. Give it a few seconds, then ask again.'
    }

    const model = await this.resolveSummaryModel()
    return summarizeMissedWindow(
      { client: this.deps.ollama, model },
      segments,
      window
    )
  }

  /* ---------------- discard ---------------- */

  /** Throws away the in-flight recording and everything it produced. */
  async discard(): Promise<void> {
    const meetingId = this.meetingId
    if (!meetingId) return

    if (this.ticker) {
      clearInterval(this.ticker)
      this.ticker = null
    }
    this.pipeline?.dispose()
    this.pipeline = null
    try {
      this.recorder?.kill()
    } catch {
      /* already gone */
    }

    this.deleteAudioFor(meetingId, join(getPaths().audioDir, meetingId))
    deleteMeeting(meetingId)

    this.meetingId = null
    this.recorder = null
    this.startedAt = null
    this.live = { segments: [] }
    this.warnings = []
    this.error = null
    this.pushState()
  }

  /* ---------------- audio retention ---------------- */

  private deleteAudioFor(meetingId: string, audioDir: string): void {
    try {
      if (existsSync(audioDir)) {
        rmSync(audioDir, { recursive: true, force: true })
        log.info(`deleted audio for ${meetingId}`)
      }
      clearMeetingAudio(meetingId)
    } catch (error) {
      log.warn(`could not delete audio for ${meetingId}`, error)
    }
  }

  /**
   * Deletes audio older than the configured retention window.
   *
   * Run at startup rather than on a timer: the app is only open for part of the
   * day, and a startup sweep is predictable and easy to reason about.
   */
  static sweepAudioRetention(): number {
    const settings = getSettings()
    if (settings.audioRetentionDays <= 0) return 0

    const cutoff = Date.now() - settings.audioRetentionDays * 86_400_000
    const candidates = meetingsWithAudioOlderThan(cutoff)
    let removed = 0

    for (const candidate of candidates) {
      try {
        if (existsSync(candidate.audioPath)) {
          const size = statSync(candidate.audioPath).isDirectory() ? 'dir' : 'file'
          rmSync(candidate.audioPath, { recursive: size === 'dir', force: true })
        }
        clearMeetingAudio(candidate.id)
        removed++
      } catch (error) {
        log.warn(`retention sweep could not delete ${candidate.audioPath}`, error)
      }
    }

    if (removed > 0) log.info(`retention sweep removed audio for ${removed} meetings`)
    return removed
  }

  /* ---------------- one-off file transcription ---------------- */

  /**
   * Transcribes a WAV file as a standalone meeting.
   *
   * Used both by "import an audio file" and to recover a recording that was
   * captured while the speech model was not yet installed.
   */
  async transcribeFile(filePath: string, title: string): Promise<string> {
    if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`)

    const settings = getSettings()
    const startedAt = statSync(filePath).mtimeMs
    const meeting = createMeeting({ title, startedAt })

    const segments = await this.deps.sidecar.transcribe({
      path: filePath,
      model: settings.whisperModel,
      initialPrompt: '',
      vad: true
    })

    const inputs: InsertSegmentInput[] = segments.segments.map((segment) => ({
      meetingId: meeting.id,
      speakerLabel: 'Speaker 1',
      source: 'mixed' as SourceKind,
      startMs: segment.start * 1000,
      endMs: segment.end * 1000,
      text: segment.text,
      confidence: segment.confidence,
      corrected: false
    }))

    if (inputs.length > 0) insertSegments(inputs)

    updateMeetingFields(meeting.id, {
      endedAt: startedAt + (segments.duration || 0) * 1000,
      durationMs: (segments.duration || 0) * 1000,
      audioPath: filePath,
      summaryStatus: 'pending'
    })

    this.deps.emit({ type: 'segments-updated', meetingId: meeting.id })

    const model = await this.resolveSummaryModel()
    const list = listSegments(meeting.id)
    const result = await summarizeMeeting(
      { client: this.deps.ollama, model },
      { segments: list, title: meeting.title }
    )
    updateMeetingFields(meeting.id, {
      summary: result.summary,
      summarizedAt: Date.now(),
      summaryStatus: result.degraded ? 'skipped' : 'ok'
    })
    if (result.actionItems.length > 0) {
      replaceActionItems(meeting.id, result.actionItems)
    }

    void this.indexEmbeddings()

    return meeting.id
  }

  get supporting(): { transcribing: boolean; actionItems: number } {
    return {
      transcribing: this.transcribing,
      actionItems: this.meetingId ? listActionItems(this.meetingId).length : 0
    }
  }
}
