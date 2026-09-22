import type { SearchHit, SearchOptions } from '../../shared/types'
import { createLogger } from '../lib/log'
import { prepare } from './index'
import { searchByVector } from './embeddings'

const log = createLogger('search')

/**
 * Two retrieval paths, fused:
 *
 *  - Keyword: SQLite FTS5 with BM25 ranking, which is exact and instant.
 *  - Semantic: local embeddings + cosine scan, which finds meaning ("how did we
 *    handle the outage") even when the words differ.
 *
 * Results are merged with Reciprocal Rank Fusion, a simple technique that needs
 * no score calibration between the two very different scales.
 */

/**
 * Highlight markers used inside snippets. These are Unicode private-use
 * characters, so they can never collide with real transcript text.
 */
export const HL_OPEN = '\uE000'
export const HL_CLOSE = '\uE001'

/** Converts user input into a safe FTS5 MATCH expression. */
export function buildMatchExpression(query: string, mode: 'and' | 'or'): string | null {
  const tokens = query
    .toLowerCase()
    // Keep letters, numbers and apostrophes; drop FTS operators entirely.
    .split(/[^\p{L}\p{N}']+/u)
    .map((token) => token.replace(/^'+|'+$/g, ''))
    .filter((token) => token.length > 0)

  if (tokens.length === 0) return null

  // Quote each token so FTS5 treats it as a literal phrase and cannot interpret
  // it as an operator. Internal double quotes must be doubled.
  const quoted = tokens.map((token) => `"${token.replace(/"/g, '""')}"`)
  return quoted.join(mode === 'and' ? ' AND ' : ' OR ')
}

interface FtsRow {
  segment_id: string
  meeting_id: string
  snippet: string
  score: number
  start_ms: number
  speaker_label: string | null
  title: string
  started_at: number
}

function runKeyword(query: string, mode: 'and' | 'or', limit: number, sinceMs: number | null): FtsRow[] {
  const match = buildMatchExpression(query, mode)
  if (!match) return []

  try {
    const sql = `
      SELECT
        f.segment_id AS segment_id,
        f.meeting_id AS meeting_id,
        snippet(transcript_fts, 0, '${HL_OPEN}', '${HL_CLOSE}', '…', 14) AS snippet,
        bm25(transcript_fts) AS score,
        s.start_ms AS start_ms,
        s.speaker_label AS speaker_label,
        m.title AS title,
        m.started_at AS started_at
      FROM transcript_fts f
      JOIN transcript_segments s ON s.id = f.segment_id
      JOIN meetings m ON m.id = f.meeting_id
      WHERE transcript_fts MATCH ?
        AND (? IS NULL OR m.started_at >= ?)
      ORDER BY score
      LIMIT ?`

    return prepare(sql).all(match, sinceMs, sinceMs, limit) as FtsRow[]
  } catch (error) {
    log.warn(`FTS query failed for "${query}" (${mode})`, error)
    return []
  }
}

interface MeetingFtsRow {
  meeting_id: string
  snippet: string
  title: string
  started_at: number
  score: number
}

/** Searches meeting titles and summaries, so "budget review" finds the meeting. */
function runMeetingKeyword(query: string, limit: number, sinceMs: number | null): MeetingFtsRow[] {
  const match = buildMatchExpression(query, 'or')
  if (!match) return []
  try {
    return prepare(
      `SELECT
         f.meeting_id AS meeting_id,
         snippet(meeting_fts, -1, '${HL_OPEN}', '${HL_CLOSE}', '…', 14) AS snippet,
         m.title AS title,
         m.started_at AS started_at,
         bm25(meeting_fts) AS score
       FROM meeting_fts f
       JOIN meetings m ON m.id = f.meeting_id
       WHERE meeting_fts MATCH ?
         AND (? IS NULL OR m.started_at >= ?)
       ORDER BY score
       LIMIT ?`
    ).all(match, sinceMs, sinceMs, limit) as MeetingFtsRow[]
  } catch (error) {
    log.warn('meeting FTS query failed', error)
    return []
  }
}

/**
 * Like-based fallback for very short queries (1-2 characters) where FTS token
 * matching is unhelpful.
 */
function runLikeFallback(query: string, limit: number, sinceMs: number | null): FtsRow[] {
  const pattern = `%${query.replace(/[%_]/g, (m) => '\\' + m)}%`
  return prepare(
    `SELECT
       s.id AS segment_id, s.meeting_id AS meeting_id, s.text AS snippet,
       0 AS score, s.start_ms AS start_ms, s.speaker_label AS speaker_label,
       m.title AS title, m.started_at AS started_at
     FROM transcript_segments s
     JOIN meetings m ON m.id = s.meeting_id
     WHERE s.text LIKE ? ESCAPE '\\'
       AND (? IS NULL OR m.started_at >= ?)
     ORDER BY m.started_at DESC, s.start_ms ASC
     LIMIT ?`
  ).all(pattern, sinceMs, sinceMs, limit) as FtsRow[]
}

function truncate(text: string, max = 240): string {
  if (text.length <= max) return text
  return text.slice(0, max).replace(/\s+\S*$/, '') + '…'
}

export interface SemanticSearcher {
  (query: string, limit: number, meetingFilter?: string[]): Promise<Array<{ segmentId: string; score: number }>>
}

export interface SearchDeps {
  /** Provided by the embedder layer; omitted when no embedding model exists. */
  semantic?: SemanticSearcher
  model?: string
}

/**
 * Hybrid search. Keyword and semantic results are fused with RRF; each hit
 * reports which path(s) found it so the UI can be honest about provenance.
 */
export async function search(
  options: SearchOptions,
  deps: SearchDeps = {}
): Promise<SearchHit[]> {
  const query = options.query.trim()
  if (query.length === 0) return []

  const limit = Math.min(Math.max(options.limit ?? 40, 1), 200)
  const useKeyword = options.keyword !== false
  const useSemantic = options.semantic !== false
  const sinceMs =
    options.sinceDays && options.sinceDays > 0 ? Date.now() - options.sinceDays * 86_400_000 : null

  // Pull a deeper candidate list than we will return, so fusion has material.
  const pool = Math.max(limit * 3, 60)

  const keywordHits = useKeyword ? collectKeyword(query, pool, sinceMs) : []

  let semanticHits: Array<{ segmentId: string; score: number }> = []
  if (useSemantic && deps.semantic) {
    try {
      semanticHits = await deps.semantic(query, pool)
    } catch (error) {
      log.warn('semantic search failed; returning keyword results only', error)
    }
  }

  const K = 60 // RRF constant
  interface FusedEntry {
    hit: Omit<SearchHit, 'score' | 'via'>
    rrf: number
    via: Set<'keyword' | 'semantic'>
  }
  const fused = new Map<string, FusedEntry>()

  const ensure = (segmentId: string, hit: Omit<SearchHit, 'score' | 'via'>): FusedEntry => {
    const existing = fused.get(segmentId)
    if (existing) return existing
    const created: FusedEntry = { hit, rrf: 0, via: new Set<'keyword' | 'semantic'>() }
    fused.set(segmentId, created)
    return created
  }

  keywordHits.forEach((row, index) => {
    const entry = ensure(row.segmentId, {
      meetingId: row.meetingId,
      meetingTitle: row.title,
      startedAt: row.startedAt,
      segmentId: row.segmentId,
      snippet: truncate(row.snippet ?? ''),
      startMs: row.startMs,
      speakerLabel: row.speakerLabel
    })
    entry.rrf += 1 / (K + index + 1)
    entry.via.add('keyword')
  })

  semanticHits.forEach((row, index) => {
    // A semantic hit still needs segment text for display.
    const entry = fused.get(row.segmentId)
    if (entry) {
      entry.rrf += 1 / (K + index + 1)
      entry.via.add('semantic')
      return
    }
    const detail = getSegmentDetail(row.segmentId)
    if (!detail) return
    const created = ensure(row.segmentId, {
      meetingId: detail.meetingId,
      meetingTitle: detail.title,
      startedAt: detail.startedAt,
      segmentId: row.segmentId,
      snippet: truncate(detail.text),
      startMs: detail.startMs,
      speakerLabel: detail.speakerLabel
    })
    created.rrf += 1 / (K + index + 1)
    created.via.add('semantic')
  })

  const results: SearchHit[] = [...fused.values()].map((entry) => ({
    ...entry.hit,
    score: Number(entry.rrf.toFixed(6)),
    via:
      entry.via.has('keyword') && entry.via.has('semantic')
        ? 'both'
        : entry.via.has('keyword')
          ? 'keyword'
          : 'semantic'
  }))

  results.sort((a, b) => b.score - a.score)
  return results.slice(0, limit)
}

function collectKeyword(
  query: string,
  pool: number,
  sinceMs: number | null
): Array<{
  segmentId: string
  meetingId: string
  snippet: string
  title: string
  startedAt: number
  startMs: number
  speakerLabel: string | null
}> {
  // Prefer AND so "q3 budget" finds the sentence with both words; if that finds
  // nothing, relax to OR rather than showing an empty page.
  let rows = runKeyword(query, 'and', pool, sinceMs)
  if (rows.length === 0) rows = runKeyword(query, 'or', pool, sinceMs)
  if (rows.length === 0) rows = runLikeFallback(query, pool, sinceMs)

  return rows.map((row) => ({
    segmentId: row.segment_id,
    meetingId: row.meeting_id,
    snippet: row.snippet,
    title: row.title,
    startedAt: row.started_at,
    startMs: row.start_ms,
    speakerLabel: row.speaker_label
  }))
}

function getSegmentDetail(segmentId: string): {
  meetingId: string
  text: string
  startMs: number
  speakerLabel: string | null
  title: string
  startedAt: number
} | null {
  const row = prepare(
    `SELECT s.meeting_id, s.text, s.start_ms, s.speaker_label, m.title, m.started_at
     FROM transcript_segments s JOIN meetings m ON m.id = s.meeting_id
     WHERE s.id = ?`
  ).get(segmentId) as
    | {
        meeting_id: string
        text: string
        start_ms: number
        speaker_label: string | null
        title: string
        started_at: number
      }
    | undefined

  if (!row) return null
  return {
    meetingId: row.meeting_id,
    text: row.text,
    startMs: row.start_ms,
    speakerLabel: row.speaker_label,
    title: row.title,
    startedAt: row.started_at
  }
}

/**
 * Retrieves the most relevant transcript chunks for a question, used as context
 * for the local RAG answer.
 */
export async function retrieveContext(
  question: string,
  meetingIds: string[] | undefined,
  deps: SearchDeps,
  limit = 12
): Promise<
  Array<{
    segmentId: string
    meetingId: string
    text: string
    startMs: number
    title: string
    startedAt: number
    score: number
  }>
> {
  const hits = await search({ query: question, limit, semantic: true, keyword: true }, deps)

  const filtered =
    meetingIds && meetingIds.length > 0 ? hits.filter((h) => meetingIds.includes(h.meetingId)) : hits

  const out: Array<{
    segmentId: string
    meetingId: string
    text: string
    startMs: number
    title: string
    startedAt: number
    score: number
  }> = []

  for (const hit of filtered) {
    if (!hit.segmentId) continue
    const detail = getSegmentDetail(hit.segmentId)
    if (!detail) continue
    out.push({
      segmentId: hit.segmentId,
      meetingId: hit.meetingId,
      text: detail.text,
      startMs: detail.startMs,
      title: hit.meetingTitle,
      startedAt: hit.startedAt,
      score: hit.score
    })
  }
  return out
}

/** Cheap default: nearest-neighbour hits from an already-computed vector. */
export function semanticFromVector(
  vector: Float32Array,
  model: string,
  limit: number,
  meetingFilter?: string[]
): Array<{ segmentId: string; score: number }> {
  return searchByVector(vector, model, limit, meetingFilter)
}
