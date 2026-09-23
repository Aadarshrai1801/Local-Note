/**
 * The application shell: sidebar, view switch, recording strip, toasts.
 *
 * Routing is intentionally tiny — a view name plus an optional meeting id in
 * the store — which keeps the whole thing readable and lets the main process
 * drive navigation through the `navigate` event.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { api } from '@/lib/api'
import { cx } from '@/lib/format'
import { useAsyncData } from '@/lib/hooks'
import {
  go,
  isSetupDismissed,
  StoreProvider,
  useBusy,
  useIsRecording,
  useNav,
  useStatus,
  useStore
} from '@/lib/store'
import { RecordingBar } from '@/components/RecordingBar'
import { Sidebar } from '@/components/Sidebar'
import { GlobalShortcuts } from '@/components/GlobalShortcuts'
import { ToastViewport } from '@/components/Toast'
import { Dictionary } from '@/views/Dictionary'
import { Home } from '@/views/Home'
import { Live } from '@/views/Live'
import { MeetingDetailView } from '@/views/MeetingDetail'
import { Search } from '@/views/Search'
import { Settings } from '@/views/Settings'
import { Setup } from '@/views/Setup'
import { Snippets } from '@/views/Snippets'

function BusyIndicator(): ReactNode {
  const busy = useBusy()
  if (!busy) return null
  const progress = busy.progress
  return (
    <div
      className="pointer-events-none absolute inset-x-0 top-0 z-30"
      role="status"
      aria-live="polite"
    >
      <div className="h-px w-full bg-ink-800/60">
        {progress == null ? (
          <div className="h-px w-1/4 animate-shimmer bg-gradient-to-r from-transparent via-ink-200/80 to-transparent bg-[length:200%_100%]" />
        ) : (
          <div
            className="h-px bg-ink-200/80 transition-[width] duration-300 ease-spring"
            style={{ width: `${Math.round(Math.max(0, Math.min(1, progress)) * 100)}%` }}
          />
        )}
      </div>
      <p className="glass-strong absolute left-1/2 top-2 -translate-x-1/2 rounded-full px-3 py-1 font-mono text-[10px] uppercase tracking-[0.1em] text-ink-300">
        {busy.label}
      </p>
    </div>
  )
}

/**
 * Decides whether the app should open on the setup screen: something required
 * is missing *and* there is nothing recorded yet. Once the user skips it, we
 * never send them back there uninvited.
 */
function FirstRunRedirect(): ReactNode {
  const { bootstrapped, nav } = useStore()
  const { status, loaded } = useStatus()
  const [decided, setDecided] = useState(false)

  const probe = useAsyncData(
    async () => {
      const [checks, meetings] = await Promise.all([api.runSetupChecks(), api.listMeetings()])
      return { checks, meetingCount: meetings.length }
    },
    [],
    {}
  )

  useEffect(() => {
    if (decided || !bootstrapped || !loaded || probe.data == null) return
    setDecided(true)
    if (nav.view !== 'home') return
    const missing = probe.data.checks.some((check) => check.status === 'missing')
    const sttMissing = status != null && !status.stt.available
    if (!isSetupDismissed() && missing && sttMissing && probe.data.meetingCount === 0) {
      go('setup')
    }
  }, [decided, bootstrapped, loaded, probe.data, nav.view, status])

  return null
}

function CurrentView(): ReactNode {
  const nav = useNav()
  switch (nav.view) {
    case 'live':
      return <Live />
    case 'meeting':
      return <MeetingDetailView meetingId={nav.meetingId} />
    case 'search':
      return <Search />
    case 'dictionary':
      return <Dictionary />
    case 'snippets':
      return <Snippets />
    case 'settings':
      return <Settings />
    case 'setup':
      return <Setup />
    case 'home':
    default:
      return <Home />
  }
}

function Shell(): ReactNode {
  const nav = useNav()
  const recordingActive = useIsRecording()
  const isLiveView = nav.view === 'live'

  return (
    <div className="flex h-full min-h-0 overflow-hidden bg-ink-950 text-ink-100">
      <Sidebar />
      <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        <BusyIndicator />
        <FirstRunRedirect />
        <GlobalShortcuts />
        {recordingActive && !isLiveView && <RecordingBar />}
        <div
          className={cx(
            'min-h-0 flex-1',
            isLiveView ? 'overflow-hidden' : 'overflow-y-auto'
          )}
        >
          <CurrentView />
        </div>
      </main>
      <ToastViewport />
    </div>
  )
}

export function App(): ReactNode {
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  )
}
