#!/usr/bin/env python3
"""
Local Note sidecar — local speech-to-text, embeddings and diarization.

Runs as a long-lived subprocess of the Electron main process and speaks a small
JSON-lines protocol over stdin/stdout, one JSON object per line. Running as a
persistent process matters: the Whisper model is loaded once and reused for
every audio chunk, instead of paying a multi-second load per chunk.

Protocol
--------
Request : {"id": "<any>", "cmd": "<name>", ...params}
Response: {"id": "<any>", "ok": true,  "result": {...}}
          {"id": "<any>", "ok": false, "error": "..."}
Events  : {"event": "<name>", ...}          (unsolicited, e.g. progress)

Commands
--------
  status                          report which engines and models are usable
  load            {model}         pre-load a Whisper model into memory
  transcribe      {path,...}      transcribe one WAV file
  embed           {texts}         embed text locally (ONNX MiniLM)
  diarize         {path,...}      speaker turns for one WAV file
  download-model  {model}         explicitly fetch a Whisper model (network)
  download-embedding-model        explicitly fetch the ONNX embedder (network)
  shutdown                        exit cleanly

Everything except the two explicit `download-*` commands runs fully offline.
"""

from __future__ import annotations

import json
import os
import sys
import traceback
from typing import Any, Dict, List, Optional

# --------------------------------------------------------------------------
# Windows symlink compatibility
# --------------------------------------------------------------------------
# huggingface_hub caches downloads by symlinking files from blobs/ into
# snapshots/. Creating a symlink on Windows requires Developer Mode or an
# elevated process, and without it the download fails part-way, leaving a model
# directory that looks present but is missing config.json and tokenizer.json.
#
# The cache can copy instead of link, but that must be decided before
# huggingface_hub is imported, so it is handled here rather than in the Node
# layer. Symlinks are kept where they work, since they avoid duplicating data.
def _symlinks_supported() -> bool:
    import tempfile

    try:
        with tempfile.TemporaryDirectory() as directory:
            source = os.path.join(directory, "source")
            link = os.path.join(directory, "link")
            with open(source, "w") as handle:
                handle.write("x")
            os.symlink(source, link)
        return True
    except (OSError, NotImplementedError, AttributeError, ValueError):
        return False


if not _symlinks_supported():
    # Copies files instead of symlinking them.
    os.environ["HF_HUB_DISABLE_SYMLINKS"] = "1"
    # Suppresses the accompanying warning; the situation is already handled.
    os.environ["HF_HUB_DISABLE_SYMLINKS_WARNING"] = "1"

# --------------------------------------------------------------------------
# Model catalogue. Sizes are approximate and only used for UI guidance.
# --------------------------------------------------------------------------

WHISPER_MODELS: Dict[str, Dict[str, Any]] = {
    "tiny": {"size": 75_000_000, "ram_gb": 1, "english_only": False},
    "tiny.en": {"size": 75_000_000, "ram_gb": 1, "english_only": True},
    "base": {"size": 145_000_000, "ram_gb": 2, "english_only": False},
    "base.en": {"size": 145_000_000, "ram_gb": 2, "english_only": True},
    "small": {"size": 480_000_000, "ram_gb": 3, "english_only": False},
    "small.en": {"size": 480_000_000, "ram_gb": 3, "english_only": True},
    "medium": {"size": 1_530_000_000, "ram_gb": 6, "english_only": False},
    "medium.en": {"size": 1_530_000_000, "ram_gb": 6, "english_only": True},
    "large-v3": {"size": 3_100_000_000, "ram_gb": 10, "english_only": False},
    "large-v3-turbo": {"size": 1_600_000_000, "ram_gb": 8, "english_only": False},
    "distil-large-v3": {"size": 1_500_000_000, "ram_gb": 8, "english_only": True},
}

