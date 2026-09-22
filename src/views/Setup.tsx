/**
 * First-run setup.
 *
 * This screen is deliberately honest about the one-time cost: the app can be
 * explored without any of it, but transcription genuinely needs a local model
 * downloaded once. Every step shows the exact command and can be skipped.
 */
import { useState, type ReactNode } from 'react'
import type { SetupCheck } from '@shared/types'
import { api } from '@/lib/api'
import { cx, copyText } from '@/lib/format'
import { useAsyncData } from '@/lib/hooks'
import { attempt, dismissSetup, go, pushToast, useStatus } from '@/lib/store'
import { Button } from '@/components/Button'
import { ErrorState, LoadingBlock } from '@/components/EmptyState'
import { Icon } from '@/components/Icon'

interface Step {
  id: string
  title: string
  detail: ReactNode
  commands: Array<{ label: string; command: string; note?: string }>
  optional?: boolean
}

const STEPS: Step[] = [
  {
    id: 'native',
    title: 'Build the audio capture helper',
    detail: (
      <>
        Windows has no supported way to record “what is playing through the speakers” from Node, so
        Local Note ships a small C# helper that talks to the Core Audio APIs directly. It compiles
        with the <code className="font-mono text-ink-300">csc.exe</code> that already exists on
        Windows — nothing to install.
      </>
    ),
    commands: [
      { label: 'Build it', command: 'npm run build:native' },
      {
        label: 'Or compile by hand',
        command:
          'csc.exe /nologo /platform:x64 /target:exe /out:build\\WasapiRecorder.exe native\\WasapiRecorder.cs'
      }
    ]
  },
  {
    id: 'python',
    title: 'Install the transcription engine',
    detail: (
      <>
        Speech recognition runs through{' '}
        <code className="font-mono text-ink-300">faster-whisper</code>, a Python package that runs
        Whisper models on your CPU. Python 3.10 or newer is required. This is the step that makes
        transcription possible at all.
      </>
    ),
    commands: [
      { label: 'Install the package', command: 'python -m pip install --upgrade faster-whisper' },
      { label: 'Verify it imports', command: 'python -c "import faster_whisper; print(faster_whisper.__version__)"' }
    ]
  },
  {
    id: 'whisper-model',
    title: 'Download one Whisper model',
    detail: (
      <>
        Models are downloaded once from Hugging Face and then never touched again. “Base” is the
        default: about 150 MB and accurate enough for clear speech. Larger models are better with
        names and jargon, and slower.
      </>
    ),
    commands: [
      {
        label: 'Recommended first model',
        command: 'base.en',
        note: 'Press Download in Settings → Models; this is not a shell command.'
      }
    ]
  },
  {
    id: 'ollama',
    title: 'Add a local model for summaries (optional)',
    detail: (
      <>
        Summaries, action items and answers are written by a model running through Ollama. Without
        it, Local Note still transcribes everything and falls back to extractive notes. Nothing is
        sent to a cloud service either way.
      </>
    ),
    optional: true,
    commands: [
      { label: 'Install Ollama', command: 'winget install --id Ollama.Ollama -e' },
      { label: 'Pull a chat model', command: 'ollama pull llama3.1:8b' },
      { label: 'Pull an embedding model (semantic search)', command: 'ollama pull nomic-embed-text' }
    ]
  }
]

