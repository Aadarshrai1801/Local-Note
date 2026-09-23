/**
 * Dictionary: terms that bias the speech model toward the spellings you use.
 *
 * Editing is inline and validated locally, because a dictionary entry that
 * silently fails to save is worse than no dictionary at all. The add form and
 * the on/off switch stay on dark chrome; the term list itself is the light
 * content surface, where long notes read best.
 */
import { useState, type ReactNode } from 'react'
import type { AppSettings, DictionaryTerm } from '@shared/types'
import { api } from '@/lib/api'
import { cx, formatCount, formatDateShort, plural } from '@/lib/format'
import { useAsyncData } from '@/lib/hooks'
import { attempt, saveSettings, pushToast, useSettings } from '@/lib/store'
import { Button } from '@/components/Button'
import { EmptyState, ErrorState, LoadingBlock } from '@/components/EmptyState'
import { Icon } from '@/components/Icon'

/** The light-surface equivalent of `.field`, for inputs inside a canvas card. */
const CANVAS_FIELD =
  'w-full rounded-control border border-canvas-hairline bg-canvas px-3 py-2 text-[13.5px] text-canvas-text placeholder:text-canvas-faint transition-colors duration-150 ease-spring focus:border-signal-500/50 focus:outline-none'

export function Dictionary(): ReactNode {
  const settings = useSettings()
  const terms = useAsyncData(() => api.listDictionary(), [], {
    toastOnError: 'Could not load the dictionary'
  })
  const list = terms.data ?? []

  const [draftTerm, setDraftTerm] = useState('')
  const [draftReplacement, setDraftReplacement] = useState('')
  const [draftNotes, setDraftNotes] = useState('')
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const duplicate = (term: string, exceptId?: string): boolean =>
    list.some(
      (item) => item.id !== exceptId && item.term.trim().toLowerCase() === term.trim().toLowerCase()
    )

  const add = async (): Promise<void> => {
    const term = draftTerm.trim()
    if (term.length === 0) {
      setError('Enter a term first.')
      return
    }
    if (duplicate(term)) {
      setError(`“${term}” is already in the dictionary.`)
      return
    }
    setError(null)
    setAdding(true)
    const created = await attempt(
      () => api.addDictionaryTerm(term, draftReplacement.trim() || null, draftNotes.trim() || null),
      { errorPrefix: 'Could not add the term' }
    )
    setAdding(false)
    if (created) {
      terms.setData((prev) => [...(prev ?? []), created])
      setDraftTerm('')
      setDraftReplacement('')
      setDraftNotes('')
      pushToast('info', `“${created.term}” will now bias the speech model.`)
    }
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-8 py-9 lg:px-12">
      <p className="eyebrow">Dictionary</p>
      <h1 className="mt-2 text-[30px] font-medium leading-[1.15] tracking-[-0.025em] text-ink-50">
        The words this office actually uses
      </h1>
      <p className="mt-3 max-w-[70ch] text-[13.5px] leading-relaxed text-ink-400">
        These terms are handed to the speech model as a hint before it listens, which is what stops
        product names becoming nonsense. When a near-miss still gets through — “wazzup i” instead of
        “WASAPI” — the term is auto-corrected in the transcript and marked as corrected, using the
        spelling in the <span className="text-ink-200">replacement</span> column. Nothing is sent
        anywhere to make this work.
      </p>

      {/* Toggle ---------------------------------------------------- */}
      <DictionaryToggle settings={settings} />

      {/* Add ------------------------------------------------------- */}
      <section className="mt-6 rounded-panel border border-ink-800 bg-ink-900/50">
        <div className="flex items-center gap-2 border-b border-ink-800/80 px-3.5 py-2">
          <Icon name="plus" size={13} className="text-ink-500" />
          <h2 className="eyebrow text-ink-400">Add a term</h2>
        </div>
        <form
          className="grid gap-3 p-3.5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.4fr)_auto]"
          onSubmit={(event) => {
            event.preventDefault()
            void add()
          }}
        >
          <div>
            <label htmlFor="dict-term" className="eyebrow mb-1 block text-ink-500">
              Term (as heard)
            </label>
            <input
              id="dict-term"
              value={draftTerm}
              onChange={(event) => {
                setDraftTerm(event.target.value)
                setError(null)
              }}
              placeholder="wazzup i"
              className={cx('field text-[13.5px]', error && 'border-danger-500/50')}
              aria-invalid={error != null}
              aria-describedby={error ? 'dict-error' : undefined}
            />
          </div>
          <div>
            <label htmlFor="dict-replacement" className="eyebrow mb-1 block text-ink-500">
              Replacement
            </label>
            <input
              id="dict-replacement"
              value={draftReplacement}
              onChange={(event) => setDraftReplacement(event.target.value)}
              placeholder="WASAPI"
              className="field text-[13.5px]"
            />
          </div>
          <div>
            <label htmlFor="dict-notes" className="eyebrow mb-1 block text-ink-500">
              Notes
            </label>
            <input
              id="dict-notes"
              value={draftNotes}
              onChange={(event) => setDraftNotes(event.target.value)}
              placeholder="Why this matters"
              className="field text-[13.5px]"
            />
          </div>
          <div className="flex items-end">
            <Button
              type="submit"
              variant="primary"
              loading={adding}
              disabled={draftTerm.trim().length === 0}
              icon={<Icon name="plus" size={13} />}
            >
              Add
            </Button>
          </div>
        </form>
        {error && (
          <p
            id="dict-error"
            role="alert"
            className="flex items-center gap-1.5 border-t border-danger-500/20 bg-danger-500/[0.06] px-3.5 py-2 text-[13px] text-danger-400"
          >
            <Icon name="alert" size={13} />
            {error}
          </p>
        )}
      </section>

      {/* Terms ----------------------------------------------------- */}
      <section className="mt-8" aria-labelledby="dict-list-heading">
        <div className="flex items-baseline gap-3 pb-3">
          <h2 id="dict-list-heading" className="eyebrow text-ink-400">
            Terms
          </h2>
          <span className="font-mono text-[11px] text-ink-500">{plural(list.length, 'term')}</span>
          <span aria-hidden="true" className="h-px flex-1 bg-ink-800/70" />
          <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-500">
            hover a card to edit
          </span>
        </div>

        <div className="canvas-surface rounded-panel border border-ink-800 p-4 shadow-lift">
          {terms.error && list.length === 0 ? (
            <ErrorState message={terms.error} onRetry={terms.refresh} onCanvas />
          ) : terms.loading && list.length === 0 ? (
            <LoadingBlock label="Loading dictionary…" onCanvas />
          ) : list.length === 0 ? (
            <EmptyState
              compact
              tone="canvas"
              title="No terms yet"
              description="Add the product names, people and acronyms that keep coming back wrong. Two or three well-chosen terms make a noticeable difference."
            />
          ) : (
            <TermList
              terms={list}
              onUpdated={(updated) =>
                terms.setData((prev) =>
                  (prev ?? []).map((item) => (item.id === updated.id ? updated : item))
                )
              }
              onDeleted={(id) =>
                terms.setData((prev) => (prev ?? []).filter((item) => item.id !== id))
              }
            />
          )}
        </div>
      </section>
    </div>
  )
}

