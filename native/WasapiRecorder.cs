// Local Note — WASAPI loopback + microphone recorder
// ---------------------------------------------------------------------------
// Records "what is playing through the speakers" (the other person on a call)
// using WASAPI loopback capture, without joining the call as a bot and without
// installing a virtual audio cable. Optionally records the microphone in
// parallel, so "You" vs "Them" is known before any diarization runs.
//
// This file is intentionally dependency-free: it P/Invokes the Windows Core
// Audio APIs directly, so it compiles with the csc.exe compiler that ships with
// every Windows install (no NuGet, no .NET SDK, no Visual Studio).
//
// Output layout (16 kHz mono PCM16 WAV, ready for Whisper):
//   <out>/<session>/system/full.wav          full-session mixdown
//   <out>/<session>/system/chunks/chunk_NNNNN.wav
//   <out>/<session>/mic/full.wav             (only when mic enabled)
//   <out>/<session>/mic/chunks/chunk_NNNNN.wav
//
// stdout protocol: one JSON object per line.
//   {"type":"ready", ...} {"type":"chunk", ...} {"type":"level", ...}
//   {"type":"stopped", ...} {"type":"error", ...}
// stdin protocol: send "stop\n" for a graceful shutdown (patches WAV headers).
//
// Build: csc.exe /nologo /platform:x64 /target:exe /out:WasapiRecorder.exe WasapiRecorder.cs
// ---------------------------------------------------------------------------

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace LocalNote
{
    #region Core Audio interop

    internal enum EDataFlow { eRender = 0, eCapture = 1, eAll = 2 }
    internal enum ERole { eConsole = 0, eMultimedia = 1, eCommunications = 2 }

    [Flags]
    internal enum CLSCTX : uint { CLSCTX_ALL = 0x17 }

    internal enum AUDCLNT_SHAREMODE { SHARED = 0, EXCLUSIVE = 1 }

    internal enum STGM : uint { STGM_READ = 0 }

    [Flags]
    internal enum AUDCLNT_FLAGS : uint
    {
        LOOPBACK = 0x00020000,
        EVENTCALLBACK = 0x00040000,
        NOPERSIST = 0x00080000,
        SRC_DEFAULT_QUALITY = 0x08000000,
        AUTOCONVERTPCM = 0x80000000
    }

    [Flags]
    internal enum AUDCLNT_BUFFERFLAGS : uint
    {
        DATA_DISCONTINUITY = 0x1,
        SILENT = 0x2,
        TIMESTAMP_ERROR = 0x4
    }

    [StructLayout(LayoutKind.Sequential, Pack = 2)]
    internal struct WAVEFORMATEX
    {
        public ushort wFormatTag;
        public ushort nChannels;
        public uint nSamplesPerSec;
        public uint nAvgBytesPerSec;
        public ushort nBlockAlign;
        public ushort wBitsPerSample;
        public ushort cbSize;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 2)]
    internal struct WAVEFORMATEXTENSIBLE
    {
        public WAVEFORMATEX Format;
        public ushort wValidBitsPerSample;
        public uint dwChannelMask;
        public Guid SubFormat;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct PROPERTYKEY { public Guid fmtid; public uint pid; }

    [StructLayout(LayoutKind.Explicit)]
    internal struct PROPVARIANT
    {
        [FieldOffset(0)] public ushort vt;
        [FieldOffset(8)] public IntPtr pointerValue;
    }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDeviceEnumerator
    {
        int EnumAudioEndpoints(EDataFlow dataFlow, uint dwStateMask, out IntPtr devices);
        int GetDefaultAudioEndpoint(EDataFlow dataFlow, ERole role, out IMMDevice endpoint);
        int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
        int RegisterEndpointNotificationCallback(IntPtr client);
        int UnregisterEndpointNotificationCallback(IntPtr client);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDevice
    {
        int Activate(ref Guid iid, CLSCTX clsCtx, IntPtr activationParams,
                     [MarshalAs(UnmanagedType.IUnknown)] out object instance);
        int OpenPropertyStore(STGM stgmAccess, out IPropertyStore properties);
        int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        int GetState(out uint state);
    }

    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IPropertyStore
    {
        int GetCount(out uint propertyCount);
        int GetAt(uint propertyIndex, out PROPERTYKEY key);
        int GetValue(ref PROPERTYKEY key, out PROPVARIANT value);
        int SetValue(ref PROPERTYKEY key, ref PROPVARIANT value);
        int Commit();
    }

    [ComImport, Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioClient
    {
        int Initialize(AUDCLNT_SHAREMODE shareMode, AUDCLNT_FLAGS streamFlags,
                       long hnsBufferDuration, long hnsPeriodicity,
                       IntPtr format, IntPtr audioSessionGuid);
        int GetBufferSize(out uint bufferFrames);
        int GetStreamLatency(out long latency);
        int GetCurrentPadding(out uint paddingFrames);
        int IsFormatSupported(AUDCLNT_SHAREMODE shareMode, IntPtr format, out IntPtr closestMatch);
        int GetMixFormat(out IntPtr deviceFormat);
        int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
        int Start();
        int Stop();
        int Reset();
        int SetEventHandle(IntPtr eventHandle);
        int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
    }

    [ComImport, Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioCaptureClient
    {
        int GetBuffer(out IntPtr data, out uint numFrames, out AUDCLNT_BUFFERFLAGS flags,
                      out long devicePosition, out long qpcPosition);
        int ReleaseBuffer(uint numFramesRead);
        int GetNextPacketSize(out uint numFramesInNextPacket);
    }

    internal static class NativeMethods
    {
        [DllImport("ole32.dll")]
        public static extern int CoInitializeEx(IntPtr reserved, uint coInit);

        [DllImport("ole32.dll")]
        public static extern void CoUninitialize();

        [DllImport("ole32.dll")]
        public static extern int PropVariantClear(ref PROPVARIANT pvar);

        public const uint COINIT_MULTITHREADED = 0x0;
    }

    #endregion

    #region Resampling + WAV writing

    /// <summary>
    /// Converts arbitrary-rate, multi-channel float audio into 16 kHz mono
    /// PCM16. Downsampling averages over the decimation window (a box low-pass)
    /// which is sufficient anti-aliasing for speech recognition, and arbitrary
    /// ratios are handled by resampling at the fractional position.
    /// </summary>
    internal sealed class StreamProcessor
    {
        private readonly int _inRate;
        private readonly int _inChannels;
        private readonly int _outRate;
        private readonly double _ratio;

        private float[] _pending = new float[1 << 16];
        private int _pendingCount;
        private double _position;

        public StreamProcessor(int inRate, int inChannels, int outRate)
        {
            _inRate = inRate;
            _inChannels = inChannels;
            _outRate = outRate;
            _ratio = (double)inRate / outRate;
        }

        /// <summary>Push interleaved float samples; returns 16 kHz mono PCM16 frames.</summary>
        public short[] Process(float[] interleaved, int frames)
        {
            EnsureCapacity(_pendingCount + frames);
            for (int f = 0; f < frames; f++)
            {
                float sum = 0f;
                int baseIdx = f * _inChannels;
                for (int c = 0; c < _inChannels; c++) sum += interleaved[baseIdx + c];
                _pending[_pendingCount + f] = sum / _inChannels;
            }
            _pendingCount += frames;

            // Downsampling averages the input window (a box low-pass, which is
            // enough anti-aliasing for speech). Upsampling interpolates between
            // neighbouring samples. Either way the fractional read position is
            // preserved so the output keeps a constant rate.
            int window = Math.Max(1, (int)Math.Floor(_ratio));
            bool downsampling = _ratio >= 1.0;
            var scratch = new List<short>(_pendingCount * _outRate / Math.Max(1, _inRate) + 8);

            while (true)
            {
                int start = (int)_position;
                int end = start + window;
                if (end > _pendingCount - 1) break;

                float value;
                if (downsampling)
                {
                    double acc = 0;
                    for (int i = start; i < end; i++) acc += _pending[i];
                    value = (float)(acc / (end - start));
                }
                else
                {
                    double frac = _position - start;
                    value = (float)(_pending[start] * (1 - frac) + _pending[start + 1] * frac);
                }

                if (value > 1f) value = 1f;
                if (value < -1f) value = -1f;
                scratch.Add((short)Math.Round(value * 32767.0));
                _position += _ratio;
            }

            int consumed = (int)_position;
            if (consumed > 0)
            {
                _pendingCount -= consumed;
                if (_pendingCount > 0)
                    Array.Copy(_pending, consumed, _pending, 0, _pendingCount);
                _position -= consumed;
            }

            if (scratch.Count == 0) return EmptyShorts;
            return scratch.ToArray();
        }

        private static readonly short[] EmptyShorts = new short[0];

        private void EnsureCapacity(int needed)
        {
            if (needed <= _pending.Length) return;
            int size = _pending.Length;
            while (size < needed) size *= 2;
            Array.Resize(ref _pending, size);
        }
    }

    /// <summary>Writes 16-bit mono WAV. Header sizes are patched on close.</summary>
    internal sealed class WavWriter : IDisposable
    {
        private readonly FileStream _stream;
        private readonly BinaryWriter _writer;
        private readonly string _path;
        private readonly int _sampleRate;
        private long _dataBytes;
        private bool _closed;

        public string Path { get { return _path; } }
        public int SampleRate { get { return _sampleRate; } }

        public WavWriter(string path, int sampleRate)
        {
            _path = path;
            _sampleRate = sampleRate;
            Directory.CreateDirectory(System.IO.Path.GetDirectoryName(path));
            _stream = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.Read, 1 << 16);
            _writer = new BinaryWriter(_stream);
            WriteHeader(0);
        }

        private void WriteHeader(int dataBytes)
        {
            _stream.Position = 0;
            _writer.Write(Encoding.ASCII.GetBytes("RIFF"));
            _writer.Write(36 + dataBytes);
            _writer.Write(Encoding.ASCII.GetBytes("WAVE"));
            _writer.Write(Encoding.ASCII.GetBytes("fmt "));
            _writer.Write(16);
            _writer.Write((short)1);
            _writer.Write((short)1);
            _writer.Write(SampleRate);
            _writer.Write(SampleRate * 2);
            _writer.Write((short)2);
            _writer.Write((short)16);
            _writer.Write(Encoding.ASCII.GetBytes("data"));
            _writer.Write(dataBytes);
        }

        public void Write(short[] samples, int count)
        {
            if (count <= 0) return;
            var bytes = new byte[count * 2];
            Buffer.BlockCopy(samples, 0, bytes, 0, count * 2);
            _stream.Write(bytes, 0, bytes.Length);
            _dataBytes += bytes.Length;
        }

        public void WriteSilence(int frames)
        {
            if (frames <= 0) return;
            var bytes = new byte[frames * 2];
            _stream.Write(bytes, 0, bytes.Length);
            _dataBytes += bytes.Length;
        }

        public void Dispose()
        {
            if (_closed) return;
            _closed = true;
            try
            {
                WriteHeader((int)Math.Min(_dataBytes, int.MaxValue));
                _writer.Flush();
                _stream.Flush();
            }
            catch { /* best effort on shutdown */ }
            try { _writer.Dispose(); } catch { }
            try { _stream.Dispose(); } catch { }
        }

        public int FrameCount { get { return (int)(_dataBytes / 2); } }
    }

    #endregion

    /// <summary>One capture endpoint (either system loopback or a microphone).</summary>
    internal sealed class CaptureStream
    {
        private readonly string _name;
        private readonly EDataFlow _flow;
        private readonly bool _loopback;
        private readonly string _deviceId;
        private readonly string _directory;
        private readonly int _outRate;
        private readonly int _chunkFrames;

        private volatile bool _stop;
        private Thread _thread;
        private WavWriter _full;
        private volatile string _deviceName = "unknown";
        private volatile Exception _failure;

        // Diagnostics surfaced to the UI as a heartbeat, so a dead or stalled
        // stream is visible instead of failing silently.
        private long _packets;
        private long _padFrames;
        private long _realFrames;
        private double _recentRms;
        private long _lastBeatMs;
        private int _lastHr;
        private int _formatRate;

        public string Name { get { return _name; } }
        public string DeviceName { get { return _deviceName; } }
        public Exception Failure { get { return _failure; } }

        /// <summary>Raised for every completed chunk, on the capture thread.</summary>
        public event Action<ChunkInfo> ChunkReady;

        public CaptureStream(string name, EDataFlow flow, bool loopback, string deviceId,
                             string directory, int outRate, int chunkMs)
        {
            _name = name;
            _flow = flow;
            _loopback = loopback;
            _deviceId = deviceId;
            _directory = directory;
            _outRate = outRate;
            _chunkFrames = Math.Max(1, outRate * chunkMs / 1000);
        }

        public void Start()
        {
            _thread = new Thread(Run) { IsBackground = true, Name = "capture-" + _name };
            _thread.Start();
        }

        public void Stop() { _stop = true; }

        public void Join(int ms) { if (_thread != null) _thread.Join(ms); }

        private IAudioClient ActivateClient(out IAudioCaptureClient capture, out IntPtr mixFormatPtr)
        {
            capture = null;
            mixFormatPtr = IntPtr.Zero;

            var enumeratorType = Type.GetTypeFromCLSID(new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E"));
            var enumerator = (IMMDeviceEnumerator)Activator.CreateInstance(enumeratorType);

            IMMDevice device;
            if (!string.IsNullOrEmpty(_deviceId))
            {
                int hrGet = enumerator.GetDevice(_deviceId, out device);
                if (hrGet != 0 || device == null) throw new InvalidOperationException("device not found: " + _deviceId);
            }
            else
            {
                int hr = enumerator.GetDefaultAudioEndpoint(_flow, ERole.eMultimedia, out device);
                if (hr != 0 || device == null) throw new InvalidOperationException("no default endpoint for " + _name);
            }

            // Friendly name is nice for the UI but never fatal.
            try
            {
                string endpointId;
                if (device.GetId(out endpointId) == 0 && !string.IsNullOrEmpty(endpointId))
                {
                    string friendly = DeviceEnumerator.FriendlyName(endpointId);
                    if (!string.IsNullOrEmpty(friendly)) _deviceName = friendly;
                }
            }
            catch { }

            var iid = typeof(IAudioClient).GUID;
            object clientObj;
            int hrActivate = device.Activate(ref iid, CLSCTX.CLSCTX_ALL, IntPtr.Zero, out clientObj);
            if (hrActivate != 0) throw new InvalidOperationException("Activate failed 0x" + hrActivate.ToString("X8"));
            var client = (IAudioClient)clientObj;

            int hrFormat = client.GetMixFormat(out mixFormatPtr);
            if (hrFormat != 0) throw new InvalidOperationException("GetMixFormat failed 0x" + hrFormat.ToString("X8"));

            var flags = AUDCLNT_FLAGS.NOPERSIST;
            if (_loopback) flags |= AUDCLNT_FLAGS.LOOPBACK;

            // Polling mode (no event callback) is the most portable option for
            // loopback capture across drivers.
            int hrInit = client.Initialize(AUDCLNT_SHAREMODE.SHARED, flags, 0, 0, mixFormatPtr, IntPtr.Zero);
            if (hrInit != 0) throw new InvalidOperationException("Initialize failed 0x" + hrInit.ToString("X8"));

            var captureIid = typeof(IAudioCaptureClient).GUID;
            object captureObj;
            int hrService = client.GetService(ref captureIid, out captureObj);
            if (hrService != 0) throw new InvalidOperationException("GetService failed 0x" + hrService.ToString("X8"));
            capture = (IAudioCaptureClient)captureObj;

            return client;
        }

        private void Run()
        {
            NativeMethods.CoInitializeEx(IntPtr.Zero, NativeMethods.COINIT_MULTITHREADED);
            try
            {
                IAudioCaptureClient capture;
                IntPtr mixFormatPtr;
                var client = ActivateClient(out capture, out mixFormatPtr);

                var format = (WAVEFORMATEX)Marshal.PtrToStructure(mixFormatPtr, typeof(WAVEFORMATEX));
                ushort tag = format.wFormatTag;
                ushort bits = format.wBitsPerSample;
                Guid subFormat = Guid.Empty;
                if (tag == 0xFFFE)
                {
                    var ext = (WAVEFORMATEXTENSIBLE)Marshal.PtrToStructure(mixFormatPtr, typeof(WAVEFORMATEXTENSIBLE));
                    subFormat = ext.SubFormat;
                }
                bool isFloat = tag == 3 || subFormat == new Guid("00000003-0000-0010-8000-00AA00389B71");
                bool isPcm = tag == 1 || subFormat == new Guid("00000001-0000-0010-8000-00AA00389B71");

                var processor = new StreamProcessor((int)format.nSamplesPerSec, format.nChannels, _outRate);
                _formatRate = (int)format.nSamplesPerSec;

                string fullPath = System.IO.Path.Combine(_directory, "full.wav");
                string chunkDir = System.IO.Path.Combine(_directory, "chunks");
                Directory.CreateDirectory(chunkDir);
                _full = new WavWriter(fullPath, _outRate);

                var chunkBuffer = new short[_chunkFrames + _outRate];
                int chunkFill = 0;
                int chunkIndex = 0;
                long totalFrames = 0;

                client.Start();
                var clock = System.Diagnostics.Stopwatch.StartNew();

                var accum = new List<float>(1 << 16);
                int bytesPerFrame = format.nBlockAlign;

                while (!_stop)
                {
                    uint packetFrames;
                    int hrNext = capture.GetNextPacketSize(out packetFrames);
                    _lastHr = hrNext;
                    if (hrNext != 0)
                    {
                        Recorder.Emit(new Dictionary<string, object>
                        {
                            { "type", "warning" },
                            { "stream", _name },
                            { "message", "GetNextPacketSize failed 0x" + hrNext.ToString("X8") + "; stopping this stream" }
                        });
                        break;
                    }

                    if (packetFrames == 0)
                    {
                        // Nothing captured yet. For loopback this is normal when
                        // the output device is silent; pad the timeline so the
                        // mic and system streams stay time-aligned.
                        Thread.Sleep(10);
                        long before = totalFrames;
                        PadToClock(clock, chunkBuffer, ref chunkFill, ref chunkIndex, ref totalFrames);
                        _padFrames += totalFrames - before;
                        Beat(clock, ref _lastBeatMs, totalFrames);
                        continue;
                    }

                    IntPtr dataPtr;
                    uint frames;
                    AUDCLNT_BUFFERFLAGS packetFlags;
                    long devicePos, qpcPos;
                    int hrBuf = capture.GetBuffer(out dataPtr, out frames, out packetFlags, out devicePos, out qpcPos);
                    if (hrBuf != 0) break;
                    _packets++;

                    int sampleCount = (int)frames * format.nChannels;
                    accum.Clear();
                    bool silent = (packetFlags & AUDCLNT_BUFFERFLAGS.SILENT) != 0 || dataPtr == IntPtr.Zero;
                    if (silent)
                    {
                        for (int i = 0; i < sampleCount; i++) accum.Add(0f);
                    }
                    else if (isFloat && bits == 32)
                    {
                        var raw = new float[sampleCount];
                        Marshal.Copy(dataPtr, raw, 0, sampleCount);
                        accum.AddRange(raw);
                    }
                    else if (isPcm && bits == 16)
                    {
                        var raw = new short[sampleCount];
                        Marshal.Copy(dataPtr, raw, 0, sampleCount);
                        for (int i = 0; i < sampleCount; i++) accum.Add(raw[i] / 32768f);
                    }
                    else if (isPcm && bits == 32)
                    {
                        var raw = new int[sampleCount];
                        Marshal.Copy(dataPtr, raw, 0, sampleCount);
                        for (int i = 0; i < sampleCount; i++) accum.Add((float)(raw[i] / 2147483648.0));
                    }
                    else
                    {
                        // Unknown layout: treat as silence rather than crash.
                        for (int i = 0; i < sampleCount; i++) accum.Add(0f);
                    }

                    capture.ReleaseBuffer(frames);
                    _realFrames += frames;

                    PadToClock(clock, chunkBuffer, ref chunkFill, ref chunkIndex, ref totalFrames);

                    var mono = processor.Process(accum.ToArray(), (int)frames);
                    if (!silent) _recentRms = ComputeRms(mono, mono.Length);
                    AppendMono(mono, mono.Length, chunkBuffer, ref chunkFill, ref chunkIndex, ref totalFrames);
                    Beat(clock, ref _lastBeatMs, totalFrames);
                }

                // Flush whatever is left so the last seconds are not lost.
                if (chunkFill > 0 && _full != null)
                {
                    EmitChunk(chunkBuffer, chunkFill, chunkIndex++, totalFrames);
                    chunkFill = 0;
                }

                try { client.Stop(); } catch { }
            }
            catch (Exception ex)
            {
                _failure = ex;
                Recorder.ReportError(_name, ex);
            }
            finally
            {
                if (_full != null) _full.Dispose();
                NativeMethods.CoUninitialize();
            }
        }

        /// <summary>
        /// Emits a periodic heartbeat so the UI can show a live level meter and
        /// so a stalled stream (no packets, or all padding) is diagnosable
        /// rather than silently producing an empty recording.
        /// </summary>
        private void Beat(System.Diagnostics.Stopwatch clock, ref long lastBeatMs, long totalFrames)
        {
            long now = clock.ElapsedMilliseconds;
            if (now - lastBeatMs < 2000) return;
            lastBeatMs = now;
            Recorder.Emit(new Dictionary<string, object>
            {
                { "type", "level" },
                { "stream", _name },
                { "ms", now },
                { "capturedMs", totalFrames * 1000L / _outRate },
                { "packets", _packets },
                { "realMs", _realFrames * 1000L / _formatRate },
                { "paddedMs", _padFrames * 1000L / _outRate },
                { "rms", Math.Round(_recentRms, 5) },
                { "hr", _lastHr }
            });
        }

        private static double ComputeRms(short[] samples, int count)
        {
            if (count <= 0) return 0;
            double sum = 0;
            for (int i = 0; i < count; i++)
            {
                double v = samples[i] / 32768.0;
                sum += v * v;
            }
            return Math.Sqrt(sum / count);
        }

        /// <summary>
        /// Keeps the captured timeline in step with wall-clock time. Loopback
        /// capture delivers nothing while the speakers are silent, which would
        /// otherwise make the system stream drift behind the mic stream and
        /// break speaker/timestamp alignment.
        /// </summary>
        private void PadToClock(System.Diagnostics.Stopwatch clock, short[] chunkBuffer,
                                ref int chunkFill, ref int chunkIndex, ref long totalFrames)
        {
            long expected = clock.ElapsedMilliseconds * _outRate / 1000;
            long deficit = expected - totalFrames;
            // Only correct meaningful gaps; ignore normal packet jitter.
            if (deficit < _outRate / 4) return;
            if (deficit > _outRate * 30) deficit = _outRate * 30;

            int remaining = (int)deficit;
            while (remaining > 0)
            {
                int space = chunkBuffer.Length - chunkFill;
                int take = Math.Min(space, remaining);
                Array.Clear(chunkBuffer, chunkFill, take);
                chunkFill += take;
                totalFrames += take;
                remaining -= take;
                if (chunkFill >= _chunkFrames)
                {
                    EmitChunk(chunkBuffer, chunkFill, chunkIndex++, totalFrames);
                    chunkFill = 0;
                }
            }
        }

        private void AppendMono(short[] mono, int count, short[] chunkBuffer,
                                ref int chunkFill, ref int chunkIndex, ref long totalFrames)
        {
            int offset = 0;
            while (offset < count)
            {
                int space = chunkBuffer.Length - chunkFill;
                int take = Math.Min(space, count - offset);
                Array.Copy(mono, offset, chunkBuffer, chunkFill, take);
                chunkFill += take;
                offset += take;
                totalFrames += take;
                if (chunkFill >= _chunkFrames)
                {
                    EmitChunk(chunkBuffer, chunkFill, chunkIndex++, totalFrames);
                    chunkFill = 0;
                }
            }
        }

        private void EmitChunk(short[] buffer, int count, int index, long totalFrames)
        {
            // Write to a temp name then rename, so the consumer can never read a
            // half-written chunk.
            string finalPath = System.IO.Path.Combine(_directory, "chunks",
                "chunk_" + index.ToString("D5", CultureInfo.InvariantCulture) + ".wav");
            string tempPath = finalPath + ".tmp";

            double sumSquares = 0;
            for (int i = 0; i < count; i++)
            {
                double v = buffer[i] / 32768.0;
                sumSquares += v * v;
            }
            double rms = count > 0 ? Math.Sqrt(sumSquares / count) : 0;

            using (var w = new WavWriter(tempPath, _outRate))
            {
                w.Write(buffer, count);
            }
            if (File.Exists(finalPath)) File.Delete(finalPath);
            File.Move(tempPath, finalPath);

            if (_full != null) _full.Write(buffer, count);

            var handler = ChunkReady;
            if (handler != null)
                handler(new ChunkInfo
                {
                    Stream = _name,
                    Index = index,
                    Path = finalPath,
                    Frames = count,
                    SampleRate = _outRate,
                    Rms = rms,
                    StartMs = (totalFrames - count) * 1000L / _outRate
                });
        }
    }

    internal sealed class ChunkInfo
    {
        public string Stream;
        public int Index;
        public string Path;
        public int Frames;
        public int SampleRate;
        public double Rms;
        public long StartMs;
    }

    internal static class Recorder
    {
        private static readonly object OutLock = new object();

        public static void Emit(object payload)
        {
            string json = Json.Serialize(payload);
            lock (OutLock)
            {
                Console.Out.Write(json);
                Console.Out.Write('\n');
                Console.Out.Flush();
            }
        }

        public static void ReportError(string stream, Exception ex)
        {
            Emit(new Dictionary<string, object>
            {
                { "type", "error" },
                { "stream", stream },
                { "message", ex.Message },
                { "detail", ex.ToString() }
            });
        }
    }

    /// <summary>Minimal JSON writer so the recorder needs no external packages.</summary>
    internal static class Json
    {
        public static string Serialize(object value)
        {
            var sb = new StringBuilder();
            Write(sb, value);
            return sb.ToString();
        }

        private static void Write(StringBuilder sb, object value)
        {
            if (value == null) { sb.Append("null"); return; }

            var dict = value as IDictionary<string, object>;
            if (dict != null)
            {
                sb.Append('{');
                bool first = true;
                foreach (var kv in dict)
                {
                    if (!first) sb.Append(',');
                    first = false;
                    WriteString(sb, kv.Key);
                    sb.Append(':');
                    Write(sb, kv.Value);
                }
                sb.Append('}');
                return;
            }

            var list = value as System.Collections.IEnumerable;
            if (list != null && !(value is string))
            {
                sb.Append('[');
                bool first = true;
                foreach (var item in list)
                {
                    if (!first) sb.Append(',');
                    first = false;
                    Write(sb, item);
                }
                sb.Append(']');
                return;
            }

            if (value is string) { WriteString(sb, (string)value); return; }
            if (value is bool) { sb.Append(((bool)value) ? "true" : "false"); return; }

            if (value is double || value is float)
            {
                double d = Convert.ToDouble(value, CultureInfo.InvariantCulture);
                if (double.IsNaN(d) || double.IsInfinity(d)) { sb.Append("0"); return; }
                sb.Append(d.ToString("R", CultureInfo.InvariantCulture));
                return;
            }

            if (value is IFormattable)
            {
                sb.Append(((IFormattable)value).ToString(null, CultureInfo.InvariantCulture));
                return;
            }

            WriteString(sb, value.ToString());
        }

        private static void WriteString(StringBuilder sb, string s)
        {
            sb.Append('"');
            foreach (char c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
                        else sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
        }
    }

    internal static class Program
    {
        private static int Main(string[] args)
        {
            var options = Options.Parse(args);

            if (options.ShowHelp)
            {
                Console.WriteLine(Options.HelpText);
                return 0;
            }

            if (options.ListDevices)
            {
                DeviceEnumerator.List();
                return 0;
            }

            if (string.IsNullOrEmpty(options.OutDir))
            {
                Recorder.Emit(new Dictionary<string, object>
                {
                    { "type", "error" }, { "message", "--out is required" }
                });
                return 2;
            }

            var streams = new List<CaptureStream>();
            var sessionDir = System.IO.Path.Combine(options.OutDir, options.SessionId);
            Directory.CreateDirectory(sessionDir);

            streams.Add(new CaptureStream("system", EDataFlow.eRender, true, options.SystemDevice,
                System.IO.Path.Combine(sessionDir, "system"), options.SampleRate, options.ChunkMs));

            if (options.CaptureMic)
            {
                streams.Add(new CaptureStream("mic", EDataFlow.eCapture, false, options.MicDevice,
                    System.IO.Path.Combine(sessionDir, "mic"), options.SampleRate, options.ChunkMs));
            }

            bool stopping = false;
            foreach (var s in streams)
            {
                var captured = s;
                captured.ChunkReady += info => Recorder.Emit(new Dictionary<string, object>
                {
                    { "type", "chunk" },
                    { "stream", info.Stream },
                    { "index", info.Index },
                    { "path", info.Path },
                    { "frames", info.Frames },
                    { "sampleRate", info.SampleRate },
                    { "rms", Math.Round(info.Rms, 6) },
                    { "startMs", info.StartMs }
                });
            }

            // Graceful stop on stdin so the final WAV headers get patched.
            var stdinThread = new Thread(() =>
            {
                try
                {
                    string line;
                    while ((line = Console.In.ReadLine()) != null)
                    {
                        if (line.Trim().Equals("stop", StringComparison.OrdinalIgnoreCase))
                        {
                            stopping = true;
                            foreach (var s in streams) s.Stop();
                            break;
                        }
                    }
                }
                catch { }
            }) { IsBackground = true };
            stdinThread.Start();

            foreach (var s in streams) s.Start();

            Recorder.Emit(new Dictionary<string, object>
            {
                { "type", "ready" },
                { "session", options.SessionId },
                { "dir", sessionDir },
                { "sampleRate", options.SampleRate },
                { "chunkMs", options.ChunkMs },
                { "streams", streams.ConvertAll(s => (object)new Dictionary<string, object>
                    {
                        { "name", s.Name },
                        { "device", s.DeviceName }
                    }) }
            });

            // Wait for a stop signal, or until a stream dies unexpectedly.
            while (!stopping)
            {
                foreach (var s in streams)
                {
                    if (s.Failure != null)
                    {
                        stopping = true;
                        break;
                    }
                }
                Thread.Sleep(100);
            }

            foreach (var s in streams) s.Stop();
            foreach (var s in streams) s.Join(4000);

            Recorder.Emit(new Dictionary<string, object>
            {
                { "type", "stopped" },
                { "session", options.SessionId },
                { "dir", sessionDir }
            });
            return 0;
        }
    }

    internal sealed class Options
    {
        public string OutDir;
        public string SessionId = "session";
        public string SystemDevice;
        public string MicDevice;
        public bool CaptureMic = true;
        public int SampleRate = 16000;
        public int ChunkMs = 5000;
        public bool ListDevices;
        public bool ShowHelp;

        public const string HelpText =
@"Local Note WASAPI recorder

  --out <dir>            output directory (required)
  --session <id>         session folder name (default: session)
  --system-device <id>   render endpoint id for loopback (default: system default)
  --mic-device <id>      capture endpoint id (default: system default)
  --no-mic               disable microphone capture
  --sample-rate <hz>     output sample rate (default: 16000)
  --chunk-ms <ms>        live chunk length (default: 5000)
  --list-devices         print available endpoints as JSON and exit
  --help                 show this help";

        public static Options Parse(string[] args)
        {
            var o = new Options();
            for (int i = 0; i < args.Length; i++)
            {
                string a = args[i];
                switch (a)
                {
                    case "--out": o.OutDir = Next(args, ref i); break;
                    case "--session": o.SessionId = Next(args, ref i); break;
                    case "--system-device": o.SystemDevice = Next(args, ref i); break;
                    case "--mic-device": o.MicDevice = Next(args, ref i); break;
                    case "--no-mic": o.CaptureMic = false; break;
                    case "--sample-rate": o.SampleRate = int.Parse(Next(args, ref i), CultureInfo.InvariantCulture); break;
                    case "--chunk-ms": o.ChunkMs = int.Parse(Next(args, ref i), CultureInfo.InvariantCulture); break;
                    case "--list-devices": o.ListDevices = true; break;
                    case "--help": case "-h": o.ShowHelp = true; break;
                }
            }
            return o;
        }

        private static string Next(string[] args, ref int i)
        {
            if (i + 1 >= args.Length) return null;
            return args[++i];
        }
    }

    internal static class DeviceEnumerator
    {
        /// <summary>
        /// Resolves a human-readable endpoint name from the MMDevices registry
        /// store. This is more reliable than marshalling the COM property store
        /// and keeps the UI honest about which device is being recorded.
        /// </summary>
        public static string FriendlyName(string endpointId)
        {
            if (string.IsNullOrEmpty(endpointId)) return null;
            int open = endpointId.LastIndexOf('{');
            int close = endpointId.LastIndexOf('}');
            if (open < 0 || close <= open) return null;
            string guid = endpointId.Substring(open + 1, close - open - 1);

            string[] flows = new string[] { "Render", "Capture" };
            // Preference order: the full endpoint friendly name (e.g.
            // "Speakers (Realtek(R) Audio)"), then the hardware product name,
            // then the generic endpoint description. Bluetooth endpoints often
            // leave the first one empty, so a chain is required for a label the
            // user will actually recognise.
            string[] valueNames = new string[]
            {
                "{a45c254e-df1c-4efd-8020-67d146a850e0},14",
                "{b3f8fa53-0004-438e-9003-51a46e139bfc},6",
                "{a45c254e-df1c-4efd-8020-67d146a850e0},2",
                "{026e516e-b814-414b-83cd-856d6fef4822},2"
            };

            foreach (string flow in flows)
            {
                try
                {
                    string path = @"SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\"
                        + flow + @"\{" + guid + @"}\Properties";
                    using (var key = Microsoft.Win32.Registry.LocalMachine.OpenSubKey(path))
                    {
                        if (key == null) continue;
                        foreach (string valueName in valueNames)
                        {
                            string name = key.GetValue(valueName) as string;
                            if (!string.IsNullOrEmpty(name)) return name;
                        }
                    }
                }
                catch { }
            }
            return null;
        }

        public static void List()
        {
            NativeMethods.CoInitializeEx(IntPtr.Zero, NativeMethods.COINIT_MULTITHREADED);
            var results = new List<object>();
            try
            {
                var type = Type.GetTypeFromCLSID(new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E"));
                var enumerator = (IMMDeviceEnumerator)Activator.CreateInstance(type);

                object loopbackDefault = null;
                try
                {
                    IMMDevice d;
                    if (enumerator.GetDefaultAudioEndpoint(EDataFlow.eRender, ERole.eMultimedia, out d) == 0 && d != null)
                    {
                        string id;
                        d.GetId(out id);
                        loopbackDefault = id;
                    }
                }
                catch { }

                object micDefault = null;
                try
                {
                    IMMDevice d;
                    if (enumerator.GetDefaultAudioEndpoint(EDataFlow.eCapture, ERole.eMultimedia, out d) == 0 && d != null)
                    {
                        string id;
                        d.GetId(out id);
                        micDefault = id;
                    }
                }
                catch { }

                Recorder.Emit(new Dictionary<string, object>
                {
                    { "type", "devices" },
                    { "system", loopbackDefault },
                    { "systemName", loopbackDefault == null ? null : FriendlyName((string)loopbackDefault) },
                    { "mic", micDefault },
                    { "micName", micDefault == null ? null : FriendlyName((string)micDefault) }
                });
            }
            catch (Exception ex)
            {
                Recorder.Emit(new Dictionary<string, object>
                {
                    { "type", "error" }, { "message", ex.Message }
                });
            }
            finally
            {
                NativeMethods.CoUninitialize();
            }
        }
    }
}
