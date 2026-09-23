/**
 * Note list: card-based rows on the light content canvas.
 *
 * Each card is one meeting and carries the facts that exist on the meeting row
 * (duration, segment count, action-item count) plus a bounded speaker count
 * derived from the transcript where it can be known. Quick actions appear on
 * hover or keyboard focus and are real buttons; delete confirms inline rather
 * than in a modal.
 *
 * Pins are a UI-level sort persisted in localStorage — see `pins.ts` for why
 * they are not a database column.
 */
import { useMemo, useState, type ReactNode } from 'react'
import type { Meeting } from '@shared/types'
import { api } from '@/lib/api'
import {
  copyText,
  cx,
  formatDayGroup,
  formatDurationCompact,
  formatRelative,
  plural,
  truncate
} from '@/lib/format'
import { attempt, openMeeting, pushToast } from '@/lib/store'
import { Icon } from '@/components/Icon'
import { ExportMenu, type ExportFormat } from '@/components/ExportMenu'
import { Skeleton } from '@/components/EmptyState'
import { togglePin, unpin, usePinnedIds } from '@/components/pins'
import { useSpeakerCounts } from '@/components/speakerCounts'

export interface MeetingListProps {
  meetings: Meeting[]
  /** Highlight the row matching the currently open meeting. */
  selectedId?: string | null
  loading?: boolean
  className?: string
}

interface DayGroup {
  key: string
  label: string
  meetings: Meeting[]
}

function groupByDay(meetings: Meeting[]): DayGroup[] {
  const groups = new Map<string, DayGroup>()
  for (const meeting of meetings) {
    const key = formatDayGroup(meeting.startedAt)
    const existing = groups.get(key)
    if (existing) {
      existing.meetings.push(meeting)
    } else {
      groups.set(key, { key, label: key, meetings: [meeting] })
    }
  }
  return Array.from(groups.values())
}

function noteText(meeting: Meeting): string {
  const lines = [meeting.title]
  const meta = `${formatRelative(meeting.startedAt)} · ${formatDurationCompact(meeting.durationMs)} · ${plural(meeting.segmentCount, 'line')}`
  lines.push(meta)
  if (meeting.summary && meeting.summary.trim().length > 0) {
    lines.push('', meeting.summary.trim())
  }
  return lines.join('\n')
}

