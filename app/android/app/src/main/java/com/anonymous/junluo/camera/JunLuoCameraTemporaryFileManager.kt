package com.anonymous.junluo.camera

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.AtomicFile
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.LinkedHashMap
import java.util.UUID

internal val JUNLUO_CAMERA_FRAME_RETRY_DELAYS_MS = longArrayOf(1_000L, 5_000L, 30_000L)

internal fun isJunLuoCameraPrivacyCanonicalChild(rootPath: String, candidatePath: String): Boolean =
    candidatePath.startsWith(rootPath + File.separator) && candidatePath != rootPath

internal fun pruneJunLuoCameraDeletionProofs(
    proofs: List<JunLuoCameraFrameDeletionProof>,
    now: Long,
): List<JunLuoCameraFrameDeletionProof> = proofs
    .filter { now - it.completedAt <= 24 * 60 * 60 * 1000L }
    .takeLast(32)

internal enum class JunLuoCameraFrameCleanupState(val wireValue: String) {
    NONE("none"), DELETING("deleting"), RETRYING("retrying"),
    VERIFIED_DELETED("verified_deleted"), FAILED("failed"),
}

internal enum class JunLuoCameraFrameCleanupTrigger(val wireValue: String) {
    CONSUMER_RELEASE("consumer_release"), EXPLICIT_SAVE("explicit_save"),
    CAPTURE_CANCELLED("capture_cancelled"), SESSION_STOP("session_stop"),
    BRIDGE_INVALIDATED("bridge_invalidated"), WATCHDOG("watchdog"),
    STARTUP_ORPHAN_SCAN("startup_orphan_scan"), LEGACY_CACHE_SCAN("legacy_cache_scan"),
    DEBUG_SELF_TEST("debug_self_test"),
}

internal data class JunLuoCameraFrameDeletionProof(
    val proofId: String,
    val completedAt: Long,
    val trigger: JunLuoCameraFrameCleanupTrigger,
    val byteLength: Long?,
    val sha256Prefix: String?,
    val attemptCount: Int,
    val deletionVerified: Boolean,
    val orphanRecovered: Boolean,
)

internal data class JunLuoCameraFramePrivacyState(
    val schemaVersion: Int = 1,
    val activeFrameCount: Int,
    val retryingFrameCount: Int,
    val orphanFrameCount: Int,
    val cacheEmpty: Boolean,
    val lastCleanupAt: Long?,
    val lastCleanupState: JunLuoCameraFrameCleanupState,
    val lastCleanupTrigger: JunLuoCameraFrameCleanupTrigger?,
    val startupOrphansDeleted: Int,
    val auditAvailable: Boolean,
    val latestProof: JunLuoCameraFrameDeletionProof?,
)

internal sealed class JunLuoCameraManagedDeletionResult {
    data class VerifiedDeleted(val auditPersisted: Boolean) : JunLuoCameraManagedDeletionResult()
    data object Retrying : JunLuoCameraManagedDeletionResult()
    data object Failed : JunLuoCameraManagedDeletionResult()
}

internal object JunLuoCameraTemporaryFileManager {
    private const val PRIVACY_ROOT = "junluo-camera/camera-perception"
    private const val PROOF_PATH = "junluo-camera/frame-privacy-v1"
    private const val MAX_PROOFS = 32
    private const val PROOF_MAX_AGE_MS = 24 * 60 * 60 * 1000L
    private val LEGACY_DIRECTORIES = listOf(
        "junluo-camera/chapter4-debug", "junluo-camera/chapter5-service",
        "junluo-camera/chapter6-bridge",
    )

    private data class PendingDeletion(
        val file: File,
        val trigger: JunLuoCameraFrameCleanupTrigger,
        val byteLength: Long?,
        val sha256Prefix: String?,
        val orphanRecovered: Boolean,
        val callback: (JunLuoCameraManagedDeletionResult) -> Unit,
        var attemptCount: Int = 0,
        var state: JunLuoCameraFrameCleanupState = JunLuoCameraFrameCleanupState.DELETING,
    )

    private val handler = Handler(Looper.getMainLooper())
    private val sessionDirectoryIds = LinkedHashMap<String, String>()
    private val activePaths = linkedSetOf<String>()
    private val pendingByPath = LinkedHashMap<String, PendingDeletion>()
    private val proofs = mutableListOf<JunLuoCameraFrameDeletionProof>()
    private val debugFailuresRemaining = mutableMapOf<String, Int>()
    private var appContext: Context? = null
    private var initialized = false
    private var lastCleanupAt: Long? = null
    private var lastCleanupState = JunLuoCameraFrameCleanupState.NONE
    private var lastCleanupTrigger: JunLuoCameraFrameCleanupTrigger? = null
    private var startupOrphansDeleted = 0
    private var auditAvailable = true

