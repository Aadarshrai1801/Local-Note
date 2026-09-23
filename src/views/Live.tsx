/**
 * Live view — the core screen.
 *
 * Layout is a fixed header (recording state, levels, backlog, stop), an
 * optional brief, and one scrolling transcript. Nothing here is modal: the
 * "What did I miss?" answer opens as a dismissible inline panel so it can never
 * block the transcript that is still arriving.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { Meeting, SessionState } from '@shared/types'
import { api } from '@/lib/api'
import { cx, formatClock, formatSeconds } from '@/lib/format'
import { useAsyncData, useEscape, useNow } from '@/lib/hooks'
import {
  attempt,
  bumpRevision,
  go,
  startRecording,
  stopRecording,
  useBusy,
  useLiveSegments,
  useMeetingRevision,
  useSession,
  useSettings
} from '@/lib/store'
import { Button, IconButton } from '@/components/Button'
import { EmptyState } from '@/components/EmptyState'
import { Icon } from '@/components/Icon'
import { LevelMeter } from '@/components/LevelMeter'
import { BriefPanel } from '@/components/BriefPanel'
import { TranscriptList } from '@/components/TranscriptList'

export function Live(): ReactNode {
  const session = useSession()
  const segments = useLiveSegments()
  const settings = useSettings()
  const revision = useMeetingRevision(session.meetingId)
  const [missed, setMissed] = useState<{ text: string; at: number } | null>(null)
  const [missedBusy, setMissedBusy] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [starting, setStarting] = useState(false)

  useEscape(() => setMissed(null), missed != null)

  const meeting = useAsyncData<Meeting | null>(
    () => (session.meetingId ? api.getMeeting(session.meetingId).then((d) => d?.meeting ?? null) : Promise.resolve(null)),
    [session.meetingId, revision]
  )

  // A fresh session invalidates any stale "what did I miss" answer.
  useEffect(() => {
    setMissed(null)
  }, [session.meetingId])

  const handleMissed = useCallback(async () => {
    setMissedBusy(true)
    const text = await attempt(() => api.whatDidIMiss(settings?.missedWindowMinutes), {
      errorPrefix: 'Could not build a recap'
    })
    setMissedBusy(false)
    if (text) setMissed({ text, at: Date.now() })
  }, [settings?.missedWindowMinutes])

  const handleStop = async (): Promise<void> => {
    setStopping(true)
    await stopRecording()
    setStopping(false)
  }

  const handleStart = async (): Promise<void> => {
    setStarting(true)
    await startRecording({
      targets: { system: true, mic: settings?.captureMic ?? true },
      model: settings?.whisperModel,
      keepAudio: settings?.keepAudio
    })
    setStarting(false)
  }

  if (!session.active) {
    return (
      <div className="mx-auto w-full max-w-3xl px-8 py-12 lg:px-12">
        <p className="eyebrow">Live transcript</p>
        <h1 className="mt-2 text-[26px] font-medium tracking-[-0.025em] text-ink-50">
          Nothing is recording
        </h1>
        <p className="mt-3 max-w-[60ch] text-[13.5px] leading-relaxed text-ink-400">
          Start a session to watch the transcript arrive line by line. Lines are written to the
          local database as they are recognised, so a crash never loses what was already said.
        </p>
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Button
            variant="accent"
            size="lg"
            loading={starting}
            icon={<Icon name="play" size={14} />}
            onClick={() => void handleStart()}
          >
            Start recording
          </Button>
          <Button variant="ghost" size="md" onClick={() => go('home')}>
            Back to Home
          </Button>
        </div>
        <div className="mt-8">
          <EmptyState
            compact
            title="Tip: give the meeting a title first"
            description="A title makes the meeting list and search results readable later. You can also add an agenda on Home, which the summary will use as context."
          />
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <LiveHeader
        session={session}
        stopping={stopping}
        missedBusy={missedBusy}
        onStop={() => void handleStop()}
        onMissed={() => void handleMissed()}
        hasMissed={missed != null}
      />

      {session.warnings.length > 0 && (
        <div className="shrink-0 border-b border-ember-500/25 bg-ember-500/[0.06] px-6 py-2.5">
          <ul className="space-y-1">
            {session.warnings.map((warning) => (
              <li key={warning} className="flex items-start gap-2 text-[13px] text-ember-200">
                <Icon name="alert" size={14} className="mt-0.5 shrink-0 text-ember-400" />
                <span>{warning}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {session.error && (
        <div className="shrink-0 border-b border-danger-500/30 bg-danger-500/[0.07] px-6 py-2.5">
          <p className="flex items-start gap-2 text-[13px] text-danger-400">
            <Icon name="alert" size={14} className="mt-0.5 shrink-0 text-danger-400" />
            <span>{session.error}</span>
          </p>
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-4 px-6 py-5">
        <div className="flex flex-wrap items-start gap-4">
          <div className="min-w-0 flex-1">
            <BriefPanel
              meeting={meeting.data}
              loading={meeting.loading && meeting.data == null}
              onSaved={() => {
                if (session.meetingId) bumpRevision(session.meetingId)
              }}
            />
          </div>
          {missed && (
            <MissedPanel
              text={missed.text}
              at={missed.at}
              onDismiss={() => setMissed(null)}
              onRefresh={() => void handleMissed()}
              refreshing={missedBusy}
            />
          )}
        </div>

        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-baseline gap-3 pb-2">
            <h2 className="eyebrow text-ink-400">Transcript</h2>
            <span className="font-mono text-[11px] text-ink-600">
              {segments.length} lines
            </span>
            <span aria-hidden="true" className="h-px flex-1 bg-ink-800/70" />
            <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-600">
              newest at the bottom
            </span>
          </div>
          <TranscriptList segments={segments} live showSource />
        </div>
      </div>
    </div>
  )
}

interface LiveHeaderProps {
  session: SessionState
  stopping: boolean
  missedBusy: boolean
  hasMissed: boolean
  onStop: () => void
  onMissed: () => void
}

function LiveHeader({
  session,
  stopping,
  missedBusy,
  hasMissed,
  onStop,
  onMissed
}: LiveHeaderProps): ReactNode {
  const now = useNow(1000, session.active)
  const busy = useBusy()
  const elapsed = Math.max(
    session.elapsedMs,
    session.startedAt != null ? now - session.startedAt : 0
  )
  const behind = session.backlogSeconds

  return (
    <header className="shrink-0 border-b border-ember-500/25 bg-ember-500/[0.05]">
      {/* Row 1 — identity and controls */}
      <div className="flex items-center gap-4 px-6 py-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <span className="h-2.5 w-2.5 shrink-0 animate-pulse-rec rounded-full bg-ember-400" />
          <span className="shrink-0 font-mono text-[11px] uppercase tracking-[0.14em] text-ember-300">
            Recording
          </span>
          <h1
            className="min-w-0 truncate text-[15px] font-medium tracking-[-0.01em] text-ink-50"
            title={session.title}
          >
            {session.title || 'Untitled meeting'}
          </h1>
        </div>

        <div className="flex shrink-0 items-center gap-2.5">
          <Button
            variant="secondary"
            size="md"
            loading={missedBusy}
            aria-expanded={hasMissed}
            icon={<Icon name="message" size={14} />}
            onClick={onMissed}
          >
            What did I miss?
          </Button>
          <Button
            variant="live"
            size="md"
            loading={stopping}
            icon={<Icon name="stop" size={13} />}
            onClick={onStop}
          >
            Stop recording
          </Button>
        </div>
      </div>

      {/* Row 2 — capture telemetry */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-ember-500/15 px-6 py-2">
        <span className="shrink-0 font-mono text-[20px] leading-none tabular-nums tracking-tight text-ink-50">
          {formatClock(elapsed)}
        </span>
        <span className="shrink-0 font-mono text-[11px] text-ink-500">
          {session.startedAt
            ? `started ${new Date(session.startedAt).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
                hour12: false
              })}`
            : ''}
        </span>

        {session.levels.system != null ? (
          <LevelMeter
            stream="system"
            level={session.levels.system}
            className="min-w-[10rem] max-w-[18rem] flex-1"
          />
        ) : null}
        {session.levels.mic != null ? (
          <LevelMeter
            stream="mic"
            level={session.levels.mic}
            className="min-w-[10rem] max-w-[18rem] flex-1"
          />
        ) : null}

        <div className="ml-auto flex shrink-0 items-center gap-3">
          {session.levels.system == null && session.levels.mic == null && elapsed < 4000 && (
            <span className="font-mono text-[11px] text-ink-500">waiting for the first buffers…</span>
          )}
          <BacklogHint
            queueDepth={session.queueDepth}
            backlogSeconds={behind}
            busyLabel={busy?.label ?? null}
          />
        </div>
      </div>
    </header>
  )
}

