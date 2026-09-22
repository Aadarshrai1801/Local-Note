import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { EventEmitter } from 'node:events'
import { createLogger } from '../lib/log'
import { getRecorderExePath } from '../lib/paths'
import type { StreamKind } from '../../shared/types'

const log = createLogger('recorder')

/* ------------------------------------------------------------------ */
/* Wire protocol types (mirrors the JSON the C# helper emits)          */
/* ------------------------------------------------------------------ */

export interface RecorderReadyEvent {
  type: 'ready'
  session: string
  dir: string
  sampleRate: number
  chunkMs: number
  streams: Array<{ name: StreamKind; device: string }>
}

export interface RecorderChunkEvent {
  type: 'chunk'
  stream: StreamKind
  index: number
  path: string
  frames: number
  sampleRate: number
  rms: number
  startMs: number
}

export interface RecorderLevelEvent {
  type: 'level'
  stream: StreamKind
  ms: number
  capturedMs: number
  realMs: number
  paddedMs: number
  packets: number
  rms: number
  hr: number
}

export interface RecorderErrorEvent {
  type: 'error'
  stream?: string
  message: string
  detail?: string
}

export interface RecorderWarningEvent {
  type: 'warning'
  stream?: string
  message: string
}

export interface RecorderStoppedEvent {
  type: 'stopped'
  session: string
  dir: string
}

export interface DeviceListEvent {
  type: 'devices'
  system: string | null
  systemName: string | null
  mic: string | null
  micName: string | null
}

export type RecorderEvent =
  | RecorderReadyEvent
  | RecorderChunkEvent
  | RecorderLevelEvent
  | RecorderErrorEvent
  | RecorderWarningEvent
  | RecorderStoppedEvent

export interface StartRecorderOptions {
  sessionId: string
  outDir: string
  captureMic: boolean
  systemDeviceId?: string | null
  micDeviceId?: string | null
  sampleRate?: number
  chunkMs?: number
}

/**
 * Controls the native WASAPI capture helper.
 *
 * The helper writes 16 kHz mono PCM WAV files (a full-session file plus rolling
 * chunks) and reports progress as JSON lines on stdout. Keeping the capture in
 * a separate process means a driver-level fault cannot take down the UI, and
 * the helper can be compiled/replaced independently of the app.
 */