    @Synchronized
    fun initialize(context: Context) {
        if (initialized) return
        appContext = context.applicationContext
        loadProofs(context.applicationContext)
        initialized = true
        sweepOrphans(context.applicationContext, startup = true)
        publishState()
    }

    @Synchronized
    fun createOutputFile(context: Context, sessionId: String): File {
        initialize(context)
        val root = privacyRoot(context).apply {
            if (!exists() && !mkdirs()) throw IllegalStateException(JunLuoCameraErrorCodes.FILE_IO_FAILED)
        }
        val opaqueId = sessionDirectoryIds.getOrPut(sessionId) { UUID.randomUUID().toString() }
        val directory = File(root, "session-$opaqueId").apply {
            if (!exists() && !mkdirs()) throw IllegalStateException(JunLuoCameraErrorCodes.FILE_IO_FAILED)
        }
        val path = requireCanonicalChild(root, File(directory, "${UUID.randomUUID()}.jpg"))
        activePaths.add(path)
        publishState()
        return File(path)
    }

    @Synchronized
    fun register(file: File): Boolean {
        val context = appContext ?: return false
        val path = runCatching { requireCanonicalChild(privacyRoot(context), file) }.getOrNull() ?: return false
        activePaths.add(path)
        publishState()
        return true
    }

    fun delete(
        file: File,
        trigger: JunLuoCameraFrameCleanupTrigger,
        byteLength: Long? = null,
        sha256: String? = null,
        orphanRecovered: Boolean = false,
        callback: (JunLuoCameraManagedDeletionResult) -> Unit = {},
    ): JunLuoCameraManagedDeletionResult {
        val context = appContext ?: return JunLuoCameraManagedDeletionResult.Failed
        val path = runCatching { requireCanonicalChild(privacyRoot(context), file) }.getOrNull()
            ?: return JunLuoCameraManagedDeletionResult.Failed
        synchronized(this) {
            pendingByPath[path]?.let {
                return if (it.state == JunLuoCameraFrameCleanupState.FAILED) {
                    JunLuoCameraManagedDeletionResult.Failed
                } else JunLuoCameraManagedDeletionResult.Retrying
            }
            pendingByPath[path] = PendingDeletion(
                File(path), trigger, byteLength?.takeIf { it >= 0L },
                sha256?.take(8)?.lowercase()?.takeIf { it.matches(Regex("[0-9a-f]{1,8}")) },
                orphanRecovered, callback,
            )
            lastCleanupState = JunLuoCameraFrameCleanupState.DELETING
            lastCleanupTrigger = trigger
            publishState()
        }
        return attemptDelete(path)
    }

    fun deleteManagedOrFallback(
        context: Context,
        file: File,
        trigger: JunLuoCameraFrameCleanupTrigger,
    ): Boolean {
        initialize(context)
        if (runCatching { requireCanonicalChild(privacyRoot(context), file) }.isFailure) {
            return !file.exists() || file.delete()
        }
        return delete(file, trigger) is JunLuoCameraManagedDeletionResult.VerifiedDeleted
    }

    fun verifyCleanup(context: Context): JunLuoCameraFramePrivacyState {
        initialize(context)
        val failedPaths = synchronized(this) {
            pendingByPath.filterValues { it.state == JunLuoCameraFrameCleanupState.FAILED }
                .onEach { (_, pending) ->
                    pending.state = JunLuoCameraFrameCleanupState.DELETING
                    pending.attemptCount = 0
                }
                .keys
                .toList()
        }
        failedPaths.forEach { handler.post { attemptDelete(it) } }
        synchronized(this) {
            sweepOrphans(context.applicationContext, startup = false)
            return snapshotLocked()
        }
    }

    @Synchronized
    fun snapshot(context: Context): JunLuoCameraFramePrivacyState {
        initialize(context)
        return snapshotLocked()
    }

    @Synchronized
    fun createDebugSelfTest(context: Context, failuresBeforeSuccess: Int): JunLuoCameraManagedDeletionResult {
        initialize(context)
        val file = createDebugTestFile(context)
        activePaths.add(file.canonicalPath)
        debugFailuresRemaining[file.canonicalPath] = failuresBeforeSuccess.coerceIn(0, 4)
        return delete(file, JunLuoCameraFrameCleanupTrigger.DEBUG_SELF_TEST, file.length())
    }

    @Synchronized
    fun createDebugOrphan(context: Context): JunLuoCameraFramePrivacyState {
        initialize(context)
        createDebugTestFile(context)
        publishState()
        return snapshotLocked()
    }

