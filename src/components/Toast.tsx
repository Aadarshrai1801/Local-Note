/**
 * Transient messages. Toasts never carry anything the user must act on — the
 * design keeps important results inline (see the Live view's "What did I miss?"
 * panel) so a toast can safely disappear.
 *
 * They float above all content, so they are one of the few places that use the
 * glass treatment.
 */
import { useEffect, type ReactNode } from 'react'
import { cx } from '@/lib/format'
import { Icon, type IconName } from '@/components/Icon'
import { dismissToast, useToasts, type Toast, type ToastLevel } from '@/lib/store'

const TONES: Record<ToastLevel, { icon: string; glyph: IconName }> = {
  info: { icon: 'text-ink-300', glyph: 'info' },
  warn: { icon: 'text-ember-300', glyph: 'alert' },
  error: { icon: 'text-danger-400', glyph: 'alert' }
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
      className="glass-strong animate-fade-up pointer-events-auto flex w-[min(26rem,calc(100vw-2rem))] items-start gap-2.5 rounded-card px-3.5 py-3"
    >
      <Icon name={tone.glyph} size={15} className={cx('mt-0.5 shrink-0', tone.icon)} />
      <p className="flex-1 text-[13px] leading-relaxed text-ink-100">{toast.message}</p>
      <button
        type="button"
        aria-label="Dismiss message"
        onClick={() => dismissToast(toast.id)}
        className="-mr-1 -mt-0.5 rounded-full p-1 text-ink-400 transition-colors duration-150 ease-spring hover:bg-ink-800 hover:text-ink-100"
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
