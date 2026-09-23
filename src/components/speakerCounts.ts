/**
 * Speaker counts for the Home cards.
 *
 * `Meeting` carries no speaker count and `getSpeakerNames()` is only a table of
 * custom names, so the only honest source is the transcript itself. Loading
 * every transcript for every card would be wasteful, so counts are fetched for
 * the first dozen meetings that have segments, cached per meeting id, and
 * omitted entirely when unknown. Nothing is estimated.
 */
import { useEffect, useState } from 'react'
import type { Meeting } from '@shared/types'
import { api } from '@/lib/api'

/** Upper bound on transcript loads per Home render pass. */
export const MAX_SPEAKER_LOOKUPS = 12

const cache = new Map<string, number>()

function snapshot(): Record<string, number> {
  return Object.fromEntries(cache)
}

export function useSpeakerCounts(meetings: Meeting[]): Record<string, number> {
  const [counts, setCounts] = useState<Record<string, number>>(snapshot)

  useEffect(() => {
    const targets = meetings
      .filter((meeting) => meeting.segmentCount > 0 && !cache.has(meeting.id))
      .slice(0, MAX_SPEAKER_LOOKUPS)
    if (targets.length === 0) return

    let cancelled = false
    void Promise.all(
      targets.map(async (meeting) => {
        try {
          const detail = await api.getMeeting(meeting.id)
          if (!detail) return
          const labels = new Set<string>()
          for (const segment of detail.segments) {
            if (segment.speakerLabel) labels.add(segment.speakerLabel)
          }
          if (labels.size > 0) cache.set(meeting.id, labels.size)
        } catch {
          // Leave it unknown; the card simply omits the chip.
        }
      })
    ).then(() => {
      if (!cancelled) setCounts(snapshot())
    })

    return () => {
      cancelled = true
    }
  }, [meetings])

  return counts
}