    @Synchronized
    fun createDebugWatchdogTest(context: Context): JunLuoCameraFramePrivacyState {
        initialize(context)
        val file = createDebugTestFile(context)
        activePaths.add(file.canonicalPath)
        val byteLength = file.length()
        handler.postDelayed({
            delete(file, JunLuoCameraFrameCleanupTrigger.WATCHDOG, byteLength)
        }, 120_000L)
        publishState()
        return snapshotLocked()
    }

    @Synchronized
    private fun sweepOrphans(context: Context, startup: Boolean) {
        val root = privacyRoot(context)
        val known = activePaths.toSet()
        root.walkTopDown().filter { it.isFile }.forEach { file ->
            val path = runCatching { requireCanonicalChild(root, file) }.getOrNull() ?: return@forEach
            if (path !in known && path !in pendingByPath) {
                delete(
                    file, JunLuoCameraFrameCleanupTrigger.STARTUP_ORPHAN_SCAN,
                    file.length(), orphanRecovered = true,
                ) { result ->
                    if (startup && result is JunLuoCameraManagedDeletionResult.VerifiedDeleted) {
                        synchronized(this) { startupOrphansDeleted += 1; publishState() }
                    }
                }
            }
        }
        LEGACY_DIRECTORIES.forEach { relative ->
            val directory = File(context.cacheDir, relative)
            directory.walkTopDown().filter { it.isFile }.forEach { file ->
                val length = file.length().takeIf { it > 0L }
                if (deleteLegacyFile(file)) {
                    appendProof(JunLuoCameraFrameCleanupTrigger.LEGACY_CACHE_SCAN, length, null, 1, true)
                    if (startup) startupOrphansDeleted += 1
                }
            }
            if (directory.listFiles()?.isEmpty() == true) directory.delete()
        }
    }

    private fun attemptDelete(path: String): JunLuoCameraManagedDeletionResult {
        val pending = synchronized(this) { pendingByPath[path] }
            ?: return JunLuoCameraManagedDeletionResult.Failed
        pending.attemptCount += 1
        val forcedFailure = synchronized(this) {
            val remaining = debugFailuresRemaining[path] ?: 0
            if (remaining > 0) { debugFailuresRemaining[path] = remaining - 1; true } else false
        }
        val deleted = !forcedFailure && (!pending.file.exists() || pending.file.delete()) && !pending.file.exists()
        if (deleted) {
            val auditPersisted = synchronized(this) {
                activePaths.remove(path)
                pendingByPath.remove(path)
                debugFailuresRemaining.remove(path)
                removeEmptyDirectoryTree(pending.file.parentFile)
                lastCleanupAt = System.currentTimeMillis()
                lastCleanupState = JunLuoCameraFrameCleanupState.VERIFIED_DELETED
                lastCleanupTrigger = pending.trigger
                val persisted = appendProof(
                    pending.trigger, pending.byteLength, pending.sha256Prefix,
                    pending.attemptCount, pending.orphanRecovered,
                )
                publishState()
                persisted
            }
            val result = JunLuoCameraManagedDeletionResult.VerifiedDeleted(auditPersisted)
            pending.callback(result)
            return result
        }
        val retryIndex = pending.attemptCount - 1
        if (retryIndex < JUNLUO_CAMERA_FRAME_RETRY_DELAYS_MS.size) {
            synchronized(this) {
                pending.state = JunLuoCameraFrameCleanupState.RETRYING
                lastCleanupAt = System.currentTimeMillis()
                lastCleanupState = JunLuoCameraFrameCleanupState.RETRYING
                lastCleanupTrigger = pending.trigger
                publishState()
            }
            handler.postDelayed({ attemptDelete(path) }, JUNLUO_CAMERA_FRAME_RETRY_DELAYS_MS[retryIndex])
            return JunLuoCameraManagedDeletionResult.Retrying
        }
        synchronized(this) {
            pending.state = JunLuoCameraFrameCleanupState.FAILED
            lastCleanupAt = System.currentTimeMillis()
            lastCleanupState = JunLuoCameraFrameCleanupState.FAILED
            lastCleanupTrigger = pending.trigger
            publishState()
        }
        pending.callback(JunLuoCameraManagedDeletionResult.Failed)
        return JunLuoCameraManagedDeletionResult.Failed
    }

    @Synchronized
    private fun snapshotLocked(): JunLuoCameraFramePrivacyState {
        val diskFiles = appContext?.let { privacyRoot(it).walkTopDown().filter(File::isFile)
            .mapNotNull { file -> runCatching { file.canonicalPath }.getOrNull() }.toList() }.orEmpty()
        val retrying = pendingByPath.values.count {
            it.state == JunLuoCameraFrameCleanupState.DELETING || it.state == JunLuoCameraFrameCleanupState.RETRYING
        }
        return JunLuoCameraFramePrivacyState(
            activeFrameCount = activePaths.count { it !in pendingByPath },
            retryingFrameCount = retrying,
            orphanFrameCount = diskFiles.count { it !in activePaths },
            cacheEmpty = diskFiles.isEmpty(),
            lastCleanupAt = lastCleanupAt,
            lastCleanupState = lastCleanupState,
            lastCleanupTrigger = lastCleanupTrigger,
            startupOrphansDeleted = startupOrphansDeleted,
            auditAvailable = auditAvailable,
            latestProof = proofs.lastOrNull(),
        )
    }

