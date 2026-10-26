package com.anonymous.junluo.camera

const val JUNLUO_CAMERA_SERVICE_SCHEMA_VERSION = 6
const val JUNLUO_CAMERA_SERVICE_STORE_NAME = "junluo_camera_perception_session_v1"
const val JUNLUO_CAMERA_NOTIFICATION_CHANNEL_ID = "junluo_camera_observation_v1"
const val JUNLUO_CAMERA_SERVICE_CHECK_INTERVAL_MS = 15_000L
const val JUNLUO_CAMERA_SERVICE_HEARTBEAT_INTERVAL_MS = 60_000L
const val JUNLUO_CAMERA_TASK_REMOVED_STOP_REASON = "task_removed"
const val JUNLUO_CAMERA_MIUI_SWIPE_UP_CLEAN_MARKER = "SwipeUpClean"

enum class JunLuoCameraServiceStatus {
    STOPPED,
    STARTING,
    RUNNING,
    PAUSED_CAMERA_BUSY,
    STOPPING,
    ERROR,
}

enum class JunLuoCameraResourceOwner(val wireValue: String) {
    OBSERVATION_CAPTURE("observation_capture"),
    OBSERVATION_PREVIEW("observation_preview"),
    MANUAL_CAMERA("manual_camera"),
    VIDEO_CALL_CAMERA("video_call_camera");

    companion object {
        fun fromWireValue(value: String?): JunLuoCameraResourceOwner? = entries.firstOrNull { it.wireValue == value }
    }
}

enum class JunLuoCameraCaptureDeliveryMode {
    AUDIT_ONLY,
    BRIDGE_EPHEMERAL,
    AUTOMATIC_EPHEMERAL,
}

enum class JunLuoCameraServiceCameraState {
    IDLE,
    OPENING,
    CAPTURING,
    PREVIEWING,
}

data class JunLuoCameraServiceStartRequest(
    val sessionId: String,
    val facing: JunLuoCameraFacing,
    val requestedAt: Long,
    val hardDeadlineAt: Long?,
    val lastSuccessfulObservationAt: Long?,
)

data class JunLuoCameraServiceCaptureRequest(
    val sessionId: String,
    val requestId: String,
    val requestedAt: Long,
    val captureGeneration: Long = 0L,
    val deliveryMode: JunLuoCameraCaptureDeliveryMode = JunLuoCameraCaptureDeliveryMode.AUDIT_ONLY,
    val automaticAttemptId: String? = null,
)

data class JunLuoCameraServiceSnapshot(
    val schemaVersion: Int = JUNLUO_CAMERA_SERVICE_SCHEMA_VERSION,
    val revision: Long = 0L,
    val status: JunLuoCameraServiceStatus = JunLuoCameraServiceStatus.STOPPED,
    val sessionId: String? = null,
    val sourceKind: String? = null,
    val startedAt: Long? = null,
    val lastHeartbeatAt: Long? = null,
    val hardDeadlineAt: Long? = null,
    val lastSuccessfulObservationAt: Long? = null,
    val cameraReady: Boolean = false,
    val cameraState: JunLuoCameraServiceCameraState = JunLuoCameraServiceCameraState.IDLE,
    val activeCaptureRequestId: String? = null,
    val lastCaptureRequestId: String? = null,
    val lastCaptureCompletedAt: Long? = null,
    val lastCaptureSucceeded: Boolean? = null,
    val lastCaptureByteLength: Long? = null,
    val lastCaptureFailureCode: String? = null,
    val persistentNotificationVisible: Boolean = false,
    val lastFailureCode: String? = null,
    val stopReasonCode: String? = null,
    val cameraResourceOwner: JunLuoCameraResourceOwner? = null,
    val cameraResourceLeaseId: String? = null,
    val cameraResourcePausedAt: Long? = null,
    val lastSessionId: String? = null,
    val automaticObservation: JunLuoCameraAutomaticObservationState = JunLuoCameraAutomaticObservationState(),
)

