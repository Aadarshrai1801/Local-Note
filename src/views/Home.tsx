/**
 * Home: start a recording, or pick up where you left off.
 *
 * The start affordance is the page's headline. It is left-aligned and large,
 * but deliberately uncoloured — amber only appears once capture is running.
 */
import { useState, type ReactNode } from 'react'
import { api } from '@/lib/api'
import { formatDurationCompact, plural } from '@/lib/format'
import { useAsyncData } from '@/lib/hooks'
import {
  go,
  setSearchQuery,
  startRecording,
  useMeetingsRevision,
  useSettings,
  useStatus
} from '@/lib/store'
import { Button } from '@/components/Button'
import { EmptyState, ErrorState, LoadingBlock } from '@/components/EmptyState'
import { Icon } from '@/components/Icon'
import { MeetingList } from '@/components/MeetingList'

export function Home(): ReactNode {
  const { status, loaded } = useStatus()
  const settings = useSettings()
  const revision = useMeetingsRevision()
  const [title, setTitle] = useState('')
  const [agenda, setAgenda] = useState('')
  const [captureMic, setCaptureMic] = useState(true)
  const [captureSystem, setCaptureSystem] = useState(true)
  const [starting, setStarting] = useState(false)
  const [query, setQuery] = useState('')

  const meetings = useAsyncData(() => api.listMeetings(), [revision], {
    toastOnError: 'Could not load your meetings'
  })

  const sttMissing = loaded && status != null && !status.stt.available

  const handleStart = async (): Promise<void> => {
    setStarting(true)
    await startRecording({
      title: title.trim() || undefined,
      briefNotes: agenda.trim() || undefined,
      targets: { system: captureSystem, mic: captureMic },
      model: settings?.whisperModel,
      keepAudio: settings?.keepAudio
    })
    setStarting(false)
    setTitle('')
    setAgenda('')
  }

  const submitSearch = (): void => {
    const trimmed = query.trim()
    if (trimmed.length === 0) return
    setSearchQuery(trimmed)
    go('search')
  }

  const list = meetings.data ?? []
  const totalMs = list.reduce((sum, m) => sum + (m.durationMs ?? 0), 0)

  return (
    <div className="mx-auto w-full max-w-5xl px-8 py-9 lg:px-12">
      {/* Start ------------------------------------------------------- */}
      <section aria-labelledby="start-heading">
        <p className="eyebrow">New recording</p>
        <h1
          id="start-heading"
          className="mt-2 max-w-[26ch] text-[34px] font-medium leading-[1.1] tracking-[-0.03em] text-ink-50"
        >
          Capture the meeting, keep the notes on this machine.
        </h1>
        <p className="mt-3 max-w-[62ch] text-[13.5px] leading-relaxed text-ink-400">
          System audio is recorded from your speakers and your microphone in parallel, transcribed
          locally, then summarised once you stop. Nothing is uploaded and there is no account.
        </p>

        <div className="mt-6 rounded-md border border-ink-800 bg-ink-900/60">
          <div className="grid gap-4 p-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div className="space-y-2">
              <label htmlFor="home-title" className="eyebrow block">
                Meeting title
              </label>
              <input
                id="home-title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !sttMissing) void handleStart()
                }}
                placeholder="Weekly product sync"
                className="field"
                autoComplete="off"
                spellCheck={false}
              />
              <p className="text-[12px] text-ink-500">
                Optional — you can rename the meeting later from its detail view.
              </p>
            </div>
            <div className="space-y-2">
              <label htmlFor="home-agenda" className="eyebrow block">
                Agenda (optional)
              </label>
              <textarea
                id="home-agenda"
                value={agenda}
                onChange={(event) => setAgenda(event.target.value)}
                rows={3}
                placeholder="What needs to happen in this meeting?"
                className="field resize-y leading-relaxed"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-x-5 gap-y-3 border-t border-ink-800/80 px-5 py-3.5">
            <label className="flex cursor-pointer items-center gap-2 text-[13px] text-ink-300">
              <input
                type="checkbox"
                checked={captureSystem}
                onChange={(event) => setCaptureSystem(event.target.checked)}
                className="h-3.5 w-3.5 accent-signal-500"
              />
              <Icon name="monitor" size={14} className="text-ink-500" />
              System audio
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-[13px] text-ink-300">
              <input
                type="checkbox"
                checked={captureMic}
                onChange={(event) => setCaptureMic(event.target.checked)}
                className="h-3.5 w-3.5 accent-signal-500"
              />
              <Icon name="mic" size={14} className="text-ink-500" />
              Microphone
            </label>
            {settings?.whisperModel && (
              <span className="chip">model · {settings.whisperModel}</span>
            )}
            <span className="chip">audio kept · {settings?.keepAudio ? 'yes' : 'no'}</span>

            <Button
              variant="primary"
              size="lg"
              className="ml-auto min-w-[11rem]"
              loading={starting}
              disabled={sttMissing || (!captureMic && !captureSystem)}
              onClick={() => void handleStart()}
              icon={<Icon name="play" size={14} />}
            >
              Start recording
            </Button>
          </div>
        </div>

        {sttMissing && (
          <div className="mt-4">
            <ErrorState
              title="Local transcription is not available yet"
              message={
                status?.stt.guidance ??
                status?.stt.error ??
                'No Whisper model is installed, so recordings would be captured but never transcribed. Set it up first — it is a one-time step.'
              }
              compact
            />
            <div className="mt-3">
              <Button
                variant="secondary"
                size="sm"
                icon={<Icon name="arrowUpRight" size={13} />}
                onClick={() => go('setup')}
              >
                Open setup
              </Button>
            </div>
          </div>
        )}
      </section>

      {/* Meetings ---------------------------------------------------- */}
      <section aria-labelledby="meetings-heading" className="mt-12">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="eyebrow">Recorded meetings</p>
            <h2
              id="meetings-heading"
              className="mt-1.5 text-[19px] font-medium tracking-[-0.02em] text-ink-100"
            >
              {list.length > 0 ? (
                <>
                  {plural(list.length, 'meeting')}
                  <span className="ml-2 font-mono text-[12px] font-normal tracking-normal text-ink-500">
                    {formatDurationCompact(totalMs)} transcribed
                  </span>
                </>
              ) : (
                'Nothing recorded yet'
              )}
            </h2>
          </div>

          <form
            className="relative w-full max-w-sm"
            onSubmit={(event) => {
              event.preventDefault()
              submitSearch()
            }}
            role="search"
          >
            <Icon
              name="search"
              size={15}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-500"
            />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search every transcript…"
              aria-label="Search every transcript"
              className="field pl-9"
            />
            <button
              type="submit"
              onClick={submitSearch}
              className="sr-only"
            >
              Search
            </button>
          </form>
        </div>

        <div className="mt-6">
          {meetings.error && list.length === 0 ? (
            <ErrorState message={meetings.error} onRetry={meetings.refresh} />
          ) : meetings.loading && list.length === 0 ? (
            <LoadingBlock label="Loading your meetings…" />
          ) : null}

          {!meetings.loading && !meetings.error && list.length === 0 && (
            <EmptyState
              eyebrow="No meetings"
              title="Your first transcript will appear here"
              description={
                <>
                  Press <span className="text-ink-200">Start recording</span> when your next call
                  begins. Everything — audio, transcript, summary — stays in your local data
                  folder.
                </>
              }
              action={
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => go('settings')}
                  icon={<Icon name="sliders" size={13} />}
                >
                  Review capture settings
                </Button>
              }
            />
          )}

          {list.length > 0 && (
            <MeetingList meetings={list} loading={meetings.loading} />
          )}
        </div>
      </section>

      {/* Local-only footnote --------------------------------------- */}
      <section className="mt-14 border-t border-ink-800 pt-5">
        <p className="flex items-start gap-2 text-[12.5px] leading-relaxed text-ink-500">
          <Icon name="shield" size={14} className="mt-0.5 shrink-0 text-ink-600" />
          <span className="max-w-[68ch]">
            All processing is local. Audio is written to a folder you choose, transcription runs on
            this CPU, and summaries use a local model if one is running. No account, no telemetry,
            no cloud.
          </span>
        </p>
      </section>
    </div>
  )
}
