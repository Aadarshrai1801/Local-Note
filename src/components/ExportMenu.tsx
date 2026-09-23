/**
 * Export popover: one trigger, three formats, no modal.
 *
 * Used both in the meeting header (default trigger) and in the Home card quick
 * actions (compact trigger). The floating panel uses the glass treatment so it
 * reads as sitting above content on either surface.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { cx } from '@/lib/format'
import { useEscape } from '@/lib/hooks'
import { Icon } from '@/components/Icon'

export type ExportFormat = 'md' | 'txt' | 'json'

const OPTIONS: Array<{ format: ExportFormat; label: string; hint: string }> = [
  { format: 'md', label: 'Markdown', hint: 'Readable notes with headings' },
  { format: 'txt', label: 'Plain text', hint: 'Timestamped transcript only' },
  { format: 'json', label: 'JSON', hint: 'Everything, for scripting' }
]

export interface ExportMenuProps {
  exporting: ExportFormat | null
  onExport: (format: ExportFormat) => void
  /** `compact` is the round icon trigger used on the light note cards. */
  variant?: 'default' | 'compact'
  className?: string
}

export function ExportMenu({
  exporting,
  onExport,
  variant = 'default',
  className
}: ExportMenuProps): ReactNode {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const firstItemRef = useRef<HTMLButtonElement | null>(null)

  useEscape(() => setOpen(false), open)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent): void => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open])

  useEffect(() => {
    if (open) firstItemRef.current?.focus()
  }, [open])

  const close = (): void => {
    setOpen(false)
    triggerRef.current?.focus()
  }

  return (
    <div ref={containerRef} className={cx('relative', className)}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={variant === 'compact' ? 'Export this meeting' : undefined}
        title={variant === 'compact' ? 'Export' : undefined}
        disabled={exporting != null}
        onClick={() => setOpen((prev) => !prev)}
        className={cx(
          variant === 'compact'
            ? 'flex h-7 w-7 items-center justify-center rounded-full text-canvas-muted transition-colors duration-150 ease-spring hover:bg-canvas-sunken hover:text-canvas-text disabled:opacity-40'
            : 'btn btn-quiet h-7 gap-1.5 px-2.5 text-[12px]',
          exporting != null && 'opacity-60'
        )}
      >
        <Icon name="download" size={variant === 'compact' ? 14 : 13} />
        {variant === 'default' && (
          <>
            <span className="truncate">Export</span>
            <Icon name="chevronDown" size={12} />
          </>
        )}
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Export format"
          className="glass-strong animate-scale-in absolute right-0 top-full z-30 mt-1.5 w-64 origin-top-right overflow-hidden rounded-card"
        >
          {OPTIONS.map((option, index) => (
            <button
              key={option.format}
              ref={index === 0 ? firstItemRef : undefined}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false)
                onExport(option.format)
              }}
              className="flex w-full items-baseline gap-3 px-3.5 py-2.5 text-left transition-colors duration-150 ease-spring hover:bg-ink-800/70"
            >
              <span className="w-20 shrink-0 text-[13px] text-ink-100">{option.label}</span>
              <span className="min-w-0 flex-1 text-[12px] leading-snug text-ink-400">
                {option.hint}
              </span>
              <span className="shrink-0 font-mono text-[10px] uppercase text-ink-500">
                .{option.format}
              </span>
            </button>
          ))}
          <p className="border-t border-ink-800 px-3.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-500">
            written to your data folder
          </p>
        </div>
      )}
    </div>
  )
}
