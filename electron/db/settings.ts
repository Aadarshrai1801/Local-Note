import type { AppSettings } from '../../shared/types'
import { getMeta, setMeta } from './index'
import { createLogger } from '../lib/log'

const log = createLogger('settings')

const SETTINGS_KEY = 'settings'

/**
 * Settings live inside the SQLite file rather than a separate config file, so
 * "back up your data" and "move to a new machine" both mean copying one folder.
 */
export const DEFAULT_SETTINGS: AppSettings = {
  // "base.en" is the accuracy/speed sweet spot for English on CPU.
  whisperModel: 'base.en',
  ollamaModel: null,
  embeddingModel: null,
  keepAudio: true,
  // 0 = keep audio forever unless the user asks otherwise.
  audioRetentionDays: 0,
  captureMic: true,
  missedWindowMinutes: 10,
  dictionaryEnabled: true,
  // Chunks quieter than this RMS are treated as silence and never transcribed.
  silenceThreshold: 0.0035,
  ollamaHost: 'http://127.0.0.1:11434',
  pythonPath: null,
  systemDeviceId: null,
  micDeviceId: null,
  theme: 'dark'
}

let cache: AppSettings | null = null

export function getSettings(): AppSettings {
  if (cache) return cache

  const raw = getMeta(SETTINGS_KEY)
  if (!raw) {
    cache = { ...DEFAULT_SETTINGS }
    return cache
  }

  try {
    const parsed = JSON.parse(raw) as Partial<AppSettings>
    // Merge over defaults so a settings file written by an older build still
    // loads after new keys are added.
    cache = { ...DEFAULT_SETTINGS, ...parsed }
  } catch (error) {
    log.warn('settings JSON was unreadable; falling back to defaults', error)
    cache = { ...DEFAULT_SETTINGS }
  }
  return cache
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  const next: AppSettings = { ...getSettings(), ...patch }

  // Guard the values that would otherwise break audio or arithmetic downstream.
  if (!Number.isFinite(next.missedWindowMinutes) || next.missedWindowMinutes < 1) {
    next.missedWindowMinutes = DEFAULT_SETTINGS.missedWindowMinutes
  }
  if (next.missedWindowMinutes > 120) next.missedWindowMinutes = 120
  if (!Number.isFinite(next.audioRetentionDays) || next.audioRetentionDays < 0) {
    next.audioRetentionDays = 0
  }
  if (!Number.isFinite(next.silenceThreshold) || next.silenceThreshold < 0) {
    next.silenceThreshold = 0
  }
  if (next.silenceThreshold > 0.2) next.silenceThreshold = 0.2

  setMeta(SETTINGS_KEY, JSON.stringify(next))
  cache = next
  return next
}

/** Test helper: makes the next getSettings() re-read from the database. */
export function invalidateSettingsCache(): void {
  cache = null
}
