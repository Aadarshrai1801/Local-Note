/**
 * Search across every transcript, plus a question box that answers with
 * citations.
 *
 * Results are grouped by meeting and drawn against a timeline rail, so a hit
 * carries its position in the conversation rather than just a score. The
 * result list lives on the light content canvas; the query controls and the
 * AI answer stay on dark chrome.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { RagAnswer, SearchHit } from '@shared/types'
import { api, isMockApi } from '@/lib/api'
import {
  cx,
  formatClock,
  formatDate,
  formatDuration,
  formatTime,
  plural,
  splitHighlight,
  truncate
} from '@/lib/format'
import { useAsyncData, useDebounced, useEscape } from '@/lib/hooks'
import { attempt, openMeeting, useBackendBusy, useSearchQuery, useStatus } from '@/lib/store'
import { Button } from '@/components/Button'
import { EmptyState, ErrorState, LoadingBlock } from '@/components/EmptyState'
import { Icon } from '@/components/Icon'
import { Kbd } from '@/components/Kbd'
import { SEARCH_QUERY_ID } from '@/components/GlobalShortcuts'

const SINCE_OPTIONS: Array<{ value: number | null; label: string }> = [
  { value: null, label: 'Any time' },
  { value: 7, label: 'Last 7 days' },
  { value: 30, label: 'Last 30 days' },
  { value: 90, label: 'Last quarter' }
]

/** Highlight that stays legible on the light content surface. */
const MARK_CLASS = 'rounded-[3px] bg-ink-200/80 px-0.5 text-canvas-text'

interface MeetingGroup {
  meetingId: string
  title: string
  startedAt: number
  hits: SearchHit[]
  /** Latest hit position, used to scale the timeline rail. */
  span: number
}

function groupHits(hits: SearchHit[]): MeetingGroup[] {
  const groups = new Map<string, MeetingGroup>()
  for (const hit of hits) {
    const existing = groups.get(hit.meetingId)
    if (existing) {
      existing.hits.push(hit)
      existing.span = Math.max(existing.span, hit.startMs ?? 0)
    } else {
      groups.set(hit.meetingId, {
        meetingId: hit.meetingId,
        title: hit.meetingTitle,
        startedAt: hit.startedAt,
        hits: [hit],
        span: hit.startMs ?? 0
      })
    }
  }
  return Array.from(groups.values()).sort((a, b) => b.startedAt - a.startedAt)
}

function viaLabel(via: SearchHit['via']): string {
  if (via === 'both') return 'keyword + semantic'
  return via
}