function DictionaryToggle({ settings }: { settings: AppSettings | null }): ReactNode {
  const [saving, setSaving] = useState(false)
  const enabled = settings?.dictionaryEnabled ?? true

  const toggle = async (): Promise<void> => {
    setSaving(true)
    await saveSettings({ dictionaryEnabled: !enabled })
    setSaving(false)
  }

  return (
    <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-panel border border-ink-800 bg-ink-900/50 px-3.5 py-3">
      <label className="flex cursor-pointer items-center gap-2 text-[13px] text-ink-200">
        <input
          type="checkbox"
          checked={enabled}
          disabled={saving || settings == null}
          onChange={() => void toggle()}
          className="h-3.5 w-3.5 accent-signal-500"
        />
        Use the dictionary during transcription
      </label>
      <span className="font-mono text-[11px] text-ink-500">
        {enabled ? 'biasing the model' : 'disabled — raw output only'}
      </span>
      {!enabled && (
        <span className="chip bg-ink-800/70 text-ink-300">terms are still stored for later</span>
      )}
    </div>
  )
}

interface TermListProps {
  terms: DictionaryTerm[]
  onUpdated: (term: DictionaryTerm) => void
  onDeleted: (id: string) => void
}

function TermList({ terms, onUpdated, onDeleted }: TermListProps): ReactNode {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const remove = async (term: DictionaryTerm): Promise<void> => {
    setBusyId(term.id)
    const ok = await attempt(
      async () => {
        await api.deleteDictionaryTerm(term.id)
        return true
      },
      { errorPrefix: 'Could not delete the term' }
    )
    setBusyId(null)
    if (ok) onDeleted(term.id)
  }

  const sorted = [...terms].sort((a, b) => b.hitCount - a.hitCount || a.term.localeCompare(b.term))

  return (
    <ul className="space-y-2.5">
      {sorted.map((term) =>
        editingId === term.id ? (
          <li
            key={term.id}
            className="animate-fade-up rounded-card border border-signal-500/40 bg-canvas-raised p-3.5 shadow-lift"
          >
            <TermEditForm
              term={term}
              existing={terms}
              onCancel={() => setEditingId(null)}
              onSaved={(updated) => {
                onUpdated(updated)
                setEditingId(null)
              }}
            />
          </li>
        ) : (
          <li
            key={term.id}
            className="group rounded-card border border-canvas-hairline bg-canvas-raised p-3.5 shadow-lift transition-all duration-200 ease-spring hover:-translate-y-px hover:shadow-float"
          >
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="chip bg-ink-900 font-mono text-ink-100">{term.term}</span>
                  <Icon name="chevronRight" size={12} className="text-canvas-faint" />
                  {term.replacement ? (
                    <span className="chip border border-canvas-hairline bg-canvas-sunken font-mono text-canvas-text">
                      {term.replacement}
                    </span>
                  ) : (
                    <span className="chip bg-canvas-sunken font-mono text-canvas-muted">
                      bias only
                    </span>
                  )}
                  {duplicateOf(term, terms) && (
                    <span className="chip bg-danger-500/10 text-danger-600">
                      <Icon name="alert" size={10} />
                      duplicate
                    </span>
                  )}
                </div>

                {term.notes && (
                  <p className="mt-2 max-w-[70ch] text-[13.5px] leading-relaxed text-canvas-muted">
                    {term.notes}
                  </p>
                )}

                <p className="mt-2 flex items-center gap-3 font-mono text-[11px] text-canvas-muted">
                  <span className={cx(term.hitCount > 0 && 'text-canvas-text')}>
                    {formatCount(term.hitCount)} hits
                  </span>
                  <span>added {formatDateShort(term.createdAt)}</span>
                </p>
              </div>

              <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-150 ease-spring group-hover:opacity-100 group-focus-within:opacity-100">
                <button
                  type="button"
                  aria-label={`Edit ${term.term}`}
                  title="Edit"
                  onClick={() => setEditingId(term.id)}
                  className="flex h-7 w-7 items-center justify-center rounded-full text-canvas-muted transition-colors duration-150 ease-spring hover:bg-canvas-sunken hover:text-canvas-text"
                >
                  <Icon name="pencil" size={13} />
                </button>
                <button
                  type="button"
                  aria-label={`Delete ${term.term}`}
                  title="Delete"
                  disabled={busyId === term.id}
                  onClick={() => void remove(term)}
                  className="flex h-7 w-7 items-center justify-center rounded-full text-canvas-muted transition-colors duration-150 ease-spring hover:bg-danger-500/10 hover:text-danger-600 disabled:opacity-40"
                >
                  <Icon name="trash" size={13} />
                </button>
              </div>
            </div>
          </li>
        )
      )}
    </ul>
  )
}