export function Setup(): ReactNode {
  const { status, loaded } = useStatus()
  const checks = useAsyncData(() => api.runSetupChecks(), [], {
    toastOnError: 'Could not run the setup checks'
  })
  const [rerunning, setRerunning] = useState(false)

  const rerun = async (): Promise<void> => {
    setRerunning(true)
    await attempt(() => api.refreshStatus(), { errorPrefix: 'Could not refresh status' })
    checks.refresh()
    setRerunning(false)
  }

  const checkList = checks.data ?? []
  const blocking = checkList.filter((check) => check.status === 'missing')
  const warnings = checkList.filter((check) => check.status === 'warn')

  return (
    <div className="mx-auto w-full max-w-4xl px-8 py-10 lg:px-12">
      <p className="eyebrow">One-time setup</p>
      <h1 className="mt-2 max-w-[30ch] text-[30px] font-medium leading-[1.15] tracking-[-0.03em] text-ink-50">
        Two local installs and one model download.
      </h1>
      <p className="mt-3 max-w-[68ch] text-[13.5px] leading-relaxed text-ink-400">
        Local Note records and transcribes on this machine, which means the pieces that do the work
        have to exist on this machine. None of it requires an account, and none of it sends your
        meetings anywhere.
      </p>

      {/* Status ----------------------------------------------------- */}
      <section className="mt-7 rounded-md border border-ink-800 bg-ink-900/50 px-3.5 py-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <span className="eyebrow text-ink-400">Current status</span>
          <StatusPill
            ok={status?.stt.available ?? false}
            label="transcription"
            detail={status?.stt.engine ?? 'not installed'}
          />
          <StatusPill
            ok={status?.llm.available ?? false}
            label="local model"
            detail={status?.llm.selectedModel ?? 'not running'}
          />
          <span className="font-mono text-[11px] text-ink-500">
            {status?.stt.modelsPresent.length
              ? `models: ${status.stt.modelsPresent.join(', ')}`
              : 'no models on disk'}
          </span>
          <Button
            size="sm"
            variant="secondary"
            className="ml-auto"
            loading={rerunning}
            icon={<Icon name="refresh" size={13} />}
            onClick={() => void rerun()}
          >
            Re-run checks
          </Button>
        </div>

        <div className="mt-3 border-t border-ink-800/70 pt-3">
          {checks.error ? (
            <ErrorState message={checks.error} onRetry={checks.refresh} compact />
          ) : checks.loading && checkList.length === 0 ? (
            <LoadingBlock label="Checking what is already installed…" />
          ) : (
            <ul className="grid gap-1.5 sm:grid-cols-2">
              {checkList.map((check) => (
                <CheckLine key={check.id} check={check} />
              ))}
            </ul>
          )}
        </div>

        {loaded && blocking.length === 0 && (
          <p className="mt-3 flex items-center gap-2 text-[12.5px] text-signal-300">
            <Icon name="checkCircle" size={14} />
            Everything needed for transcription is in place.
          </p>
        )}
        {blocking.length > 0 && (
          <p className="mt-3 flex items-start gap-2 text-[12.5px] leading-relaxed text-ink-300">
            <Icon name="alert" size={13} className="mt-0.5 shrink-0 text-ember-400" />
            <span>
              {blocking.length === 1
                ? 'One required item is missing'
                : `${blocking.length} required items are missing`}
              : {blocking.map((check) => check.label).join(', ')}. Transcription cannot start until
              that is done.
            </span>
          </p>
        )}
        {blocking.length === 0 && warnings.length > 0 && (
          <p className="mt-3 text-[12.5px] leading-relaxed text-ink-500">
            Optional, not blocking: {warnings.map((check) => check.label).join(', ')}.
          </p>
        )}
      </section>

      {/* Steps ------------------------------------------------------ */}
      <ol className="mt-8 space-y-6">
        {STEPS.map((step, index) => (
          <li key={step.id} className="rounded-md border border-ink-800">
            <header className="flex items-start gap-3 border-b border-ink-800/80 px-4 py-3">
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border border-ink-700 font-mono text-[11px] text-ink-400">
                {index + 1}
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="flex flex-wrap items-center gap-2 text-[14.5px] font-medium tracking-[-0.01em] text-ink-100">
                  {step.title}
                  {step.optional && <span className="chip">optional</span>}
                </h2>
              </div>
            </header>
            <div className="space-y-3 px-4 py-3.5">
              <p className="max-w-[74ch] text-[13px] leading-relaxed text-ink-400">{step.detail}</p>
              <div className="space-y-2">
                {step.commands.map((entry) => (
                  <CommandBlock key={entry.command} {...entry} />
                ))}
              </div>
              {step.id === 'whisper-model' && (
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<Icon name="cpu" size={13} />}
                  onClick={() => go('settings')}
                >
                  Open model list in Settings
                </Button>
              )}
              {step.id === 'ollama' && (
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Icon name="arrowUpRight" size={13} />}
                  onClick={() => go('settings')}
                >
                  Check Ollama status
                </Button>
              )}
            </div>
          </li>
        ))}
      </ol>

      {/* Escape hatch ---------------------------------------------- */}
      <section className="mt-8 rounded-md border border-ink-800 bg-ink-900/40 px-4 py-4">
        <h2 className="text-[14.5px] font-medium tracking-[-0.01em] text-ink-100">
          Not ready to install anything?
        </h2>
        <p className="mt-1.5 max-w-[72ch] text-[13px] leading-relaxed text-ink-400">
          You can look around first. The interface, search, dictionary and settings all work without
          any of the above — recordings simply will not be transcribed until the engine and one model
          are in place. Capture itself also needs the helper from step 1.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              dismissSetup()
              go('home')
            }}
          >
            Skip and explore the UI
          </Button>
          <span className="font-mono text-[11px] text-ink-500">
            you can return here from Settings → Diagnostics
          </span>
        </div>
      </section>

      <p className="mt-8 max-w-[74ch] border-t border-ink-800 pt-4 text-[12.5px] leading-relaxed text-ink-500">
        Everything runs locally: audio is captured through WASAPI, transcribed by Whisper on your
        CPU, and summarised by a model you already have. The only network requests in the whole app
        are the model downloads you start yourself.
      </p>
    </div>
  )
}

