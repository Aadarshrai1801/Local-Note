/**
 * Shared domain types for Local Note.
 *
 * These are imported by both the Electron main process and the React renderer,
 * so they must stay free of runtime dependencies (types only). The shape of
 * these types is the contract for every IPC call.
 */

export type StreamKind = 'system' | 'mic'

/** Where a transcript segment came from, which also implies who spoke. */
export type SourceKind = 'system' | 'mic' | 'mixed'

export interface Meeting {
  id: string
  title: string
  startedAt: number
  endedAt: number | null
  /** Null when the user chose to discard audio after transcription. */
  audioPath: string | null
  durationMs: number | null
  summary: string | null
  /** Free-text agenda/notes captured before the meeting (pre-meeting brief). */
  briefNotes: string | null
  /** Paths of documents dragged in for the pre-meeting brief. */
  briefDocs: string | null
  /** LLM bullet summary of the brief, if generated. */
  briefSummary: string | null
  /** Non-null once post-meeting summarisation has completed. */
  summarizedAt: number | null
  /** ok | failed | skipped | pending */
  summaryStatus: SummaryStatus
  summaryError: string | null
  segmentCount: number
  actionItemCount: number
}

export type SummaryStatus = 'pending' | 'ok' | 'failed' | 'skipped'

export interface TranscriptSegment {
  id: string
  meetingId: string
  speakerLabel: string | null
  source: SourceKind
  startMs: number
  endMs: number
  text: string
  /** Confidence 0..1 if the STT engine reports one. */
  confidence: number | null
  /** True when the segment was corrected by the personal dictionary. */
  corrected: boolean
}

export interface ActionItem {
  id: string
  meetingId: string
  text: string
  assignee: string | null
  done: boolean
  /** Ordering hint as produced/edited by the user. */
  position: number
}

export interface DictionaryTerm {
  id: string
  term: string
  /** Optional replacement: how the term should actually be spelled. */
  replacement: string | null
  notes: string | null
  createdAt: number
  hitCount: number
}

export interface SpeakerName {
  meetingId: string
  speakerLabel: string
  displayName: string
}

/** A named voice profile used to keep speaker labels stable across meetings. */
export interface VoiceProfile {
  id: string
  name: string
  /** JSON-encoded number[] embedding centroid. */
  centroid: string
  embeddingModel: string
  dim: number
  sampleCount: number
  createdAt: number
  updatedAt: number
}

/* ------------------------------------------------------------------ */
/* Model / backend status                                              */
/* ------------------------------------------------------------------ */

export interface SttStatus {
  /** Which engine will be used, or null when nothing is installed. */
  engine: 'faster-whisper' | 'whisper.cpp' | null
  available: boolean
  pythonPath: string | null
  pythonVersion: string | null
  /** Installed faster-whisper version, if importable. */
  version: string | null
  modelsPresent: string[]
  modelDir: string
  /** Human-readable next step when unavailable. */
  guidance: string | null
  error: string | null
}

export interface OllamaModel {
  name: string
  sizeBytes: number | null
  parameterSize: string | null
}

export interface LlmStatus {
  available: boolean
  host: string
  models: OllamaModel[]
  selectedModel: string | null
  embeddingModel: string | null
  error: string | null
  guidance: string | null
}

export interface DiarizationStatus {
  available: boolean
  engine: 'pyannote' | 'speechbrain' | 'stream' | null
  guidance: string | null
}

export interface BackendStatus {
  stt: SttStatus
  llm: LlmStatus
  diarization: DiarizationStatus
}

/* ------------------------------------------------------------------ */
/* Live session state                                                  */
/* ------------------------------------------------------------------ */

export interface StreamLevel {
  stream: StreamKind
  /** Wall-clock ms since session start as reported by the recorder. */
  ms: number
  capturedMs: number
  realMs: number
  paddedMs: number
  packets: number
  /** Recent RMS amplitude 0..1 for a level meter. */
  rms: number
  /** True when the stream has produced no real audio at all (likely a problem). */
  dead: boolean
  deviceName: string | null
}

