package com.anonymous.junluo.camera

import android.content.Context
import android.os.Handler
import android.os.Looper
import java.io.File
import java.util.LinkedHashMap
import java.util.UUID

internal data class JunLuoCameraBridgeFrameHandle(
    val frameId: String,
    val releaseToken: String,
    val file: File,
    val sessionId: String,
    val requestId: String,
    val captureGeneration: Long,
    val expiresAt: Long,
    val byteLength: Long,
    val sha256: String,
)

internal sealed class JunLuoCameraFrameReleaseResult {
    data class VerifiedDeleted(
        val alreadyDeleted: Boolean,
        val auditPersisted: Boolean,
    ) : JunLuoCameraFrameReleaseResult()
    data object Retrying : JunLuoCameraFrameReleaseResult()
    data object Failed : JunLuoCameraFrameReleaseResult()
    data class Rejected(val failureCode: String) : JunLuoCameraFrameReleaseResult()
}

internal object JunLuoCameraBridgeFrameRegistry {
    private const val MAX_ENTRIES = 64
    private const val MAX_AGE_MS = 10 * 60 * 1000L
    private const val FRAME_TTL_MS = 120_000L
    private val handler = Handler(Looper.getMainLooper())
    private val active = LinkedHashMap<String, JunLuoCameraBridgeFrameHandle>()
    private val cleanupStates = LinkedHashMap<String, JunLuoCameraFrameCleanupState>()
    private val tombstones = LinkedHashMap<String, Triple<String, Long, Boolean>>()
    private val saveClaims = mutableSetOf<String>()
    private val waiters = LinkedHashMap<String, MutableList<(JunLuoCameraFrameReleaseResult) -> Unit>>()

    @Synchronized
    fun register(
        sessionId: String,
        requestId: String,
        captureGeneration: Long,
        file: File,
        byteLength: Long,
        sha256: String,
        now: Long = System.currentTimeMillis(),
    ): Result<JunLuoCameraBridgeFrameHandle> {
        prune(now)
        if (active.isNotEmpty()) {
            JunLuoCameraTemporaryFileManager.delete(
                file, JunLuoCameraFrameCleanupTrigger.CAPTURE_CANCELLED, byteLength, sha256,
            )
            return Result.failure(IllegalStateException(JunLuoCameraServiceErrorCodes.FRAME_PENDING_RELEASE))
        }
        if (!JunLuoCameraTemporaryFileManager.register(file)) {
            return Result.failure(IllegalStateException(JunLuoCameraErrorCodes.FILE_IO_FAILED))
        }
        val handle = JunLuoCameraBridgeFrameHandle(
            UUID.randomUUID().toString(), UUID.randomUUID().toString(), file,
            sessionId, requestId, captureGeneration, now + FRAME_TTL_MS, byteLength, sha256,
        )
        active[handle.frameId] = handle
        handler.postDelayed({ expire(handle.frameId, handle.releaseToken) }, FRAME_TTL_MS)
        return Result.success(handle)
    }

    fun release(
        frameId: String,
        releaseToken: String,
        trigger: JunLuoCameraFrameCleanupTrigger = JunLuoCameraFrameCleanupTrigger.CONSUMER_RELEASE,
    ): JunLuoCameraFrameReleaseResult {
        val handle: JunLuoCameraBridgeFrameHandle
        synchronized(this) {
            prune(System.currentTimeMillis())
            tombstones[frameId]?.let { tombstone ->
                return if (tombstone.first == releaseToken) {
                    JunLuoCameraFrameReleaseResult.VerifiedDeleted(true, tombstone.third)
                } else JunLuoCameraFrameReleaseResult.Rejected(
                    JunLuoCameraServiceErrorCodes.RESOURCE_LEASE_MISMATCH,
                )
            }
            handle = active[frameId] ?: return JunLuoCameraFrameReleaseResult.Rejected(
                JunLuoCameraServiceErrorCodes.RESOURCE_LEASE_MISMATCH,
            )
            if (handle.releaseToken != releaseToken) return JunLuoCameraFrameReleaseResult.Rejected(
                JunLuoCameraServiceErrorCodes.RESOURCE_LEASE_MISMATCH,
            )
            when (cleanupStates[frameId]) {
                JunLuoCameraFrameCleanupState.DELETING,
                JunLuoCameraFrameCleanupState.RETRYING -> return JunLuoCameraFrameReleaseResult.Retrying
                JunLuoCameraFrameCleanupState.FAILED -> return JunLuoCameraFrameReleaseResult.Failed
                else -> cleanupStates[frameId] = JunLuoCameraFrameCleanupState.DELETING
            }
        }
        return when (val result = JunLuoCameraTemporaryFileManager.delete(
            handle.file, trigger, handle.byteLength, handle.sha256,
        ) { settled -> completeDeletion(frameId, releaseToken, settled) }) {
            is JunLuoCameraManagedDeletionResult.VerifiedDeleted -> synchronized(this) {
                tombstones[frameId]?.let {
                    JunLuoCameraFrameReleaseResult.VerifiedDeleted(false, it.third)
                } ?: JunLuoCameraFrameReleaseResult.VerifiedDeleted(false, result.auditPersisted)
            }
            JunLuoCameraManagedDeletionResult.Retrying -> {
                synchronized(this) { cleanupStates[frameId] = JunLuoCameraFrameCleanupState.RETRYING }
                JunLuoCameraFrameReleaseResult.Retrying
            }
            JunLuoCameraManagedDeletionResult.Failed -> {
                synchronized(this) { cleanupStates[frameId] = JunLuoCameraFrameCleanupState.FAILED }
                JunLuoCameraFrameReleaseResult.Failed
            }
        }
    }

