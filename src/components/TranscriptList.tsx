/**
 * The transcript surface, used by both the Live view (streaming, dark chrome)
 * and the meeting detail view (persisted, light content canvas).
 *
 * Rendering contract: adding one segment must not re-render the others. Rows are
 * `React.memo` components keyed by segment id, and every callback passed down is
 * stable (`useEventCallback`), so appending at the tail only mounts one row —
 * plus the previous tail row, whose "provisional" flag flips.
 *
 * Correction inspector: the backend stores the corrected text only — the raw
 * pre-correction wording is replaced in place and never kept. So the "View diff"
 * toggle cannot show a real before/after. It shows the corrected line plus an
 * honest explanation, and (when the data allows) which dictionary spellings are
 * present in that line. Nothing is invented.
 */
import { memo, useMemo, useState, type ReactNode } from 'react'
import type { DictionaryTerm, LiveSegment, SpeakerName, TranscriptSegment } from '@shared/types'
import { cx, formatClock, splitHighlight } from '@/lib/format'
import { useEventCallback, useStickyScroll } from '@/lib/hooks'
import { Button } from '@/components/Button'
import { Icon } from '@/components/Icon'

export type TranscriptTone = 'dark' | 'canvas'

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
  /** Which surface the list is drawn on. */
  tone?: TranscriptTone
  /** Enables the per-segment correction inspector on corrected lines. */
  showCorrections?: boolean
  /** Dictionary entries used to explain which spellings were applied. */
  corrections?: DictionaryTerm[]
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

/** Small, surface-aware class bundles so the row stays readable. */
const TONE = {
  dark: {
    stamp: 'text-ink-500',
    stampProvisional: 'text-ink-600',
    speaker: 'text-ink-400',
    speakerYou: 'text-ink-300',
    speakerHover: 'hover:text-signal-300 focus-visible:text-signal-300',
    source: 'text-ink-600',
    corrected: 'text-signal-400/80',
    confidence: 'text-ink-500',
    text: 'text-ink-100',
    textProvisional: 'text-ink-300',
    rail: 'bg-ink-800/70',
    mark: 'rounded-[3px] bg-ink-200/25 px-0.5 text-ink-50'
  },
  canvas: {
    stamp: 'text-canvas-muted',
    stampProvisional: 'text-canvas-faint',
    speaker: 'text-canvas-muted',
    speakerYou: 'text-canvas-text',
    speakerHover: 'hover:text-signal-600 focus-visible:text-signal-600',
    source: 'text-canvas-faint',
    corrected: 'text-signal-600',
    confidence: 'text-canvas-faint',
    text: 'text-canvas-text',
    textProvisional: 'text-canvas-muted',
    rail: 'bg-canvas-hairline',
    mark: 'rounded-[3px] bg-ink-200/80 px-0.5 text-canvas-text'
  }
} satisfies Record<TranscriptTone, Record<string, string>>

interface RowProps {
  segment: TranscriptSegment | LiveSegment
  speakerName: string | null
  provisional: boolean
  isTail: boolean
  showSource: boolean
  highlight: string
  tone: TranscriptTone
  showCorrections: boolean
  corrections: DictionaryTerm[]
  onSpeakerClick?: (label: string) => void
}

