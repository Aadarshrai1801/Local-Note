/**
 * Action items: a checkbox list bound straight to the backend.
 *
 * Every mutation is optimistic-free on purpose — the checkbox reflects the
 * stored value, and a failed write pushes a toast and reverts. An action the
 * user cannot trust is worse than a slow one.
 */
import { useState, type ReactNode } from 'react'
import type { ActionItem } from '@shared/types'
import { api } from '@/lib/api'
import { cx } from '@/lib/format'
import { attempt } from '@/lib/store'
import { Button, IconButton } from '@/components/Button'
import { Icon } from '@/components/Icon'
import { EmptyState } from '@/components/EmptyState'

export interface ActionItemListProps {
  meetingId: string
  items: ActionItem[]
  /** Called after a successful write so the parent can refetch/bump. */
  onChange: () => void
  className?: string
  /** Shows the "regenerate from transcript" affordance. */
  onRegenerate?: () => void
  regenerating?: boolean
}

export function ActionItemList({
  meetingId,
  items,
  onChange,
  className,
  onRegenerate,
  regenerating = false
}: ActionItemListProps): ReactNode {
  const [draft, setDraft] = useState('')
  const [assignee, setAssignee] = useState('')
  const [adding, setAdding] = useState(false)
  const [pendingId, setPendingId] = useState<string | null>(null)

  const sorted = [...items].sort((a, b) =>
    a.done === b.done ? a.position - b.position : a.done ? 1 : -1
  )

  const toggle = async (item: ActionItem): Promise<void> => {
    setPendingId(item.id)
    const ok = await attempt(async () => {
      await api.updateActionItem(item.id, { done: !item.done })
      return true
    }, { errorPrefix: 'Could not update the action item' })
    setPendingId(null)
    if (ok) onChange()
  }

  const updateText = async (item: ActionItem, text: string): Promise<void> => {
    const trimmed = text.trim()
    if (trimmed.length === 0 || trimmed === item.text) return
    setPendingId(item.id)
    const ok = await attempt(async () => {
      await api.updateActionItem(item.id, { text: trimmed })
      return true
    }, { errorPrefix: 'Could not rename the action item' })
    setPendingId(null)
    if (ok) onChange()
  }

  const updateAssignee = async (item: ActionItem, next: string): Promise<void> => {
    const trimmed = next.trim()
    const value = trimmed.length > 0 ? trimmed : null
    if (value === item.assignee) return
    setPendingId(item.id)
    const ok = await attempt(async () => {
      await api.updateActionItem(item.id, { assignee: value })
      return true
    }, { errorPrefix: 'Could not reassign the action item' })
    setPendingId(null)
    if (ok) onChange()
  }

  const remove = async (item: ActionItem): Promise<void> => {
    setPendingId(item.id)
    const ok = await attempt(async () => {
      await api.deleteActionItem(item.id)
      return true
    }, { errorPrefix: 'Could not delete the action item' })
    setPendingId(null)
    if (ok) onChange()
  }

  const add = async (): Promise<void> => {
    const text = draft.trim()
    if (text.length === 0) return
    setAdding(true)
    const created = await attempt(
      () => api.addActionItem(meetingId, text, assignee.trim() || null),
      { errorPrefix: 'Could not add the action item' }
    )
    setAdding(false)
    if (created) {
      setDraft('')
      setAssignee('')
      onChange()
    }
  }

  return (
    <div className={cx('flex flex-col gap-3', className)}>
      {sorted.length === 0 ? (
        <EmptyState
          compact
          title="No action items yet"
          description="They are extracted locally after a recording stops, or you can add one by hand below."
          action={
            onRegenerate ? (
              <Button
                size="sm"
                variant="signal"
                loading={regenerating}
                icon={<Icon name="sparkle" size={13} />}
                onClick={onRegenerate}
              >
                Extract from transcript
              </Button>
            ) : undefined
          }
        />
      ) : (
        <ul className="divide-y divide-ink-800/70">
          {sorted.map((item) => (
            <li key={item.id} className="group flex items-start gap-3 py-2.5">
              <label className="flex cursor-pointer items-start gap-3">
                <input
                  type="checkbox"
                  checked={item.done}
                  disabled={pendingId === item.id}
                  onChange={() => void toggle(item)}
                  className="mt-[3px] h-3.5 w-3.5 shrink-0 cursor-pointer appearance-none rounded-[3px] border border-ink-600 bg-ink-950 transition-colors checked:border-signal-500 checked:bg-signal-500/80 disabled:opacity-50"
                  style={
                    item.done
                      ? {
                          backgroundImage:
                            "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='%230b1118' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M3 8.5 6.4 12 13 4.5'/%3E%3C/svg%3E\")",
                          backgroundSize: '100%'
                        }
                      : undefined
                  }
                  aria-label={item.done ? `Mark “${item.text}” as not done` : `Mark “${item.text}” as done`}
                />
                <span className="sr-only">Done</span>
              </label>

              <div className="min-w-0 flex-1">
                <textarea
                  defaultValue={item.text}
                  rows={2}
                  disabled={pendingId === item.id}
                  onBlur={(event) => void updateText(item, event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      event.currentTarget.blur()
                    }
                    if (event.key === 'Escape') {
                      event.currentTarget.value = item.text
                      event.currentTarget.blur()
                    }
                  }}
                  aria-label="Action item text"
                  className={cx(
                    'w-full resize-none rounded-control border border-transparent bg-transparent px-1.5 py-1 text-[13.5px] leading-relaxed transition-colors duration-150 ease-spring',
                    'hover:border-ink-800 focus:border-ink-700 focus:outline-none',
                    item.done ? 'text-ink-500 line-through' : 'text-ink-100'
                  )}
                />
                <div className="mt-1 flex items-center gap-1.5 px-1">
                  <Icon name="user" size={11} className="shrink-0 text-ink-600" />
                  <input
                    defaultValue={item.assignee ?? ''}
                    placeholder="unassigned"
                    disabled={pendingId === item.id}
                    onBlur={(event) => void updateAssignee(item, event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') event.currentTarget.blur()
                    }}
                    aria-label="Assignee"
                    title="Assignee — type a name to reassign"
                    className={cx(
                      'w-32 rounded-control border border-transparent bg-transparent py-0.5 font-mono text-[11px] uppercase tracking-[0.08em] transition-colors duration-150 ease-spring',
                      'hover:border-ink-800 focus:border-ink-700 focus:text-ink-100 focus:outline-none',
                      item.assignee ? 'text-signal-300' : 'text-ink-500 placeholder:text-ink-600'
                    )}
                  />
                </div>
              </div>

              <IconButton
                label="Delete action item"
                size="sm"
                variant="ghost"
                className="opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
                onClick={() => void remove(item)}
              >
                <Icon name="trash" size={14} />
              </IconButton>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-2">
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void add()
          }}
          placeholder="Add an action item…"
          aria-label="New action item"
          className="field flex-1 py-1.5 text-[13.5px]"
        />
        <input
          value={assignee}
          onChange={(event) => setAssignee(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void add()
          }}
          placeholder="assignee"
          aria-label="New action item assignee"
          className="field w-28 py-1.5 font-mono text-[11px] uppercase tracking-[0.08em]"
        />
        <Button
          size="sm"
          variant="secondary"
          loading={adding}
          disabled={draft.trim().length === 0}
          icon={<Icon name="plus" size={13} />}
          onClick={() => void add()}
        >
          Add
        </Button>
      </div>
    </div>
  )
}
