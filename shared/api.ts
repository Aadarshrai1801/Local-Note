/**
 * The complete IPC surface exposed to the renderer as `window.localNote`.
 *
 * Keeping this as one interface means the preload bridge, the main-process
 * handlers and the React UI are all checked against the same contract.
 */
import type {
  ActionItem,
  AppPaths,
  AppSettings,
  BackendStatus,
  DictionaryTerm,
  Meeting,
  RagAnswer,
  SearchHit,
  SearchOptions,
  SessionState,
  SetupCheck,
  SpeakerName,
  StartRecordingOptions,
  TranscriptSegment,
  MainEvent,
  VoiceProfile
} from './types'

export interface WhisperModelInfo {
  id: string
  label: string
  /** Approximate download size, for the setup screen. */
  sizeBytes: number
  /** Rough RAM guidance for the README/settings. */
  ramGb: number
  downloaded: boolean
  /** Whether this model is English-only. */
  englishOnly: boolean
  note: string
}

export interface MeetingDetail {
  meeting: Meeting
  segments: TranscriptSegment[]
  actionItems: ActionItem[]
  speakers: SpeakerName[]
}

export interface IcsImport {
  title: string | null
  startedAt: number | null
  endedAt: number | null
  attendees: string[]
  description: string | null
  location: string | null
}

export interface SummaryProgress {
  /** 0..1 while a map-reduce summarisation is running. */
  progress: number
  label: string
}

export interface LocalNoteApi {
  /* ---------------- settings + health ---------------- */
  getSettings(): Promise<AppSettings>
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  getPaths(): Promise<AppPaths>
  getStatus(): Promise<BackendStatus>
  refreshStatus(): Promise<BackendStatus>
  runSetupChecks(): Promise<SetupCheck[]>

  /* ---------------- meetings ---------------- */
  listMeetings(): Promise<Meeting[]>
  getMeeting(id: string): Promise<MeetingDetail | null>
  updateMeeting(
    id: string,
    patch: Partial<Pick<Meeting, 'title' | 'briefNotes'>>
  ): Promise<Meeting>
  deleteMeeting(id: string): Promise<void>
  exportMeeting(id: string, format: 'md' | 'txt' | 'json'): Promise<string | null>
  revealMeetingAudio(id: string): Promise<void>

  /* ---------------- speakers ---------------- */
  getSpeakerNames(meetingId: string): Promise<SpeakerName[]>
  renameSpeaker(meetingId: string, label: string, displayName: string): Promise<void>
  listVoiceProfiles(): Promise<VoiceProfile[]>
  deleteVoiceProfile(id: string): Promise<void>

  /* ---------------- recording ---------------- */
  startRecording(opts: StartRecordingOptions): Promise<{ meetingId: string }>
  stopRecording(): Promise<{ meetingId: string }>
  getSession(): Promise<SessionState>
  discardSession(): Promise<void>

  /* ---------------- pre-meeting brief ---------------- */
  setBrief(meetingId: string, notes: string, docs: string[]): Promise<Meeting>
  attachBriefDocs(): Promise<string[]>
  importIcs(): Promise<IcsImport | null>
  generateBrief(meetingId: string): Promise<string>

  /* ---------------- live / summaries ---------------- */
  whatDidIMiss(minutes?: number): Promise<string>
  generateSummary(meetingId: string): Promise<Meeting>
  askAboutMeeting(meetingId: string, question: string): Promise<string>
  regenerateActionItems(meetingId: string): Promise<ActionItem[]>
  addActionItem(meetingId: string, text: string, assignee: string | null): Promise<ActionItem>
  updateActionItem(
    id: string,
    patch: Partial<Pick<ActionItem, 'text' | 'assignee' | 'done'>>
  ): Promise<void>
  deleteActionItem(id: string): Promise<void>