EMBEDDING_MODEL_ID = "all-MiniLM-L6-v2"
EMBEDDING_FILES = {
    "model.onnx": "https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main/onnx/model.onnx",
    "tokenizer.json": "https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main/tokenizer.json",
}
EMBEDDING_DIM = 384
EMBEDDING_MAX_TOKENS = 256

_state: Dict[str, Any] = {
    "models_dir": os.environ.get("LOCALNOTE_MODELS_DIR") or os.path.join(
        os.path.expanduser("~"), ".localnote", "models"
    ),
}


def models_dir() -> str:
    path = _state["models_dir"]
    os.makedirs(path, exist_ok=True)
    return path


def whisper_download_root() -> str:
    root = os.path.join(models_dir(), "whisper")
    os.makedirs(root, exist_ok=True)
    return root


def embedding_model_dir() -> str:
    path = os.path.join(models_dir(), "embeddings", EMBEDDING_MODEL_ID)
    os.makedirs(path, exist_ok=True)
    return path


# --------------------------------------------------------------------------
# Output helpers — stdout carries protocol only; anything else goes to stderr.
# --------------------------------------------------------------------------


def send(payload: Dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, default=str) + "\n")
    sys.stdout.flush()


def log(message: str) -> None:
    sys.stderr.write(f"[localnote-sidecar] {message}\n")
    sys.stderr.flush()


def ok(request_id: Any, result: Any) -> None:
    send({"id": request_id, "ok": True, "result": result})


def fail(request_id: Any, error: str, detail: Optional[str] = None) -> None:
    payload: Dict[str, Any] = {"id": request_id, "ok": False, "error": error}
    if detail:
        payload["detail"] = detail
    send(payload)


# --------------------------------------------------------------------------
# Capability detection
# --------------------------------------------------------------------------


def module_version(name: str) -> Optional[str]:
    try:
        module = __import__(name)
        return getattr(module, "__version__", "unknown")
    except Exception:
        return None


def detect_whisper() -> Dict[str, Any]:
    version = module_version("faster_whisper")
    return {
        "available": version is not None,
        "engine": "faster-whisper" if version else None,
        "version": version,
    }


def detect_embeddings() -> Dict[str, Any]:
    onnx = module_version("onnxruntime") is not None
    tokenizers = module_version("tokenizers") is not None
    model_present = os.path.exists(os.path.join(embedding_model_dir(), "model.onnx")) and os.path.exists(
        os.path.join(embedding_model_dir(), "tokenizer.json")
    )
    return {
        "available": onnx and tokenizers and model_present,
        "onnxruntime": onnx,
        "tokenizers": tokenizers,
        "model_present": model_present,
        "model_dir": embedding_model_dir(),
        "dim": EMBEDDING_DIM,
    }


def detect_diarization() -> Dict[str, Any]:
    pyannote = module_version("pyannote.audio") is not None
    speechbrain = module_version("speechbrain") is not None
    torch = module_version("torch") is not None
    sklearn = module_version("sklearn") is not None

    engine = None
    if pyannote and torch:
        engine = "pyannote"
    elif speechbrain and sklearn and torch:
        engine = "speechbrain"

    return {
        "available": engine is not None,
        "engine": engine,
        "pyannote": pyannote,
        "speechbrain": speechbrain,
        "torch": torch,
        "sklearn": sklearn,
        "guidance": None
        if engine
        else "Speaker diarization needs the optional Python extras. Without them, Local Note "
        "still separates 'You' (microphone) from 'Them' (system audio).",
    }


def _cache_dir_to_model_id(directory_name: str) -> Optional[str]:
    """
    Maps a Hugging Face cache directory back to a Whisper model id.

    faster-whisper stores models under its own cache layout, so a downloaded
    "tiny.en" lives in a folder named:

        models--Systran--faster-whisper-tiny.en

    Reporting that raw folder name as the model id would make the app think no
    model is installed, so it is converted back to "tiny.en" here. A directory
    that already looks like a plain model id is returned unchanged, which also
    covers models placed there manually.
    """
    if not directory_name.startswith("models--"):
        return directory_name

    parts = directory_name.split("--")
    if len(parts) < 2:
        return None

    repo = parts[-1]
    for prefix in ("faster-whisper-", "whisper-"):
        if repo.startswith(prefix):
            return repo[len(prefix) :]
    return repo or None


