/**
 * The persistent recording strip.
 *
 * It is rendered by the app shell whenever a session is live and the user is
 * not already looking at the Live view, so recording can always be stopped
 * without navigating. It floats above the content with the glass treatment and
 * is the one place amber appears while a session is running.
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
    <div className="flex shrink-0 justify-center px-6 pt-4">
      <div className="glass animate-fade-up flex w-full max-w-4xl items-center gap-x-4 rounded-full py-2 pl-4 pr-2">
        <span className="h-2 w-2 shrink-0 animate-pulse-rec rounded-full bg-ember-400" />
        <span className="hidden shrink-0 font-mono text-[11px] uppercase tracking-[0.14em] text-ember-300 sm:inline">
          Recording
        </span>
        <span
          className="min-w-0 max-w-[18rem] truncate text-[13px] text-ink-100"
          title={session.title}
        >
          {session.title || 'Untitled meeting'}
        </span>

        <span className="shrink-0 font-mono text-[15px] tabular-nums tracking-tight text-ink-50">
          {formatClock(elapsed)}
        </span>

        <div className="hidden min-w-0 flex-1 items-center gap-5 lg:flex">
          {session.levels.system != null && (
            <LevelMeter stream="system" level={session.levels.system} compact className="flex-1" />
          )}
          {session.levels.mic != null && (
            <LevelMeter stream="mic" level={session.levels.mic} compact className="flex-1" />
          )}
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-2">
          {session.backlogSeconds > 0.4 && (
            <span className="hidden font-mono text-[11px] text-ink-400 xl:inline">
              transcribing… {formatSeconds(session.backlogSeconds)} behind
            </span>
          )}
          <Button
            size="sm"
            variant="ghost"
            icon={<Icon name="waveform" size={14} />}
            onClick={() => go('live')}
          >
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
    </div>
  )
}
