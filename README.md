# Local Note

An offline meeting notetaker for Windows. It records **what your speakers are
playing** (the other people on a call) plus your own microphone, transcribes it
locally with speaker labels, and writes summaries and action items — with **no
account, no cloud, and no telemetry**.

Everything runs on your machine. The only time Local Note touches the network is
when *you* explicitly download a model, once.

```
┌─────────────────────────────────────────────────────────────┐
│                    Renderer (React + Tailwind)              │
│  Live transcript · meeting archive · search · dictionary    │
└───────────────────────────┬─────────────────────────────────┘
                            │ context-isolated IPC
┌───────────────────────────▼─────────────────────────────────┐
│                   Electron main process (Node)              │
│  capture orchestration · SQLite · search index · prompts    │
└──────┬────────────────────┬────────────────────┬────────────┘
       │                    │                    │
┌──────▼────────┐  ┌────────▼────────┐  ┌────────▼──────────┐
│ WasapiRecorder│  │  Python sidecar │  │  Ollama (optional)│
│  C# · WASAPI  │  │  faster-whisper │  │  localhost:11434  │
│  loopback+mic │  │  ONNX MiniLM    │  │  summaries / Q&A  │
│  (no driver)  │  │  diarization    │  │                   │
└──────┬────────┘  └────────┬────────┘  └────────┬──────────┘
       │                    │                    │
┌──────▼────────────────────▼────────────────────▼──────────┐
│      %APPDATA%\Local Note  —  localnote.db + audio\       │
│      meetings · segments · action items · embeddings      │
└───────────────────────────────────────────────────────────┘
```

---

## Why there is no virtual audio driver

Most meeting recorders either join the call as a bot or ask you to install a
virtual audio cable. Local Note does neither: it uses **WASAPI loopback capture**,
a Windows feature that lets an application record the default output device
directly. The call app never knows it is being recorded, and you never install a
driver.

The helper is a single dependency-free C# file
([`native/WasapiRecorder.cs`](native/WasapiRecorder.cs)) that P/Invokes the Core
Audio APIs. It is compiled with the C# compiler that **ships inside Windows**
(`csc.exe`) — so building this project needs no Visual Studio, no .NET SDK, and
no Rust toolchain.

The microphone and the system audio are captured as **two parallel streams**,
never mixed. That is a deliberate design choice: it means the app knows *"You"*
versus *"Them"* before any speaker-diarization model runs, which is both cheaper
and more reliable than clustering alone.

---

## Prerequisites

