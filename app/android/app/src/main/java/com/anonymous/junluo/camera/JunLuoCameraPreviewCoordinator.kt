package com.anonymous.junluo.camera

internal sealed class JunLuoCameraPreviewCaptureStart {
    data object NotAvailable : JunLuoCameraPreviewCaptureStart()
    data object Accepted : JunLuoCameraPreviewCaptureStart()
    data class Rejected(val failureCode: String) : JunLuoCameraPreviewCaptureStart()
}

internal object JunLuoCameraPreviewCoordinator {
    private var activeView: JunLuoCameraPreviewView? = null

    @Synchronized
    fun activate(view: JunLuoCameraPreviewView) {
        if (activeView !== view) {
            activeView?.stopFromCoordinator("camera_preview_replaced", suspended = true, settleState = true)
            activeView = view
        }
        view.startOrSwitchFromCoordinator()
    }

    @Synchronized
    fun release(view: JunLuoCameraPreviewView, reasonCode: String, suspended: Boolean) {
        if (activeView === view) activeView = null
        view.stopFromCoordinator(reasonCode, suspended, settleState = true)
    }

    @Synchronized
    fun suspendForManualCamera(): String? {
        val view = activeView ?: return null
        view.manualCameraSuspensionFailure()?.let { return it }
        view.suspendForManualCamera()
        return null
    }

    @Synchronized
    fun captureForBridge(request: JunLuoCameraServiceCaptureRequest): JunLuoCameraPreviewCaptureStart {
        val view = activeView ?: return JunLuoCameraPreviewCaptureStart.NotAvailable
        if (view.currentSessionId() != request.sessionId) {
            return JunLuoCameraPreviewCaptureStart.Rejected(JunLuoCameraServiceErrorCodes.STALE_SESSION)
        }
        val failureCode = view.captureForBridge(request)
        return if (failureCode == null) {
            JunLuoCameraPreviewCaptureStart.Accepted
        } else {
            JunLuoCameraPreviewCaptureStart.Rejected(failureCode)
        }
    }

    @Synchronized
    fun cancelCapture(sessionId: String, requestId: String, captureGeneration: Long): Boolean {
        val view = activeView ?: return false
        return view.cancelBridgeCapture(sessionId, requestId, captureGeneration)
    }

    @Synchronized
    fun terminateSession(sessionId: String?) {
        val view = activeView ?: return
        if (sessionId == null || view.currentSessionId() == sessionId) {
            activeView = null
            view.stopFromCoordinator("camera_session_stopped", suspended = false, settleState = false)
        }
    }

    @Synchronized
    fun pauseForThermal() {
        val view = activeView ?: return
        activeView = null
        view.stopForThermal()
    }

    @Synchronized
    fun invalidateBridge() {
        val view = activeView ?: return
        activeView = null
        view.stopFromCoordinator("camera_bridge_invalidated", suspended = false, settleState = true)
    }
}