  /* ---------------- search ---------------- */
  search(opts: SearchOptions): Promise<SearchHit[]>
  askAcrossMeetings(question: string, meetingIds?: string[]): Promise<RagAnswer>
  reindexSearch(): Promise<{ embedded: number; total: number }>

  /* ---------------- dictionary ---------------- */
  listDictionary(): Promise<DictionaryTerm[]>
  addDictionaryTerm(
    term: string,
    replacement?: string | null,
    notes?: string | null
  ): Promise<DictionaryTerm>
  updateDictionaryTerm(
    id: string,
    patch: Partial<Pick<DictionaryTerm, 'term' | 'replacement' | 'notes'>>
  ): Promise<DictionaryTerm>
  deleteDictionaryTerm(id: string): Promise<void>

  /* ---------------- models ---------------- */
  listWhisperModels(): Promise<WhisperModelInfo[]>
  downloadWhisperModel(id: string): Promise<{ ok: boolean; message: string }>
  deleteWhisperModel(id: string): Promise<void>
  compileRecorder(): Promise<{ ok: boolean; message: string }>
  transcribeAudioFile(): Promise<{ meetingId: string } | null>

  /* ---------------- misc ---------------- */
  openDataDir(): Promise<void>
  openLogs(): Promise<void>
  getLogTail(lines?: number): Promise<string>

  /* ---------------- floating capture bar ---------------- */
  getCaptureBarStatus(): Promise<{
    enabled: boolean
    hideWhenIdle: boolean
    hotkey: string
    /** False when another application already owns the shortcut. */
    hotkeyRegistered: boolean
  }>
  resetCaptureBarPosition(): Promise<void>

  /* ---------------- events ---------------- */
  onEvent(callback: (event: MainEvent) => void): () => void
}

/** Channel names, kept in one place so main and preload cannot drift. */
export const CHANNELS = {
  invoke: 'localnote:invoke',
  event: 'localnote:event'
} as const

/**
 * Every method that is dispatched over the invoke channel.
 *
 * This exists as a runtime list (not just a type) so the preload bridge can be
 * generated from it, and so the main process can declare its handler table as
 * `Record<InvokeMethod, ...>` — which makes TypeScript fail the build if a
 * method is ever added to the interface without an implementation.
 */
export const INVOKE_METHODS = [
  'getSettings',
  'updateSettings',
  'getPaths',
  'getStatus',
  'refreshStatus',
  'runSetupChecks',
  'listMeetings',
  'getMeeting',
  'updateMeeting',
  'deleteMeeting',
  'exportMeeting',
  'revealMeetingAudio',
  'getSpeakerNames',
  'renameSpeaker',
  'listVoiceProfiles',
  'deleteVoiceProfile',
  'startRecording',
  'stopRecording',
  'getSession',
  'discardSession',
  'setBrief',
  'attachBriefDocs',
  'importIcs',
  'generateBrief',
  'whatDidIMiss',
  'generateSummary',
  'askAboutMeeting',
  'regenerateActionItems',
  'addActionItem',
  'updateActionItem',
  'deleteActionItem',
  'search',
  'askAcrossMeetings',
  'reindexSearch',
  'listDictionary',
  'addDictionaryTerm',
  'updateDictionaryTerm',
  'deleteDictionaryTerm',
  'listWhisperModels',
  'downloadWhisperModel',
  'deleteWhisperModel',
  'compileRecorder',
  'transcribeAudioFile',
  'openDataDir',
  'openLogs',
  'getLogTail',
  'getCaptureBarStatus',
  'resetCaptureBarPosition'
] as const

export type InvokeMethod = (typeof INVOKE_METHODS)[number]

/**
 * Compile-time guard: if a method is added to `LocalNoteApi` but not to
 * `INVOKE_METHODS`, the assignment below stops type-checking.
 */
type AssertAllExposed = Exclude<keyof LocalNoteApi, 'onEvent'> extends InvokeMethod ? true : never
export type _ExposureCheck = AssertAllExposed
