/**
 * Fixed navigation rail: wordmark, the four primary views, and the recording
 * control.
 *
 * The "Start recording" button is deliberately neutral in colour. Amber is
 * reserved for the moment capture is actually running, so the rail's bottom
 * slot switches to a live indicator (amber dot, timer, stop) only when it is.
 */
import { useState, type ReactNode } from 'react'
import { cx, formatClock } from '@/lib/format'
import { useNow } from '@/lib/hooks'
import { isMockApi } from '@/lib/api'
import {
  go,
  startRecording,
  stopRecording,
  useBusy,
  useIsRecording,
  useNav,
  useSessionField,
  useStatus,
  type ViewName
} from '@/lib/store'
import { Button } from '@/components/Button'
import { Icon, LogoMark, type IconName } from '@/components/Icon'
import { Kbd } from '@/components/Kbd'

interface NavItem {
  view: ViewName
  label: string
  icon: IconName
}

const NAV_ITEMS: NavItem[] = [
  { view: 'home', label: 'Home', icon: 'home' },
  { view: 'dictionary', label: 'Dictionary', icon: 'book' },
  { view: 'snippets', label: 'Snippets', icon: 'layers' },
  { view: 'settings', label: 'Settings', icon: 'sliders' }
]

export function Sidebar(): ReactNode {
  const nav = useNav()
  const recording = useIsRecording()
  const startedAt = useSessionField((session) => session.startedAt)
  const sessionTitle = useSessionField((session) => session.title)
  const { status } = useStatus()
  const busy = useBusy()
  const now = useNow(1000, recording)
  const [starting, setStarting] = useState(false)
  const [stopping, setStopping] = useState(false)

  const sttMissing = status != null && !status.stt.available
  const elapsed = startedAt != null ? Math.max(0, now - startedAt) : 0

  const handleStart = async (): Promise<void> => {
    setStarting(true)
    await startRecording({ targets: { system: true, mic: true } })
    setStarting(false)
  }

  const handleStop = async (): Promise<void> => {
    setStopping(true)
    await stopRecording()
    setStopping(false)
  }

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-ink-800 bg-ink-950">
      {/* Wordmark */}
      <div className="px-5 pb-6 pt-6">
        <div className="flex items-center gap-2.5">
          <LogoMark
            size={22}
            className={cx('shrink-0', recording ? 'text-ember-400' : 'text-ink-400')}
          />
          <div className="leading-none">
            <p className="text-[15px] font-semibold uppercase tracking-[0.22em] text-ink-100">
              Local
            </p>
            <p className="text-[15px] font-semibold uppercase tracking-[0.22em] text-ink-400">
              Note
            </p>
          </div>
        </div>
        <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-500">
          offline meeting notes
        </p>
      </div>

      {/* Primary nav — exactly four destinations. */}
      <nav aria-label="Primary" className="flex-1 space-y-1 px-3">
        {NAV_ITEMS.map((item) => {
          const active = nav.view === item.view
          return (
            <button
              key={item.view}
              type="button"
              aria-current={active ? 'page' : undefined}
              onClick={() => go(item.view)}
              className={cx(
                'group flex w-full items-center gap-2.5 rounded-control px-2.5 py-2 text-left text-[13px] transition-colors duration-150 ease-spring',
                active
                  ? 'bg-ink-850 text-ink-100'
                  : 'text-ink-400 hover:bg-ink-900/60 hover:text-ink-100'
              )}
            >
              <Icon
                name={item.icon}
                size={16}
                className={active ? 'text-ink-200' : 'text-ink-500 group-hover:text-ink-300'}
              />
              {item.label}
            </button>
          )
        })}

        {nav.view === 'meeting' && nav.meetingId && (
          <p className="flex items-center gap-2.5 px-2.5 pt-3 text-[12px] text-ink-500">
            <Icon name="file" size={14} className="text-ink-600" />
            Viewing a meeting
          </p>
        )}
      </nav>

      {/* Recording control + quiet status footer. */}
      <div className="space-y-4 px-3 pb-5 pt-4">
        {recording ? (
          <div className="animate-fade-up space-y-2.5 rounded-card border border-ink-800 bg-ink-900/70 px-3 py-3">
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 animate-pulse-rec rounded-full bg-ember-400" />
              <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-ember-300">
                Recording
              </span>
            </div>
            <p className="font-mono text-[19px] tabular-nums tracking-tight text-ink-100">
              {formatClock(elapsed)}
            </p>
            {sessionTitle && (
              <p className="truncate text-[12px] text-ink-400" title={sessionTitle}>
                {sessionTitle}
              </p>
            )}
            <Button
              size="sm"
              variant="secondary"
              block
              loading={stopping}
              icon={<Icon name="stop" size={13} />}
              onClick={() => void handleStop()}
            >
              Stop recording
            </Button>
            <Button size="sm" variant="ghost" block onClick={() => go('live')}>
              Go to live transcript
            </Button>
          </div>
        ) : (
          <Button
            variant="secondary"
            block
            size="md"
            className="justify-between px-3"
            loading={starting}
            icon={
              <span
                aria-hidden="true"
                className="block h-2.5 w-2.5 rounded-full border border-ink-400"
              />
            }
            iconRight={<Kbd>Ctrl N</Kbd>}
            onClick={() => void handleStart()}
            disabled={sttMissing}
            title={sttMissing ? 'Install the local transcription model first' : undefined}
          >
            Start recording
          </Button>
        )}

        {sttMissing && (
          <button
            type="button"
            onClick={() => go('setup')}
            className="flex w-full items-start gap-2 rounded-control px-2.5 py-1.5 text-left text-[11.5px] leading-snug text-ember-300 transition-colors duration-150 ease-spring hover:bg-ink-900/60 hover:text-ember-200"
          >
            <Icon name="alert" size={13} className="mt-0.5 shrink-0 text-ember-400" />
            <span>
              Transcription unavailable
              <span className="mt-0.5 block text-ink-500">Run the one-time setup →</span>
            </span>
          </button>
        )}

        {/* Progress only. The backend status lines and the privacy notice that
            used to sit here were removed: status is already on the Setup and
            Diagnostics screens, and repeating a privacy claim inside the
            navigation added noise without adding information. */}
        {busy && (
          <p className="flex items-center gap-1.5 px-2.5 font-mono text-[10px] uppercase tracking-[0.1em] text-ink-500">
            <span className="h-1 w-1 animate-pulse rounded-full bg-signal-400" />
            <span className="truncate">{busy.label}</span>
          </p>
        )}
        {isMockApi && (
          <p className="px-1 font-mono text-[10px] uppercase tracking-[0.08em] text-ember-400/80">
            browser mock · not recording
          </p>
        )}
      </div>
    </aside>
  )
}
