import { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, shell } from 'electron'
import { existsSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'

import { CHANNELS, INVOKE_METHODS, type InvokeMethod } from '../shared/api'
import type {
  ActionItem,
  AppSettings,
  BackendStatus,
  DictionaryTerm,
  MainEvent,
  Meeting,
  RagAnswer,
  SearchHit,
  SearchOptions,
  SessionState,
  SetupCheck,
  StartRecordingOptions
} from '../shared/types'

import { createLogger, ensureLogFile, logStartupBanner, tailLog } from './lib/log'
import { getPaths } from './lib/paths'
import { closeDb, getDb } from './db'
import { getSettings, updateSettings } from './db/settings'
import {
  addActionItem,
  deleteActionItem,
  deleteMeeting,
  deleteVoiceProfile,
  getMeeting,
  getSpeakerNames,
  listActionItems,
  listMeetings,
  listSegments,
  listVoiceProfiles,
  replaceActionItems,
  setSpeakerName,
  updateActionItem,
  updateMeetingFields
} from './db/meetings'
import {
  addDictionaryTerm as addTermRow,
  deleteDictionaryTerm as deleteTermRow,
  listDictionary,
  updateDictionaryTerm as updateTermRow
} from './db/dictionary'
import { retrieveContext, search as runSearch, type SearchDeps } from './db/search'
import { invalidateEmbeddingCache, segmentsMissingEmbeddings, upsertEmbeddings } from './db/embeddings'
import { indexMissingEmbeddings, resolveEmbedder, type Embedder } from './llm/embed'
import { OllamaClient, pickSummaryModel } from './llm/ollama'
import {
  answerAboutMeeting,
  answerAcrossMeetings,
  generateBrief,
  summarizeMeeting
} from './llm/summarize'
import { Recorder } from './audio/recorder'
import { ensureRecorderBuilt } from './audio/recorder-build'
import { SessionManager } from './audio/session'
import { Sidecar } from './stt/sidecar'
import { documentsToContext, extractDocument, importBriefDocument } from './brief/documents'
import { readIcsFile } from './brief/ics'

const log = createLogger('main')

/* ------------------------------------------------------------------ */
/* Storage location                                                    */
/* ------------------------------------------------------------------ */

/**
 * Relocate Electron's own storage before anything else runs.
 *
 * `app.getPath('userData')` is where Chromium keeps its Cache, GPUCache,
 * Local Storage, Session Storage and network state. It defaults to
 * %APPDATA%\<productName> on the system drive, which ignores the app's own
 * data-directory setting entirely.
 *
 * Pointing it at the resolved data directory means every byte the app writes —
 * Chromium's caches as well as meetings, audio and models — lives under one
 * folder that the user chose. This must happen before the app is ready.
 */
try {
  const resolved = getPaths().dataDir
  if (app.getPath('userData') !== resolved) {
    app.setPath('userData', resolved)
  }
} catch (error) {
  // Never fatal: falling back to the default location is better than not starting.
  log.warn('could not relocate Electron storage; using the default location', error)
}

/* ------------------------------------------------------------------ */
/* Shared services                                                     */
/* ------------------------------------------------------------------ */

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let session: SessionManager | null = null
let sidecar: Sidecar | null = null
let ollama: OllamaClient | null = null
let quitting = false
/** Guards the one-shot async cleanup in `before-quit`. */
let cleanupComplete = false

const isDev = !app.isPackaged
/**
 * The renderer is only loaded from the Vite dev server when the dev launcher
 * explicitly asks for it. Relying on `isDev` alone would make `npm start` (which
 * runs a production build) try to reach a dev server that is not running.
 */
const devOrigin: string | null =
  isDev && process.env.LOCALNOTE_DEV_URL ? process.env.LOCALNOTE_DEV_URL : null

function emit(event: MainEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(CHANNELS.event, event)
  }
}

function toast(level: 'info' | 'warn' | 'error', message: string): void {
  emit({ type: 'toast', level, message })
}

/* ------------------------------------------------------------------ */
/* Offline enforcement                                                 */
/* ------------------------------------------------------------------ */

/**
 * Blocks every network request the renderer could make, except its own local
 * UI assets.
 *
 * This is a structural guarantee rather than a promise in the README: even if a
 * future change introduced a remote font, CDN import or analytics call, it
 * would be blocked here and logged. The app's only outbound traffic ever is the
 * explicit, user-initiated model downloads in the main process.
 */