sealed class JunLuoCameraServiceCommandReceipt {
    data class Accepted(
        val sessionId: String,
        val status: JunLuoCameraServiceStatus,
        val revision: Long,
    ) : JunLuoCameraServiceCommandReceipt()

    data class Rejected(
        val failureCode: String,
    ) : JunLuoCameraServiceCommandReceipt()
}

internal object JunLuoCameraServiceErrorCodes {
    const val VISIBLE_ACTIVITY_REQUIRED = "camera_visible_activity_required"
    const val NOTIFICATION_PERMISSION_REQUIRED = "camera_notification_permission_required"
    const val NOTIFICATION_CHANNEL_BLOCKED = "camera_notification_channel_blocked"
    const val FOREGROUND_START_NOT_ALLOWED = "camera_foreground_start_not_allowed"
    const val FOREGROUND_SERVICE_INVALID = "camera_foreground_service_invalid"
    const val SESSION_ALREADY_RUNNING = "camera_session_already_running"
    const val INVALID_SESSION_REQUEST = "camera_invalid_session_request"
    const val INVALID_CAPTURE_REQUEST = "camera_invalid_capture_request"
    const val PROCESS_TERMINATED = "camera_process_terminated"
    const val INVALID_BRIDGE_PAYLOAD = "camera_invalid_bridge_payload"
    const val STATE_PERSIST_FAILED = "camera_state_persist_failed"
    const val BRIDGE_TIMEOUT = "camera_bridge_timeout"
    const val STALE_SESSION = "camera_stale_session"
    const val RESOURCE_BUSY = "camera_resource_busy"
    const val RESOURCE_LEASE_MISMATCH = "camera_resource_lease_mismatch"
    const val FRAME_PENDING_RELEASE = "camera_frame_pending_release"
    const val FRAME_ALREADY_RELEASED = "camera_frame_already_released"
    const val FRAME_RELEASE_FAILED = "camera_frame_release_failed"
    const val FRAME_CLEANUP_RETRYING = "camera_frame_cleanup_retrying"
    const val FRAME_CLEANUP_FAILED = "camera_frame_cleanup_failed"
    const val FRAME_PRIVACY_STATE_UNAVAILABLE = "camera_frame_privacy_state_unavailable"
    const val FRAME_PRIVACY_AUDIT_FAILED = "camera_frame_privacy_audit_failed"
    const val SENSITIVE_BACKUP_POLICY_PERSIST_FAILED = "camera_sensitive_backup_policy_persist_failed"
    const val PREVIEW_CANCELLED = "camera_preview_cancelled"
    const val PREVIEW_STALE_GENERATION = "camera_preview_stale_generation"
    const val MANUAL_SAVE_REQUIRES_PREVIEW = "camera_manual_save_requires_preview"
    const val MANUAL_SAVE_DESTINATION_REQUIRED = "camera_manual_save_destination_required"
    const val MANUAL_SAVE_PERMISSION_LOST = "camera_manual_save_permission_lost"
    const val MANUAL_SAVE_CREATE_FAILED = "camera_manual_save_create_failed"
    const val MANUAL_SAVE_WRITE_FAILED = "camera_manual_save_write_failed"
    const val MANUAL_SAVE_VERIFICATION_FAILED = "camera_manual_save_verification_failed"
    const val MANUAL_SAVE_CANCELLED = "camera_manual_save_cancelled"
    const val AUTOMATIC_POLICY_INVALID = "camera_automatic_policy_invalid"
    const val AUTOMATIC_ATTEMPT_STALE = "camera_automatic_attempt_stale"
    const val AUTOMATIC_OPPORTUNITY_NOT_AVAILABLE = "camera_automatic_opportunity_not_available"
    const val AUTOMATIC_RETRY_NOT_AVAILABLE = "camera_automatic_retry_not_available"
    const val AUTOMATIC_DEBUG_UNAVAILABLE = "camera_automatic_debug_unavailable"
    const val NETWORK_UNAVAILABLE = "camera_network_unavailable"
}

