/**
 * Settings: models, AI, audio, data, diagnostics.
 *
 * Two rules shape this screen. First, anything that leaves the machine (a model
 * download) says so explicitly before you press the button. Second, every path
 * where data lives is shown verbatim — the "all data is local" promise is only
 * credible if you can read the paths.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { AppPaths, AppSettings, DictionaryTerm, SetupCheck } from '@shared/types'
import type { WhisperModelInfo } from '@shared/api'
import { api } from '@/lib/api'
import {
  cx,
  copyText,
  formatBytes,
  plural,
  truncate
} from '@/lib/format'
import { useAsyncData } from '@/lib/hooks'
import {
  attempt,
  pushToast,
  saveSettings,
  useBackendBusy,
  usePaths,
  useSettings,
  useStatus
} from '@/lib/store'
import { Button, IconButton } from '@/components/Button'
import { ErrorState, LoadingBlock, Skeleton } from '@/components/EmptyState'
import { Icon } from '@/components/Icon'

type SectionId = 'models' | 'ai' | 'audio' | 'capturebar' | 'data' | 'diagnostics'

const SECTIONS: Array<{
  id: SectionId
  label: string
  icon: 'cpu' | 'sparkle' | 'sliders' | 'target' | 'database' | 'terminal'
}> = [
  { id: 'models', label: 'Models', icon: 'cpu' },
  { id: 'ai', label: 'AI', icon: 'sparkle' },
  { id: 'audio', label: 'Audio', icon: 'sliders' },
  { id: 'capturebar', label: 'Capture bar', icon: 'target' },
  { id: 'data', label: 'Data', icon: 'database' },
  { id: 'diagnostics', label: 'Diagnostics', icon: 'terminal' }
]

export function Settings(): ReactNode {
  const [section, setSection] = useState<SectionId>('models')
  const settings = useSettings()

  return (
    <div className="mx-auto w-full max-w-5xl px-8 py-9 lg:px-12">
      <p className="eyebrow">Settings</p>
      <h1 className="mt-2 text-[24px] font-medium tracking-[-0.025em] text-ink-50">
        Local Note configuration
      </h1>
      <p className="mt-3 flex items-start gap-2 text-[13.5px] leading-relaxed text-ink-400">
        <Icon name="shield" size={15} className="mt-0.5 shrink-0 text-signal-400" />
        <span className="max-w-[68ch]">
          <span className="text-ink-100">All processing is local.</span> No account, no telemetry,
          no cloud. The two things that ever touch the network are the one-time model downloads you
          start yourself.
        </span>
      </p>

      <nav aria-label="Settings sections" className="mt-7 flex flex-wrap gap-1.5">
        {SECTIONS.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-current={section === item.id ? 'true' : undefined}
            onClick={() => setSection(item.id)}
            className={cx(
              'flex items-center gap-2 rounded-full px-3 py-1.5 text-[13px] transition-colors duration-150 ease-spring',
              section === item.id
                ? 'bg-ink-800 text-ink-100'
                : 'text-ink-400 hover:bg-ink-900 hover:text-ink-200'
            )}
          >
            <Icon name={item.icon} size={14} />
            {item.label}
          </button>
        ))}
      </nav>

      <div className="mt-7">
        {settings == null ? (
          <div className="space-y-3" aria-busy="true">
            <Skeleton width="14rem" />
            <Skeleton width="100%" className="h-20" />
          </div>
        ) : section === 'models' ? (
          <ModelsSection settings={settings} />
        ) : section === 'ai' ? (
          <AiSection settings={settings} />
        ) : section === 'audio' ? (
          <AudioSection settings={settings} />
        ) : section === 'capturebar' ? (
          <CaptureBarSection settings={settings} />
        ) : section === 'data' ? (
          <DataSection />
        ) : (
          <DiagnosticsSection />
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Shared bits                                                         */
/* ------------------------------------------------------------------ */

function SectionHeader({
  title,
  description
}: {
  title: string
  description: ReactNode
}): ReactNode {
  return (
    <header className="mb-5">
      <h2 className="text-[15px] font-medium tracking-[-0.015em] text-ink-100">{title}</h2>
      <p className="mt-1.5 max-w-[72ch] text-[13.5px] leading-relaxed text-ink-400">{description}</p>
    </header>
  )
}

