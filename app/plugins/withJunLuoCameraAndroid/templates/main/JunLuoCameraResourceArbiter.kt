package __PACKAGE_NAME__.camera

import android.content.Context
import java.util.UUID

internal data class JunLuoCameraResourceLease(
    val leaseId: String,
    val owner: JunLuoCameraResourceOwner,
    val sessionId: String?,
    val bridgeGeneration: Long?,
)

internal sealed class JunLuoCameraResourceReceipt {
    data class Accepted(
        val lease: JunLuoCameraResourceLease,
        val snapshot: JunLuoCameraServiceSnapshot,
    ) : JunLuoCameraResourceReceipt()

    data class Rejected(val failureCode: String) : JunLuoCameraResourceReceipt()
}

internal object JunLuoCameraResourceArbiter {
    private var activeLease: JunLuoCameraResourceLease? = null

    @Synchronized
    fun acquireManual(
        context: Context,
        owner: JunLuoCameraResourceOwner,
        bridgeGeneration: Long,
    ): JunLuoCameraResourceReceipt {
        if (owner == JunLuoCameraResourceOwner.OBSERVATION_CAPTURE || owner == JunLuoCameraResourceOwner.OBSERVATION_PREVIEW) {
            return JunLuoCameraResourceReceipt.Rejected(JunLuoCameraServiceErrorCodes.INVALID_BRIDGE_PAYLOAD)
        }
        if (activeLease?.owner == JunLuoCameraResourceOwner.OBSERVATION_CAPTURE) {
            return JunLuoCameraResourceReceipt.Rejected(JunLuoCameraErrorCodes.CAPTURE_IN_PROGRESS)
        }
        if (activeLease != null) return JunLuoCameraResourceReceipt.Rejected(JunLuoCameraServiceErrorCodes.RESOURCE_BUSY)
        val snapshot = JunLuoCameraServiceStore.read(context)
        if (snapshot.automaticObservation.phase == JunLuoCameraAutomaticPhase.EXECUTING) {
            return JunLuoCameraResourceReceipt.Rejected(JunLuoCameraServiceErrorCodes.RESOURCE_BUSY)
        }
        if (
            snapshot.cameraState == JunLuoCameraServiceCameraState.OPENING ||
            snapshot.cameraState == JunLuoCameraServiceCameraState.CAPTURING
        ) return JunLuoCameraResourceReceipt.Rejected(JunLuoCameraErrorCodes.CAPTURE_IN_PROGRESS)
        val lease = JunLuoCameraResourceLease(
            leaseId = UUID.randomUUID().toString(),
            owner = owner,
            sessionId = snapshot.sessionId.takeIf { snapshot.status == JunLuoCameraServiceStatus.RUNNING },
            bridgeGeneration = bridgeGeneration,
        )
        val committed = if (snapshot.status == JunLuoCameraServiceStatus.RUNNING && snapshot.sessionId != null) {
            try {
                JunLuoCameraServiceStore.update(context) { current ->
                    if (
                        current.revision != snapshot.revision ||
                        current.status != JunLuoCameraServiceStatus.RUNNING ||
                        current.cameraState != JunLuoCameraServiceCameraState.IDLE ||
                        current.cameraResourceOwner != null
                    ) throw JunLuoCameraResourceConflictException()
                    pauseCameraServiceForResource(current, owner, lease.leaseId, System.currentTimeMillis())
                }
            } catch (_: JunLuoCameraResourceConflictException) {
                return JunLuoCameraResourceReceipt.Rejected(JunLuoCameraServiceErrorCodes.RESOURCE_BUSY)
            } catch (_: JunLuoCameraStatePersistException) {
                return JunLuoCameraResourceReceipt.Rejected(JunLuoCameraServiceErrorCodes.STATE_PERSIST_FAILED)
            }
        } else {
            snapshot
        }
        activeLease = lease
        return JunLuoCameraResourceReceipt.Accepted(lease, committed)
    }

