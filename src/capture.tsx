import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { MainEvent, SessionState, StreamLevel } from '@shared/types'
import { api } from './lib/api'
import './index.css'

/**
 * The floating capture bar.
 *
 * Design intent: invisible until needed. At rest it is a small, dim pill that
 * gets out of the way. While recording it comes alive with audio-level bars
 * driven by the real microphone and system levels, so the user can see at a
 * glance that it is actually hearing something.
 *
 * Deliberately no live transcript. Streaming text into a 260px bar is
 * unreadable and jitters constantly; the transcript belongs in the Hub.
 */

const BAR_COUNT = 7

/** Symmetric envelope so the meter reads as a waveform rather than a block. */
const BAR_ENVELOPE = [0.45, 0.7, 0.9, 1, 0.9, 0.7, 0.45]

/** Tallest the bars get, in pixels. Matches the meter container height. */
const BAR_MAX_HEIGHT = 26

interface BarState {
  /** Combined loudness across the active streams. */
  level: number
  /** True when a stream that should be producing audio is silent. */
  starved: boolean
}

function readBars(state: SessionState | null): BarState {
  if (!state?.active) return { level: 0, starved: false }

  const levels = [state.levels.system, state.levels.mic].filter(
    (level): level is StreamLevel => level !== null
  )
  if (levels.length === 0) return { level: 0, starved: false }

  const loudest = Math.max(...levels.map((level) => level.rms))
  // "Starved" means the app is recording but hearing nothing at all — the
  // failure mode that silently ruins a transcript.
  const starved = levels.every((level) => level.dead || level.rms < 0.0005)
  return { level: loudest, starved }
}

function CaptureBar(): React.ReactElement {
  const [session, setSession] = useState<SessionState | null>(null)
  const [hovered, setHovered] = useState(false)
  const [busy, setBusy] = useState(false)
  const [justSaved, setJustSaved] = useState(false)
  const smoothed = useRef(0)

  useEffect(() => {
    let cancelled = false

    void api
      .getSession()
      .then((state) => {
        if (!cancelled) setSession(state)
      })
      .catch(() => undefined)

    const unsubscribe = api.onEvent((event: MainEvent) => {
      if (event.type === 'session') setSession(event.state)
      if (event.type === 'busy') setBusy(Boolean(event.label))
    })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  const { level, starved } = useMemo(() => readBars(session), [session])
  const recording = Boolean(session?.active)

  // Smooth the level so the bars glide instead of flickering between packets.
  const [displayLevel, setDisplayLevel] = useState(0)
  useEffect(() => {
    const target = recording ? level : 0
    smoothed.current = smoothed.current + (target - smoothed.current) * 0.35
    setDisplayLevel(smoothed.current)
  }, [level, recording])

  // A brief, quiet confirmation that something was saved.
  const wasRecording = useRef(false)
  useEffect(() => {
    if (wasRecording.current && !recording && !busy) {
      setJustSaved(true)
      const timer = setTimeout(() => setJustSaved(false), 2200)
      return () => clearTimeout(timer)
    }
    wasRecording.current = recording
    return undefined
  }, [recording, busy])

  const toggle = async (): Promise<void> => {
    try {
      if (recording) {
        await api.stopRecording()
      } else {
        await api.startRecording({})
      }
    } catch {
      // The Hub surfaces errors; the bar stays quiet so it never becomes a
      // source of noise while the user is in a meeting.
    }
  }

  /**
   * Double-clicking the bar opens the Hub.
   *
   * The Hub can be closed while the app keeps running with only this bar, so
   * the bar needs a way back that does not depend on finding the tray icon.
   */
  const openHub = (): void => {
    void api.openHub().catch(() => undefined)
  }

  const elapsed = session?.elapsedMs ?? 0
  const timer = recording ? formatClock(elapsed) : null

  return (
    <div
      className="flex h-full w-full items-end justify-center pb-1"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div
        onDoubleClick={openHub}
        title={recording ? 'Recording — double-click to open Local Note' : 'Double-click to open Local Note'}
        className={[
          'drag-region flex h-[48px] w-full items-center gap-3 rounded-full px-3',
          'glass transition-all duration-200 ease-spring',
          recording ? 'opacity-100' : hovered ? 'opacity-100' : 'opacity-45',
          recording ? 'ring-1 ring-ember-400/30' : ''
        ].join(' ')}
      >
        {/* Status / capture control */}
        <button
          type="button"
          onClick={() => void toggle()}
          title={recording ? 'Stop recording' : 'Start recording'}
          className={[
            'no-drag grid h-8 w-8 shrink-0 place-items-center rounded-full',
            'transition-all duration-150 ease-spring active:scale-95',
            recording
              ? 'bg-ember-400 text-ink-950'
              : 'bg-ink-800/80 text-ink-300 hover:bg-ink-700 hover:text-ink-100'
          ].join(' ')}
        >
          {recording ? <StopGlyph /> : <MicGlyph />}
        </button>

        {/* Audio level bars — the only live feedback in the bar */}
        <div className="flex h-7 flex-1 items-center justify-center gap-[3px]">
          {Array.from({ length: BAR_COUNT }).map((_, index) => (
            <Bar
              key={index}
              index={index}
              level={displayLevel}
              recording={recording}
              starved={starved}
            />
          ))}
        </div>

        {/* Timer or a quiet saved confirmation */}
        <div className="w-[62px] shrink-0 text-right">
          {timer ? (
            <span className="font-mono text-[12px] tabular-nums text-ink-100">{timer}</span>
          ) : justSaved ? (
            <span className="animate-fade-up text-[11px] font-medium text-ink-300">Saved</span>
          ) : busy ? (
            <span className="animate-pulse text-[11px] text-ink-400">···</span>
          ) : (
            <span className="text-[11px] text-ink-500">{hovered ? 'Ready' : ''}</span>
          )}
        </div>
      </div>
    </div>
  )
}

function Bar({
  index,
  level,
  recording,
  starved
}: {
  index: number
  level: number
  recording: boolean
  starved: boolean
}): React.ReactElement {
  const envelope = BAR_ENVELOPE[index] ?? 1
  const scale = recording ? Math.max(0.12, level * envelope) : 0.16

  return (
    <span
      className={[
        'w-[4px] rounded-full transition-[height] duration-100 ease-out',
        starved ? 'bg-ink-600' : recording ? 'bg-ember-400' : 'bg-ink-600'
      ].join(' ')}
      style={{ height: `${Math.round(scale * BAR_MAX_HEIGHT)}px` }}
    />
  )
}

function MicGlyph(): React.ReactElement {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v4" />
    </svg>
  )
}

function StopGlyph(): React.ReactElement {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="6" width="12" height="12" rx="2.5" />
    </svg>
  )
}

function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

const container = document.getElementById('capture-root')
if (container) {
  createRoot(container).render(
    <React.StrictMode>
      <CaptureBar />
    </React.StrictMode>
  )
}