function Field({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: ReactNode
}): ReactNode {
  return (
    <div className="py-3.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <span className="text-[13.5px] text-ink-200">{label}</span>
        {hint && <span className="font-mono text-[11px] text-ink-500">{hint}</span>}
      </div>
      <div className="mt-2">{children}</div>
    </div>
  )
}

function Toggle({
  checked,
  onChange,
  disabled,
  label
}: {
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
  label: string
}): ReactNode {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-[13px] text-ink-300">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        aria-label={label}
        className="h-3.5 w-3.5 accent-signal-500"
      />
      <span>{label}</span>
    </label>
  )
}

function PathRow({ label, value }: { label: string; value: string }): ReactNode {
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex items-center gap-3 py-2">
      <span className="w-28 shrink-0 font-mono text-[10px] uppercase tracking-[0.1em] text-ink-500">
        {label}
      </span>
      <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink-200" title={value}>
        {value}
      </code>
      <IconButton
        label={`Copy ${label} path`}
        size="sm"
        onClick={async () => {
          const ok = await copyText(value)
          if (ok) {
            setCopied(true)
            window.setTimeout(() => setCopied(false), 1500)
          } else {
            pushToast('error', 'Could not copy the path.')
          }
        }}
      >
        <Icon name={copied ? 'check' : 'copy'} size={12} />
      </IconButton>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Models                                                             */
/* ------------------------------------------------------------------ */

function ModelsSection({ settings }: { settings: AppSettings }): ReactNode {
  const models = useAsyncData(() => api.listWhisperModels(), [], {
    toastOnError: 'Could not list the local models'
  })
  const backendBusy = useBackendBusy()
  const [downloading, setDownloading] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)

  const list = models.data ?? []

  const setActive = async (id: string): Promise<void> => {
    await saveSettings({ whisperModel: id })
  }

  const download = async (model: WhisperModelInfo): Promise<void> => {
    setDownloading(model.id)
    const result = await attempt(() => api.downloadWhisperModel(model.id), {
      errorPrefix: `Could not download ${model.label}`
    })
    setDownloading(null)
    if (result) {
      pushToast(result.ok ? 'info' : 'warn', result.message)
      models.refresh()
    }
  }

  const remove = async (model: WhisperModelInfo): Promise<void> => {
    setDeleting(model.id)
    const ok = await attempt(async () => {
      await api.deleteWhisperModel(model.id)
      return true
    }, { errorPrefix: `Could not delete ${model.label}` })
    setDeleting(null)
    if (ok) {
      pushToast('info', `${model.label} deleted from disk.`)
      models.refresh()
    }
  }

  return (
    <div>
      <SectionHeader
        title="Transcription models"
        description="Whisper runs entirely on this CPU. Bigger models are more accurate and slower; they are downloaded once, from the internet, when you ask for them."
      />

      <div className="mb-4 flex items-start gap-2 rounded-md border border-ink-800 bg-ink-900/50 px-3.5 py-3">
        <Icon name="info" size={14} className="mt-0.5 shrink-0 text-ink-500" />
        <p className="text-[12.5px] leading-relaxed text-ink-300">
          Downloading a model is the only time this app uses the network, and it only happens when
          you press the button. Whisper models come from Hugging Face; Ollama models from the Ollama
          registry. Nothing about you, your meetings, or your machine is sent with the request.
        </p>
      </div>

      {backendBusy && downloading && (
        <div className="mb-4 rounded-md border border-signal-500/25 bg-signal-500/[0.05] px-3.5 py-3">
          <p className="flex items-center gap-2 text-[13px] text-signal-200">
            <Icon name="download" size={13} />
            {backendBusy.label}
          </p>
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-ink-800">
            <div
              className="h-full rounded-full bg-signal-500 transition-[width] duration-300"
              style={{
                width: `${Math.round((backendBusy.progress ?? 0.1) * 100)}%`
              }}
            />
          </div>
          <p className="mt-1.5 font-mono text-[11px] text-ink-500">
            large models can take several minutes on a slow connection
          </p>
        </div>
      )}

      {models.error ? (
        <ErrorState message={models.error} onRetry={models.refresh} />
      ) : models.loading && list.length === 0 ? (
        <LoadingBlock label="Checking which models are on disk…" />
      ) : (
        <ul className="divide-y divide-ink-800/70 overflow-hidden rounded-md border border-ink-800">
          {list.map((model) => {
            const active = settings.whisperModel === model.id
            return (
              <li
                key={model.id}
                className={cx('flex items-start gap-4 px-3.5 py-3', active && 'bg-signal-500/[0.04]')}
              >
                <span className="mt-0.5 shrink-0">
                  <span
                    aria-hidden="true"
                    className={cx(
                      'block h-2 w-2 rounded-full',
                      active ? 'bg-signal-400' : model.downloaded ? 'bg-ink-500' : 'bg-ink-700'
                    )}
                  />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                    <span className="text-[13.5px] font-medium text-ink-100">{model.label}</span>
                    <span className="font-mono text-[11px] text-ink-500">{model.id}</span>
                    {model.englishOnly && <span className="chip">english only</span>}
                    {model.downloaded ? (
                      <span className="chip chip-signal">on disk</span>
                    ) : (
                      <span className="chip">not downloaded</span>
                    )}
                    {active && <span className="chip chip-signal">in use</span>}
                  </p>
                  <p className="mt-1 max-w-[68ch] text-[12.5px] leading-relaxed text-ink-400">
                    {model.note}
                  </p>
                  <p className="mt-1.5 font-mono text-[11px] text-ink-500">
                    download ≈ {formatBytes(model.sizeBytes)} · needs ≈ {model.ramGb} GB RAM
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                  {!active && (
                    <Button
                      size="sm"
                      variant={model.downloaded ? 'primary' : 'secondary'}
                      disabled={!model.downloaded}
                      title={
                        model.downloaded
                          ? 'Use this model for new recordings'
                          : 'Download it first'
                      }
                      onClick={() => void setActive(model.id)}
                    >
                      Use
                    </Button>
                  )}
                  {model.downloaded ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={deleting === model.id}
                      onClick={() => void remove(model)}
                      title={active ? 'Download another model first' : 'Free up disk space'}
                      disabled={active}
                    >
                      Delete
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={downloading === model.id}
                      disabled={downloading != null && downloading !== model.id}
                      icon={<Icon name="download" size={13} />}
                      onClick={() => void download(model)}
                    >
                      Download
                    </Button>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* AI                                                                 */
/* ------------------------------------------------------------------ */

function AiSection({ settings }: { settings: AppSettings }): ReactNode {
  const { status, loaded } = useStatus()
  const [host, setHost] = useState(settings.ollamaHost)
  const [savingHost, setSavingHost] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const backendBusy = useBackendBusy()

  useEffect(() => {
    setHost(settings.ollamaHost)
  }, [settings.ollamaHost])

  const llm = status?.llm

  const saveHost = async (): Promise<void> => {
    const value = host.trim()
    if (value.length === 0 || value === settings.ollamaHost) return
    setSavingHost(true)
    const saved = await saveSettings({ ollamaHost: value })
    setSavingHost(false)
    if (saved) pushToast('info', 'Ollama host updated.')
  }

  const refresh = async (): Promise<void> => {
    setRefreshing(true)
    const next = await attempt(() => api.refreshStatus(), {
      errorPrefix: 'Could not reach the local model runner'
    })
    setRefreshing(false)
    if (next) {
      pushToast(
        next.llm.available ? 'info' : 'warn',
        next.llm.available
          ? `Ollama is ready with ${plural(next.llm.models.length, 'model')}.`
          : 'Ollama is not reachable. Summaries and answers will use the extractive fallback.'
      )
    }
  }

  return (
    <div>
      <SectionHeader
        title="Local AI"
        description="Summaries, action items and answers are produced by a model running on this machine through Ollama. If it is not running, everything else still works — you just get extractive notes instead of written ones."
      />

      <div
        className={cx(
          'flex flex-wrap items-center gap-3 rounded-md border px-3.5 py-3',
          llm?.available
            ? 'border-signal-500/25 bg-signal-500/[0.05]'
            : 'border-ink-800 bg-ink-900/50'
        )}
      >
        <span
          aria-hidden="true"
          className={cx(
            'h-2 w-2 shrink-0 rounded-full',
            llm?.available ? 'bg-signal-400' : 'bg-ink-600'
          )}
        />
        <span className="text-[13px] text-ink-100">
          {!loaded
            ? 'Checking Ollama…'
            : llm?.available
              ? 'Ollama is running'
              : 'Ollama is not reachable'}
        </span>
        {llm && <span className="font-mono text-[11px] text-ink-500">{llm.host}</span>}
        {backendBusy && (
          <span className="font-mono text-[11px] text-signal-300">{backendBusy.label}</span>
        )}
        <Button
          size="sm"
          variant="secondary"
          className="ml-auto"
          loading={refreshing}
          icon={<Icon name="refresh" size={13} />}
          onClick={() => void refresh()}
        >
          Re-check
        </Button>
      </div>

      {llm?.guidance && (
        <p className="mt-3 flex items-start gap-2 text-[12.5px] leading-relaxed text-ink-400">
          <Icon name="info" size={13} className="mt-0.5 shrink-0 text-ink-500" />
          {llm.guidance}
        </p>
      )}

      <div className="mt-4 divide-y divide-ink-800/70 rounded-md border border-ink-800 px-3.5">
        <Field
          label="Chat model"
          hint={settings.ollamaModel ?? 'none selected'}
        >
          {llm && llm.models.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {llm.models.map((model) => (
                <button
                  key={model.name}
                  type="button"
                  onClick={() => void saveSettings({ ollamaModel: model.name })}
                  className={cx(
                    'rounded-md border px-2.5 py-1.5 text-left transition-colors',
                    settings.ollamaModel === model.name
                      ? 'border-signal-500/40 bg-signal-500/10 text-signal-200'
                      : 'border-ink-800 text-ink-300 hover:border-ink-700 hover:text-ink-100'
                  )}
                >
                  <span className="block font-mono text-[12px]">{model.name}</span>
                  <span className="block font-mono text-[10px] uppercase tracking-[0.08em] text-ink-500">
                    {model.parameterSize ?? '—'} · {formatBytes(model.sizeBytes)}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <p className="text-[12.5px] text-ink-500">
              No models listed. Install Ollama, then run{' '}
              <code className="font-mono text-ink-300">ollama pull llama3.1:8b</code>.
            </p>
          )}
        </Field>

        <Field
          label="Embedding model"
          hint={settings.embeddingModel ?? 'semantic search disabled'}
        >
          <div className="flex flex-wrap items-center gap-2">
            <input
              defaultValue={settings.embeddingModel ?? ''}
              onBlur={(event) => {
                const value = event.target.value.trim()
                if (value !== (settings.embeddingModel ?? '')) {
                  void saveSettings({ embeddingModel: value || null })
                }
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur()
              }}
              placeholder="nomic-embed-text"
              className="field field-sm max-w-xs font-mono text-[12px]"
              aria-label="Embedding model"
            />
            <p className="text-[12px] text-ink-500">
              Used only for semantic search and the cross-meeting index.
            </p>
          </div>
        </Field>

        <Field label="Ollama host" hint="http://127.0.0.1:11434 by default">
          <div className="flex max-w-lg items-center gap-2">
            <input
              value={host}
              onChange={(event) => setHost(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void saveHost()
              }}
              className="field field-sm font-mono text-[12px]"
              aria-label="Ollama host"
              spellCheck={false}
            />
            <Button
              size="sm"
              variant="secondary"
              loading={savingHost}
              disabled={host.trim() === settings.ollamaHost}
              onClick={() => void saveHost()}
            >
              Save
            </Button>
          </div>
        </Field>

        <Field
          label="Roll-back window for “What did I miss?”"
          hint={`${settings.missedWindowMinutes} minutes`}
        >
          <div className="flex max-w-lg items-center gap-3">
            <input
              type="range"
              min={1}
              max={30}
              step={1}
              value={settings.missedWindowMinutes}
              onChange={(event) =>
                void saveSettings({ missedWindowMinutes: Number(event.target.value) })
              }
              aria-label="Roll-back window in minutes"
              className="w-56 accent-signal-500"
            />
            <span className="font-mono text-[12px] text-ink-400">
              last {settings.missedWindowMinutes} min
            </span>
          </div>
        </Field>
      </div>

      <VoiceProfilesSection />
    </div>
  )
}

function VoiceProfilesSection(): ReactNode {
  const profiles = useAsyncData(() => api.listVoiceProfiles(), [], {
    toastOnError: 'Could not list voice profiles'
  })
  const [deleting, setDeleting] = useState<string | null>(null)
  const list = profiles.data ?? []

  const remove = async (id: string, name: string): Promise<void> => {
    setDeleting(id)
    const ok = await attempt(async () => {
      await api.deleteVoiceProfile(id)
      return true
    }, { errorPrefix: `Could not delete the voice profile for ${name}` })
    setDeleting(null)
    if (ok) profiles.refresh()
  }

  return (
    <div className="mt-8">
      <div className="flex items-baseline gap-3 pb-2">
        <h3 className="section-title">Voice profiles</h3>
        <span className="font-mono text-[11px] text-ink-600">{plural(list.length, 'profile')}</span>
        <span aria-hidden="true" className="h-px flex-1 bg-ink-800/70" />
      </div>
      {profiles.error ? (
        <ErrorState message={profiles.error} onRetry={profiles.refresh} compact />
      ) : list.length === 0 ? (
        <p className="text-[12.5px] leading-relaxed text-ink-500">
          None yet. Profiles are created when diarization is available and are stored as embedding
          centroids — numbers, not recordings.
        </p>
      ) : (
        <ul className="divide-y divide-ink-800/70 rounded-md border border-ink-800">
          {list.map((profile) => (
            <li key={profile.id} className="flex items-center gap-3 px-3.5 py-2.5">
              <Icon name="users" size={14} className="shrink-0 text-ink-500" />
              <span className="min-w-0 flex-1 truncate text-[13px] text-ink-200">
                {profile.name}
              </span>
              <span className="font-mono text-[11px] text-ink-500">
                {plural(profile.sampleCount, 'sample')} · dim {profile.dim}
              </span>
              <IconButton
                label={`Delete voice profile for ${profile.name}`}
                size="sm"
                disabled={deleting === profile.id}
                onClick={() => void remove(profile.id, profile.name)}
              >
                <Icon name="trash" size={13} />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Audio                                                              */
/* ------------------------------------------------------------------ */

function AudioSection({ settings }: { settings: AppSettings }): ReactNode {
  const [systemDevice, setSystemDevice] = useState(settings.systemDeviceId ?? '')
  const [micDevice, setMicDevice] = useState(settings.micDeviceId ?? '')

  const saveDevice = async (key: 'systemDeviceId' | 'micDeviceId', value: string): Promise<void> => {
    const trimmed = value.trim() || null
    await saveSettings(
      key === 'systemDeviceId' ? { systemDeviceId: trimmed } : { micDeviceId: trimmed }
    )
  }

  return (
    <div>
      <SectionHeader
        title="Capture"
        description="System audio is recorded from the default playback device (WASAPI loopback), the microphone from the default recording device. Device IDs are the Windows endpoint IDs; leave blank for the system default."
      />

      <div className="divide-y divide-ink-800/70 rounded-md border border-ink-800 px-3.5">
        <Field label="Capture microphone" hint={settings.captureMic ? 'on' : 'off'}>
          <div className="flex flex-wrap items-center gap-4">
            <Toggle
              label="Record your own voice alongside everyone else"
              checked={settings.captureMic}
              onChange={(next) => void saveSettings({ captureMic: next })}
            />
            <p className="text-[12px] leading-relaxed text-ink-500">
              With the microphone on, your lines are labelled “You” instead of being folded in with
              the room.
            </p>
          </div>
        </Field>

        <Field label="System device ID" hint={settings.systemDeviceId ?? 'default output'}>
          <div className="flex max-w-xl items-center gap-2">
            <input
              value={systemDevice}
              onChange={(event) => setSystemDevice(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void saveDevice('systemDeviceId', systemDevice)
              }}
              placeholder="default"
              className="field field-sm font-mono text-[12px]"
              aria-label="System audio device ID"
              spellCheck={false}
            />
            <Button
              size="sm"
              variant="secondary"
              disabled={systemDevice === (settings.systemDeviceId ?? '')}
              onClick={() => void saveDevice('systemDeviceId', systemDevice)}
            >
              Save
            </Button>
          </div>
        </Field>

        <Field label="Microphone device ID" hint={settings.micDeviceId ?? 'default input'}>
          <div className="flex max-w-xl items-center gap-2">
            <input
              value={micDevice}
              onChange={(event) => setMicDevice(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void saveDevice('micDeviceId', micDevice)
              }}
              placeholder="default"
              className="field field-sm font-mono text-[12px]"
              aria-label="Microphone device ID"
              spellCheck={false}
            />
            <Button
              size="sm"
              variant="secondary"
              disabled={micDevice === (settings.micDeviceId ?? '')}
              onClick={() => void saveDevice('micDeviceId', micDevice)}
            >
              Save
            </Button>
          </div>
        </Field>

        <Field
          label="Silence threshold"
          hint={`rms ${settings.silenceThreshold.toFixed(3)}`}
        >
          <div className="flex max-w-xl items-center gap-3">
            <input
              type="range"
              min={0}
              max={0.1}
              step={0.002}
              value={settings.silenceThreshold}
              onChange={(event) =>
                void saveSettings({ silenceThreshold: Number(event.target.value) })
              }
              aria-label="Silence threshold"
              className="w-56 accent-signal-500"
            />
            <p className="text-[12px] leading-relaxed text-ink-500">
              Chunks quieter than this are skipped instead of being sent to the model. Raise it if
              room noise produces phantom lines.
            </p>
          </div>
        </Field>

        <Field label="Keep audio" hint={settings.keepAudio ? 'keeping WAV files' : 'discarding after transcription'}>
          <div className="flex flex-wrap items-center gap-4">
            <Toggle
              label="Keep the raw WAV files after the meeting"
              checked={settings.keepAudio}
              onChange={(next) => void saveSettings({ keepAudio: next })}
            />
            <p className="text-[12px] leading-relaxed text-ink-500">
              Off by default: the transcript is the record, and raw audio is the most sensitive and
              the largest thing on disk.
            </p>
          </div>
        </Field>

        <Field
          label="Audio retention"
          hint={
            settings.audioRetentionDays === 0
              ? 'never delete automatically'
              : `${settings.audioRetentionDays} days`
          }
        >
          <div className="flex flex-wrap items-center gap-3">
            <select
              value={settings.audioRetentionDays}
              onChange={(event) =>
                void saveSettings({ audioRetentionDays: Number(event.target.value) })
              }
              aria-label="Audio retention in days"
              className="field field-sm w-44"
            >
              <option value={0}>Keep forever</option>
              <option value={1}>1 day</option>
              <option value={7}>7 days</option>
              <option value={30}>30 days</option>
              <option value={90}>90 days</option>
            </select>
            <p className="text-[12px] leading-relaxed text-ink-500">
              Only applies to kept audio. Transcripts, summaries and action items are never deleted
              automatically.
            </p>
          </div>
        </Field>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Data                                                               */
/* ------------------------------------------------------------------ */

function DataSection(): ReactNode {
  const paths = usePaths()
  const [opening, setOpening] = useState<'data' | 'logs' | null>(null)
  const [confirmReset, setConfirmReset] = useState(false)

  const open = async (which: 'data' | 'logs'): Promise<void> => {
    setOpening(which)
    await attempt(async () => {
      if (which === 'data') await api.openDataDir()
      else await api.openLogs()
      return true
    }, { errorPrefix: 'Could not open that folder' })
    setOpening(null)
  }

  const unknownPaths: AppPaths = {
    dataDir: '—',
    dbPath: '—',
    audioDir: '—',
    modelsDir: '—',
    logsDir: '—',
    briefDocsDir: '—'
  }
  const values = paths ?? unknownPaths

  return (
    <div>
      <SectionHeader
        title="Where your data lives"
        description="Everything Local Note stores is under these folders. There is no server-side copy, so a backup is simply a copy of the data folder."
      />

      <div className="rounded-md border border-ink-800 bg-ink-900/50 px-3.5 py-2">
        {paths == null ? (
          <div className="space-y-3 py-3" aria-busy="true">
            <Skeleton width="100%" />
            <Skeleton width="80%" />
            <Skeleton width="90%" />
          </div>
        ) : (
          <div className="divide-y divide-ink-800/70">
            <PathRow label="Data folder" value={values.dataDir} />
            <PathRow label="Database" value={values.dbPath} />
            <PathRow label="Audio" value={values.audioDir} />
            <PathRow label="Models" value={values.modelsDir} />
            <PathRow label="Brief docs" value={values.briefDocsDir} />
            <PathRow label="Logs" value={values.logsDir} />
          </div>
        )}
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          variant="secondary"
          size="sm"
          loading={opening === 'data'}
          icon={<Icon name="folder" size={13} />}
          onClick={() => void open('data')}
        >
          Open data folder
        </Button>
        <Button
          variant="secondary"
          size="sm"
          loading={opening === 'logs'}
          icon={<Icon name="terminal" size={13} />}
          onClick={() => void open('logs')}
        >
          Open logs
        </Button>
      </div>

      <div className="mt-8 rounded-md border border-red-500/25 bg-red-500/[0.05] px-3.5 py-3.5">
        <h3 className="flex items-center gap-2 text-[13.5px] font-medium text-red-200">
          <Icon name="alert" size={14} />
          Delete all data
        </h3>
        <p className="mt-2 max-w-[72ch] text-[12.5px] leading-relaxed text-ink-300">
          There is no in-app wipe yet, because deleting is not recoverable here. To remove
          everything: close Local Note, then delete the data folder shown above. That removes the
          database, kept audio, downloaded models and logs. Windows will ask you to confirm.
        </p>
        <ul className="mt-2 space-y-1 font-mono text-[11px] text-ink-400">
          <li>· {values.dataDir}</li>
          <li className="text-ink-500">
            (optional) also uninstall Python packages and Ollama models if nothing else on this
            machine uses them
          </li>
        </ul>
        {confirmReset ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-[12.5px] text-ink-300">
              Nothing is deleted from here. Copy the command to do it by hand?
            </span>
            <Button
              size="sm"
              variant="danger"
              icon={<Icon name="copy" size={13} />}
              onClick={async () => {
                const ok = await copyText(`rmdir /s /q "${values.dataDir}"`)
                pushToast(
                  ok ? 'warn' : 'error',
                  ok
                    ? 'Command copied. Run it in a terminal after closing Local Note.'
                    : 'Could not copy the command.'
                )
                setConfirmReset(false)
              }}
            >
              Copy removal command
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmReset(false)}>
              Close
            </Button>
          </div>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            className="mt-3 text-red-300 hover:bg-red-500/10"
            icon={<Icon name="trash" size={13} />}
            onClick={() => setConfirmReset(true)}
          >
            How do I remove everything?
          </Button>
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Diagnostics                                                        */
/* ------------------------------------------------------------------ */

function DiagnosticsSection(): ReactNode {
  const checks = useAsyncData(() => api.runSetupChecks(), [], {})
  const logs = useAsyncData(() => api.getLogTail(400), [], {})
  const [compiling, setCompiling] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  const recheck = useCallback(() => {
    checks.refresh()
    logs.refresh()
  }, [checks, logs])

  const compile = async (): Promise<void> => {
    setCompiling(true)
    const outcome = await attempt(() => api.compileRecorder(), {
      label: 'Rebuilding the capture helper…',
      errorPrefix: 'Could not rebuild the recorder'
    })
    setCompiling(false)
    if (outcome) {
      setResult(outcome.message)
      pushToast(outcome.ok ? 'info' : 'error', outcome.message)
    }
  }

  const checkList = checks.data ?? []

  return (
    <div>
      <SectionHeader
        title="Diagnostics"
        description="The same checks the first-run screen uses. Each one either passes, warns, or blocks a feature — and says what to do about it."
      />

      <div className="flex items-center gap-2 pb-2">
        <h3 className="section-title">Setup checks</h3>
        <span aria-hidden="true" className="h-px flex-1 bg-ink-800/70" />
        <Button
          size="sm"
          variant="ghost"
          icon={<Icon name="refresh" size={12} />}
          onClick={recheck}
        >
          Re-run
        </Button>
      </div>

      {checks.error ? (
        <ErrorState message={checks.error} onRetry={checks.refresh} compact />
      ) : checks.loading && checkList.length === 0 ? (
        <LoadingBlock label="Running checks…" />
      ) : (
        <ul className="divide-y divide-ink-800/70 rounded-md border border-ink-800">
          {checkList.map((check) => (
            <CheckRow key={check.id} check={check} />
          ))}
        </ul>
      )}

      <div className="mt-8 flex items-center gap-2 pb-2">
        <h3 className="section-title">Audio capture helper</h3>
        <span aria-hidden="true" className="h-px flex-1 bg-ink-800/70" />
      </div>
      <div className="rounded-md border border-ink-800 bg-ink-900/50 px-3.5 py-3">
        <p className="max-w-[72ch] text-[12.5px] leading-relaxed text-ink-400">
          The recorder is a small C# program that P/Invokes the Windows Core Audio APIs directly. It
          is compiled with the csc.exe that ships with Windows — no .NET SDK, no NuGet, no virtual
          audio cable. Rebuild it if capture fails with a compiler or version error.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            loading={compiling}
            icon={<Icon name="refresh" size={13} />}
            onClick={() => void compile()}
          >
            Rebuild recorder
          </Button>
          {result && <span className="font-mono text-[11px] text-ink-400">{truncate(result, 120)}</span>}
        </div>
      </div>

      <div className="mt-8 flex items-center gap-2 pb-2">
        <h3 className="section-title">Log tail</h3>
        <span className="font-mono text-[11px] text-ink-600">newest last</span>
        <span aria-hidden="true" className="h-px flex-1 bg-ink-800/70" />
        <Button
          size="sm"
          variant="ghost"
          icon={<Icon name="refresh" size={12} />}
          onClick={logs.refresh}
        >
          Refresh
        </Button>
      </div>
      {logs.error ? (
        <ErrorState message={logs.error} onRetry={logs.refresh} compact />
      ) : (
        <pre className="well max-h-80 overflow-auto px-3.5 py-3 font-mono text-[11.5px] leading-relaxed text-ink-300">
          {logs.loading && logs.data == null ? 'Reading log file…' : (logs.data ?? 'No log output.')}
        </pre>
      )}
      <p className="mt-2 text-[12px] leading-relaxed text-ink-500">
        Logs never include transcript text — only counts, timings, device names and errors — so they
        are safe to paste into a bug report.
      </p>
    </div>
  )
}

function CheckRow({ check }: { check: SetupCheck }): ReactNode {
  const tone =
    check.status === 'ok'
      ? { dot: 'bg-signal-400', text: 'text-signal-300', label: 'ok' }
      : check.status === 'warn'
        ? { dot: 'bg-ember-400', text: 'text-ember-300', label: 'warning' }
        : { dot: 'bg-red-400', text: 'text-red-300', label: 'missing' }

  return (
    <li className="flex items-start gap-3 px-3.5 py-3">
      <span aria-hidden="true" className={cx('mt-1.5 h-2 w-2 shrink-0 rounded-full', tone.dot)} />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-baseline gap-2">
          <span className="text-[13.5px] text-ink-100">{check.label}</span>
          <span className={cx('font-mono text-[10px] uppercase tracking-[0.1em]', tone.text)}>
            {tone.label}
          </span>
        </p>
        <p className="mt-0.5 max-w-[72ch] text-[12.5px] leading-relaxed text-ink-400">
          {check.detail}
        </p>
        {check.action && (
          <p className="mt-1.5 flex items-start gap-1.5 text-[12.5px] leading-relaxed text-ink-300">
            <Icon name="arrowUpRight" size={13} className="mt-0.5 shrink-0 text-ink-500" />
            <span>{check.action}</span>
          </p>
        )}
      </div>
    </li>
  )
}