# Files a CTranslate2 Whisper model needs to actually load. Checking for
# model.bin alone is not enough: an interrupted download can leave the weights
# in place while config.json and tokenizer.json are missing, and reporting that
# as installed makes the app try to use a model that cannot load.
REQUIRED_MODEL_FILES = ("model.bin", "config.json", "tokenizer.json")


def _snapshot_is_complete(model_directory: str) -> bool:
    """True when some snapshot inside this cache entry has every required file."""
    snapshots = os.path.join(model_directory, "snapshots")
    if not os.path.isdir(snapshots):
        # Not the Hugging Face cache layout; accept a flat model directory.
        return all(os.path.exists(os.path.join(model_directory, name)) for name in REQUIRED_MODEL_FILES)

    for entry in os.listdir(snapshots):
        snapshot = os.path.join(snapshots, entry)
        if not os.path.isdir(snapshot):
            continue
        if all(os.path.exists(os.path.join(snapshot, name)) for name in REQUIRED_MODEL_FILES):
            return True
    return False


def installed_whisper_models() -> List[str]:
    """Whisper models already downloaded and complete enough to load."""
    found: List[str] = []
    root = whisper_download_root()
    if not os.path.isdir(root):
        return found

    for entry in os.listdir(root):
        # Skip the cache's own bookkeeping directories (".locks", ".cache").
        if entry.startswith("."):
            continue
        candidate = os.path.join(root, entry)
        if not os.path.isdir(candidate):
            continue
        if not _snapshot_is_complete(candidate):
            log(f"ignoring incomplete model download: {entry}")
            continue

        model_id = _cache_dir_to_model_id(entry)
        if model_id:
            found.append(model_id)

    return sorted(set(found))


def cmd_status(request_id: Any) -> None:
    whisper = detect_whisper()
    device, compute_type = detect_device()
    ok(
        request_id,
        {
            "python": sys.version.split()[0],
            "executable": sys.executable,
            "whisper": whisper,
            "device": device,
            "computeType": compute_type,
            "embeddings": detect_embeddings(),
            "diarization": detect_diarization(),
            "models_present": installed_whisper_models(),
            "models_dir": models_dir(),
            "whisper_models": WHISPER_MODELS,
        },
    )


# --------------------------------------------------------------------------
# Whisper transcription
# --------------------------------------------------------------------------

_whisper_cache: Dict[str, Any] = {}

# Remembers the device configuration that actually worked, so a failed GPU
# probe is not repeated for every model load.
_device_cache: Dict[str, Any] = {"config": None}


def cuda_is_usable() -> bool:
    """
    Fast, reliable check for whether GPU inference can work at all.

    CTranslate2 can see an NVIDIA GPU through the driver while being unable to
    load the cuBLAS/cuDNN libraries it needs. Probing by *attempting* a model
    load is unreliable: on Windows the attempt can block for a long time before
    failing, which would leave the user staring at a stalled transcription.

    Loading the required DLLs directly answers the question in milliseconds. If
    they are missing we skip CUDA entirely and go straight to CPU.
    """
    if sys.platform != "win32":
        # On other platforms let CTranslate2 make the decision.
        return True

    import ctypes

    # CUDA 12 names first (current CTranslate2 builds), then CUDA 11.
    for group in (["cublas64_12.dll", "cublasLt64_12.dll"], ["cublas64_11.dll"]):
        try:
            for name in group:
                ctypes.WinDLL(name)
            return True
        except OSError:
            continue
    return False


def device_candidates() -> List[tuple]:
    """Device configurations to try, best first."""
    if cuda_is_usable():
        return [("cuda", "float16"), ("cuda", "int8_float16"), ("cpu", "int8")]
    return [("cpu", "int8")]


