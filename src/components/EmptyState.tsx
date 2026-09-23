/**
 * Empty, loading, and error placeholders. Every view uses these so a failed
 * backend call can never produce a blank screen.
 *
 * `tone="canvas"` switches the palette to the light content surface, and
 * `onCanvas` does the same for the smaller states (error / loading / skeleton)
 * that sit inside a light panel.
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
  tone?: 'neutral' | 'signal' | 'canvas'
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
  const canvas = tone === 'canvas'
  return (
    <div
      className={cx(
        'flex flex-col items-start gap-3 text-left',
        canvas
          ? 'rounded-panel border border-dashed border-canvas-hairline'
          : 'rounded-panel border border-dashed border-ink-800',
        compact ? 'px-5 py-6' : 'px-6 py-10',
        tone === 'signal' && 'border-signal-500/25 bg-signal-500/[0.04]',
        className
      )}
    >
      {eyebrow && (
        <span
          className={cx(
            'eyebrow',
            canvas && 'text-canvas-muted',
            tone === 'signal' && 'text-signal-400'
          )}
        >
          {eyebrow}
        </span>
      )}
      <h3
        className={cx(
          'text-[15px] font-medium tracking-tight',
          canvas ? 'text-canvas-text' : 'text-ink-100'
        )}
      >
        {title}
      </h3>
      {description && (
        <div
          className={cx(
            'max-w-prose text-[13px] leading-relaxed',
            canvas ? 'text-canvas-muted' : 'text-ink-400'
          )}
        >
          {description}
        </div>
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
  /** Set when the error is rendered on the light content surface. */
  onCanvas?: boolean
}

export function ErrorState({
  title = 'Something went wrong',
  message,
  onRetry,
  className,
  compact = false,
  onCanvas = false
}: ErrorStateProps): ReactNode {
  return (
    <div
      role="alert"
      className={cx(
        'flex flex-col items-start gap-3 rounded-panel border border-danger-500/30 bg-danger-500/[0.06]',
        compact ? 'px-5 py-4' : 'px-6 py-6',
        className
      )}
    >
      <div className={cx('flex items-center gap-2', onCanvas ? 'text-danger-600' : 'text-danger-400')}>
        <Icon name="alert" size={16} />
        <h3 className="text-[14px] font-medium tracking-tight">{title}</h3>
      </div>
      <p
        className={cx(
          'max-w-prose text-[13px] leading-relaxed',
          onCanvas ? 'text-canvas-muted' : 'text-ink-300'
        )}
      >
        {message}
      </p>
      {onRetry && (
        <Button size="sm" variant={onCanvas ? 'primary' : 'secondary'} onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  )
}

/** Neutral skeleton block; used to hold layout while data loads. */
export function Skeleton({
  className,
  width,
  onCanvas = false
}: {
  className?: string
  width?: string
  onCanvas?: boolean
}): ReactNode {
  return (
    <span
      aria-hidden="true"
      style={width ? { width } : undefined}
      className={cx(
        'block h-3 rounded-control',
        onCanvas ? 'bg-canvas-hairline' : 'bg-ink-800/70',
        className
      )}
    />
  )
}

export interface LoadingBlockProps {
  label?: string
  className?: string
  onCanvas?: boolean
}

/** Reserves vertical space so data arriving never shifts the layout. */
export function LoadingBlock({
  label = 'Loading…',
  className,
  onCanvas = false
}: LoadingBlockProps): ReactNode {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cx(
        'flex items-center gap-2 py-4 text-[13px]',
        onCanvas ? 'text-canvas-muted' : 'text-ink-500',
        className
      )}
    >
      <span className="relative flex h-1.5 w-1.5">
        <span
          className={cx(
            'absolute inline-flex h-full w-full animate-ping rounded-full opacity-60',
            onCanvas ? 'bg-canvas-faint' : 'bg-ink-500'
          )}
        />
        <span
          className={cx(
            'relative inline-flex h-1.5 w-1.5 rounded-full',
            onCanvas ? 'bg-canvas-muted' : 'bg-ink-400'
          )}
        />
      </span>
      {label}
    </div>
  )
}