function BacklogHint({
  queueDepth,
  backlogSeconds,
  busyLabel
}: {
  queueDepth: number
  backlogSeconds: number
  busyLabel: string | null
}): ReactNode {
  if (busyLabel) {
    return (
      <span className="hidden items-center gap-1.5 font-mono text-[11px] text-signal-300 lg:flex">
        <Icon name="sparkle" size={12} className="shrink-0" />
        {busyLabel}
      </span>
    )
  }
  if (backlogSeconds < 0.4 && queueDepth === 0) {
    return (
      <span className="hidden items-center gap-1.5 font-mono text-[11px] text-ink-500 lg:flex">
        <Icon name="check" size={12} className="shrink-0 text-ink-600" />
        caught up
      </span>
    )
  }
  return (
    <span
      className="hidden items-center gap-1.5 font-mono text-[11px] text-ink-400 lg:flex"
      title={`${queueDepth} chunk${queueDepth === 1 ? '' : 's'} waiting`}
    >
      <Icon name="clock" size={12} className="shrink-0 text-ink-600" />
      transcribing… {formatSeconds(backlogSeconds)} behind
    </span>
  )
}

interface MissedPanelProps {
  text: string
  at: number
  refreshing: boolean
  onDismiss: () => void
  onRefresh: () => void
}