    @Synchronized
    fun reserveObservationCapture(
        context: Context,
        request: JunLuoCameraServiceCaptureRequest,
    ): JunLuoCameraResourceReceipt {
        if (activeLease != null) return JunLuoCameraResourceReceipt.Rejected(JunLuoCameraServiceErrorCodes.RESOURCE_BUSY)
        if (JunLuoCameraBridgeFrameRegistry.hasPendingFrame()) {
            return JunLuoCameraResourceReceipt.Rejected(JunLuoCameraServiceErrorCodes.FRAME_PENDING_RELEASE)
        }
        val current = JunLuoCameraServiceStore.read(context)
        cameraServiceCaptureGateFailure(current, request)?.let { return JunLuoCameraResourceReceipt.Rejected(it) }
        val lease = JunLuoCameraResourceLease(
            leaseId = UUID.randomUUID().toString(),
            owner = JunLuoCameraResourceOwner.OBSERVATION_CAPTURE,
            sessionId = request.sessionId,
            bridgeGeneration = null,
        )
        val committed = try {
            JunLuoCameraServiceStore.update(context) { latest ->
                cameraServiceCaptureGateFailure(latest, request)?.let { throw JunLuoCameraResourceConflictException(it) }
                beginCameraServiceCaptureSnapshot(latest, request).copy(cameraResourceLeaseId = lease.leaseId)
            }
        } catch (error: JunLuoCameraResourceConflictException) {
            return JunLuoCameraResourceReceipt.Rejected(error.failureCode)
        } catch (_: JunLuoCameraStatePersistException) {
            return JunLuoCameraResourceReceipt.Rejected(JunLuoCameraServiceErrorCodes.STATE_PERSIST_FAILED)
        }
        activeLease = lease
        return JunLuoCameraResourceReceipt.Accepted(lease, committed)
    }

    @Synchronized
    fun reserveObservationPreview(
        context: Context,
        sessionId: String,
    ): JunLuoCameraResourceReceipt {
        if (activeLease != null) return JunLuoCameraResourceReceipt.Rejected(JunLuoCameraServiceErrorCodes.RESOURCE_BUSY)
        val current = JunLuoCameraServiceStore.read(context)
        if (current.status != JunLuoCameraServiceStatus.RUNNING || current.sessionId != sessionId) {
            return JunLuoCameraResourceReceipt.Rejected(JunLuoCameraServiceErrorCodes.STALE_SESSION)
        }
        if (current.automaticObservation.phase == JunLuoCameraAutomaticPhase.EXECUTING) {
            return JunLuoCameraResourceReceipt.Rejected(JunLuoCameraServiceErrorCodes.RESOURCE_BUSY)
        }
        if (current.cameraState != JunLuoCameraServiceCameraState.IDLE || current.cameraResourceOwner != null) {
            return JunLuoCameraResourceReceipt.Rejected(JunLuoCameraServiceErrorCodes.RESOURCE_BUSY)
        }
        val lease = JunLuoCameraResourceLease(
            leaseId = UUID.randomUUID().toString(),
            owner = JunLuoCameraResourceOwner.OBSERVATION_PREVIEW,
            sessionId = sessionId,
            bridgeGeneration = null,
        )
        val committed = try {
            JunLuoCameraServiceStore.update(context) { latest ->
                if (
                    latest.revision != current.revision ||
                    latest.status != JunLuoCameraServiceStatus.RUNNING ||
                    latest.sessionId != sessionId ||
                    latest.cameraState != JunLuoCameraServiceCameraState.IDLE ||
                    latest.cameraResourceOwner != null
                ) throw JunLuoCameraResourceConflictException()
                beginCameraServicePreviewSnapshot(latest, lease.leaseId)
            }
        } catch (error: JunLuoCameraResourceConflictException) {
            return JunLuoCameraResourceReceipt.Rejected(error.failureCode)
        } catch (_: JunLuoCameraStatePersistException) {
            return JunLuoCameraResourceReceipt.Rejected(JunLuoCameraServiceErrorCodes.STATE_PERSIST_FAILED)
        }
        activeLease = lease
        return JunLuoCameraResourceReceipt.Accepted(lease, committed)
    }

