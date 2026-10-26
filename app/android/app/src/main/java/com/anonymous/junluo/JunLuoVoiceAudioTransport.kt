package com.anonymous.junluo

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString.Companion.toByteString
import org.json.JSONObject
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean


internal class JunLuoVoiceAudioTransport {
    companion object {
        private const val MAX_QUEUED_AUDIO_BYTES = 64L * 1024L
        private val client = OkHttpClient.Builder()
            .connectTimeout(5, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .writeTimeout(5, TimeUnit.SECONDS)
            .build()
    }

    private val stateLock = Any()
    private var generation = 0L
    private var socket: WebSocket? = null

    fun connect(
        url: String,
        onReady: () -> Unit,
        onMessage: (String) -> Unit,
        onFailure: (String) -> Unit
    ) {
        val request = Request.Builder().url(url).build()
        val attempt = synchronized(stateLock) {
            generation += 1
            socket?.cancel()
            socket = null
            generation
        }
        val readyDelivered = AtomicBoolean(false)
        val created = client.newWebSocket(request, object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                if (!isCurrent(attempt, webSocket)) return
                onMessage(text)
                val type = runCatching { JSONObject(text).optString("type") }.getOrNull()
                if (type == "ready" && readyDelivered.compareAndSet(false, true)) {
                    onReady()
                }
            }

            override fun onFailure(webSocket: WebSocket, error: Throwable, response: Response?) {
                if (!clearIfCurrent(attempt, webSocket)) return
                onFailure(error.message ?: "Native microphone WebSocket failed")
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (!clearIfCurrent(attempt, webSocket)) return
                onFailure("Native microphone WebSocket closed ($code)")
            }
        })
        synchronized(stateLock) {
            if (generation == attempt) {
                socket = created
            } else {
                created.cancel()
            }
        }
    }

    fun sendAudio(frame: ByteArray): Boolean {
        val current = synchronized(stateLock) { socket } ?: return false
        if (current.queueSize() > MAX_QUEUED_AUDIO_BYTES) return false
        return current.send(frame.toByteString())
    }

    fun sendText(payload: String): Boolean {
        val current = synchronized(stateLock) { socket } ?: return false
        return current.send(payload)
    }

    fun queueSize(): Long = synchronized(stateLock) { socket?.queueSize() ?: 0L }

    fun close() {
        val current = synchronized(stateLock) {
            generation += 1
            val previous = socket
            socket = null
            previous
        } ?: return
        runCatching { current.send("""{"type":"end"}""") }
        runCatching { current.close(1000, "voice call ended") }
    }

    private fun isCurrent(attempt: Long, candidate: WebSocket): Boolean =
        synchronized(stateLock) { generation == attempt && socket === candidate }

    private fun clearIfCurrent(attempt: Long, candidate: WebSocket): Boolean =
        synchronized(stateLock) {
            if (generation != attempt || socket !== candidate) return@synchronized false
            socket = null
            true
        }
}