export class Recorder extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null
  private stopped: Promise<void> | null = null
  private stopResolve: (() => void) | null = null
  private sawStopped = false
  private fatalError: string | null = null
  private readyInfo: RecorderReadyEvent | null = null

  get isRunning(): boolean {
    return this.child !== null && this.child.exitCode === null
  }

  get fatal(): string | null {
    return this.fatalError
  }

  get ready(): RecorderReadyEvent | null {
    return this.readyInfo
  }

  /** Lists the current default endpoints, without starting a recording. */
  static listDevices(): Promise<DeviceListEvent> {
    const exe = getRecorderExePath()
    return new Promise((resolve, reject) => {
      execFile(exe, ['--list-devices'], { windowsHide: true, timeout: 20_000 }, (error, stdout) => {
        if (error) {
          reject(new Error(`Could not query audio devices: ${error.message}`))
          return
        }
        const line = stdout.split('\n').find((l) => l.trim().length > 0)
        if (!line) {
          reject(new Error('The audio helper returned no device information.'))
          return
        }
        try {
          resolve(JSON.parse(line) as DeviceListEvent)
        } catch (parseError) {
          reject(new Error(`Unreadable device list: ${String(parseError)}`))
        }
      })
    })
  }

  async start(options: StartRecorderOptions): Promise<RecorderReadyEvent> {
    if (this.isRunning) throw new Error('A recording is already in progress.')

    const exe = getRecorderExePath()
    const args = [
      '--out',
      options.outDir,
      '--session',
      options.sessionId,
      '--sample-rate',
      String(options.sampleRate ?? 16000),
      '--chunk-ms',
      String(options.chunkMs ?? 5000)
    ]

    if (options.captureMic) {
      if (options.micDeviceId) args.push('--mic-device', options.micDeviceId)
    } else {
      args.push('--no-mic')
    }
    if (options.systemDeviceId) args.push('--system-device', options.systemDeviceId)

    log.info(`starting recorder: ${exe} ${args.join(' ')}`)

    const child = spawn(exe, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child = child
    this.sawStopped = false
    this.fatalError = null

    const ready = new Promise<RecorderReadyEvent>((resolve, reject) => {
      const onReady = (info: RecorderReadyEvent): void => {
        cleanup()
        resolve(info)
      }
      const onFail = (error: Error): void => {
        cleanup()
        reject(error)
      }
      const cleanup = (): void => {
        this.off('ready', onReady)
        this.off('start-failed', onFail)
      }
      this.once('ready', onReady)
      this.once('start-failed', onFail)
    })

    // The helper emits one JSON object per line.
    const reader = createInterface({ input: child.stdout, crlfDelay: Infinity })
    reader.on('line', (line) => {
      const trimmed = line.trim()
      if (trimmed.length === 0) return
      let parsed: RecorderEvent
      try {
        parsed = JSON.parse(trimmed) as RecorderEvent
      } catch {
        log.debug(`unparsed recorder output: ${trimmed}`)
        return
      }
      this.handleEvent(parsed)
    })

    child.stderr.on('data', (data: Buffer) => {
      const text = data.toString().trim()
      if (text.length > 0) log.warn(`recorder stderr: ${text}`)
    })

    child.on('error', (error) => {
      this.fatalError = `Could not start the audio capture helper: ${error.message}`
      log.error(this.fatalError)
      this.emit('start-failed', new Error(this.fatalError))
      this.emit('error-event', { type: 'error', message: this.fatalError })
    })

    child.on('exit', (code, signal) => {
      log.info(`recorder exited code=${code} signal=${signal}`)
      this.child = null
      if (!this.sawStopped) {
        // An unexpected exit means capture stopped without being asked to.
        if (!this.fatalError) {
          this.fatalError =
            code === 0
              ? 'Audio capture ended unexpectedly.'
              : `Audio capture stopped unexpectedly (exit code ${code ?? 'unknown'}).`
        }
        this.emit('error-event', { type: 'error', message: this.fatalError })
        this.emit('start-failed', new Error(this.fatalError))
      }
      this.resolveStop()
    })

    const info = await ready
    this.readyInfo = info
    return info
  }

  private handleEvent(event: RecorderEvent): void {
    switch (event.type) {
      case 'ready':
        this.readyInfo = event
        this.emit('ready', event)
        break
      case 'chunk':
        this.emit('chunk', event)
        break
      case 'level':
        this.emit('level', event)
        break
      case 'warning':
        log.warn(`recorder warning: ${event.message}`)
        this.emit('warning', event)
        break
      case 'error':
        // A stream-level error is reported but not treated as fatal here; the
        // exit handler decides whether the whole capture died.
        log.error(`recorder error: ${event.message}`, event.detail)
        this.emit('error-event', event)
        break
      case 'stopped':
        this.sawStopped = true
        this.emit('stopped', event)
        this.resolveStop()
        break
      default:
        break
    }
  }

  private resolveStop(): void {
    if (this.stopResolve) {
      const resolve = this.stopResolve
      this.stopResolve = null
      resolve()
    }
  }

  /**
   * Asks the helper to finish writing and exit.
   *
   * A graceful stop matters: the helper patches the WAV header on shutdown and
   * flushes the final partial chunk, so killing it outright would lose the last
   * few seconds of audio.
   */
  async stop(timeoutMs = 15_000): Promise<void> {
    if (!this.child) return
    if (this.stopped) return this.stopped

    this.stopped = new Promise<void>((resolve) => {
      this.stopResolve = resolve
    })

    try {
      this.child.stdin.write('stop\n')
      this.child.stdin.end()
    } catch (error) {
      log.warn('could not send stop signal to recorder', error)
    }

    const timer = setTimeout(() => {
      if (this.child) {
        log.warn('recorder did not exit in time; terminating')
        this.child.kill()
      }
      this.resolveStop()
    }, timeoutMs)

    await this.stopped
    clearTimeout(timer)
    this.stopped = null
    this.child = null
    this.readyInfo = null
  }

  /** Immediate termination, used when discarding a session. */
  kill(): void {
    if (this.child) {
      log.warn('killing recorder process')
      this.sawStopped = true
      this.child.kill()
      this.child = null
    }
    this.resolveStop()
  }
}
