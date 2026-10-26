package com.anonymous.junluo.camera

import android.os.Handler
import android.os.Looper
import java.util.concurrent.CopyOnWriteArraySet

internal sealed class JunLuoCameraBridgeCaptureReceipt {
    abstract val sessionId: String
    abstract val requestId: String
    abstract val captureGeneration: Long

    data class Success(
        override val sessionId: String,
        override val requestId: String,
        override val captureGeneration: Long,
        val revision: Long,
        val sourceKind: String,
        val capturedAt: Long,
        val temporaryUri: String,
        val temporaryFrameId: String,
        val releaseToken: String,
        val width: Int,
        val height: Int,
        val rotation: Int,
        val mirrored: Boolean,
        val sha256: String,
        val byteLength: Long,
    ) : JunLuoCameraBridgeCaptureReceipt()

    data class Failure(
        override val sessionId: String,
        override val requestId: String,
        override val captureGeneration: Long,
        val failureCode: String,
    ) : JunLuoCameraBridgeCaptureReceipt()
}

internal interface JunLuoCameraServiceEventListener {
    fun onSessionSnapshot(snapshot: JunLuoCameraServiceSnapshot) = Unit
    fun onHeartbeat(snapshot: JunLuoCameraServiceSnapshot) = Unit
    fun onCaptureReceipt(receipt: JunLuoCameraBridgeCaptureReceipt) = Unit
    fun onFramePrivacyState(state: JunLuoCameraFramePrivacyState) = Unit
}

internal object JunLuoCameraServiceEventBus {
    private val handler = Handler(Looper.getMainLooper())
    private val listeners = CopyOnWriteArraySet<JunLuoCameraServiceEventListener>()

    fun addListener(listener: JunLuoCameraServiceEventListener) {
        listeners.add(listener)
    }

    fun removeListener(listener: JunLuoCameraServiceEventListener) {
        listeners.remove(listener)
    }

    fun publishSnapshot(snapshot: JunLuoCameraServiceSnapshot) = enqueue {
        listeners.forEach { it.onSessionSnapshot(snapshot) }
    }

    fun publishHeartbeat(snapshot: JunLuoCameraServiceSnapshot) = enqueue {
        listeners.forEach { it.onHeartbeat(snapshot) }
    }

    fun publishCapture(receipt: JunLuoCameraBridgeCaptureReceipt) = enqueue {
        listeners.forEach { it.onCaptureReceipt(receipt) }
    }

    fun publishPrivacy(state: JunLuoCameraFramePrivacyState) = enqueue {
        listeners.forEach { it.onFramePrivacyState(state) }
    }

    private fun enqueue(block: () -> Unit) {
        handler.post(block)
    }
}
