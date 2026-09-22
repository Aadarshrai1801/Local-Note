/**
 * Chronological meeting list, grouped by day.
 *
 * Rows are intentionally dense and text-first: title, then metadata in
 * monospace, then the summary's first line as a lede. No thumbnails, no cards.
 */
import type { ReactNode } from 'react'
import type { Meeting } from '@shared/types'
import { cx, formatDate, formatDayGroup, formatDurationCompact, formatRelative, formatTime, plural, truncate } from '@/lib/format'
import { openMeeting } from '@/lib/store'
import { Icon } from '@/components/Icon'
import { Skeleton } from '@/components/EmptyState'

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

function MeetingRow({ meeting }: { meeting: Meeting }): ReactNode {
  const summary = meeting.summary?.trim()
  return (
    <li>
      <button
        type="button"
        onClick={() => openMeeting(meeting.id)}
        className="group grid w-full grid-cols-[6.5rem_minmax(0,1fr)_auto] items-baseline gap-x-4 rounded-md px-3 py-3 text-left transition-colors hover:bg-ink-900/60"
      >
        <span className="font-mono text-[11px] tabular-nums text-ink-500">
          {formatTime(meeting.startedAt)}
          <span className="ml-1.5 text-ink-600">{formatRelative(meeting.startedAt)}</span>
        </span>

        <span className="min-w-0">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[14px] font-medium tracking-[-0.01em] text-ink-100 group-hover:text-white">
              {meeting.title}
            </span>
            {meeting.summaryStatus === 'pending' && (
              <span className="chip shrink-0 text-ink-500">pending</span>
            )}
            {meeting.summaryStatus === 'failed' && (
              <span className="chip shrink-0 border-red-500/30 text-red-300">summary failed</span>
            )}
            {meeting.audioPath && (
              <Icon name="waveform" size={12} className="shrink-0 text-ink-600" label="Audio kept" />
            )}
          </span>
          <span
            className={cx(
              'mt-0.5 block max-w-[62ch] truncate text-[12.5px] leading-relaxed',
              summary ? 'text-ink-400' : 'text-ink-600 italic'
            )}
          >
            {summary ? truncate(summary, 150) : 'No summary yet'}
          </span>
        </span>

        <span className="flex shrink-0 items-center gap-4 font-mono text-[11px] tabular-nums text-ink-500">
          <span title="Duration">{formatDurationCompact(meeting.durationMs)}</span>
          <span title="Transcript segments" className="hidden sm:inline">
            {plural(meeting.segmentCount, 'line')}
          </span>
          <span title="Action items" className="hidden md:inline">
            {plural(meeting.actionItemCount, 'action')}
          </span>
          <Icon
            name="chevronRight"
            size={14}
            className="text-ink-700 transition-colors group-hover:text-ink-400"
          />
        </span>
      </button>
    </li>
  )
}

export function MeetingList({
  meetings,
  selectedId,
  loading = false,
  className
}: MeetingListProps): ReactNode {
  if (loading && meetings.length === 0) {
    return (
      <div className={cx('space-y-3', className)} aria-busy="true">
        {[0, 1, 2, 3].map((row) => (
          <div key={row} className="grid grid-cols-[6.5rem_1fr_auto] items-center gap-4 px-3 py-3">
            <Skeleton width="4rem" />
            <span className="space-y-2">
              <Skeleton width={`${40 + ((row * 13) % 35)}%`} />
              <Skeleton width={`${60 + ((row * 7) % 30)}%`} className="h-2.5 bg-ink-800/50" />
            </span>
            <Skeleton width="5rem" />
          </div>
        ))}
      </div>
    )
  }

  const groups = groupByDay(meetings)

  return (
    <div className={cx('space-y-6', className)}>
      {groups.map((group) => (
        <section key={group.key} aria-label={group.label}>
          <div className="flex items-baseline gap-3 px-3">
            <h3 className="eyebrow text-ink-500">{group.label}</h3>
            <span className="font-mono text-[10px] text-ink-600">
              {plural(group.meetings.length, 'meeting')}
            </span>
            <span
              aria-hidden="true"
              className={cx('h-px flex-1 bg-ink-800/70', selectedId && 'opacity-40')}
            />
          </div>
          <ul className="mt-1 divide-y divide-ink-800/60">
            {group.meetings.map((meeting) => (
              <MeetingRow key={meeting.id} meeting={meeting} />
            ))}
          </ul>
        </section>
      ))}
      {meetings.length > 0 && (
        <p className="px-3 font-mono text-[10px] uppercase tracking-[0.1em] text-ink-700">
          {formatDate(meetings[meetings.length - 1].startedAt)} — earliest meeting on this machine
        </p>
      )}
    </div>
  )
}