    @Synchronized
    fun markObservationPreviewStarting(
        context: Context,
        leaseId: String,
    ): JunLuoCameraResourceReceipt = updateObservationPreview(context, leaseId) { snapshot, lease ->
        beginCameraServicePreviewSnapshot(snapshot, lease.leaseId)
    }

    @Synchronized
    fun settleObservationPreview(
        context: Context,
        leaseId: String,
        facing: JunLuoCameraFacing,
    ): JunLuoCameraResourceReceipt = updateObservationPreview(context, leaseId) { snapshot, lease ->
        settleCameraServicePreviewSnapshot(snapshot, lease.leaseId, facing)
            ?: throw JunLuoCameraResourceConflictException(JunLuoCameraServiceErrorCodes.PREVIEW_STALE_GENERATION)
    }

    @Synchronized
    fun beginObservationPreviewCapture(
        context: Context,
        leaseId: String,
        requestId: String,
    ): JunLuoCameraResourceReceipt = updateObservationPreview(context, leaseId) { snapshot, lease ->
        beginCameraServicePreviewCaptureSnapshot(snapshot, lease.leaseId, requestId)
            ?: throw JunLuoCameraResourceConflictException(JunLuoCameraServiceErrorCodes.RESOURCE_BUSY)
    }

    @Synchronized
    fun settleObservationPreviewCapture(
        context: Context,
        leaseId: String,
        requestId: String,
        completedAt: Long,
        succeeded: Boolean,
        byteLength: Long? = null,
        failureCode: String? = null,
    ): JunLuoCameraResourceReceipt = updateObservationPreview(context, leaseId) { snapshot, lease ->
        settleCameraServicePreviewCaptureSnapshot(
            snapshot,
            lease.leaseId,
            requestId,
            completedAt,
            succeeded,
            byteLength,
            failureCode,
        ) ?: throw JunLuoCameraResourceConflictException(JunLuoCameraServiceErrorCodes.PREVIEW_STALE_GENERATION)
    }

    @Synchronized
    fun release(
        context: Context,
        owner: JunLuoCameraResourceOwner,
        leaseId: String,
    ): JunLuoCameraResourceReceipt {
        val lease = activeLease ?: run {
            if (owner != JunLuoCameraResourceOwner.OBSERVATION_PREVIEW) {
                return JunLuoCameraResourceReceipt.Rejected(JunLuoCameraServiceErrorCodes.RESOURCE_LEASE_MISMATCH)
            }
            val persisted = JunLuoCameraServiceStore.read(context)
            if (
                persisted.cameraResourceOwner != owner ||
                persisted.cameraResourceLeaseId != leaseId
            ) {
                return JunLuoCameraResourceReceipt.Rejected(JunLuoCameraServiceErrorCodes.RESOURCE_LEASE_MISMATCH)
            }
            JunLuoCameraResourceLease(leaseId, owner, persisted.sessionId, null)
        }
        if (activeLease != null && (lease.owner != owner || lease.leaseId != leaseId)) {
            return JunLuoCameraResourceReceipt.Rejected(JunLuoCameraServiceErrorCodes.RESOURCE_LEASE_MISMATCH)
        }
        val snapshot = JunLuoCameraServiceStore.read(context)
        val committed = if (owner == JunLuoCameraResourceOwner.OBSERVATION_PREVIEW) {
            try {
                JunLuoCameraServiceStore.update(context) { current ->
                    releaseCameraServicePreviewSnapshot(current, leaseId)
                        ?: throw JunLuoCameraResourceConflictException(JunLuoCameraServiceErrorCodes.STALE_SESSION)
                }
            } catch (_: JunLuoCameraStatePersistException) {
                return JunLuoCameraResourceReceipt.Rejected(JunLuoCameraServiceErrorCodes.STATE_PERSIST_FAILED)
            } catch (error: JunLuoCameraResourceConflictException) {
                activeLease = null
                return JunLuoCameraResourceReceipt.Rejected(error.failureCode)
            }
        } else if (owner != JunLuoCameraResourceOwner.OBSERVATION_CAPTURE && lease.sessionId != null) {
            val resumed = resumeCameraServiceFromResource(snapshot, owner, leaseId)
            if (resumed == null) {
                activeLease = null
                return JunLuoCameraResourceReceipt.Rejected(JunLuoCameraServiceErrorCodes.STALE_SESSION)
            }
            try {
                JunLuoCameraServiceStore.update(context) { current ->
                    resumeCameraServiceFromResource(current, owner, leaseId)
                        ?: throw JunLuoCameraResourceConflictException(JunLuoCameraServiceErrorCodes.STALE_SESSION)
                }
            } catch (_: JunLuoCameraStatePersistException) {
                return JunLuoCameraResourceReceipt.Rejected(JunLuoCameraServiceErrorCodes.STATE_PERSIST_FAILED)
            } catch (error: JunLuoCameraResourceConflictException) {
                activeLease = null
                return JunLuoCameraResourceReceipt.Rejected(error.failureCode)
            }
        } else snapshot
        if (activeLease?.leaseId == leaseId) activeLease = null
        return JunLuoCameraResourceReceipt.Accepted(lease, committed)
    }