    @Synchronized
    private fun publishState() {
        if (initialized) JunLuoCameraServiceEventBus.publishPrivacy(snapshotLocked())
    }

    @Synchronized
    private fun appendProof(
        trigger: JunLuoCameraFrameCleanupTrigger,
        byteLength: Long?,
        sha256Prefix: String?,
        attemptCount: Int,
        orphanRecovered: Boolean,
    ): Boolean {
        val context = appContext ?: return false
        val now = System.currentTimeMillis()
        proofs.removeAll { now - it.completedAt > PROOF_MAX_AGE_MS }
        proofs.add(JunLuoCameraFrameDeletionProof(
            UUID.randomUUID().toString(), now, trigger, byteLength, sha256Prefix,
            attemptCount, true, orphanRecovered,
        ))
        while (proofs.size > MAX_PROOFS) proofs.removeAt(0)
        return persistProofs(context).also { auditAvailable = it }
    }

    private fun loadProofs(context: Context) {
        val file = proofFile(context)
        if (!file.exists()) return
        runCatching {
            val array = JSONArray(file.readText(Charsets.UTF_8))
            val now = System.currentTimeMillis()
            for (index in 0 until array.length()) {
                val item = array.getJSONObject(index)
                val completedAt = item.optLong("completedAt", 0L)
                val trigger = JunLuoCameraFrameCleanupTrigger.entries.firstOrNull {
                    it.wireValue == item.optString("trigger")
                } ?: continue
                if (completedAt <= 0L || now - completedAt > PROOF_MAX_AGE_MS) continue
                proofs.add(JunLuoCameraFrameDeletionProof(
                    item.optString("proofId"), completedAt, trigger,
                    item.optLong("byteLength").takeIf { item.has("byteLength") },
                    item.optString("sha256Prefix").takeIf(String::isNotBlank),
                    item.optInt("attemptCount", 1), item.optBoolean("deletionVerified", true),
                    item.optBoolean("orphanRecovered", false),
                ))
            }
            while (proofs.size > MAX_PROOFS) proofs.removeAt(0)
        }.onFailure { auditAvailable = false }
    }

    private fun persistProofs(context: Context): Boolean = runCatching {
        val file = proofFile(context)
        file.parentFile?.mkdirs()
        val array = JSONArray()
        proofs.forEach { proof -> array.put(JSONObject().apply {
            put("proofId", proof.proofId); put("completedAt", proof.completedAt)
            put("trigger", proof.trigger.wireValue)
            proof.byteLength?.let { put("byteLength", it) }
            proof.sha256Prefix?.let { put("sha256Prefix", it) }
            put("attemptCount", proof.attemptCount); put("deletionVerified", proof.deletionVerified)
            put("orphanRecovered", proof.orphanRecovered)
        }) }
        val atomic = AtomicFile(file)
        val stream = atomic.startWrite()
        try {
            stream.write(array.toString().toByteArray(Charsets.UTF_8)); atomic.finishWrite(stream)
        } catch (error: Throwable) { atomic.failWrite(stream); throw error }
    }.isSuccess

    private fun proofFile(context: Context) = File(context.noBackupFilesDir, PROOF_PATH)
    private fun privacyRoot(context: Context) = File(context.cacheDir, PRIVACY_ROOT)

    private fun createDebugTestFile(context: Context): File {
        val root = privacyRoot(context).apply { mkdirs() }
        val directory = File(root, "session-${UUID.randomUUID()}").apply { mkdirs() }
        val file = File(directory, "${UUID.randomUUID()}.tmp")
        requireCanonicalChild(root, file)
        file.writeText("temporary privacy self test", Charsets.UTF_8)
        return file
    }

    private fun requireCanonicalChild(root: File, candidate: File): String {
        val rootPath = root.canonicalPath
        val path = candidate.canonicalPath
        if (!isJunLuoCameraPrivacyCanonicalChild(rootPath, path)) throw SecurityException("camera temp path escaped")
        return path
    }

    private fun deleteLegacyFile(file: File): Boolean = !file.exists() || (file.delete() && !file.exists())

    private fun removeEmptyDirectoryTree(start: File?) {
        val root = appContext?.let(::privacyRoot) ?: return
        var current = start
        while (current != null && current != root) {
            if (current.listFiles()?.isNotEmpty() == true || !current.delete()) break
            current = current.parentFile
        }
    }
}
