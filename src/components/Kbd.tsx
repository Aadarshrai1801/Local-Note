/**
 * A small keyboard hint. Deliberately quiet: shortcuts are surfaced inline
 * next to the control they trigger, never as a wall of tooltips.
 */
import type { ReactNode } from 'react'
import { cx } from '@/lib/format'

export interface KbdProps {
  children: ReactNode
  /** Match the surface the hint sits on. */
  tone?: 'dark' | 'canvas' | 'accent'
  className?: string
}

export function Kbd({ children, tone = 'dark', className }: KbdProps): ReactNode {
  return (
    <kbd
      className={cx(
        'inline-flex h-[18px] select-none items-center rounded-[6px] border px-1.5 font-mono text-[10px] font-normal leading-none',
        tone === 'canvas'
          ? 'border-canvas-hairline bg-canvas-sunken text-canvas-muted'
          : tone === 'accent'
            ? 'border-ink-950/30 bg-ink-950/15 text-ink-950'
            : 'border-ink-700 bg-ink-900/70 text-ink-400',
        className
      )}
    >
      {children}
    </kbd>
  )
}