internal fun isActiveCameraServiceStatus(status: JunLuoCameraServiceStatus): Boolean =
    status == JunLuoCameraServiceStatus.STARTING ||
        status == JunLuoCameraServiceStatus.RUNNING ||
        status == JunLuoCameraServiceStatus.PAUSED_CAMERA_BUSY ||
        status == JunLuoCameraServiceStatus.STOPPING

internal fun isValidCameraServiceStartRequest(request: JunLuoCameraServiceStartRequest): Boolean {
    if (!request.sessionId.matches(Regex("[A-Za-z0-9._-]{1,128}"))) return false
    if (request.requestedAt <= 0L) return false
    if (request.hardDeadlineAt != null && request.hardDeadlineAt < request.requestedAt) return false
    if (request.lastSuccessfulObservationAt != null && request.lastSuccessfulObservationAt <= 0L) return false
    return true
}

internal fun isValidCameraServiceCaptureRequest(request: JunLuoCameraServiceCaptureRequest): Boolean =
    request.sessionId.matches(Regex("[A-Za-z0-9._-]{1,128}")) &&
        isValidCameraRequestId(request.requestId) &&
        request.requestedAt > 0L &&
        if (request.deliveryMode == JunLuoCameraCaptureDeliveryMode.AUTOMATIC_EPHEMERAL) {
            isValidCameraRequestId(request.automaticAttemptId.orEmpty())
        } else {
            request.automaticAttemptId == null
        }

internal fun cameraServiceCaptureGateFailure(
    snapshot: JunLuoCameraServiceSnapshot,
    request: JunLuoCameraServiceCaptureRequest,
): String? = when {
    !isValidCameraServiceCaptureRequest(request) -> JunLuoCameraServiceErrorCodes.INVALID_CAPTURE_REQUEST
    snapshot.automaticObservation.phase == JunLuoCameraAutomaticPhase.EXECUTING &&
        request.automaticAttemptId == null -> JunLuoCameraServiceErrorCodes.RESOURCE_BUSY
    request.automaticAttemptId != null &&
        (snapshot.automaticObservation.phase != JunLuoCameraAutomaticPhase.EXECUTING ||
            snapshot.automaticObservation.activeAttemptId != request.automaticAttemptId ||
            snapshot.automaticObservation.activeRequestId != request.requestId) ->
        JunLuoCameraServiceErrorCodes.AUTOMATIC_ATTEMPT_STALE
    snapshot.cameraResourceOwner != null -> JunLuoCameraServiceErrorCodes.RESOURCE_BUSY
    snapshot.status != JunLuoCameraServiceStatus.RUNNING || snapshot.sessionId != request.sessionId ->
        JunLuoCameraErrorCodes.NOT_RUNNING
    snapshot.cameraState != JunLuoCameraServiceCameraState.IDLE || snapshot.activeCaptureRequestId != null ->
        JunLuoCameraErrorCodes.CAPTURE_IN_PROGRESS
    else -> null
}

internal fun beginCameraServiceCaptureSnapshot(
    snapshot: JunLuoCameraServiceSnapshot,
    request: JunLuoCameraServiceCaptureRequest,
): JunLuoCameraServiceSnapshot = snapshot.copy(
    cameraReady = false,
    cameraState = JunLuoCameraServiceCameraState.OPENING,
    activeCaptureRequestId = request.requestId,
    lastCaptureFailureCode = null,
    cameraResourceOwner = JunLuoCameraResourceOwner.OBSERVATION_CAPTURE,
)

internal fun settleCameraServiceCaptureSnapshot(
    snapshot: JunLuoCameraServiceSnapshot,
    requestId: String,
    completedAt: Long,
    succeeded: Boolean,
    byteLength: Long? = null,
    failureCode: String? = null,
): JunLuoCameraServiceSnapshot = snapshot.copy(
    cameraReady = false,
    cameraState = JunLuoCameraServiceCameraState.IDLE,
    activeCaptureRequestId = null,
    lastCaptureRequestId = requestId,
    lastCaptureCompletedAt = completedAt,
    lastCaptureSucceeded = succeeded,
    lastCaptureByteLength = byteLength?.takeIf { succeeded && it > 0L },
    lastCaptureFailureCode = failureCode?.takeIf { !succeeded },
    cameraResourceOwner = null,
    cameraResourceLeaseId = null,
)

