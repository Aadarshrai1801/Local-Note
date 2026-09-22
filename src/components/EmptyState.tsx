/**
 * Empty, loading, and error placeholders. Every view uses these so a failed
 * backend call can never produce a blank screen.
 */
import type { ReactNode } from 'react'
import { cx } from '@/lib/format'
import { Button } from '@/components/Button'
import { Icon } from '@/components/Icon'

export interface EmptyStateProps {
  title: string
  description?: ReactNode
  action?: ReactNode
  /** Eyebrow text above the title, e.g. "No meetings". */
  eyebrow?: string
  tone?: 'neutral' | 'signal'
  className?: string
  compact?: boolean
}

export function EmptyState({
  title,
  description,
  action,
  eyebrow,
  tone = 'neutral',
  className,
  compact = false
}: EmptyStateProps): ReactNode {
  return (
    <div
      className={cx(
        'flex flex-col items-start gap-3 rounded-md border border-dashed border-ink-800 text-left',
        compact ? 'px-5 py-6' : 'px-6 py-10',
        tone === 'signal' && 'border-signal-500/25 bg-signal-500/[0.04]',
        className
      )}
    >
      {eyebrow && (
        <span className={cx('eyebrow', tone === 'signal' && 'text-signal-400')}>{eyebrow}</span>
      )}
      <h3 className="text-[15px] font-medium tracking-tight text-ink-100">{title}</h3>
      {description && (
        <div className="max-w-prose text-[13px] leading-relaxed text-ink-400">{description}</div>
      )}
      {action && <div className="mt-1 flex flex-wrap items-center gap-2">{action}</div>}
    </div>
  )
}

export interface ErrorStateProps {
  title?: string
  message: string
  onRetry?: () => void
  className?: string
  compact?: boolean
}

export function ErrorState({
  title = 'Something went wrong',
  message,
  onRetry,
  className,
  compact = false
}: ErrorStateProps): ReactNode {
  return (
    <div
      role="alert"
      className={cx(
        'flex flex-col items-start gap-3 rounded-md border border-red-500/25 bg-red-500/[0.06]',
        compact ? 'px-5 py-4' : 'px-6 py-6',
        className
      )}
    >
      <div className="flex items-center gap-2 text-red-300">
        <Icon name="alert" size={16} />
        <h3 className="text-[14px] font-medium tracking-tight">{title}</h3>
      </div>
      <p className="max-w-prose text-[13px] leading-relaxed text-ink-300">{message}</p>
      {onRetry && (
        <Button size="sm" variant="secondary" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  )
}

/** Neutral skeleton block; used to hold layout while data loads. */
export function Skeleton({
  className,
  width
}: {
  className?: string
  width?: string
}): ReactNode {
  return (
    <span
      aria-hidden="true"
      style={width ? { width } : undefined}
      className={cx('block h-3 rounded bg-ink-800/70', className)}
    />
  )
}

export interface LoadingBlockProps {
  label?: string
  className?: string
}

/** Reserves vertical space so data arriving never shifts the layout. */
export function LoadingBlock({ label = 'Loading…', className }: LoadingBlockProps): ReactNode {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cx('flex items-center gap-2 py-4 text-[13px] text-ink-500', className)}
    >
      <span className="relative flex h-1.5 w-1.5">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-ink-500 opacity-60" />
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-ink-400" />
      </span>
      {label}
    </div>
  )
}
