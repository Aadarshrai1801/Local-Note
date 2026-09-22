/**
 * The persistent recording strip.
 *
 * It is rendered by the app shell whenever a session is live and the user is
 * not already looking at the Live view, so recording can always be stopped
 * without navigating. Amber appears here and nowhere else except live state.
 */
import { useState, type ReactNode } from 'react'
import { formatClock, formatSeconds } from '@/lib/format'
import { useNow } from '@/lib/hooks'
import { go, stopRecording, useSession } from '@/lib/store'
import { Button } from '@/components/Button'
import { Icon } from '@/components/Icon'
import { LevelMeter } from '@/components/LevelMeter'

export function RecordingBar(): ReactNode {
  const session = useSession()
  const now = useNow(1000, session.active)
  const [stopping, setStopping] = useState(false)

  if (!session.active) return null

  const elapsed = Math.max(
    session.elapsedMs,
    session.startedAt != null ? now - session.startedAt : 0
  )

  const handleStop = async (): Promise<void> => {
    setStopping(true)
    await stopRecording()
    setStopping(false)
  }

  return (
    <div className="animate-fade-up flex shrink-0 items-center gap-4 border-b border-ember-500/25 bg-ember-500/[0.06] px-6 py-2">
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="h-2 w-2 shrink-0 animate-pulse-rec rounded-full bg-ember-400" />
        <span className="shrink-0 font-mono text-[11px] uppercase tracking-[0.14em] text-ember-300">
          Recording
        </span>
        <span className="max-w-[22rem] truncate text-[13px] text-ink-200" title={session.title}>
          {session.title || 'Untitled meeting'}
        </span>
      </div>

      <span className="shrink-0 font-mono text-[15px] tabular-nums tracking-tight text-ink-100">
        {formatClock(elapsed)}
      </span>

      <div className="hidden min-w-[16rem] flex-1 items-center gap-5 lg:flex">
        {session.levels.system != null && (
          <LevelMeter stream="system" level={session.levels.system} compact className="flex-1" />
        )}
        {session.levels.mic != null && (
          <LevelMeter stream="mic" level={session.levels.mic} compact className="flex-1" />
        )}
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-3">
        {session.backlogSeconds > 0.4 && (
          <span className="hidden font-mono text-[11px] text-ink-400 xl:inline">
            transcribing… {formatSeconds(session.backlogSeconds)} behind
          </span>
        )}
        <Button size="sm" variant="ghost" icon={<Icon name="waveform" size={14} />} onClick={() => go('live')}>
          Open live view
        </Button>
        <Button
          size="sm"
          variant="live"
          loading={stopping}
          icon={<Icon name="stop" size={13} />}
          onClick={() => void handleStop()}
        >
          Stop recording
        </Button>
      </div>
    </div>
  )
}
