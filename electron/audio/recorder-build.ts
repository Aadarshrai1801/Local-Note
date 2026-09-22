import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createLogger } from '../lib/log'
import { getNativeDir, getRecorderExePath, getRecorderSourcePath } from '../lib/paths'

const log = createLogger('recorder-build')

/**
 * Local Note captures system audio with a small C# helper that P/Invokes the
 * Windows Core Audio (WASAPI) APIs directly.
 *
 * It is compiled on first use with the C# compiler that ships inside every
 * Windows installation (%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe).
 * That means no Visual Studio, no .NET SDK, no NuGet restore and no Rust
 * toolchain are required to build or run this app.
 */

/** Locations of the bundled compiler, newest framework first. */
function candidateCompilers(): string[] {
  const windir = process.env.WINDIR ?? 'C:\\Windows'
  const roots = [
    join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe')
  ]
  return roots
}

export interface BuildResult {
  ok: boolean
  message: string
  exePath: string
  /** True when a previously compiled binary was reused. */
  cached: boolean
}

function isUpToDate(exePath: string, sourcePath: string): boolean {
  if (!existsSync(exePath)) return false
  try {
    return statSync(exePath).mtimeMs >= statSync(sourcePath).mtimeMs
  } catch {
    return false
  }
}

/**
 * Compiles native/WasapiRecorder.cs into native/bin/WasapiRecorder.exe.
 * Safe to call repeatedly: it reuses the binary unless the source is newer.
 */
export async function ensureRecorderBuilt(force = false): Promise<BuildResult> {
  const exePath = getRecorderExePath()
  const sourcePath = getRecorderSourcePath()

  if (!force && isUpToDate(exePath, sourcePath)) {
    return { ok: true, message: 'Audio helper is already built.', exePath, cached: true }
  }

  if (!existsSync(sourcePath)) {
    const message = `Recorder source not found at ${sourcePath}`
    log.error(message)
    return { ok: false, message, exePath, cached: false }
  }

  const compiler = candidateCompilers().find((path) => existsSync(path))
  if (!compiler) {
    const message =
      'Could not find the .NET Framework C# compiler (csc.exe) that ships with Windows. ' +
      'Audio capture is unavailable on this system.'
    log.error(message)
    return { ok: false, message, exePath, cached: false }
  }

  const outDir = dirname(exePath)
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })

  log.info(`compiling audio helper with ${compiler}`)

  return new Promise<BuildResult>((resolve) => {
    execFile(
      compiler,
      [
        '/nologo',
        '/platform:x64',
        '/optimize+',
        '/target:exe',
        `/out:${exePath}`,
        sourcePath
      ],
      { windowsHide: true, timeout: 120_000 },
      (error, stdout, stderr) => {
        const output = `${stdout ?? ''}${stderr ?? ''}`.trim()

        if (error || !existsSync(exePath)) {
          const message = `Compiling the audio helper failed.\n${output || String(error)}`
          log.error(message)
          resolve({ ok: false, message, exePath, cached: false })
          return
        }

        log.info('audio helper compiled successfully')
        resolve({
          ok: true,
          message: output.length > 0 ? `Built with warnings:\n${output}` : 'Audio helper built.',
          exePath,
          cached: false
        })
      }
    )
  })
}

export function recorderExists(): boolean {
  return existsSync(getRecorderExePath())
}

export function getNativeDirPath(): string {
  return getNativeDir()
}
