import type { DictionaryTerm } from '../../shared/types'
import { newId, nullableText, prepare } from './index'

/**
 * The personal dictionary improves accuracy in two complementary ways:
 *
 *  1. Before transcription: terms are passed to Whisper as an "initial prompt",
 *     which biases the decoder toward the expected vocabulary.
 *  2. After transcription: near-miss words are corrected with a fuzzy match, so
 *     "kubernetes" is fixed even when the model heard "cubernetes".
 */

interface DictionaryRow {
  id: string
  term: string
  replacement: string | null
  notes: string | null
  created_at: number
  hit_count: number
}

function mapTerm(row: DictionaryRow): DictionaryTerm {
  return {
    id: row.id,
    term: row.term,
    replacement: row.replacement,
    notes: row.notes,
    createdAt: row.created_at,
    hitCount: row.hit_count
  }
}

export function listDictionary(): DictionaryTerm[] {
  const rows = prepare('SELECT * FROM dictionary_terms ORDER BY lower(term) ASC').all() as DictionaryRow[]
  return rows.map(mapTerm)
}

export function addDictionaryTerm(
  term: string,
  replacement: string | null,
  notes: string | null
): DictionaryTerm {
  const clean = term.trim()
  if (clean.length === 0) throw new Error('A dictionary term cannot be empty.')
  if (clean.length > 120) throw new Error('Dictionary terms must be 120 characters or fewer.')

  const existing = prepare('SELECT id FROM dictionary_terms WHERE lower(term) = lower(?)').get(clean) as
    | { id: string }
    | undefined
  if (existing) throw new Error(`"${clean}" is already in your dictionary.`)

  const id = newId('dic')
  prepare(
    'INSERT INTO dictionary_terms(id, term, replacement, notes, created_at, hit_count) VALUES(?, ?, ?, ?, ?, 0)'
  ).run(id, clean, nullableText(replacement), nullableText(notes), Date.now())

  const row = prepare('SELECT * FROM dictionary_terms WHERE id = ?').get(id) as DictionaryRow
  return mapTerm(row)
}

export function updateDictionaryTerm(
  id: string,
  patch: Partial<Pick<DictionaryTerm, 'term' | 'replacement' | 'notes'>>
): DictionaryTerm {
  const sets: string[] = []
  const values: Array<string | null> = []

  if (patch.term !== undefined) {
    const clean = patch.term.trim()
    if (clean.length === 0) throw new Error('A dictionary term cannot be empty.')
    const clash = prepare('SELECT id FROM dictionary_terms WHERE lower(term) = lower(?) AND id <> ?').get(
      clean,
      id
    ) as { id: string } | undefined
    if (clash) throw new Error(`"${clean}" is already in your dictionary.`)
    sets.push('term = ?')
    values.push(clean)
  }
  if (patch.replacement !== undefined) {
    sets.push('replacement = ?')
    values.push(nullableText(patch.replacement))
  }
  if (patch.notes !== undefined) {
    sets.push('notes = ?')
    values.push(nullableText(patch.notes))
  }

  if (sets.length > 0) {
    values.push(id)
    prepare(`UPDATE dictionary_terms SET ${sets.join(', ')} WHERE id = ?`).run(...values)
  }

  const row = prepare('SELECT * FROM dictionary_terms WHERE id = ?').get(id) as DictionaryRow | undefined
  if (!row) throw new Error('That dictionary term no longer exists.')
  return mapTerm(row)
}

export function deleteDictionaryTerm(id: string): void {
  prepare('DELETE FROM dictionary_terms WHERE id = ?').run(id)
}

function incrementHit(id: string, by: number): void {
  prepare('UPDATE dictionary_terms SET hit_count = hit_count + ? WHERE id = ?').run(by, id)
}

/* ------------------------------------------------------------------ */
/* STT biasing                                                         */
/* ------------------------------------------------------------------ */

/**
 * Builds the Whisper "initial prompt" from dictionary terms.
 *
 * Whisper only attends to roughly the final 224 tokens of a prompt, so this
 * keeps the list bounded and prefers the terms the user has actually been
 * getting wrong (highest hit counts first).
 */