function installOfflineGuard(): void {
  // In development the renderer is served by Vite, which also needs its HMR
  // websocket. Only that exact origin is allowed through.
  const guard = (details: { url: string }, callback: (response: { cancel: boolean }) => void): void => {
    const url = details.url
    const isLocalAsset =
      url.startsWith('file://') ||
      url.startsWith('devtools://') ||
      url.startsWith('blob:') ||
      url.startsWith('data:') ||
      (devOrigin !== null &&
        (url.startsWith(devOrigin) ||
          // Vite's HMR socket, e.g. ws://localhost:5273/?token=...
          url.startsWith(devOrigin.replace(/^http/, 'ws'))))

    if (isLocalAsset) {
      callback({ cancel: false })
      return
    }

    log.warn(`blocked outbound request from the app UI: ${url}`)
    callback({ cancel: true })
  }

  app.on('web-contents-created', (_event, contents) => {
    contents.session.webRequest.onBeforeRequest(guard)

    // Nothing in the UI should ever open a new window or navigate away.
    contents.setWindowOpenHandler(({ url }) => {
      log.warn(`blocked window.open to ${url}`)
      return { action: 'deny' }
    })

    contents.on('will-navigate', (event, url) => {
      const allowedNavigation = devOrigin !== null && url.startsWith(devOrigin)
      if (!url.startsWith('file://') && !allowedNavigation) {
        event.preventDefault()
        log.warn(`blocked navigation to ${url}`)
      }
    })
  })
}

/* ------------------------------------------------------------------ */
/* Window + tray                                                       */
/* ------------------------------------------------------------------ */