const TranscriptRow = memo(function TranscriptRow({
  segment,
  speakerName,
  provisional,
  isTail,
  showSource,
  highlight,
  tone,
  showCorrections,
  corrections,
  onSpeakerClick
}: RowProps): ReactNode {
  const label = speakerName ?? segment.speakerLabel ?? 'Unknown speaker'
  const colors = TONE[tone]
  const [diffOpen, setDiffOpen] = useState(false)

  const parts = useMemo(
    () => (highlight.trim().length > 0 ? splitHighlight(segment.text, highlight) : null),
    [segment.text, highlight]
  )

  const matchedCorrections = useMemo(() => {
    if (!diffOpen) return []
    const haystack = segment.text.toLowerCase()
    return corrections.filter((entry) => {
      const applied = (entry.replacement ?? entry.term).toLowerCase()
      return applied.length > 0 && haystack.includes(applied)
    })
  }, [diffOpen, corrections, segment.text])

  const appliedSummary = matchedCorrections
    .map((entry) =>
      entry.replacement ? `“${entry.replacement}” (from “${entry.term}”)` : `“${entry.term}”`
    )
    .join(', ')

  const showDiffToggle = showCorrections && segment.corrected

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
          provisional ? colors.stampProvisional : colors.stamp
        )}
        title={`At ${formatClock(segment.startMs)}`}
      >
        {formatClock(segment.startMs)}
      </span>

      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          {onSpeakerClick && segment.speakerLabel ? (
            <button
              type="button"
              onClick={() => onSpeakerClick(segment.speakerLabel ?? '')}
              className={cx(
                'rounded text-[11px] font-semibold uppercase tracking-[0.1em] transition-colors duration-150 ease-spring',
                colors.speakerHover,
                label === 'You' ? colors.speakerYou : colors.speaker
              )}
              title="Rename this speaker"
            >
              {label}
            </button>
          ) : (
            <span
              className={cx(
                'text-[11px] font-semibold uppercase tracking-[0.1em]',
                label === 'You' ? colors.speakerYou : colors.speaker
              )}
            >
              {label}
            </span>
          )}

          {showSource && (
            <span
              className={cx(
                'inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.1em]',
                colors.source
              )}
            >
              <Icon name={SOURCE_ICON[segment.source]} size={11} />
              {SOURCE_LABEL[segment.source]}
            </span>
          )}

          {segment.corrected && (
            <span
              className={cx(
                'font-mono text-[10px] uppercase tracking-[0.1em]',
                colors.corrected
              )}
              title="Corrected by your personal dictionary"
            >
              corrected
            </span>
          )}

          {segment.confidence != null && segment.confidence < 0.7 && (
            <span
              className={cx('font-mono text-[10px]', colors.confidence)}
              title={`Low confidence (${Math.round(segment.confidence * 100)}%)`}
            >
              low confidence
            </span>
          )}

          {showDiffToggle && (
            <button
              type="button"
              aria-expanded={diffOpen}
              onClick={() => setDiffOpen((prev) => !prev)}
              className={cx(
                'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em] transition-colors duration-150 ease-spring',
                tone === 'canvas'
                  ? 'text-signal-600 hover:bg-canvas-sunken'
                  : 'text-signal-400/80 hover:bg-ink-800/60'
              )}
            >
              <Icon name="diff" size={11} />
              {diffOpen ? 'Hide diff' : 'View diff'}
            </button>
          )}
        </div>

        <p
          className={cx(
            'mt-1 max-w-[68ch] text-[13.5px] leading-[1.65]',
            provisional ? `italic ${colors.textProvisional}` : colors.text
          )}
        >
          {parts
            ? parts.map((part, index) =>
                part.match ? (
                  <mark key={index} className={colors.mark}>
                    {part.text}
                  </mark>
                ) : (
                  <span key={index}>{part.text}</span>
                )
              )
            : segment.text}
          {provisional && (
            <span
              className={cx(
                'ml-1.5 inline-block align-baseline font-mono text-[10px] uppercase tracking-[0.1em]',
                colors.stamp
              )}
            >
              transcribing…
            </span>
          )}
        </p>

        {showDiffToggle && diffOpen && (
          <div
            className={cx(
              'animate-fade-up mt-2 max-w-[68ch] rounded-control border px-3 py-2.5',
              tone === 'canvas'
                ? 'border-canvas-hairline bg-canvas-sunken'
                : 'border-ink-800 bg-ink-950/60'
            )}
          >
            <p className={cx('eyebrow', tone === 'canvas' ? 'text-canvas-faint' : 'text-ink-500')}>
              Dictionary correction
            </p>
            <p
              className={cx(
                'mt-1.5 text-[13px] leading-relaxed',
                tone === 'canvas' ? 'text-canvas-text' : 'text-ink-100'
              )}
            >
              {segment.text}
            </p>
            <p
              className={cx(
                'mt-2 text-[12px] leading-relaxed',
                tone === 'canvas' ? 'text-canvas-muted' : 'text-ink-400'
              )}
            >
              {segment.speakerLabel ? `${segment.speakerLabel} — ` : ''}the raw wording of this line
              was replaced in place by the dictionary correction pass, and the original text is not
              kept anywhere. There is no before/after to compare: the line above is the corrected
              transcript, not a diff.
            </p>
            {matchedCorrections.length > 0 ? (
              <p
                className={cx(
                  'mt-1.5 text-[12px] leading-relaxed',
                  tone === 'canvas' ? 'text-canvas-muted' : 'text-ink-400'
                )}
              >
                Dictionary spellings present in this line: {appliedSummary}. Matched against the
                dictionary as it stands now — a term removed or renamed since this meeting will not
                appear here.
              </p>
            ) : (
              <p
                className={cx(
                  'mt-1.5 text-[12px] leading-relaxed',
                  tone === 'canvas' ? 'text-canvas-muted' : 'text-ink-400'
                )}
              >
                No spelling from your current dictionary appears in this line, so whichever term
                triggered the correction has since been removed or renamed.
              </p>
            )}
          </div>
        )}
      </div>

      {isTail && (
        <span
          aria-hidden="true"
          className="absolute -left-[13px] top-3.5 h-1.5 w-1.5 animate-pulse-rec rounded-full bg-ember-400/70"
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
  className,
  tone = 'dark',
  showCorrections = false,
  corrections
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
            <p
              className={cx(
                'max-w-sm text-[13px] leading-relaxed',
                tone === 'canvas' ? 'text-canvas-muted' : 'text-ink-500'
              )}
            >
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
      <div ref={setRef} className="min-h-0 flex-1 overflow-y-auto pr-2 scroll-slim">
        <ol className="relative pl-4">
          {/* Hairline rail aligning timestamps with the text column. */}
          <span
            aria-hidden="true"
            className={cx(
              'pointer-events-none absolute bottom-3 left-[3.4rem] top-3 w-px',
              TONE[tone].rail
            )}
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
              tone={tone}
              showCorrections={showCorrections}
              corrections={corrections ?? EMPTY_CORRECTIONS}
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
            className="pointer-events-auto shadow-float"
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

/** Stable identity so rows that don't need the dictionary never lose memoization. */
const EMPTY_CORRECTIONS: DictionaryTerm[] = []
