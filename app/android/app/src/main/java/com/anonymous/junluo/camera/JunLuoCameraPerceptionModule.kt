package com.anonymous.junluo.camera

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.activity.ComponentActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import com.anonymous.junluo.BuildConfig
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.ReadableType
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.util.LinkedHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

internal class JunLuoCameraPerceptionModule(
    reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext), JunLuoCameraServiceEventListener, LifecycleEventListener {
    private data class PendingCapture(
        val sessionId: String,
        val requestId: String,
        val generation: Long,
        val promises: MutableList<Promise>,
        val timeout: Runnable,
    )

    private data class CachedCommand(
        val fingerprint: String,
        val result: CommandResult,
        val createdAt: Long,
    )

    private data class PendingManualSave(
        val fingerprint: String,
        val sessionId: String,
        val frameId: String,
        val releaseToken: String,
        val cancelled: AtomicBoolean,
        val promises: MutableList<Promise>,
    )

    private data class CachedManualSave(
        val fingerprint: String,
        val result: ManualSaveBridgeResult,
        val createdAt: Long,
    )

    private data class ManualSaveBridgeResult(
        val ok: Boolean,
        val failureCode: String? = null,
        val actionId: String? = null,
        val sessionId: String? = null,
        val requestId: String? = null,
        val sourceKind: String? = null,
        val capturedAt: Long? = null,
        val savedAt: Long? = null,
        val fileName: String? = null,
        val directoryDisplayName: String? = null,
        val width: Int? = null,
        val height: Int? = null,
        val rotation: Int? = null,
        val mirrored: Boolean? = null,
        val byteLength: Long? = null,
        val sha256: String? = null,
        val sourceFrameCleanup: String? = null,
        val consentSource: String? = null,
        val longTermStorage: String? = null,
    )

    private data class CommandResult(
        val ok: Boolean,
        val failureCode: String? = null,
        val sessionId: String? = null,
        val status: String? = null,
        val revision: Long? = null,
        val leaseId: String? = null,
        val owner: String? = null,
        val cleanupState: String? = null,
        val deletionVerified: Boolean? = null,
        val alreadyDeleted: Boolean? = null,
        val auditPersisted: Boolean? = null,
        val destinationConfigured: Boolean? = null,
        val destinationAvailable: Boolean? = null,
        val directoryDisplayName: String? = null,
        val selectedAt: Long? = null,
        val consentGranted: Boolean? = null,
        val updatedAt: Long? = null,
    )

    companion object {
        const val NAME = "JunLuoCameraPerception"
        const val EVENT_STATE = "onCameraSessionStateChanged"
        const val EVENT_CAPTURE = "onCameraCaptureReceipt"
        const val EVENT_HEARTBEAT = "onCameraServiceHeartbeat"
        const val EVENT_PRIVACY = "onCameraFramePrivacyStateChanged"
        private const val COMMAND_CACHE_LIMIT = 64
        private const val COMMAND_CACHE_TTL_MS = 10 * 60 * 1000L
        private const val BRIDGE_CAPTURE_TIMEOUT_MS = 25_000L
        private const val FRAME_DELETION_AWAIT_TIMEOUT_MS = 40_000L
        private val nextBridgeGeneration = AtomicLong(0L)
        private val nextCaptureGeneration = AtomicLong(0L)
    }

    private val handler = Handler(Looper.getMainLooper())
    private val bridgeGeneration = nextBridgeGeneration.incrementAndGet()
    private val pendingCaptures = LinkedHashMap<String, PendingCapture>()
    private val completedCaptures = LinkedHashMap<String, JunLuoCameraBridgeCaptureReceipt>()
    private val releasedCaptureKeys = LinkedHashMap<String, Long>()
    private val commandCache = LinkedHashMap<String, CachedCommand>()
    private val pendingManualSaves = LinkedHashMap<String, PendingManualSave>()
    private val cachedManualSaves = LinkedHashMap<String, CachedManualSave>()
    private val manualSaveExecutor = Executors.newSingleThreadExecutor()
    private var invalidated = false

    init {
        JunLuoCameraServiceEventBus.addListener(this)
        reactContext.addLifecycleEventListener(this)
        JunLuoCameraBridgeFrameRegistry.cleanupOrphans(reactContext)
    }

    override fun getName(): String = NAME

    @ReactMethod
    fun getAndroidCameraAvailability(facingValue: String, promise: Promise) {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            handler.post { getAndroidCameraAvailability(facingValue, promise) }
            return
        }
        val facing = parseFacing(facingValue) ?: return promise.resolve(failureMap(JunLuoCameraServiceErrorCodes.INVALID_BRIDGE_PAYLOAD))
        val core = JunLuoCameraCore(reactApplicationContext)
        core.getAvailability(facing) { availability ->
            core.release()
            promise.resolve(Arguments.createMap().apply {
                putBoolean("ok", availability.failureCode == null)
                putString("facing", availability.facing.name.lowercase())
                putBoolean("available", availability.available)
                putDouble("checkedAt", availability.checkedAt.toDouble())
                putNullableString("failureCode", availability.failureCode)
            })
        }
    }

    @ReactMethod
    fun getObservationPrerequisites(promise: Promise) {
        JunLuoCameraServiceNotifications.ensureChannel(reactApplicationContext)
        val activity = reactApplicationContext.currentActivity as? ComponentActivity
        promise.resolve(Arguments.createMap().apply {
            putBoolean("ok", true)
            putBoolean("cameraPermissionGranted", hasPermission(Manifest.permission.CAMERA))
            putBoolean(
                "notificationPermissionGranted",
                Build.VERSION.SDK_INT < 33 || hasPermission(Manifest.permission.POST_NOTIFICATIONS),
            )
            putBoolean("notificationChannelVisible", JunLuoCameraServiceNotifications.visibilityFailure(reactApplicationContext) == null)
            putBoolean("activityResumed", activity?.lifecycle?.currentState?.isAtLeast(Lifecycle.State.RESUMED) == true)
            putMap("runtimeConditions", runtimeConditionsMap(JunLuoCameraRuntimeConditions.read(reactApplicationContext)))
        })
    }

    @ReactMethod
    fun getObservationSessionState(promise: Promise) {
        promise.resolve(snapshotMap(JunLuoCameraSessionServiceController.readSnapshot(reactApplicationContext)))
    }

    @ReactMethod
    fun startObservationSession(request: ReadableMap, promise: Promise) = command(request, promise) {
        val activity = reactApplicationContext.currentActivity as? ComponentActivity
            ?: return@command CommandResult(false, JunLuoCameraServiceErrorCodes.VISIBLE_ACTIVITY_REQUIRED)
        val sessionId = request.string("sessionId") ?: return@command invalidResult()
        val facing = parseFacing(request.string("facing")) ?: return@command invalidResult()
        val requestedAt = request.long("requestedAt") ?: return@command invalidResult()
        when (val receipt = JunLuoCameraSessionServiceController.startFromVisibleActivity(
            activity,
            JunLuoCameraServiceStartRequest(sessionId, facing, requestedAt, null, null),
        )) {
            is JunLuoCameraServiceCommandReceipt.Accepted -> CommandResult(
                true,
                sessionId = receipt.sessionId,
                status = receipt.status.name.lowercase(),
                revision = receipt.revision,
            )
            is JunLuoCameraServiceCommandReceipt.Rejected -> CommandResult(false, receipt.failureCode)
        }
    }

    @ReactMethod
    fun stopObservationSession(request: ReadableMap, promise: Promise) = command(request, promise) {
        val sessionId = request.string("sessionId") ?: return@command invalidResult()
        val snapshot = JunLuoCameraSessionServiceController.readSnapshot(reactApplicationContext)
        if (snapshot.sessionId != sessionId && snapshot.lastSessionId != sessionId) {
            return@command CommandResult(false, JunLuoCameraServiceErrorCodes.STALE_SESSION)
        }
        JunLuoCameraPreviewCoordinator.terminateSession(sessionId)
        JunLuoCameraSessionServiceController.stop(
            reactApplicationContext,
            request.string("reasonCode")?.take(128) ?: "user_stop",
        )
        CommandResult(true, sessionId = sessionId, status = snapshot.status.name.lowercase(), revision = snapshot.revision)
    }

    @ReactMethod
    fun switchObservationFacing(request: ReadableMap, promise: Promise) = command(request, promise) {
        val sessionId = request.string("sessionId") ?: return@command invalidResult()
        val facing = parseFacing(request.string("facing")) ?: return@command invalidResult()
        val core = JunLuoCameraCore(reactApplicationContext)
        core.getAvailability(facing) { availability ->
            core.release()
            val result = if (!availability.available) {
                CommandResult(false, availability.failureCode ?: JunLuoCameraErrorCodes.UNAVAILABLE)
            } else when (val receipt = JunLuoCameraSessionServiceController.switchFacing(reactApplicationContext, sessionId, facing)) {
                is JunLuoCameraServiceCommandReceipt.Accepted -> CommandResult(
                    true, sessionId = sessionId, status = receipt.status.name.lowercase(), revision = receipt.revision,
                )
                is JunLuoCameraServiceCommandReceipt.Rejected -> CommandResult(false, receipt.failureCode)
            }
            resolveAndCache(request, promise, result)
        }
        null
    }

    @ReactMethod
    fun updateAutomaticObservationPolicy(request: ReadableMap, promise: Promise) = command(request, promise) {
        val quietHours = request.map("quietHours") ?: return@command invalidResult()
        val policy = JunLuoCameraAutomaticPolicyRequest(
            sessionId = request.string("sessionId"),
            enabled = request.boolean("enabled") ?: return@command invalidResult(),
            minimumIntervalMinutes = request.strictInt("minimumIntervalMinutes") ?: return@command invalidResult(),
            maximumIntervalMinutes = request.strictInt("maximumIntervalMinutes") ?: return@command invalidResult(),
            quietHoursEnabled = quietHours.boolean("enabled") ?: return@command invalidResult(),
            quietStartMinuteOfDay = quietHours.strictInt("startMinuteOfDay") ?: return@command invalidResult(),
            quietEndMinuteOfDay = quietHours.strictInt("endMinuteOfDay") ?: return@command invalidResult(),
            latestSuccessfulObservationAt = request.strictPositiveLong("latestSuccessfulObservationAt"),
        )
        if (request.hasNonNull("latestSuccessfulObservationAt") && policy.latestSuccessfulObservationAt == null) {
            return@command invalidResult()
        }
        if (!isValidAutomaticPolicy(policy)) return@command CommandResult(
            false, JunLuoCameraServiceErrorCodes.AUTOMATIC_POLICY_INVALID,
        )
        val current = JunLuoCameraSessionServiceController.readSnapshot(reactApplicationContext)
        if (!automaticPolicyTargetsCurrentSession(current, policy.sessionId)) {
            return@command CommandResult(false, JunLuoCameraServiceErrorCodes.STALE_SESSION)
        }
        val updated = try {
            JunLuoCameraServiceStore.update(reactApplicationContext) { snapshot ->
                applyAutomaticObservationPolicy(snapshot, policy, junLuoCameraAutomaticNow())
            }
        } catch (_: JunLuoCameraStatePersistException) {
            if (isActiveCameraServiceStatus(current.status)) {
                JunLuoCameraSessionServiceController.stop(
                    reactApplicationContext, JunLuoCameraServiceErrorCodes.STATE_PERSIST_FAILED,
                )
            }
            return@command CommandResult(false, JunLuoCameraServiceErrorCodes.STATE_PERSIST_FAILED)
        }
        updated.sessionId?.takeIf { isActiveCameraServiceStatus(updated.status) }?.let {
            JunLuoCameraSessionServiceController.refreshAutomaticSchedule(
                reactApplicationContext, it, updated.automaticObservation.scheduleGeneration,
            )
        }
        CommandResult(
            true,
            sessionId = updated.sessionId,
            status = updated.status.name.lowercase(),
            revision = updated.revision,
        )
    }

    @ReactMethod
    fun requestAutomaticObservationOpportunity(request: ReadableMap, promise: Promise) = command(request, promise) {
        val sessionId = request.string("sessionId") ?: return@command invalidResult()
        val attemptId = request.string("attemptId") ?: return@command invalidResult()
        val requestId = request.string("requestId") ?: return@command invalidResult()
        val scheduleGeneration = request.strictNonNegativeLong("scheduleGeneration") ?: return@command invalidResult()
        val enforceMinimum = request.boolean("enforceMinimumInterval") ?: return@command invalidResult()
        if (!listOf(sessionId, attemptId, requestId).all(::isValidCameraRequestId) ||
            request.string("triggerKind") != JunLuoCameraAutomaticTriggerKind.ACTION_OPPORTUNITY.wireValue
        ) return@command invalidResult()
        val updated = try {
            JunLuoCameraServiceStore.update(reactApplicationContext) { snapshot ->
                val gate = automaticObservationOpportunityGateFailure(
                    snapshot, sessionId, scheduleGeneration, junLuoCameraAutomaticNow(), enforceMinimum,
                ) ?: modelObservationPrerequisiteFailure(snapshot)
                if (gate != null) throw JunLuoCameraResourceConflictException(gate)
                snapshot.copy(automaticObservation = beginAutomaticObservationAttempt(
                    snapshot.automaticObservation, junLuoCameraAutomaticNow(), attemptId, requestId,
                ))
            }
        } catch (error: JunLuoCameraResourceConflictException) {
            return@command CommandResult(false, error.failureCode)
        } catch (_: JunLuoCameraStatePersistException) {
            JunLuoCameraSessionServiceController.stop(reactApplicationContext, JunLuoCameraServiceErrorCodes.STATE_PERSIST_FAILED)
            return@command CommandResult(false, JunLuoCameraServiceErrorCodes.STATE_PERSIST_FAILED)
        }
        // Claim only. The owning JS tool invocation performs capture after this durable receipt.
        JunLuoCameraSessionServiceController.refreshAutomaticSchedule(
            reactApplicationContext, sessionId, updated.automaticObservation.scheduleGeneration,
        )
        CommandResult(true, sessionId = sessionId, status = updated.status.name.lowercase(), revision = updated.revision)
    }

    @ReactMethod
    fun completeAutomaticObservationAttempt(request: ReadableMap, promise: Promise) = command(request, promise) {
        val completion = JunLuoCameraAutomaticCompletionRequest(
            sessionId = request.string("sessionId") ?: return@command invalidResult(),
            attemptId = request.string("attemptId") ?: return@command invalidResult(),
            requestId = request.string("requestId") ?: return@command invalidResult(),
            scheduleGeneration = request.strictNonNegativeLong("scheduleGeneration") ?: return@command invalidResult(),
            outcome = request.string("outcome") ?: return@command invalidResult(),
            failureCode = request.string("failureCode"),
            observationId = request.string("observationId"),
            capturedAt = request.strictPositiveLong("capturedAt"),
        )
        if (request.hasNonNull("capturedAt") && completion.capturedAt == null) return@command invalidResult()
        if (!isValidAutomaticCompletion(completion)) return@command invalidResult()
        val current = JunLuoCameraServiceStore.read(reactApplicationContext)
        if (current.sessionId != completion.sessionId) {
            return@command CommandResult(false, JunLuoCameraServiceErrorCodes.STALE_SESSION)
        }
        completeAutomaticObservationAttempt(
            current.automaticObservation,
            completion,
            junLuoCameraAutomaticNow(),
        ) ?: return@command CommandResult(false, JunLuoCameraServiceErrorCodes.AUTOMATIC_ATTEMPT_STALE)
        val updated = try {
            JunLuoCameraServiceStore.update(reactApplicationContext) { latest ->
                if (latest.sessionId != completion.sessionId || latest.status != JunLuoCameraServiceStatus.RUNNING) {
                    throw JunLuoCameraAutomaticStaleAttemptException()
                }
                if (completion.outcome == "success" &&
                    (latest.lastCaptureRequestId != completion.requestId || latest.lastCaptureSucceeded != true ||
                        !JunLuoCameraTemporaryFileManager.snapshot(reactApplicationContext).cacheEmpty)) {
                    throw JunLuoCameraAutomaticStaleAttemptException()
                }
                val latestSettled = completeAutomaticObservationAttempt(
                    latest.automaticObservation,
                    completion,
                    junLuoCameraAutomaticNow(),
                ) ?: throw JunLuoCameraAutomaticStaleAttemptException()
                latest.copy(
                    lastSuccessfulObservationAt = completion.capturedAt
                        ?: latest.lastSuccessfulObservationAt,
                    hardDeadlineAt = latestSettled.hardDeadlineAt,
                    automaticObservation = latestSettled,
                )
            }
        } catch (_: JunLuoCameraAutomaticStaleAttemptException) {
            return@command CommandResult(false, JunLuoCameraServiceErrorCodes.AUTOMATIC_ATTEMPT_STALE)
        } catch (_: JunLuoCameraStatePersistException) {
            JunLuoCameraSessionServiceController.stop(
                reactApplicationContext, JunLuoCameraServiceErrorCodes.STATE_PERSIST_FAILED,
            )
            return@command CommandResult(false, JunLuoCameraServiceErrorCodes.STATE_PERSIST_FAILED)
        }
        JunLuoCameraSessionServiceController.refreshAutomaticSchedule(
            reactApplicationContext,
            completion.sessionId,
            updated.automaticObservation.scheduleGeneration,
        )
        CommandResult(
            true,
            sessionId = updated.sessionId,
            status = updated.status.name.lowercase(),
            revision = updated.revision,
        )
    }

    @ReactMethod
    fun retryAutomaticObservationNow(request: ReadableMap, promise: Promise) = command(request, promise) {
        val sessionId = request.string("sessionId") ?: return@command invalidResult()
        val attemptId = request.string("attemptId") ?: return@command invalidResult()
        val requestId = request.string("requestId") ?: return@command invalidResult()
        val nextRequestId = request.string("nextRequestId")
        val scheduleGeneration = request.strictNonNegativeLong("scheduleGeneration") ?: return@command invalidResult()
        if (!listOf(sessionId, attemptId, requestId).all(::isValidCameraRequestId) ||
            (request.hasNonNull("nextRequestId") && (nextRequestId == null || !isValidCameraRequestId(nextRequestId)))
        ) return@command invalidResult()
        val updated = try {
            JunLuoCameraServiceStore.update(reactApplicationContext) { snapshot ->
                val retry = retryAutomaticObservationAttempt(
                    snapshot, sessionId, scheduleGeneration, attemptId, requestId, nextRequestId, junLuoCameraAutomaticNow(),
                ) ?: throw JunLuoCameraResourceConflictException(JunLuoCameraServiceErrorCodes.AUTOMATIC_RETRY_NOT_AVAILABLE)
                modelObservationPrerequisiteFailure(snapshot, allowExistingFrame = nextRequestId == null)?.let {
                    throw JunLuoCameraResourceConflictException(it)
                }
                snapshot.copy(automaticObservation = retry)
            }
        } catch (error: JunLuoCameraResourceConflictException) {
            return@command CommandResult(false, error.failureCode)
        } catch (_: JunLuoCameraStatePersistException) {
            JunLuoCameraSessionServiceController.stop(reactApplicationContext, JunLuoCameraServiceErrorCodes.STATE_PERSIST_FAILED)
            return@command CommandResult(false, JunLuoCameraServiceErrorCodes.STATE_PERSIST_FAILED)
        }
        JunLuoCameraSessionServiceController.refreshAutomaticSchedule(
            reactApplicationContext, sessionId, updated.automaticObservation.scheduleGeneration,
        )
        CommandResult(true, sessionId = sessionId, status = updated.status.name.lowercase(), revision = updated.revision)
    }

    private fun modelObservationPrerequisiteFailure(
        snapshot: JunLuoCameraServiceSnapshot,
        allowExistingFrame: Boolean = false,
    ): String? {
        if (!JunLuoCameraProcessState.serviceAlive) return JunLuoCameraErrorCodes.NOT_RUNNING
        if (!hasPermission(Manifest.permission.CAMERA)) return JunLuoCameraErrorCodes.PERMISSION_REQUIRED
        JunLuoCameraServiceNotifications.visibilityFailure(reactApplicationContext)?.let { return it }
        return JunLuoCameraAutomaticObservationScheduler.prerequisiteFailure(
            reactApplicationContext, snapshot, allowExistingFrame,
        )
    }

    @ReactMethod
    fun runAutomaticObservationDebugCommand(request: ReadableMap, promise: Promise) = command(request, promise) {
        if (!BuildConfig.DEBUG) return@command CommandResult(false, JunLuoCameraServiceErrorCodes.AUTOMATIC_DEBUG_UNAVAILABLE)
        val mode = request.string("mode") ?: return@command invalidResult()
        if (mode == "runtime_conditions") {
            val clear = request.boolean("clear")
            val battery = request.strictInt("batteryPercent")
            val charging = request.boolean("charging")
            val thermal = request.strictInt("thermalStatus")
            if ((request.hasNonNull("clear") && clear == null) ||
                (request.hasNonNull("batteryPercent") && (battery == null || battery !in 0..100)) ||
                (request.hasNonNull("charging") && charging == null) ||
                (request.hasNonNull("thermalStatus") && (thermal == null || thermal !in 0..6)) ||
                (clear != true && !request.hasKey("batteryPercent") && !request.hasKey("charging") && !request.hasKey("thermalStatus"))
            ) return@command invalidResult()
            if (clear == true) JunLuoCameraRuntimeConditions.clearDebugSimulation()
            else JunLuoCameraRuntimeConditions.setDebugSimulation(battery, charging, thermal)
            // Refresh an existing owner only. Never create a service for a Debug status change.
            if (JunLuoCameraProcessState.serviceAlive) {
                JunLuoCameraSessionServiceController.refreshResourceState(reactApplicationContext)
            }
            val snapshot = JunLuoCameraServiceStore.read(reactApplicationContext)
            JunLuoCameraServiceEventBus.publishHeartbeat(snapshot)
            return@command CommandResult(true, sessionId = snapshot.sessionId, revision = snapshot.revision)
        }
        val value = request.strictInt("value")
        if (mode !in setOf("advance_time", "reset_time", "force_opportunity") ||
            (mode == "advance_time" && (value == null || value !in 0..1440))
        ) return@command invalidResult()
        if (mode == "force_opportunity") {
            val snapshot = JunLuoCameraServiceStore.read(reactApplicationContext)
            if (snapshot.automaticObservation.phase == JunLuoCameraAutomaticPhase.EXECUTING) {
                return@command CommandResult(false, JunLuoCameraServiceErrorCodes.RESOURCE_BUSY)
            }
            val anchor = listOfNotNull(snapshot.lastSuccessfulObservationAt,
                snapshot.automaticObservation.anchorAt, snapshot.automaticObservation.lastAttemptAt).maxOrNull()
            val readyAt = anchor?.plus(snapshot.automaticObservation.minimumIntervalMinutes * 60_000L)
                ?: junLuoCameraAutomaticNow()
            JunLuoCameraAutomaticDebugClock.offsetMs += (readyAt - junLuoCameraAutomaticNow()).coerceAtLeast(0L)
        } else {
            JunLuoCameraAutomaticDebugClock.offsetMs = if (mode == "advance_time") value!!.toLong() * 60_000L else 0L
        }
        val updated = try {
            JunLuoCameraServiceStore.update(reactApplicationContext) { snapshot ->
                snapshot.copy(automaticObservation = recomputeAutomaticObservationState(
                    snapshot.automaticObservation, junLuoCameraAutomaticNow(),
                    snapshot.status == JunLuoCameraServiceStatus.RUNNING,
                ))
            }
        } catch (_: JunLuoCameraStatePersistException) {
            JunLuoCameraSessionServiceController.stop(reactApplicationContext, JunLuoCameraServiceErrorCodes.STATE_PERSIST_FAILED)
            return@command CommandResult(false, JunLuoCameraServiceErrorCodes.STATE_PERSIST_FAILED)
        }
        updated.sessionId?.let {
            JunLuoCameraSessionServiceController.refreshAutomaticSchedule(
                reactApplicationContext, it, updated.automaticObservation.scheduleGeneration,
            )
        }
        CommandResult(true, sessionId = updated.sessionId, status = updated.status.name.lowercase(), revision = updated.revision)
    }

    @ReactMethod
    fun captureObservationFrame(request: ReadableMap, promise: Promise) {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            handler.post { captureObservationFrame(request, promise) }
            return
        }
        val sessionId = request.string("sessionId") ?: return promise.resolve(failureMap(JunLuoCameraServiceErrorCodes.INVALID_BRIDGE_PAYLOAD))
        val requestId = request.string("requestId") ?: return promise.resolve(failureMap(JunLuoCameraServiceErrorCodes.INVALID_BRIDGE_PAYLOAD))
        val requestedAt = request.long("requestedAt") ?: return promise.resolve(failureMap(JunLuoCameraServiceErrorCodes.INVALID_BRIDGE_PAYLOAD))
        val automaticAttemptId = request.string("automaticAttemptId")
        val currentSnapshot = JunLuoCameraServiceStore.read(reactApplicationContext)
        if (automaticAttemptId != null) {
            val state = currentSnapshot.automaticObservation
            if (
                currentSnapshot.sessionId != sessionId || !state.enabled ||
                isAutomaticQuietAt(state, junLuoCameraAutomaticNow()) ||
                state.phase != JunLuoCameraAutomaticPhase.EXECUTING ||
                state.activeAttemptId != automaticAttemptId ||
                state.activeRequestId != requestId
            ) return promise.resolve(failureMap(JunLuoCameraServiceErrorCodes.AUTOMATIC_ATTEMPT_STALE))
        } else if (currentSnapshot.automaticObservation.phase == JunLuoCameraAutomaticPhase.EXECUTING) {
            return promise.resolve(failureMap(JunLuoCameraServiceErrorCodes.RESOURCE_BUSY))
        }
        val key = "$sessionId:$requestId"
        synchronized(pendingCaptures) {
            if (releasedCaptureKeys.containsKey(key)) {
                promise.resolve(failureMap(JunLuoCameraServiceErrorCodes.FRAME_ALREADY_RELEASED))
                return
            }
            completedCaptures[key]?.let { receipt ->
                promise.resolve(captureReceiptMap(receipt))
                return
            }
            pendingCaptures[key]?.let { pending ->
                pending.promises.add(promise)
                return
            }
            val captureGeneration = nextCaptureGeneration.incrementAndGet()
            val timeout = Runnable {
                val pending = synchronized(pendingCaptures) { pendingCaptures.remove(key) } ?: return@Runnable
                JunLuoCameraSessionServiceController.cancelCapture(
                    reactApplicationContext,
                    pending.sessionId,
                    pending.requestId,
                    pending.generation,
                )
                pending.promises.forEach { it.resolve(failureMap(JunLuoCameraServiceErrorCodes.BRIDGE_TIMEOUT)) }
            }
            pendingCaptures[key] = PendingCapture(sessionId, requestId, captureGeneration, mutableListOf(promise), timeout)
            handler.postDelayed(timeout, BRIDGE_CAPTURE_TIMEOUT_MS)
            val captureRequest = JunLuoCameraServiceCaptureRequest(
                sessionId,
                requestId,
                requestedAt,
                captureGeneration,
                if (automaticAttemptId == null) {
                    JunLuoCameraCaptureDeliveryMode.BRIDGE_EPHEMERAL
                } else {
                    JunLuoCameraCaptureDeliveryMode.AUTOMATIC_EPHEMERAL
                },
                automaticAttemptId,
            )
            val failureCode = when (val previewStart = JunLuoCameraPreviewCoordinator.captureForBridge(captureRequest)) {
                JunLuoCameraPreviewCaptureStart.Accepted -> null
                JunLuoCameraPreviewCaptureStart.NotAvailable -> when (val receipt =
                    JunLuoCameraSessionServiceController.captureOnceForBridge(reactApplicationContext, captureRequest)
                ) {
                    is JunLuoCameraServiceCommandReceipt.Accepted -> null
                    is JunLuoCameraServiceCommandReceipt.Rejected -> receipt.failureCode
                }
                is JunLuoCameraPreviewCaptureStart.Rejected -> previewStart.failureCode
            }
            if (failureCode != null) {
                pendingCaptures.remove(key)
                handler.removeCallbacks(timeout)
                promise.resolve(failureMap(failureCode))
            }
        }
    }

    @ReactMethod
    fun cancelObservationCapture(request: ReadableMap, promise: Promise) {
        val sessionId = request.string("sessionId") ?: return promise.resolve(failureMap(JunLuoCameraServiceErrorCodes.INVALID_BRIDGE_PAYLOAD))
        val requestId = request.string("requestId") ?: return promise.resolve(failureMap(JunLuoCameraServiceErrorCodes.INVALID_BRIDGE_PAYLOAD))
        val key = "$sessionId:$requestId"
        val pending = synchronized(pendingCaptures) { pendingCaptures[key] }
            ?: return promise.resolve(failureMap(JunLuoCameraErrorCodes.CAPTURE_CANCELLED))
        if (!JunLuoCameraPreviewCoordinator.cancelCapture(sessionId, requestId, pending.generation)) {
            JunLuoCameraSessionServiceController.cancelCapture(reactApplicationContext, sessionId, requestId, pending.generation)
        }
        promise.resolve(successMap())
    }

    @ReactMethod
    fun releaseObservationFrame(request: ReadableMap, promise: Promise) {
        val frameId = request.string("temporaryFrameId") ?: return promise.resolve(failureMap(JunLuoCameraServiceErrorCodes.INVALID_BRIDGE_PAYLOAD))
        val releaseToken = request.string("releaseToken") ?: return promise.resolve(failureMap(JunLuoCameraServiceErrorCodes.INVALID_BRIDGE_PAYLOAD))
        when (val result = JunLuoCameraBridgeFrameRegistry.release(frameId, releaseToken)) {
            is JunLuoCameraFrameReleaseResult.VerifiedDeleted -> {
                synchronized(pendingCaptures) {
                    completedCaptures.entries.firstOrNull { (_, receipt) ->
                        receipt is JunLuoCameraBridgeCaptureReceipt.Success && receipt.temporaryFrameId == frameId
                    }?.let { entry ->
                        completedCaptures.remove(entry.key)
                        releasedCaptureKeys[entry.key] = System.currentTimeMillis()
                        trimCaches()
                    }
                }
                promise.resolve(frameReleaseResultMap(result))
            }
            else -> promise.resolve(frameReleaseResultMap(result))
        }
    }

    @ReactMethod
    fun getTemporaryFramePrivacyState(promise: Promise) {
        promise.resolve(framePrivacyStateMap(JunLuoCameraTemporaryFileManager.snapshot(reactApplicationContext)))
    }

    @ReactMethod
    fun verifyTemporaryFrameCleanup(request: ReadableMap, promise: Promise) = command(request, promise) {
        val state = JunLuoCameraTemporaryFileManager.verifyCleanup(reactApplicationContext)
        CommandResult(
            ok = true,
            cleanupState = state.lastCleanupState.wireValue,
            deletionVerified = state.cacheEmpty && state.retryingFrameCount == 0,
        )
    }

    @ReactMethod
    fun awaitObservationFrameDeletion(request: ReadableMap, promise: Promise) {
        val frameId = request.string("temporaryFrameId")
            ?: return promise.resolve(failureMap(JunLuoCameraServiceErrorCodes.INVALID_BRIDGE_PAYLOAD))
        val releaseToken = request.string("releaseToken")
            ?: return promise.resolve(failureMap(JunLuoCameraServiceErrorCodes.INVALID_BRIDGE_PAYLOAD))
        val completed = AtomicBoolean(false)
        val timeout = Runnable {
            if (completed.compareAndSet(false, true)) {
                promise.resolve(frameReleaseResultMap(JunLuoCameraFrameReleaseResult.Failed))
            }
        }
        handler.postDelayed(timeout, FRAME_DELETION_AWAIT_TIMEOUT_MS)
        JunLuoCameraBridgeFrameRegistry.awaitDeletion(frameId, releaseToken) { result ->
            handler.post {
                if (completed.compareAndSet(false, true)) {
                    handler.removeCallbacks(timeout)
                    promise.resolve(frameReleaseResultMap(result))
                }
            }
        }
    }

    @ReactMethod
    fun getSensitiveCameraBackupPolicy(promise: Promise) {
        promise.resolve(sensitiveBackupPolicyMap(
            JunLuoCameraSensitiveBackupPolicyStore.get(reactApplicationContext),
        ))
    }

    @ReactMethod
    fun setSensitiveCameraBackupPolicy(request: ReadableMap, promise: Promise) = command(request, promise) {
        val consentGranted = request.boolean("consentGranted") ?: return@command invalidResult()
        val requestedAt = request.long("requestedAt") ?: return@command invalidResult()
        JunLuoCameraSensitiveBackupPolicyStore.set(
            reactApplicationContext, consentGranted, requestedAt,
        ).fold(
            onSuccess = { policy -> CommandResult(
                ok = true, consentGranted = policy.consentGranted, updatedAt = policy.updatedAt,
            ) },
            onFailure = { failure -> CommandResult(
                false,
                failure.message ?: JunLuoCameraServiceErrorCodes.SENSITIVE_BACKUP_POLICY_PERSIST_FAILED,
            ) },
        )
    }

    @ReactMethod
    fun runTemporaryFramePrivacyDebugSelfTest(request: ReadableMap, promise: Promise) = command(request, promise) {
        if (!BuildConfig.DEBUG) return@command CommandResult(
            false, JunLuoCameraServiceErrorCodes.FRAME_PRIVACY_STATE_UNAVAILABLE,
        )
        val mode = request.string("mode") ?: return@command invalidResult()
        if (mode == "create_orphan") {
            val state = JunLuoCameraTemporaryFileManager.createDebugOrphan(reactApplicationContext)
            return@command CommandResult(
                true, cleanupState = state.lastCleanupState.wireValue, deletionVerified = false,
            )
        }
        if (mode == "watchdog") {
            val state = JunLuoCameraTemporaryFileManager.createDebugWatchdogTest(reactApplicationContext)
            return@command CommandResult(
                true, cleanupState = state.lastCleanupState.wireValue, deletionVerified = false,
            )
        }
        val failures = when (mode) {
            "delete_now" -> 0
            "fail_once" -> 1
            "fail_all" -> 4
            else -> return@command invalidResult()
        }
        when (JunLuoCameraTemporaryFileManager.createDebugSelfTest(reactApplicationContext, failures)) {
            is JunLuoCameraManagedDeletionResult.VerifiedDeleted -> CommandResult(
                true, cleanupState = JunLuoCameraFrameCleanupState.VERIFIED_DELETED.wireValue,
                deletionVerified = true,
            )
            JunLuoCameraManagedDeletionResult.Retrying -> CommandResult(
                true, cleanupState = JunLuoCameraFrameCleanupState.RETRYING.wireValue,
                deletionVerified = false,
            )
            JunLuoCameraManagedDeletionResult.Failed -> CommandResult(
                false, JunLuoCameraServiceErrorCodes.FRAME_CLEANUP_FAILED,
                cleanupState = JunLuoCameraFrameCleanupState.FAILED.wireValue,
                deletionVerified = false,
            )
        }
    }

    @ReactMethod
    fun getManualSaveDestination(promise: Promise) {
        promise.resolve(manualSaveDestinationMap(JunLuoCameraManualSaveStore.get(reactApplicationContext)))
    }

    @ReactMethod
    fun openManualSaveDestinationPicker(request: ReadableMap, promise: Promise) = command(request, promise) {
        val activity = reactApplicationContext.currentActivity as? ComponentActivity
            ?: return@command CommandResult(false, JunLuoCameraServiceErrorCodes.VISIBLE_ACTIVITY_REQUIRED)
        if (!activity.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) {
            return@command CommandResult(false, JunLuoCameraServiceErrorCodes.VISIBLE_ACTIVITY_REQUIRED)
        }
        JunLuoCameraManualSavePickerActivity.open(activity).fold(
            onSuccess = { CommandResult(true) },
            onFailure = { CommandResult(false, JunLuoCameraErrorCodes.UNKNOWN) },
        )
    }

    @ReactMethod
    fun setManualSaveDestination(request: ReadableMap, promise: Promise) = command(request, promise) {
        val treeUri = request.string("directoryUri") ?: return@command invalidResult()
        val selectedAt = request.long("requestedAt") ?: return@command invalidResult()
        JunLuoCameraManualSaveStore.set(reactApplicationContext, treeUri, selectedAt).fold(
            onSuccess = { destination -> CommandResult(
                ok = true,
                destinationConfigured = destination.configured,
                destinationAvailable = destination.available,
                directoryDisplayName = destination.displayName,
                selectedAt = destination.selectedAt,
            ) },
            onFailure = { failure -> CommandResult(
                false,
                failure.message ?: JunLuoCameraErrorCodes.UNKNOWN,
            ) },
        )
    }

    @ReactMethod
    fun clearManualSaveDestination(request: ReadableMap, promise: Promise) = command(request, promise) {
        if (!JunLuoCameraManualSaveStore.clear(reactApplicationContext)) {
            CommandResult(false, JunLuoCameraServiceErrorCodes.STATE_PERSIST_FAILED)
        } else {
            CommandResult(
                ok = true,
                destinationConfigured = false,
                destinationAvailable = false,
            )
        }
    }

    @ReactMethod
    fun saveObservationFrameToDestination(request: ReadableMap, promise: Promise) {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            handler.post { saveObservationFrameToDestination(request, promise) }
            return
        }
        val commandId = request.string("commandId")
        val requestedAt = request.long("requestedAt")
        val actionId = request.string("actionId")
        val sessionId = request.string("sessionId")
        val requestId = request.string("requestId")
        val frameId = request.string("temporaryFrameId")
        val releaseToken = request.string("releaseToken")
        val fileName = request.string("fileName")
        if (
            commandId == null || requestedAt == null || actionId == null || sessionId == null || requestId == null ||
            frameId == null || releaseToken == null || fileName == null ||
            !commandId.matches(Regex("[A-Za-z0-9._-]{1,128}")) ||
            !actionId.matches(Regex("[A-Za-z0-9._-]{1,128}"))
        ) {
            promise.resolve(manualSaveResultMap(ManualSaveBridgeResult(false, JunLuoCameraServiceErrorCodes.INVALID_BRIDGE_PAYLOAD)))
            return
        }
        val fingerprint = request.toHashMap().toString()
        pruneManualSaveCache()
        synchronized(pendingManualSaves) {
            cachedManualSaves[commandId]?.let { cached ->
                promise.resolve(manualSaveResultMap(
                    if (cached.fingerprint == fingerprint) cached.result
                    else ManualSaveBridgeResult(false, JunLuoCameraServiceErrorCodes.INVALID_BRIDGE_PAYLOAD),
                ))
                return
            }
            pendingManualSaves[commandId]?.let { pending ->
                if (pending.fingerprint == fingerprint) {
                    pending.promises.add(promise)
                } else {
                    promise.resolve(manualSaveResultMap(ManualSaveBridgeResult(false, JunLuoCameraServiceErrorCodes.INVALID_BRIDGE_PAYLOAD)))
                }
                return
            }
        }
        val receipt = synchronized(pendingCaptures) {
            completedCaptures["$sessionId:$requestId"] as? JunLuoCameraBridgeCaptureReceipt.Success
        }
        if (receipt == null || receipt.temporaryFrameId != frameId || receipt.releaseToken != releaseToken) {
            promise.resolve(manualSaveResultMap(ManualSaveBridgeResult(false, JunLuoCameraServiceErrorCodes.STALE_SESSION)))
            return
        }
        val snapshot = JunLuoCameraSessionServiceController.readSnapshot(reactApplicationContext)
        if (
            snapshot.sessionId != sessionId || snapshot.status != JunLuoCameraServiceStatus.RUNNING ||
            snapshot.cameraState != JunLuoCameraServiceCameraState.PREVIEWING ||
            snapshot.cameraResourceOwner != JunLuoCameraResourceOwner.OBSERVATION_PREVIEW
        ) {
            promise.resolve(manualSaveResultMap(ManualSaveBridgeResult(false, JunLuoCameraServiceErrorCodes.MANUAL_SAVE_REQUIRES_PREVIEW)))
            return
        }
        val handle = JunLuoCameraBridgeFrameRegistry.claimForSave(frameId, releaseToken).getOrElse { failure ->
            promise.resolve(manualSaveResultMap(ManualSaveBridgeResult(
                false,
                failure.message ?: JunLuoCameraServiceErrorCodes.FRAME_PENDING_RELEASE,
            )))
            return
        }
        val pending = PendingManualSave(
            fingerprint,
            sessionId,
            frameId,
            releaseToken,
            AtomicBoolean(false),
            mutableListOf(promise),
        )
        synchronized(pendingManualSaves) { pendingManualSaves[commandId] = pending }
        manualSaveExecutor.execute {
            val nativeResult = runCatching {
                JunLuoCameraManualSaveStore.save(
                    reactApplicationContext,
                    handle,
                    fileName,
                    receipt.byteLength,
                    receipt.sha256,
                    pending.cancelled::get,
                )
            }.getOrElse {
                JunLuoCameraManualSaveResult.Failure(JunLuoCameraServiceErrorCodes.MANUAL_SAVE_WRITE_FAILED)
            }
            val releaseResult = JunLuoCameraBridgeFrameRegistry.release(
                frameId, releaseToken, JunLuoCameraFrameCleanupTrigger.EXPLICIT_SAVE,
            )
            JunLuoCameraBridgeFrameRegistry.finishSaveClaim(frameId)
            val cleanup = if (releaseResult is JunLuoCameraFrameReleaseResult.VerifiedDeleted) "released" else "retrying"
            val bridgeResult = when (nativeResult) {
                is JunLuoCameraManualSaveResult.Failure -> ManualSaveBridgeResult(false, nativeResult.failureCode)
                is JunLuoCameraManualSaveResult.Success -> ManualSaveBridgeResult(
                    ok = true,
                    actionId = actionId,
                    sessionId = sessionId,
                    requestId = requestId,
                    sourceKind = receipt.sourceKind,
                    capturedAt = receipt.capturedAt,
                    savedAt = nativeResult.savedAt,
                    fileName = nativeResult.fileName,
                    directoryDisplayName = nativeResult.directoryDisplayName,
                    width = receipt.width,
                    height = receipt.height,
                    rotation = receipt.rotation,
                    mirrored = receipt.mirrored,
                    byteLength = nativeResult.byteLength,
                    sha256 = nativeResult.sha256,
                    sourceFrameCleanup = cleanup,
                    consentSource = "explicit_manual_save_confirmation",
                    longTermStorage = "user_selected_saf_directory",
                )
            }
            handler.post {
                val completed = synchronized(pendingManualSaves) {
                    val activeSave = pendingManualSaves.remove(commandId)
                    cachedManualSaves[commandId] = CachedManualSave(fingerprint, bridgeResult, System.currentTimeMillis())
                    trimManualSaveCache()
                    activeSave
                }
                synchronized(pendingCaptures) {
                    completedCaptures.remove("$sessionId:$requestId")
                    releasedCaptureKeys["$sessionId:$requestId"] = System.currentTimeMillis()
                    trimCaches()
                }
                completed?.promises?.forEach { it.resolve(manualSaveResultMap(bridgeResult)) }
            }
        }
    }

    @ReactMethod
    fun acquireCameraResource(request: ReadableMap, promise: Promise) = command(request, promise) {
        val owner = JunLuoCameraResourceOwner.fromWireValue(request.string("owner")) ?: return@command invalidResult()
        JunLuoCameraPreviewCoordinator.suspendForManualCamera()?.let { failureCode ->
            return@command CommandResult(false, failureCode)
        }
        when (val receipt = JunLuoCameraResourceArbiter.acquireManual(
            reactApplicationContext,
            owner,
            bridgeGeneration,
        )) {
            is JunLuoCameraResourceReceipt.Accepted -> {
                JunLuoCameraSessionServiceController.refreshResourceState(reactApplicationContext)
                CommandResult(
                    true,
                    sessionId = receipt.snapshot.sessionId,
                    status = receipt.snapshot.status.name.lowercase(),
                    revision = receipt.snapshot.revision,
                    leaseId = receipt.lease.leaseId,
                    owner = receipt.lease.owner.wireValue,
                )
            }
            is JunLuoCameraResourceReceipt.Rejected -> CommandResult(false, receipt.failureCode)
        }
    }

    @ReactMethod
    fun releaseCameraResource(request: ReadableMap, promise: Promise) = command(request, promise) {
        val owner = JunLuoCameraResourceOwner.fromWireValue(request.string("owner")) ?: return@command invalidResult()
        val leaseId = request.string("leaseId") ?: return@command invalidResult()
        when (val receipt = JunLuoCameraResourceArbiter.release(reactApplicationContext, owner, leaseId)) {
            is JunLuoCameraResourceReceipt.Accepted -> {
                JunLuoCameraSessionServiceController.refreshResourceState(reactApplicationContext)
                CommandResult(
                    true,
                    sessionId = receipt.snapshot.sessionId,
                    status = receipt.snapshot.status.name.lowercase(),
                    revision = receipt.snapshot.revision,
                    leaseId = leaseId,
                    owner = owner.wireValue,
                )
            }
            is JunLuoCameraResourceReceipt.Rejected -> CommandResult(false, receipt.failureCode)
        }
    }

    @ReactMethod
    fun openObservationNotificationSettings(promise: Promise) {
        runCatching {
            JunLuoCameraServiceNotifications.openSettingsIntent(reactApplicationContext)
                .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
                .let(reactApplicationContext::startActivity)
        }.onSuccess { promise.resolve(successMap()) }
            .onFailure { promise.resolve(failureMap(JunLuoCameraServiceErrorCodes.NOTIFICATION_CHANNEL_BLOCKED)) }
    }

    @ReactMethod fun addListener(eventName: String) = Unit
    @ReactMethod fun removeListeners(count: Int) = Unit

    override fun onSessionSnapshot(snapshot: JunLuoCameraServiceSnapshot) {
        if (snapshot.status == JunLuoCameraServiceStatus.STOPPED) {
            synchronized(pendingManualSaves) {
                pendingManualSaves.values.filter { pending ->
                    pending.sessionId == snapshot.lastSessionId || pending.sessionId == snapshot.sessionId
                }.forEach { it.cancelled.set(true) }
            }
        }
        emit(EVENT_STATE, snapshotMap(snapshot))
    }

    override fun onHeartbeat(snapshot: JunLuoCameraServiceSnapshot) = emit(EVENT_HEARTBEAT, Arguments.createMap().apply {
        putDouble("revision", snapshot.revision.toDouble())
        putNullableString("sessionId", snapshot.sessionId)
        putNullableDouble("lastHeartbeatAt", snapshot.lastHeartbeatAt)
    })

    override fun onCaptureReceipt(receipt: JunLuoCameraBridgeCaptureReceipt) {
        val map = captureReceiptMap(receipt)
        emit(EVENT_CAPTURE, map)
        val key = "${receipt.sessionId}:${receipt.requestId}"
        val pending = synchronized(pendingCaptures) {
            completedCaptures[key] = receipt
            trimCaches()
            pendingCaptures.remove(key)
        } ?: return
        handler.removeCallbacks(pending.timeout)
        pending.promises.forEach { it.resolve(captureReceiptMap(receipt)) }
    }

    override fun onFramePrivacyState(state: JunLuoCameraFramePrivacyState) {
        emit(EVENT_PRIVACY, framePrivacyStateMap(state))
    }

    override fun onHostResume() {
        JunLuoCameraResourceArbiter.recoverLostManualLease(
            reactApplicationContext,
            bridgeGeneration,
            activityResumed = true,
        )?.let { JunLuoCameraSessionServiceController.refreshResourceState(reactApplicationContext) }
    }

    override fun onHostPause() = Unit
    override fun onHostDestroy() = Unit

    override fun invalidate() {
        if (invalidated) return
        invalidated = true
        JunLuoCameraServiceEventBus.removeListener(this)
        reactApplicationContext.removeLifecycleEventListener(this)
        JunLuoCameraResourceArbiter.invalidateBridgeGeneration(bridgeGeneration)
        JunLuoCameraPreviewCoordinator.invalidateBridge()
        JunLuoCameraBridgeFrameRegistry.releaseAll(JunLuoCameraFrameCleanupTrigger.BRIDGE_INVALIDATED)
        synchronized(pendingCaptures) {
            pendingCaptures.values.forEach { pending ->
                handler.removeCallbacks(pending.timeout)
                JunLuoCameraSessionServiceController.cancelCapture(
                    reactApplicationContext,
                    pending.sessionId,
                    pending.requestId,
                    pending.generation,
                )
                pending.promises.forEach { it.resolve(failureMap(JunLuoCameraErrorCodes.CAPTURE_CANCELLED)) }
            }
            pendingCaptures.clear()
        }
        synchronized(pendingManualSaves) {
            pendingManualSaves.values.forEach { it.cancelled.set(true) }
        }
        manualSaveExecutor.shutdown()
        super.invalidate()
    }

    private fun command(request: ReadableMap, promise: Promise, block: () -> CommandResult?): Unit {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            handler.post { command(request, promise, block) }
            return
        }
        val commandId = request.string("commandId")
        val requestedAt = request.long("requestedAt")
        if (commandId == null || requestedAt == null || !commandId.matches(Regex("[A-Za-z0-9._-]{1,128}"))) {
            promise.resolve(failureMap(JunLuoCameraServiceErrorCodes.INVALID_BRIDGE_PAYLOAD))
            return
        }
        pruneCommandCache()
        val fingerprint = request.toHashMap().toString()
        commandCache[commandId]?.let { cached ->
            promise.resolve(commandResultMap(
                if (cached.fingerprint == fingerprint) cached.result else invalidResult(),
            ))
            return
        }
        block()?.let { result ->
            commandCache[commandId] = CachedCommand(fingerprint, result, System.currentTimeMillis())
            trimCaches()
            promise.resolve(commandResultMap(result))
        }
    }

    private fun resolveAndCache(request: ReadableMap, promise: Promise, result: CommandResult) {
        val commandId = request.string("commandId") ?: return promise.resolve(failureMap(JunLuoCameraServiceErrorCodes.INVALID_BRIDGE_PAYLOAD))
        commandCache[commandId] = CachedCommand(request.toHashMap().toString(), result, System.currentTimeMillis())
        trimCaches()
        promise.resolve(commandResultMap(result))
    }

    private fun runtimeConditionsMap(state: JunLuoCameraRuntimeConditionsSnapshot): WritableMap = Arguments.createMap().apply {
        state.batteryPercent?.let { putInt("batteryPercent", it) } ?: putNull("batteryPercent")
        state.charging?.let { putBoolean("charging", it) } ?: putNull("charging")
        state.thermalStatus?.let { putInt("thermalStatus", it) } ?: putNull("thermalStatus")
        putBoolean("lowBatteryPaused", state.lowBatteryPaused)
        putBoolean("thermalPaused", state.thermalPaused)
        state.powerSaveMode?.let { putBoolean("powerSaveMode", it) } ?: putNull("powerSaveMode")
        state.batteryOptimizationExempt?.let { putBoolean("batteryOptimizationExempt", it) } ?: putNull("batteryOptimizationExempt")
        state.backgroundRestricted?.let { putBoolean("backgroundRestricted", it) } ?: putNull("backgroundRestricted")
        state.cameraPrivacyToggleSupported?.let { putBoolean("cameraPrivacyToggleSupported", it) } ?: putNull("cameraPrivacyToggleSupported")
        putDouble("checkedAt", state.checkedAt.toDouble())
        putBoolean("simulated", state.simulated)
    }

    private fun snapshotMap(snapshot: JunLuoCameraServiceSnapshot): WritableMap = Arguments.createMap().apply {
        putBoolean("ok", true)
        putInt("schemaVersion", snapshot.schemaVersion)
        putString("modelObservationMode", JUNLUO_CAMERA_MODEL_OBSERVATION_MODE)
        putBoolean("networkAvailable", JunLuoCameraAutomaticObservationScheduler.networkAvailable(reactApplicationContext))
        putDouble("revision", snapshot.revision.toDouble())
        putString("status", snapshot.status.name.lowercase())
        putNullableString("sessionId", snapshot.sessionId)
        putNullableString("lastSessionId", snapshot.lastSessionId)
        putNullableString("sourceKind", snapshot.sourceKind)
        putNullableDouble("startedAt", snapshot.startedAt)
        putNullableDouble("lastHeartbeatAt", snapshot.lastHeartbeatAt)
        putNullableDouble("hardDeadlineAt", snapshot.hardDeadlineAt)
        putNullableDouble("lastSuccessfulObservationAt", snapshot.lastSuccessfulObservationAt)
        putBoolean("cameraReady", snapshot.cameraReady)
        putString("cameraState", snapshot.cameraState.name.lowercase())
        putNullableString("activeCaptureRequestId", snapshot.activeCaptureRequestId)
        putBoolean("persistentNotificationVisible", snapshot.persistentNotificationVisible)
        putNullableString("lastFailureCode", snapshot.lastFailureCode)
        putNullableString("stopReasonCode", snapshot.stopReasonCode)
        putNullableString("cameraResourceOwner", snapshot.cameraResourceOwner?.wireValue)
        putNullableString("cameraResourceLeaseId", snapshot.cameraResourceLeaseId)
        putNullableDouble("cameraResourcePausedAt", snapshot.cameraResourcePausedAt)
        putMap("automaticObservation", Arguments.createMap().apply {
            val automatic = snapshot.automaticObservation
            putBoolean("enabled", automatic.enabled)
            putString("phase", automatic.phase.wireValue)
            putDouble("scheduleGeneration", automatic.scheduleGeneration.toDouble())
            putNullableDouble("anchorAt", automatic.anchorAt)
            putNullableDouble("nextOpportunityAt", automatic.nextOpportunityAt)
            putNullableDouble("hardDeadlineAt", automatic.hardDeadlineAt)
            putNullableDouble("resumeAt", automatic.resumeAt)
            putNullableString("activeAttemptId", automatic.activeAttemptId)
            putNullableString("activeRequestId", automatic.activeRequestId)
            putNullableString("activeTriggerKind", automatic.activeTriggerKind?.wireValue)
            putBoolean("activeRetryUsed", automatic.activeRetryUsed)
            putInt("consecutiveFailureCount", automatic.consecutiveFailureCount)
            putNullableDouble("nextRetryAt", automatic.nextRetryAt)
            putNullableDouble("lastAttemptAt", automatic.lastAttemptAt)
            putNullableString("lastAttemptTriggerKind", automatic.lastAttemptTriggerKind?.wireValue)
            putNullableString("lastFailureCode", automatic.lastFailureCode)
            putDouble("overdueByMs", automatic.overdueByMs.toDouble())
        })
    }

    private fun captureReceiptMap(receipt: JunLuoCameraBridgeCaptureReceipt): WritableMap = Arguments.createMap().apply {
        putString("sessionId", receipt.sessionId)
        putString("requestId", receipt.requestId)
        putDouble("captureGeneration", receipt.captureGeneration.toDouble())
        when (receipt) {
            is JunLuoCameraBridgeCaptureReceipt.Failure -> {
                putBoolean("ok", false)
                putString("failureCode", receipt.failureCode)
            }
            is JunLuoCameraBridgeCaptureReceipt.Success -> {
                putBoolean("ok", true)
                putDouble("revision", receipt.revision.toDouble())
                putString("sourceKind", receipt.sourceKind)
                putDouble("capturedAt", receipt.capturedAt.toDouble())
                putString("temporaryUri", receipt.temporaryUri)
                putString("temporaryFrameId", receipt.temporaryFrameId)
                putString("releaseToken", receipt.releaseToken)
                putInt("width", receipt.width)
                putInt("height", receipt.height)
                putInt("rotation", receipt.rotation)
                putBoolean("mirrored", receipt.mirrored)
                putString("sha256", receipt.sha256)
                putDouble("byteLength", receipt.byteLength.toDouble())
            }
        }
    }

    private fun commandResultMap(result: CommandResult): WritableMap = Arguments.createMap().apply {
        putBoolean("ok", result.ok)
        putNullableString("failureCode", result.failureCode)
        putNullableString("sessionId", result.sessionId)
        putNullableString("status", result.status)
        result.revision?.let { putDouble("revision", it.toDouble()) }
        putNullableString("leaseId", result.leaseId)
        putNullableString("owner", result.owner)
        putNullableString("cleanupState", result.cleanupState)
        result.deletionVerified?.let { putBoolean("deletionVerified", it) }
        result.alreadyDeleted?.let { putBoolean("alreadyDeleted", it) }
        result.auditPersisted?.let { putBoolean("auditPersisted", it) }
        result.destinationConfigured?.let { putBoolean("configured", it) }
        result.destinationAvailable?.let { putBoolean("available", it) }
        putNullableString("directoryDisplayName", result.directoryDisplayName)
        putNullableDouble("selectedAt", result.selectedAt)
        result.consentGranted?.let { putBoolean("consentGranted", it) }
        putNullableDouble("updatedAt", result.updatedAt)
    }

    private fun manualSaveDestinationMap(destination: JunLuoCameraManualSaveDestination): WritableMap = Arguments.createMap().apply {
        putBoolean("ok", true)
        putBoolean("configured", destination.configured)
        putBoolean("available", destination.available)
        putNullableString("directoryDisplayName", destination.displayName)
        putNullableDouble("selectedAt", destination.selectedAt)
    }

    private fun manualSaveResultMap(result: ManualSaveBridgeResult): WritableMap = Arguments.createMap().apply {
        putBoolean("ok", result.ok)
        putNullableString("failureCode", result.failureCode)
        putNullableString("actionId", result.actionId)
        putNullableString("sessionId", result.sessionId)
        putNullableString("requestId", result.requestId)
        putNullableString("sourceKind", result.sourceKind)
        putNullableDouble("capturedAt", result.capturedAt)
        putNullableDouble("savedAt", result.savedAt)
        putNullableString("fileName", result.fileName)
        putNullableString("directoryDisplayName", result.directoryDisplayName)
        result.width?.let { putInt("width", it) }
        result.height?.let { putInt("height", it) }
        result.rotation?.let { putInt("rotation", it) }
        result.mirrored?.let { putBoolean("mirrored", it) }
        putNullableDouble("byteLength", result.byteLength)
        putNullableString("sha256", result.sha256)
        putNullableString("mimeType", if (result.ok) "image/jpeg" else null)
        if (result.ok) putBoolean("destinationVerified", true)
        putNullableString("sourceFrameCleanup", result.sourceFrameCleanup)
        putNullableString("consentSource", result.consentSource)
        putNullableString("longTermStorage", result.longTermStorage)
    }

    private fun frameReleaseResultMap(result: JunLuoCameraFrameReleaseResult): WritableMap = when (result) {
        is JunLuoCameraFrameReleaseResult.VerifiedDeleted -> commandResultMap(CommandResult(
            ok = true,
            cleanupState = JunLuoCameraFrameCleanupState.VERIFIED_DELETED.wireValue,
            deletionVerified = true,
            alreadyDeleted = result.alreadyDeleted,
            auditPersisted = result.auditPersisted,
        ))
        JunLuoCameraFrameReleaseResult.Retrying -> commandResultMap(CommandResult(
            ok = true,
            failureCode = JunLuoCameraServiceErrorCodes.FRAME_CLEANUP_RETRYING,
            cleanupState = JunLuoCameraFrameCleanupState.RETRYING.wireValue,
            deletionVerified = false,
            alreadyDeleted = false,
        ))
        JunLuoCameraFrameReleaseResult.Failed -> commandResultMap(CommandResult(
            ok = false,
            failureCode = JunLuoCameraServiceErrorCodes.FRAME_CLEANUP_FAILED,
            cleanupState = JunLuoCameraFrameCleanupState.FAILED.wireValue,
            deletionVerified = false,
            alreadyDeleted = false,
        ))
        is JunLuoCameraFrameReleaseResult.Rejected -> failureMap(result.failureCode)
    }

    private fun framePrivacyStateMap(state: JunLuoCameraFramePrivacyState): WritableMap = Arguments.createMap().apply {
        putBoolean("ok", true)
        putInt("schemaVersion", state.schemaVersion)
        putInt("activeFrameCount", state.activeFrameCount)
        putInt("retryingFrameCount", state.retryingFrameCount)
        putInt("orphanFrameCount", state.orphanFrameCount)
        putBoolean("cacheEmpty", state.cacheEmpty)
        putNullableDouble("lastCleanupAt", state.lastCleanupAt)
        putString("lastCleanupState", state.lastCleanupState.wireValue)
        putNullableString("lastCleanupTrigger", state.lastCleanupTrigger?.wireValue)
        putInt("startupOrphansDeleted", state.startupOrphansDeleted)
        putBoolean("auditAvailable", state.auditAvailable)
        state.latestProof?.let { proof ->
            putMap("latestProof", Arguments.createMap().apply {
                putString("proofId", proof.proofId)
                putDouble("completedAt", proof.completedAt.toDouble())
                putString("trigger", proof.trigger.wireValue)
                putNullableDouble("byteLength", proof.byteLength)
                putNullableString("sha256Prefix", proof.sha256Prefix)
                putInt("attemptCount", proof.attemptCount)
                putBoolean("deletionVerified", proof.deletionVerified)
                putBoolean("orphanRecovered", proof.orphanRecovered)
            })
        }
    }

    private fun sensitiveBackupPolicyMap(policy: JunLuoCameraSensitiveBackupPolicy): WritableMap =
        Arguments.createMap().apply {
            putBoolean("ok", true)
            putInt("schemaVersion", policy.schemaVersion)
            putBoolean("consentGranted", policy.consentGranted)
            putNullableDouble("updatedAt", policy.updatedAt)
        }

    private fun successMap() = commandResultMap(CommandResult(true))
    private fun failureMap(code: String) = commandResultMap(CommandResult(false, code))
    private fun invalidResult() = CommandResult(false, JunLuoCameraServiceErrorCodes.INVALID_BRIDGE_PAYLOAD)
    private fun parseFacing(value: String?): JunLuoCameraFacing? = when (value?.lowercase()) {
        "front", "android_front" -> JunLuoCameraFacing.FRONT
        "back", "android_back" -> JunLuoCameraFacing.BACK
        else -> null
    }

    private fun emit(name: String, payload: WritableMap) {
        if (invalidated || !reactApplicationContext.hasActiveReactInstance()) return
        reactApplicationContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit(name, payload)
    }

    private fun hasPermission(permission: String): Boolean =
        ContextCompat.checkSelfPermission(reactApplicationContext, permission) == PackageManager.PERMISSION_GRANTED

    private fun pruneCommandCache(now: Long = System.currentTimeMillis()) {
        commandCache.entries.removeAll { now - it.value.createdAt > COMMAND_CACHE_TTL_MS }
        releasedCaptureKeys.entries.removeAll { now - it.value > COMMAND_CACHE_TTL_MS }
    }

    private fun pruneManualSaveCache(now: Long = System.currentTimeMillis()) {
        cachedManualSaves.entries.removeAll { now - it.value.createdAt > COMMAND_CACHE_TTL_MS }
    }

    private fun trimManualSaveCache() {
        pruneManualSaveCache()
        while (cachedManualSaves.size > COMMAND_CACHE_LIMIT) cachedManualSaves.remove(cachedManualSaves.keys.first())
    }

    private fun trimCaches() {
        pruneCommandCache()
        while (commandCache.size > COMMAND_CACHE_LIMIT) commandCache.remove(commandCache.keys.first())
        while (completedCaptures.size > COMMAND_CACHE_LIMIT) completedCaptures.remove(completedCaptures.keys.first())
        while (releasedCaptureKeys.size > COMMAND_CACHE_LIMIT) releasedCaptureKeys.remove(releasedCaptureKeys.keys.first())
    }

    private fun ReadableMap.string(key: String): String? =
        if (hasNonNull(key) && getType(key) == ReadableType.String) getString(key) else null
    private fun ReadableMap.long(key: String): Long? =
        if (hasNonNull(key) && getType(key) == ReadableType.Number) getDouble(key).toLong().takeIf { it > 0L } else null
    private fun ReadableMap.boolean(key: String): Boolean? =
        if (hasNonNull(key) && getType(key) == ReadableType.Boolean) getBoolean(key) else null
    private fun ReadableMap.map(key: String): ReadableMap? =
        if (hasNonNull(key) && getType(key) == ReadableType.Map) getMap(key) else null
    private fun ReadableMap.hasNonNull(key: String): Boolean = hasKey(key) && !isNull(key)
    private fun ReadableMap.strictInt(key: String): Int? {
        if (!hasNonNull(key) || getType(key) != ReadableType.Number) return null
        val value = getDouble(key)
        if (!value.isFinite() || value % 1.0 != 0.0 || value < Int.MIN_VALUE || value > Int.MAX_VALUE) return null
        return value.toInt()
    }
    private fun ReadableMap.strictPositiveLong(key: String): Long? {
        if (!hasNonNull(key) || getType(key) != ReadableType.Number) return null
        val value = getDouble(key)
        if (!value.isFinite() || value % 1.0 != 0.0 || value <= 0.0 || value > Long.MAX_VALUE.toDouble()) return null
        return value.toLong()
    }
    private fun ReadableMap.strictNonNegativeLong(key: String): Long? {
        if (!hasNonNull(key) || getType(key) != ReadableType.Number) return null
        val value = getDouble(key)
        if (!value.isFinite() || value % 1.0 != 0.0 || value < 0.0 || value > Long.MAX_VALUE.toDouble()) return null
        return value.toLong()
    }
    private fun WritableMap.putNullableString(key: String, value: String?) = if (value == null) putNull(key) else putString(key, value)
    private fun WritableMap.putNullableDouble(key: String, value: Long?) = if (value == null) putNull(key) else putDouble(key, value.toDouble())
}
