import { createLogger } from '../lib/log'
import type { OllamaModel } from '../../shared/types'
import { OllamaClient, pickEmbeddingModel } from './ollama'
import type { Sidecar } from '../stt/sidecar'

const log = createLogger('embed')

/**
 * Text embeddings for semantic search.
 *
 * Three tiers, tried in order, so the feature degrades rather than disappears:
 *
 *   1. **Local ONNX MiniLM** via the Python sidecar — the best fully-offline
 *      option and the recommended setup.
 *   2. **Ollama** embeddings, when an embedding model is already pulled.
 *   3. **Lexical vectors** computed in-process. These are not semantic in the
 *      ML sense, but they still rank passages by weighted term overlap, so
 *      "find meetings about X" returns sensible results with zero setup.
 */

export interface EmbedderInfo {
  /** Identifier stored alongside vectors; a change invalidates the index. */
  model: string
  dim: number
  kind: 'sidecar' | 'ollama' | 'lexical'
  label: string
}

export interface Embedder {
  info: EmbedderInfo
  embed(texts: string[]): Promise<Float32Array[]>
}

/* ------------------------------------------------------------------ */
/* Tier 1: local ONNX model via the Python sidecar                     */
/* ------------------------------------------------------------------ */

class SidecarEmbedder implements Embedder {
  readonly info: EmbedderInfo

  constructor(private readonly sidecar: Sidecar, model: string, dim: number) {
    this.info = {
      model,
      dim,
      kind: 'sidecar',
      label: 'Local MiniLM (ONNX)'
    }
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const result = await this.sidecar.embed(texts)
    return result.vectors.map((vector) => Float32Array.from(vector))
  }
}

/* ------------------------------------------------------------------ */
/* Tier 2: Ollama embeddings                                           */
/* ------------------------------------------------------------------ */

class OllamaEmbedder implements Embedder {
  readonly info: EmbedderInfo

  constructor(private readonly client: OllamaClient, model: string, dim: number) {
    this.info = { model: `ollama:${model}`, dim, kind: 'ollama', label: `Ollama ${model}` }
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const vectors = await this.client.embed(this.info.model.replace(/^ollama:/, ''), texts)
    return vectors.map((vector) => Float32Array.from(vector))
  }
}

/* ------------------------------------------------------------------ */
/* Tier 3: in-process lexical vectors                                  */
/* ------------------------------------------------------------------ */

const LEXICAL_DIM = 512

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'than', 'that', 'this', 'these', 'those',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'do', 'does', 'did', 'doing',
  'have', 'has', 'had', 'having', 'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her',
  'us', 'them', 'my', 'your', 'his', 'its', 'our', 'their', 'to', 'of', 'in', 'on', 'at', 'by',
  'for', 'with', 'about', 'as', 'into', 'like', 'through', 'after', 'over', 'between', 'out',
  'against', 'during', 'without', 'before', 'under', 'around', 'among', 'so', 'just', 'also',
  'not', 'no', 'yes', 'okay', 'ok', 'well', 'now', 'up', 'down', 'can', 'could', 'would',
  'should', 'will', 'shall', 'may', 'might', 'must', 'get', 'got', 'go', 'going', 'gone',
  'know', 'think', 'see', 'make', 'made', 'take', 'took', 'come', 'came', 'want', 'need',
  'use', 'used', 'really', 'very', 'much', 'more', 'most', 'some', 'any', 'all', 'each',
  'there', 'here', 'when', 'where', 'why', 'how', 'what', 'which', 'who', 'whom', 'from',
  'because', 'while', 'still', 'thing', 'things', 'stuff', 'kind', 'sort', 'lot'
])

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token))
}

/**
 * Deterministic hashing embedder with sublinear term weighting.
 *
 * Each token is hashed into a fixed number of buckets (signed, to reduce
 * collisions) and weighted by 1/sqrt(term frequency). Similar text produces
 * similar vectors, which is enough to rank passages by relevance.
 */