/** Inline, dismissible, and deliberately not a modal. */
function MissedPanel({
  text,
  at,
  refreshing,
  onDismiss,
  onRefresh
}: MissedPanelProps): ReactNode {
  return (
    <section
      aria-label="What did I miss"
      className="animate-fade-up w-full max-w-md shrink-0 rounded-panel border border-signal-500/30 bg-signal-500/[0.06] lg:w-[26rem]"
    >
      <div className="flex items-center gap-2 border-b border-signal-500/20 px-3.5 py-2">
        <Icon name="sparkle" size={13} className="shrink-0 text-signal-400" />
        <h2 className="flex-1 font-mono text-[11px] uppercase tracking-[0.14em] text-signal-300">
          What did I miss
        </h2>
        <span className="font-mono text-[10px] text-signal-400/70">
          {new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}
        </span>
        <IconButton label="Refresh recap" size="sm" onClick={onRefresh} disabled={refreshing}>
          <Icon name="refresh" size={13} />
        </IconButton>
        <IconButton label="Dismiss recap" size="sm" onClick={onDismiss}>
          <Icon name="x" size={13} />
        </IconButton>
      </div>
      <div className="max-h-56 overflow-y-auto px-3.5 py-3">
        <p className={cx('whitespace-pre-line text-[13px] leading-relaxed text-ink-200')}>{text}</p>
      </div>
      <p className="border-t border-signal-500/15 px-3.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-signal-400/60">
        generated locally · press esc to dismiss
      </p>
    </section>
  )
}