export function MeetingList({
  meetings,
  selectedId,
  loading = false,
  className
}: MeetingListProps): ReactNode {
  const pinnedIds = usePinnedIds()
  const speakerCounts = useSpeakerCounts(meetings)

  const pinned = useMemo(() => {
    const rank = new Map<string, number>()
    pinnedIds.forEach((id, index) => rank.set(id, index))
    return meetings
      .filter((meeting) => rank.has(meeting.id))
      .sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0))
  }, [meetings, pinnedIds])

  const rest = useMemo(() => {
    const pinnedSet = new Set(pinned.map((meeting) => meeting.id))
    return meetings.filter((meeting) => !pinnedSet.has(meeting.id))
  }, [meetings, pinned])

  if (loading && meetings.length === 0) {
    return (
      <div className={cx('space-y-2.5', className)} aria-busy="true">
        {[0, 1, 2, 3].map((row) => (
          <div
            key={row}
            className="rounded-card border border-canvas-hairline bg-canvas-raised px-4 py-3.5"
          >
            <div className="flex items-center gap-2">
              <Skeleton width={`${38 + ((row * 13) % 30)}%`} onCanvas className="h-3.5" />
              <Skeleton width="4rem" onCanvas />
            </div>
            <Skeleton
              width={`${62 + ((row * 7) % 26)}%`}
              onCanvas
              className="mt-2.5 h-2.5"
            />
            <div className="mt-3 flex gap-2">
              <Skeleton width="4.5rem" onCanvas className="h-5 rounded-full" />
              <Skeleton width="3.5rem" onCanvas className="h-5 rounded-full" />
            </div>
          </div>
        ))}
      </div>
    )
  }

  const groups = groupByDay(rest)

  return (
    <div className={cx('space-y-7', className)}>
      {pinned.length > 0 && (
        <section aria-label="Pinned meetings">
          <GroupHeader label="Pinned" count={pinned.length} />
          <ul className="mt-3 space-y-2.5">
            {pinned.map((meeting) => (
              <MeetingCard
                key={meeting.id}
                meeting={meeting}
                pinned
                speakerCount={speakerCounts[meeting.id]}
                selected={selectedId === meeting.id}
              />
            ))}
          </ul>
        </section>
      )}

      {groups.map((group) => (
        <section key={group.key} aria-label={group.label}>
          <GroupHeader label={group.label} count={group.meetings.length} />
          <ul className="mt-3 space-y-2.5">
            {group.meetings.map((meeting) => (
              <MeetingCard
                key={meeting.id}
                meeting={meeting}
                pinned={false}
                speakerCount={speakerCounts[meeting.id]}
                selected={selectedId === meeting.id}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

function GroupHeader({ label, count }: { label: string; count: number }): ReactNode {
  return (
    <div className="flex items-baseline gap-3 px-1">
      <h3 className="eyebrow text-canvas-faint">{label}</h3>
      <span className="font-mono text-[10px] text-canvas-faint">
        {plural(count, 'meeting')}
      </span>
      <span aria-hidden="true" className="h-px flex-1 bg-canvas-hairline" />
    </div>
  )
}

interface MeetingCardProps {
  meeting: Meeting
  pinned: boolean
  speakerCount?: number
  selected: boolean
}

function MeetingCard({ meeting, pinned, speakerCount, selected }: MeetingCardProps): ReactNode {
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [busy, setBusy] = useState(false)
  const [exporting, setExporting] = useState<ExportFormat | null>(null)
  const [copied, setCopied] = useState(false)

  const summary = meeting.summary?.trim() ?? ''

  const copy = async (): Promise<void> => {
    const ok = await copyText(noteText(meeting))
    if (!ok) {
      pushToast('error', 'Could not copy to the clipboard.')
      return
    }
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  const exportAs = async (format: ExportFormat): Promise<void> => {
    setExporting(format)
    const path = await attempt(() => api.exportMeeting(meeting.id, format), {
      errorPrefix: `Could not export as ${format}`
    })
    setExporting(null)
    if (path === null) pushToast('warn', 'Export cancelled.')
    else if (path) pushToast('info', `Exported to ${path}`)
  }

  const remove = async (): Promise<void> => {
    setBusy(true)
    const ok = await attempt(
      async () => {
        await api.deleteMeeting(meeting.id)
        return true
      },
      { errorPrefix: 'Could not delete the meeting', meetingId: meeting.id }
    )
    setBusy(false)
    if (ok) {
      unpin(meeting.id)
      pushToast('info', 'Meeting deleted.')
    }
  }

  return (
    <li>
      <article
        className={cx(
          'group relative rounded-card border bg-canvas-raised shadow-lift transition-all duration-200 ease-spring',
          'hover:-translate-y-px hover:shadow-float',
          selected ? 'border-signal-400/60' : 'border-canvas-hairline'
        )}
      >
        <div className="flex items-start gap-3 px-4 py-3.5">
          <button
            type="button"
            onClick={() => openMeeting(meeting.id)}
            className="min-w-0 flex-1 text-left"
          >
            <span className="flex items-center gap-2">
              <span className="truncate text-[13.5px] font-semibold tracking-[-0.01em] text-canvas-text">
                {meeting.title || 'Untitled meeting'}
              </span>
              {meeting.summaryStatus === 'pending' && (
                <span className="chip shrink-0 bg-canvas-sunken text-canvas-muted">
                  summary pending
                </span>
              )}
              {meeting.summaryStatus === 'failed' && (
                <span className="chip shrink-0 bg-danger-500/10 text-danger-600">summary failed</span>
              )}
            </span>

            <span
              className={cx(
                'mt-1 block max-w-[72ch] truncate text-[13.5px] leading-relaxed',
                summary ? 'text-canvas-muted' : 'italic text-canvas-faint'
              )}
            >
              {summary ? truncate(summary, 150) : 'No summary yet'}
            </span>

            <span className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <span
                className="font-mono text-[11px] tabular-nums text-canvas-muted"
                title={new Date(meeting.startedAt).toLocaleString()}
              >
                {formatRelative(meeting.startedAt)}
              </span>
              <span aria-hidden="true" className="h-3 w-px bg-canvas-hairline" />
              <span className="font-mono text-[11px] tabular-nums text-canvas-muted">
                {formatDurationCompact(meeting.durationMs)}
              </span>
              <span className="chip bg-canvas-sunken text-canvas-muted">
                {plural(meeting.segmentCount, 'line')}
              </span>
              <span className="chip bg-canvas-sunken text-canvas-muted">
                {plural(meeting.actionItemCount, 'action')}
              </span>
              {speakerCount != null && speakerCount > 0 && (
                <span className="chip bg-canvas-sunken text-canvas-muted">
                  <Icon name="users" size={10} />
                  {plural(speakerCount, 'speaker')}
                </span>
              )}
              {meeting.audioPath && (
                <span className="chip bg-canvas-sunken text-canvas-muted" title="Audio kept on disk">
                  <Icon name="waveform" size={10} />
                  audio kept
                </span>
              )}
              {pinned && (
                <span className="chip bg-ink-900 text-ink-100">
                  <Icon name="pin" size={10} />
                  pinned
                </span>
              )}
            </span>
          </button>

          {/* Quick actions: hidden until hover or focus, always keyboard reachable. */}
          <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-150 ease-spring group-hover:opacity-100 group-focus-within:opacity-100">
            <button
              type="button"
              onClick={() => void copy()}
              aria-label={`Copy notes for ${meeting.title}`}
              title="Copy notes"
              className="flex h-7 w-7 items-center justify-center rounded-full text-canvas-muted transition-colors duration-150 ease-spring hover:bg-canvas-sunken hover:text-canvas-text"
            >
              <Icon name={copied ? 'check' : 'copy'} size={14} />
            </button>
            <button
              type="button"
              onClick={() => togglePin(meeting.id)}
              aria-pressed={pinned}
              aria-label={pinned ? `Unpin ${meeting.title}` : `Pin ${meeting.title}`}
              title={pinned ? 'Unpin' : 'Pin to top'}
              className="flex h-7 w-7 items-center justify-center rounded-full text-canvas-muted transition-colors duration-150 ease-spring hover:bg-canvas-sunken hover:text-canvas-text"
            >
              <Icon name={pinned ? 'unpin' : 'pin'} size={14} />
            </button>
            <ExportMenu
              variant="compact"
              exporting={exporting}
              onExport={(format) => void exportAs(format)}
            />
            <button
              type="button"
              onClick={() => setConfirmingDelete(true)}
              aria-label={`Delete ${meeting.title}`}
              title="Delete"
              className="flex h-7 w-7 items-center justify-center rounded-full text-canvas-muted transition-colors duration-150 ease-spring hover:bg-danger-500/10 hover:text-danger-600"
            >
              <Icon name="trash" size={14} />
            </button>
          </div>
        </div>

        {confirmingDelete && (
          <div className="animate-fade-up flex flex-wrap items-center gap-3 border-t border-canvas-hairline bg-danger-500/[0.05] px-4 py-2.5">
            <p className="min-w-0 flex-1 text-[13.5px] leading-relaxed text-canvas-muted">
              Delete “{meeting.title}”, its transcript and any kept audio? There is no cloud copy.
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={() => void remove()}
              className="btn btn-danger h-7 px-3 text-[12px]"
            >
              {busy ? 'Deleting…' : 'Delete permanently'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirmingDelete(false)}
              className="btn h-7 px-3 text-[12px] text-canvas-muted hover:bg-canvas-sunken hover:text-canvas-text"
            >
              Cancel
            </button>
          </div>
        )}
      </article>
    </li>
  )
}