function duplicateOf(term: DictionaryTerm, terms: DictionaryTerm[]): boolean {
  return terms.some(
    (other) =>
      other.id !== term.id && other.term.trim().toLowerCase() === term.term.trim().toLowerCase()
  )
}

interface TermEditFormProps {
  term: DictionaryTerm
  existing: DictionaryTerm[]
  onCancel: () => void
  onSaved: (term: DictionaryTerm) => void
}

function TermEditForm({ term, existing, onCancel, onSaved }: TermEditFormProps): ReactNode {
  const [value, setValue] = useState(term.term)
  const [replacement, setReplacement] = useState(term.replacement ?? '')
  const [notes, setNotes] = useState(term.notes ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async (): Promise<void> => {
    const next = value.trim()
    if (next.length === 0) {
      setError('A term cannot be empty.')
      return
    }
    if (
      existing.some(
        (other) => other.id !== term.id && other.term.trim().toLowerCase() === next.toLowerCase()
      )
    ) {
      setError(`“${next}” is already in the dictionary.`)
      return
    }
    setError(null)
    setSaving(true)
    const updated = await attempt(
      () =>
        api.updateDictionaryTerm(term.id, {
          term: next,
          replacement: replacement.trim() || null,
          notes: notes.trim() || null
        }),
      { errorPrefix: 'Could not save the term' }
    )
    setSaving(false)
    if (updated) onSaved(updated)
  }

  return (
    <form
      className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.4fr)_auto]"
      onSubmit={(event) => {
        event.preventDefault()
        void save()
      }}
    >
      <div>
        <label className="eyebrow mb-1 block text-canvas-muted" htmlFor={`edit-term-${term.id}`}>
          Term
        </label>
        <input
          id={`edit-term-${term.id}`}
          value={value}
          onChange={(event) => {
            setValue(event.target.value)
            setError(null)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') onCancel()
          }}
          autoFocus
          className={cx(CANVAS_FIELD, 'font-mono', error && 'border-danger-500/60')}
          aria-invalid={error != null}
        />
      </div>
      <div>
        <label
          className="eyebrow mb-1 block text-canvas-muted"
          htmlFor={`edit-replacement-${term.id}`}
        >
          Replacement
        </label>
        <input
          id={`edit-replacement-${term.id}`}
          value={replacement}
          onChange={(event) => setReplacement(event.target.value)}
          placeholder="leave empty to only bias"
          className={cx(CANVAS_FIELD, 'font-mono')}
        />
      </div>
      <div>
        <label className="eyebrow mb-1 block text-canvas-muted" htmlFor={`edit-notes-${term.id}`}>
          Notes
        </label>
        <input
          id={`edit-notes-${term.id}`}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          className={CANVAS_FIELD}
        />
      </div>
      <div className="flex items-start gap-2 pt-5">
        <Button size="sm" variant="primary" type="submit" loading={saving}>
          Save
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="text-canvas-muted hover:bg-canvas-sunken hover:text-canvas-text"
          onClick={onCancel}
        >
          Cancel
        </Button>
      </div>
      {error && (
        <p
          role="alert"
          className="flex items-center gap-1.5 text-[13px] text-danger-600 lg:col-span-4"
        >
          <Icon name="alert" size={13} />
          {error}
        </p>
      )}
    </form>
  )
}
