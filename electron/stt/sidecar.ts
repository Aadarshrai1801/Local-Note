import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { createLogger } from '../lib/log'
import { getPaths, getResourceDir, getSidecarDir } from '../lib/paths'
import { getSettings } from '../db/settings'
import type { SttStatus } from '../../shared/types'

const log = createLogger('sidecar')

/* ------------------------------------------------------------------ */
/* Protocol types                                                      */
/* ------------------------------------------------------------------ */

export interface SidecarSegment {
  start: number
  end: number
  text: string
  confidence: number | null
  noSpeechProb: number
}

export interface TranscribeResult {
  path: string
  model: string
  language: string | null
  languageProbability: number
  duration: number
  segments: SidecarSegment[]
}

export interface EmbedResult {
  model: string
  dim: number
  vectors: number[][]
}

export interface DiarizationTurn {
  start: number
  end: number
  speaker: string
}

export interface DiarizeResult {
  engine: string
  turns: DiarizationTurn[]
}

export interface SidecarStatusResult {
  python: string
  executable: string
  whisper: { available: boolean; engine: string | null; version: string | null }
  embeddings: {
    available: boolean
    onnxruntime: boolean
    tokenizers: boolean
    model_present: boolean
    model_dir: string
    dim: number
  }
  diarization: { available: boolean; engine: string | null; guidance: string | null }
  models_present: string[]
  models_dir: string
  whisper_models: Record<string, { size: number; ram_gb: number; english_only: boolean }>
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
  command: string
}

/* ------------------------------------------------------------------ */
/* Python discovery                                                    */
/* ------------------------------------------------------------------ */

export interface PythonCandidate {
  path: string
  label: string
}

/**
 * Finds Python interpreters worth trying, most-likely-first:
 *  1. an explicit override in settings
 *  2. the LOCALNOTE_PYTHON environment variable
 *  3. a project-local .venv (the documented setup path)
 *  4. the `py` launcher
 *  5. `python` on PATH
 */
