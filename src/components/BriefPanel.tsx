/**
 * Pre-meeting brief: agenda notes, attached documents, and a calendar import.
 *
 * Collapsible rather than modal — it sits above the transcript and gets out of
 * the way the moment the meeting starts.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Meeting } from '@shared/types'
import type { IcsImport } from '@shared/api'
import { api } from '@/lib/api'
import { cx, formatDate, formatTime } from '@/lib/format'
import { useEscape } from '@/lib/hooks'
import { attempt, bumpRevision, pushToast } from '@/lib/store'
import { Button, IconButton } from '@/components/Button'
import { Icon } from '@/components/Icon'

export interface BriefPanelProps {
  meeting: Meeting | null
  /** Loads the meeting row if the parent only has an id. */
  loading?: boolean
  onSaved?: (meeting: Meeting) => void
  defaultOpen?: boolean
  className?: string
}

function docsFromMeeting(meeting: Meeting | null): string[] {
  if (!meeting?.briefDocs) return []
  return meeting.briefDocs
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

function fileNameFromPath(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] || path
}

export function BriefPanel({
  meeting,
  loading = false,
  onSaved,
  defaultOpen = false,
  className
}: BriefPanelProps): ReactNode {
  const [open, setOpen] = useState(defaultOpen || meeting?.briefNotes == null)
  const [notes, setNotes] = useState(meeting?.briefNotes ?? '')
  const [docs, setDocs] = useState<string[]>(() => docsFromMeeting(meeting))
  const [saving, setSaving] = useState(false)
  const [attaching, setAttaching] = useState(false)
  const [importing, setImporting] = useState(false)
  const [imported, setImported] = useState<IcsImport | null>(null)
  const [generating, setGenerating] = useState(false)
  const [briefSummary, setBriefSummary] = useState(meeting?.briefSummary ?? null)
  const [dirty, setDirty] = useState(false)

  // Sync from the stored meeting only when a different meeting is loaded, so
  // background refetches never clobber text the user is typing.
  const syncedIdRef = useRef<string | null>(null)
  useEffect(() => {
    if (!meeting) return
    if (syncedIdRef.current === meeting.id) return
    syncedIdRef.current = meeting.id
    setNotes(meeting.briefNotes ?? '')
    setDocs(docsFromMeeting(meeting))
    setDirty(false)
    // An in-progress meeting opens by default so documents can be attached;
    // a finished meeting with a saved brief starts collapsed.
    setOpen((meeting.briefNotes ?? '').trim().length === 0 || meeting.endedAt == null)
  }, [meeting])

  useEffect(() => {
    if (meeting) setBriefSummary(meeting.briefSummary)
  }, [meeting])

  useEscape(() => {
    if (open && meeting?.briefNotes != null) setOpen(false)
  }, open)

  const save = async (): Promise<void> => {
    if (!meeting) return
    setSaving(true)
    const saved = await attempt(() => api.setBrief(meeting.id, notes, docs), {
      errorPrefix: 'Could not save the brief'
    })
    setSaving(false)
    if (saved) {
      setDirty(false)
      pushToast('info', 'Brief saved.')
      bumpRevision(meeting.id)
      onSaved?.(saved)
    }
  }

  const attach = async (): Promise<void> => {
    if (!meeting) return
    setAttaching(true)
    const picked = await attempt(() => api.attachBriefDocs(), {
      errorPrefix: 'Could not attach documents'
    })
    setAttaching(false)
    if (picked && picked.length > 0) {
      setDocs((prev) => Array.from(new Set([...prev, ...picked])))
      setDirty(true)
    }
  }

  const importIcs = async (): Promise<void> => {
    setImporting(true)
    const parsed = await attempt(() => api.importIcs(), {
      errorPrefix: 'Could not read the calendar invite'
    })
    setImporting(false)
    if (parsed) {
      setImported(parsed)
      if (parsed.description && !dirty) {
        setNotes((prev) => (prev.trim().length > 0 ? prev : (parsed.description ?? '')))
        setDirty(true)
      }
    }
  }

  const generate = async (): Promise<void> => {
    if (!meeting) return
    setGenerating(true)
    const summary = await attempt(() => api.generateBrief(meeting.id), {
      label: 'Summarising the brief…',
      errorPrefix: 'Could not summarise the brief'
    })
    setGenerating(false)
    if (summary) {
      setBriefSummary(summary)
      bumpRevision(meeting.id)
    }
  }

  const attendeeNames = imported?.attendees ?? []
  const title = imported?.title ?? meeting?.title ?? 'Untitled meeting'
  const whenLabel = imported?.startedAt
    ? `${formatDate(imported.startedAt)} · ${formatTime(imported.startedAt)}`
    : meeting
      ? `${formatDate(meeting.startedAt)} · ${formatTime(meeting.startedAt)}`
      : null

  return (
    <section
      className={cx(
        'shrink-0 rounded-panel border border-ink-800 bg-ink-900/60',
        imported && 'border-signal-500/25',
        className
      )}
      aria-label="Pre-meeting brief"
    >
      <div className="flex items-center gap-2 px-4 py-2.5">
        <button
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <Icon
            name={open ? 'chevronDown' : 'chevronRight'}
            size={14}
            className="shrink-0 text-ink-500"
          />
          <span className="eyebrow shrink-0 text-ink-400">Brief</span>
          <span className="min-w-0 truncate text-[13px] text-ink-200">{title}</span>
          {whenLabel && (
            <span className="hidden shrink-0 font-mono text-[11px] text-ink-500 sm:inline">
              {whenLabel}
            </span>
          )}
          {!open && !loading && (meeting?.briefNotes ?? '').trim().length > 0 && (
            <span className="hidden min-w-0 truncate text-[12px] text-ink-500 md:inline">
              {meeting?.briefNotes}
            </span>
          )}
        </button>
        {!open && (meeting?.briefNotes ?? '').trim().length === 0 && (
          <span className="chip shrink-0">optional</span>
        )}
        <IconButton
          label={open ? 'Collapse brief' : 'Expand brief'}
          size="sm"
          onClick={() => setOpen((prev) => !prev)}
        >
          <Icon name={open ? 'chevronUp' : 'chevronDown'} size={14} />
        </IconButton>
      </div>

      {open && (
        <div className="max-h-[42vh] space-y-4 overflow-y-auto border-t border-ink-800/80 px-4 py-4">
          {loading && <p className="text-[13px] text-ink-500">Loading brief…</p>}

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_16rem]">
            <div className="space-y-2">
              <label htmlFor="brief-notes" className="eyebrow block">
                Agenda / notes
              </label>
              <textarea
                id="brief-notes"
                value={notes}
                onChange={(event) => {
                  setNotes(event.target.value)
                  setDirty(true)
                }}
                rows={4}
                placeholder={
                  'What is this meeting for?\nWho is in it?\nWhat decision needs to be made?'
                }
                className="field resize-y leading-relaxed"
                disabled={!meeting}
              />
              <p className="text-[12px] leading-relaxed text-ink-500">
                The brief is stored with the meeting and used as context when the summary is
                generated. It is never sent anywhere.
              </p>
            </div>

            <div className="space-y-3">
              <div>
                <span className="eyebrow mb-1.5 block">Documents</span>
                {docs.length === 0 ? (
                  <p className="text-[12px] text-ink-500">No documents attached.</p>
                ) : (
                  <ul className="space-y-1">
                    {docs.map((doc) => (
                      <li
                        key={doc}
                        className="flex items-center gap-2 rounded-control border border-ink-800 bg-ink-950 px-2 py-1.5"
                      >
                        <Icon name="file" size={13} className="shrink-0 text-ink-500" />
                        <span
                          className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-300"
                          title={doc}
                        >
                          {fileNameFromPath(doc)}
                        </span>
                        <IconButton
                          label={`Remove ${fileNameFromPath(doc)}`}
                          size="sm"
                          onClick={() => {
                            setDocs((prev) => prev.filter((d) => d !== doc))
                            setDirty(true)
                          }}
                        >
                          <Icon name="x" size={12} />
                        </IconButton>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  loading={attaching}
                  disabled={!meeting}
                  icon={<Icon name="paperclip" size={13} />}
                  onClick={() => void attach()}
                >
                  Attach documents
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  loading={importing}
                  icon={<Icon name="calendar" size={13} />}
                  onClick={() => void importIcs()}
                >
                  Import .ics
                </Button>
              </div>

              {attendeeNames.length > 0 && (
                <div>
                  <span className="eyebrow mb-1.5 block">Attendees</span>
                  <ul className="flex flex-wrap gap-1.5">
                    {attendeeNames.map((name) => (
                      <li key={name} className="chip">
                        <Icon name="user" size={11} />
                        {name}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {imported?.location && (
                <p className="font-mono text-[11px] text-ink-500">location · {imported.location}</p>
              )}
            </div>
          </div>

          {briefSummary && (
            <div className="rounded-card border border-signal-500/25 bg-signal-500/[0.05] px-3.5 py-3">
              <span className="eyebrow mb-1 block text-signal-400">Brief summary</span>
              <p className="text-[13px] leading-relaxed text-ink-200">{briefSummary}</p>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 border-t border-ink-800/80 pt-3">
            <Button
              size="sm"
              variant="primary"
              loading={saving}
              disabled={!meeting || !dirty}
              icon={<Icon name="check" size={13} />}
              onClick={() => void save()}
            >
              Save brief
            </Button>
            <Button
              size="sm"
              variant="signal"
              loading={generating}
              disabled={!meeting || notes.trim().length === 0}
              icon={<Icon name="sparkle" size={13} />}
              onClick={() => void generate()}
            >
              Summarise brief
            </Button>
            {dirty && (
              <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-500">
                unsaved changes
              </span>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