def detect_device() -> tuple:
    """Returns the device configuration currently in use."""
    return _device_cache["config"] or ("cpu", "int8")


def _warm_up(model) -> None:
    """
    Runs a tiny inference to prove the device really works.

    Constructing a WhisperModel on CUDA can succeed while the first real
    inference fails (for example "Library cublas64_12.dll is not found"), so
    loading alone is not sufficient evidence that the GPU is usable.
    """
    import numpy as np

    silence = np.zeros(1600, dtype=np.float32)  # 0.1 s at 16 kHz
    segments, _info = model.transcribe(silence, beam_size=1, vad_filter=False)
    for _ in segments:
        break


def get_whisper(model_id: str, allow_download: bool = False):
    """
    Loads a Whisper model.

    `allow_download` is False for anything the user did not explicitly ask for.
    faster-whisper will happily fetch a missing model from Hugging Face on first
    use, which would turn "press record" into an unannounced 145 MB download.
    Model downloads are supposed to be a deliberate, visible action, so every
    path except the explicit download command refuses to fetch and explains what
    to do instead.
    """
    if model_id in _whisper_cache:
        return _whisper_cache[model_id]

    if not allow_download:
        present = installed_whisper_models()
        if model_id not in present:
            size = WHISPER_MODELS.get(model_id, {}).get("size")
            size_hint = f" (about {size // 1_000_000} MB)" if size else ""
            alternatives = f" Already installed: {', '.join(present)}." if present else ""
            raise RuntimeError(
                f"The speech model '{model_id}' is not installed yet{size_hint}. "
                f"Open Settings > Models in Local Note and download it once, "
                f"then try again.{alternatives}"
            )

    from faster_whisper import WhisperModel

    # Try the known-good configuration first, then the rest.
    candidates: List[tuple] = []
    known = _device_cache["config"]
    if known:
        candidates.append(known)
    candidates.extend([candidate for candidate in device_candidates() if candidate != known])

    last_error: Optional[BaseException] = None

    for device, compute_type in candidates:
        try:
            log(f"loading whisper model '{model_id}' on {device}/{compute_type}")
            model = WhisperModel(
                model_id,
                device=device,
                compute_type=compute_type,
                download_root=whisper_download_root(),
                # Belt and braces: even if the presence check above were wrong,
                # this guarantees no implicit network fetch.
                local_files_only=not allow_download,
            )
            _warm_up(model)

            # Only keep one model resident: they are large and switching size is
            # rare compared with the cost of holding several.
            _whisper_cache.clear()
            _whisper_cache[model_id] = model
            _device_cache["config"] = (device, compute_type)
            log(f"whisper model '{model_id}' ready on {device}/{compute_type}")
            return model
        except Exception as exc:
            last_error = exc
            log(f"device {device}/{compute_type} unusable for '{model_id}': {exc}")

    raise RuntimeError(
        f"Could not load the speech model '{model_id}' on any available device. "
        f"Last error: {last_error}"
    )


def cmd_load(request_id: Any, params: Dict[str, Any]) -> None:
    model_id = params.get("model") or "base.en"
    get_whisper(model_id)
    device, compute_type = detect_device()
    ok(request_id, {"loaded": model_id, "device": device, "computeType": compute_type})


def cmd_download_model(request_id: Any, params: Dict[str, Any]) -> None:
    """
    Explicitly downloads a Whisper model. This is the only Whisper code path
    that touches the network, and it only runs when the user asks for it.
    """
    model_id = params.get("model") or "base.en"
    if model_id not in WHISPER_MODELS:
        fail(request_id, f"Unknown model '{model_id}'.")
        return

    try:
        send({"event": "progress", "id": request_id, "phase": "download", "model": model_id, "fraction": 0.05})
        # This is the one place a model may be fetched from the network.
        get_whisper(model_id, allow_download=True)
        send({"event": "progress", "id": request_id, "phase": "download", "model": model_id, "fraction": 1.0})
        ok(request_id, {"downloaded": model_id, "models_present": installed_whisper_models()})
    except Exception as exc:  # network errors, disk errors, unsupported model
        fail(request_id, f"Could not download '{model_id}': {exc}", traceback.format_exc())


