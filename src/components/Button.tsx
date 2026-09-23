/**
 * The only button in the app.
 *
 * Variant rules (part of the design contract):
 * - `primary` is a high-contrast neutral pill. This is the default CTA shape.
 * - `accent` is the single amber accent. It belongs to recording controls
 *   (start/stop) and nothing else — if two things on screen are amber, one is
 *   wrong. `live` is kept as an alias for existing recording controls.
 * - `signal` marks AI-derived actions (summarise, ask, regenerate) with the
 *   recessive grey-blue treatment.
 * - `danger` is destructive and always confirms inline at the call site.
 *
 * Every variant is a pill and every call site stays a real <button>, so the
 * global :focus-visible ring and keyboard activation come for free.
 */
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cx } from '@/lib/format'
import { Spinner } from '@/components/Icon'

export type ButtonVariant =
  | 'primary'
  | 'accent'
  | 'secondary'
  | 'ghost'
  | 'danger'
  | 'live'
  | 'signal'
  | 'link'

export type ButtonSize = 'sm' | 'md' | 'lg'

/** Shared with IconButton; component-layer primitives from index.css. */
const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-ink-100 text-ink-950 hover:bg-white active:scale-[0.98]',
  accent: 'btn-primary',
  secondary: 'btn-quiet',
  ghost: 'btn-ghost',
  danger: 'btn-danger',
  live: 'btn-primary',
  signal: 'bg-signal-500/15 text-signal-300 hover:bg-signal-500/25 active:scale-[0.98]',
  link: 'px-0 text-signal-300 hover:text-signal-200 hover:underline'
}

/**
 * Icon-only buttons carry the same tones but no text padding, so the square
 * dimensions below are never fighting `px-4` from the pill primitives.
 */
const ICON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-ink-100 text-ink-950 hover:bg-white active:scale-[0.94]',
  accent: 'bg-ember-400 text-ink-950 hover:bg-ember-300 active:scale-[0.94]',
  secondary: 'bg-ink-800/70 text-ink-100 hover:bg-ink-700 active:scale-[0.94]',
  ghost: 'text-ink-300 hover:bg-ink-800/60 hover:text-ink-100 active:scale-[0.94]',
  danger: 'bg-danger-500/15 text-danger-400 hover:bg-danger-500/25 active:scale-[0.94]',
  live: 'bg-ember-400 text-ink-950 hover:bg-ember-300 active:scale-[0.94]',
  signal: 'bg-signal-500/15 text-signal-300 hover:bg-signal-500/25 active:scale-[0.94]',
  link: 'text-signal-300 hover:text-signal-200'
}

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-7 gap-1.5 px-2.5 text-[12px]',
  md: 'h-9 gap-2 px-3.5 text-[13px]',
  lg: 'h-11 gap-2.5 px-5 text-[13.5px]'
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
        'inline-flex select-none items-center justify-center font-medium tracking-[-0.01em]',
        !isLink && 'btn',
        VARIANTS[variant],
        !isLink && SIZES[size],
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

/** Round, label-carrying button for toolbars and row actions. */
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
        'inline-flex shrink-0 items-center justify-center rounded-full transition-all duration-150 ease-spring',
        'disabled:cursor-not-allowed disabled:opacity-45',
        dimension,
        ICON_VARIANTS[variant],
        className
      )}
      {...rest}
    >
      {children}
    </button>
  )
}