async function createWindow(): Promise<void> {
  const iconPath = join(app.getAppPath(), 'assets', 'icon.png')

  mainWindow = new BrowserWindow({
    width: 1240,
    height: 840,
    minWidth: 940,
    minHeight: 620,
    show: false,
    backgroundColor: '#0b1118',
    title: 'Local Note',
    icon: existsSync(iconPath) ? iconPath : undefined,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  if (devOrigin !== null) {
    await mainWindow.loadURL(devOrigin)
  } else {
    await mainWindow.loadFile(join(app.getAppPath(), 'dist', 'index.html'))
  }

  // Closing the window during a recording would silently end the meeting.
  mainWindow.on('close', (event) => {
    if (!quitting && session?.isActive) {
      const choice = dialog.showMessageBoxSync(mainWindow!, {
        type: 'warning',
        buttons: ['Keep recording', 'Stop and close'],
        defaultId: 0,
        cancelId: 0,
        title: 'A recording is in progress',
        message: 'Local Note is still recording this meeting.',
        detail: 'Closing now will stop the recording and finish saving the transcript.'
      })

      if (choice === 0) {
        event.preventDefault()
        return
      }

      void session?.stop().catch((error) => log.error('failed to stop session on close', error))
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

/**
 * Tray icon that changes appearance while recording.
 *
 * The spec calls for the recording state to be unmistakable; an always-visible
 * tray indicator means the user can see it even when the window is behind
 * whatever call app they are using.
 */
function createTray(): void {
  const assets = join(app.getAppPath(), 'assets')
  const idlePath = join(assets, 'tray.png')
  const recordingPath = join(assets, 'tray-recording.png')
  if (!existsSync(idlePath)) return

  const idleImage = nativeImage.createFromPath(idlePath)
  const recordingImage = existsSync(recordingPath)
    ? nativeImage.createFromPath(recordingPath)
    : idleImage

  tray = new Tray(idleImage.resize({ width: 16, height: 16 }))
  tray.setToolTip('Local Note — idle')

  const menu = Menu.buildFromTemplate([
    {
      label: 'Open Local Note',
      click: () => {
        mainWindow?.show()
        mainWindow?.focus()
      }
    },
    { type: 'separator' },
    {
      label: 'Stop recording',
      click: () => {
        void session?.stop().catch((error) => log.error('tray stop failed', error))
      }
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        quitting = true
        app.quit()
      }
    }
  ])
  tray.setContextMenu(menu)

  tray.on('double-click', () => {
    mainWindow?.show()
    mainWindow?.focus()
  })

  // Keep the tray in sync with the recording state.
  session?.on('state', (state: SessionState) => {
    if (!tray || tray.isDestroyed()) return
    const image = state.active ? recordingImage : idleImage
    tray.setImage(image.resize({ width: 16, height: 16 }))
    tray.setToolTip(
      state.active
        ? `Local Note — RECORDING${state.title ? `: ${state.title}` : ''}`
        : 'Local Note — idle'
    )
  })
}

/* ------------------------------------------------------------------ */
/* Setup checks                                                        */
/* ------------------------------------------------------------------ */

async function runSetupChecks(): Promise<SetupCheck[]> {
  const checks: SetupCheck[] = []
  const paths = getPaths()

  // 1. Storage.
  try {
    getDb()
    checks.push({
      id: 'database',
      label: 'Local database',
      status: 'ok',
      detail: paths.dbPath,
      action: null
    })
  } catch (error) {
    checks.push({
      id: 'database',
      label: 'Local database',
      status: 'missing',
      detail: error instanceof Error ? error.message : String(error),
      action: `Check that ${paths.dataDir} is writable.`
    })
  }

  // 2. Native audio helper.
  const build = await ensureRecorderBuilt()
  checks.push({
    id: 'audio-helper',
    label: 'System audio capture helper',
    status: build.ok ? 'ok' : 'missing',
    detail: build.ok ? build.message : build.message.split('\n')[0],
    action: build.ok ? null : 'This needs the C# compiler bundled with Windows (csc.exe).'
  })

  // 3. Default audio devices.
  try {
    const devices = await Recorder.listDevices()
    checks.push({
      id: 'devices',
      label: 'Audio devices',
      status: devices.system ? 'ok' : 'warn',
      detail: `Output: ${devices.systemName ?? 'default device'} | Input: ${
        devices.micName ?? 'none detected'
      }`,
      action: devices.micName
        ? null
        : 'No microphone was detected. You can still record system audio, which covers online calls.'
    })
  } catch (error) {
    checks.push({
      id: 'devices',
      label: 'Audio devices',
      status: 'warn',
      detail: error instanceof Error ? error.message : String(error),
      action: 'Check that an audio output device is enabled in Windows.'
    })
  }

  // 4. Speech-to-text engine.
  if (sidecar) {
    const stt = await sidecar.statusSafe()
    checks.push({
      id: 'stt',
      label: 'Local speech recognition',
      status: stt.available ? (stt.modelsPresent.length > 0 ? 'ok' : 'warn') : 'missing',
      detail: stt.available
        ? stt.modelsPresent.length > 0
          ? `faster-whisper ${stt.version} · models: ${stt.modelsPresent.join(', ')}`
          : `faster-whisper ${stt.version} installed, but no speech model downloaded yet.`
        : (stt.error ?? 'Not installed.'),
      action: stt.available && stt.modelsPresent.length > 0 ? null : stt.guidance
    })
  }

  // 5. Local LLM.
  if (ollama) {
    const status = await ollama.listModels()
    checks.push({
      id: 'llm',
      label: 'Local language model (optional)',
      status: status === null ? 'warn' : status.length > 0 ? 'ok' : 'warn',
      detail:
        status === null
          ? 'Ollama is not running.'
          : status.length > 0
            ? `${status.length} model(s) available: ${status.map((m) => m.name).slice(0, 4).join(', ')}`
            : 'Ollama is running but has no models installed.',
      action:
        status === null
          ? 'Optional. Install from https://ollama.com/download, then run "ollama pull llama3.1:8b".'
          : status.length === 0
            ? 'Run "ollama pull llama3.1:8b" to enable summaries.'
            : null
    })
  }

  return checks
}

/* ------------------------------------------------------------------ */
/* Search plumbing                                                     */
/* ------------------------------------------------------------------ */

/** Builds an embedder for query-time embedding. */
async function buildEmbedder(): Promise<Embedder> {
  const settings = getSettings()
  let sidecarEmbeddingsAvailable = false
  let dim = 384

  try {
    const status = await sidecar!.status()
    sidecarEmbeddingsAvailable = status.embeddings.available
    dim = status.embeddings.dim
  } catch {
    /* sidecar offline */
  }

  const models = (await ollama!.listModels()) ?? []

  return resolveEmbedder({
    sidecar: sidecar!,
    client: ollama!,
    models,
    configuredEmbeddingModel: settings.embeddingModel,
    sidecarEmbeddingsAvailable,
    sidecarEmbeddingModel: 'all-MiniLM-L6-v2',
    sidecarEmbeddingDim: dim
  })
}

function semanticDeps(embedder: Embedder): SearchDeps {
  return {
    model: embedder.info.model,
    semantic: async (query, limit) => {
      const [vector] = await embedder.embed([query])
      if (!vector) return []
      const { searchByVector } = await import('./db/embeddings')
      return searchByVector(vector, embedder.info.model, limit)
    }
  }
}

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */

function buildExport(meetingId: string, format: 'md' | 'txt' | 'json'): string | null {
  const meeting = getMeeting(meetingId)
  if (!meeting) return null

  const segments = listSegments(meetingId)
  const items = listActionItems(meetingId)
  const names = getSpeakerNames(meetingId)
  const displayName = (label: string | null): string => {
    if (!label) return 'Speaker'
    return names.find((entry) => entry.speakerLabel === label)?.displayName ?? label
  }

  if (format === 'json') {
    return JSON.stringify({ meeting, segments, actionItems: items, speakers: names }, null, 2)
  }

  const clock = (ms: number): string => {
    const total = Math.max(0, Math.round(ms / 1000))
    const h = Math.floor(total / 3600)
    const m = Math.floor((total % 3600) / 60)
    const s = total % 60
    const pad = (value: number): string => String(value).padStart(2, '0')
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
  }

  const lines: string[] = []
  if (format === 'md') {
    lines.push(`# ${meeting.title}`, '')
    lines.push(`**Date:** ${new Date(meeting.startedAt).toLocaleString()}  `)
    if (meeting.durationMs) lines.push(`**Duration:** ${clock(meeting.durationMs)}  `)
    lines.push('')
    if (meeting.briefNotes) {
      lines.push('## Agenda / notes', '', meeting.briefNotes, '')
    }
    if (meeting.summary) {
      lines.push('## Summary', '', meeting.summary, '')
    }
    if (items.length > 0) {
      lines.push('## Action items', '')
      for (const item of items) {
        lines.push(`- [${item.done ? 'x' : ' '}] ${item.text}${item.assignee ? ` — **${item.assignee}**` : ''}`)
      }
      lines.push('')
    }
    lines.push('## Transcript', '')
    for (const segment of segments) {
      lines.push(`**${clock(segment.startMs)} · ${displayName(segment.speakerLabel)}:** ${segment.text}`)
      lines.push('')
    }
  } else {
    lines.push(meeting.title)
    lines.push(new Date(meeting.startedAt).toLocaleString())
    lines.push('')
    if (meeting.summary) {
      lines.push('SUMMARY')
      lines.push(meeting.summary)
      lines.push('')
    }
    if (items.length > 0) {
      lines.push('ACTION ITEMS')
      for (const item of items) {
        lines.push(`  [${item.done ? 'x' : ' '}] ${item.text}${item.assignee ? ` (${item.assignee})` : ''}`)
      }
      lines.push('')
    }
    lines.push('TRANSCRIPT')
    for (const segment of segments) {
      lines.push(`[${clock(segment.startMs)}] ${displayName(segment.speakerLabel)}: ${segment.text}`)
    }
  }

  return lines.join('\n')
}

function safeFileName(value: string): string {
  return value.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120) || 'meeting'
}

/* ------------------------------------------------------------------ */
/* Brief documents                                                     */
/* ------------------------------------------------------------------ */

interface BriefDocRecord {
  path: string
  name: string
  text: string
  failed: boolean
  note: string | null
}

function readBriefDocs(meeting: Meeting): BriefDocRecord[] {
  if (!meeting.briefDocs) return []
  try {
    const parsed: unknown = JSON.parse(meeting.briefDocs)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((entry): entry is BriefDocRecord => {
      return Boolean(entry) && typeof entry === 'object' && typeof (entry as BriefDocRecord).path === 'string'
    })
  } catch {
    return []
  }
}

/* ------------------------------------------------------------------ */
/* IPC handlers                                                        */
/* ------------------------------------------------------------------ */

type Handler = (args: unknown[]) => Promise<unknown> | unknown

const handlers: Record<InvokeMethod, Handler> = {
  /* ---------------- settings + health ---------------- */

  getSettings: () => getSettings(),

  updateSettings: (args) => {
    const patch = (args[0] ?? {}) as Partial<AppSettings>
    const next = updateSettings(patch)
    // The STT prompt is derived from settings, so refresh the live pipeline.
    if (session?.isActive) {
      session.setPromptContext?.(next)
    }
    return next
  },

  getPaths: () => getPaths(),

  getStatus: async (): Promise<BackendStatus> => {
    const settings = getSettings()
    const [stt, models] = await Promise.all([
      sidecar ? sidecar.statusSafe() : Promise.resolve(null),
      ollama ? ollama.listModels() : Promise.resolve(null)
    ])

    let diarization: BackendStatus['diarization'] = {
      available: false,
      engine: null,
      guidance: null
    }
    try {
      const status = await sidecar!.status()
      // The sidecar reports the engine as a plain string; narrow it to the
      // known set so an unexpected value cannot leak into the typed API.
      const engine = status.diarization.engine
      const knownEngine =
        engine === 'pyannote' || engine === 'speechbrain' || engine === 'stream' ? engine : null
      diarization = {
        available: status.diarization.available,
        engine: knownEngine,
        guidance: status.diarization.guidance
      }
    } catch {
      /* sidecar offline */
    }

    const llm = ollama
      ? await ollama.status(settings.ollamaModel, settings.embeddingModel, models)
      : {
          available: false,
          host: settings.ollamaHost,
          models: [],
          selectedModel: null,
          embeddingModel: null,
          error: null,
          guidance: 'Ollama is not available.'
        }

    return {
      stt:
        stt ??
        {
          engine: null,
          available: false,
          pythonPath: null,
          pythonVersion: null,
          version: null,
          modelsPresent: [],
          modelDir: getPaths().modelsDir,
          guidance: 'The local speech engine could not be queried.',
          error: null
        },
      llm: {
        ...llm,
        models: models ?? []
      },
      diarization
    }
  },

  refreshStatus: async () => {
    // Force re-discovery of the Python interpreter and model list.
    try {
      await sidecar?.shutdown()
    } catch {
      /* ignore */
    }
    sidecar = new Sidecar()
    return handlers.getStatus([]) as Promise<BackendStatus>
  },

  runSetupChecks: () => runSetupChecks(),

  /* ---------------- meetings ---------------- */

  listMeetings: () => listMeetings(),

  getMeeting: (args) => {
    const id = String(args[0])
    const meeting = getMeeting(id)
    if (!meeting) return null
    return {
      meeting,
      segments: listSegments(id),
      actionItems: listActionItems(id),
      speakers: getSpeakerNames(id)
    }
  },

  updateMeeting: (args) => {
    const [id, patch] = args as [string, Partial<Pick<Meeting, 'title' | 'briefNotes'>>]
    return updateMeetingFields(id, patch)
  },

  deleteMeeting: async (args) => {
    const id = String(args[0])
    const meeting = getMeeting(id)
    if (meeting?.audioPath) {
      try {
        await rm(meeting.audioPath, { recursive: true, force: true })
      } catch (error) {
        log.warn(`could not delete audio for ${id}`, error)
      }
    }
    deleteMeeting(id)
    invalidateEmbeddingCache()
    return true
  },

  exportMeeting: async (args) => {
    const [id, format] = args as [string, 'md' | 'txt' | 'json']
    const meeting = getMeeting(id)
    if (!meeting) throw new Error('Meeting not found.')

    const content = buildExport(id, format)
    if (content === null) throw new Error('Nothing to export.')

    const extension = format === 'md' ? 'md' : format === 'json' ? 'json' : 'txt'
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: 'Export meeting',
      defaultPath: join(app.getPath('documents'), `${safeFileName(meeting.title)}.${extension}`),
      filters: [{ name: format.toUpperCase(), extensions: [extension] }]
    })

    if (result.canceled || !result.filePath) return null
    writeFileSync(result.filePath, content, 'utf8')
    return result.filePath
  },

  revealMeetingAudio: (args) => {
    const meeting = getMeeting(String(args[0]))
    if (meeting?.audioPath && existsSync(meeting.audioPath)) {
      shell.showItemInFolder(meeting.audioPath)
    }
    return true
  },

  /* ---------------- speakers ---------------- */

  getSpeakerNames: (args) => getSpeakerNames(String(args[0])),

  renameSpeaker: (args) => {
    const [meetingId, label, displayName] = args as [string, string, string]
    const clean = displayName.trim()
    // Renaming to empty reverts to the generated label.
    if (clean.length === 0) {
      setSpeakerName(meetingId, label, label)
      return true
    }
    setSpeakerName(meetingId, label, clean)
    return true
  },

  listVoiceProfiles: () => listVoiceProfiles(),

  deleteVoiceProfile: (args) => {
    deleteVoiceProfile(String(args[0]))
    return true
  },

  /* ---------------- recording ---------------- */

  startRecording: async (args) => {
    const options = (args[0] ?? {}) as StartRecordingOptions
    return session!.start(options)
  },

  stopRecording: async () => session!.stop(),

  getSession: (): SessionState => session!.getState(),

  discardSession: async () => {
    await session!.discard()
    return true
  },

  /* ---------------- pre-meeting brief ---------------- */

  setBrief: async (args) => {
    const [meetingId, notes, docs] = args as [string, string, string[]]
    const records: BriefDocRecord[] = []

    for (const path of docs) {
      const extracted = await extractDocument(path)
      records.push({
        path,
        name: extracted.name,
        text: extracted.text,
        failed: extracted.failed,
        note: extracted.note
      })
    }

    const meeting = updateMeetingFields(meetingId, {
      briefNotes: notes,
      briefDocs: records.length > 0 ? JSON.stringify(records) : null
    })

    // Refresh the live STT biasing prompt with the new agenda/attendee names.
    session?.setPromptContext?.(getSettings(), notes)
    return meeting
  },

  attachBriefDocs: async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: 'Attach reference documents',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Documents', extensions: ['pdf', 'txt', 'md', 'csv', 'json'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    if (result.canceled) return []
    // Copy into the app's data folder so the brief survives the original moving.
    return result.filePaths.map((path) => importBriefDocument(path))
  },

  importIcs: async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: 'Import a calendar file',
      properties: ['openFile'],
      filters: [{ name: 'Calendar', extensions: ['ics'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return null

    const parsed = readIcsFile(result.filePaths[0])
    return {
      title: parsed.title,
      startedAt: parsed.startedAt,
      endedAt: parsed.endedAt,
      attendees: parsed.attendees,
      description: parsed.description,
      location: parsed.location
    }
  },

  generateBrief: async (args) => {
    const meetingId = String(args[0])
    const meeting = getMeeting(meetingId)
    if (!meeting) throw new Error('Meeting not found.')

    const docs = readBriefDocs(meeting)
    const settings = getSettings()
    const models = (await ollama!.listModels()) ?? []
    const model = pickSummaryModel(models, settings.ollamaModel)

    const brief = await generateBrief(
      { client: ollama!, model },
      {
        title: meeting.title,
        notes: meeting.briefNotes ?? '',
        documentText: documentsToContext(docs.map((doc) => ({ ...doc, path: doc.path }))),
        calendar: ''
      }
    )

    updateMeetingFields(meetingId, { briefSummary: brief })
    return brief
  },

  /* ---------------- live + summaries ---------------- */

  whatDidIMiss: (args) => session!.whatDidIMiss(args[0] as number | undefined),

  generateSummary: async (args) => {
    const meetingId = String(args[0])
    const meeting = getMeeting(meetingId)
    if (!meeting) throw new Error('Meeting not found.')

    const segments = listSegments(meetingId)
    if (segments.length === 0) {
      throw new Error('There is no transcript to summarise yet.')
    }

    const settings = getSettings()
    const models = (await ollama!.listModels()) ?? []
    const model = pickSummaryModel(models, settings.ollamaModel)

    emit({ type: 'busy', label: 'Generating summary…', progress: 0 })

    try {
      const result = await summarizeMeeting(
        {
          client: ollama!,
          model,
          onProgress: (update) => emit({ type: 'busy', label: update.label, progress: update.progress })
        },
        { segments, title: meeting.title, briefNotes: meeting.briefNotes }
      )

      const updated = updateMeetingFields(meetingId, {
        summary: result.summary,
        summarizedAt: Date.now(),
        summaryStatus: result.degraded ? 'skipped' : 'ok',
        summaryError: result.degraded ? 'Generated without a language model.' : null
      })

      if (result.actionItems.length > 0) {
        replaceActionItems(meetingId, result.actionItems)
        emit({ type: 'action-items', meetingId })
      }

      emit({
        type: 'summary',
        meetingId,
        status: result.degraded ? 'skipped' : 'ok',
        summary: result.summary
      })
      return updated
    } finally {
      emit({ type: 'busy', label: null, progress: null })
    }
  },

  askAboutMeeting: async (args) => {
    const [meetingId, question] = args as [string, string]
    const segments = listSegments(meetingId)
    const settings = getSettings()
    const models = (await ollama!.listModels()) ?? []
    const model = pickSummaryModel(models, settings.ollamaModel)

    return answerAboutMeeting({ client: ollama!, model }, segments, question)
  },

  regenerateActionItems: async (args) => {
    const meetingId = String(args[0])
    const meeting = getMeeting(meetingId)
    if (!meeting) throw new Error('Meeting not found.')

    const segments = listSegments(meetingId)
    const settings = getSettings()
    const models = (await ollama!.listModels()) ?? []
    const model = pickSummaryModel(models, settings.ollamaModel)

    if (!model) {
      throw new Error(
        'Extracting action items needs a local language model. Install Ollama and pull a model ' +
          'such as llama3.1:8b, then try again.'
      )
    }

    const result = await summarizeMeeting(
      { client: ollama!, model },
      { segments, title: meeting.title }
    )
    const items = replaceActionItems(meetingId, result.actionItems)
    emit({ type: 'action-items', meetingId })
    return items
  },

  addActionItem: (args) => {
    const [meetingId, text, assignee] = args as [string, string, string | null]
    return addActionItem(meetingId, text, assignee)
  },

  updateActionItem: (args) => {
    const [id, patch] = args as [string, Partial<Pick<ActionItem, 'text' | 'assignee' | 'done'>>]
    updateActionItem(id, patch)
    return true
  },

  deleteActionItem: (args) => {
    deleteActionItem(String(args[0]))
    return true
  },

  /* ---------------- search ---------------- */

  search: async (args): Promise<SearchHit[]> => {
    const options = args[0] as SearchOptions
    const embedder = await buildEmbedder()
    // The lexical tier is query-time only; if it is all we have, keyword
    // ranking already covers term overlap, so semantic adds nothing.
    const deps = embedder.info.kind === 'lexical' ? {} : semanticDeps(embedder)
    return runSearch(options, deps)
  },

  askAcrossMeetings: async (args): Promise<RagAnswer> => {
    const [question, meetingIds] = args as [string, string[] | undefined]
    const embedder = await buildEmbedder()
    const deps = embedder.info.kind === 'lexical' ? {} : semanticDeps(embedder)

    const chunks = await retrieveContext(question, meetingIds, deps, 12)
    const settings = getSettings()
    const models = (await ollama!.listModels()) ?? []
    const model = pickSummaryModel(models, settings.ollamaModel)

    const result = await answerAcrossMeetings({ client: ollama!, model }, question, chunks)

    return {
      answer: result.answer,
      citations: chunks.slice(0, 8).map((chunk) => ({
        meetingId: chunk.meetingId,
        meetingTitle: chunk.title,
        segmentId: chunk.segmentId,
        startMs: chunk.startMs,
        text: chunk.text
      })),
      usedModel: model ?? 'none',
      degraded: result.degraded
    }
  },

  reindexSearch: async () => {
    const embedder = await buildEmbedder()
    const result = await indexMissingEmbeddings(embedder, segmentsMissingEmbeddings, upsertEmbeddings, 32)
    invalidateEmbeddingCache()
    return result
  },

  /* ---------------- dictionary ---------------- */

  listDictionary: () => listDictionary(),

  addDictionaryTerm: (args) => {
    const [term, replacement, notes] = args as [string, string | null, string | null]
    return addTermRow(term, replacement ?? null, notes ?? null)
  },

  updateDictionaryTerm: (args) => {
    const [id, patch] = args as [
      string,
      Partial<Pick<DictionaryTerm, 'term' | 'replacement' | 'notes'>>
    ]
    return updateTermRow(id, patch)
  },

  deleteDictionaryTerm: (args) => {
    deleteTermRow(String(args[0]))
    // Refresh the live biasing prompt.
    if (session?.isActive) session.refreshDictionaryPrompt()
    return true
  },

  /* ---------------- models ---------------- */

  listWhisperModels: async () => {
    let present: string[] = []
    let catalogue: Record<string, { size: number; ram_gb: number; english_only: boolean }> = {}

    try {
      const status = await sidecar!.status()
      present = status.models_present
      catalogue = status.whisper_models
    } catch {
      /* sidecar offline; fall back to a static catalogue */
      catalogue = {
        'tiny.en': { size: 75_000_000, ram_gb: 1, english_only: true },
        'base.en': { size: 145_000_000, ram_gb: 2, english_only: true },
        'small.en': { size: 480_000_000, ram_gb: 3, english_only: true },
        'medium.en': { size: 1_530_000_000, ram_gb: 6, english_only: true },
        'large-v3': { size: 3_100_000_000, ram_gb: 10, english_only: false }
      }
    }

    const notes: Record<string, string> = {
      'tiny.en': 'Fastest, least accurate. Good for clear audio and quick notes.',
      'base.en': 'The recommended default: a good balance of speed and accuracy on CPU.',
      'small.en': 'Noticeably better on accents and jargon; roughly 2-3x slower than base.',
      'medium.en': 'High accuracy. Needs a reasonably modern CPU to keep up in real time.',
      'large-v3': 'Best accuracy, heaviest. A GPU is strongly recommended.',
      'large-v3-turbo': 'Near-large accuracy at much higher speed.',
      'distil-large-v3': 'Distilled large model, English only, fast for its accuracy.'
    }

    return Object.entries(catalogue).map(([id, info]) => ({
      id,
      label: id,
      sizeBytes: info.size,
      ramGb: info.ram_gb,
      downloaded: present.includes(id),
      englishOnly: info.english_only,
      note: notes[id] ?? ''
    }))
  },

  downloadWhisperModel: async (args) => {
    const model = String(args[0])
    try {
      emit({ type: 'busy', label: `Downloading ${model}…`, progress: null })
      await sidecar!.downloadModel(model)
      emit({ type: 'busy', label: null, progress: null })
      emit({ type: 'status', status: await (handlers.getStatus([]) as Promise<BackendStatus>) })
      return { ok: true, message: `${model} is ready.` }
    } catch (error) {
      emit({ type: 'busy', label: null, progress: null })
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error)
      }
    }
  },

  deleteWhisperModel: async (args) => {
    const model = String(args[0])
    const target = join(getPaths().modelsDir, 'whisper', model)
    if (existsSync(target)) {
      await rm(target, { recursive: true, force: true })
    }
    emit({ type: 'status', status: await (handlers.getStatus([]) as Promise<BackendStatus>) })
    return true
  },

  compileRecorder: async () => {
    const result = await ensureRecorderBuilt(true)
    return { ok: result.ok, message: result.message }
  },

  transcribeAudioFile: async () => {
    const settings = getSettings()
    let available = false
    try {
      const status = await sidecar!.status()
      available = status.whisper.available && status.models_present.length > 0
    } catch {
      available = false
    }

    if (!available) {
      throw new Error(
        'Transcribing a file needs the local speech engine and a downloaded model. ' +
          'See Settings > Models to download one.'
      )
    }

    const result = await dialog.showOpenDialog(mainWindow!, {
      title: 'Choose an audio file',
      properties: ['openFile'],
      filters: [
        { name: 'Audio', extensions: ['wav', 'mp3', 'm4a', 'flac', 'ogg', 'opus', 'webm'] }
      ]
    })
    if (result.canceled || result.filePaths.length === 0) return null

    const filePath = result.filePaths[0]
    const title = filePath.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '') || 'Imported audio'

    emit({ type: 'busy', label: `Transcribing ${title}…`, progress: null })
    try {
      const meetingId = await session!.transcribeFile(filePath, title)
      emit({ type: 'segments-updated', meetingId })
      emit({ type: 'navigate', view: 'meeting', meetingId })
      return { meetingId }
    } finally {
      emit({ type: 'busy', label: null, progress: null })
    }
  },

  /* ---------------- misc ---------------- */

  openDataDir: async () => {
    await shell.openPath(getPaths().dataDir)
    return true
  },

  openLogs: async () => {
    await shell.openPath(getPaths().logsDir)
    return true
  },

  getLogTail: (args) => tailLog(typeof args[0] === 'number' ? (args[0] as number) : 200)
}