export function buildSttPrompt(extraContext?: string | null): string {
  const terms = listDictionary()
  if (terms.length === 0) {
    return extraContext?.trim() ? extraContext.trim().slice(0, 800) : ''
  }

  const ranked = [...terms].sort((a, b) => b.hitCount - a.hitCount)
  const parts: string[] = []
  let budget = 700

  for (const term of ranked) {
    const phrase = term.replacement ?? term.term
    if (parts.length > 0) budget -= 2 // ", "
    if (phrase.length > budget) break
    parts.push(phrase)
    budget -= phrase.length
    if (parts.length >= 120) break
  }

  let prompt = parts.join(', ')
  const context = extraContext?.trim()
  if (context) {
    prompt = `${prompt}. ${context.slice(0, 300)}`
  }
  return prompt
}

/* ------------------------------------------------------------------ */
/* Post-processing correction                                          */
/* ------------------------------------------------------------------ */

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length

  // Single-row dynamic programming keeps this allocation-free per call.
  let previous = new Array<number>(b.length + 1)
  let current = new Array<number>(b.length + 1)

  for (let j = 0; j <= b.length; j++) previous[j] = j

  for (let i = 1; i <= a.length; i++) {
    current[0] = i
    const ca = a.charCodeAt(i - 1)
    for (let j = 1; j <= b.length; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost)
    }
    const swap = previous
    previous = current
    current = swap
  }

  return previous[b.length]
}

export interface CorrectionResult {
  text: string
  changes: Array<{ from: string; to: string; termId: string }>
}

/**
 * Applies dictionary corrections to a finished segment.
 *
 * Deliberately conservative: it only rewrites a word when the edit distance is
 * small relative to the word length, so ordinary words are not mangled. This
 * runs on completed text only, never on the in-flight segment, so the live
 * transcript does not flicker.
 */
export function correctText(text: string, terms: DictionaryTerm[]): CorrectionResult {
  if (terms.length === 0) return { text, changes: [] }

  const changes: Array<{ from: string; to: string; termId: string }> = []
  const candidates = terms
    .map((term) => ({
      term,
      canonical: (term.replacement ?? term.term).trim(),
      // Compare case-insensitively against the raw term, since that is what
      // the user typed as the "correct" form.
      compare: term.term.trim().toLowerCase()
    }))
    .filter((c) => c.canonical.length > 0)

  if (candidates.length === 0) return { text, changes: [] }

  const corrected = text.replace(/\b[\p{L}\p{N}][\p{L}\p{N}'’\-]*\b/gu, (word) => {
    const lower = word.toLowerCase()

    // Exact (case-insensitive) match: normalise to the canonical spelling
    // (this fixes capitalisation) but never count it as a fuzzy hit.
    const exact = candidates.find((c) => c.compare === lower)
    if (exact) return exact.canonical

    if (word.length < 4) return word

    let best: { candidate: (typeof candidates)[number]; distance: number } | null = null
    for (const candidate of candidates) {
      // Length difference alone rules most candidates out cheaply.
      if (Math.abs(candidate.compare.length - lower.length) > 2) continue
      const distance = levenshtein(lower, candidate.compare)
      if (!best || distance < best.distance) best = { candidate, distance }
    }
    if (!best) return word

    const allowed = best.candidate.compare.length <= 6 ? 1 : 2
    if (best.distance === 0 || best.distance > allowed) return word

    // Require a meaningful similarity ratio so short words are not over-corrected.
    const similarity = 1 - best.distance / Math.max(lower.length, best.candidate.compare.length)
    if (similarity < 0.72) return word

    changes.push({ from: word, to: best.candidate.canonical, termId: best.candidate.term.id })
    return best.candidate.canonical
  })

  return { text: corrected, changes }
}

/** Records how often each term was corrected, which feeds prompt ranking. */
export function recordCorrectionHits(changes: Array<{ termId: string }>): void {
  if (changes.length === 0) return
  const counts = new Map<string, number>()
  for (const change of changes) {
    counts.set(change.termId, (counts.get(change.termId) ?? 0) + 1)
  }
  for (const [id, count] of counts) incrementHit(id, count)
}
