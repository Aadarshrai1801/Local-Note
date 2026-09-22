/**
 * Every glyph in the app, hand-drawn on a 24×24 grid with a single 1.5px
 * stroke. No icon dependency: the set is small and the shapes are simple
 * geometry, which suits the editorial look better than a generic icon font.
 */
import type { ReactNode } from 'react'
import { cx } from '@/lib/format'

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round'
} as const

const ICONS = {
  /* navigation */
  home: <path d="M4 10.6 12 4l8 6.6V20a1 1 0 0 1-1 1h-4.4v-6h-5.2v6H5a1 1 0 0 1-1-1z" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6.25" />
      <path d="M15.9 15.9 20.5 20.5" />
    </>
  ),
  book: (
    <>
      <path d="M12 6.6C10.5 5.1 8.6 4.5 6 4.5v13.1c2.6 0 4.5.6 6 2.1 1.5-1.5 3.4-2.1 6-2.1V4.5c-2.6 0-4.5.6-6 2.1z" />
      <path d="M12 6.6v13.1" />
    </>
  ),
  sliders: (
    <>
      <path d="M4 8h3.4" />
      <path d="M11.4 8H20" />
      <circle cx="9" cy="8" r="2.2" />
      <path d="M4 16h7.4" />
      <path d="M15.4 16H20" />
      <circle cx="13" cy="16" r="2.2" />
    </>
  ),

  /* capture */
  mic: (
    <>
      <rect x="9" y="3.4" width="6" height="10.2" rx="3" />
      <path d="M5.6 11.6a6.4 6.4 0 0 0 12.8 0" />
      <path d="M12 18v3" />
      <path d="M9 21h6" />
    </>
  ),
  monitor: (
    <>
      <rect x="3" y="4.6" width="18" height="12.4" rx="1.5" />
      <path d="M12 17v3.4" />
      <path d="M9 20.4h6" />
    </>
  ),
  waveform: <path d="M3 12h1.8l2-5.4 3 12.4 3-15 2.6 8.6 1.6-3.2H21" />,
  stop: <rect x="6.5" y="6.5" width="11" height="11" rx="2" />,
  play: <path d="M8.6 5.6 18.4 12l-9.8 6.4z" />,
  target: (
    <>
      <circle cx="12" cy="12" r="8.4" />
      <circle cx="12" cy="12" r="2.9" />
    </>
  ),

  /* AI-derived content */
  sparkle: (
    <>
      <path d="M11.4 3.6l1.6 4.4 4.4 1.6-4.4 1.6-1.6 4.4-1.6-4.4L5.4 9.6l4.4-1.6z" />
      <path d="M18.4 15.2l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7z" />
    </>
  ),
  list: (
    <>
      <path d="M4 6.5h16" />
      <path d="M4 12h16" />
      <path d="M4 17.5h8.5" />
      <path d="M16.6 16.4l1.7 1.9 3.1-3.5" />
    </>
  ),
  message: (
    <>
      <path d="M4 6.6A1.6 1.6 0 0 1 5.6 5h12.8A1.6 1.6 0 0 1 20 6.6v7.6a1.6 1.6 0 0 1-1.6 1.6H9.4L4 19.6z" />
      <path d="M8.5 10.4h7" />
      <path d="M8.5 13h4" />
    </>
  ),

  /* metadata */
  clock: (
    <>
      <circle cx="12" cy="12" r="8.4" />
      <path d="M12 7.2V12l3.4 2.1" />
    </>
  ),
  calendar: (
    <>
      <rect x="3.5" y="5" width="17" height="15.4" rx="2" />
      <path d="M3.5 10h17" />
      <path d="M8 3.4v3.2" />
      <path d="M16 3.4v3.2" />
    </>
  ),
  users: (
    <>
      <circle cx="9.5" cy="8.6" r="3.2" />
      <path d="M3.9 19.6c.6-3.1 2.9-4.8 5.6-4.8s5 1.7 5.6 4.8" />
      <path d="M16.2 6.3a3.1 3.1 0 0 1 0 5.6" />
      <path d="M17.4 15.5c1.9.6 3.2 2 3.7 4.1" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8.6" r="3.4" />
      <path d="M5.6 19.6c.7-3.3 3.3-5 6.4-5s5.7 1.7 6.4 5" />
    </>
  ),
  file: (
    <>
      <path d="M6.5 3.5h7L19 9.2v10.3a1 1 0 0 1-1 1H6.5a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1z" />
      <path d="M13.5 3.5v5.7H19" />
      <path d="M9 13h6" />
      <path d="M9 16.5h3.5" />
    </>
  ),

  /* actions */
  paperclip: (
    <path d="M8.7 12.7l6.3-6.3a3.1 3.1 0 0 1 4.4 4.4l-7.7 7.7a4.6 4.6 0 0 1-6.5-6.5l6.9-6.9" />
  ),
  upload: (
    <>
      <path d="M12 16.4V4.5" />
      <path d="M7.6 9 12 4.5 16.4 9" />
      <path d="M4.5 15.5v3a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5v-3" />
    </>
  ),
  download: (
    <>
      <path d="M12 4.5v11.9" />
      <path d="M7.6 12 12 16.4 16.4 12" />
      <path d="M4.5 15.5v3a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5v-3" />
    </>
  ),
  trash: (
    <>
      <path d="M4.5 6.5h15" />
      <path d="M9.6 6.5V4.2h4.8v2.3" />
      <path d="M6.8 6.5l.9 13.3h8.6l.9-13.3" />
      <path d="M10.2 10.5v6" />
      <path d="M13.8 10.5v6" />
    </>
  ),
  plus: (
    <>
      <path d="M12 5.2v13.6" />
      <path d="M5.2 12h13.6" />
    </>
  ),
  check: <path d="M5 12.6 9.6 17 19 7.2" />,
  x: (
    <>
      <path d="M6.2 6.2 17.8 17.8" />
      <path d="M17.8 6.2 6.2 17.8" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="11.4" height="11.4" rx="1.5" />
      <path d="M15.4 9V4.6H3.6V16h4.4" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 12a8 8 0 1 1-2.7-6" />
      <path d="M20 4.6V10h-5.4" />
    </>
  ),
  pencil: (
    <>
      <path d="M4.6 19.4h3.8L19 8.8l-3.8-3.8L4.6 15.6z" />
      <path d="M13.8 6.6 17.5 10.3" />
    </>
  ),
  more: (
    <>
      <circle cx="6" cy="12" r="1.35" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.35" fill="currentColor" stroke="none" />
      <circle cx="18" cy="12" r="1.35" fill="currentColor" stroke="none" />
    </>
  ),

  /* directions */
  chevronDown: <path d="M6.6 9.6 12 15l5.4-5.4" />,
  chevronUp: <path d="M6.6 14.4 12 9l5.4 5.4" />,
  chevronRight: <path d="M9.6 5.6 16 12l-6.4 6.4" />,
  chevronLeft: <path d="M14.4 5.6 8 12l6.4 6.4" />,
  arrowDown: (
    <>
      <path d="M12 4.5v15" />
      <path d="M6.6 14 12 19.4 17.4 14" />
    </>
  ),
  arrowUp: (
    <>
      <path d="M12 19.5v-15" />
      <path d="M6.6 10 12 4.6 17.4 10" />
    </>
  ),
  arrowLeft: (
    <>
      <path d="M19.4 12h-15" />
      <path d="M9.8 5.6 4.4 12l5.4 6.4" />
    </>
  ),
  arrowUpRight: (
    <>
      <path d="M7 17 17 7" />
      <path d="M8.6 7H17v8.4" />
    </>
  ),

  /* status */
  alert: (
    <>
      <path d="M12 4.4 21 19.6H3z" />
      <path d="M12 10v4.4" />
      <circle cx="12" cy="17" r="0.9" fill="currentColor" stroke="none" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8.4" />
      <path d="M12 11v5.6" />
      <circle cx="12" cy="8.2" r="0.9" fill="currentColor" stroke="none" />
    </>
  ),
  checkCircle: (
    <>
      <circle cx="12" cy="12" r="8.4" />
      <path d="M8.4 12.3l2.5 2.5 4.7-5.4" />
    </>
  ),
  lock: (
    <>
      <rect x="4.6" y="10.4" width="14.8" height="9.6" rx="1.5" />
      <path d="M8.2 10.4V8a3.8 3.8 0 0 1 7.6 0v2.4" />
    </>
  ),
  shield: <path d="M12 3.6 19.4 6.2v5.6c0 4.3-3 7.5-7.4 8.6-4.4-1.1-7.4-4.3-7.4-8.6V6.2z" />,

  /* technical */
  terminal: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="1.5" />
      <path d="M7.6 10 10 12.5 7.6 15" />
      <path d="M12.6 15h3.8" />
    </>
  ),
  cpu: (
    <>
      <rect x="7" y="7" width="10" height="10" rx="1.5" />
      <rect x="10.3" y="10.3" width="3.4" height="3.4" rx="0.6" />
      <path d="M10 3.6V7" />
      <path d="M14 3.6V7" />
      <path d="M10 17v3.4" />
      <path d="M14 17v3.4" />
      <path d="M3.6 10H7" />
      <path d="M3.6 14H7" />
      <path d="M17 10h3.4" />
      <path d="M17 14h3.4" />
    </>
  ),
  database: (
    <>
      <ellipse cx="12" cy="6" rx="7.4" ry="2.8" />
      <path d="M4.6 6v12c0 1.55 3.31 2.8 7.4 2.8s7.4-1.25 7.4-2.8V6" />
      <path d="M4.6 12c0 1.55 3.31 2.8 7.4 2.8s7.4-1.25 7.4-2.8" />
    </>
  ),
  folder: (
    <path d="M3.6 6.6A1.6 1.6 0 0 1 5.2 5h4.1l2 2.6h7.5a1.6 1.6 0 0 1 1.6 1.6v8.2a1.6 1.6 0 0 1-1.6 1.6H5.2a1.6 1.6 0 0 1-1.6-1.6z" />
  ),
  external: (
    <>
      <path d="M14 4.5h5.5V10" />
      <path d="M19.5 4.5 12.6 11.4" />
      <path d="M18 14.4v4.1a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6h4.1" />
    </>
  ),
  filter: (
    <>
      <path d="M4 6.6h16" />
      <path d="M7 12h10" />
      <path d="M10 17.4h4" />
    </>
  )
} satisfies Record<string, ReactNode>

export type IconName = keyof typeof ICONS

export interface IconProps {
  name: IconName
  /** Rendered size in px; the grid is always 24×24. */
  size?: number
  className?: string
  /** Decorative by default; pass a label to expose it to assistive tech. */
  label?: string
}

export function Icon({ name, size = 16, className, label }: IconProps): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
      {...stroke}
    >
      {ICONS[name]}
    </svg>
  )
}

/** The wordmark: a waveform that resolves into set text lines. */
export function LogoMark({
  size = 22,
  className
}: {
  size?: number
  className?: string
}): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <g stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
        <path d="M2.6 9.6v4.8" />
        <path d="M6.1 6.2v11.6" />
        <path d="M9.6 8.4v7.2" />
        <path d="M14.2 6.6h7.2" />
        <path d="M14.2 12h4.4" />
        <path d="M14.2 17.4h7.2" />
      </g>
    </svg>
  )
}

/** Indeterminate ring, sized to sit next to 13–14px text. */
export function Spinner({ size = 14, className }: { size?: number; className?: string }): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={cx('animate-spin', className)}
      aria-hidden="true"
      focusable="false"
      fill="none"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.4" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
    </svg>
  )
}