    @Synchronized
    fun forceReleaseObservation(leaseId: String?) {
        val lease = activeLease ?: return
        if (
            (lease.owner == JunLuoCameraResourceOwner.OBSERVATION_CAPTURE || lease.owner == JunLuoCameraResourceOwner.OBSERVATION_PREVIEW) &&
            (leaseId == null || lease.leaseId == leaseId)
        ) {
            activeLease = null
        }
    }

    @Synchronized
    fun hasExternalLease(): Boolean = activeLease?.owner == JunLuoCameraResourceOwner.MANUAL_CAMERA ||
        activeLease?.owner == JunLuoCameraResourceOwner.VIDEO_CALL_CAMERA

    @Synchronized
    fun invalidateBridgeGeneration(generation: Long) {
        if (activeLease?.bridgeGeneration == generation) {
            activeLease = activeLease?.copy(bridgeGeneration = -generation.coerceAtLeast(1L))
        }
    }

    @Synchronized
    fun recoverLostManualLease(
        context: Context,
        activeBridgeGeneration: Long,
        activityResumed: Boolean,
    ): JunLuoCameraResourceReceipt? {
        val lease = activeLease ?: return null
        if (
            !activityResumed ||
            lease.owner == JunLuoCameraResourceOwner.OBSERVATION_CAPTURE ||
            lease.owner == JunLuoCameraResourceOwner.OBSERVATION_PREVIEW
        ) return null
        if (lease.bridgeGeneration == activeBridgeGeneration) return null
        return release(context, lease.owner, lease.leaseId)
    }

    private fun updateObservationPreview(
        context: Context,
        leaseId: String,
        transform: (JunLuoCameraServiceSnapshot, JunLuoCameraResourceLease) -> JunLuoCameraServiceSnapshot,
    ): JunLuoCameraResourceReceipt {
        val lease = activeLease
            ?: return JunLuoCameraResourceReceipt.Rejected(JunLuoCameraServiceErrorCodes.PREVIEW_STALE_GENERATION)
        if (lease.owner != JunLuoCameraResourceOwner.OBSERVATION_PREVIEW || lease.leaseId != leaseId) {
            return JunLuoCameraResourceReceipt.Rejected(JunLuoCameraServiceErrorCodes.PREVIEW_STALE_GENERATION)
        }
        val committed = try {
            JunLuoCameraServiceStore.update(context) { snapshot -> transform(snapshot, lease) }
        } catch (error: JunLuoCameraResourceConflictException) {
            return JunLuoCameraResourceReceipt.Rejected(error.failureCode)
        } catch (_: JunLuoCameraStatePersistException) {
            return JunLuoCameraResourceReceipt.Rejected(JunLuoCameraServiceErrorCodes.STATE_PERSIST_FAILED)
        }
        return JunLuoCameraResourceReceipt.Accepted(lease, committed)
    }
}

internal class JunLuoCameraResourceConflictException(
    val failureCode: String = JunLuoCameraServiceErrorCodes.RESOURCE_BUSY,
) : IllegalStateException(failureCode)
