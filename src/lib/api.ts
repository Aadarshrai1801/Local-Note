/**
 * Renderer-side access to the Electron bridge.
 *
 * The preload script exposes `window.localNote` (typed by `shared/api.ts`).
 * When the renderer is served by plain `vite dev` — i.e. in a browser, without
 * Electron — there is no bridge, so we fall back to an in-memory mock that
 * implements the *entire* `LocalNoteApi`. That keeps UI work possible without
 * the native recorder, Whisper, or Ollama.
 *
 * The mock is deliberately honest: it never fakes a capability silently. In
 * browser-mock mode the sidebar shows a "browser mock" badge so nobody
 * mistakes it for a real session.
 */
import type {
  ActionItem,
  AppPaths,
  AppSettings,
  BackendStatus,
  DictionaryTerm,
  LiveSegment,
  MainEvent,
  Meeting,
  RagAnswer,
  SearchHit,
  SearchOptions,
  SessionState,
  SetupCheck,
  SpeakerName,
  StartRecordingOptions,
  StreamKind,
  StreamLevel,
  SummaryStatus,
  TranscriptSegment,
  VoiceProfile
} from '@shared/types'
import type { IcsImport, LocalNoteApi, MeetingDetail, WhisperModelInfo } from '@shared/api'

declare global {
  interface Window {
    localNote?: LocalNoteApi
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Deterministic RNG so the mock dataset is identical on every reload. */
function makeRng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 4294967296
  }
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n))
}

/* ------------------------------------------------------------------ */
/* Browser mock                                                        */
/* ------------------------------------------------------------------ */

const DATA_DIR = 'C:\\Users\\Alex\\AppData\\Roaming\\Local Note'

const MOCK_PATHS: AppPaths = {
  dataDir: DATA_DIR,
  dbPath: `${DATA_DIR}\\localnote.db`,
  audioDir: `${DATA_DIR}\\audio`,
  modelsDir: `${DATA_DIR}\\models`,
  logsDir: `${DATA_DIR}\\logs`,
  briefDocsDir: `${DATA_DIR}\\brief-docs`
}

const MOCK_SETTINGS: AppSettings = {
  whisperModel: 'base.en',
  ollamaModel: 'llama3.1:8b',
  embeddingModel: 'nomic-embed-text',
  keepAudio: false,
  audioRetentionDays: 7,
  captureMic: true,
  missedWindowMinutes: 10,
  dictionaryEnabled: true,
  silenceThreshold: 0.012,
  ollamaHost: 'http://127.0.0.1:11434',
  pythonPath: 'C:\\Python312\\python.exe',
  systemDeviceId: 'default-render',
  micDeviceId: null,
  theme: 'dark',
  captureBarEnabled: true,
  captureBarHideWhenIdle: false,
  captureHotkey: 'CommandOrControl+Shift+Space',
  captureBarPosition: null
}

const MOCK_MODELS: WhisperModelInfo[] = [
  {
    id: 'tiny.en',
    label: 'Tiny (English)',
    sizeBytes: 78_000_000,
    ramGb: 1,
    downloaded: true,
    englishOnly: true,
    note: 'Fastest, least accurate. Fine for a quick check that capture works.'
  },
  {
    id: 'base.en',
    label: 'Base (English)',
    sizeBytes: 148_000_000,
    ramGb: 1,
    downloaded: true,
    englishOnly: true,
    note: 'The default. Good balance for meetings where only one person speaks at a time.'
  },
  {
    id: 'small.en',
    label: 'Small (English)',
    sizeBytes: 488_000_000,
    ramGb: 2,
    downloaded: false,
    englishOnly: true,
    note: 'Clearly better on names and jargon. A good upgrade if you have 8 GB of RAM.'
  },
  {
    id: 'medium.en',
    label: 'Medium (English)',
    sizeBytes: 1_530_000_000,
    ramGb: 5,
    downloaded: false,
    englishOnly: true,
    note: 'Near-large quality, noticeably slower. Needs a reasonably modern CPU.'
  },
  {
    id: 'large-v3',
    label: 'Large v3 (multilingual)',
    sizeBytes: 3_100_000_000,
    ramGb: 8,
    downloaded: false,
    englishOnly: false,
    note: 'Best accuracy and multilingual. Slow on CPU; a GPU makes a big difference.'
  }
]

