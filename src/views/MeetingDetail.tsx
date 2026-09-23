/**
 * Meeting detail: title, summary, action items, speakers, transcript, and the
 * per-meeting question box.
 *
 * The page is a two-column editorial layout — transcript on the left (the
 * record, drawn on the light content canvas so long text stays legible) and
 * derived artifacts on the right (the convenience, in the recessive signal
 * treatment). Amber does not appear here at all.
 *
 * Correction inspector: `corrected` marks a segment that the dictionary pass
 * rewrote. The raw wording is replaced in place and not stored, so "View diff"
 * explains what happened and which dictionary spellings are in the line rather
 * than inventing a before/after. See TranscriptList for the rendering.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { DictionaryTerm, SpeakerName } from '@shared/types'
import { api } from '@/lib/api'
import {
  cx,
  copyText,
  formatClock,
  formatDate,
  formatDuration,
  formatTime,
  plural,
  truncate
} from '@/lib/format'
import { useAsyncData, useEscape } from '@/lib/hooks'
import {
  attempt,
  bumpMeetingsRevision,
  bumpRevision,
  go,
  pushToast,
  useBackendBusy,
  useMeetingRevision
} from '@/lib/store'
import { ActionItemList } from '@/components/ActionItemList'
import { Button } from '@/components/Button'
import { EmptyState, ErrorState, Skeleton } from '@/components/EmptyState'
import { ExportMenu, type ExportFormat } from '@/components/ExportMenu'
import { Icon } from '@/components/Icon'
import { TranscriptList } from '@/components/TranscriptList'

export interface MeetingDetailViewProps {
  meetingId: string | null
}

export function MeetingDetailView({ meetingId }: MeetingDetailViewProps): ReactNode {
  const revision = useMeetingRevision(meetingId)
  const backendBusy = useBackendBusy()

  const detail = useAsyncData(
    () => (meetingId ? api.getMeeting(meetingId) : Promise.resolve(null)),
    [meetingId, revision],
    { toastOnError: 'Could not load that meeting' }
  )

  const meeting = detail.data?.meeting ?? null
  const segments = detail.data?.segments ?? []
  const actionItems = detail.data?.actionItems ?? []
  const speakers = detail.data?.speakers ?? []

  const correctedCount = useMemo(
    () => segments.filter((segment) => segment.corrected).length,
    [segments]
  )

  // The dictionary is only needed to explain corrected lines, so it is loaded
  // lazily and not at all for meetings that were never corrected.
  const dictionary = useAsyncData<DictionaryTerm[]>(
    () => (correctedCount > 0 ? api.listDictionary() : Promise.resolve([])),
    [meetingId, correctedCount > 0]
  )
  const corrections = dictionary.data ?? EMPTY_CORRECTIONS

  const [summarizing, setSummarizing] = useState(false)
  const [regenerating, setRegenerating] = useState(false)
  const [question, setQuestion] = useState('')
  const [asking, setAsking] = useState(false)
  const [answer, setAnswer] = useState<string | null>(null)
  const [exporting, setExporting] = useState<ExportFormat | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [renamingSpeaker, setRenamingSpeaker] = useState<string | null>(null)

  useEscape(() => setAnswer(null), answer != null)

  // Reset per-meeting UI state when the selection changes.
  useEffect(() => {
    setAnswer(null)
    setQuestion('')
    setConfirmDelete(false)
    setRenamingSpeaker(null)
  }, [meetingId])

  const speakerLabels = useMemo(() => {
    const seen: string[] = []
    for (const segment of segments) {
      const label = segment.speakerLabel
      if (label && !seen.includes(label)) seen.push(label)
    }
    for (const speaker of speakers) {
      if (!seen.includes(speaker.speakerLabel)) seen.push(speaker.speakerLabel)
    }
    return seen
  }, [segments, speakers])

  const refresh = (): void => {
    if (meetingId) bumpRevision(meetingId)
    detail.refresh()
  }

  const saveTitle = async (next: string): Promise<void> => {
    if (!meeting || !meetingId) return
    const title = next.trim()
    if (title.length === 0 || title === meeting.title) return
    const updated = await attempt(() => api.updateMeeting(meetingId, { title }), {
      errorPrefix: 'Could not rename the meeting'
    })
    if (updated) {
      detail.setData((prev) => (prev ? { ...prev, meeting: updated } : prev))
      bumpMeetingsRevision()
    }
  }

  const generateSummary = async (): Promise<void> => {
    if (!meetingId) return
    setSummarizing(true)
    const updated = await attempt(() => api.generateSummary(meetingId), {
      label: 'Summarising…',
      errorPrefix: 'Could not generate a summary'
    })
    setSummarizing(false)
    if (updated) {
      detail.setData((prev) => (prev ? { ...prev, meeting: updated } : prev))
      bumpMeetingsRevision()
    }
  }

  const regenerateActions = async (): Promise<void> => {
    if (!meetingId) return
    setRegenerating(true)
    const items = await attempt(() => api.regenerateActionItems(meetingId), {
      label: 'Extracting action items…',
      errorPrefix: 'Could not extract action items'
    })
    setRegenerating(false)
    if (items) refresh()
  }

  const ask = async (): Promise<void> => {
    if (!meetingId || question.trim().length === 0) return
    setAsking(true)
    const text = await attempt(() => api.askAboutMeeting(meetingId, question.trim()), {
      label: 'Thinking locally…',
      errorPrefix: 'Could not answer that question'
    })
    setAsking(false)
    if (text != null) setAnswer(text)
  }

  const exportAs = async (format: ExportFormat): Promise<void> => {
    if (!meetingId) return
    setExporting(format)
    const path = await attempt(() => api.exportMeeting(meetingId, format), {
      errorPrefix: `Could not export as ${format}`
    })
    setExporting(null)
    if (path === null) {
      pushToast('warn', 'Export cancelled.')
    } else if (path) {
      pushToast('info', `Exported to ${path}`)
    }
  }

  const renameSpeaker = async (label: string, displayName: string): Promise<void> => {
    if (!meetingId) return
    const ok = await attempt(
      async () => {
        await api.renameSpeaker(meetingId, label, displayName)
        return true
      },
      { errorPrefix: 'Could not rename that speaker' }
    )
    if (ok) {
      setRenamingSpeaker(null)
      refresh()
    }
  }

  const removeMeeting = async (): Promise<void> => {
    if (!meetingId) return
    const ok = await attempt(
      async () => {
        await api.deleteMeeting(meetingId)
        return true
      },
      { errorPrefix: 'Could not delete the meeting' }
    )
    if (ok) {
      pushToast('info', 'Meeting deleted.')
      bumpMeetingsRevision()
      go('home')
    }
  }

  /* ---- states -------------------------------------------------- */

  if (!meetingId) {
    return (
      <div className="mx-auto w-full max-w-3xl px-8 py-12 lg:px-12">
        <EmptyState
          eyebrow="No meeting selected"
          title="Pick a meeting from Home"
          description="Every recording, transcript, summary and action item lives on that meeting's page."
          action={
            <Button variant="secondary" size="sm" onClick={() => go('home')}>
              Back to Home
            </Button>
          }
        />
      </div>
    )
  }

  if (detail.error && !detail.data) {
    return (
      <div className="mx-auto w-full max-w-3xl px-8 py-12 lg:px-12">
        <ErrorState
          title="Could not open that meeting"
          message={detail.error}
          onRetry={detail.refresh}
        />
        <div className="mt-4">
          <Button
            variant="ghost"
            size="sm"
            icon={<Icon name="arrowLeft" size={13} />}
            onClick={() => go('home')}
          >
            Back to Home
          </Button>
        </div>
      </div>
    )
  }

  if (detail.loading && !detail.data) {
    return (
      <div className="mx-auto w-full max-w-6xl px-8 py-10 lg:px-12">
        <Skeleton width="12rem" className="h-3" />
        <Skeleton width="24rem" className="mt-4 h-6" />
        <Skeleton width="18rem" className="mt-3 h-3" />
        <div className="mt-8 grid gap-10 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="rounded-panel border border-ink-800 bg-canvas p-4">
            <div className="space-y-3">
              <Skeleton width="100%" className="h-3.5" onCanvas />
              <Skeleton width="92%" className="h-3.5" onCanvas />
              <Skeleton width="88%" className="h-3.5" onCanvas />
              <Skeleton width="60%" className="h-3.5" onCanvas />
            </div>
          </div>
          <Skeleton width="100%" className="h-36" />
        </div>
      </div>
    )
  }

  if (!meeting) {
    return (
      <div className="mx-auto w-full max-w-3xl px-8 py-12 lg:px-12">
        <EmptyState
          eyebrow="Missing"
          title="That meeting no longer exists"
          description="It may have been deleted from another window."
          action={
            <Button variant="secondary" size="sm" onClick={() => go('home')}>
              Back to Home
            </Button>
          }
        />
      </div>
    )
  }

  const summarized = meeting.summary != null && meeting.summary.trim().length > 0
  const summaryRunning =
    summarizing || (meeting.summaryStatus === 'pending' && backendBusy?.label != null)

  return (
    <div className="mx-auto w-full max-w-6xl px-8 py-8 lg:px-12">
      {/* Header ---------------------------------------------------- */}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          icon={<Icon name="arrowLeft" size={13} />}
          onClick={() => go('home')}
        >
          All meetings
        </Button>
        <span className="font-mono text-[11px] text-ink-500">
          {formatDate(meeting.startedAt)} · {formatTime(meeting.startedAt)} ·{' '}
          {formatDuration(meeting.durationMs)}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <ExportMenu exporting={exporting} onExport={(format) => void exportAs(format)} />
          {meeting.audioPath && (
            <Button
              size="sm"
              variant="secondary"
              icon={<Icon name="waveform" size={13} />}
              onClick={() =>
                void attempt(
                  async () => {
                    await api.revealMeetingAudio(meeting.id)
                    return true
                  },
                  { errorPrefix: 'Could not open the audio file' }
                )
              }
            >
              Reveal audio
            </Button>
          )}
        </div>
      </div>

      <div className="mt-4">
        <InlineTitle value={meeting.title} onSave={(next) => void saveTitle(next)} />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="chip bg-ink-800/70 text-ink-300">
            {plural(meeting.segmentCount, 'line')}
          </span>
          <span className="chip bg-ink-800/70 text-ink-300">
            {plural(meeting.actionItemCount, 'action')}
          </span>
          {meeting.audioPath ? (
            <span className="chip bg-ink-800/70 text-ink-300">
              <Icon name="waveform" size={11} />
              audio kept
            </span>
          ) : (
            <span className="chip bg-ink-800/70 text-ink-300">audio discarded</span>
          )}
          {meeting.summarizedAt && (
            <span className="chip bg-signal-500/15 text-signal-300">
              summarised {formatTime(meeting.summarizedAt)}
            </span>
          )}
          {meeting.summaryStatus === 'failed' && (
            <span className="chip bg-danger-500/10 text-danger-400">summary failed</span>
          )}
        </div>
        {meeting.briefNotes && (
          <details className="mt-4 rounded-control border border-ink-800 bg-ink-900/50">
            <summary className="cursor-pointer px-3.5 py-2 text-[13px] text-ink-300 marker:text-ink-600">
              <span className="eyebrow mr-2 text-ink-500">Brief</span>
              {truncate(meeting.briefNotes, 90)}
            </summary>
            <p className="whitespace-pre-line border-t border-ink-800/70 px-3.5 py-3 text-[13.5px] leading-relaxed text-ink-200">
              {meeting.briefNotes}
            </p>
          </details>
        )}
      </div>

      <div className="mt-8 grid items-start gap-10 lg:grid-cols-[minmax(0,1fr)_22rem]">
        {/* Transcript --------------------------------------------- */}
        <section aria-labelledby="transcript-heading" className="flex min-h-[24rem] flex-col">
          <div className="flex items-baseline gap-3 pb-2">
            <h2 id="transcript-heading" className="eyebrow text-ink-400">
              Transcript
            </h2>
            <span className="font-mono text-[11px] text-ink-500">
              {plural(segments.length, 'line')}
              {correctedCount > 0 && ` · ${plural(correctedCount, 'correction')}`}
            </span>
            <span aria-hidden="true" className="h-px flex-1 bg-ink-800/70" />
            <CopyTranscriptButton
              segments={segments.map((s) => `${formatClock(s.startMs)} ${s.text}`).join('\n')}
            />
          </div>

          <div className="canvas-surface flex min-h-[20rem] flex-1 flex-col rounded-panel border border-ink-800 p-4 shadow-lift">
            <TranscriptList
              segments={segments}
              speakers={speakers}
              showSource
              tone="canvas"
              showCorrections
              corrections={corrections}
              onSpeakerClick={(label) => {
                setRenamingSpeaker(label)
                document
                  .getElementById('speakers')
                  ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
              }}
              emptyState={
                <EmptyState
                  compact
                  tone="canvas"
                  title="No transcript for this meeting"
                  description="Nothing was recognised — the recording may have been silent, or transcription was not available when it ran."
                />
              }
            />
          </div>
        </section>

        {/* Right rail ------------------------------------------- */}
        <aside className="space-y-8">
          {/* Summary */}
          <section aria-labelledby="summary-heading">
            <div className="flex items-center gap-2 pb-2">
              <h2 id="summary-heading" className="eyebrow text-ink-400">
                Summary
              </h2>
              {summarized && <span className="chip bg-signal-500/15 text-signal-300">local model</span>}
              <span aria-hidden="true" className="h-px flex-1 bg-ink-800/70" />
            </div>

            {summaryRunning ? (
              <div className="rounded-panel border border-signal-500/25 bg-signal-500/[0.05] px-3.5 py-3">
                <div className="flex items-center gap-2 text-[13px] text-signal-300">
                  <Icon name="sparkle" size={13} className="animate-pulse" />
                  {backendBusy?.label ?? 'Summarising this meeting…'}
                </div>
                <ProgressRail progress={backendBusy?.progress ?? null} />
                <p className="mt-2 text-[13px] leading-relaxed text-ink-400">
                  Long transcripts are summarised in passes, so this can take a minute. The
                  transcript is already saved.
                </p>
              </div>
            ) : summarized ? (
              <div className="rounded-panel border border-signal-500/25 bg-signal-500/[0.05] px-3.5 py-3">
                <p className="whitespace-pre-line border-l-2 border-signal-500/50 pl-3 text-[13.5px] leading-[1.7] text-ink-100">
                  {meeting.summary}
                </p>
                <div className="mt-3 flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={summarizing}
                    icon={<Icon name="refresh" size={13} />}
                    onClick={() => void generateSummary()}
                  >
                    Regenerate
                  </Button>
                </div>
              </div>
            ) : (
              <EmptyState
                compact
                tone="signal"
                title={
                  meeting.summaryStatus === 'failed' ? 'Summarising failed' : 'No summary yet'
                }
                description={
                  meeting.summaryError ??
                  'Your local model reads the transcript and writes a short brief. Nothing leaves the machine.'
                }
                action={
                  <Button
                    size="sm"
                    variant="signal"
                    loading={summarizing}
                    icon={<Icon name="sparkle" size={13} />}
                    onClick={() => void generateSummary()}
                  >
                    Generate summary
                  </Button>
                }
              />
            )}
          </section>

          {/* Ask ------------------------------------------------- */}
          <section
            aria-labelledby="ask-heading"
            className="rounded-panel border border-signal-500/25 bg-signal-500/[0.04]"
          >
            <div className="flex items-center gap-2 border-b border-signal-500/15 px-3.5 py-2">
              <Icon name="sparkle" size={13} className="shrink-0 text-signal-400" />
              <h2
                id="ask-heading"
                className="font-mono text-[11px] uppercase tracking-[0.14em] text-signal-300"
              >
                Ask about this meeting
              </h2>
              <span className="ml-auto font-mono text-[10px] uppercase tracking-[0.08em] text-signal-400/60">
                local model
              </span>
            </div>
            <div className="space-y-3 px-3.5 py-3">
              <form
                className="flex items-center gap-2"
                onSubmit={(event) => {
                  event.preventDefault()
                  void ask()
                }}
              >
                <input
                  value={question}
                  onChange={(event) => setQuestion(event.target.value)}
                  placeholder="Did we agree on a launch date?"
                  aria-label="Question about this meeting"
                  className="field text-[13.5px]"
                />
                <Button
                  type="submit"
                  variant="signal"
                  loading={asking}
                  disabled={question.trim().length === 0}
                  icon={<Icon name="message" size={13} />}
                >
                  Ask
                </Button>
              </form>

              {answer != null && (
                <div className="animate-fade-up rounded-card border border-signal-500/20 bg-ink-950/60 px-3.5 py-3">
                  <div className="flex items-start gap-2">
                    <p className="min-w-0 flex-1 whitespace-pre-line text-[13.5px] leading-relaxed text-ink-100">
                      {answer}
                    </p>
                    <button
                      type="button"
                      aria-label="Dismiss answer"
                      onClick={() => setAnswer(null)}
                      className="-mr-1 -mt-0.5 rounded-full p-1 text-ink-400 transition-colors duration-150 ease-spring hover:bg-ink-800 hover:text-ink-100"
                    >
                      <Icon name="x" size={13} />
                    </button>
                  </div>
                  <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.08em] text-signal-400/60">
                    answer only covers this transcript · press esc to dismiss
                  </p>
                </div>
              )}
            </div>
          </section>

          {/* Action items */}
          <section aria-labelledby="actions-heading">
            <div className="flex items-center gap-2 pb-2">
              <h2 id="actions-heading" className="eyebrow text-ink-400">
                Action items
              </h2>
              <span aria-hidden="true" className="h-px flex-1 bg-ink-800/70" />
              {actionItems.length > 0 && (
                <Button
                  size="sm"
                  variant="ghost"
                  loading={regenerating}
                  icon={<Icon name="refresh" size={12} />}
                  onClick={() => void regenerateActions()}
                >
                  Re-extract
                </Button>
              )}
            </div>
            <ActionItemList
              meetingId={meeting.id}
              items={actionItems}
              onChange={refresh}
              onRegenerate={() => void regenerateActions()}
              regenerating={regenerating}
            />
          </section>

          {/* Speakers */}
          <section id="speakers" aria-labelledby="speakers-heading" className="scroll-mt-6">
            <div className="flex items-center gap-2 pb-2">
              <h2 id="speakers-heading" className="eyebrow text-ink-400">
                Speakers
              </h2>
              <span aria-hidden="true" className="h-px flex-1 bg-ink-800/70" />
            </div>
            {speakerLabels.length === 0 ? (
              <p className="text-[13px] leading-relaxed text-ink-500">
                No speakers were detected: this meeting has no transcript lines.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {speakerLabels.map((label) => {
                  const current =
                    speakers.find((s: SpeakerName) => s.speakerLabel === label)?.displayName ?? ''
                  const editing = renamingSpeaker === label
                  if (editing) {
                    return (
                      <li key={label}>
                        <SpeakerEditor
                          label={label}
                          initial={current}
                          onCancel={() => setRenamingSpeaker(null)}
                          onSave={(name) => void renameSpeaker(label, name)}
                          onClear={() => void renameSpeaker(label, '')}
                        />
                      </li>
                    )
                  }
                  return (
                    <li key={label}>
                      <button
                        type="button"
                        onClick={() => setRenamingSpeaker(label)}
                        className="group flex w-full items-center gap-2 rounded-control border border-ink-800 px-2.5 py-1.5 text-left transition-colors duration-150 ease-spring hover:border-ink-700 hover:bg-ink-900/60"
                      >
                        <Icon name="user" size={13} className="shrink-0 text-ink-500" />
                        <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink-200">
                          {current || <span className="text-ink-500">{label}</span>}
                        </span>
                        {current && (
                          <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-500">
                            {label}
                          </span>
                        )}
                        <Icon
                          name="pencil"
                          size={12}
                          className="shrink-0 text-ink-600 transition-colors group-hover:text-ink-400"
                        />
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
            <p className="mt-2 text-[13px] leading-relaxed text-ink-500">
              Renaming a speaker updates the transcript, summaries produced later, and search results
              for this meeting only.
            </p>
          </section>

          {/* Danger */}
          <section aria-labelledby="danger-heading" className="border-t border-ink-800 pt-5">
            <h2 id="danger-heading" className="eyebrow mb-2 text-ink-500">
              Danger
            </h2>
            {confirmDelete ? (
              <div className="animate-fade-up flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="danger"
                  icon={<Icon name="trash" size={13} />}
                  onClick={() => void removeMeeting()}
                >
                  Delete permanently
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
                  Cancel
                </Button>
              </div>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                className="text-danger-400 hover:bg-danger-500/10"
                icon={<Icon name="trash" size={13} />}
                onClick={() => setConfirmDelete(true)}
              >
                Delete this meeting
              </Button>
            )}
            <p className="mt-2 text-[13px] leading-relaxed text-ink-500">
              Deletes the transcript, summary, action items and any kept audio for this meeting.
              There is no cloud copy to fall back on.
            </p>
          </section>
        </aside>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Pieces                                                             */
/* ------------------------------------------------------------------ */

/** Stable identity so transcript rows never lose memoization. */
const EMPTY_CORRECTIONS: DictionaryTerm[] = []

function InlineTitle({
  value,
  onSave
}: {
  value: string
  onSave: (next: string) => void
}): ReactNode {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    setDraft(value)
  }, [value])

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing])

  if (editing) {
    return (
      <form
        onSubmit={(event) => {
          event.preventDefault()
          setEditing(false)
          onSave(draft)
        }}
      >
        <input
          ref={inputRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            setEditing(false)
            onSave(draft)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setDraft(value)
              setEditing(false)
            }
          }}
          aria-label="Meeting title"
          className="w-full rounded-control border border-ink-700 bg-ink-900 px-2.5 py-1 text-[24px] font-medium tracking-[-0.025em] text-ink-50 focus:outline-none"
        />
      </form>
    )
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      title="Click to rename"
      className="group -mx-2 flex max-w-full items-center gap-2 rounded-control px-2 py-1 text-left transition-colors duration-150 ease-spring hover:bg-ink-900/60"
    >
      <h1 className="truncate text-[24px] font-medium tracking-[-0.025em] text-ink-50">
        {value || 'Untitled meeting'}
      </h1>
      <Icon
        name="pencil"
        size={14}
        className="shrink-0 text-ink-600 transition-colors group-hover:text-ink-400"
      />
    </button>
  )
}