def _looks_like_gpu_failure(exc: BaseException) -> bool:
    """
    Heuristic for "the GPU path is broken" as opposed to "this audio is bad".

    CTranslate2 surfaces missing CUDA runtime pieces as a generic library-load
    error, so the message is the only signal available.
    """
    text = str(exc).lower()
    return any(
        marker in text
        for marker in ("cublas", "cudnn", "cuda", "nvcuda", "cudart", "gpu", "no kernel image")
    )


def cmd_transcribe(request_id: Any, params: Dict[str, Any]) -> None:
    path = params.get("path")
    if not path or not os.path.exists(path):
        fail(request_id, f"Audio file not found: {path}")
        return

    model_id = params.get("model") or "base.en"
    initial_prompt = (params.get("initialPrompt") or "").strip() or None
    language = params.get("language") or None
    vad = bool(params.get("vad", True))
    word_timestamps = bool(params.get("wordTimestamps", False))
    beam_size = int(params.get("beamSize") or 5)

    try:
        model = get_whisper(model_id)
    except Exception as exc:
        fail(
            request_id,
            f"Speech model '{model_id}' is not available locally: {exc}",
            traceback.format_exc(),
        )
        return

    def run(active_model):
        segments, info = active_model.transcribe(
            path,
            language=language,
            initial_prompt=initial_prompt,
            vad_filter=vad,
            beam_size=beam_size,
            word_timestamps=word_timestamps,
            condition_on_previous_text=False,  # each chunk is independent audio
        )

        out_segments: List[Dict[str, Any]] = []
        for segment in segments:
            text = (segment.text or "").strip()
            if not text:
                continue
            # avg_logprob is a log-probability; convert to a rough 0..1 confidence.
            confidence = None
            if segment.avg_logprob is not None:
                confidence = max(0.0, min(1.0, 1.0 + float(segment.avg_logprob)))
            out_segments.append(
                {
                    "start": float(segment.start or 0.0),
                    "end": float(segment.end or 0.0),
                    "text": text,
                    "confidence": confidence,
                    "noSpeechProb": float(getattr(segment, "no_speech_prob", 0.0) or 0.0),
                }
            )
        return out_segments, info

    try:
        try:
            out_segments, info = run(model)
        except Exception as exc:
            # A GPU that passed the warm-up can still fail later. Rather than
            # losing the audio, pin to CPU and retry once.
            if detect_device()[0] != "cuda" or not _looks_like_gpu_failure(exc):
                raise
            log(f"GPU inference failed mid-session ({exc}); retrying on CPU")
            _whisper_cache.clear()
            _device_cache["config"] = ("cpu", "int8")
            model = get_whisper(model_id)
            out_segments, info = run(model)

        ok(
            request_id,
            {
                "path": path,
                "model": model_id,
                "device": detect_device()[0],
                "language": getattr(info, "language", None),
                "languageProbability": float(getattr(info, "language_probability", 0.0) or 0.0),
                "duration": float(getattr(info, "duration", 0.0) or 0.0),
                "segments": out_segments,
            },
        )
    except Exception as exc:
        fail(request_id, f"Transcription failed: {exc}", traceback.format_exc())


# --------------------------------------------------------------------------
# Embeddings (ONNX MiniLM — no PyTorch required)
# --------------------------------------------------------------------------

_embedder: Dict[str, Any] = {"session": None, "tokenizer": None}


