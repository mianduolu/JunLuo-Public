package com.anonymous.junluo.camera

import android.net.Uri
import android.widget.FrameLayout
import android.view.View.MeasureSpec
import androidx.activity.ComponentActivity
import androidx.camera.view.PreviewView
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.events.RCTEventEmitter

internal class JunLuoCameraPreviewView(
    private val reactContext: ThemedReactContext,
) : FrameLayout(reactContext), LifecycleEventListener, JunLuoCameraServiceEventListener {
    private data class ActivePreviewCapture(
        val request: JunLuoCameraServiceCaptureRequest,
        val outputFile: java.io.File,
        val leaseId: String,
        val viewGeneration: Long,
        val core: JunLuoCameraCore,
    )

    private var layoutPassPosted = false
    private val nativePreview = PreviewView(context).apply {
        implementationMode = PreviewView.ImplementationMode.PERFORMANCE
        scaleType = PreviewView.ScaleType.FIT_CENTER
    }
    private var previewId = ""
    private var sessionId: String? = null
    private var requestedFacing = JunLuoCameraFacing.FRONT
    private var active = false
    private var generation = 0L
    private var appliedGeneration = -1L
    private var leaseId: String? = null
    private var core: JunLuoCameraCore? = null
    private var activeFacing: JunLuoCameraFacing? = null
    private var switchInFlight = false
    private var activePreviewCapture: ActivePreviewCapture? = null
    private var hostResumed = true
    private var manualSuspended = false
    private var disposed = false

    init {
        addView(nativePreview, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
        reactContext.addLifecycleEventListener(this)
        JunLuoCameraServiceEventBus.addListener(this)
    }

    override fun requestLayout() {
        super.requestLayout()
        if (layoutPassPosted) return
        layoutPassPosted = true
        post {
            if (isAttachedToWindow && width > 0 && height > 0) {
                measure(
                    MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY),
                    MeasureSpec.makeMeasureSpec(height, MeasureSpec.EXACTLY),
                )
                layout(left, top, right, bottom)
            }
            layoutPassPosted = false
        }
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        scheduleReconcile()
    }

    override fun onSizeChanged(width: Int, height: Int, oldWidth: Int, oldHeight: Int) {
        super.onSizeChanged(width, height, oldWidth, oldHeight)
        scheduleReconcile()
    }

    fun setPreviewId(value: String?) {
        previewId = value.orEmpty().take(128)
        scheduleReconcile()
    }

    fun setSessionId(value: String?) {
        sessionId = value?.takeIf { it.isNotBlank() }?.take(128)
        scheduleReconcile()
    }

    fun setRequestedFacing(value: String?) {
        requestedFacing = if (value == "back") JunLuoCameraFacing.BACK else JunLuoCameraFacing.FRONT
        scheduleReconcile()
    }

    fun setActive(value: Boolean) {
        active = value
        if (!value) manualSuspended = false
        scheduleReconcile()
    }

    fun setGeneration(value: Double) {
        generation = value.toLong().coerceAtLeast(0L)
        scheduleReconcile()
    }

    fun currentSessionId(): String? = sessionId

    fun manualCameraSuspensionFailure(): String? =
        if (activePreviewCapture != null) JunLuoCameraErrorCodes.CAPTURE_IN_PROGRESS else null

    fun captureForBridge(request: JunLuoCameraServiceCaptureRequest): String? {
        JunLuoCameraRuntimeConditions.read(context).captureFailure(
            automatic = request.deliveryMode == JunLuoCameraCaptureDeliveryMode.AUTOMATIC_EPHEMERAL,
        )?.let { return it }
        val activeCore = core ?: return JunLuoCameraServiceErrorCodes.RESOURCE_BUSY
        val activeLeaseId = leaseId ?: return JunLuoCameraServiceErrorCodes.RESOURCE_BUSY
        if (
            disposed || !active || !hostResumed || manualSuspended ||
            sessionId != request.sessionId || activeFacing == null
        ) return JunLuoCameraServiceErrorCodes.STALE_SESSION
        if (switchInFlight) return JunLuoCameraErrorCodes.OPERATION_IN_PROGRESS
        if (activePreviewCapture != null) return JunLuoCameraErrorCodes.CAPTURE_IN_PROGRESS
        if (JunLuoCameraBridgeFrameRegistry.hasPendingFrame()) {
            return JunLuoCameraServiceErrorCodes.FRAME_PENDING_RELEASE
        }
        val outputFile = runCatching {
            JunLuoCameraBridgeFrameRegistry.createOutputFile(context, request.sessionId)
        }.getOrNull() ?: return JunLuoCameraErrorCodes.FILE_IO_FAILED
        when (val begun = JunLuoCameraResourceArbiter.beginObservationPreviewCapture(
            context,
            activeLeaseId,
            request.requestId,
        )) {
            is JunLuoCameraResourceReceipt.Rejected -> {
                JunLuoCameraTemporaryFileManager.deleteManagedOrFallback(
                    context, outputFile, JunLuoCameraFrameCleanupTrigger.CAPTURE_CANCELLED,
                )
                if (begun.failureCode == JunLuoCameraServiceErrorCodes.STATE_PERSIST_FAILED) {
                    JunLuoCameraSessionServiceController.stop(context, begun.failureCode)
                }
                return begun.failureCode
            }
            is JunLuoCameraResourceReceipt.Accepted -> Unit
        }
        val operation = ActivePreviewCapture(request, outputFile, activeLeaseId, generation, activeCore)
        activePreviewCapture = operation
        JunLuoCameraSessionServiceController.refreshResourceState(context)
        activeCore.captureOnce(request.requestId, outputFile) { result ->
            if (activePreviewCapture !== operation) {
                JunLuoCameraTemporaryFileManager.deleteManagedOrFallback(
                    context, outputFile, JunLuoCameraFrameCleanupTrigger.CAPTURE_CANCELLED,
                )
                return@captureOnce
            }
            finishPreviewCapture(operation, result)
        }
        return null
    }

    fun cancelBridgeCapture(sessionId: String, requestId: String, captureGeneration: Long): Boolean {
        val operation = activePreviewCapture ?: return false
        if (
            operation.request.sessionId != sessionId ||
            operation.request.requestId != requestId ||
            operation.request.captureGeneration != captureGeneration
        ) return false
        cancelActivePreviewCapture(JunLuoCameraErrorCodes.CAPTURE_CANCELLED, settleState = true)
        return true
    }

    fun dispose() {
        if (disposed) return
        disposed = true
        reactContext.removeLifecycleEventListener(this)
        JunLuoCameraServiceEventBus.removeListener(this)
        JunLuoCameraPreviewCoordinator.release(this, "camera_preview_view_dropped", suspended = true)
    }

    fun startOrSwitchFromCoordinator() {
        if (disposed || !active || !hostResumed || manualSuspended || previewId.isBlank() || sessionId == null) return
        if (JunLuoCameraRuntimeConditions.read(context).thermalPaused) {
            stopForThermal()
            return
        }
        val runningCore = core
        if (runningCore != null && leaseId != null && appliedGeneration == generation) {
            if (activePreviewCapture != null) return
            if (activeFacing != requestedFacing) switchFacing(runningCore)
            return
        }
        if (runningCore != null || leaseId != null) {
            stopFromCoordinator("camera_preview_generation_changed", suspended = true, settleState = true)
        }
        startPreview()
    }

    fun stopForThermal() {
        active = false
        stopFromCoordinator("camera_thermal_paused", suspended = false, settleState = true)
    }

    fun stopFromCoordinator(reasonCode: String, suspended: Boolean, settleState: Boolean) {
        appliedGeneration = -1L
        cancelActivePreviewCapture(
            if (reasonCode == "camera_thermal_paused") reasonCode else JunLuoCameraErrorCodes.CAPTURE_CANCELLED,
            settleState,
        )
        core?.stop(reasonCode)
        core?.release()
        core = null
        activeFacing = null
        switchInFlight = false
        val activeLeaseId = leaseId
        leaseId = null
        if (activeLeaseId != null) {
            if (settleState) {
                when (val releaseResult = JunLuoCameraResourceArbiter.release(context, JunLuoCameraResourceOwner.OBSERVATION_PREVIEW, activeLeaseId)) {
                    is JunLuoCameraResourceReceipt.Accepted -> JunLuoCameraSessionServiceController.refreshResourceState(context)
                    is JunLuoCameraResourceReceipt.Rejected -> {
                        JunLuoCameraResourceArbiter.forceReleaseObservation(activeLeaseId)
                        if (releaseResult.failureCode == JunLuoCameraServiceErrorCodes.STATE_PERSIST_FAILED) {
                            JunLuoCameraSessionServiceController.stop(context, releaseResult.failureCode)
                        }
                    }
                }
            } else {
                JunLuoCameraResourceArbiter.forceReleaseObservation(activeLeaseId)
            }
        }
        emit(if (suspended) "suspended" else "off", reasonCode = reasonCode)
    }

    fun suspendForManualCamera() {
        manualSuspended = true
        stopFromCoordinator("manual_camera", suspended = true, settleState = true)
    }

    override fun onHostResume() {
        hostResumed = true
        scheduleReconcile()
    }

    override fun onHostPause() {
        hostResumed = false
        JunLuoCameraPreviewCoordinator.release(this, "activity_on_stop", suspended = true)
    }

    override fun onHostDestroy() {
        dispose()
    }

    override fun onSessionSnapshot(snapshot: JunLuoCameraServiceSnapshot) {
        activePreviewCapture?.request?.takeIf { it.automaticAttemptId != null }?.let { request ->
            if (snapshot.automaticObservation.phase != JunLuoCameraAutomaticPhase.EXECUTING ||
                snapshot.automaticObservation.activeAttemptId != request.automaticAttemptId ||
                snapshot.automaticObservation.activeRequestId != request.requestId) {
                cancelActivePreviewCapture(JunLuoCameraErrorCodes.CAPTURE_CANCELLED, settleState = true)
            }
        }
        val currentSessionId = sessionId
        if (currentSessionId == null || snapshot.sessionId != currentSessionId || snapshot.status == JunLuoCameraServiceStatus.STOPPED) {
            if (core != null || leaseId != null) {
                JunLuoCameraPreviewCoordinator.release(this, "camera_session_stopped", suspended = false)
            }
            return
        }
        if (snapshot.status == JunLuoCameraServiceStatus.PAUSED_CAMERA_BUSY) {
            manualSuspended = true
            return
        }
        if (
            manualSuspended &&
            snapshot.status == JunLuoCameraServiceStatus.RUNNING &&
            snapshot.cameraState == JunLuoCameraServiceCameraState.IDLE &&
            snapshot.cameraResourceOwner == null
        ) {
            manualSuspended = false
            scheduleReconcile()
        }
    }

    private fun scheduleReconcile() {
        post {
            if (disposed) return@post
            if (!active || !hostResumed || sessionId == null) {
                if (core != null || leaseId != null) {
                    JunLuoCameraPreviewCoordinator.release(this, "camera_preview_inactive", suspended = true)
                } else {
                    emit(if (active) "suspended" else "off")
                }
            } else if (!manualSuspended) {
                JunLuoCameraPreviewCoordinator.activate(this)
            }
        }
    }

    private fun startPreview() {
        val requestedSessionId = sessionId ?: return
        val reservation = JunLuoCameraResourceArbiter.reserveObservationPreview(context, requestedSessionId)
        if (reservation is JunLuoCameraResourceReceipt.Rejected) {
            emit("error", failureCode = reservation.failureCode)
            return
        }
        val accepted = reservation as JunLuoCameraResourceReceipt.Accepted
        val newLeaseId = accepted.lease.leaseId
        val expectedGeneration = generation
        leaseId = newLeaseId
        appliedGeneration = expectedGeneration
        emit("starting", facing = requestedFacing)
        JunLuoCameraSessionServiceController.refreshResourceState(context)
        val activity = reactContext.currentActivity as? ComponentActivity
        if (activity == null) {
            failPreview(newLeaseId, JunLuoCameraServiceErrorCodes.VISIBLE_ACTIVITY_REQUIRED)
            return
        }
        val newCore = JunLuoCameraCore(context)
        core = newCore
        newCore.start(
            activity,
            nativePreview,
            requestedFacing,
            JunLuoCameraCoreListener { snapshot ->
                if (snapshot.state == JunLuoCameraCoreState.ERROR && leaseId == newLeaseId) {
                    failPreview(newLeaseId, snapshot.lastFailureCode ?: JunLuoCameraErrorCodes.UNKNOWN)
                }
            },
            PreviewView.ImplementationMode.PERFORMANCE,
        ) { receipt ->
            if (!isCurrent(newLeaseId, expectedGeneration, newCore)) {
                newCore.stop(JunLuoCameraServiceErrorCodes.PREVIEW_STALE_GENERATION)
                newCore.release()
                when (val releaseResult = JunLuoCameraResourceArbiter.release(
                    context,
                    JunLuoCameraResourceOwner.OBSERVATION_PREVIEW,
                    newLeaseId,
                )) {
                    is JunLuoCameraResourceReceipt.Accepted -> JunLuoCameraSessionServiceController.refreshResourceState(context)
                    is JunLuoCameraResourceReceipt.Rejected -> {
                        JunLuoCameraResourceArbiter.forceReleaseObservation(newLeaseId)
                        if (releaseResult.failureCode == JunLuoCameraServiceErrorCodes.STATE_PERSIST_FAILED) {
                            JunLuoCameraSessionServiceController.stop(context, releaseResult.failureCode)
                        }
                    }
                }
                return@start
            }
            when (receipt) {
                is JunLuoCameraStartReceipt.Success -> {
                    when (val settled = JunLuoCameraResourceArbiter.settleObservationPreview(context, newLeaseId, receipt.facing)) {
                        is JunLuoCameraResourceReceipt.Accepted -> {
                            activeFacing = receipt.facing
                            JunLuoCameraSessionServiceController.refreshResourceState(context)
                            emit(
                                "streaming",
                                facing = receipt.facing,
                                previewWidth = receipt.previewWidth,
                                previewHeight = receipt.previewHeight,
                            )
                        }
                        is JunLuoCameraResourceReceipt.Rejected -> failPreview(newLeaseId, settled.failureCode)
                    }
                }
                is JunLuoCameraStartReceipt.Failure -> failPreview(newLeaseId, receipt.failureCode)
            }
        }
    }

    private fun switchFacing(runningCore: JunLuoCameraCore) {
        if (switchInFlight || activePreviewCapture != null) return
        val activeLeaseId = leaseId ?: return
        val oldFacing = activeFacing ?: return
        val expectedGeneration = generation
        when (val starting = JunLuoCameraResourceArbiter.markObservationPreviewStarting(context, activeLeaseId)) {
            is JunLuoCameraResourceReceipt.Rejected -> {
                failPreview(activeLeaseId, starting.failureCode)
                return
            }
            is JunLuoCameraResourceReceipt.Accepted -> Unit
        }
        switchInFlight = true
        emit("switching", facing = requestedFacing)
        JunLuoCameraSessionServiceController.refreshResourceState(context)
        runningCore.switchFacing(requestedFacing) { receipt ->
            if (!isCurrent(activeLeaseId, expectedGeneration, runningCore)) return@switchFacing
            switchInFlight = false
            when (receipt) {
                is JunLuoCameraSwitchReceipt.Success -> when (
                    val settled = JunLuoCameraResourceArbiter.settleObservationPreview(context, activeLeaseId, receipt.facing)
                ) {
                    is JunLuoCameraResourceReceipt.Accepted -> {
                        activeFacing = receipt.facing
                        val dimensions = runningCore.snapshot()
                        JunLuoCameraSessionServiceController.refreshResourceState(context)
                        emit("streaming", facing = receipt.facing, previewWidth = dimensions.previewWidth, previewHeight = dimensions.previewHeight)
                    }
                    is JunLuoCameraResourceReceipt.Rejected -> failPreview(activeLeaseId, settled.failureCode)
                }
                is JunLuoCameraSwitchReceipt.Failure -> {
                    JunLuoCameraResourceArbiter.settleObservationPreview(context, activeLeaseId, oldFacing)
                    JunLuoCameraSessionServiceController.refreshResourceState(context)
                    emit("streaming", facing = oldFacing, failureCode = receipt.failureCode)
                }
            }
        }
    }

    private fun failPreview(activeLeaseId: String, failureCode: String) {
        if (leaseId != activeLeaseId) return
        core?.stop(failureCode)
        core?.release()
        core = null
        leaseId = null
        activeFacing = null
        switchInFlight = false
        val released = JunLuoCameraResourceArbiter.release(context, JunLuoCameraResourceOwner.OBSERVATION_PREVIEW, activeLeaseId)
        JunLuoCameraSessionServiceController.refreshResourceState(context)
        emit("error", failureCode = failureCode)
        if (
            failureCode == JunLuoCameraServiceErrorCodes.STATE_PERSIST_FAILED ||
            released is JunLuoCameraResourceReceipt.Rejected && released.failureCode == JunLuoCameraServiceErrorCodes.STATE_PERSIST_FAILED
        ) {
            JunLuoCameraSessionServiceController.stop(context, JunLuoCameraServiceErrorCodes.STATE_PERSIST_FAILED)
        }
    }

    private fun finishPreviewCapture(
        operation: ActivePreviewCapture,
        result: JunLuoCameraCaptureResult,
    ) {
        if (activePreviewCapture !== operation) {
            JunLuoCameraTemporaryFileManager.deleteManagedOrFallback(
                context, operation.outputFile, JunLuoCameraFrameCleanupTrigger.CAPTURE_CANCELLED,
            )
            return
        }
        if (
            disposed || leaseId != operation.leaseId || generation != operation.viewGeneration ||
            core !== operation.core || sessionId != operation.request.sessionId
        ) {
            cancelActivePreviewCapture(JunLuoCameraErrorCodes.CAPTURE_CANCELLED, settleState = true)
            return
        }
        activePreviewCapture = null
        when (result) {
            is JunLuoCameraCaptureResult.Failure -> {
                JunLuoCameraTemporaryFileManager.deleteManagedOrFallback(
                    context, operation.outputFile, JunLuoCameraFrameCleanupTrigger.CAPTURE_CANCELLED,
                )
                settlePreviewCaptureFailure(operation, result.failureCode, result.failedAt)
            }
            is JunLuoCameraCaptureResult.Success -> finishPreviewCaptureSuccess(operation, result)
        }
        scheduleReconcile()
    }

    private fun finishPreviewCaptureSuccess(
        operation: ActivePreviewCapture,
        result: JunLuoCameraCaptureResult.Success,
    ) {
        val handle = JunLuoCameraBridgeFrameRegistry.register(
            operation.request.sessionId,
            operation.request.requestId,
            operation.request.captureGeneration,
            operation.outputFile,
            result.byteLength,
            result.sha256,
        ).getOrElse { error ->
            JunLuoCameraTemporaryFileManager.deleteManagedOrFallback(
                context, operation.outputFile, JunLuoCameraFrameCleanupTrigger.CAPTURE_CANCELLED,
            )
            settlePreviewCaptureFailure(
                operation,
                error.message ?: JunLuoCameraServiceErrorCodes.FRAME_PENDING_RELEASE,
                System.currentTimeMillis(),
            )
            return
        }
        when (val settled = JunLuoCameraResourceArbiter.settleObservationPreviewCapture(
            context,
            operation.leaseId,
            operation.request.requestId,
            result.capturedAt,
            succeeded = true,
            byteLength = result.byteLength,
        )) {
            is JunLuoCameraResourceReceipt.Rejected -> {
                JunLuoCameraBridgeFrameRegistry.release(handle.frameId, handle.releaseToken)
                publishPreviewCaptureFailure(operation.request, settled.failureCode)
                if (settled.failureCode == JunLuoCameraServiceErrorCodes.STATE_PERSIST_FAILED) {
                    JunLuoCameraSessionServiceController.stop(context, settled.failureCode)
                }
            }
            is JunLuoCameraResourceReceipt.Accepted -> {
                JunLuoCameraSessionServiceController.refreshResourceState(context)
                JunLuoCameraServiceEventBus.publishCapture(
                    JunLuoCameraBridgeCaptureReceipt.Success(
                        sessionId = operation.request.sessionId,
                        requestId = operation.request.requestId,
                        captureGeneration = operation.request.captureGeneration,
                        revision = settled.snapshot.revision,
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
        }
    }

    private fun settlePreviewCaptureFailure(
        operation: ActivePreviewCapture,
        failureCode: String,
        completedAt: Long,
    ) {
        val settled = JunLuoCameraResourceArbiter.settleObservationPreviewCapture(
            context,
            operation.leaseId,
            operation.request.requestId,
            completedAt,
            succeeded = false,
            failureCode = failureCode,
        )
        JunLuoCameraSessionServiceController.refreshResourceState(context)
        publishPreviewCaptureFailure(operation.request, failureCode)
        if (settled is JunLuoCameraResourceReceipt.Rejected && settled.failureCode == JunLuoCameraServiceErrorCodes.STATE_PERSIST_FAILED) {
            JunLuoCameraSessionServiceController.stop(context, settled.failureCode)
        }
    }

    private fun cancelActivePreviewCapture(failureCode: String, settleState: Boolean) {
        val operation = activePreviewCapture ?: return
        activePreviewCapture = null
        operation.core.cancelCaptureRequest(operation.request.requestId)
        JunLuoCameraTemporaryFileManager.deleteManagedOrFallback(
            context, operation.outputFile, JunLuoCameraFrameCleanupTrigger.CAPTURE_CANCELLED,
        )
        if (settleState) {
            settlePreviewCaptureFailure(operation, failureCode, System.currentTimeMillis())
        } else {
            publishPreviewCaptureFailure(operation.request, failureCode)
        }
    }

    private fun publishPreviewCaptureFailure(request: JunLuoCameraServiceCaptureRequest, failureCode: String) {
        JunLuoCameraServiceEventBus.publishCapture(
            JunLuoCameraBridgeCaptureReceipt.Failure(
                request.sessionId,
                request.requestId,
                request.captureGeneration,
                failureCode,
            ),
        )
    }

    private fun isCurrent(expectedLeaseId: String, expectedGeneration: Long, expectedCore: JunLuoCameraCore): Boolean =
        !disposed && active && hostResumed && leaseId == expectedLeaseId && generation == expectedGeneration && core === expectedCore

    private fun emit(
        phase: String,
        facing: JunLuoCameraFacing? = activeFacing,
        previewWidth: Int? = null,
        previewHeight: Int? = null,
        failureCode: String? = null,
        reasonCode: String? = null,
    ) {
        if (id == NO_ID || previewId.isBlank()) return
        val event = Arguments.createMap().apply {
            putString("previewId", previewId)
            sessionId?.let { putString("sessionId", it) }
            putDouble("generation", generation.toDouble())
            putString("phase", phase)
            facing?.let {
                putString("facing", it.name.lowercase())
                putString("sourceKind", it.sourceKind)
            }
            previewWidth?.let { putInt("previewWidth", it) }
            previewHeight?.let { putInt("previewHeight", it) }
            if (phase == "streaming") {
                putArray("requestedPreviewFps", Arguments.createArray().apply {
                    pushInt(JUNLUO_CAMERA_TARGET_FPS)
                    pushInt(JUNLUO_CAMERA_TARGET_FPS)
                })
            }
            failureCode?.let { putString("failureCode", it) }
            reasonCode?.let { putString("reasonCode", it) }
        }
        @Suppress("DEPRECATION")
        reactContext.getJSModule(RCTEventEmitter::class.java)
            .receiveEvent(id, "topPreviewStateChanged", event)
    }
}