function SpeakerEditor({
  label,
  initial,
  onSave,
  onCancel,
  onClear
}: {
  label: string
  initial: string
  onSave: (name: string) => void
  onCancel: () => void
  onClear: () => void
}): ReactNode {
  const [draft, setDraft] = useState(initial)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  return (
    <form
      className="rounded-card border border-signal-500/30 bg-signal-500/[0.05] px-2.5 py-2.5"
      onSubmit={(event) => {
        event.preventDefault()
        onSave(draft)
      }}
    >
      <label className="eyebrow mb-1 block text-ink-500">{label} is really…</label>
      <input
        ref={inputRef}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onCancel()
        }}
        placeholder="e.g. Priya Raghavan"
        className="field py-1.5 text-[13px]"
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="primary" type="submit" disabled={draft.trim().length === 0}>
          Save name
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        {initial && (
          <Button size="sm" variant="ghost" onClick={onClear}>
            Forget name
          </Button>
        )}
      </div>
    </form>
  )
}

function ProgressRail({ progress }: { progress: number | null }): ReactNode {
  const width = progress == null ? 100 : Math.round(Math.max(0, Math.min(1, progress)) * 100)
  return (
    <div
      className="mt-2.5 h-1 overflow-hidden rounded-full bg-ink-800"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={progress == null ? undefined : width}
    >
      <div
        className={cx(
          'h-full rounded-full',
          progress == null
            ? 'w-full animate-shimmer bg-gradient-to-r from-signal-500/20 via-signal-400 to-signal-500/20 bg-[length:200%_100%]'
            : 'bg-signal-500 transition-[width] duration-300'
        )}
        style={progress == null ? undefined : { width: `${width}%` }}
      />
    </div>
  )
}

/** Copy the whole transcript as one text blob. */
function CopyTranscriptButton({ segments }: { segments: string }): ReactNode {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (timerRef.current != null) window.clearTimeout(timerRef.current)
    },
    []
  )

  return (
    <button
      type="button"
      disabled={segments.trim().length === 0}
      onClick={async () => {
        const ok = await copyText(segments)
        if (!ok) {
          pushToast('error', 'Could not copy to the clipboard.')
          return
        }
        setCopied(true)
        if (timerRef.current != null) window.clearTimeout(timerRef.current)
        timerRef.current = window.setTimeout(() => setCopied(false), 1800)
      }}
      className="flex shrink-0 items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-500 transition-colors duration-150 ease-spring hover:text-ink-200 disabled:opacity-40"
    >
      <Icon name={copied ? 'check' : 'copy'} size={12} />
      {copied ? 'copied' : 'copy'}
    </button>
  )
}