    fun awaitDeletion(
        frameId: String,
        releaseToken: String,
        callback: (JunLuoCameraFrameReleaseResult) -> Unit,
    ) {
        synchronized(this) {
            tombstones[frameId]?.let { tombstone ->
                callback(if (tombstone.first == releaseToken) {
                    JunLuoCameraFrameReleaseResult.VerifiedDeleted(true, tombstone.third)
                } else JunLuoCameraFrameReleaseResult.Rejected(
                    JunLuoCameraServiceErrorCodes.RESOURCE_LEASE_MISMATCH,
                ))
                return
            }
            val handle = active[frameId]
            if (handle == null || handle.releaseToken != releaseToken) {
                callback(JunLuoCameraFrameReleaseResult.Rejected(
                    JunLuoCameraServiceErrorCodes.RESOURCE_LEASE_MISMATCH,
                ))
                return
            }
            if (cleanupStates[frameId] == JunLuoCameraFrameCleanupState.FAILED) {
                callback(JunLuoCameraFrameReleaseResult.Failed)
                return
            }
            waiters.getOrPut(frameId) { mutableListOf() }.add(callback)
        }
    }

    fun releaseSession(sessionId: String) {
        val handles = synchronized(this) { active.values.filter { it.sessionId == sessionId } }
        handles.forEach { release(it.frameId, it.releaseToken, JunLuoCameraFrameCleanupTrigger.SESSION_STOP) }
        synchronized(this) { prune(System.currentTimeMillis()) }
    }

    fun releaseAll(trigger: JunLuoCameraFrameCleanupTrigger) {
        val handles = synchronized(this) { active.values.toList() }
        handles.forEach { release(it.frameId, it.releaseToken, trigger) }
    }

    @Synchronized
    fun hasPendingFrame(): Boolean = active.isNotEmpty()

    @Synchronized
    fun claimForSave(frameId: String, releaseToken: String): Result<JunLuoCameraBridgeFrameHandle> {
        prune(System.currentTimeMillis())
        val handle = active[frameId]
            ?: return Result.failure(IllegalStateException(JunLuoCameraServiceErrorCodes.FRAME_ALREADY_RELEASED))
        if (handle.releaseToken != releaseToken) {
            return Result.failure(IllegalStateException(JunLuoCameraServiceErrorCodes.RESOURCE_LEASE_MISMATCH))
        }
        if (cleanupStates.containsKey(frameId) || !saveClaims.add(frameId)) {
            return Result.failure(IllegalStateException(JunLuoCameraServiceErrorCodes.FRAME_PENDING_RELEASE))
        }
        return Result.success(handle)
    }

    @Synchronized
    fun finishSaveClaim(frameId: String) { saveClaims.remove(frameId) }

    fun cleanupOrphans(context: Context) {
        JunLuoCameraTemporaryFileManager.initialize(context)
        JunLuoCameraTemporaryFileManager.verifyCleanup(context)
    }

    fun createOutputFile(context: Context, sessionId: String): File =
        JunLuoCameraTemporaryFileManager.createOutputFile(context, sessionId)

    private fun expire(frameId: String, releaseToken: String) {
        val handle = synchronized(this) { active[frameId] } ?: return
        if (handle.releaseToken != releaseToken || handle.expiresAt > System.currentTimeMillis()) return
        release(frameId, releaseToken, JunLuoCameraFrameCleanupTrigger.WATCHDOG)
    }

    private fun completeDeletion(
        frameId: String,
        releaseToken: String,
        result: JunLuoCameraManagedDeletionResult,
    ) {
        val resolved: JunLuoCameraFrameReleaseResult
        val callbacks: List<(JunLuoCameraFrameReleaseResult) -> Unit>
        synchronized(this) {
            when (result) {
                is JunLuoCameraManagedDeletionResult.VerifiedDeleted -> {
                    active.remove(frameId); cleanupStates.remove(frameId); saveClaims.remove(frameId)
                    tombstones[frameId] = Triple(releaseToken, System.currentTimeMillis(), result.auditPersisted)
                    resolved = JunLuoCameraFrameReleaseResult.VerifiedDeleted(false, result.auditPersisted)
                }
                JunLuoCameraManagedDeletionResult.Retrying -> {
                    cleanupStates[frameId] = JunLuoCameraFrameCleanupState.RETRYING
                    resolved = JunLuoCameraFrameReleaseResult.Retrying
                }
                JunLuoCameraManagedDeletionResult.Failed -> {
                    cleanupStates[frameId] = JunLuoCameraFrameCleanupState.FAILED
                    resolved = JunLuoCameraFrameReleaseResult.Failed
                }
            }
            callbacks = if (resolved is JunLuoCameraFrameReleaseResult.Retrying) emptyList()
            else waiters.remove(frameId).orEmpty()
            prune(System.currentTimeMillis())
        }
        callbacks.forEach { it(resolved) }
    }

    private fun prune(now: Long) {
        tombstones.entries.removeAll { now - it.value.second > MAX_AGE_MS }
        while (tombstones.size > MAX_ENTRIES) tombstones.remove(tombstones.keys.first())
    }
}
