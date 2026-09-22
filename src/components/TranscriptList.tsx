/**
 * The transcript surface, used by both the Live view (streaming) and the
 * meeting detail view (persisted).
 *
 * Rendering contract: adding one segment must not re-render the others. Rows are
 * `React.memo` components keyed by segment id, and every callback passed down is
 * stable (`useEventCallback`), so appending at the tail only mounts one row —
 * plus the previous tail row, whose "provisional" flag flips.
 */
import { memo, useMemo, type ReactNode } from 'react'
import type { LiveSegment, SpeakerName, TranscriptSegment } from '@shared/types'
import { cx, formatClock, splitHighlight } from '@/lib/format'
import { useEventCallback, useStickyScroll } from '@/lib/hooks'
import { Button } from '@/components/Button'
import { Icon } from '@/components/Icon'

export interface TranscriptListProps {
  segments: Array<TranscriptSegment | LiveSegment>
  /** Speaker renames applied on top of the raw labels. */
  speakers?: SpeakerName[]
  /** Live mode enables auto-scroll, provisional styling and the tail marker. */
  live?: boolean
  /** Show the source stream (system/mic) next to the speaker. */
  showSource?: boolean
  /** Highlight these terms in every row (search-driven). */
  highlight?: string
  /** Clicking a speaker label is the shortcut into the rename UI. */
  onSpeakerClick?: (label: string) => void
  emptyState?: ReactNode
  className?: string
}

const SOURCE_LABEL: Record<TranscriptSegment['source'], string> = {
  system: 'them',
  mic: 'you',
  mixed: 'mixed'
}

const SOURCE_ICON: Record<TranscriptSegment['source'], 'monitor' | 'mic' | 'waveform'> = {
  system: 'monitor',
  mic: 'mic',
  mixed: 'waveform'
}

interface RowProps {
  segment: TranscriptSegment | LiveSegment
  speakerName: string | null
  provisional: boolean
  isTail: boolean
  showSource: boolean
  highlight: string
  onSpeakerClick?: (label: string) => void
}

const TranscriptRow = memo(function TranscriptRow({
  segment,
  speakerName,
  provisional,
  isTail,
  showSource,
  highlight,
  onSpeakerClick
}: RowProps): ReactNode {
  const label = speakerName ?? segment.speakerLabel ?? 'Unknown speaker'
  const parts = useMemo(
    () => (highlight.trim().length > 0 ? splitHighlight(segment.text, highlight) : null),
    [segment.text, highlight]
  )

  return (
    <li
      className={cx(
        'group relative grid grid-cols-[3.5rem_1fr] gap-x-4 py-2.5',
        provisional && 'opacity-70'
      )}
    >
      <span
        className={cx(
          'pt-0.5 text-right font-mono text-[11px] tabular-nums',
          provisional ? 'text-ink-600' : 'text-ink-500'
        )}
        title={`At ${formatClock(segment.startMs)}`}
      >
        {formatClock(segment.startMs)}
      </span>

      <div className="min-w-0">
        <div className="flex items-center gap-2">
          {onSpeakerClick && segment.speakerLabel ? (
            <button
              type="button"
              onClick={() => onSpeakerClick(segment.speakerLabel ?? '')}
              className={cx(
                'rounded text-[11px] font-semibold uppercase tracking-[0.1em] transition-colors',
                'hover:text-signal-300 focus-visible:text-signal-300',
                label === 'You' ? 'text-ink-300' : 'text-ink-400'
              )}
              title="Rename this speaker"
            >
              {label}
            </button>
          ) : (
            <span
              className={cx(
                'text-[11px] font-semibold uppercase tracking-[0.1em]',
                label === 'You' ? 'text-ink-300' : 'text-ink-400'
              )}
            >
              {label}
            </span>
          )}

          {showSource && (
            <span className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.1em] text-ink-600">
              <Icon name={SOURCE_ICON[segment.source]} size={11} />
              {SOURCE_LABEL[segment.source]}
            </span>
          )}

          {segment.corrected && (
            <span
              className="font-mono text-[10px] uppercase tracking-[0.1em] text-signal-400/80"
              title="Corrected by your personal dictionary"
            >
              corrected
            </span>
          )}

          {segment.confidence != null && segment.confidence < 0.7 && (
            <span
              className="font-mono text-[10px] text-ink-500"
              title={`Low confidence (${Math.round(segment.confidence * 100)}%)`}
            >
              low confidence
            </span>
          )}
        </div>

        <p
          className={cx(
            'mt-1 max-w-[68ch] text-[13.5px] leading-[1.65]',
            provisional ? 'italic text-ink-300' : 'text-ink-100'
          )}
        >
          {parts
            ? parts.map((part, index) =>
                part.match ? <mark key={index}>{part.text}</mark> : <span key={index}>{part.text}</span>
              )
            : segment.text}
          {provisional && (
            <span className="ml-1.5 inline-block align-baseline font-mono text-[10px] uppercase tracking-[0.1em] text-ink-500">
              transcribing…
            </span>
          )}
        </p>
      </div>

      {isTail && (
        <span
          aria-hidden="true"
          className="absolute -left-[13px] top-3.5 h-1.5 w-1.5 rounded-full bg-ember-400/70"
        />
      )}
    </li>
  )
})

export function TranscriptList({
  segments,
  speakers,
  live = false,
  showSource = false,
  highlight = '',
  onSpeakerClick,
  emptyState,
  className
}: TranscriptListProps): ReactNode {
  const { setRef, pinned, jumpToLatest } = useStickyScroll<HTMLDivElement>(segments.length, live)
  const handleSpeakerClick = useEventCallback((label: string) => {
    onSpeakerClick?.(label)
  })

  const speakerMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const speaker of speakers ?? []) map.set(speaker.speakerLabel, speaker.displayName)
    return map
  }, [speakers])

  const tailId = segments.length > 0 ? segments[segments.length - 1].id : null

  if (segments.length === 0) {
    return (
      <div className={cx('flex-1', className)}>
        {emptyState ?? (
          <div className="flex h-full min-h-[12rem] items-center justify-center px-6 text-center">
            <p className="max-w-sm text-[13px] leading-relaxed text-ink-500">
              Nothing transcribed yet. Lines appear here as they are recognised — usually within a
              few seconds of being spoken.
            </p>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className={cx('relative flex min-h-0 flex-1 flex-col', className)}>
      <div ref={setRef} className="min-h-0 flex-1 overflow-y-auto pr-2">
        <ol className="relative pl-4">
          {/* Hairline rail aligning timestamps with the text column. */}
          <span
            aria-hidden="true"
            className="pointer-events-none absolute bottom-3 left-[3.4rem] top-3 w-px bg-ink-800/70"
          />
          {segments.map((segment) => (
            <TranscriptRow
              key={segment.id}
              segment={segment}
              speakerName={speakerMap.get(segment.speakerLabel ?? '') ?? null}
              provisional={live && segment.id === tailId}
              isTail={live && segment.id === tailId}
              showSource={showSource}
              highlight={highlight}
              onSpeakerClick={onSpeakerClick ? handleSpeakerClick : undefined}
            />
          ))}
        </ol>
        <div className="h-16" aria-hidden="true" />
      </div>

      {live && !pinned && (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
          <Button
            size="sm"
            variant="secondary"
            className="pointer-events-auto shadow-panel"
            icon={<Icon name="arrowDown" size={13} />}
            onClick={jumpToLatest}
          >
            Jump to latest
          </Button>
        </div>
      )}
    </div>
  )
}
