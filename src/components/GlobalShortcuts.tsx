/**
 * Application-level keyboard shortcuts.
 *
 * - Ctrl/Cmd+K or `/` focuses the search box on this screen, or opens Search
 *   and focuses it from anywhere else.
 * - Ctrl/Cmd+N starts a new recording (or jumps to the live view if one is
 *   already running).
 *
 * `/` is ignored while the user is typing so it can still be typed into text.
 * The hints are surfaced inline with <Kbd> next to the controls they trigger.
 */
import { useEffect, type ReactNode } from 'react'
import { go, startRecording, useIsRecording, useNav, useSettings } from '@/lib/store'

export const HOME_SEARCH_ID = 'home-search'
export const SEARCH_QUERY_ID = 'search-query'

function focusWhenReady(id: string, attempts = 20): void {
  const element = document.getElementById(id)
  if (element instanceof HTMLElement) {
    element.focus()
    if (element instanceof HTMLInputElement) element.select()
    return
  }
  if (attempts <= 0) return
  window.setTimeout(() => focusWhenReady(id, attempts - 1), 30)
}

function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null
  if (element == null) return false
  const tag = element.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || element.isContentEditable
}

export function GlobalShortcuts(): ReactNode {
  const nav = useNav()
  const recording = useIsRecording()
  const settings = useSettings()

  useEffect(() => {
    const focusSearch = (): void => {
      if (nav.view === 'home') {
        focusWhenReady(HOME_SEARCH_ID)
        return
      }
      if (nav.view === 'search') {
        focusWhenReady(SEARCH_QUERY_ID)
        return
      }
      go('search')
      focusWhenReady(SEARCH_QUERY_ID)
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      const mod = event.ctrlKey || event.metaKey
      const key = event.key.toLowerCase()

      if (mod && key === 'k') {
        event.preventDefault()
        focusSearch()
        return
      }

      if (mod && key === 'n') {
        event.preventDefault()
        if (recording) {
          go('live')
          return
        }
        void startRecording({
          targets: { system: true, mic: settings?.captureMic ?? true },
          model: settings?.whisperModel,
          keepAudio: settings?.keepAudio
        })
        return
      }

      if (!mod && !event.altKey && event.key === '/' && !isTypingTarget(event.target)) {
        event.preventDefault()
        focusSearch()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [nav.view, recording, settings])

  return null
}