internal fun cameraServiceStartupGateFailure(
    activityResumed: Boolean,
    cameraPermissionGranted: Boolean,
    notificationPermissionGranted: Boolean,
    notificationVisible: Boolean,
): String? = when {
    !activityResumed -> JunLuoCameraServiceErrorCodes.VISIBLE_ACTIVITY_REQUIRED
    !cameraPermissionGranted -> JunLuoCameraErrorCodes.PERMISSION_REQUIRED
    !notificationPermissionGranted -> JunLuoCameraServiceErrorCodes.NOTIFICATION_PERMISSION_REQUIRED
    !notificationVisible -> JunLuoCameraServiceErrorCodes.NOTIFICATION_CHANNEL_BLOCKED
    else -> null
}

internal fun cameraServiceSessionConflict(
    snapshot: JunLuoCameraServiceSnapshot,
    request: JunLuoCameraServiceStartRequest,
): String? = if (
    isActiveCameraServiceStatus(snapshot.status) &&
    snapshot.sessionId != null &&
    snapshot.sessionId != request.sessionId
) {
    JunLuoCameraServiceErrorCodes.SESSION_ALREADY_RUNNING
} else {
    null
}

internal fun advanceCameraServiceSnapshot(
    previous: JunLuoCameraServiceSnapshot,
    candidate: JunLuoCameraServiceSnapshot,
): JunLuoCameraServiceSnapshot {
    val normalized = candidate.copy(
        schemaVersion = JUNLUO_CAMERA_SERVICE_SCHEMA_VERSION,
        revision = previous.revision,
    )
    return if (normalized == previous) previous else normalized.copy(revision = previous.revision.coerceAtLeast(0L) + 1L)
}

internal fun reconcileTerminatedCameraServiceSnapshot(
    snapshot: JunLuoCameraServiceSnapshot,
    occurredAt: Long,
): JunLuoCameraServiceSnapshot = reconcileStoppedCameraServiceSnapshot(
    snapshot = snapshot,
    occurredAt = occurredAt,
    stopReasonCode = JunLuoCameraServiceErrorCodes.PROCESS_TERMINATED,
    failureCode = JunLuoCameraServiceErrorCodes.PROCESS_TERMINATED,
)

internal fun reconcileTaskRemovedCameraServiceSnapshot(
    snapshot: JunLuoCameraServiceSnapshot,
    occurredAt: Long,
): JunLuoCameraServiceSnapshot = reconcileStoppedCameraServiceSnapshot(
    snapshot = snapshot,
    occurredAt = occurredAt,
    stopReasonCode = JUNLUO_CAMERA_TASK_REMOVED_STOP_REASON,
    failureCode = null,
)

internal fun isCameraServiceMiuiSwipeUpTaskRemoval(
    userRequested: Boolean,
    description: String?,
    exitTimestamp: Long,
    sessionStartedAt: Long?,
): Boolean = userRequested &&
    description?.contains(JUNLUO_CAMERA_MIUI_SWIPE_UP_CLEAN_MARKER, ignoreCase = true) == true &&
    sessionStartedAt != null &&
    exitTimestamp >= sessionStartedAt