function StatusPill({
  ok,
  label,
  detail
}: {
  ok: boolean
  label: string
  detail: string
}): ReactNode {
  return (
    <span className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.08em]">
      <span
        aria-hidden="true"
        className={cx('h-1.5 w-1.5 rounded-full', ok ? 'bg-signal-400' : 'bg-ink-600')}
      />
      <span className="text-ink-500">{label}</span>
      <span className="normal-case tracking-normal text-ink-300">{detail}</span>
    </span>
  )
}

function CheckLine({ check }: { check: SetupCheck }): ReactNode {
  const tone =
    check.status === 'ok'
      ? { text: 'text-signal-300', dot: 'bg-signal-400' }
      : check.status === 'warn'
        ? { text: 'text-ember-300', dot: 'bg-ember-400' }
        : { text: 'text-red-300', dot: 'bg-red-400' }
  return (
    <li className="flex items-start gap-2 text-[12.5px] leading-relaxed">
      <span aria-hidden="true" className={cx('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full', tone.dot)} />
      <span className="min-w-0">
        <span className="text-ink-200">{check.label}</span>
        <span className={cx('ml-2 font-mono text-[10px] uppercase tracking-[0.1em]', tone.text)}>
          {check.status}
        </span>
        <span className="ml-2 text-ink-500">{check.detail}</span>
      </span>
    </li>
  )
}

function CommandBlock({
  label,
  command,
  note
}: {
  label: string
  command: string
  note?: string
}): ReactNode {
  const [copied, setCopied] = useState(false)

  return (
    <div className="rounded-md border border-ink-800 bg-ink-950">
      <div className="flex items-center gap-2 border-b border-ink-800/70 px-2.5 py-1">
        <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-500">
          {label}
        </span>
        <button
          type="button"
          onClick={async () => {
            const ok = await copyText(command)
            if (!ok) {
              pushToast('error', 'Could not copy to the clipboard.')
              return
            }
            setCopied(true)
            window.setTimeout(() => setCopied(false), 1500)
          }}
          className="ml-auto flex items-center gap-1.5 rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-500 transition-colors hover:bg-ink-800 hover:text-ink-200"
        >
          <Icon name={copied ? 'check' : 'copy'} size={11} />
          {copied ? 'copied' : 'copy'}
        </button>
      </div>
      <pre className="overflow-x-auto px-2.5 py-2 font-mono text-[12px] text-ink-200">
        <code>{command}</code>
      </pre>
      {note && (
        <p className="border-t border-ink-800/70 px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-500">
          {note}
        </p>
      )}
    </div>
  )
}