export function Search(): ReactNode {
  const seed = useSearchQuery()
  const { status } = useStatus()
  const backendBusy = useBackendBusy()

  const [query, setQuery] = useState(seed)
  const [semantic, setSemantic] = useState(true)
  const [keyword, setKeyword] = useState(true)
  const [sinceDays, setSinceDays] = useState<number | null>(null)
  const debounced = useDebounced(query, 300)

  const [answer, setAnswer] = useState<RagAnswer | null>(null)
  const [question, setQuestion] = useState('')
  const [asking, setAsking] = useState(false)
  const [reindexing, setReindexing] = useState(false)
  const [reindexResult, setReindexResult] = useState<{ embedded: number; total: number } | null>(
    null
  )

  useEscape(() => setAnswer(null), answer != null)

  // A query handed over from Home should land in the box.
  useEffect(() => {
    if (seed.length > 0) setQuery(seed)
  }, [seed])

  const trimmed = debounced.trim()

  const results = useAsyncData(
    () =>
      trimmed.length === 0
        ? Promise.resolve<SearchHit[]>([])
        : api.search({
            query: trimmed,
            semantic,
            keyword,
            sinceDays: sinceDays ?? undefined,
            limit: 60
          }),
    [trimmed, semantic, keyword, sinceDays]
  )

  const hits = results.data ?? []
  const groups = useMemo(() => groupHits(hits), [hits])

  const runReindex = async (): Promise<void> => {
    setReindexing(true)
    const result = await attempt(() => api.reindexSearch(), {
      errorPrefix: 'Could not rebuild the search index'
    })
    setReindexing(false)
    if (result) {
      setReindexResult(result)
      results.refresh()
    }
  }

  const ask = useCallback(async () => {
    const value = question.trim()
    if (value.length === 0) return
    setAsking(true)
    const result = await attempt(() => api.askAcrossMeetings(value), {
      label: 'Searching all meetings…',
      errorPrefix: 'Could not answer that question'
    })
    setAsking(false)
    if (result) setAnswer(result)
  }, [question])

  const llmMissing = status != null && !status.llm.available

  return (
    <div className="mx-auto w-full max-w-5xl px-8 py-9 lg:px-12">
      <p className="eyebrow">Search</p>
      <h1 className="mt-2 text-[30px] font-medium leading-[1.15] tracking-[-0.025em] text-ink-50">
        Everything that was said, on this machine
      </h1>
      <p className="mt-3 max-w-[66ch] text-[13.5px] leading-relaxed text-ink-400">
        Keyword search matches exact words across every transcript. Semantic search adds paraphrases
        and needs the local embedding model, but keyword results always work without it.
      </p>

      {/* Query ------------------------------------------------------ */}
      <form
        className="mt-6"
        role="search"
        onSubmit={(event) => {
          event.preventDefault()
          results.refresh()
        }}
      >
        <div className="relative">
          <Icon
            name="search"
            size={16}
            className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-500"
          />
          <input
            id={SEARCH_QUERY_ID}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search for a decision, a name, a number…"
            aria-label="Search query"
            aria-keyshortcuts="/ Control+K"
            autoFocus
            className="field h-11 py-0 pl-10 pr-28 text-[13.5px]"
          />
          <span className="pointer-events-none absolute right-3.5 top-1/2 flex -translate-y-1/2 items-center gap-2 font-mono text-[10px] uppercase tracking-[0.1em] text-ink-500">
            {trimmed.length > 0 ? plural(hits.length, 'hit') : <Kbd>/</Kbd>}
          </span>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-x-2.5 gap-y-2">
          <label className="flex cursor-pointer items-center gap-2 rounded-full px-2.5 py-1 text-[12.5px] text-ink-300 transition-colors duration-150 ease-spring hover:bg-ink-900/60">
            <input
              type="checkbox"
              checked={keyword}
              onChange={(event) => setKeyword(event.target.checked)}
              className="h-3.5 w-3.5 accent-signal-500"
            />
            keyword
          </label>
          <label
            className={cx(
              'flex cursor-pointer items-center gap-2 rounded-full px-2.5 py-1 text-[12.5px] transition-colors duration-150 ease-spring',
              llmMissing ? 'text-ink-500' : 'text-ink-300 hover:bg-ink-900/60'
            )}
            title={llmMissing ? 'The local embedding model is not running' : undefined}
          >
            <input
              type="checkbox"
              checked={semantic}
              disabled={llmMissing}
              onChange={(event) => setSemantic(event.target.checked)}
              className="h-3.5 w-3.5 accent-signal-500"
            />
            semantic
            <Icon name="sparkle" size={12} className="text-signal-500/70" />
          </label>

          <span aria-hidden="true" className="hidden h-4 w-px bg-ink-800 sm:block" />

          <div className="flex items-center gap-1">
            {SINCE_OPTIONS.map((option) => (
              <button
                key={option.label}
                type="button"
                aria-pressed={sinceDays === option.value}
                onClick={() => setSinceDays(option.value)}
                className={cx(
                  'rounded-full px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.08em] transition-colors duration-150 ease-spring',
                  sinceDays === option.value
                    ? 'bg-ink-800 text-ink-100'
                    : 'text-ink-500 hover:bg-ink-900 hover:text-ink-300'
                )}
              >
                {option.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            disabled={reindexing}
            onClick={() => void runReindex()}
            className="ml-auto flex items-center gap-1.5 rounded-full px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-500 transition-colors duration-150 ease-spring hover:text-ink-200 disabled:opacity-40"
          >
            <Icon
              name={reindexing ? 'refresh' : 'database'}
              size={12}
              className={cx(reindexing && 'animate-spin')}
            />
            {reindexing ? 'indexing…' : 'rebuild index'}
          </button>
        </div>

        {reindexResult && !reindexing && (
          <p className="mt-2 font-mono text-[11px] text-signal-400/80">
            index rebuilt · {reindexResult.embedded}/{reindexResult.total} segments embedded
          </p>
        )}
        {backendBusy && reindexing && (
          <p className="mt-2 font-mono text-[11px] text-ink-400">{backendBusy.label}</p>
        )}
      </form>

      {/* Results ---------------------------------------------------- */}
      <div className="mt-7 grid items-start gap-10 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <section aria-labelledby="results-heading" className="min-w-0">
          <div className="flex items-baseline gap-3 pb-3">
            <h2 id="results-heading" className="eyebrow text-ink-400">
              Results
            </h2>
            <span aria-hidden="true" className="h-px flex-1 bg-ink-800/70" />
          </div>

          <div className="canvas-surface rounded-panel border border-ink-800 p-4 shadow-lift">
            {trimmed.length === 0 ? (
              <EmptyState
                tone="canvas"
                compact
                title="Start typing to search"
                description="Try a person's name, a commitment (“by Friday”), a decision, or a phrase you remember hearing. Results show where in the meeting each hit occurred."
              />
            ) : results.loading && hits.length === 0 ? (
              <LoadingBlock label="Searching local transcripts…" onCanvas />
            ) : results.error ? (
              <ErrorState message={results.error} onRetry={results.refresh} onCanvas />
            ) : hits.length === 0 ? (
              <EmptyState
                tone="canvas"
                compact
                title="No matches"
                description={
                  <>
                    Nothing matched “{trimmed}” with {keyword ? 'keyword' : ''}
                    {keyword && semantic ? ' + ' : ''}
                    {semantic ? 'semantic' : ''} search.
                    {!keyword && (
                      <span className="mt-1 block text-canvas-muted">
                        Turn keyword search back on to match exact words.
                      </span>
                    )}
                    <span className="mt-1 block text-canvas-muted">
                      If you have never run it, try “Rebuild index”.
                    </span>
                  </>
                }
              />
            ) : (
              <div className="space-y-4">
                {groups.map((group) => (
                  <MeetingGroupCard key={group.meetingId} group={group} query={trimmed} />
                ))}
              </div>
            )}
          </div>
        </section>

        {/* Ask across meetings -------------------------------------- */}
        <aside className="rounded-panel border border-signal-500/25 bg-signal-500/[0.04]">
          <div className="flex items-center gap-2 border-b border-signal-500/15 px-3.5 py-2">
            <Icon name="sparkle" size={13} className="shrink-0 text-signal-400" />
            <h2 className="font-mono text-[11px] uppercase tracking-[0.14em] text-signal-300">
              Ask across all meetings
            </h2>
          </div>
          <div className="space-y-3 px-3.5 py-3">
            <form
              onSubmit={(event) => {
                event.preventDefault()
                void ask()
              }}
            >
              <textarea
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                rows={3}
                placeholder="When did we last discuss pricing?"
                aria-label="Question across all meetings"
                className="field resize-y text-[13.5px] leading-relaxed"
              />
              <div className="mt-2 flex items-center gap-2">
                <Button
                  type="submit"
                  size="sm"
                  variant="signal"
                  loading={asking}
                  disabled={question.trim().length === 0}
                  icon={<Icon name="message" size={13} />}
                >
                  Ask
                </Button>
                {llmMissing && (
                  <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-500">
                    extractive mode
                  </span>
                )}
              </div>
            </form>

            {llmMissing && (
              <p className="text-[13px] leading-relaxed text-ink-500">
                The local model is not running, so answers are assembled from the transcripts
                themselves instead of being written by a model. They are less fluent but still
                cited.
              </p>
            )}

            {answer != null && (
              <div className="animate-fade-up rounded-card border border-signal-500/20 bg-ink-950/60 px-3.5 py-3">
                <div className="flex items-start gap-2">
                  <p className="min-w-0 flex-1 whitespace-pre-line text-[13.5px] leading-relaxed text-ink-100">
                    {answer.answer}
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

                {answer.citations.length > 0 && (
                  <ol className="mt-3 space-y-1.5 border-t border-signal-500/15 pt-3">
                    {answer.citations.map((citation, index) => (
                      <li key={`${citation.meetingId}-${citation.segmentId}`}>
                        <button
                          type="button"
                          onClick={() => openMeeting(citation.meetingId)}
                          className="group flex w-full items-start gap-2 rounded-control px-1 py-1 text-left transition-colors duration-150 ease-spring hover:bg-signal-500/10"
                        >
                          <span className="mt-0.5 font-mono text-[10px] text-signal-400/70">
                            [{index + 1}]
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[12px] text-ink-200 group-hover:text-ink-100">
                              {citation.meetingTitle}
                            </span>
                            <span className="mt-0.5 block font-mono text-[10px] text-ink-500">
                              at {formatClock(citation.startMs)} · {truncate(citation.text, 64)}
                            </span>
                          </span>
                          <Icon
                            name="arrowUpRight"
                            size={12}
                            className="mt-1 shrink-0 text-ink-600 group-hover:text-signal-300"
                          />
                        </button>
                      </li>
                    ))}
                  </ol>
                )}

                <p className="mt-2 border-t border-signal-500/15 pt-2 font-mono text-[10px] uppercase tracking-[0.08em] text-signal-400/60">
                  {answer.usedModel}
                  {answer.degraded ? ' · extractive fallback' : ' · local model'}
                </p>
              </div>
            )}
          </div>
        </aside>
      </div>

      {isMockApi && (
        <p className="mt-10 border-t border-ink-800 pt-4 font-mono text-[10px] uppercase tracking-[0.1em] text-ink-500">
          browser mock · results come from sample transcripts
        </p>
      )}
    </div>
  )
}

function MeetingGroupCard({ group, query }: { group: MeetingGroup; query: string }): ReactNode {
  const best = group.hits.reduce((acc, hit) => (hit.score > acc.score ? hit : acc), group.hits[0])
  const span = Math.max(group.span, 1)

  return (
    <article className="rounded-card border border-canvas-hairline bg-canvas-raised shadow-lift">
      <button
        type="button"
        onClick={() => openMeeting(group.meetingId)}
        className="group flex w-full items-baseline gap-3 rounded-t-card px-3.5 py-2.5 text-left"
      >
        <Icon name="file" size={14} className="shrink-0 translate-y-0.5 text-canvas-faint" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13.5px] font-semibold tracking-[-0.01em] text-canvas-text">
            {group.title}
          </span>
          <span className="mt-0.5 block font-mono text-[11px] text-canvas-muted">
            {formatDate(group.startedAt)} · {formatTime(group.startedAt)} ·{' '}
            {plural(group.hits.length, 'hit')}
          </span>
        </span>
        <span className="chip shrink-0 bg-canvas-sunken text-canvas-muted">
          best · {viaLabel(best.via)}
        </span>
        <Icon
          name="chevronRight"
          size={14}
          className="shrink-0 self-center text-canvas-faint transition-colors group-hover:text-canvas-muted"
        />
      </button>

      {/* Timeline rail: each hit is a tick at its position in the meeting. */}
      <div className="relative mx-3.5 h-9 border-t border-canvas-hairline">
        <span
          aria-hidden="true"
          className="absolute left-0 right-0 top-[18px] h-px bg-canvas-hairline"
        />
        <span className="absolute left-0 top-[22px] font-mono text-[9px] uppercase tracking-[0.08em] text-canvas-faint">
          0:00
        </span>
        {group.hits.map((hit) => (
          <span
            key={`${hit.segmentId ?? 'hit'}-${hit.via}-${hit.startMs ?? 0}`}
            title={`${formatClock(hit.startMs)} into the meeting — ${viaLabel(hit.via)}`}
            className={cx(
              'absolute top-[12px] h-3 w-[3px] rounded-full',
              hit.via === 'keyword' ? 'bg-canvas-text/60' : 'bg-signal-500'
            )}
            style={{ left: `${Math.min(98, Math.max(0, ((hit.startMs ?? 0) / span) * 100))}%` }}
          />
        ))}
        <span className="absolute right-0 top-[22px] font-mono text-[9px] uppercase tracking-[0.08em] text-canvas-faint">
          latest hit {formatClock(span)}
        </span>
      </div>

      <ul className="divide-y divide-canvas-hairline">
        {group.hits.slice(0, 6).map((hit) => (
          <li key={`${hit.segmentId ?? 'hit'}-${hit.via}-${hit.startMs ?? 0}-${hit.score}`}>
            <button
              type="button"
              onClick={() => openMeeting(hit.meetingId)}
              className="flex w-full items-start gap-3 px-3.5 py-2.5 text-left transition-colors duration-150 ease-spring hover:bg-canvas-sunken"
            >
              <span className="w-12 shrink-0 pt-0.5 text-right font-mono text-[11px] tabular-nums text-canvas-muted">
                {formatDuration(hit.startMs)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span className="shrink-0 text-[11px] font-semibold uppercase tracking-[0.1em] text-canvas-muted">
                    {hit.speakerLabel ?? 'Unknown'}
                  </span>
                  <span className="chip shrink-0 bg-canvas-sunken text-canvas-muted">
                    {viaLabel(hit.via)}
                  </span>
                </span>
                <span className="mt-1 block max-w-[70ch] text-[13.5px] leading-relaxed text-canvas-text">
                  {splitHighlight(hit.snippet, query).map((part, index) =>
                    part.match ? (
                      <mark key={index} className={MARK_CLASS}>
                        {part.text}
                      </mark>
                    ) : (
                      <span key={index}>{part.text}</span>
                    )
                  )}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {group.hits.length > 6 && (
        <p className="border-t border-canvas-hairline px-3.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-canvas-faint">
          {group.hits.length - 6} more hits in this meeting — open it to read the transcript
        </p>
      )}
    </article>
  )
}
