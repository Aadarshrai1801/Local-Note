/**
 * Dictionary: terms that bias the speech model toward the spellings you use.
 *
 * Editing is inline and validated locally, because a dictionary entry that
 * silently fails to save is worse than no dictionary at all.
 */
import { useState, type ReactNode } from 'react'
import type { AppSettings, DictionaryTerm } from '@shared/types'
import { api } from '@/lib/api'
import { cx, formatCount, formatDateShort, plural } from '@/lib/format'
import { useAsyncData } from '@/lib/hooks'
import { attempt, saveSettings, pushToast, useSettings } from '@/lib/store'
import { Button, IconButton } from '@/components/Button'
import { EmptyState, ErrorState, LoadingBlock } from '@/components/EmptyState'
import { Icon } from '@/components/Icon'

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
      <h1 className="mt-2 text-[26px] font-medium tracking-[-0.025em] text-ink-50">
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
      <section className="mt-8 rounded-md border border-ink-800 bg-ink-900/50">
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
              className={cx('field', error && 'border-red-500/50')}
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
              className="field"
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
              className="field"
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
            className="flex items-center gap-1.5 border-t border-red-500/20 bg-red-500/[0.06] px-3.5 py-2 text-[12.5px] text-red-300"
          >
            <Icon name="alert" size={13} />
            {error}
          </p>
        )}
      </section>

      {/* Table ----------------------------------------------------- */}
      <section className="mt-8" aria-labelledby="dict-table-heading">
        <div className="flex items-baseline gap-3 pb-2">
          <h2 id="dict-table-heading" className="section-title">
            Terms
          </h2>
          <span className="font-mono text-[11px] text-ink-600">
            {plural(list.length, 'term')}
          </span>
          <span aria-hidden="true" className="h-px flex-1 bg-ink-800/70" />
          <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-600">
            hover a row to edit
          </span>
        </div>

        {terms.error && list.length === 0 ? (
          <ErrorState message={terms.error} onRetry={terms.refresh} />
        ) : terms.loading && list.length === 0 ? (
          <LoadingBlock label="Loading dictionary…" />
        ) : list.length === 0 ? (
          <EmptyState
            compact
            title="No terms yet"
            description="Add the product names, people and acronyms that keep coming back wrong. Two or three well-chosen terms make a noticeable difference."
          />
        ) : (
          <TermTable
            terms={list}
            onUpdated={(updated) =>
              terms.setData((prev) =>
                (prev ?? []).map((item) => (item.id === updated.id ? updated : item))
              )
            }
            onDeleted={(id) => terms.setData((prev) => (prev ?? []).filter((item) => item.id !== id))}
          />
        )}
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
    <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-ink-800 bg-ink-900/40 px-3.5 py-3">
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
        <span className="chip">terms are still stored for later</span>
      )}
    </div>
  )
}

interface TermTableProps {
  terms: DictionaryTerm[]
  onUpdated: (term: DictionaryTerm) => void
  onDeleted: (id: string) => void
}

