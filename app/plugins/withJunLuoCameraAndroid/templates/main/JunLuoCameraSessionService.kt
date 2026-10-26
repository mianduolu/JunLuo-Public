package __PACKAGE_NAME__.camera

import android.Manifest
import android.app.NotificationManager
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import java.io.File

class JunLuoCameraSessionService : Service(), LifecycleOwner {
    override val lifecycle: Lifecycle
        get() = lifecycleRegistry

    private val lifecycleRegistry = LifecycleRegistry(this)
    private val mainHandler = Handler(Looper.getMainLooper())
    private var cameraCore: JunLuoCameraCore? = null
    private var activeSessionId: String? = null
    private var activeFacing: JunLuoCameraFacing? = null
    private var activeCaptureRequestId: String? = null
    private var activeCaptureGeneration: Long = 0L
    private var activeCaptureDeliveryMode = JunLuoCameraCaptureDeliveryMode.AUDIT_ONLY
    private var activeObservationLeaseId: String? = null
    private var activeCaptureOutputFile: File? = null
    private var pendingCaptureRunnable: Runnable? = null
    private var generation = 0L
    private var terminating = false
    private var lifecycleStarted = false
    private var lifecycleDestroyed = false
    private var lastHeartbeatWriteAt = 0L
    private var latestStartId = 0
    private lateinit var automaticScheduler: JunLuoCameraAutomaticObservationScheduler
    private var timeReceiverRegistered = false
    private var networkCallbackRegistered = false
    private var lastRuntimeConditions: JunLuoCameraRuntimeConditionsSnapshot? = null
    @Volatile private var networkValidated = false
    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
            val validated = capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
                capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
            val recovered = validated && !networkValidated
            networkValidated = validated
            if (recovered) requestPrerequisiteRecoveryCheck()
        }

        override fun onLost(network: Network) {
            networkValidated = false
        }
    }
    private val timeChangeReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            try {
                if (
                    intent?.action == Intent.ACTION_TIME_CHANGED ||
                    intent?.action == Intent.ACTION_TIMEZONE_CHANGED
                ) {
                    val failureCode = runtimeGateFailure()
                    if (activeSessionId != null && failureCode != null) {
                        terminate(failureCode, failureCode, abnormal = true)
                    } else {
                        automaticScheduler.tick()
                    }
                }
            } catch (_: JunLuoCameraStatePersistException) {
                failClosedAfterPersistenceFailure()
            }
        }
    }

    private val monitorRunnable = object : Runnable {
        override fun run() {
            try {
                if (terminating || activeSessionId == null) return
                val failureCode = runtimeGateFailure()
                if (failureCode != null) {
                    terminate(failureCode, failureCode, abnormal = true)
                    return
                }
                refreshRuntimeConditions()
                val now = System.currentTimeMillis()
                if (now - lastHeartbeatWriteAt >= JUNLUO_CAMERA_SERVICE_HEARTBEAT_INTERVAL_MS) {
                    val heartbeat = JunLuoCameraServiceStore.update(this@JunLuoCameraSessionService) { snapshot ->
                        snapshot.copy(lastHeartbeatAt = now)
                    }
                    JunLuoCameraServiceEventBus.publishHeartbeat(heartbeat)
                    lastHeartbeatWriteAt = now
                }
                automaticScheduler.tick()
                if (!terminating) mainHandler.postDelayed(this, JUNLUO_CAMERA_SERVICE_CHECK_INTERVAL_MS)
            } catch (_: JunLuoCameraStatePersistException) {
                failClosedAfterPersistenceFailure()
            }
        }
    }

    override fun onCreate() {
        super.onCreate()
        JunLuoCameraProcessState.serviceAlive = true
        lifecycleRegistry.handleLifecycleEvent(Lifecycle.Event.ON_CREATE)
        JunLuoCameraServiceNotifications.ensureChannel(this)
        automaticScheduler = JunLuoCameraAutomaticObservationScheduler(
            this,
            mainHandler,
            ::refreshNotificationFromSnapshot,
            ::failClosedAfterPersistenceFailure,
        )
        JunLuoCameraRuntimeConditions.start(this) {
            mainHandler.post {
                if (!terminating && activeSessionId != null) {
                    try {
                        refreshRuntimeConditions()
                    } catch (_: JunLuoCameraStatePersistException) {
                        failClosedAfterPersistenceFailure()
                    }
                }
            }
        }
        ContextCompat.registerReceiver(
            this,
            timeChangeReceiver,
            IntentFilter().apply {
                addAction(Intent.ACTION_TIME_CHANGED)
                addAction(Intent.ACTION_TIMEZONE_CHANGED)
            },
            ContextCompat.RECEIVER_NOT_EXPORTED,
        )
        timeReceiverRegistered = true
        val connectivityManager = getSystemService(ConnectivityManager::class.java)
        val activeNetwork = connectivityManager.activeNetwork
        networkValidated = activeNetwork != null && connectivityManager.getNetworkCapabilities(activeNetwork)?.let {
            it.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
                it.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
        } == true
        networkCallbackRegistered = runCatching {
            connectivityManager.registerDefaultNetworkCallback(networkCallback)
            true
        }.getOrDefault(false)
        clearOnDemandCache()
        JunLuoCameraBridgeFrameRegistry.cleanupOrphans(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        latestStartId = startId
        try {
            when (intent?.action) {
                ACTION_START -> handleStart(intent)
                ACTION_CAPTURE_ONCE -> handleCaptureOnce(intent)
                ACTION_SWITCH_FACING -> handleSwitchFacing(intent)
                ACTION_CANCEL_CAPTURE -> handleCancelCapture(intent)
                ACTION_RESOURCE_STATE_CHANGED -> {
                    refreshRuntimeConditions()
                    refreshNotificationFromSnapshot()
                    automaticScheduler.prerequisiteMayHaveRecovered()
                }
                ACTION_AUTOMATIC_TICK -> {
                    val snapshot = JunLuoCameraServiceStore.read(this)
                    val sessionId = intent.getStringExtra(EXTRA_SESSION_ID)
                    val scheduleGeneration = intent.getLongExtra(EXTRA_AUTOMATIC_GENERATION, Long.MIN_VALUE)
                    val failureCode = runtimeGateFailure()
                    if (activeSessionId != null && failureCode != null) {
                        terminate(failureCode, failureCode, abnormal = true)
                    } else if (
                        activeSessionId == sessionId &&
                        snapshot.automaticObservation.scheduleGeneration == scheduleGeneration
                    ) automaticScheduler.tick()
                }
                ACTION_STOP -> terminate(
                    intent.getStringExtra(EXTRA_STOP_REASON)?.takeIf { it.isNotBlank() } ?: "manual_stop",
                    failureCode = null,
                    abnormal = false,
                )
                else -> terminate(
                    JunLuoCameraServiceErrorCodes.PROCESS_TERMINATED,
                    JunLuoCameraServiceErrorCodes.PROCESS_TERMINATED,
                    abnormal = true,
                )
            }
        } catch (_: JunLuoCameraStatePersistException) {
            failClosedAfterPersistenceFailure()
        }
        return START_NOT_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onTaskRemoved(rootIntent: Intent?) {
        try {
            terminate("task_removed", failureCode = null, abnormal = false)
        } catch (_: JunLuoCameraStatePersistException) {
            failClosedAfterPersistenceFailure()
        }
        super.onTaskRemoved(rootIntent)
    }

    override fun onLowMemory() {
        try {
            terminate("system_low_memory", failureCode = null, abnormal = false)
        } catch (_: JunLuoCameraStatePersistException) {
            failClosedAfterPersistenceFailure()
        }
        super.onLowMemory()
    }

    override fun onDestroy() {
        try {
            if (!terminating && isActiveCameraServiceStatus(JunLuoCameraServiceStore.read(this).status)) {
                terminate(
                    JunLuoCameraServiceErrorCodes.PROCESS_TERMINATED,
                    JunLuoCameraServiceErrorCodes.PROCESS_TERMINATED,
                    abnormal = true,
                    stopService = false,
                )
            }
        } catch (_: JunLuoCameraStatePersistException) {
            failClosedAfterPersistenceFailure()
        }
        releaseOwnedResources()
        JunLuoCameraRuntimeConditions.stopMonitoring()
        JunLuoCameraRuntimeConditions.clearDebugSimulation()
        if (timeReceiverRegistered) {
            runCatching { unregisterReceiver(timeChangeReceiver) }
            timeReceiverRegistered = false
        }
        if (networkCallbackRegistered) {
            runCatching {
                getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(networkCallback)
            }
            networkCallbackRegistered = false
        }
        if (!lifecycleDestroyed) {
            lifecycleRegistry.handleLifecycleEvent(Lifecycle.Event.ON_DESTROY)
            lifecycleDestroyed = true
        }
        JunLuoCameraProcessState.serviceAlive = false
        JunLuoCameraProcessState.pendingSessionId = null
        super.onDestroy()
    }

    private fun requestPrerequisiteRecoveryCheck() {
        mainHandler.post {
            if (!terminating && activeSessionId != null && ::automaticScheduler.isInitialized) {
                automaticScheduler.prerequisiteMayHaveRecovered()
            }
        }
    }

    private fun refreshRuntimeConditions() {
        val conditions = JunLuoCameraRuntimeConditions.read(this)
        val comparable = conditions.copy(checkedAt = 0L)
        if (conditions.thermalPaused) JunLuoCameraPreviewCoordinator.pauseForThermal()
        val requestId = activeCaptureRequestId
        val sessionId = activeSessionId
        if (requestId != null && sessionId != null) {
            conditions.captureFailure(
                automatic = activeCaptureDeliveryMode == JunLuoCameraCaptureDeliveryMode.AUTOMATIC_EPHEMERAL,
            )?.let { failure ->
                failOnDemandCapture(JunLuoCameraServiceCaptureRequest(
                    sessionId, requestId, System.currentTimeMillis(), activeCaptureGeneration,
                    activeCaptureDeliveryMode,
                ), failure)
            }
        }
        if (lastRuntimeConditions != comparable) {
            lastRuntimeConditions = comparable
            // This event requests a fresh read; it does not manufacture a new persisted heartbeat.
            JunLuoCameraServiceEventBus.publishHeartbeat(JunLuoCameraServiceStore.read(this))
            refreshNotificationFromSnapshot()
        }
    }

    private fun handleStart(intent: Intent) {
        val request = JunLuoCameraSessionServiceController.requestFromIntent(intent)
        if (request == null) {
            terminate(
                JunLuoCameraServiceErrorCodes.INVALID_SESSION_REQUEST,
                JunLuoCameraServiceErrorCodes.INVALID_SESSION_REQUEST,
                abnormal = true,
            )
            return
        }
        if (activeSessionId == request.sessionId && !terminating) {
            return
        }
        if (activeSessionId != null && activeSessionId != request.sessionId) {
            return
        }
        runtimeGateFailure()?.let { failureCode ->
            terminate(failureCode, failureCode, abnormal = true)
            return
        }

        activeSessionId = request.sessionId
        activeFacing = request.facing
        JunLuoCameraProcessState.pendingSessionId = null
        generation += 1L
        terminating = false
        val now = System.currentTimeMillis()
        lastHeartbeatWriteAt = now

        try {
            ServiceCompat.startForeground(
                this,
                JunLuoCameraServiceNotifications.ONGOING_NOTIFICATION_ID,
                JunLuoCameraServiceNotifications.buildOngoing(
                    this,
                    JunLuoCameraServiceStatus.STARTING,
                    request.facing,
                    JunLuoCameraServiceCameraState.IDLE,
                ),
                if (Build.VERSION.SDK_INT >= 30) ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA else 0,
            )
        } catch (_: Throwable) {
            terminate(
                JunLuoCameraServiceErrorCodes.FOREGROUND_SERVICE_INVALID,
                JunLuoCameraServiceErrorCodes.FOREGROUND_SERVICE_INVALID,
                abnormal = true,
            )
            return
        }

        JunLuoCameraServiceStore.update(this) { previous ->
            previous.copy(
                status = JunLuoCameraServiceStatus.STARTING,
                sessionId = request.sessionId,
                sourceKind = request.facing.sourceKind,
                startedAt = request.requestedAt,
                lastHeartbeatAt = now,
                hardDeadlineAt = request.hardDeadlineAt,
                lastSuccessfulObservationAt = request.lastSuccessfulObservationAt,
                cameraReady = false,
                cameraState = JunLuoCameraServiceCameraState.IDLE,
                activeCaptureRequestId = null,
                lastCaptureRequestId = null,
                lastCaptureCompletedAt = null,
                lastCaptureSucceeded = null,
                lastCaptureByteLength = null,
                lastCaptureFailureCode = null,
                persistentNotificationVisible = true,
                lastFailureCode = null,
                stopReasonCode = null,
            )
        }
        markRunning(request)
    }

    private fun markRunning(request: JunLuoCameraServiceStartRequest) {
        JunLuoCameraServiceStore.update(this) { previous ->
            previous.copy(
                status = JunLuoCameraServiceStatus.RUNNING,
                sourceKind = request.facing.sourceKind,
                lastHeartbeatAt = System.currentTimeMillis(),
                cameraReady = false,
                cameraState = JunLuoCameraServiceCameraState.IDLE,
                activeCaptureRequestId = null,
                persistentNotificationVisible = true,
                lastFailureCode = null,
                stopReasonCode = null,
            )
        }
        getSystemService(NotificationManager::class.java).notify(
            JunLuoCameraServiceNotifications.ONGOING_NOTIFICATION_ID,
            JunLuoCameraServiceNotifications.buildOngoing(
                this,
                JunLuoCameraServiceStatus.RUNNING,
                request.facing,
                JunLuoCameraServiceCameraState.IDLE,
            ),
        )
        mainHandler.removeCallbacks(monitorRunnable)
        mainHandler.postDelayed(monitorRunnable, JUNLUO_CAMERA_SERVICE_CHECK_INTERVAL_MS)
        automaticScheduler.start()
    }

    private fun handleCaptureOnce(intent: Intent) {
        val request = JunLuoCameraSessionServiceController.captureRequestFromIntent(intent)
        if (request == null) {
            JunLuoCameraServiceStore.update(this) { snapshot ->
                snapshot.copy(lastCaptureFailureCode = JunLuoCameraServiceErrorCodes.INVALID_CAPTURE_REQUEST)
            }
            return
        }
        if (terminating || activeSessionId != request.sessionId || activeFacing == null) {
            JunLuoCameraServiceStore.update(this) { snapshot ->
                settleCameraServiceCaptureSnapshot(
                    snapshot,
                    request.requestId,
                    System.currentTimeMillis(),
                    succeeded = false,
                    failureCode = JunLuoCameraErrorCodes.NOT_RUNNING,
                )
            }
            return
        }
        val snapshot = JunLuoCameraServiceStore.read(this)
        val alreadyReserved = snapshot.cameraState == JunLuoCameraServiceCameraState.OPENING &&
            snapshot.activeCaptureRequestId == request.requestId &&
            snapshot.cameraResourceOwner == JunLuoCameraResourceOwner.OBSERVATION_CAPTURE &&
            snapshot.cameraResourceLeaseId != null
        if (!alreadyReserved) {
            JunLuoCameraServiceStore.update(this) { current ->
                current.copy(lastCaptureFailureCode = JunLuoCameraServiceErrorCodes.RESOURCE_BUSY)
            }
            return
        }
        runtimeGateFailure()?.let { failureCode ->
            failOnDemandCapture(request, failureCode)
            return
        }

        activeCaptureRequestId = request.requestId
        activeCaptureGeneration = request.captureGeneration
        activeCaptureDeliveryMode = request.deliveryMode
        activeObservationLeaseId = snapshot.cameraResourceLeaseId
        JunLuoCameraRuntimeConditions.read(this).captureFailure(
            automatic = request.deliveryMode == JunLuoCameraCaptureDeliveryMode.AUTOMATIC_EPHEMERAL,
        )?.let { failureCode ->
            failOnDemandCapture(request, failureCode)
            return
        }
        updateOngoingNotification(JunLuoCameraServiceCameraState.OPENING)
        val captureRunnable = Runnable { beginOnDemandCapture(request) }
        pendingCaptureRunnable = captureRunnable
        val delayMs = intent.getLongExtra(EXTRA_CAPTURE_DELAY_MS, 0L).coerceIn(0L, 5_000L)
        if (delayMs == 0L) {
            captureRunnable.run()
        } else {
            mainHandler.postDelayed(captureRunnable, delayMs)
        }
    }

    private fun beginOnDemandCapture(request: JunLuoCameraServiceCaptureRequest) {
        pendingCaptureRunnable = null
        if (terminating || activeCaptureRequestId != request.requestId) return
        JunLuoCameraRuntimeConditions.read(this).captureFailure(
            automatic = request.deliveryMode == JunLuoCameraCaptureDeliveryMode.AUTOMATIC_EPHEMERAL,
        )?.let { failureCode ->
            failOnDemandCapture(request, failureCode)
            return
        }
        runtimeGateFailure()?.let { failureCode ->
            failOnDemandCapture(request, failureCode)
            return
        }
        val facing = activeFacing ?: run {
            failOnDemandCapture(request, JunLuoCameraErrorCodes.NOT_RUNNING)
            return
        }
        val outputFile = prepareCaptureOutput(request) ?: run {
            failOnDemandCapture(request, JunLuoCameraErrorCodes.FILE_IO_FAILED)
            return
        }
        activeCaptureOutputFile = outputFile
        generation += 1L
        val expectedGeneration = generation
        ensureCameraLifecycleStarted()

        val core = JunLuoCameraCore(this)
        cameraCore = core
        core.startHeadless(
            lifecycleOwner = this,
            facing = facing,
            listener = JunLuoCameraCoreListener { coreSnapshot ->
                if (!isCurrentOnDemandCapture(request, expectedGeneration, core)) {
                    return@JunLuoCameraCoreListener
                }
                if (coreSnapshot.state == JunLuoCameraCoreState.ERROR ||
                    coreSnapshot.state == JunLuoCameraCoreState.BUSY
                ) {
                    failOnDemandCapture(
                        request,
                        coreSnapshot.lastFailureCode ?: JunLuoCameraErrorCodes.UNKNOWN,
                    )
                }
            },
        ) { receipt ->
            try {
                if (!isCurrentOnDemandCapture(request, expectedGeneration, core)) return@startHeadless
                when (receipt) {
                    is JunLuoCameraStartReceipt.Failure -> failOnDemandCapture(request, receipt.failureCode)
                    is JunLuoCameraStartReceipt.Success -> {
                        JunLuoCameraRuntimeConditions.read(this).captureFailure(
                            automatic = request.deliveryMode == JunLuoCameraCaptureDeliveryMode.AUTOMATIC_EPHEMERAL,
                        )?.let { failureCode ->
                            failOnDemandCapture(request, failureCode)
                            return@startHeadless
                        }
                        JunLuoCameraServiceStore.update(this) { snapshot ->
                            snapshot.copy(
                                cameraReady = true,
                                cameraState = JunLuoCameraServiceCameraState.CAPTURING,
                                lastHeartbeatAt = System.currentTimeMillis(),
                            )
                        }
                        updateOngoingNotification(JunLuoCameraServiceCameraState.CAPTURING)
                        core.captureOnce(request.requestId, outputFile) { result ->
                            try {
                                if (!isCurrentOnDemandCapture(request, expectedGeneration, core)) {
                                    JunLuoCameraTemporaryFileManager.deleteManagedOrFallback(
                                        this, outputFile, JunLuoCameraFrameCleanupTrigger.CAPTURE_CANCELLED,
                                    )
                                    return@captureOnce
                                }
                                when (result) {
                                    is JunLuoCameraCaptureResult.Success -> finishOnDemandCapture(request, result)
                                    is JunLuoCameraCaptureResult.Failure -> failOnDemandCapture(
                                        request,
                                        result.failureCode,
                                    )
                                }
                            } catch (_: JunLuoCameraStatePersistException) {
                                failClosedAfterPersistenceFailure()
                            }
                        }
                    }
                }
            } catch (_: JunLuoCameraStatePersistException) {
                failClosedAfterPersistenceFailure()
            }
        }
    }

    private fun finishOnDemandCapture(
        request: JunLuoCameraServiceCaptureRequest,
        result: JunLuoCameraCaptureResult.Success,
    ) {
        val outputFile = activeCaptureOutputFile ?: run {
            failOnDemandCapture(request, JunLuoCameraErrorCodes.FILE_IO_FAILED)
            return
        }
        releaseCameraCore("camera_capture_complete")
        val leaseId = activeObservationLeaseId
        JunLuoCameraResourceArbiter.forceReleaseObservation(leaseId)

        if (request.deliveryMode == JunLuoCameraCaptureDeliveryMode.AUDIT_ONLY) {
            val deleted = outputFile.delete() || !outputFile.exists()
            activeCaptureOutputFile = null
            clearCaptureIdentity()
            if (!deleted || !clearOnDemandCache()) {
                failOnDemandCapture(request, JunLuoCameraErrorCodes.FILE_IO_FAILED)
                return
            }
            JunLuoCameraServiceStore.update(this) { snapshot -> successfulIdleSnapshot(snapshot, request, result) }
            updateOngoingNotification(JunLuoCameraServiceCameraState.IDLE)
            return
        }

        val handle = JunLuoCameraBridgeFrameRegistry.register(
            sessionId = request.sessionId,
            requestId = request.requestId,
            captureGeneration = request.captureGeneration,
            file = outputFile,
            byteLength = result.byteLength,
            sha256 = result.sha256,
        ).getOrElse { error ->
            JunLuoCameraTemporaryFileManager.deleteManagedOrFallback(
                this, outputFile, JunLuoCameraFrameCleanupTrigger.CAPTURE_CANCELLED,
            )
            activeCaptureOutputFile = null
            clearCaptureIdentity()
            failOnDemandCapture(
                request,
                error.message ?: JunLuoCameraServiceErrorCodes.FRAME_PENDING_RELEASE,
            )
            return
        }
        activeCaptureOutputFile = null
        val committed = try {
            JunLuoCameraServiceStore.update(this) { snapshot -> successfulIdleSnapshot(snapshot, request, result) }
        } catch (_: JunLuoCameraStatePersistException) {
            JunLuoCameraBridgeFrameRegistry.release(handle.frameId, handle.releaseToken)
            clearCaptureIdentity()
            failClosedAfterPersistenceFailure()
            return
        }
        clearCaptureIdentity()
        updateOngoingNotification(JunLuoCameraServiceCameraState.IDLE)
        JunLuoCameraServiceEventBus.publishCapture(
            JunLuoCameraBridgeCaptureReceipt.Success(
                sessionId = request.sessionId,
                requestId = request.requestId,
                captureGeneration = request.captureGeneration,
                revision = committed.revision,
                sourceKind = result.sourceKind,
                capturedAt = result.capturedAt,
                temporaryUri = Uri.fromFile(handle.file).toString(),
                temporaryFrameId = handle.frameId,
                releaseToken = handle.releaseToken,
                width = result.width,
                height = result.height,
                rotation = result.rotation,
                mirrored = result.mirrored,
                sha256 = result.sha256,
                byteLength = result.byteLength,
            ),
        )
    }

    private fun successfulIdleSnapshot(
        snapshot: JunLuoCameraServiceSnapshot,
        request: JunLuoCameraServiceCaptureRequest,
        result: JunLuoCameraCaptureResult.Success,
    ): JunLuoCameraServiceSnapshot = settleCameraServiceCaptureSnapshot(
        snapshot,
        request.requestId,
        result.capturedAt,
        succeeded = true,
        byteLength = result.byteLength,
    ).copy(
        lastHeartbeatAt = System.currentTimeMillis(),
        lastFailureCode = null,
        stopReasonCode = null,
    )

    private fun failOnDemandCapture(
        request: JunLuoCameraServiceCaptureRequest,
        failureCode: String,
    ) {
        if (terminating) return
        if (request.deliveryMode == JunLuoCameraCaptureDeliveryMode.AUTOMATIC_EPHEMERAL ||
            failureCode == "camera_thermal_paused" || failureCode == "camera_low_battery") {
            releaseCameraCore("camera_automatic_capture_failed")
            activeCaptureOutputFile?.let { outputFile ->
                JunLuoCameraTemporaryFileManager.deleteManagedOrFallback(
                    this, outputFile, JunLuoCameraFrameCleanupTrigger.CAPTURE_CANCELLED,
                )
            }
            activeCaptureOutputFile = null
            JunLuoCameraResourceArbiter.forceReleaseObservation(activeObservationLeaseId)
            JunLuoCameraServiceStore.update(this) { snapshot ->
                settleCameraServiceCaptureSnapshot(
                    snapshot,
                    request.requestId,
                    System.currentTimeMillis(),
                    succeeded = false,
                    failureCode = failureCode,
                )
            }
            clearCaptureIdentity()
            updateOngoingNotification(JunLuoCameraServiceCameraState.IDLE)
            JunLuoCameraServiceEventBus.publishCapture(
                JunLuoCameraBridgeCaptureReceipt.Failure(
                    request.sessionId,
                    request.requestId,
                    request.captureGeneration,
                    failureCode,
                ),
            )
            return
        }
        try {
            terminate(failureCode, failureCode, abnormal = true)
        } catch (_: JunLuoCameraStatePersistException) {
            failClosedAfterPersistenceFailure()
        }
    }

    private fun isCurrentOnDemandCapture(
        request: JunLuoCameraServiceCaptureRequest,
        expectedGeneration: Long,
        core: JunLuoCameraCore,
    ): Boolean = core === cameraCore && isCurrentCameraServiceCaptureCallback(
        activeSessionId,
        request.sessionId,
        generation,
        expectedGeneration,
        activeCaptureRequestId,
        request.requestId,
        terminating,
    )

    private fun ensureCameraLifecycleStarted() {
        if (!lifecycleStarted) {
            lifecycleRegistry.handleLifecycleEvent(Lifecycle.Event.ON_START)
            lifecycleStarted = true
        }
    }

    private fun updateOngoingNotification(cameraState: JunLuoCameraServiceCameraState) {
        val snapshot = JunLuoCameraServiceStore.read(this)
        getSystemService(NotificationManager::class.java).notify(
            JunLuoCameraServiceNotifications.ONGOING_NOTIFICATION_ID,
            JunLuoCameraServiceNotifications.buildOngoing(
                this,
                snapshot.status,
                activeFacing,
                cameraState,
                snapshot.automaticObservation.phase,
            ),
        )
    }

    private fun refreshNotificationFromSnapshot() {
        val snapshot = JunLuoCameraServiceStore.read(this)
        val captureId = activeCaptureRequestId
        if (captureId != null && activeCaptureDeliveryMode == JunLuoCameraCaptureDeliveryMode.AUTOMATIC_EPHEMERAL &&
            (snapshot.automaticObservation.phase != JunLuoCameraAutomaticPhase.EXECUTING ||
                snapshot.automaticObservation.activeRequestId != captureId)) {
            activeSessionId?.let { cancelActiveCapture(it, captureId, activeCaptureGeneration) }
            return
        }
        if (activeSessionId == null || !isActiveCameraServiceStatus(snapshot.status)) return
        activeFacing = if (snapshot.sourceKind == JunLuoCameraFacing.BACK.sourceKind) {
            JunLuoCameraFacing.BACK
        } else {
            JunLuoCameraFacing.FRONT
        }
        getSystemService(NotificationManager::class.java).notify(
            JunLuoCameraServiceNotifications.ONGOING_NOTIFICATION_ID,
            JunLuoCameraServiceNotifications.buildOngoing(
                this,
                snapshot.status,
                activeFacing,
                snapshot.cameraState,
                snapshot.automaticObservation.phase,
            ),
        )
    }

    private fun handleSwitchFacing(intent: Intent) {
        val sessionId = intent.getStringExtra(EXTRA_SESSION_ID) ?: return
        val facing = runCatching { JunLuoCameraFacing.valueOf(intent.getStringExtra(EXTRA_FACING).orEmpty()) }
            .getOrNull() ?: return
        if (terminating || activeSessionId != sessionId) return
        val snapshot = JunLuoCameraServiceStore.read(this)
        if (snapshot.sessionId != sessionId || snapshot.sourceKind != facing.sourceKind) return
        activeFacing = facing
        refreshNotificationFromSnapshot()
    }

    private fun handleCancelCapture(intent: Intent) {
        val sessionId = intent.getStringExtra(EXTRA_SESSION_ID) ?: return
        val requestId = intent.getStringExtra(EXTRA_CAPTURE_REQUEST_ID) ?: return
        val captureGeneration = intent.getLongExtra(EXTRA_CAPTURE_GENERATION, Long.MIN_VALUE)
        if (
            sessionId != activeSessionId ||
            requestId != activeCaptureRequestId ||
            captureGeneration != activeCaptureGeneration ||
            terminating
        ) return
        cancelActiveCapture(sessionId, requestId, captureGeneration)
    }

    private fun cancelActiveCapture(sessionId: String, requestId: String, captureGeneration: Long) {
        val deliveryMode = activeCaptureDeliveryMode
        val leaseId = activeObservationLeaseId
        releaseCameraCore("camera_capture_cancelled")
        activeCaptureOutputFile?.let { outputFile ->
            JunLuoCameraTemporaryFileManager.deleteManagedOrFallback(
                this, outputFile, JunLuoCameraFrameCleanupTrigger.CAPTURE_CANCELLED,
            )
        }
        activeCaptureOutputFile = null
        JunLuoCameraResourceArbiter.forceReleaseObservation(leaseId)
        val snapshot = JunLuoCameraServiceStore.update(this) { current ->
            settleCameraServiceCaptureSnapshot(
                current,
                requestId,
                System.currentTimeMillis(),
                succeeded = false,
                failureCode = JunLuoCameraErrorCodes.CAPTURE_CANCELLED,
            )
        }
        clearCaptureIdentity()
        updateOngoingNotification(JunLuoCameraServiceCameraState.IDLE)
        if (deliveryMode != JunLuoCameraCaptureDeliveryMode.AUDIT_ONLY) {
            JunLuoCameraServiceEventBus.publishCapture(
                JunLuoCameraBridgeCaptureReceipt.Failure(
                    sessionId,
                    requestId,
                    captureGeneration,
                    JunLuoCameraErrorCodes.CAPTURE_CANCELLED,
                ),
            )
        }
        JunLuoCameraServiceEventBus.publishHeartbeat(snapshot)
    }

    private fun prepareCaptureOutput(request: JunLuoCameraServiceCaptureRequest): File? {
        if (
            request.deliveryMode == JunLuoCameraCaptureDeliveryMode.BRIDGE_EPHEMERAL ||
            request.deliveryMode == JunLuoCameraCaptureDeliveryMode.AUTOMATIC_EPHEMERAL
        ) {
            return runCatching { JunLuoCameraBridgeFrameRegistry.createOutputFile(this, request.sessionId) }
                .getOrNull()
        }
        if (!clearOnDemandCache()) return null
        val directory = File(cacheDir, ON_DEMAND_CACHE_DIRECTORY)
        if (!directory.exists() && !directory.mkdirs()) return null
        return File(directory, "${request.requestId}.jpg")
    }

    private fun clearOnDemandCache(): Boolean {
        val directory = File(cacheDir, ON_DEMAND_CACHE_DIRECTORY)
        if (!directory.exists()) return true
        return directory.listFiles()?.all { file -> file.deleteRecursively() } ?: false
    }

    private fun runtimeGateFailure(): String? {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            return JunLuoCameraErrorCodes.PERMISSION_REQUIRED
        }
        return JunLuoCameraServiceNotifications.visibilityFailure(this)
    }

    private fun terminate(
        reasonCode: String,
        failureCode: String?,
        abnormal: Boolean,
        stopService: Boolean = true,
    ) {
        if (terminating) return
        terminating = true
        JunLuoCameraRuntimeConditions.clearDebugSimulation()
        JunLuoCameraRuntimeConditions.stopMonitoring()
        generation += 1L
        mainHandler.removeCallbacks(monitorRunnable)
        val now = System.currentTimeMillis()
        val stoppingSessionId = activeSessionId ?: JunLuoCameraServiceStore.read(this).sessionId
        JunLuoCameraPreviewCoordinator.terminateSession(stoppingSessionId)
        val captureRequestId = activeCaptureRequestId
            ?: JunLuoCameraServiceStore.read(this).activeCaptureRequestId
        val captureGeneration = activeCaptureGeneration
        val captureDeliveryMode = activeCaptureDeliveryMode
        if (captureRequestId != null) {
            JunLuoCameraServiceStore.update(this) { snapshot ->
                settleCameraServiceCaptureSnapshot(
                    snapshot,
                    captureRequestId,
                    now,
                    succeeded = false,
                    failureCode = failureCode ?: JunLuoCameraErrorCodes.CAPTURE_CANCELLED,
                )
            }
        }
        if (abnormal) {
            JunLuoCameraServiceStore.update(this) { snapshot ->
                snapshot.copy(
                    status = JunLuoCameraServiceStatus.ERROR,
                    lastHeartbeatAt = now,
                    cameraReady = false,
                    cameraState = JunLuoCameraServiceCameraState.IDLE,
                    activeCaptureRequestId = null,
                    lastFailureCode = failureCode,
                    stopReasonCode = reasonCode,
                )
            }
        }
        JunLuoCameraServiceStore.update(this) { snapshot ->
            snapshot.copy(
                status = JunLuoCameraServiceStatus.STOPPING,
                lastHeartbeatAt = now,
                cameraReady = false,
                cameraState = JunLuoCameraServiceCameraState.IDLE,
                activeCaptureRequestId = null,
                lastFailureCode = failureCode,
                stopReasonCode = reasonCode,
                automaticObservation = stopAutomaticObservationState(snapshot.automaticObservation),
            )
        }
        if (activeSessionId != null) {
            runCatching {
                getSystemService(NotificationManager::class.java).notify(
                    JunLuoCameraServiceNotifications.ONGOING_NOTIFICATION_ID,
                    JunLuoCameraServiceNotifications.buildOngoing(
                        this,
                        JunLuoCameraServiceStatus.STOPPING,
                        activeFacing,
                        JunLuoCameraServiceCameraState.IDLE,
                    ),
                )
            }
        }

        releaseOwnedResources()
        stoppingSessionId?.let(JunLuoCameraBridgeFrameRegistry::releaseSession)
        JunLuoCameraServiceStore.update(this) { snapshot ->
            snapshot.copy(
                status = JunLuoCameraServiceStatus.STOPPED,
                lastSessionId = stoppingSessionId,
                sessionId = null,
                lastHeartbeatAt = System.currentTimeMillis(),
                cameraReady = false,
                cameraState = JunLuoCameraServiceCameraState.IDLE,
                activeCaptureRequestId = null,
                cameraResourceOwner = null,
                cameraResourceLeaseId = null,
                cameraResourcePausedAt = null,
                persistentNotificationVisible = false,
                lastFailureCode = failureCode,
                stopReasonCode = reasonCode,
            )
        }
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        getSystemService(NotificationManager::class.java)
            .cancel(JunLuoCameraServiceNotifications.ONGOING_NOTIFICATION_ID)
        if (abnormal && failureCode != null) {
            JunLuoCameraServiceNotifications.postStopped(this, failureCode)
        }
        if (
            captureRequestId != null &&
            stoppingSessionId != null &&
            captureDeliveryMode != JunLuoCameraCaptureDeliveryMode.AUDIT_ONLY
        ) {
            JunLuoCameraServiceEventBus.publishCapture(
                JunLuoCameraBridgeCaptureReceipt.Failure(
                    stoppingSessionId,
                    captureRequestId,
                    captureGeneration,
                    failureCode ?: JunLuoCameraErrorCodes.CAPTURE_CANCELLED,
                ),
            )
        }
        activeSessionId = null
        activeFacing = null
        JunLuoCameraProcessState.pendingSessionId = null
        if (stopService) stopSelfResult(latestStartId)
    }

    private fun releaseOwnedResources() {
        mainHandler.removeCallbacks(monitorRunnable)
        releaseCameraCore("camera_service_stopped")
        activeCaptureOutputFile?.let { outputFile ->
            JunLuoCameraTemporaryFileManager.deleteManagedOrFallback(
                this, outputFile, JunLuoCameraFrameCleanupTrigger.SESSION_STOP,
            )
        }
        activeCaptureOutputFile = null
        JunLuoCameraResourceArbiter.forceReleaseObservation(activeObservationLeaseId)
        clearCaptureIdentity()
        clearOnDemandCache()
        if (::automaticScheduler.isInitialized) automaticScheduler.stop()
    }

    private fun failClosedAfterPersistenceFailure() {
        val failedSessionId = activeSessionId ?: JunLuoCameraServiceStore.read(this).sessionId
        val failedRequestId = activeCaptureRequestId ?: JunLuoCameraServiceStore.read(this).activeCaptureRequestId
        val failedCaptureGeneration = activeCaptureGeneration
        val failedDeliveryMode = activeCaptureDeliveryMode
        terminating = true
        JunLuoCameraRuntimeConditions.clearDebugSimulation()
        JunLuoCameraRuntimeConditions.stopMonitoring()
        generation += 1L
        mainHandler.removeCallbacks(monitorRunnable)
        releaseOwnedResources()
        failedSessionId?.let(JunLuoCameraBridgeFrameRegistry::releaseSession)
        val stopped = runCatching {
            JunLuoCameraServiceStore.update(this) { snapshot ->
                snapshot.copy(
                    status = JunLuoCameraServiceStatus.STOPPED,
                    lastSessionId = failedSessionId,
                    sessionId = null,
                    lastHeartbeatAt = System.currentTimeMillis(),
                    cameraReady = false,
                    cameraState = JunLuoCameraServiceCameraState.IDLE,
                    activeCaptureRequestId = null,
                    cameraResourceOwner = null,
                    cameraResourceLeaseId = null,
                    cameraResourcePausedAt = null,
                    persistentNotificationVisible = false,
                    lastFailureCode = JunLuoCameraServiceErrorCodes.STATE_PERSIST_FAILED,
                    stopReasonCode = JunLuoCameraServiceErrorCodes.STATE_PERSIST_FAILED,
                    automaticObservation = stopAutomaticObservationState(snapshot.automaticObservation),
                )
            }
        }.getOrNull()
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        getSystemService(NotificationManager::class.java)
            .cancel(JunLuoCameraServiceNotifications.ONGOING_NOTIFICATION_ID)
        JunLuoCameraServiceNotifications.postStopped(this, JunLuoCameraServiceErrorCodes.STATE_PERSIST_FAILED)
        if (
            stopped != null &&
            failedSessionId != null &&
            failedRequestId != null &&
            failedDeliveryMode != JunLuoCameraCaptureDeliveryMode.AUDIT_ONLY
        ) {
            JunLuoCameraServiceEventBus.publishCapture(
                JunLuoCameraBridgeCaptureReceipt.Failure(
                    failedSessionId,
                    failedRequestId,
                    failedCaptureGeneration,
                    JunLuoCameraServiceErrorCodes.STATE_PERSIST_FAILED,
                ),
            )
        }
        activeSessionId = null
        activeFacing = null
        JunLuoCameraProcessState.pendingSessionId = null
        JunLuoCameraProcessState.serviceAlive = false
        stopSelf()
    }

    private fun releaseCameraCore(reasonCode: String) {
        pendingCaptureRunnable?.let(mainHandler::removeCallbacks)
        pendingCaptureRunnable = null
        val core = cameraCore
        cameraCore = null
        core?.stop(reasonCode)
        core?.release()
        if (lifecycleStarted && !lifecycleDestroyed) {
            lifecycleRegistry.handleLifecycleEvent(Lifecycle.Event.ON_STOP)
            lifecycleStarted = false
        }
    }

    private fun clearCaptureIdentity() {
        activeCaptureRequestId = null
        activeCaptureGeneration = 0L
        activeCaptureDeliveryMode = JunLuoCameraCaptureDeliveryMode.AUDIT_ONLY
        activeObservationLeaseId = null
    }

    companion object {
        const val ACTION_START = "com.anonymous.junluo.camera.action.START"
        const val ACTION_CAPTURE_ONCE = "com.anonymous.junluo.camera.action.CAPTURE_ONCE"
        const val ACTION_CANCEL_CAPTURE = "com.anonymous.junluo.camera.action.CANCEL_CAPTURE"
        const val ACTION_SWITCH_FACING = "com.anonymous.junluo.camera.action.SWITCH_FACING"
        const val ACTION_RESOURCE_STATE_CHANGED = "com.anonymous.junluo.camera.action.RESOURCE_STATE_CHANGED"
        const val ACTION_AUTOMATIC_TICK = "com.anonymous.junluo.camera.action.AUTOMATIC_TICK"
        const val ACTION_STOP = "com.anonymous.junluo.camera.action.STOP"
        const val EXTRA_SESSION_ID = "session_id"
        const val EXTRA_FACING = "facing"
        const val EXTRA_REQUESTED_AT = "requested_at"
        const val EXTRA_HARD_DEADLINE_AT = "hard_deadline_at"
        const val EXTRA_LAST_SUCCESS_AT = "last_success_at"
        const val EXTRA_CAPTURE_REQUEST_ID = "capture_request_id"
        const val EXTRA_CAPTURE_DELAY_MS = "capture_delay_ms"
        const val EXTRA_CAPTURE_GENERATION = "capture_generation"
        const val EXTRA_CAPTURE_DELIVERY_MODE = "capture_delivery_mode"
        const val EXTRA_STOP_REASON = "stop_reason"
        const val EXTRA_AUTOMATIC_GENERATION = "automatic_generation"
        const val EXTRA_AUTOMATIC_ATTEMPT_ID = "automatic_attempt_id"
        const val ON_DEMAND_CACHE_DIRECTORY = "junluo-camera/chapter5-on-demand"
    }
}
