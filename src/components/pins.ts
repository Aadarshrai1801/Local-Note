/**
 * Pinned meetings.
 *
 * The shared `Meeting` contract is frozen (no `pinned` column) and the SQLite
 * schema lives in the frozen main process, so pins are a UI-level sort backed
 * by localStorage rather than a real database field. They survive restarts and
 * are scoped to this machine/profile, which is the honest behaviour we can
 * offer without changing the data model.
 */
import { useSyncExternalStore } from 'react'

const STORAGE_KEY = 'localnote.pinnedMeetings'

function read(): string[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw == null) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((id): id is string => typeof id === 'string' && id.length > 0)
  } catch {
    // Storage can be unavailable or hold junk; pins are best-effort.
    return []
  }
}

let ids: string[] = read()
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function commit(next: string[]): void {
  ids = next
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Private mode / quota: keep the in-memory pin for this session.
  }
  for (const listener of Array.from(listeners)) listener()
}

export function isPinned(meetingId: string): boolean {
  return ids.includes(meetingId)
}

/** Toggle a pin. Returns the new pinned state. */
export function togglePin(meetingId: string): boolean {
  const next = ids.includes(meetingId)
  commit(next ? ids.filter((id) => id !== meetingId) : [...ids, meetingId])
  return !next
}

export function unpin(meetingId: string): void {
  if (ids.includes(meetingId)) commit(ids.filter((id) => id !== meetingId))
}

/** Reactive list of pinned meeting ids, in the order they were pinned. */
export function usePinnedIds(): readonly string[] {
  return useSyncExternalStore(subscribe, () => ids, () => ids)
}