private fun reconcileStoppedCameraServiceSnapshot(
    snapshot: JunLuoCameraServiceSnapshot,
    occurredAt: Long,
    stopReasonCode: String,
    failureCode: String?,
): JunLuoCameraServiceSnapshot {
    if (!isActiveCameraServiceStatus(snapshot.status)) return snapshot
    return advanceCameraServiceSnapshot(
        snapshot,
        snapshot.copy(
            status = JunLuoCameraServiceStatus.STOPPED,
            lastHeartbeatAt = occurredAt,
            cameraReady = false,
            cameraState = JunLuoCameraServiceCameraState.IDLE,
            activeCaptureRequestId = null,
            cameraResourceOwner = null,
            cameraResourceLeaseId = null,
            cameraResourcePausedAt = null,
            persistentNotificationVisible = false,
            lastFailureCode = failureCode,
            stopReasonCode = stopReasonCode,
            automaticObservation = stopAutomaticObservationState(snapshot.automaticObservation),
        ),
    )
}

internal fun isCurrentCameraServiceCallback(
    activeSessionId: String?,
    expectedSessionId: String,
    activeGeneration: Long,
    expectedGeneration: Long,
    terminating: Boolean,
): Boolean = !terminating && activeSessionId == expectedSessionId && activeGeneration == expectedGeneration

internal fun isCurrentCameraServiceCaptureCallback(
    activeSessionId: String?,
    expectedSessionId: String,
    activeGeneration: Long,
    expectedGeneration: Long,
    activeCaptureRequestId: String?,
    expectedCaptureRequestId: String,
    terminating: Boolean,
): Boolean = isCurrentCameraServiceCallback(
    activeSessionId,
    expectedSessionId,
    activeGeneration,
    expectedGeneration,
    terminating,
) && activeCaptureRequestId == expectedCaptureRequestId

internal fun cameraServiceSwitchGateFailure(
    snapshot: JunLuoCameraServiceSnapshot,
    sessionId: String,
): String? = when {
    snapshot.sessionId != sessionId -> JunLuoCameraServiceErrorCodes.STALE_SESSION
    snapshot.status == JunLuoCameraServiceStatus.PAUSED_CAMERA_BUSY -> JunLuoCameraServiceErrorCodes.RESOURCE_BUSY
    snapshot.status != JunLuoCameraServiceStatus.RUNNING -> JunLuoCameraErrorCodes.NOT_RUNNING
    snapshot.cameraState != JunLuoCameraServiceCameraState.IDLE -> JunLuoCameraErrorCodes.OPERATION_IN_PROGRESS
    snapshot.cameraResourceOwner != null -> JunLuoCameraServiceErrorCodes.RESOURCE_BUSY
    else -> null
}

internal fun beginCameraServicePreviewSnapshot(
    snapshot: JunLuoCameraServiceSnapshot,
    leaseId: String,
): JunLuoCameraServiceSnapshot = advanceCameraServiceSnapshot(
    snapshot,
    snapshot.copy(
        cameraReady = false,
        cameraState = JunLuoCameraServiceCameraState.OPENING,
        cameraResourceOwner = JunLuoCameraResourceOwner.OBSERVATION_PREVIEW,
        cameraResourceLeaseId = leaseId,
        cameraResourcePausedAt = null,
    ),
)

internal fun settleCameraServicePreviewSnapshot(
    snapshot: JunLuoCameraServiceSnapshot,
    leaseId: String,
    facing: JunLuoCameraFacing,
): JunLuoCameraServiceSnapshot? {
    if (
        snapshot.status != JunLuoCameraServiceStatus.RUNNING ||
        snapshot.cameraResourceOwner != JunLuoCameraResourceOwner.OBSERVATION_PREVIEW ||
        snapshot.cameraResourceLeaseId != leaseId
    ) return null
    return advanceCameraServiceSnapshot(
        snapshot,
        snapshot.copy(
            sourceKind = facing.sourceKind,
            cameraReady = true,
            cameraState = JunLuoCameraServiceCameraState.PREVIEWING,
        ),
    )
}