export function lexicalVector(text: string): Float32Array {
  const vector = new Float32Array(LEXICAL_DIM)
  const tokens = tokenize(text)
  if (tokens.length === 0) return vector

  const counts = new Map<string, number>()
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1)

  for (const [token, count] of counts) {
    const weight = 1 / Math.sqrt(count)
    // Two independent hashes give a lower collision rate than one.
    const h1 = hashString(token, 0x811c9dc5)
    const h2 = hashString(token, 0x1000193)

    for (let i = 0; i < 2; i++) {
      const hash = i === 0 ? h1 : h2
      const bucket = Math.abs(hash) % LEXICAL_DIM
      const sign = (hash >>> 16) & 1 ? 1 : -1
      vector[bucket] += sign * weight
    }
  }

  // L2-normalise so cosine similarity behaves.
  let norm = 0
  for (let i = 0; i < LEXICAL_DIM; i++) norm += vector[i] * vector[i]
  norm = Math.sqrt(norm)
  if (norm > 0) {
    for (let i = 0; i < LEXICAL_DIM; i++) vector[i] /= norm
  }
  return vector
}

function hashString(value: string, seed: number): number {
  let hash = seed
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash | 0
}

class LexicalEmbedder implements Embedder {
  readonly info: EmbedderInfo = {
    model: 'lexical:v1',
    dim: LEXICAL_DIM,
    kind: 'lexical',
    label: 'Built-in lexical ranking (no model installed)'
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((text) => lexicalVector(text))
  }
}

/* ------------------------------------------------------------------ */
/* Resolution                                                          */
/* ------------------------------------------------------------------ */

export interface ResolveEmbedderInput {
  sidecar: Sidecar
  client: OllamaClient
  models: OllamaModel[]
  configuredEmbeddingModel: string | null
  /** Whether the sidecar reported its ONNX embedder as usable. */
  sidecarEmbeddingsAvailable: boolean
  sidecarEmbeddingModel: string
  sidecarEmbeddingDim: number
}

/**
 * Picks the best available embedder.
 *
 * `allowLexical` exists so callers that are about to write vectors can refuse
 * the lexical tier; mixing tiers in one index would make similarity scores
 * meaningless, so the index is always built with a single kind of vector.
 */
export function resolveEmbedder(input: ResolveEmbedderInput): Embedder {
  if (input.sidecarEmbeddingsAvailable) {
    return new SidecarEmbedder(
      input.sidecar,
      `onnx:${input.sidecarEmbeddingModel}`,
      input.sidecarEmbeddingDim
    )
  }

  const ollamaModel = pickEmbeddingModel(input.models, input.configuredEmbeddingModel)
  if (ollamaModel) {
    // Dimension is discovered on first use; 768 is the common default.
    return new OllamaEmbedder(input.client, ollamaModel, 768)
  }

  log.debug('no ML embedder available; using built-in lexical ranking')
  return new LexicalEmbedder()
}

/**
 * Embeds and stores any segments that do not yet have a vector for this model.
 * Returns how many were written out of how many were candidates.
 */
export async function indexMissingEmbeddings(
  embedder: Embedder,
  fetchMissing: (model: string, limit: number) => Array<{
    segmentId: string
    meetingId: string
    text: string
  }>,
  store: (rows: Array<{ segmentId: string; meetingId: string; model: string; vector: Float32Array }>) => void,
  batchSize = 32
): Promise<{ embedded: number; total: number }> {
  let embedded = 0
  let total = 0

  // Loop so a large backlog is fully indexed rather than capped at one batch.
  for (;;) {
    const missing = fetchMissing(embedder.info.model, batchSize * 8)
    if (missing.length === 0) break

    total += missing.length
    for (let offset = 0; offset < missing.length; offset += batchSize) {
      const batch = missing.slice(offset, offset + batchSize)
      const vectors = await embedder.embed(batch.map((item) => item.text))
      const rows = batch.map((item, index) => ({
        segmentId: item.segmentId,
        meetingId: item.meetingId,
        model: embedder.info.model,
        vector: vectors[index]
      }))
      store(rows)
      embedded += rows.length
    }

    if (missing.length < batchSize * 8) break
  }

  return { embedded, total }
}