/* ------------------------------------------------------------------ */
/* Dispatch                                                            */
/* ------------------------------------------------------------------ */

function registerIpc(): void {
  ipcMain.handle(CHANNELS.invoke, async (_event, method: string, args: unknown[]) => {
    if (!INVOKE_METHODS.includes(method as InvokeMethod)) {
      throw new Error(`Unknown method "${method}"`)
    }
    const handler = handlers[method as InvokeMethod]
    if (!handler) throw new Error(`Method "${method}" is not implemented`)
    return handler(Array.isArray(args) ? args : [])
  })
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

// Only one instance may run: two instances would fight over the database and
// could both try to capture audio.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    ensureLogFile()

    try {
      getDb()
    } catch (error) {
      dialog.showErrorBox(
        'Local Note could not open its database',
        `${error instanceof Error ? error.message : String(error)}\n\n` +
          `The data folder is:\n${getPaths().dataDir}`
      )
      app.quit()
      return
    }

    const settings = getSettings()
    logStartupBanner({
      dataDir: getPaths().dataDir,
      whisperModel: settings.whisperModel,
      keepAudio: settings.keepAudio,
      captureMic: settings.captureMic
    })

    ollama = new OllamaClient(settings.ollamaHost)
    sidecar = new Sidecar()

    session = new SessionManager({
      sidecar,
      ollama,
      emit,
      sttAvailable: async () => {
        try {
          if (!sidecar) return false
          const status = await sidecar.status()
          return status.whisper.available && status.models_present.length > 0
        } catch (error) {
          log.debug('STT availability probe failed', error)
          return false
        }
      }
    })

    // Forward session state changes so the tray can react.
    session.on('state', (state: SessionState) => {
      emit({ type: 'session', state })
    })

    installOfflineGuard()
    registerIpc()
    await createWindow()
    createTray()

    // Remove expired audio from previous sessions.
    try {
      SessionManager.sweepAudioRetention()
    } catch (error) {
      log.warn('audio retention sweep failed', error)
    }

    // Warm the sidecar in the background so the first recording starts fast.
    void sidecar
      .statusSafe()
      .then((status) => {
        if (status.available) log.info('speech engine available')
        else log.info('speech engine not available yet', status.error ?? status.guidance)
      })
      .catch(() => undefined)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      quitting = true
      app.quit()
    }
  })

  app.on('before-quit', (event) => {
    quitting = true

    // Shut down cleanly exactly once. Stopping an active session matters: the
    // recorder patches its WAV headers on shutdown, so killing the process
    // outright would lose the last few seconds of audio.
    if (cleanupComplete) return
    event.preventDefault()

    void (async () => {
      try {
        if (session?.isActive) await session.stop()
      } catch (error) {
        log.error('failed to stop session during quit', error)
      }
      try {
        await sidecar?.shutdown()
      } catch {
        /* the sidecar may already be gone */
      }
      sidecar = null
      try {
        closeDb()
      } catch (error) {
        log.warn('failed to close the database during quit', error)
      }
      cleanupComplete = true
      app.quit()
    })()
  })
}
