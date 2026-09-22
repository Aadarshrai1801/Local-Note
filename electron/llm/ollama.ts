import { createLogger } from '../lib/log'
import type { LlmStatus, OllamaModel } from '../../shared/types'

const log = createLogger('ollama')

/**
 * Client for a local Ollama server (http://127.0.0.1:11434 by default).
 *
 * Ollama is the only component that runs as a separate service. It is entirely
 * optional: when it is not installed, Local Note still records and transcribes,
 * and the AI panels explain how to enable them. Nothing here ever contacts a
 * remote host — the base URL is fixed to loopback by default and validated.
 */

const DEFAULT_HOST = 'http://127.0.0.1:11434'
const REQUEST_TIMEOUT_MS = 300_000

export interface OllamaTag {
  name: string
  model: string
  size: number
  details?: { parameter_size?: string; family?: string }
}

/** Rejects any host that is not loopback, enforcing the offline guarantee. */
export function assertLocalHost(host: string): string {
  const trimmed = host.trim().replace(/\/+$/, '')
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error(`Ollama host is not a valid URL: ${host}`)
  }

  const allowed = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0'])
  if (!allowed.has(parsed.hostname)) {
    throw new Error(
      `Refusing to contact "${parsed.hostname}": Local Note only talks to a local Ollama ` +
        'instance on this machine, so that no meeting data can leave it.'
    )
  }
  return trimmed
}

async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fn(controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

export class OllamaClient {
  constructor(private readonly host: string = DEFAULT_HOST) {}

  private base(): string {
    return assertLocalHost(this.host)
  }

  /** Lists installed models. Returns null when the server is unreachable. */
  async listModels(): Promise<OllamaModel[] | null> {
    try {
      const response = await withTimeout(
        (signal) => fetch(`${this.base()}/api/tags`, { signal }),
        8_000
      )
      if (!response.ok) return null
      const body = (await response.json()) as { models?: OllamaTag[] }
      const models = (body.models ?? []).map((model) => ({
        name: model.name,
        sizeBytes: typeof model.size === 'number' ? model.size : null,
        parameterSize: model.details?.parameter_size ?? null
      }))
      // Stable ordering keeps the settings dropdown from jumping around.
      models.sort((a, b) => a.name.localeCompare(b.name))
      return models
    } catch {
      // Ollama simply not being installed is the normal case, not an error.
      log.debug(`ollama not reachable at ${this.host}`)
      return null
    }
  }

  async isAvailable(): Promise<boolean> {
    return (await this.listModels()) !== null
  }

  /** Single-shot text generation. */
  async generate(params: {
    model: string
    prompt: string
    system?: string
    temperature?: number
    /** Ask Ollama to constrain output to JSON. */
    json?: boolean
    numCtx?: number
  }): Promise<string> {
    const body: Record<string, unknown> = {
      model: params.model,
      prompt: params.prompt,
      stream: false,
      options: {
        temperature: params.temperature ?? 0.2,
        ...(params.numCtx ? { num_ctx: params.numCtx } : {})
      }
    }
    if (params.system) body.system = params.system
    if (params.json) body.format = 'json'

    const response = await withTimeout((signal) =>
      fetch(`${this.base()}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal
      })
    )

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`Ollama returned ${response.status}${text ? `: ${text.slice(0, 300)}` : ''}`)
    }

    const payload = (await response.json()) as { response?: string }
    return (payload.response ?? '').trim()
  }

  /**
   * Embedding endpoint that works across Ollama versions: newer builds expose
   * /api/embed, older ones only /api/embeddings.
   */
  async embed(model: string, texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return []

    try {
      const response = await withTimeout(
        (signal) =>
          fetch(`${this.base()}/api/embed`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, input: texts }),
            signal
          }),
        120_000
      )
      if (response.ok) {
        const payload = (await response.json()) as { embeddings?: number[][] }
        if (Array.isArray(payload.embeddings) && payload.embeddings.length === texts.length) {
          return payload.embeddings
        }
      }
    } catch (error) {
      log.debug('/api/embed unavailable, falling back to /api/embeddings', error)
    }

    // Legacy per-text endpoint.
    const vectors: number[][] = []
    for (const text of texts) {
      const response = await withTimeout(
        (signal) =>
          fetch(`${this.base()}/api/embeddings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, prompt: text }),
            signal
          }),
        120_000
      )
      if (!response.ok) throw new Error(`Ollama embeddings failed with status ${response.status}`)
      const payload = (await response.json()) as { embedding?: number[] }
      if (!Array.isArray(payload.embedding)) throw new Error('Ollama returned no embedding vector')
      vectors.push(payload.embedding)
    }
    return vectors
  }

  /** Full status for the settings and setup screens. */
  async status(
    selectedModel: string | null,
    embeddingModel: string | null,
    /** Reuse an already-fetched model list to avoid probing twice. */
    preloaded?: OllamaModel[] | null
  ): Promise<LlmStatus> {
    const models = preloaded !== undefined ? preloaded : await this.listModels()

    if (models === null) {
      return {
        available: false,
        host: this.host,
        models: [],
        selectedModel: null,
        embeddingModel: null,
        error: null,
        guidance:
          'Ollama is not running. Install it once from https://ollama.com/download, then run ' +
          '"ollama pull llama3.1:8b". Summaries and Q&A stay disabled until then — recording and ' +
          'transcription work without it.'
      }
    }

    const modelNames = new Set(models.map((model) => model.name))
    const chosen = selectedModel && modelNames.has(selectedModel) ? selectedModel : models[0]?.name ?? null

    return {
      available: models.length > 0,
      host: this.host,
      models,
      selectedModel: chosen,
      embeddingModel: embeddingModel && modelNames.has(embeddingModel) ? embeddingModel : null,
      error: null,
      guidance:
        models.length === 0
          ? 'Ollama is running but has no models yet. Run "ollama pull llama3.1:8b" to download one.'
          : null
    }
  }
}

/** Models that are suitable for embeddings, in preference order. */
export const PREFERRED_EMBEDDING_MODELS = [
  'nomic-embed-text',
  'mxbai-embed-large',
  'all-minilm',
  'snowflake-arctic-embed'
]

export function pickEmbeddingModel(models: OllamaModel[], configured: string | null): string | null {
  if (configured && models.some((model) => model.name === configured)) return configured
  for (const preferred of PREFERRED_EMBEDDING_MODELS) {
    const match = models.find((model) => model.name === preferred || model.name.startsWith(`${preferred}:`))
    if (match) return match.name
  }
  return null
}

/** Models that tend to follow instructions well enough for summarisation. */
export const PREFERRED_SUMMARY_MODELS = [
  'llama3.1:8b',
  'llama3.2',
  'llama3.1',
  'qwen2.5',
  'mistral',
  'phi3',
  'gemma2'
]

export function pickSummaryModel(models: OllamaModel[], configured: string | null): string | null {
  if (configured && models.some((model) => model.name === configured)) return configured

  for (const preferred of PREFERRED_SUMMARY_MODELS) {
    const match = models.find(
      (model) => model.name === preferred || model.name.startsWith(`${preferred.split(':')[0]}:`)
    )
    if (match) return match.name
  }
  return models[0]?.name ?? null
}
