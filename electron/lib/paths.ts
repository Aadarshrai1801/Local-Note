import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AppPaths } from '../../shared/types'

/**
 * Every byte Local Note writes lives under a single directory tree, so users
 * can back it up, move it to another machine, or delete it in one action.
 *
 * Resolution order:
 *   1. the LOCALNOTE_DATA_DIR environment variable
 *   2. a `localnote.config.json` file next to the app (see below)
 *   3. %APPDATA%\Local Note
 *
 * The config file makes it easy to keep large model downloads on a drive with
 * more room, which is a common request on machines with a small system drive:
 *
 *   { "dataDir": "D:\\Local Note\\data" }
 */
interface LocalNoteConfig {
  dataDir?: string
  /** Optional separate location for downloaded models (can be very large). */
  modelsDir?: string
}

function readConfigFile(): LocalNoteConfig | null {
  const candidates = [
    join(process.cwd(), 'localnote.config.json'),
    join(getResourceDir(), 'localnote.config.json')
  ]

  for (const path of candidates) {
    try {
      if (!existsSync(path)) continue
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as LocalNoteConfig
      if (parsed && typeof parsed === 'object') return parsed
    } catch {
      // A malformed config must never stop the app from starting.
    }
  }
  return null
}

function resolveDataDir(config: LocalNoteConfig | null): string {
  const override = process.env.LOCALNOTE_DATA_DIR
  if (override && override.trim().length > 0) return override

  if (config?.dataDir && config.dataDir.trim().length > 0) return config.dataDir

  try {
    return app.getPath('userData')
  } catch {
    // Fall back to a local folder if Electron's path API is unavailable.
    return join(process.cwd(), '.localnote-data')
  }
}

let cached: AppPaths | null = null

export function getPaths(): AppPaths {
  if (cached) return cached

  const config = readConfigFile()
  const dataDir = resolveDataDir(config)

  // Models may be pointed at a separate volume, since they are by far the
  // largest thing the app stores.
  const modelsDir =
    process.env.LOCALNOTE_MODELS_DIR ??
    (config?.modelsDir && config.modelsDir.trim().length > 0
      ? config.modelsDir
      : join(dataDir, 'models'))

  const paths: AppPaths = {
    dataDir,
    dbPath: join(dataDir, 'localnote.db'),
    audioDir: join(dataDir, 'audio'),
    modelsDir,
    logsDir: join(dataDir, 'logs'),
    briefDocsDir: join(dataDir, 'brief-docs')
  }

  for (const dir of [
    paths.dataDir,
    paths.audioDir,
    paths.modelsDir,
    paths.logsDir,
    paths.briefDocsDir
  ]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }

  cached = paths
  return paths
}

/**
 * Root directory that holds `assets/`, `native/` and `sidecar/`.
 *
 * In development this is the project root. When packaged, those folders are
 * listed in `asarUnpack`, so they live next to the archive rather than inside it.
 *
 * `LOCALNOTE_RESOURCE_DIR` overrides the whole thing, which is what makes a
 * portable install (or an out-of-tree test harness) able to point the app at a
 * specific set of helper files.
 */
export function getResourceDir(): string {
  const override = process.env.LOCALNOTE_RESOURCE_DIR
  if (override && override.trim().length > 0) return override

  try {
    const appPath = app.getAppPath()
    if (app.isPackaged) {
      return appPath.replace(/app\.asar$/, 'app.asar.unpacked')
    }
    return appPath
  } catch {
    // Not running inside Electron (e.g. a unit test): walk up from this file.
    return join(__dirname, '..', '..', '..')
  }
}

export function getNativeDir(): string {
  return join(getResourceDir(), 'native')
}

export function getSidecarDir(): string {
  return join(getResourceDir(), 'sidecar')
}

/**
 * Root of the application bundle — the folder that contains `dist/`.
 *
 * This is deliberately different from `getResourceDir()`:
 *
 *   * `native/` and `sidecar/` are listed in `asarUnpack`, so they live beside
 *     the archive and are reached through `getResourceDir()`.
 *   * `dist/` is packaged *inside* the archive, so it must be reached through
 *     the app path. Pointing at the unpacked folder finds nothing there.
 */
export function getAppRoot(): string {
  try {
    return app.getAppPath()
  } catch {
    // Not running inside Electron (e.g. a unit test).
    return join(__dirname, '..', '..', '..')
  }
}

export function getRecorderExePath(): string {
  return join(getNativeDir(), 'bin', 'WasapiRecorder.exe')
}

export function getRecorderSourcePath(): string {
  return join(getNativeDir(), 'WasapiRecorder.cs')
}
