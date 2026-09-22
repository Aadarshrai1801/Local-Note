/**
 * The only button in the app.
 *
 * Variant rules (part of the design contract):
 * - `primary` is a high-contrast neutral, never coloured.
 * - `live` is the only amber variant; it belongs to recording controls only.
 * - `signal` marks AI-derived actions (summarise, ask, regenerate).
 * - `danger` is destructive and always asks for confirmation at the call site.
 */
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cx } from '@/lib/format'
import { Spinner } from '@/components/Icon'

export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'ghost'
  | 'danger'
  | 'live'
  | 'signal'
  | 'link'

export type ButtonSize = 'sm' | 'md' | 'lg'

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'border border-transparent bg-ink-100 text-ink-950 hover:bg-white active:bg-ink-200 disabled:hover:bg-ink-100',
  secondary:
    'border border-ink-800 bg-ink-900 text-ink-100 hover:border-ink-700 hover:bg-ink-800/70 active:bg-ink-800',
  ghost:
    'border border-transparent text-ink-300 hover:bg-ink-800/50 hover:text-ink-100 active:bg-ink-800',
  danger:
    'border border-red-500/35 bg-red-500/10 text-red-300 hover:bg-red-500/20 active:bg-red-500/25',
  live: 'border border-ember-500/45 bg-ember-500/12 text-ember-300 hover:bg-ember-500/20 active:bg-ember-500/25',
  signal:
    'border border-signal-500/35 bg-signal-500/10 text-signal-300 hover:bg-signal-500/20 active:bg-signal-500/25',
  link: 'border border-transparent text-signal-300 hover:text-signal-200 hover:underline px-0'
}

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-7 gap-1.5 px-2.5 text-[12px]',
  md: 'h-9 gap-2 px-3.5 text-[13px]',
  lg: 'h-11 gap-2.5 px-5 text-sm'
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  /** Shows a spinner and blocks interaction (the label stays visible). */
  loading?: boolean
  icon?: ReactNode
  iconRight?: ReactNode
  block?: boolean
}

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  icon,
  iconRight,
  block = false,
  className,
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps): ReactNode {
  const isLink = variant === 'link'
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(
        'inline-flex select-none items-center justify-center rounded-md font-medium tracking-[-0.01em]',
        'transition-colors duration-100',
        'disabled:cursor-not-allowed disabled:opacity-45',
        !isLink && SIZES[size],
        VARIANTS[variant],
        block && 'w-full',
        className
      )}
      {...rest}
    >
      {loading ? (
        <Spinner size={14} className="shrink-0" />
      ) : (
        icon && <span className="shrink-0 [&>svg]:block">{icon}</span>
      )}
      {children != null && <span className="truncate">{children}</span>}
      {iconRight && !loading && <span className="shrink-0 [&>svg]:block">{iconRight}</span>}
    </button>
  )
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string
  variant?: ButtonVariant
  size?: ButtonSize
  children: ReactNode
}

/** Square, label-carrying button for toolbars and row actions. */
export function IconButton({
  label,
  variant = 'ghost',
  size = 'md',
  className,
  children,
  type = 'button',
  ...rest
}: IconButtonProps): ReactNode {
  const dimension = size === 'sm' ? 'h-7 w-7' : size === 'lg' ? 'h-11 w-11' : 'h-9 w-9'
  return (
    <button
      type={type}
      title={label}
      aria-label={label}
      className={cx(
        'inline-flex items-center justify-center rounded-md transition-colors duration-100',
        'disabled:cursor-not-allowed disabled:opacity-45',
        dimension,
        VARIANTS[variant],
        className
      )}
      {...rest}
    >
      {children}
    </button>
  )
}