export function pythonCandidates(): PythonCandidate[] {
  const candidates: PythonCandidate[] = []

  const configured = getSettings().pythonPath
  if (configured && configured.trim().length > 0) {
    candidates.push({ path: configured.trim(), label: 'configured in settings' })
  }

  // An environment variable makes a packaged or portable install configurable
  // without going through the UI, and without the app having to guess where the
  // interpreter lives.
  const fromEnv = process.env.LOCALNOTE_PYTHON
  if (fromEnv && fromEnv.trim().length > 0) {
    candidates.push({ path: fromEnv.trim(), label: 'LOCALNOTE_PYTHON' })
  }

  // Look for a project virtualenv in every location that could plausibly hold
  // one. Relying on the working directory alone is fragile: a packaged app
  // launched from the Start Menu or Explorer has a working directory unrelated
  // to where the user created their virtualenv.
  const roots = new Set<string>([process.cwd(), getResourceDir()])

  // The data directory is often inside the project folder (for example
  // <project>\.localnote-data), so its parent is a good place to look.
  try {
    const dataDir = getPaths().dataDir
    roots.add(dataDir)
    roots.add(join(dataDir, '..'))
  } catch {
    /* data directory not resolvable yet */
  }

  for (const root of roots) {
    if (!root) continue
    for (const relative of [
      ['.venv', 'Scripts', 'python.exe'],
      ['venv', 'Scripts', 'python.exe'],
      ['.venv', 'bin', 'python'],
      ['venv', 'bin', 'python']
    ]) {
      const candidate = join(root, ...relative)
      if (existsSync(candidate)) {
        candidates.push({ path: candidate, label: `virtualenv near ${root}` })
      }
    }
  }

  candidates.push({ path: 'py', label: 'py launcher' })
  candidates.push({ path: 'python', label: 'python on PATH' })

  // De-duplicate while preserving order.
  const seen = new Set<string>()
  return candidates.filter((candidate) => {
    const key = candidate.path.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * The Windows Store installs stub executables named python.exe that, when run,
 * open the Store instead of running Python — and can block waiting for input.
 * They are never a usable interpreter, so they are skipped outright.
 */
function isWindowsStoreStub(path: string): boolean {
  return /\\WindowsApps\\python(3)?\.exe$/i.test(path)
}

function checkPython(path: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    execFile(path, args, { windowsHide: true, timeout: timeoutMs }, (error, stdout, stderr) => {
      const text = `${stdout ?? ''}${stderr ?? ''}`.trim()
      resolve({ ok: !error && text.length > 0, stdout: text })
    })
  })
}

export interface PythonProbe {
  path: string
  version: string
  hasFasterWhisper: boolean
  fasterWhisperVersion: string | null
  label: string
}

let fallbackProbe: PythonProbe | null = null

/**
 * Probes each candidate interpreter to find one that can actually run the
 * sidecar. Returns null when no Python is usable, which the UI reports as
 * "transcription unavailable" rather than failing silently.
 */
export async function findUsablePython(): Promise<PythonProbe | null> {
  for (const candidate of pythonCandidates()) {
    if (isWindowsStoreStub(candidate.path)) {
      log.debug(`skipping Windows Store python stub: ${candidate.path}`)
      continue
    }

    const baseArgs = candidate.path === 'py' ? ['-3'] : []

    const versionResult = await checkPython(candidate.path, [...baseArgs, '--version'], 10_000)
    if (!versionResult.ok) continue

    // Confirm the interpreter can import the sidecar's dependencies.
    const importResult = await checkPython(
      candidate.path,
      [...baseArgs, '-c', 'import faster_whisper; print(getattr(faster_whisper, "__version__", "unknown"))'],
      60_000
    )

    const probe: PythonProbe = {
      path: candidate.path === 'py' ? 'py' : candidate.path,
      version: versionResult.stdout.replace(/^Python\s+/i, '').trim(),
      hasFasterWhisper: importResult.ok,
      fasterWhisperVersion: importResult.ok ? importResult.stdout.split('\n').pop()!.trim() : null,
      label: candidate.label
    }

    // Prefer a Python that already has the STT stack; otherwise remember the
    // first working interpreter as a fallback (the user may install later).
    if (probe.hasFasterWhisper) return probe
    if (!fallbackProbe) fallbackProbe = probe
  }

  return fallbackProbe
}

/* ------------------------------------------------------------------ */
/* Sidecar process                                                     */
/* ------------------------------------------------------------------ */

export class Sidecar extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null
  private pending = new Map<string, Pending>()
  private nextId = 1
  private starting: Promise<void> | null = null
  private restartCount = 0
  private disposed = false
  private probe: PythonProbe | null = null

  /** Absolute path to the sidecar script. */
  private scriptPath(): string {
    return join(getSidecarDir(), 'localnote_sidecar.py')
  }

  get probedPython(): PythonProbe | null {
    return this.probe
  }

  get isRunning(): boolean {
    return this.child !== null && this.child.exitCode === null
  }

  async ensureStarted(): Promise<void> {
    if (this.isRunning) return
    if (this.starting) return this.starting

    this.starting = this.start()
    try {
      await this.starting
    } finally {
      this.starting = null
    }
  }

  private async start(): Promise<void> {
    const script = this.scriptPath()
    if (!existsSync(script)) {
      throw new Error(`Sidecar script missing at ${script}`)
    }

    const python = await findUsablePython()
    if (!python) {
      throw new Error(
        'No Python interpreter was found. Install Python 3.10+ and the local speech ' +
          'dependencies to enable transcription.'
      )
    }
    this.probe = python

    const args = [...(python.path === 'py' ? ['-3'] : []), script]
    log.info(`starting sidecar: ${python.path} ${args.join(' ')}`)

    // Keep every model cache on the configured data volume. Without these,
    // huggingface_hub would write into %USERPROFILE%\.cache on the system drive,
    // which matters on machines where C: is small.
    const huggingFaceHome = join(getPaths().modelsDir, 'huggingface')

    const child = spawn(python.path, args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        LOCALNOTE_MODELS_DIR: getPaths().modelsDir,
        HF_HOME: huggingFaceHome,
        HF_HUB_CACHE: join(huggingFaceHome, 'hub'),
        // Legacy variables still honoured by some Hugging Face libraries.
        TRANSFORMERS_CACHE: join(huggingFaceHome, 'transformers'),
        XDG_CACHE_HOME: huggingFaceHome,
        // Keep Python from buffering our protocol writes.
        PYTHONUNBUFFERED: '1',
        PYTHONIOENCODING: 'utf-8'
      }
    })
    this.child = child

    const ready = new Promise<void>((resolve, reject) => {
      const onReady = (): void => {
        cleanup()
        resolve()
      }
      const onExit = (code: number | null): void => {
        cleanup()
        reject(new Error(`The transcription service exited during startup (code ${code ?? 'unknown'}).`))
      }
      const cleanup = (): void => {
        this.off('ready', onReady)
        this.off('early-exit', onExit)
      }
      this.once('ready', onReady)
      this.once('early-exit', onExit)
      // Python can take a moment to import on a cold start.
      setTimeout(() => {
        cleanup()
        reject(new Error('The transcription service did not start within 60 seconds.'))
      }, 60_000).unref()
    })

    const reader = createInterface({ input: child.stdout, crlfDelay: Infinity })
    reader.on('line', (line) => this.handleLine(line))

    child.stderr.on('data', (data: Buffer) => {
      const text = data.toString().trim()
      if (text.length > 0) log.debug(`sidecar: ${text}`)
    })

    child.on('error', (error) => {
      log.error('sidecar process error', error)
      this.failAllPending(`Transcription service error: ${error.message}`)
    })

    child.on('exit', (code, signal) => {
      log.info(`sidecar exited code=${code} signal=${signal}`)
      this.child = null
      this.emit('early-exit', code)
      this.failAllPending(`The transcription service stopped unexpectedly (code ${code ?? 'unknown'}).`)
      if (!this.disposed && this.restartCount < 5) {
        this.restartCount++
        log.warn(`restarting sidecar (attempt ${this.restartCount})`)
      }
    })

    await ready
    this.restartCount = 0
    log.info('sidecar ready')
  }

  private handleLine(line: string): void {
    const trimmed = line.trim()
    if (trimmed.length === 0) return

    let message: Record<string, unknown>
    try {
      message = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      log.debug(`unparsed sidecar output: ${trimmed}`)
      return
    }

    if (message.event === 'ready') {
      this.emit('ready')
      return
    }
    if (message.event === 'progress') {
      this.emit('progress', message)
      return
    }

    const id = String(message.id ?? '')
    const entry = this.pending.get(id)
    if (!entry) {
      log.debug(`sidecar response for unknown request ${id}`)
      return
    }
    this.pending.delete(id)
    clearTimeout(entry.timer)

    if (message.ok === true) {
      entry.resolve(message.result)
    } else {
      const error = new Error(String(message.error ?? 'Unknown sidecar error'))
      const detail = message.detail
      if (typeof detail === 'string' && detail.length > 0) {
        log.warn(`sidecar error detail for ${entry.command}`, detail)
      }
      entry.reject(error)
    }
  }

  private failAllPending(reason: string): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error(reason))
      this.pending.delete(id)
    }
  }

  /**
   * Sends one request and resolves with its result.
   *
   * Long timeouts are intentional: transcribing a 5-second chunk can take
   * longer than that on a slow CPU, and a first-time model load can take a
   * minute or more.
   */
  private request<T>(command: string, params: Record<string, unknown> = {}, timeoutMs = 600_000): Promise<T> {
    if (!this.child) {
      return Promise.reject(new Error('The transcription service is not running.'))
    }

    const id = String(this.nextId++)
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`The "${command}" request timed out after ${Math.round(timeoutMs / 1000)}s.`))
      }, timeoutMs)

      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
        command
      })

      try {
        this.child!.stdin.write(JSON.stringify({ id, cmd: command, ...params }) + '\n')
      } catch (error) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  async status(): Promise<SidecarStatusResult> {
    await this.ensureStarted()
    return this.request<SidecarStatusResult>('status', {}, 60_000)
  }

  async loadModel(model: string): Promise<{ loaded: string; device: string }> {
    await this.ensureStarted()
    return this.request<{ loaded: string; device: string }>('load', { model })
  }

  async transcribe(params: {
    path: string
    model: string
    initialPrompt?: string
    language?: string | null
    vad?: boolean
    beamSize?: number
  }): Promise<TranscribeResult> {
    await this.ensureStarted()
    return this.request<TranscribeResult>('transcribe', params, 1_800_000)
  }

  async embed(texts: string[]): Promise<EmbedResult> {
    await this.ensureStarted()
    return this.request<EmbedResult>('embed', { texts }, 300_000)
  }

  async diarize(params: {
    path: string
    numSpeakers?: number
    minSpeakers?: number
    maxSpeakers?: number
  }): Promise<DiarizeResult> {
    await this.ensureStarted()
    return this.request<DiarizeResult>('diarize', params, 1_800_000)
  }

  /** Explicit, user-initiated model download (the only networked STT call). */
  async downloadModel(model: string): Promise<{ downloaded: string; models_present: string[] }> {
    await this.ensureStarted()
    return this.request('download-model', { model }, 3_600_000)
  }

  async downloadEmbeddingModel(): Promise<{ downloaded: string }> {
    await this.ensureStarted()
    return this.request('download-embedding-model', {}, 3_600_000)
  }

  /** Non-throwing status used by the UI, so a missing Python is not an error. */
  async statusSafe(): Promise<SttStatus> {
    const settings = getSettings()
    const empty: SttStatus = {
      engine: null,
      available: false,
      pythonPath: null,
      pythonVersion: null,
      version: null,
      modelsPresent: [],
      modelDir: getPaths().modelsDir,
      guidance: null,
      error: null
    }

    try {
      const result = await this.status()
      return {
        engine: result.whisper.available ? 'faster-whisper' : null,
        available: result.whisper.available,
        pythonPath: result.executable,
        pythonVersion: result.python,
        version: result.whisper.version,
        modelsPresent: result.models_present,
        modelDir: result.models_dir,
        guidance: result.whisper.available
          ? null
          : `Install the local speech engine to enable transcription. In the project folder run:\n` +
            `.venv\\Scripts\\python.exe -m pip install faster-whisper`,
        error: null
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const settings = getSettings()
      return {
        ...empty,
        pythonPath: settings.pythonPath,
        guidance:
          'Local Note could not find a Python interpreter for speech recognition.\n\n' +
          'Fix it one of these ways:\n' +
          '  1. In this app, open Settings > AI and set the Python path to your virtualenv, e.g.\n' +
          '     <project folder>\\.venv\\Scripts\\python.exe\n' +
          '  2. Or set a LOCALNOTE_PYTHON environment variable to that same path.\n' +
          '  3. Or create the virtualenv, if it does not exist yet:\n' +
          '     python -m venv .venv\n' +
          '     .venv\\Scripts\\python.exe -m pip install -r sidecar\\requirements.txt\n\n' +
          'Note that a "python" which opens the Microsoft Store is a Windows stub, not a real\n' +
          'interpreter, and is skipped automatically. Anaconda and Miniconda installations often\n' +
          'need to be given by full path.',
        error: message
      }
    }
  }

  async shutdown(): Promise<void> {
    this.disposed = true
    if (!this.child) return
    try {
      await this.request('shutdown', {}, 5_000)
    } catch {
      /* the process may already be gone */
    }
    try {
      this.child?.stdin.end()
      this.child?.kill()
    } catch {
      /* ignore */
    }
    this.child = null
  }
}
