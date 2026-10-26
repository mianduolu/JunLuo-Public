package com.anonymous.junluo

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.AutomaticGainControl
import android.media.audiofx.NoiseSuppressor
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.abs
import kotlin.math.sqrt


class JunLuoVoiceAudioModule(
    reactContext: ReactApplicationContext
) : ReactContextBaseJavaModule(reactContext) {

    companion object {
        private const val EVENT_SERVER_MESSAGE = "junluoVoiceAudioMessage"
        private const val SAMPLE_RATE = 16000
        private const val FRAME_BYTES = 640
        private const val AUDIO_BATCH_FRAMES = 5
        private const val AUDIO_BATCH_BYTES = FRAME_BYTES * AUDIO_BATCH_FRAMES
        private const val EMPTY_READ_RETRY_MS = 20L
        private const val MAX_EMPTY_READS = 50
        private const val TRANSPORT_DIAGNOSTIC_INTERVAL_FRAMES = 250L
        private const val CHANNEL = AudioFormat.CHANNEL_IN_MONO
        private const val ENCODING = AudioFormat.ENCODING_PCM_16BIT
    }

    private val recording = AtomicBoolean(false)
    private val startSettled = AtomicBoolean(true)
    private val stateLock = Any()
    private val droppedFrames = AtomicInteger(0)
    private val transport = JunLuoVoiceAudioTransport()
    private var startSequence = 0L
    @Volatile private var captureSequence = 0L
    @Volatile private var currentSource = "unknown"
    @Volatile private var pendingStartPromise: Promise? = null
    @Volatile private var recorder: AudioRecord? = null
    @Volatile private var recordingThread: Thread? = null
    private var echoCanceler: AcousticEchoCanceler? = null
    private var noiseSuppressor: NoiseSuppressor? = null
    private var automaticGainControl: AutomaticGainControl? = null
    private val networkStateLock = Any()
    private var previousBoundNetwork: Network? = null
    private var boundWifiNetwork: Network? = null
    private var wifiNetworkBound = false

    override fun getName(): String = "JunLuoVoiceAudio"

    @ReactMethod
    fun start(streamUrl: String, promise: Promise) {
        synchronized(stateLock) {
            if (recording.get()) {
                promise.resolve(startResult(currentSource))
                return
            }
            if (!startSettled.get()) {
                promise.reject("AUDIO_STREAM_BUSY", "Native microphone WebSocket is already connecting")
                return
            }
            if (
                ContextCompat.checkSelfPermission(
                    reactApplicationContext,
                    Manifest.permission.RECORD_AUDIO
                ) != PackageManager.PERMISSION_GRANTED
            ) {
                promise.reject("NO_MIC_PERMISSION", "RECORD_AUDIO permission is not granted")
                return
            }
            pendingStartPromise = promise
            startSettled.set(false)
            val attempt = ++startSequence
            // Publish this start and connect before stop or another start can claim the bridge.
            try {
                transport.connect(
                    streamUrl,
                    onReady = { startRecorderAfterTransportReady(attempt) },
                    onMessage = { message ->
                        synchronized(stateLock) {
                            if (startSequence == attempt) emitServerMessage(message)
                        }
                    },
                    onFailure = { message -> handleTransportFailure(attempt, message) }
                )
            } catch (error: Exception) {
                startSequence += 1
                rejectPendingStart("AUDIO_STREAM_CONNECT_FAILED", error.message ?: "Invalid audio stream URL")
                transport.close()
            }
        }
    }

    @ReactMethod
    fun stop(promise: Promise) {
        stopInternal()
        promise.resolve(true)
    }

    @ReactMethod
    fun sendText(payload: String, promise: Promise) {
        promise.resolve(transport.sendText(payload))
    }

    @ReactMethod
    fun isRecording(promise: Promise) {
        promise.resolve(recording.get())
    }

    @ReactMethod
    fun bindToWifiNetwork(promise: Promise) {
        synchronized(networkStateLock) {
            val connectivityManager = connectivityManager()
            if (wifiNetworkBound) {
                promise.resolve(networkBindingResult(connectivityManager, boundWifiNetwork, true))
                return
            }

            val wifiNetwork = connectivityManager.allNetworks.firstOrNull { network ->
                val capabilities = connectivityManager.getNetworkCapabilities(network)
                capabilities?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true &&
                    capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN).not() &&
                    capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            }
            if (wifiNetwork == null) {
                promise.reject("VOICE_CALL_WIFI_UNAVAILABLE", "No non-VPN Wi-Fi network is available")
                return
            }

            val previousNetwork = connectivityManager.boundNetworkForProcess
            val bound = runCatching {
                connectivityManager.bindProcessToNetwork(wifiNetwork)
            }.getOrDefault(false)
            if (!bound) {
                promise.reject("VOICE_CALL_WIFI_BIND_FAILED", "Could not bind the voice call to Wi-Fi")
                return
            }

            previousBoundNetwork = previousNetwork
            boundWifiNetwork = wifiNetwork
            wifiNetworkBound = true
            promise.resolve(networkBindingResult(connectivityManager, wifiNetwork, true))
        }
    }

    @ReactMethod
    fun clearWifiNetworkBinding(promise: Promise) {
        if (clearWifiNetworkBindingInternal()) {
            promise.resolve(true)
        } else {
            promise.reject("VOICE_CALL_WIFI_UNBIND_FAILED", "Could not restore the previous app network")
        }
    }

    @ReactMethod
    fun addListener(eventName: String) {
        // Required by NativeEventEmitter.
    }

    @ReactMethod
    fun removeListeners(count: Int) {
        // Required by NativeEventEmitter.
    }

    override fun invalidate() {
        stopInternal()
        clearWifiNetworkBindingInternal()
        super.invalidate()
    }

    private fun connectivityManager(): ConnectivityManager {
        return reactApplicationContext.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    }

    private fun networkBindingResult(
        connectivityManager: ConnectivityManager,
        network: Network?,
        bound: Boolean
    ) = Arguments.createMap().apply {
        val capabilities = network?.let { connectivityManager.getNetworkCapabilities(it) }
        putBoolean("bound", bound)
        putBoolean(
            "validated",
            capabilities?.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) == true
        )
        putDouble("networkHandle", network?.networkHandle?.toDouble() ?: 0.0)
    }

    private fun clearWifiNetworkBindingInternal(): Boolean {
        synchronized(networkStateLock) {
            if (!wifiNetworkBound) return true
            val restored = runCatching {
                connectivityManager().bindProcessToNetwork(previousBoundNetwork)
            }.getOrDefault(false)
            if (restored) {
                previousBoundNetwork = null
                boundWifiNetwork = null
                wifiNetworkBound = false
            }
            return restored
        }
    }

    private fun createRecorder(source: Int): Pair<AudioRecord, String>? {
        val minimum = AudioRecord.getMinBufferSize(SAMPLE_RATE, CHANNEL, ENCODING)
        if (minimum <= 0) return null
        val bufferSize = maxOf(minimum * 2, FRAME_BYTES * 8)
        val candidate = try {
            AudioRecord(source, SAMPLE_RATE, CHANNEL, ENCODING, bufferSize)
        } catch (_: Exception) {
            return null
        }
        if (candidate.state != AudioRecord.STATE_INITIALIZED) {
            runCatching { candidate.release() }
            return null
        }
        val label = if (source == MediaRecorder.AudioSource.VOICE_COMMUNICATION) {
            "voice-communication"
        } else {
            "voice-recognition"
        }
        return candidate to label
    }

    private fun configureAudioEffects(sessionId: Int) {
        echoCanceler = if (AcousticEchoCanceler.isAvailable()) {
            runCatching { AcousticEchoCanceler.create(sessionId)?.apply { enabled = true } }.getOrNull()
        } else null
        noiseSuppressor = if (NoiseSuppressor.isAvailable()) {
            runCatching { NoiseSuppressor.create(sessionId)?.apply { enabled = true } }.getOrNull()
        } else null
        automaticGainControl = if (AutomaticGainControl.isAvailable()) {
            runCatching { AutomaticGainControl.create(sessionId)?.apply { enabled = true } }.getOrNull()
        } else null
    }

    private fun startRecorderAfterTransportReady(attempt: Long) {
        synchronized(stateLock) {
            if (startSequence != attempt || startSettled.get() || recording.get()) return
            val initialized = createRecorder(MediaRecorder.AudioSource.VOICE_COMMUNICATION)
                ?: createRecorder(MediaRecorder.AudioSource.VOICE_RECOGNITION)
            if (initialized == null) {
                startSequence += 1
                rejectPendingStart(
                    "AUDIO_RECORD_INIT_FAILED",
                    "Android AudioRecord could not be initialized"
                )
                transport.close()
                return
            }

            recorder = initialized.first
            currentSource = initialized.second
            configureAudioEffects(initialized.first.audioSessionId)
            try {
                initialized.first.startRecording()
            } catch (error: Exception) {
                releaseRecorder()
                startSequence += 1
                rejectPendingStart(
                    "AUDIO_RECORD_START_FAILED",
                    error.message ?: "Android AudioRecord failed to start"
                )
                transport.close()
                return
            }
            if (initialized.first.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
                releaseRecorder()
                startSequence += 1
                rejectPendingStart(
                    "AUDIO_RECORD_START_FAILED",
                    "Android AudioRecord did not enter recording state"
                )
                transport.close()
                return
            }

            captureSequence = 0L
            droppedFrames.set(0)
            recording.set(true)
            recordingThread = Thread(
                { captureLoop(initialized.first) },
                "JunLuoVoiceAudio"
            ).apply {
                isDaemon = true
                start()
            }
            resolvePendingStart(startResult(initialized.second))
        }
    }

    private fun handleTransportFailure(attempt: Long, message: String) {
        stopRecorderInternal(expectedAttempt = attempt, transportFailure = message)
    }

    private fun isCurrentRecorder(activeRecorder: AudioRecord): Boolean =
        recording.get() && recorder === activeRecorder

    private fun handleCaptureFailure(activeRecorder: AudioRecord) {
        synchronized(stateLock) {
            if (!isCurrentRecorder(activeRecorder)) return
            // This runs on the capture thread; it releases its own resources without joining itself.
            if (stopRecorderInternal(closeTransport = true)) emitAudioStreamClosed()
        }
    }

    private fun emitAudioStreamClosed() {
        emitServerMessage(
            JSONObject()
                .put("type", "error")
                .put("code", "NATIVE_AUDIO_STREAM_CLOSED")
                .put("message", "麦克风音频通道断开了。")
                .toString()
        )
    }

    private fun captureLoop(activeRecorder: AudioRecord) {
        val frame = ByteArray(FRAME_BYTES)
        val batch = ByteArray(AUDIO_BATCH_BYTES)
        var batchOffset = 0
        var emptyReads = 0
        while (isCurrentRecorder(activeRecorder)) {
            var offset = 0
            while (isCurrentRecorder(activeRecorder) && offset < frame.size) {
                val read = try {
                    activeRecorder.read(frame, offset, frame.size - offset)
                } catch (_: Exception) {
                    AudioRecord.ERROR_INVALID_OPERATION
                }
                if (!isCurrentRecorder(activeRecorder)) return
                if (read < 0) {
                    handleCaptureFailure(activeRecorder)
                    return
                }
                if (read == 0) {
                    // Tolerate brief empty reads, but never spin indefinitely without audio.
                    emptyReads += 1
                    if (emptyReads >= MAX_EMPTY_READS) {
                        handleCaptureFailure(activeRecorder)
                        return
                    }
                    try {
                        Thread.sleep(EMPTY_READ_RETRY_MS)
                    } catch (_: InterruptedException) {
                        handleCaptureFailure(activeRecorder)
                        Thread.currentThread().interrupt()
                        return
                    }
                    continue
                }
                emptyReads = 0
                offset += read
            }
            synchronized(stateLock) {
                if (!isCurrentRecorder(activeRecorder) || offset != frame.size) return
                frame.copyInto(batch, destinationOffset = batchOffset)
                batchOffset += frame.size
                captureSequence += 1
                val sent = if (batchOffset == batch.size) {
                    batchOffset = 0
                    transport.sendAudio(batch)
                } else {
                    true
                }
                if (!sent) {
                    droppedFrames.addAndGet(AUDIO_BATCH_FRAMES)
                }
                val dropped = droppedFrames.get()
                if (
                    captureSequence == 1L ||
                    captureSequence % TRANSPORT_DIAGNOSTIC_INTERVAL_FRAMES == 0L ||
                    (!sent && (dropped == 1 || dropped % 50 == 0))
                ) {
                    sendTransportDiagnostic(frame, System.currentTimeMillis())
                }
            }
        }
    }

    private fun sendTransportDiagnostic(frame: ByteArray, capturedAt: Long) {
        var sumSquares = 0L
        var peak = 0
        var index = 0
        while (index + 1 < frame.size) {
            val low = frame[index].toInt() and 0xff
            val high = frame[index + 1].toInt()
            val sample = ((high shl 8) or low).toShort().toInt()
            val magnitude = abs(sample)
            if (magnitude > peak) peak = magnitude
            sumSquares += sample.toLong() * sample.toLong()
            index += 2
        }
        val sampleCount = frame.size / 2
        val rms = if (sampleCount > 0) sqrt(sumSquares.toDouble() / sampleCount).toInt() else 0
        val details = JSONObject()
            .put("bytes", frame.size)
            .put("batchFrames", AUDIO_BATCH_FRAMES)
            .put("capturedAt", capturedAt)
            .put("droppedFrames", droppedFrames.get())
            .put("peak", peak)
            .put("rms", rms)
            .put("sequence", captureSequence)
            .put("socketQueueBytes", transport.queueSize())
            .put("transport", "native-websocket")
        transport.sendText(
            JSONObject()
                .put("type", "diagnostic")
                .put(
                    "event",
                    if (captureSequence == 1L) {
                        "native_first_pcm_frame"
                    } else {
                        "native_pcm_transport_health"
                    }
                )
                .put("details", details)
                .put("at", capturedAt)
                .toString()
        )
    }

    private fun emitServerMessage(message: String) {
        val payload = Arguments.createMap().apply { putString("message", message) }
        runCatching {
            reactApplicationContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(EVENT_SERVER_MESSAGE, payload)
        }
    }

    private fun startResult(source: String) = Arguments.createMap().apply {
        putInt("channels", 1)
        putInt("batchFrames", AUDIO_BATCH_FRAMES)
        putInt("frameBytes", FRAME_BYTES)
        putInt("sampleRate", SAMPLE_RATE)
        putString("transport", "native-websocket")
        putString("source", source)
        putBoolean("aec", echoCanceler?.enabled == true)
        putBoolean("agc", automaticGainControl?.enabled == true)
        putBoolean("noiseSuppression", noiseSuppressor?.enabled == true)
    }

    private fun stopInternal() {
        stopRecorderInternal(closeTransport = true)
    }

    private fun stopRecorderInternal(closeTransport: Boolean = false, expectedAttempt: Long? = null,
        transportFailure: String? = null): Boolean {
        val threadToJoin: Thread?
        val recorderToRelease: AudioRecord?
        val echoCancelerToRelease: AcousticEchoCanceler?
        val noiseSuppressorToRelease: NoiseSuppressor?
        val automaticGainControlToRelease: AutomaticGainControl?
        val wasRecording: Boolean
        synchronized(stateLock) {
            if (expectedAttempt != null && startSequence != expectedAttempt) return false
            startSequence += 1
            wasRecording = recording.getAndSet(false)
            recorderToRelease = recorder
            echoCancelerToRelease = echoCanceler
            noiseSuppressorToRelease = noiseSuppressor
            automaticGainControlToRelease = automaticGainControl
            recorder = null
            echoCanceler = null
            noiseSuppressor = null
            automaticGainControl = null
            threadToJoin = recordingThread
            recordingThread = null
            if (closeTransport) {
                transport.close()
                rejectPendingStart("AUDIO_STREAM_CANCELLED", "Native microphone start was cancelled")
            }
            if (transportFailure != null) {
                rejectPendingStart("AUDIO_STREAM_CONNECT_FAILED", transportFailure)
                if (wasRecording) emitAudioStreamClosed()
            }
            runCatching { recorderToRelease?.stop() }
        }
        if (threadToJoin !== Thread.currentThread()) {
            runCatching { threadToJoin?.join(500) }
        }
        // A new start may arrive during join; release only the resources claimed above.
        runCatching { recorderToRelease?.release() }
        runCatching { echoCancelerToRelease?.release() }
        runCatching { noiseSuppressorToRelease?.release() }
        runCatching { automaticGainControlToRelease?.release() }
        return wasRecording
    }

    private fun resolvePendingStart(result: Any) {
        if (!startSettled.compareAndSet(false, true)) return
        val promise = pendingStartPromise
        pendingStartPromise = null
        promise?.resolve(result)
    }

    private fun rejectPendingStart(code: String, message: String) {
        if (!startSettled.compareAndSet(false, true)) return
        val promise = pendingStartPromise
        pendingStartPromise = null
        promise?.reject(code, message)
    }

    private fun releaseRecorder() {
        runCatching { recorder?.release() }
        recorder = null
        runCatching { echoCanceler?.release() }
        runCatching { noiseSuppressor?.release() }
        runCatching { automaticGainControl?.release() }
        echoCanceler = null
        noiseSuppressor = null
        automaticGainControl = null
    }
}