export interface LiveSegment extends TranscriptSegment {
  /** True while the segment is the newest one and may still be revised. */
  provisional?: boolean
}

export interface RecordingTargets {
  system: boolean
  mic: boolean
}

export interface StartRecordingOptions {
  title?: string
  briefNotes?: string
  briefDocs?: string[]
  targets?: RecordingTargets
  /** Which Whisper model id to use, e.g. "base.en" or "small". */
  model?: string
  /** Keep the raw audio files after the meeting. */
  keepAudio?: boolean
}

export interface SessionState {
  active: boolean
  meetingId: string | null
  title: string
  startedAt: number | null
  /** Total audio ms captured so far (from the system stream when present). */
  elapsedMs: number
  levels: Record<StreamKind, StreamLevel | null>
  /** True when the recorder compiled/launched but capture failed. */
  error: string | null
  /** Non-fatal problems the user should know about (e.g. silent microphone). */
  warnings: string[]
  /** Progress of the transcription queue. */
  queueDepth: number
  /** Seconds of audio still waiting to be transcribed. */
  backlogSeconds: number
}

/* ------------------------------------------------------------------ */
/* Search                                                             */
/* ------------------------------------------------------------------ */

export interface SearchHit {
  meetingId: string
  meetingTitle: string
  startedAt: number
  segmentId: string | null
  snippet: string
  startMs: number | null
  speakerLabel: string | null
  /** Relevance score; higher is better. Comparable only within one result set. */
  score: number
  /** Which retrieval path produced this hit. */
  via: 'keyword' | 'semantic' | 'both'
}

export interface SearchOptions {
  query: string
  limit?: number
  /** Restrict to meetings started within the last N days. */
  sinceDays?: number
  semantic?: boolean
  keyword?: boolean
}

export interface RagAnswer {
  answer: string
  citations: Array<{
    meetingId: string
    meetingTitle: string
    segmentId: string
    startMs: number
    text: string
  }>
  usedModel: string
  /** True when the answer was assembled without an LLM (extractive fallback). */
  degraded: boolean
}

/* ------------------------------------------------------------------ */
/* Setup / health                                                     */
/* ------------------------------------------------------------------ */

export interface AppPaths {
  dataDir: string
  dbPath: string
  audioDir: string
  modelsDir: string
  logsDir: string
  briefDocsDir: string
}

export interface SetupCheck {
  id: string
  label: string
  status: 'ok' | 'warn' | 'missing'
  detail: string
  /** What the user can do about it. */
  action: string | null
}

export interface AppSettings {
  whisperModel: string
  ollamaModel: string | null
  embeddingModel: string | null
  keepAudio: boolean
  /** Delete audio automatically after N days (0 = never). */
  audioRetentionDays: number
  captureMic: boolean
  /** Roll-back window used by "What did I miss?". */
  missedWindowMinutes: number
  dictionaryEnabled: boolean
  /** Minimum RMS for a chunk to be sent to STT (skips silence). */
  silenceThreshold: number
  ollamaHost: string
  pythonPath: string | null
  systemDeviceId: string | null
  micDeviceId: string | null
  theme: 'dark' | 'light' | 'system'
}

/** Events pushed from main -> renderer over a single IPC channel. */
export type MainEvent =
  | { type: 'session'; state: SessionState }
  | { type: 'segment'; segment: LiveSegment }
  | { type: 'segments-updated'; meetingId: string }
  | { type: 'summary'; meetingId: string; status: SummaryStatus; summary?: string }
  | { type: 'action-items'; meetingId: string }
  | { type: 'toast'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'busy'; label: string | null; progress: number | null }
  | { type: 'status'; status: BackendStatus }
  | { type: 'navigate'; view: string; meetingId?: string }