const MOCK_SEEDS: Array<{
  id: string
  title: string
  daysAgo: number
  atHour: number
  atMinute: number
  durationMs: number
  summary: string | null
  summaryStatus: SummaryStatus
  briefNotes: string | null
  briefDocs: string | null
  audio: boolean
  speakers: string[]
  turns: number
  topics: string[]
}> = [
  {
    id: 'mtg-1042',
    title: 'Weekly product sync',
    daysAgo: 0,
    atHour: 9,
    atMinute: 30,
    durationMs: 41 * 60_000,
    summary:
      'Transcription latency is now under five seconds on base.en, so the live view keeps up with a normal conversation. The team agreed to ship the pre-meeting brief behind a toggle while it is still rough, and to keep audio off by default so nothing piles up on disk. Priya will draft the retention copy for settings; Marcus will measure how often the dictionary actually fires.',
    summaryStatus: 'ok',
    briefNotes:
      'Standing agenda:\n1. Transcription latency\n2. Brief panel feedback\n3. Audio retention default\n4. Dictionary hits',
    briefDocs: null,
    audio: false,
    speakers: ['Speaker 1', 'You'],
    turns: 96,
    topics: ['latency', 'dictionary', 'retention', 'toggle']
  },
  {
    id: 'mtg-1039',
    title: 'Design review — onboarding flow',
    daysAgo: 0,
    atHour: 14,
    atMinute: 5,
    durationMs: 52 * 60_000,
    summary:
      'The first-run screen is doing too much at once. The agreed shape is three steps — capture the native recorder, install the Python packages, download one Whisper model — each with a copyable command and an honest note about the download. The escape hatch matters: people want to look around before committing, so "skip and explore" stays.',
    summaryStatus: 'ok',
    briefNotes: 'Review the first-run screen and the empty states for Home.',
    briefDocs: `${DATA_DIR}\\brief-docs\\onboarding-notes.md`,
    audio: false,
    speakers: ['Speaker 1', 'Speaker 2', 'You'],
    turns: 74,
    topics: ['setup', 'empty states', 'wordmark', 'copy']
  },
  {
    id: 'mtg-1031',
    title: 'Northwind vendor call',
    daysAgo: 1,
    atHour: 11,
    atMinute: 0,
    durationMs: 33 * 60_000,
    summary: null,
    summaryStatus: 'pending',
    briefNotes:
      'Renewal terms, data residency, and whether their SDK is allowed to run offline.',
    briefDocs: `${DATA_DIR}\\brief-docs\\northwind-agenda.md\n${DATA_DIR}\\brief-docs\\northwind-quote.pdf`,
    audio: false,
    speakers: ['Speaker 1', 'Speaker 2', 'You'],
    turns: 58,
    topics: ['residency', 'renewal', 'pricing', 'offline']
  },
  {
    id: 'mtg-1027',
    title: '1:1 with Priya',
    daysAgo: 2,
    atHour: 16,
    atMinute: 45,
    durationMs: 24 * 60_000,
    summary:
      'Priya is taking the settings rewrite. We agreed the diagnostics panel should stay ugly-but-useful: raw log tail, setup checks with real actions, and a rebuild button for the recorder. Career conversation deferred to the next 1:1.',
    summaryStatus: 'ok',
    briefNotes: 'Growth plan check-in, then settings ownership.',
    briefDocs: null,
    audio: false,
    speakers: ['Speaker 1', 'You'],
    turns: 41,
    topics: ['ownership', 'diagnostics', 'growth']
  },
  {
    id: 'mtg-1019',
    title: 'Quarterly planning',
    daysAgo: 6,
    atHour: 13,
    atMinute: 15,
    durationMs: 88 * 60_000,
    summary:
      'Three bets for the quarter: make capture bulletproof on Windows, make the transcript correctable in five seconds or less, and keep every byte on the machine. Stretch goal is optional diarization with local voice profiles.',
    summaryStatus: 'ok',
    briefNotes: 'Q3 bets, staffing, and the offline-only commitment.',
    briefDocs: null,
    audio: true,
    speakers: ['Speaker 1', 'Speaker 2', 'Speaker 3', 'You'],
    turns: 152,
    topics: ['Q3', 'capture', 'diarization', 'offline']
  },
  {
    id: 'mtg-1004',
    title: 'Customer interview — Dana',
    daysAgo: 13,
    atHour: 10,
    atMinute: 0,
    durationMs: 47 * 60_000,
    summary:
      'Dana records two or three calls a day and refuses to send them to a cloud service. She wants the notes to be searchable months later, and she reads the summary before the transcript every time. She asked for a way to fix names once and have that stick.',
    summaryStatus: 'ok',
    briefNotes: 'Discovery call. Ask about how notes get shared after the meeting.',
    briefDocs: `${DATA_DIR}\\brief-docs\\interview-guide.md`,
    audio: true,
    speakers: ['Speaker 1', 'You'],
    turns: 88,
    topics: ['privacy', 'summaries', 'names', 'sharing']
  }
]

const MOCK_TURNS: string[] = [
  'Let me share the window so you can see what I mean.',
  'The important part is that nothing leaves the machine — no account, no upload.',
  'I think we are agreed on the shape, the question is the default value.',
  'Last week we shipped the capture fix and it has been quiet since.',
  'Can you say a bit more about how you handle a muted microphone?',
  'If the queue falls behind we surface it instead of hiding the lag.',
  'I would rather see a rough summary immediately than a perfect one tomorrow.',
  'That matches what we saw in testing, roughly four seconds on average.',
  'Let me write down the names exactly as they should be spelled.',
  'The dictionary biases the model, so it stops mangling product names.',
  'Search should work even when the model is not running — keyword first.',
  'We keep the audio by default for zero days, which means we delete it.',
  'One risk: the first download is a few hundred megabytes.',
  'I will take the retention copy and have a draft by Thursday.',
  'Two small asks: a keyboard shortcut for stop, and a real timer.',
  'The brief is optional, but it makes the summary noticeably better.',
  'Do we want the action items to be editable in place?',
  'Yes — an action you cannot correct is worse than no action at all.',
  'I will measure how often the dictionary actually fires this month.',
  'Understood. Let us keep the scope tight and revisit next week.'
]

const MOCK_LIVE_LINES: Array<{ text: string; source: 'system' | 'mic' }> = [
  { text: 'Okay, I think we are rolling — can you hear me alright?', source: 'system' },
  { text: 'Loud and clear. I can see it transcribing on my side too.', source: 'mic' },
  { text: 'Good. So the first thing on the agenda is the latency numbers.', source: 'system' },
  { text: 'Right, and I noticed the backlog counter is finally staying near zero.', source: 'mic' },
  { text: 'That matches what I measured — about three to four seconds behind.', source: 'system' },
  { text: 'Which is fast enough that I have stopped waiting before I reply.', source: 'mic' },
  { text: 'The next item is the brief panel — did you get the documents I sent?', source: 'system' },
  { text: 'I did, both of them came through with the attendee list.', source: 'mic' },
  { text: 'Perfect. Then let us talk about what happens after we hit stop.', source: 'system' },
  { text: 'Summary runs locally, and if it fails we still keep the transcript.', source: 'mic' },
  { text: 'That is the part I care about — the transcript is the real artifact.', source: 'system' },
  { text: 'Agreed. Notes are a convenience, the transcript is the record.', source: 'mic' },
  { text: 'Let us finish with action items so nothing is ambiguous tomorrow.', source: 'system' },
  { text: 'I will write them up before I leave the call.', source: 'mic' }
]

function buildMeetings(now: number): Meeting[] {
  const rng = makeRng(20_260_922)
  return MOCK_SEEDS.map((seed) => {
    const startedAt =
      new Date(
        new Date(now - seed.daysAgo * DAY_MS).setHours(seed.atHour, seed.atMinute, 0, 0)
      ).getTime()
    const segmentCount = seed.turns
    return {
      id: seed.id,
      title: seed.title,
      startedAt,
      endedAt: startedAt + seed.durationMs,
      audioPath: seed.audio ? `${MOCK_PATHS.audioDir}\\${seed.id}\\system\\full.wav` : null,
      durationMs: seed.durationMs,
      summary: seed.summary,
      briefNotes: seed.briefNotes,
      briefDocs: seed.briefDocs,
      briefSummary: seed.briefNotes
        ? 'Brief captured before the meeting. Attendees imported from the calendar invite.'
        : null,
      summarizedAt: seed.summary ? startedAt + seed.durationMs + 60_000 : null,
      summaryStatus: seed.summaryStatus,
      summaryError: null,
      segmentCount,
      actionItemCount: Math.max(2, Math.round(segmentCount / 18) + Math.round(rng() * 2))
    }
  })
}