internal fun beginCameraServicePreviewCaptureSnapshot(
    snapshot: JunLuoCameraServiceSnapshot,
    leaseId: String,
    requestId: String,
): JunLuoCameraServiceSnapshot? {
    if (
        snapshot.status != JunLuoCameraServiceStatus.RUNNING ||
        snapshot.cameraState != JunLuoCameraServiceCameraState.PREVIEWING ||
        snapshot.activeCaptureRequestId != null ||
        snapshot.cameraResourceOwner != JunLuoCameraResourceOwner.OBSERVATION_PREVIEW ||
        snapshot.cameraResourceLeaseId != leaseId
    ) return null
    return advanceCameraServiceSnapshot(
        snapshot,
        snapshot.copy(
            cameraState = JunLuoCameraServiceCameraState.CAPTURING,
            activeCaptureRequestId = requestId,
            lastCaptureFailureCode = null,
        ),
    )
}

internal fun settleCameraServicePreviewCaptureSnapshot(
    snapshot: JunLuoCameraServiceSnapshot,
    leaseId: String,
    requestId: String,
    completedAt: Long,
    succeeded: Boolean,
    byteLength: Long? = null,
    failureCode: String? = null,
): JunLuoCameraServiceSnapshot? {
    if (
        snapshot.status != JunLuoCameraServiceStatus.RUNNING ||
        snapshot.cameraState != JunLuoCameraServiceCameraState.CAPTURING ||
        snapshot.activeCaptureRequestId != requestId ||
        snapshot.cameraResourceOwner != JunLuoCameraResourceOwner.OBSERVATION_PREVIEW ||
        snapshot.cameraResourceLeaseId != leaseId
    ) return null
    return advanceCameraServiceSnapshot(
        snapshot,
        snapshot.copy(
            cameraReady = true,
            cameraState = JunLuoCameraServiceCameraState.PREVIEWING,
            activeCaptureRequestId = null,
            lastCaptureRequestId = requestId,
            lastCaptureCompletedAt = completedAt,
            lastCaptureSucceeded = succeeded,
            lastCaptureByteLength = byteLength?.takeIf { succeeded && it > 0L },
            lastCaptureFailureCode = failureCode?.takeIf { !succeeded },
        ),
    )
}

internal fun releaseCameraServicePreviewSnapshot(
    snapshot: JunLuoCameraServiceSnapshot,
    leaseId: String,
): JunLuoCameraServiceSnapshot? {
    if (
        snapshot.status != JunLuoCameraServiceStatus.RUNNING ||
        snapshot.cameraResourceOwner != JunLuoCameraResourceOwner.OBSERVATION_PREVIEW ||
        snapshot.cameraResourceLeaseId != leaseId
    ) return null
    return advanceCameraServiceSnapshot(
        snapshot,
        snapshot.copy(
            cameraReady = false,
            cameraState = JunLuoCameraServiceCameraState.IDLE,
            cameraResourceOwner = null,
            cameraResourceLeaseId = null,
            cameraResourcePausedAt = null,
        ),
    )
}

internal fun pauseCameraServiceForResource(
    snapshot: JunLuoCameraServiceSnapshot,
    owner: JunLuoCameraResourceOwner,
    leaseId: String,
    pausedAt: Long,
): JunLuoCameraServiceSnapshot = advanceCameraServiceSnapshot(
    snapshot,
    snapshot.copy(
        status = JunLuoCameraServiceStatus.PAUSED_CAMERA_BUSY,
        cameraReady = false,
        cameraResourceOwner = owner,
        cameraResourceLeaseId = leaseId,
        cameraResourcePausedAt = pausedAt,
    ),
)

internal fun resumeCameraServiceFromResource(
    snapshot: JunLuoCameraServiceSnapshot,
    owner: JunLuoCameraResourceOwner,
    leaseId: String,
): JunLuoCameraServiceSnapshot? {
    if (
        snapshot.status != JunLuoCameraServiceStatus.PAUSED_CAMERA_BUSY ||
        snapshot.cameraResourceOwner != owner ||
        snapshot.cameraResourceLeaseId != leaseId
    ) return null
    return advanceCameraServiceSnapshot(
        snapshot,
        snapshot.copy(
            status = JunLuoCameraServiceStatus.RUNNING,
            cameraResourceOwner = null,
            cameraResourceLeaseId = null,
            cameraResourcePausedAt = null,
        ),
    )
}
