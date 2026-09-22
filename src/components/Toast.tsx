/**
 * Transient messages. Toasts never carry anything the user must act on — the
 * design keeps important results inline (see the Live view's "What did I miss?"
 * panel) so a toast can safely disappear.
 */
import { useEffect, type ReactNode } from 'react'
import { cx } from '@/lib/format'
import { Icon, type IconName } from '@/components/Icon'
import { dismissToast, useToasts, type Toast, type ToastLevel } from '@/lib/store'

const TONES: Record<ToastLevel, { ring: string; icon: string; glyph: IconName }> = {
  info: { ring: 'border-ink-700 bg-ink-900', icon: 'text-ink-300', glyph: 'info' },
  warn: { ring: 'border-ember-500/40 bg-ink-900', icon: 'text-ember-300', glyph: 'alert' },
  error: { ring: 'border-red-500/40 bg-ink-900', icon: 'text-red-300', glyph: 'alert' }
}

const AUTO_DISMISS_MS = 7000

function ToastRow({ toast }: { toast: Toast }): ReactNode {
  useEffect(() => {
    const id = window.setTimeout(() => dismissToast(toast.id), AUTO_DISMISS_MS)
    return () => window.clearTimeout(id)
  }, [toast.id])

  const tone = TONES[toast.level]
  return (
    <div
      role={toast.level === 'error' ? 'alert' : 'status'}
      className={cx(
        'animate-fade-up pointer-events-auto flex w-[min(26rem,calc(100vw-2rem))] items-start gap-2.5 rounded-md border px-3.5 py-3 shadow-panel',
        tone.ring
      )}
    >
      <Icon name={tone.glyph} size={15} className={cx('mt-0.5 shrink-0', tone.icon)} />
      <p className="flex-1 text-[13px] leading-relaxed text-ink-200">{toast.message}</p>
      <button
        type="button"
        aria-label="Dismiss message"
        onClick={() => dismissToast(toast.id)}
        className="-mr-1 -mt-0.5 rounded p-1 text-ink-500 transition-colors hover:bg-ink-800 hover:text-ink-200"
      >
        <Icon name="x" size={13} />
      </button>
    </div>
  )
}

export function ToastViewport(): ReactNode {
  const toasts = useToasts()
  return (
    <div
      aria-live="polite"
      aria-relevant="additions"
      className="pointer-events-none fixed bottom-5 right-5 z-50 flex flex-col items-end gap-2"
    >
      {toasts.map((toast) => (
        <ToastRow key={toast.id} toast={toast} />
      ))}
    </div>
  )
}