function buildSegments(meetings: Meeting[]): TranscriptSegment[] {
  const rng = makeRng(7_311)
  const out: TranscriptSegment[] = []
  meetings.forEach((meeting, mIndex) => {
    const seed = MOCK_SEEDS[mIndex]
    const duration = meeting.durationMs ?? 0
    const step = duration / seed.turns
    let line = mIndex * 5
    let speakerIndex = 0
    let run = 1 + Math.floor(rng() * 3)
    for (let i = 0; i < seed.turns; i += 1) {
      if (run <= 0) {
        speakerIndex = (speakerIndex + 1) % seed.speakers.length
        run = 1 + Math.floor(rng() * 3)
      }
      run -= 1
      const startMs = Math.round(i * step + rng() * step * 0.2)
      const text = MOCK_TURNS[line % MOCK_TURNS.length]
      line += 1
      const speakerLabel = seed.speakers[speakerIndex]
      const source: TranscriptSegment['source'] =
        speakerLabel === 'You' ? 'mic' : rng() > 0.94 ? 'mixed' : 'system'
      out.push({
        id: `${meeting.id}-seg-${String(i).padStart(4, '0')}`,
        meetingId: meeting.id,
        speakerLabel,
        source,
        startMs,
        endMs: Math.min(duration, startMs + Math.round(step * 0.85)),
        text,
        confidence: Math.round((0.82 + rng() * 0.16) * 100) / 100,
        corrected: rng() > 0.9
      })
    }
  })
  return out
}

function buildActionItems(meetings: Meeting[]): ActionItem[] {
  const rng = makeRng(4_242)
  const texts: Array<{ text: string; assignee: string | null }> = [
    { text: 'Draft the audio-retention copy for Settings', assignee: 'Priya' },
    { text: 'Measure dictionary hit rate for one week', assignee: 'Marcus' },
    { text: 'Decide whether the brief panel ships behind a toggle', assignee: null },
    { text: 'Add the recorder rebuild button to Diagnostics', assignee: 'Priya' },
    { text: 'Write down the latency numbers in the quarterly deck', assignee: 'You' },
    { text: 'Check the Northwind contract for data-residency wording', assignee: null },
    { text: 'Ask two more customers how they share notes', assignee: 'Sam' },
    { text: 'Verify capture survives a device switch mid-meeting', assignee: 'Marcus' }
  ]
  const out: ActionItem[] = []
  meetings.forEach((meeting, mIndex) => {
    const count = meeting.actionItemCount
    for (let i = 0; i < count; i += 1) {
      const pick = texts[(mIndex * 3 + i) % texts.length]
      out.push({
        id: `${meeting.id}-act-${i}`,
        meetingId: meeting.id,
        text: pick.text,
        assignee: pick.assignee,
        done: rng() > 0.72,
        position: i
      })
    }
  })
  return out
}

const MOCK_SPEAKER_NAMES: SpeakerName[] = [
  { meetingId: 'mtg-1027', speakerLabel: 'Speaker 1', displayName: 'Priya Raghavan' },
  { meetingId: 'mtg-1027', speakerLabel: 'You', displayName: 'You' },
  { meetingId: 'mtg-1004', speakerLabel: 'Speaker 1', displayName: 'Dana Whitfield' }
]

const MOCK_DICTIONARY: DictionaryTerm[] = [
  {
    id: 'dict-1',
    term: 'faster whisper',
    replacement: 'faster-whisper',
    notes: 'The Python STT engine. Always hyphenated.',
    createdAt: Date.now() - 21 * DAY_MS,
    hitCount: 34
  },
  {
    id: 'dict-2',
    term: 'wazzup i',
    replacement: 'WASAPI',
    notes: 'Windows loopback capture API.',
    createdAt: Date.now() - 20 * DAY_MS,
    hitCount: 12
  },
  {
    id: 'dict-3',
    term: 'ollama',
    replacement: null,
    notes: 'Local model runner. Bias the model toward the correct spelling.',
    createdAt: Date.now() - 14 * DAY_MS,
    hitCount: 27
  },
  {
    id: 'dict-4',
    term: 'nomic embed text',
    replacement: 'nomic-embed-text',
    notes: 'Embedding model used for semantic search.',
    createdAt: Date.now() - 14 * DAY_MS,
    hitCount: 9
  },
  {
    id: 'dict-5',
    term: 'priya raghavan',
    replacement: null,
    notes: null,
    createdAt: Date.now() - 9 * DAY_MS,
    hitCount: 18
  },
  {
    id: 'dict-6',
    term: 'northwind',
    replacement: 'Northwind',
    notes: 'Vendor. Capitalised.',
    createdAt: Date.now() - 3 * DAY_MS,
    hitCount: 5
  }
]

const MOCK_VOICE_PROFILES: VoiceProfile[] = [
  {
    id: 'voice-1',
    name: 'Priya Raghavan',
    centroid: '[0.12,-0.44,0.91,0.03]',
    embeddingModel: 'speechbrain/spkrec-ecapa-voxceleb',
    dim: 192,
    sampleCount: 6,
    createdAt: Date.now() - 30 * DAY_MS,
    updatedAt: Date.now() - 4 * DAY_MS
  },
  {
    id: 'voice-2',
    name: 'Marcus Feld',
    centroid: '[0.55,-0.02,0.31,-0.6]',
    embeddingModel: 'speechbrain/spkrec-ecapa-voxceleb',
    dim: 192,
    sampleCount: 3,
    createdAt: Date.now() - 18 * DAY_MS,
    updatedAt: Date.now() - 11 * DAY_MS
  }
]