| Requirement | Needed for | Notes |
|---|---|---|
| **Windows 10/11 (x64)** | everything | WASAPI loopback is Windows-only |
| **Node.js 20+** | building / running | [nodejs.org](https://nodejs.org) |
| **Python 3.10+** | transcription | Only for speech-to-text; the app runs without it |
| **Ollama** | summaries, action items, Q&A | Optional — [ollama.com/download](https://ollama.com/download) |

Nothing else. No API keys, no accounts, no sign-in.

---

## Setup

```bash
git clone <your-fork-url> local-note
cd local-note

# 1. JavaScript dependencies (this also fetches the Electron binary)
npm install

# 2. Python speech-to-text, in a project-local virtualenv the app auto-detects
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r sidecar\requirements.txt

# 3. (Optional) a local language model, for summaries and Q&A
ollama pull llama3.1:8b
```

> **If step 2 fails with "Python was not found; run without arguments to install
> from the Microsoft Store"**, the `python` on your PATH is a Windows Store
> stub, not a real interpreter. This is common on Windows 11 and also happens
> when Python was installed via Anaconda or Miniconda. Find a real one and use it
> by full path:
>
> ```powershell
> # See which interpreters exist, then use one of them by path:
> where.exe python
> & "$env:USERPROFILE\miniconda3\python.exe" --version
>
> # Create the virtualenv with that interpreter instead:
> & "$env:USERPROFILE\miniconda3\python.exe" -m venv .venv
> .venv\Scripts\python.exe -m pip install -r sidecar\requirements.txt
> ```
>
> The app does not need `python` on your PATH. It probes a project `.venv`
> first, then the `py` launcher, then `python`, and you can point it at any
> interpreter explicitly with the `pythonPath` setting. Store stubs are skipped
> automatically.

Then launch it:

```bash
npm run dev      # development, with hot reload
```

### Download a speech model (one time)

Transcription needs a Whisper model. Download one from **Settings → Models** in
the app; `base.en` (~145 MB) is the recommended starting point. This is the only
network access the app ever performs, it is always user-initiated, and the
progress is shown on screen.

You can also pre-fetch it from the command line:

```bash
.venv\Scripts\python.exe -c "from faster_whisper import WhisperModel; WhisperModel('base.en')"
```

### Optional: speaker diarization

Out of the box you already get two speaker labels for free, because the
microphone and system audio are captured as separate streams: **You** and
**Speaker 1** (the far end of the call). Nothing extra is needed for that.

If a call has *several* remote participants and you want them split into
`Speaker 1`, `Speaker 2`, `Speaker 3`, install the diarization extras. This pulls
in PyTorch (a few GB), which is why it is not enabled by default:

```bash
.venv\Scripts\python.exe -m pip install torch speechbrain scikit-learn scipy
```

Local Note then runs a diarization pass after each recording and relabels the
system-audio segments. It uses the openly licensed
`pyannote/speaker-diarization-community-1` pipeline when `pyannote.audio` is
installed, and otherwise falls back to SpeechBrain speaker embeddings with
agglomerative clustering. Neither path needs a Hugging Face account or an API
key — the gated pyannote models are deliberately avoided.

### Build the Windows installer

```bash
npm run dist
```

This produces an NSIS installer and a portable `.exe` in `release\`. The
installer is unsigned, so Windows SmartScreen will warn on first run — choose
*More info → Run anyway*, or sign it with your own certificate.

> **If `npm run dist` fails with `EPERM: operation not permitted, rename
> '...win-unpacked.tmp'`**, a path involved in the build contains a space.
> electron-builder extracts archives into the output directory *and* its cache
> directory, and Windows refuses the final rename when either path contains a
> space.
>
> `npm run dist` already handles this: it detects a space in the project path and
> redirects the cache and output to space-free sibling folders, printing where
> they went. If you invoke `electron-builder` yourself, do the same manually:
>
> ```bash
> set ELECTRON_BUILDER_CACHE=D:\ln-cache\builder
> set ELECTRON_CACHE=D:\ln-cache\electron
> npx electron-builder --win --config.directories.output=D:\ln-build
> ```
>
> Cloning the project into a path with no spaces avoids the problem entirely.
> This is a Windows/electron-builder quirk, not a defect in the app.

Other useful scripts:

```bash
npm run build        # compile native helper + main process + renderer
npm start            # build, then run the production bundle
npm run typecheck    # type-check both processes
npm run icon         # regenerate the app/tray icons
npm run build:native # recompile just the C# audio helper
```

---

## Choosing a model

Bigger models are more accurate and slower. On a modern laptop CPU with
`faster-whisper`, roughly:

| Model | Download | RAM | Speed on CPU | Use when |
|---|---|---|---|---|
| `tiny.en` | 75 MB | ~1 GB | much faster than real time | clear audio, quick notes |
| `base.en` | 145 MB | ~2 GB | faster than real time | **recommended default** |
| `small.en` | 480 MB | ~3 GB | roughly real time | accents, jargon, noisy rooms |
| `medium.en` | 1.5 GB | ~6 GB | slower than real time | accuracy matters more than latency |
| `large-v3` | 3.1 GB | ~10 GB | needs a GPU | best accuracy available |

Models ending in `.en` are English-only and slightly better at English for the
same size. For summaries, an 8B model such as `llama3.1:8b` is a good balance;
anything smaller tends to drift from the transcript.

---

## Features

- **System + microphone capture** — WASAPI loopback and mic in parallel, chunked
  every 5 seconds for near-live transcription.
- **Live transcript** with speaker labels and timestamps.
- **"What did I miss?"** — summarises the last N minutes (default 10) in place,
  without blocking the transcript.
- **Post-meeting summary and action items**, generated locally with map-reduce so
  long meetings are never truncated.
- **Speaker labels** — `You` and `Speaker 1` out of the box from stream
  separation; optional diarization splits the far end into `Speaker 1/2/3`, and
  you can rename any speaker to a real name.
- **Search** — SQLite FTS5 keyword search fused with local semantic search
  (reciprocal rank fusion), plus **"ask across all meetings"** with citations.
- **Personal dictionary** — terms are fed to Whisper as a biasing prompt *and*
  applied as a fuzzy correction pass, so `cubernetes` becomes `Kubernetes`.
- **Pre-meeting brief** — paste an agenda, attach a PDF/text file, or import an
  `.ics` calendar export to pre-fill the title, time and attendee names.
- **In-person mode** — microphone-only recording for room meetings and voice
  memos.
- **Recording indicator** — a persistent amber UI state and a tray icon that
  changes while recording.
- **Data portability** — one SQLite file plus an audio folder, both in a
  documented path.

### Where your data lives

```
%APPDATA%\Local Note\
├── localnote.db        every meeting, transcript, summary and embedding
├── audio\<meeting>\    full-session WAVs + live chunks (optional)
├── models\             downloaded speech and embedding models
├── brief-docs\         copies of documents attached to a brief
└── logs\               local-only log files
```

**Moving it, or keeping models off a small system drive.** Copy
`localnote.config.example.json` to `localnote.config.json` in the project root:

```json
{
  "dataDir": "D:\\LocalNote\\data",
  "modelsDir": "D:\\LocalNote\\models"
}
```

`modelsDir` is worth setting separately: models are by far the largest thing the
app stores (a `large-v3` Whisper model is over 3 GB), while the database and
audio are comparatively small. Both directories are created automatically.

You can also set `LOCALNOTE_DATA_DIR`, `LOCALNOTE_MODELS_DIR` and
`LOCALNOTE_RESOURCE_DIR` as environment variables; the config file wins over the
defaults but environment variables win over the config file. The model cache for
Hugging Face downloads is redirected into `modelsDir` too, so nothing large is
ever written to `%USERPROFILE%\.cache`.

**Everything the app writes goes to `dataDir`.** That includes Electron's own
profile — `Cache`, `GPUCache`, `Local Storage`, session and network state — which
otherwise defaults to `%APPDATA%\<productName>` on the system drive and ignores
this setting entirely. Point `dataDir` at another volume and nothing is left on
`C:`.

For an **installed** build, the config file is not packaged (it is
machine-specific), so set the environment variable instead and every launch will
use it:

```powershell
[Environment]::SetEnvironmentVariable('LOCALNOTE_DATA_DIR', 'D:\LocalNote\data', 'User')
```

The Windows installer also defaults its own install location to `D:\Local Note`
when a `D:` drive exists, and still lets you change it in the directory picker.

### Keeping development caches off the system drive

Tool caches are not part of the app, but they are often the largest thing on a
developer's machine — an npm cache alone can reach tens of gigabytes. To move
them:

```powershell
npm config set cache D:\dev-cache\npm

[Environment]::SetEnvironmentVariable('PIP_CACHE_DIR',          'D:\dev-cache\pip',              'User')
[Environment]::SetEnvironmentVariable('ELECTRON_CACHE',         'D:\dev-cache\electron',         'User')
[Environment]::SetEnvironmentVariable('ELECTRON_BUILDER_CACHE', 'D:\dev-cache\electron-builder', 'User')
[Environment]::SetEnvironmentVariable('HF_HOME',                'D:\dev-cache\huggingface',      'User')
```

---

## Privacy & Local-Only Guarantee

**What never leaves your machine:** audio, transcripts, summaries, action items,
search queries, embeddings, the personal dictionary, and the meeting archive.
There is no telemetry, no analytics, no crash reporting, and no account system.
Crash and diagnostic logs are written to a local file only.

**The only network access, ever:**

1. `npm install` — fetches JavaScript dependencies (build time).
2. `pip install -r sidecar\requirements.txt` — fetches Python packages (setup).
3. `ollama pull <model>` — downloads an LLM you choose (setup, run by you).
4. **Settings → Models → Download** — fetches a Whisper model or the ONNX
   embedding model. Always explicit, always shows progress.

At runtime the app is enforced offline: the renderer's network layer is blocked
in `electron/main.ts`, so any request that is not a local app asset is cancelled
and logged. The Ollama client refuses any host that is not loopback, so even a
misconfiguration cannot send meeting content to a remote server.

**Consent:** recording other people may be legally regulated where you live
(several jurisdictions require all-party consent). Local Note keeps a visible
recording indicator and a tray state change precisely so that recording is never
silent or accidental. Following the law is your responsibility, not the app's.

---

## Architecture notes

- **No native Node modules.** The database is SQLite through Node's built-in
  `node:sqlite`, which includes FTS5. `npm install` therefore never needs a C++
  toolchain, which is what makes "clone and run" actually work on a clean
  machine.
- **The sidecar is a persistent process**, not one process per chunk, so the
  Whisper model is loaded once and reused.
- **Long transcripts are summarised map-reduce style** — chunk, summarise each
  chunk, then merge the summaries — because a one-hour meeting does not fit in a
  small model's context window.
- **Timeline alignment.** Loopback capture delivers nothing while the speakers
  are silent. The recorder pads the system stream with silence to keep it in step
  with the microphone stream, so timestamps and speaker attribution stay aligned.
- **Graceful degradation at every layer.** No Python → audio is still recorded
  and can be transcribed later. No Ollama → summaries fall back to an extractive
  keyword summary. No embedding model → search still works through FTS5.

---

## Known limitations

**Speaker bleed when using speakers instead of headphones.** The microphone can
hear your speakers, which captures the other participants twice: once digitally
from the system stream and once acoustically from the microphone. Local Note
detects this and discards the duplicate, and warns you when it happens.

It is a mitigation rather than a complete fix. Suppression keys on the duplicate
arriving at almost the same instant on both streams, which is what distinguishes
bleed from two people simply saying similar things. Where the microphone hears
the speakers only faintly, the two transcriptions can differ enough that the
duplicate is not recognised. **Wearing headphones removes the problem entirely**
and is the recommended way to use Local Note on a call.

**Diarization of multiple remote speakers** needs optional PyTorch extras
(`torch speechbrain scikit-learn scipy`). Stream separation already gives you
`You` versus `Speaker 1` without them.

**Scanned PDFs** have no text layer, so nothing can be extracted from them. This
is reported rather than silently ignored.

**The installer is unsigned**, so Windows SmartScreen warns on first run.

**Windows only.** WASAPI loopback is a Windows API. The UI, storage and search
layers are portable, but audio capture is not.

**Voice-print re-identification** across meetings is not implemented. The
`voice_profiles` table exists for it, but matching is deliberately left out: it
is biometric data and deserves its own design discussion before being built.

---

## Troubleshooting

**"Transcription is unavailable"**
Install the Python dependencies into the project virtualenv (step 2 above), then
use **Settings → Diagnostics → Re-run checks**. Point the app at a specific
interpreter with the `pythonPath` setting if you use a different environment.

**The microphone captures nothing**
Local Note tells you this explicitly rather than silently recording silence —
look for the "no audio" state on the level meter. Check the Windows input device,
that it is not muted, and that the app has microphone permission in
*Settings → Privacy → Microphone*.

**No system audio is captured**
Check that the device playing the call is the Windows **default output device**.
Bluetooth headsets frequently switch between two profiles; if audio is routed to
a different endpoint than the one Windows reports as default, nothing will be
captured. The recording indicator shows which device is in use.

**Summaries are missing or poor**
Confirm Ollama is running (`ollama list`) and that a model is pulled. Very small
models (1-3B) often produce weak meeting summaries; `llama3.1:8b` or larger is
recommended.

**Nothing works and I want to see why**
**Settings → Diagnostics** shows a checklist plus the tail of the local log file.

---

## Contributing

Issues and pull requests are welcome.

- `npm run typecheck` must pass before submitting.
- The main process and the renderer share their types through `shared/`, and
  `shared/api.ts` is the single source of truth for the IPC surface. Adding a
  method to `LocalNoteApi` without adding it to `INVOKE_METHODS` is a **compile
  error**, by design — please keep it that way.
- New user-facing strings should be plain and honest: say what happened, what it
  means, and what the user can do about it.
- Keep the app offline. Any change that introduces a runtime network call will be
  declined; that constraint is the point of the project.

### Stretch goal (not implemented)

Voice-print based speaker re-identification across meetings — recognising that
"Speaker 2" today is the same person as "Alex" last week. The database schema
already has a `voice_profiles` table for it, but no matching logic is
implemented. It carries real privacy weight (it is biometric data), so it needs a
deliberate design discussion before being built.

---

## License

MIT — see [LICENSE](LICENSE).

Local Note is an original implementation of a *category* of tool (local meeting
notetakers). It shares no code, design, or branding with any commercial product.
