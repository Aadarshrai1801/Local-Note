import { createLogger } from '../lib/log'
import { prepare } from './index'

/**
 * Vector storage for semantic search.
 *
 * Embeddings are stored as raw Float32 blobs and compared with a brute-force
 * cosine scan. At the scale of a personal meeting archive (tens of thousands of
 * segments at 384 dimensions) this is well under a tenth of a second, and it
 * avoids depending on a native SQLite extension — which keeps the app free of
 * compiled dependencies.
 */

const log = createLogger('embeddings')

export interface EmbeddingRow {
  segmentId: string
  meetingId: string
  model: string
  dim: number
  vector: Float32Array
}

/** Serialises a vector for SQLite. Values are stored as-is (not normalised). */
export function vectorToBlob(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength))
}

export function blobToVector(blob: Uint8Array, dim: number): Float32Array {
  // Copy into an aligned buffer; a Uint8Array view over a SQLite BLOB is not
  // guaranteed to sit on a 4-byte boundary.
  const copy = new Uint8Array(blob.byteLength)
  copy.set(blob)
  const vector = new Float32Array(copy.buffer, 0, Math.floor(copy.byteLength / 4))
  return vector.length === dim ? vector : vector.subarray(0, dim)
}

export function upsertEmbedding(
  segmentId: string,
  meetingId: string,
  model: string,
  vector: Float32Array
): void {
  prepare(
    `INSERT INTO embeddings(segment_id, meeting_id, model, dim, vector) VALUES(?, ?, ?, ?, ?)
     ON CONFLICT(segment_id) DO UPDATE SET
       model = excluded.model, dim = excluded.dim, vector = excluded.vector`
  ).run(segmentId, meetingId, model, vector.length, vectorToBlob(vector))
}

export function upsertEmbeddings(
  rows: Array<{ segmentId: string; meetingId: string; model: string; vector: Float32Array }>
): void {
  if (rows.length === 0) return
  for (const row of rows) {
    upsertEmbedding(row.segmentId, row.meetingId, row.model, row.vector)
  }
}

export function deleteEmbeddingsForMeeting(meetingId: string): void {
  prepare('DELETE FROM embeddings WHERE meeting_id = ?').run(meetingId)
}

export function countEmbeddings(model?: string): number {
  const row = model
    ? (prepare('SELECT COUNT(*) AS n FROM embeddings WHERE model = ?').get(model) as { n: number })
    : (prepare('SELECT COUNT(*) AS n FROM embeddings').get() as { n: number })
  return row.n
}

/** Segment ids that have no embedding yet, for incremental indexing. */
export function segmentsMissingEmbeddings(model: string, limit = 5000): Array<{
  segmentId: string
  meetingId: string
  text: string
}> {
  const rows = prepare(
    `SELECT s.id AS segment_id, s.meeting_id AS meeting_id, s.text AS text
     FROM transcript_segments s
     LEFT JOIN embeddings e ON e.segment_id = s.id AND e.model = ?
     WHERE e.segment_id IS NULL
     ORDER BY s.meeting_id, s.start_ms
     LIMIT ?`
  ).all(model, limit) as Array<{ segment_id: string; meeting_id: string; text: string }>
  return rows.map((r) => ({ segmentId: r.segment_id, meetingId: r.meeting_id, text: r.text }))
}

let cache: { model: string; rows: EmbeddingRow[]; builtAt: number } | null = null
const CACHE_TTL_MS = 15_000

export function invalidateEmbeddingCache(): void {
  cache = null
}

/**
 * Loads all embeddings for a model into memory. Cached briefly because a single
 * search issues one scan but the UI may fire several searches in a row.
 */
export function loadEmbeddings(model: string): EmbeddingRow[] {
  if (cache && cache.model === model && Date.now() - cache.builtAt < CACHE_TTL_MS) {
    return cache.rows
  }

  const started = Date.now()
  const rows = prepare('SELECT segment_id, meeting_id, model, dim, vector FROM embeddings WHERE model = ?').all(
    model
  ) as Array<{ segment_id: string; meeting_id: string; model: string; dim: number; vector: Uint8Array }>

  const mapped: EmbeddingRow[] = rows.map((row) => ({
    segmentId: row.segment_id,
    meetingId: row.meeting_id,
    model: row.model,
    dim: row.dim,
    vector: blobToVector(row.vector, row.dim)
  }))

  cache = { model, rows: mapped, builtAt: Date.now() }
  log.debug(`loaded ${mapped.length} embeddings in ${Date.now() - started}ms`)
  return mapped
}

/** Cosine similarity. Returns 0 for zero-length or mismatched vectors. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const length = Math.min(a.length, b.length)
  if (length === 0) return 0

  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

export interface SimilarityHit {
  segmentId: string
  meetingId: string
  score: number
}

/**
 * Brute-force nearest-neighbour scan.
 *
 * `meetingFilter` lets "ask about this meeting" avoid scanning the whole
 * archive.
 */
export function searchByVector(
  query: Float32Array,
  model: string,
  limit: number,
  meetingFilter?: string[]
): SimilarityHit[] {
  const rows = loadEmbeddings(model)
  const allow = meetingFilter && meetingFilter.length > 0 ? new Set(meetingFilter) : null

  const scored: SimilarityHit[] = []
  for (const row of rows) {
    if (allow && !allow.has(row.meetingId)) continue
    const score = cosineSimilarity(query, row.vector)
    scored.push({ segmentId: row.segmentId, meetingId: row.meetingId, score })
  }

  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit)
}
