/**
 * Snippets: reusable agenda and note templates.
 *
 * This feature does not exist yet, and the screen says so plainly. There is no
 * fake template data here — only a description of what the feature will do and
 * where the equivalent inputs live today (the Home agenda field and the brief
 * panel on a live meeting).
 */
import type { ReactNode } from 'react'
import { go } from '@/lib/store'
import { Button } from '@/components/Button'
import { EmptyState } from '@/components/EmptyState'
import { Icon, type IconName } from '@/components/Icon'

interface PlanItem {
  icon: IconName
  title: string
  detail: string
}

const PLAN: PlanItem[] = [
  {
    icon: 'layers',
    title: 'Save an agenda once',
    detail:
      'A recurring meeting has the same shape every week. A snippet would store that shape — agenda prompts, attendee names, the decisions you always need — and reuse it in one click.'
  },
  {
    icon: 'sparkle',
    title: 'Feed the summary',
    detail:
      'When a recording starts from a snippet, the text would arrive as the pre-meeting brief, so the local model has context before it summarises. Same pipeline as today, fewer retyped words.'
  },
  {
    icon: 'lock',
    title: 'Stored on this machine',
    detail:
      'Snippets would live in the same local data folder as everything else. No shared library, no account, no sync — the promise does not change for this feature.'
  }
]

export function Snippets(): ReactNode {
  return (
    <div className="mx-auto w-full max-w-4xl px-8 py-9 lg:px-12">
      <p className="eyebrow">Snippets</p>
      <h1 className="mt-2 max-w-[30ch] text-[26px] font-medium leading-[1.15] tracking-[-0.025em] text-ink-50">
        Reusable agendas and note templates
      </h1>
      <p className="mt-3 max-w-[70ch] text-[13.5px] leading-relaxed text-ink-400">
        A snippet is a saved starting point for a meeting: the agenda you reuse, the questions you
        always ask, the names that keep coming back. Nothing here is wired up yet.
      </p>

      <div className="mt-8">
        <EmptyState
          eyebrow="Not built yet"
          title="Templates are still on the roadmap"
          description={
            <>
              There is no snippet library in this build, so this screen intentionally shows no
              entries. In the meantime, the same context can be typed into the{' '}
              <span className="text-ink-200">agenda</span> field on Home before you start, or into
              the brief panel while a meeting is recording — the summary already uses it.
            </>
          }
          action={
            <>
              <Button
                variant="primary"
                size="sm"
                icon={<Icon name="play" size={13} />}
                onClick={() => go('home')}
              >
                Start a recording
              </Button>
              <Button
                variant="ghost"
                size="sm"
                icon={<Icon name="arrowUpRight" size={13} />}
                onClick={() => go('settings')}
              >
                Open Settings
              </Button>
            </>
          }
        />
      </div>

      <section aria-labelledby="snippets-plan" className="mt-8">
        <div className="flex items-baseline gap-3 pb-2">
          <h2 id="snippets-plan" className="eyebrow text-ink-400">
            What this will do
          </h2>
          <span aria-hidden="true" className="h-px flex-1 bg-ink-800/70" />
        </div>
        <ul className="grid gap-3 sm:grid-cols-3">
          {PLAN.map((item) => (
            <li key={item.title} className="rounded-panel border border-ink-800 bg-ink-900/50 p-4">
              <Icon name={item.icon} size={16} className="text-ink-500" />
              <h3 className="mt-3 text-[13.5px] font-medium tracking-[-0.01em] text-ink-100">
                {item.title}
              </h3>
              <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-400">{item.detail}</p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
