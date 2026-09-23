/**
 * A live input meter for one capture stream.
 *
 * The meter exists to make capture failures loud: a muted microphone or a
 * misconfigured device shows as a red "no audio" strip rather than silence.
 */
import type { ReactNode } from 'react'
import type { StreamKind, StreamLevel } from '@shared/types'
import { cx } from '@/lib/format'
import { Icon } from '@/components/Icon'

export interface LevelMeterProps {
  stream: StreamKind
  level: StreamLevel | null
  /** Tight layout for the header strip. */
  compact?: boolean
  className?: string
}

const LABELS: Record<StreamKind, string> = {
  system: 'System',
  mic: 'Microphone'
}

export function LevelMeter({
  stream,
  level,
  compact = false,
  className
}: LevelMeterProps): ReactNode {
  const dead = level?.dead ?? false
  const missing = level == null
  const rms = level ? Math.min(1, Math.max(0, level.rms)) : 0
  // Small floor so a quiet-but-alive signal is still visible.
  const width = dead || missing ? 0 : Math.max(3, Math.round(rms * 100))

  return (
    <div className={cx('min-w-0', className)}>
      <div className={cx('flex items-center gap-2', compact ? '' : 'mb-1.5')}>
        <Icon
          name={stream === 'mic' ? 'mic' : 'monitor'}
          size={compact ? 12 : 13}
          className={cx('shrink-0', dead ? 'text-danger-400' : 'text-ink-500')}
        />
        <span
          className={cx(
            'font-mono uppercase tracking-[0.12em]',
            compact ? 'text-[10px]' : 'text-[11px]',
            dead ? 'text-danger-400' : 'text-ink-400'
          )}
        >
          {LABELS[stream]}
        </span>
        {dead ? (
          <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-danger-400">
            no audio
          </span>
        ) : missing ? (
          <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-600">
            not captured
          </span>
        ) : null}
      </div>

      <div
        role="meter"
        aria-label={`${LABELS[stream]} input level`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(rms * 100)}
        aria-valuetext={dead ? 'no audio' : `${Math.round(rms * 100)} percent`}
        className={cx(
          'relative overflow-hidden rounded-full',
          compact ? 'h-1' : 'h-1.5',
          dead ? 'bg-danger-500/25' : 'bg-ink-800'
        )}
      >
        {!dead && (
          <div
            className={cx(
              'h-full rounded-full transition-[width] duration-150 ease-spring',
              stream === 'mic' ? 'bg-ember-400' : 'bg-ember-300/80'
            )}
            style={{ width: `${width}%` }}
          />
        )}
        {dead && <div className="h-full w-full bg-danger-500/40" />}
      </div>

      {!compact && level?.deviceName && (
        <p
          className={cx(
            'mt-1.5 truncate font-mono text-[11px]',
            dead ? 'text-danger-400/80' : 'text-ink-600'
          )}
          title={level.deviceName}
        >
          {level.deviceName}
        </p>
      )}
    </div>
  )
}