function TermTable({ terms, onUpdated, onDeleted }: TermTableProps): ReactNode {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const remove = async (term: DictionaryTerm): Promise<void> => {
    setBusyId(term.id)
    const ok = await attempt(async () => {
      await api.deleteDictionaryTerm(term.id)
      return true
    }, { errorPrefix: 'Could not delete the term' })
    setBusyId(null)
    if (ok) onDeleted(term.id)
  }

  const sorted = [...terms].sort((a, b) => b.hitCount - a.hitCount || a.term.localeCompare(b.term))

  return (
    <div className="overflow-hidden rounded-md border border-ink-800">
      <table className="w-full border-collapse text-left">
        <thead>
          <tr className="bg-ink-900/70">
            <th scope="col" className="eyebrow px-3 py-2 font-normal">
              Term
            </th>
            <th scope="col" className="eyebrow px-3 py-2 font-normal">
              Replacement
            </th>
            <th scope="col" className="eyebrow hidden px-3 py-2 font-normal md:table-cell">
              Notes
            </th>
            <th scope="col" className="eyebrow px-3 py-2 text-right font-normal">
              Hits
            </th>
            <th scope="col" className="eyebrow hidden px-3 py-2 font-normal lg:table-cell">
              Added
            </th>
            <th scope="col" className="px-3 py-2">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-ink-800/70">
          {sorted.map((term) =>
            editingId === term.id ? (
              <TermEditRow
                key={term.id}
                term={term}
                existing={terms}
                onCancel={() => setEditingId(null)}
                onSaved={(updated) => {
                  onUpdated(updated)
                  setEditingId(null)
                }}
              />
            ) : (
              <tr key={term.id} className="group hover:bg-ink-900/40">
                <td className="px-3 py-2.5 align-top">
                  <span className="flex items-center gap-2">
                    <span className="font-mono text-[12.5px] text-ink-100">{term.term}</span>
                    {duplicateOf(term, terms) && (
                      <span className="chip">
                        <Icon name="alert" size={10} />
                        duplicate
                      </span>
                    )}
                  </span>
                </td>
                <td className="px-3 py-2.5 align-top">
                  {term.replacement ? (
                    <span className="font-mono text-[12.5px] text-signal-300">
                      {term.replacement}
                    </span>
                  ) : (
                    <span className="font-mono text-[12px] text-ink-600">bias only</span>
                  )}
                </td>
                <td className="hidden max-w-[24rem] px-3 py-2.5 align-top text-[12.5px] leading-relaxed text-ink-400 md:table-cell">
                  {term.notes ?? <span className="text-ink-600">—</span>}
                </td>
                <td className="px-3 py-2.5 text-right align-top">
                  <span
                    className={cx(
                      'font-mono text-[12px] tabular-nums',
                      term.hitCount > 0 ? 'text-ink-200' : 'text-ink-600'
                    )}
                  >
                    {formatCount(term.hitCount)}
                  </span>
                </td>
                <td className="hidden px-3 py-2.5 align-top font-mono text-[11px] text-ink-500 lg:table-cell">
                  {formatDateShort(term.createdAt)}
                </td>
                <td className="px-3 py-2.5 align-top">
                  <span className="flex items-center justify-end gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                    <IconButton
                      label={`Edit ${term.term}`}
                      size="sm"
                      onClick={() => setEditingId(term.id)}
                    >
                      <Icon name="pencil" size={13} />
                    </IconButton>
                    <IconButton
                      label={`Delete ${term.term}`}
                      size="sm"
                      disabled={busyId === term.id}
                      onClick={() => void remove(term)}
                    >
                      <Icon name="trash" size={13} />
                    </IconButton>
                  </span>
                </td>
              </tr>
            )
          )}
        </tbody>
      </table>
    </div>
  )
}

function duplicateOf(term: DictionaryTerm, terms: DictionaryTerm[]): boolean {
  return terms.some(
    (other) =>
      other.id !== term.id && other.term.trim().toLowerCase() === term.term.trim().toLowerCase()
  )
}

interface TermEditRowProps {
  term: DictionaryTerm
  existing: DictionaryTerm[]
  onCancel: () => void
  onSaved: (term: DictionaryTerm) => void
}

function TermEditRow({ term, existing, onCancel, onSaved }: TermEditRowProps): ReactNode {
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
    <tr className="bg-signal-500/[0.05]">
      <td colSpan={6} className="px-3 py-3">
        <form
          className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.4fr)_auto]"
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <div>
            <label className="eyebrow mb-1 block text-ink-500" htmlFor={`edit-term-${term.id}`}>
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
              className={cx('field field-sm font-mono', error && 'border-red-500/50')}
              aria-invalid={error != null}
            />
          </div>
          <div>
            <label
              className="eyebrow mb-1 block text-ink-500"
              htmlFor={`edit-replacement-${term.id}`}
            >
              Replacement
            </label>
            <input
              id={`edit-replacement-${term.id}`}
              value={replacement}
              onChange={(event) => setReplacement(event.target.value)}
              placeholder="leave empty to only bias"
              className="field field-sm font-mono"
            />
          </div>
          <div>
            <label className="eyebrow mb-1 block text-ink-500" htmlFor={`edit-notes-${term.id}`}>
              Notes
            </label>
            <input
              id={`edit-notes-${term.id}`}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              className="field field-sm"
            />
          </div>
          <div className="flex items-start gap-2 pt-5">
            <Button size="sm" variant="primary" type="submit" loading={saving}>
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </form>
        {error && (
          <p role="alert" className="mt-2 flex items-center gap-1.5 text-[12.5px] text-red-300">
            <Icon name="alert" size={13} />
            {error}
          </p>
        )}
      </td>
    </tr>
  )
}