function mockStatus(models: WhisperModelInfo[]): BackendStatus {
  return {
    stt: {
      engine: 'faster-whisper',
      available: true,
      pythonPath: MOCK_SETTINGS.pythonPath,
      pythonVersion: '3.12.4',
      version: '1.0.3',
      modelsPresent: models.filter((m) => m.downloaded).map((m) => m.id),
      modelDir: `${MOCK_PATHS.modelsDir}\\whisper`,
      guidance: null,
      error: null
    },
    llm: {
      available: true,
      host: MOCK_SETTINGS.ollamaHost,
      models: [
        { name: 'llama3.1:8b', sizeBytes: 4_920_000_000, parameterSize: '8B' },
        { name: 'qwen2.5:7b', sizeBytes: 4_680_000_000, parameterSize: '7B' }
      ],
      selectedModel: MOCK_SETTINGS.ollamaModel,
      embeddingModel: MOCK_SETTINGS.embeddingModel,
      error: null,
      guidance: null
    },
    diarization: {
      available: false,
      engine: 'stream',
      guidance:
        'Speaker labels come from the audio streams: system audio is "Them", your microphone is "You". Install pyannote for full diarization.'
    }
  }
}

function mockLogTail(lines = 200): string {
  const stamp = (offsetSeconds: number): string =>
    new Date(Date.now() - offsetSeconds * 1000).toISOString()
  const base = [
    `${stamp(240)}  INFO   app        Local Note 0.1.0 starting (offline mode)`,
    `${stamp(239)}  INFO   paths      data dir: ${MOCK_PATHS.dataDir}`,
    `${stamp(239)}  INFO   db         sqlite schema at version 4`,
    `${stamp(236)}  INFO   setup      running first-run checks`,
    `${stamp(234)}  OK     stt        faster-whisper 1.0.3 via ${MOCK_SETTINGS.pythonPath}`,
    `${stamp(234)}  OK     stt        model base.en present (${MOCK_PATHS.modelsDir}\\whisper)`,
    `${stamp(233)}  WARN   llm        ollama reachable but model llama3.1:8b is loading`,
    `${stamp(220)}  OK     llm        ollama ready on ${MOCK_SETTINGS.ollamaHost}`,
    `${stamp(180)}  INFO   recorder   compiled WasapiRecorder.exe (csc, 41 ms)`,
    `${stamp(60)}   INFO   recorder   session started: system=on mic=on`,
    `${stamp(59)}   INFO   stt        queue depth 0, backlog 0.0s`,
    `${stamp(41)}   WARN   recorder   microphone reported a silent buffer (rms 0.0004)`,
    `${stamp(40)}   OK     recorder   microphone recovered (rms 0.081)`,
    `${stamp(12)}   INFO   stt        transcribed chunk 74 in 412 ms`,
    `${stamp(4)}    INFO   session    idle, no active capture`
  ]
  return base.slice(0, Math.max(1, Math.min(lines, base.length))).join('\n')
}

function mockSetupChecks(models: WhisperModelInfo[]): SetupCheck[] {
  const modelsPresent = models.filter((m) => m.downloaded).map((m) => m.id)
  return [
    {
      id: 'native-recorder',
      label: 'Audio capture helper',
      status: 'ok',
      detail: `WasapiRecorder.exe compiled and responding at ${MOCK_PATHS.dataDir}\\bin\\WasapiRecorder.exe`,
      action: null
    },
    {
      id: 'python',
      label: 'Python runtime',
      status: 'ok',
      detail: `Python 3.12.4 at ${MOCK_SETTINGS.pythonPath}`,
      action: null
    },
    {
      id: 'faster-whisper',
      label: 'Transcription engine',
      status: 'ok',
      detail: 'faster-whisper 1.0.3 imports correctly.',
      action: null
    },
    {
      id: 'whisper-model',
      label: 'Whisper model',
      status: modelsPresent.length > 0 ? 'ok' : 'missing',
      detail:
        modelsPresent.length > 0
          ? `Downloaded: ${modelsPresent.join(', ')}`
          : 'No model downloaded yet. Transcription cannot start without one.',
      action: modelsPresent.length > 0 ? null : 'Download a Whisper model in Settings → Models.'
    },
    {
      id: 'ollama',
      label: 'Local LLM',
      status: 'warn',
      detail: 'Ollama is reachable but the selected model has not been pulled yet.',
      action: 'Run `ollama pull llama3.1:8b` for summaries and answers.'
    },
    {
      id: 'disk',
      label: 'Disk space',
      status: 'ok',
      detail: '42.6 GB free where meetings are stored.',
      action: null
    }
  ]
}