def get_embedder():
    if _embedder["session"] is not None:
        return _embedder["session"], _embedder["tokenizer"]

    import onnxruntime as ort
    from tokenizers import Tokenizer

    directory = embedding_model_dir()
    model_path = os.path.join(directory, "model.onnx")
    tokenizer_path = os.path.join(directory, "tokenizer.json")

    if not os.path.exists(model_path) or not os.path.exists(tokenizer_path):
        raise FileNotFoundError(
            "The local embedding model is not installed. Download it once from Settings > Models."
        )

    options = ort.SessionOptions()
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    options.intra_op_num_threads = max(1, (os.cpu_count() or 4) // 2)

    session = ort.InferenceSession(model_path, options, providers=["CPUExecutionProvider"])
    tokenizer = Tokenizer.from_file(tokenizer_path)
    tokenizer.enable_truncation(max_length=EMBEDDING_MAX_TOKENS)
    tokenizer.enable_padding(length=None)

    _embedder["session"] = session
    _embedder["tokenizer"] = tokenizer
    return session, tokenizer


def cmd_embed(request_id: Any, params: Dict[str, Any]) -> None:
    texts = params.get("texts") or []
    if not isinstance(texts, list) or len(texts) == 0:
        fail(request_id, "embed requires a non-empty 'texts' array.")
        return

    try:
        import numpy as np

        session, tokenizer = get_embedder()
    except Exception as exc:
        fail(request_id, str(exc), traceback.format_exc())
        return

    try:
        encoded = tokenizer.encode_batch([str(t) for t in texts])
        input_ids = np.array([e.ids for e in encoded], dtype=np.int64)
        attention_mask = np.array([e.attention_mask for e in encoded], dtype=np.int64)
        token_type_ids = np.zeros_like(input_ids)

        inputs = {
            "input_ids": input_ids,
            "attention_mask": attention_mask,
            "token_type_ids": token_type_ids,
        }
        # Tolerate exports that name their inputs differently.
        available = {i.name for i in session.get_inputs()}
        inputs = {k: v for k, v in inputs.items() if k in available}

        outputs = session.run(None, inputs)
        token_embeddings = outputs[0]

        # Mean pooling weighted by the attention mask, then L2 normalisation.
        mask = attention_mask[..., None].astype(np.float32)
        summed = (token_embeddings * mask).sum(axis=1)
        counts = np.clip(mask.sum(axis=1), 1e-9, None)
        pooled = summed / counts
        norms = np.clip(np.linalg.norm(pooled, axis=1, keepdims=True), 1e-9, None)
        normalised = pooled / norms

        ok(
            request_id,
            {
                "model": f"onnx:{EMBEDDING_MODEL_ID}",
                "dim": int(normalised.shape[1]),
                "vectors": normalised.tolist(),
            },
        )
    except Exception as exc:
        fail(request_id, f"Embedding failed: {exc}", traceback.format_exc())


def cmd_download_embedding_model(request_id: Any) -> None:
    """
    Explicitly downloads the ONNX MiniLM embedder (~90 MB). Like the Whisper
    download, this is user-initiated and never happens silently.
    """
    try:
        import urllib.request
    except Exception as exc:
        fail(request_id, f"urllib unavailable: {exc}")
        return

    directory = embedding_model_dir()
    try:
        for index, (filename, url) in enumerate(EMBEDDING_FILES.items()):
            destination = os.path.join(directory, filename)
            if os.path.exists(destination) and os.path.getsize(destination) > 0:
                continue
            send(
                {
                    "event": "progress",
                    "id": request_id,
                    "phase": "download",
                    "file": filename,
                    "fraction": index / len(EMBEDDING_FILES),
                }
            )
            temporary = destination + ".part"
            with urllib.request.urlopen(url, timeout=120) as response, open(temporary, "wb") as handle:
                while True:
                    chunk = response.read(1 << 20)
                    if not chunk:
                        break
                    handle.write(chunk)
            os.replace(temporary, destination)

        ok(
            request_id,
            {
                "downloaded": EMBEDDING_MODEL_ID,
                "directory": directory,
                "embeddings": detect_embeddings(),
            },
        )
    except Exception as exc:
        fail(request_id, f"Could not download the embedding model: {exc}", traceback.format_exc())


# --------------------------------------------------------------------------
# Diarization
# --------------------------------------------------------------------------


def cmd_diarize(request_id: Any, params: Dict[str, Any]) -> None:
    path = params.get("path")
    if not path or not os.path.exists(path):
        fail(request_id, f"Audio file not found: {path}")
        return

    status = detect_diarization()
    if not status["available"]:
        fail(request_id, "Diarization is not installed.", status.get("guidance"))
        return

    try:
        if status["engine"] == "pyannote":
            turns = _diarize_pyannote(path, params)
        else:
            turns = _diarize_speechbrain(path, params)
        ok(request_id, {"engine": status["engine"], "turns": turns})
    except Exception as exc:
        fail(request_id, f"Diarization failed: {exc}", traceback.format_exc())


def _diarize_pyannote(path: str, params: Dict[str, Any]) -> List[Dict[str, Any]]:
    """
    Uses the openly licensed community diarization pipeline. Note that
    Local Note deliberately does not depend on the gated pyannote models,
    which would require a Hugging Face account.
    """
    from pyannote.audio import Pipeline

    pipeline = Pipeline.from_pretrained("pyannote/speaker-diarization-community-1")

    kwargs: Dict[str, Any] = {}
    if params.get("numSpeakers"):
        kwargs["num_speakers"] = int(params["numSpeakers"])
    elif params.get("minSpeakers") or params.get("maxSpeakers"):
        if params.get("minSpeakers"):
            kwargs["min_speakers"] = int(params["minSpeakers"])
        if params.get("maxSpeakers"):
            kwargs["max_speakers"] = int(params["maxSpeakers"])

    annotation = pipeline(path, **kwargs)
    turns: List[Dict[str, Any]] = []
    for turn, _track, speaker in annotation.itertracks(yield_label=True):
        turns.append({"start": float(turn.start), "end": float(turn.end), "speaker": str(speaker)})
    return turns


def _diarize_speechbrain(path: str, params: Dict[str, Any]) -> List[Dict[str, Any]]:
    """
    Lightweight fallback: ECAPA-TDNN speaker embeddings over sliding windows,
    then agglomerative clustering. Runs happily on CPU.
    """
    import numpy as np
    import torch  # noqa: F401  (imported for speechbrain's backend)
    from speechbrain.inference.speaker import EncoderClassifier
    from sklearn.cluster import AgglomerativeClustering
    import wave

    with wave.open(path, "rb") as handle:
        sample_rate = handle.getframerate()
        frames = handle.readframes(handle.getnframes())
        channels = handle.getnchannels()
        audio = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
        if channels > 1:
            audio = audio.reshape(-1, channels).mean(axis=1)

    window_seconds = 1.5
    hop_seconds = 0.75
    window = int(window_seconds * sample_rate)
    hop = int(hop_seconds * sample_rate)

    if len(audio) < window:
        return [{"start": 0.0, "end": len(audio) / sample_rate, "speaker": "SPEAKER_00"}]

    classifier = EncoderClassifier.from_hparams(
        source="speechbrain/spkrec-ecapa-voxceleb",
        savedir=os.path.join(models_dir(), "embeddings", "ecapa"),
        run_opts={"device": "cpu"},
    )

    embeddings: List[Any] = []
    spans: List[tuple] = []
    for start in range(0, len(audio) - window + 1, hop):
        chunk = audio[start : start + window]
        # Skip near-silent windows: they would poison the clustering.
        if float(np.sqrt(np.mean(chunk**2))) < 0.004:
            continue
        tensor = torch.from_numpy(chunk).unsqueeze(0)
        with torch.no_grad():
            embedding = classifier.encode_batch(tensor).squeeze().cpu().numpy()
        embeddings.append(embedding)
        spans.append((start / sample_rate, (start + window) / sample_rate))

    if len(embeddings) < 3:
        return [
            {"start": start, "end": end, "speaker": "SPEAKER_00"} for start, end in spans
        ] or [{"start": 0.0, "end": len(audio) / sample_rate, "speaker": "SPEAKER_00"}]

    matrix = np.vstack(embeddings)
    norms = np.clip(np.linalg.norm(matrix, axis=1, keepdims=True), 1e-9, None)
    matrix = matrix / norms

    requested = params.get("numSpeakers")
    n_clusters = int(requested) if requested else _estimate_cluster_count(matrix)

    labels = AgglomerativeClustering(n_clusters=n_clusters, metric="cosine", linkage="average").fit_predict(
        matrix
    )

    turns: List[Dict[str, Any]] = []
    for (start, end), label in zip(spans, labels):
        speaker = f"SPEAKER_{int(label):02d}"
        # Merge consecutive windows from the same speaker.
        if turns and turns[-1]["speaker"] == speaker and turns[-1]["end"] >= start - 0.2:
            turns[-1]["end"] = end
        else:
            turns.append({"start": start, "end": end, "speaker": speaker})
    return turns


def _estimate_cluster_count(matrix) -> int:
    """
    Picks a speaker count without being told, by looking for the largest gap in
    the sorted cosine distances between consecutive windows.
    """
    import numpy as np
    from scipy.spatial.distance import pdist

    if len(matrix) < 4:
        return 1
    distances = np.sort(pdist(matrix, metric="cosine"))
    if len(distances) < 8:
        return 2
    # Compare the spread of the smallest and largest distances.
    low = float(np.median(distances[: len(distances) // 4]))
    high = float(np.median(distances[-len(distances) // 4 :]))
    if high - low < 0.08:
        return 1
    return int(np.clip(round(high / max(low, 1e-6)), 2, 5))


# --------------------------------------------------------------------------
# Main loop
# --------------------------------------------------------------------------

_COMMANDS = {
    "status": lambda rid, params: cmd_status(rid),
    "load": cmd_load,
    "transcribe": cmd_transcribe,
    "embed": cmd_embed,
    "diarize": cmd_diarize,
    "download-model": cmd_download_model,
    "download-embedding-model": lambda rid, params: cmd_download_embedding_model(rid),
}


def handle_line(line: str) -> bool:
    line = line.strip()
    if not line:
        return True

    try:
        request = json.loads(line)
    except json.JSONDecodeError as exc:
        send({"id": None, "ok": False, "error": f"Invalid JSON: {exc}"})
        return True

    request_id = request.get("id")
    command = request.get("cmd")

    if command == "shutdown":
        ok(request_id, {"bye": True})
        return False

    handler = _COMMANDS.get(command)
    if handler is None:
        fail(request_id, f"Unknown command '{command}'.")
        return True

    if command == "status":
        params: Dict[str, Any] = {}
    else:
        params = request

    try:
        handler(request_id, params)
    except Exception as exc:
        fail(request_id, f"{command} crashed: {exc}", traceback.format_exc())
    return True


def main() -> int:
    # --check gives the app a fast, single-shot capability probe.
    if "--check" in sys.argv:
        cmd_status("check")
        return 0

    dry_run = "--dry-run" in sys.argv

    log(
        "sidecar ready; python=%s faster_whisper=%s onnxruntime=%s"
        % (
            sys.version.split()[0],
            module_version("faster_whisper") or "absent",
            module_version("onnxruntime") or "absent",
        )
    )

    # Announce readiness so the parent does not need to poll.
    send({"event": "ready", "python": sys.version.split()[0], "executable": sys.executable})

    if dry_run:
        return 0

    for line in sys.stdin:
        try:
            if not handle_line(line):
                break
        except KeyboardInterrupt:
            break
    return 0


if __name__ == "__main__":
    sys.exit(main())