function createMockApi(): LocalNoteApi {
  const now = Date.now()
  const meetings = buildMeetings(now)
  const segments = buildSegments(meetings)
  const actionItems = buildActionItems(meetings)
  const dictionary = [...MOCK_DICTIONARY]
  const voiceProfiles = [...MOCK_VOICE_PROFILES]
  let settings: AppSettings = { ...MOCK_SETTINGS }
  let models = MOCK_MODELS.map((m) => ({ ...m }))
  const speakerNames = [...MOCK_SPEAKER_NAMES]

  const listeners = new Set<(event: MainEvent) => void>()
  const emit = (event: MainEvent): void => {
    for (const listener of Array.from(listeners)) {
      try {
        listener(event)
      } catch (error) {
        console.error('[Local Note mock] event listener threw', error)
      }
    }
  }

  let session: SessionState = {
    active: false,
    meetingId: null,
    title: '',
    startedAt: null,
    elapsedMs: 0,
    levels: { system: null, mic: null },
    error: null,
    warnings: [],
    queueDepth: 0,
    backlogSeconds: 0
  }

  let targets: { system: boolean; mic: boolean } = { system: true, mic: true }
  let ticker: number | null = null
  let captureTimer: number | null = null
  let liveLineIndex = 0
  let liveSegmentCount = 0
  let warnedSilentMic = false
  const rms: Record<StreamKind, number> = { system: 0.35, mic: 0.28 }
  const deviceNames: Record<StreamKind, string> = {
    system: 'Speakers (Realtek(R) Audio)',
    mic: 'Microphone Array (Intel Smart Sound)'
  }

  const findMeeting = (id: string): Meeting | null => meetings.find((m) => m.id === id) ?? null

  const meetingDetail = (id: string): MeetingDetail | null => {
    const meeting = findMeeting(id)
    if (!meeting) return null
    return {
      meeting,
      segments: segments.filter((s) => s.meetingId === id).sort((a, b) => a.startMs - b.startMs),
      actionItems: actionItems
        .filter((a) => a.meetingId === id)
        .sort((a, b) => a.position - b.position),
      speakers: speakerNames.filter((s) => s.meetingId === id)
    }
  }

  const stopTicker = (): void => {
    if (ticker != null) {
      window.clearInterval(ticker)
      ticker = null
    }
    if (captureTimer != null) {
      window.clearInterval(captureTimer)
      captureTimer = null
    }
  }

  const pushSession = (): void => {
    emit({ type: 'session', state: session })
  }

  const buildLevel = (stream: StreamKind, captured: boolean): StreamLevel | null => {
    if (!captured) return null
    const drift = (Math.random() - 0.45) * 0.3
    rms[stream] = clamp01(rms[stream] * 0.65 + (stream === 'system' ? 0.32 : 0.22) + drift)
    const dead = session.elapsedMs < 2500
    return {
      stream,
      ms: Math.round(session.elapsedMs),
      capturedMs: Math.round(session.elapsedMs * 0.98),
      realMs: Math.round(session.elapsedMs * 0.98),
      paddedMs: Math.round(session.elapsedMs * 0.02),
      packets: Math.round(session.elapsedMs / 20),
      rms: dead ? 0 : Math.round(rms[stream] * 1000) / 1000,
      dead,
      deviceName: deviceNames[stream]
    }
  }

  const startTicker = (): void => {
    stopTicker()
    ticker = window.setInterval(() => {
      if (!session.active) return
      const step = 500 + Math.round((Math.random() - 0.5) * 120)
      session = {
        ...session,
        elapsedMs: session.elapsedMs + step,
        levels: {
          system: buildLevel('system', targets.system),
          mic: buildLevel('mic', targets.mic)
        },
        queueDepth: Math.max(0, Math.round((Math.random() - 0.35) * 4)),
        backlogSeconds: Math.max(0, Math.round((Math.random() - 0.3) * 26) / 2)
      }
      if (
        session.levels.mic != null &&
        session.levels.mic.rms < 0.02 &&
        session.elapsedMs > 6000 &&
        !warnedSilentMic
      ) {
        warnedSilentMic = true
        session = {
          ...session,
          warnings: [
            ...session.warnings,
            'The microphone buffer looks silent. Check the input device in Windows sound settings, or switch it off if you only need system audio.'
          ]
        }
      }
      pushSession()
    }, 500)

    captureTimer = window.setInterval(() => {
      if (!session.active || !session.meetingId) return
      const line = MOCK_LIVE_LINES[liveLineIndex % MOCK_LIVE_LINES.length]
      liveLineIndex += 1
      liveSegmentCount += 1
      const startMs = Math.max(0, session.elapsedMs - 4200)
      const segment: LiveSegment = {
        id: `${session.meetingId}-live-${liveSegmentCount}`,
        meetingId: session.meetingId,
        speakerLabel: line.source === 'mic' ? 'You' : 'Speaker 1',
        source: line.source,
        startMs,
        endMs: startMs + 3600,
        text: line.text,
        confidence: 0.9,
        corrected: false,
        provisional: true
      }
      segments.push(segment)
      emit({ type: 'segment', segment })
      if (liveSegmentCount % 4 === 0) {
        const meeting = findMeeting(session.meetingId)
        if (meeting) meeting.segmentCount = meeting.segmentCount + 4
        emit({ type: 'segments-updated', meetingId: session.meetingId })
      }
    }, 4200)
  }

  const mockSearch = (opts: SearchOptions): SearchHit[] => {
    const query = opts.query.trim()
    if (query.length === 0) return []
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length >= 2)
    const interest = terms.length > 0 ? terms : [query.toLowerCase()]
    const since =
      opts.sinceDays != null && opts.sinceDays > 0 ? Date.now() - opts.sinceDays * DAY_MS : null
    const keywordOn = opts.keyword !== false
    const semanticOn = opts.semantic === true
    const hits: SearchHit[] = []

    if (keywordOn) {
      for (const segment of segments) {
        const meeting = findMeeting(segment.meetingId)
        if (!meeting) continue
        if (since != null && meeting.startedAt < since) continue
        const haystack = segment.text.toLowerCase()
        const matched = interest.filter((term) => haystack.includes(term))
        if (matched.length === 0) continue
        hits.push({
          meetingId: meeting.id,
          meetingTitle: meeting.title,
          startedAt: meeting.startedAt,
          segmentId: segment.id,
          snippet: segment.text,
          startMs: segment.startMs,
          speakerLabel: segment.speakerLabel,
          score: matched.length * 2 + (haystack.split(interest[0]).length - 1) * 0.5,
          via: 'keyword'
        })
      }
    }

    if (semanticOn && hits.length < 4) {
      // Pretend the embedding index surfaced a couple of paraphrases, taken
      // from roughly a third of the way into each meeting so the timeline rail
      // has something meaningful to show.
      const candidates = meetings.slice(0, 2)
      candidates.forEach((meeting, index) => {
        const meetingSegments = segments.filter((s) => s.meetingId === meeting.id)
        if (meetingSegments.length === 0) return
        const segment = meetingSegments[Math.floor(meetingSegments.length * 0.35)] ?? meetingSegments[0]
        hits.push({
          meetingId: meeting.id,
          meetingTitle: meeting.title,
          startedAt: meeting.startedAt,
          segmentId: segment.id,
          snippet: `…${segment.text} (matched semantically, not by exact words)`,
          startMs: segment.startMs,
          speakerLabel: segment.speakerLabel,
          score: 1.2 - index * 0.1,
          via: 'semantic'
        })
      })
    }

    return hits
      .sort((a, b) => b.score - a.score || b.startedAt - a.startedAt)
      .slice(0, Math.max(1, Math.min(opts.limit ?? 40, 200)))
  }

  return {
    async getSettings() {
      await delay(90)
      return { ...settings }
    },
    async updateSettings(patch) {
      await delay(80)
      settings = { ...settings, ...patch }
      return { ...settings }
    },
    async getPaths() {
      await delay(40)
      return { ...MOCK_PATHS }
    },
    async getStatus() {
      await delay(140)
      return mockStatus(models)
    },
    async refreshStatus() {
      await delay(520)
      const status = mockStatus(models)
      emit({ type: 'status', status })
      return status
    },
    async runSetupChecks() {
      await delay(680)
      return mockSetupChecks(models)
    },

    async listMeetings() {
      await delay(180)
      return meetings
        .map((m) => ({ ...m }))
        .sort((a, b) => b.startedAt - a.startedAt)
    },
    async getMeeting(id) {
      await delay(160)
      return meetingDetail(id)
    },
    async updateMeeting(id, patch) {
      await delay(90)
      const meeting = findMeeting(id)
      if (!meeting) throw new Error(`No meeting with id ${id}`)
      if (patch.title != null) meeting.title = patch.title
      if (patch.briefNotes !== undefined) meeting.briefNotes = patch.briefNotes
      emit({ type: 'segments-updated', meetingId: id })
      return { ...meeting }
    },
    async deleteMeeting(id) {
      await delay(220)
      const index = meetings.findIndex((m) => m.id === id)
      if (index >= 0) meetings.splice(index, 1)
      for (let i = segments.length - 1; i >= 0; i -= 1) {
        if (segments[i].meetingId === id) segments.splice(i, 1)
      }
      for (let i = actionItems.length - 1; i >= 0; i -= 1) {
        if (actionItems[i].meetingId === id) actionItems.splice(i, 1)
      }
      emit({ type: 'toast', level: 'info', message: 'Meeting deleted.' })
    },
    async exportMeeting(id, format) {
      await delay(320)
      const meeting = findMeeting(id)
      if (!meeting) return null
      const slug = meeting.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
      return `${DATA_DIR}\\exports\\${slug}.${format}`
    },
    async revealMeetingAudio(id) {
      await delay(120)
      const meeting = findMeeting(id)
      if (!meeting?.audioPath) {
        emit({ type: 'toast', level: 'warn', message: 'That meeting has no audio on disk.' })
      }
    },

    async getSpeakerNames(meetingId) {
      await delay(60)
      return speakerNames.filter((s) => s.meetingId === meetingId)
    },
    async renameSpeaker(meetingId, label, displayName) {
      await delay(70)
      const existing = speakerNames.find(
        (s) => s.meetingId === meetingId && s.speakerLabel === label
      )
      const trimmed = displayName.trim()
      if (existing) {
        if (trimmed.length === 0) {
          speakerNames.splice(speakerNames.indexOf(existing), 1)
        } else {
          existing.displayName = trimmed
        }
      } else if (trimmed.length > 0) {
        speakerNames.push({ meetingId, speakerLabel: label, displayName: trimmed })
      }
      emit({ type: 'segments-updated', meetingId })
    },
    async listVoiceProfiles() {
      await delay(120)
      return voiceProfiles.map((v) => ({ ...v }))
    },
    async deleteVoiceProfile(id) {
      await delay(150)
      const index = voiceProfiles.findIndex((v) => v.id === id)
      if (index >= 0) voiceProfiles.splice(index, 1)
    },

    async startRecording(opts: StartRecordingOptions) {
      await delay(260)
      if (session.active) throw new Error('A recording is already running.')
      const startedAt = Date.now()
      const id = `mtg-${String(2000 + meetings.length)}`
      const targetsIn: { system: boolean; mic: boolean } = {
        system: opts.targets?.system ?? true,
        mic: opts.targets?.mic ?? settings.captureMic
      }
      const meeting: Meeting = {
        id,
        title: opts.title?.trim() || `Meeting — ${new Date(startedAt).toLocaleString()}`,
        startedAt,
        endedAt: null,
        audioPath: null,
        durationMs: null,
        summary: null,
        briefNotes: opts.briefNotes?.trim() ? opts.briefNotes : null,
        briefDocs: opts.briefDocs?.join('\n') ?? null,
        briefSummary: null,
        summarizedAt: null,
        summaryStatus: 'pending',
        summaryError: null,
        segmentCount: 0,
        actionItemCount: 0
      }
      meetings.push(meeting)
      targets = targetsIn
      warnedSilentMic = false
      liveLineIndex = 0
      liveSegmentCount = 0
      session = {
        active: true,
        meetingId: id,
        title: meeting.title,
        startedAt,
        elapsedMs: 0,
        levels: { system: null, mic: null },
        error: null,
        warnings:
          targetsIn.mic || targetsIn.system
            ? []
            : ['No audio streams are enabled, so nothing will be captured.'],
        queueDepth: 0,
        backlogSeconds: 0
      }
      startTicker()
      pushSession()
      emit({ type: 'navigate', view: 'live', meetingId: id })
      const parts: string[] = []
      if (targetsIn.system) parts.push('system audio')
      if (targetsIn.mic) parts.push('microphone')
      emit({
        type: 'toast',
        level: 'info',
        message: `Recording started (mock). Capturing ${parts.length > 0 ? parts.join(' + ') : 'nothing'}.`
      })
      return { meetingId: id }
    },
    async stopRecording() {
      await delay(320)
      if (!session.active || !session.meetingId) throw new Error('Nothing is recording.')
      const id = session.meetingId
      const meeting = findMeeting(id)
      const elapsed = session.elapsedMs
      stopTicker()
      session = {
        ...session,
        active: false,
        levels: { system: null, mic: null },
        warnings: [],
        queueDepth: 0,
        backlogSeconds: 0
      }
      pushSession()
      if (meeting) {
        meeting.endedAt = Date.now()
        meeting.durationMs = elapsed
        meeting.audioPath = settings.keepAudio ? `${MOCK_PATHS.audioDir}\\${id}\\system\\full.wav` : null
        meeting.segmentCount = segments.filter((s) => s.meetingId === id).length
        meeting.summarizedAt = null
        meeting.summaryStatus = 'pending'
      }
      emit({ type: 'segments-updated', meetingId: id })

      // Simulate the local post-processing pipeline so the UI can be exercised.
      window.setTimeout(() => {
        emit({ type: 'busy', label: 'Summarising transcript…', progress: 0.35 })
      }, 400)
      window.setTimeout(() => {
        emit({ type: 'busy', label: 'Extracting action items…', progress: 0.75 })
      }, 1600)
      window.setTimeout(() => {
        const target = findMeeting(id)
        if (target) {
          target.summary =
            'Mock summary: the conversation covered capture reliability, transcription latency, and what happens to audio after the meeting. Two follow-ups were agreed: one owner will measure the backlog under load, and another will draft the settings copy for audio retention.'
          target.summaryStatus = 'ok'
          target.summarizedAt = Date.now()
        }
        if (target) {
          actionItems.push(
            {
              id: `${id}-act-0`,
              meetingId: id,
              text: 'Measure transcription backlog under a long meeting',
              assignee: 'Marcus',
              done: false,
              position: 0
            },
            {
              id: `${id}-act-1`,
              meetingId: id,
              text: 'Draft the audio-retention copy for Settings',
              assignee: 'Priya',
              done: false,
              position: 1
            },
            {
              id: `${id}-act-2`,
              meetingId: id,
              text: 'Confirm every store record keeps meeting_id',
              assignee: null,
              done: true,
              position: 2
            }
          )
          target.actionItemCount = 3
        }
        emit({ type: 'busy', label: null, progress: null })
        emit({ type: 'summary', meetingId: id, status: 'ok', summary: target?.summary ?? '' })
        emit({ type: 'action-items', meetingId: id })
        emit({
          type: 'toast',
          level: 'info',
          message: 'Summary and action items are ready.'
        })
      }, 3200)
      return { meetingId: id }
    },
    async getSession() {
      await delay(50)
      return { ...session, levels: { ...session.levels } }
    },
    async discardSession() {
      await delay(220)
      if (session.meetingId) {
        const id = session.meetingId
        const index = meetings.findIndex((m) => m.id === id)
        if (index >= 0) meetings.splice(index, 1)
        for (let i = segments.length - 1; i >= 0; i -= 1) {
          if (segments[i].meetingId === id) segments.splice(i, 1)
        }
      }
      stopTicker()
      session = {
        active: false,
        meetingId: null,
        title: '',
        startedAt: null,
        elapsedMs: 0,
        levels: { system: null, mic: null },
        error: null,
        warnings: [],
        queueDepth: 0,
        backlogSeconds: 0
      }
      pushSession()
    },

    async setBrief(meetingId, notes, docs) {
      await delay(160)
      const meeting = findMeeting(meetingId)
      if (!meeting) throw new Error(`No meeting with id ${meetingId}`)
      meeting.briefNotes = notes.trim().length > 0 ? notes : null
      meeting.briefDocs = docs.length > 0 ? docs.join('\n') : null
      return { ...meeting }
    },
    async attachBriefDocs() {
      await delay(300)
      return [`${MOCK_PATHS.briefDocsDir}\\northwind-agenda.md`]
    },
    async importIcs(): Promise<IcsImport | null> {
      await delay(420)
      return {
        title: 'Northwind renewal — terms review',
        startedAt: Date.now() + HOUR_MS,
        endedAt: Date.now() + 2 * HOUR_MS,
        attendees: ['Priya Raghavan', 'Marcus Feld', 'Dana Whitfield'],
        description: 'Renewal terms, data residency, and offline deployment questions.',
        location: 'Teams'
      }
    },
    async generateBrief(meetingId) {
      await delay(900)
      const meeting = findMeeting(meetingId)
      if (!meeting) throw new Error(`No meeting with id ${meetingId}`)
      meeting.briefSummary =
        'Brief summarised locally: three attendees, one agenda document, and a data-residency question to raise early.'
      return meeting.briefSummary
    },

    async whatDidIMiss(minutes) {
      await delay(700)
      const window = minutes ?? settings.missedWindowMinutes
      const recent = segments
        .filter((s) => session.meetingId != null && s.meetingId === session.meetingId)
        .slice(-6)
      if (recent.length === 0) {
        return `Nothing has been transcribed in the last ${window} minutes yet — the queue is still catching up.`
      }
      return [
        `In the last ${window} minutes the conversation covered:`,
        ...recent.map((s) => `• ${s.speakerLabel ?? 'Someone'}: ${s.text}`),
        'No decisions were recorded, and no action items were created.'
      ].join('\n')
    },
    async generateSummary(meetingId) {
      await delay(1200)
      const meeting = findMeeting(meetingId)
      if (!meeting) throw new Error(`No meeting with id ${meetingId}`)
      meeting.summary =
        'Mock summary: the meeting established what will ship next, who owns each follow-up, and what stays explicitly out of scope. The transcript is the record; this summary is a convenience.'
      meeting.summaryStatus = 'ok'
      meeting.summarizedAt = Date.now()
      emit({ type: 'summary', meetingId, status: 'ok', summary: meeting.summary })
      return { ...meeting }
    },
    async askAboutMeeting(meetingId, question) {
      await delay(950)
      const meeting = findMeeting(meetingId)
      if (!meeting) throw new Error(`No meeting with id ${meetingId}`)
      return `Mock answer for “${question}”: in “${meeting.title}” the group agreed to keep everything local, surface transcription lag instead of hiding it, and let every action item be edited in place. (Browser mock — no model was actually run.)`
    },
    async regenerateActionItems(meetingId) {
      await delay(1100)
      const target = meetingDetail(meetingId)
      if (!target) throw new Error(`No meeting with id ${meetingId}`)
      emit({ type: 'action-items', meetingId })
      return target.actionItems
    },
    async addActionItem(meetingId, text, assignee) {
      await delay(120)
      const existing = actionItems.filter((a) => a.meetingId === meetingId)
      const item: ActionItem = {
        id: `${meetingId}-act-${existing.length}-${Date.now() % 1000}`,
        meetingId,
        text,
        assignee,
        done: false,
        position: existing.length
      }
      actionItems.push(item)
      const meeting = findMeeting(meetingId)
      if (meeting) meeting.actionItemCount = existing.length + 1
      emit({ type: 'action-items', meetingId })
      return item
    },
    async updateActionItem(id, patch) {
      await delay(80)
      const item = actionItems.find((a) => a.id === id)
      if (!item) throw new Error('That action item no longer exists.')
      if (patch.text !== undefined) item.text = patch.text
      if (patch.assignee !== undefined) item.assignee = patch.assignee
      if (patch.done !== undefined) item.done = patch.done
      emit({ type: 'action-items', meetingId: item.meetingId })
    },
    async deleteActionItem(id) {
      await delay(90)
      const index = actionItems.findIndex((a) => a.id === id)
      if (index >= 0) {
        const [removed] = actionItems.splice(index, 1)
        const meeting = findMeeting(removed.meetingId)
        if (meeting) meeting.actionItemCount = actionItems.filter((a) => a.meetingId === removed.meetingId).length
        emit({ type: 'action-items', meetingId: removed.meetingId })
      }
    },

    async search(opts) {
      await delay(340)
      return mockSearch(opts)
    },
    async askAcrossMeetings(question, meetingIds) {
      await delay(1300)
      const scope = meetingIds && meetingIds.length > 0
        ? meetings.filter((m) => meetingIds.includes(m.id))
        : meetings.slice(0, 3)
      const citations = scope.slice(0, 3).flatMap((meeting) => {
        const segment = segments.find((s) => s.meetingId === meeting.id)
        if (!segment) return []
        return [
          {
            meetingId: meeting.id,
            meetingTitle: meeting.title,
            segmentId: segment.id,
            startMs: segment.startMs,
            text: segment.text
          }
        ]
      })
      return {
        answer: `Mock answer for “${question}”: across ${scope.length} meeting${
          scope.length === 1 ? '' : 's'
        } the recurring themes are local-only storage, keeping the transcript as the source of truth, and making corrections cheap. Citations below point at the exact lines. (Browser mock — no model was actually run.)`,
        citations,
        usedModel: settings.ollamaModel ?? 'none',
        degraded: false
      } satisfies RagAnswer
    },
    async reindexSearch() {
      const total = segments.length
      for (let step = 1; step <= 4; step += 1) {
        await delay(240)
        emit({
          type: 'busy',
          label: `Embedding transcripts… ${Math.round((step / 4) * 100)}%`,
          progress: step / 4
        })
      }
      emit({ type: 'busy', label: null, progress: null })
      return { embedded: total, total }
    },

    async listDictionary() {
      await delay(140)
      return dictionary.map((t) => ({ ...t }))
    },
    async addDictionaryTerm(term, replacement, notes) {
      await delay(140)
      const clean = term.trim()
      if (clean.length === 0) throw new Error('A term cannot be empty.')
      if (dictionary.some((t) => t.term.toLowerCase() === clean.toLowerCase())) {
        throw new Error(`“${clean}” is already in the dictionary.`)
      }
      const created: DictionaryTerm = {
        id: `dict-${Date.now()}`,
        term: clean,
        replacement: replacement?.trim() ? replacement.trim() : null,
        notes: notes?.trim() ? notes.trim() : null,
        createdAt: Date.now(),
        hitCount: 0
      }
      dictionary.push(created)
      return { ...created }
    },
    async updateDictionaryTerm(id, patch) {
      await delay(120)
      const term = dictionary.find((t) => t.id === id)
      if (!term) throw new Error('That term no longer exists.')
      if (patch.term !== undefined) {
        const clean = patch.term.trim()
        if (clean.length === 0) throw new Error('A term cannot be empty.')
        if (dictionary.some((t) => t.id !== id && t.term.toLowerCase() === clean.toLowerCase())) {
          throw new Error(`“${clean}” is already in the dictionary.`)
        }
        term.term = clean
      }
      if (patch.replacement !== undefined) {
        term.replacement = patch.replacement?.trim() ? patch.replacement.trim() : null
      }
      if (patch.notes !== undefined) {
        term.notes = patch.notes?.trim() ? patch.notes.trim() : null
      }
      return { ...term }
    },
    async deleteDictionaryTerm(id) {
      await delay(120)
      const index = dictionary.findIndex((t) => t.id === id)
      if (index >= 0) dictionary.splice(index, 1)
    },

    async listWhisperModels() {
      await delay(260)
      return models.map((m) => ({ ...m }))
    },
    async downloadWhisperModel(id) {
      await delay(400)
      const model = models.find((m) => m.id === id)
      if (!model) return { ok: false, message: `Unknown model “${id}”.` }
      emit({ type: 'busy', label: `Downloading ${model.label}…`, progress: 0.15 })
      for (let step = 1; step <= 4; step += 1) {
        await delay(420)
        emit({
          type: 'busy',
          label: `Downloading ${model.label}… ${Math.round((step / 4) * 100)}%`,
          progress: step / 4
        })
      }
      models = models.map((m) => (m.id === id ? { ...m, downloaded: true } : m))
      emit({ type: 'busy', label: null, progress: null })
      const status = mockStatus(models)
      emit({ type: 'status', status })
      return { ok: true, message: `${model.label} downloaded (mock — no bytes were transferred).` }
    },
    async deleteWhisperModel(id) {
      await delay(220)
      models = models.map((m) => (m.id === id ? { ...m, downloaded: false } : m))
    },
    async compileRecorder() {
      await delay(1400)
      return {
        ok: true,
        message:
          'Recorder rebuilt with csc.exe in 218 ms (mock). C:\\Local Note\\build\\WasapiRecorder.exe'
      }
    },
    async transcribeAudioFile() {
      await delay(600)
      return null
    },

    async openDataDir() {
      await delay(80)
      emit({ type: 'toast', level: 'info', message: `Mock: would open ${MOCK_PATHS.dataDir}` })
    },
    async openLogs() {
      await delay(80)
      emit({ type: 'toast', level: 'info', message: `Mock: would open ${MOCK_PATHS.logsDir}` })
    },
    async getLogTail(lines) {
      await delay(260)
      return mockLogTail(lines ?? 200)
    },

    async getCaptureBarStatus() {
      await delay(80)
      return {
        enabled: MOCK_SETTINGS.captureBarEnabled,
        hideWhenIdle: MOCK_SETTINGS.captureBarHideWhenIdle,
        hotkey: MOCK_SETTINGS.captureHotkey,
        hotkeyRegistered: true
      }
    },
    async resetCaptureBarPosition() {
      await delay(80)
      MOCK_SETTINGS.captureBarPosition = null
    },
    async openHub() {
      await delay(60)
      emit({ type: 'toast', level: 'info', message: 'Mock: would focus the Hub window' })
    },

    onEvent(callback) {
      listeners.add(callback)
      return () => {
        listeners.delete(callback)
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Resolution                                                          */
/* ------------------------------------------------------------------ */

function resolveApi(): LocalNoteApi {
  const injected = window.localNote
  if (injected) return injected

  console.warn(
    '%c Local Note %c renderer running in browser-mock mode ',
    'background:#ffab3d;color:#0b1118;font-weight:600',
    'background:#141d27;color:#e9edf3',
    '\nNo `window.localNote` bridge was found, so every call is served by an in-memory mock.' +
      '\nNothing is recorded, nothing is uploaded, and no model is run.' +
      '\nStart the app with `npm run dev` to use the real Electron bridge.'
  )
  return createMockApi()
}

export const api: LocalNoteApi = resolveApi()

/** True when the UI is running against the in-memory mock instead of Electron. */
export const isMockApi: boolean = window.localNote == null
