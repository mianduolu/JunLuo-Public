package __PACKAGE_NAME__.camera

import android.Manifest
import android.app.ForegroundServiceStartNotAllowedException
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import com.anonymous.junluo.MainActivity
import com.anonymous.junluo.R

object JunLuoCameraSessionServiceController {
    fun startFromVisibleActivity(
        activity: ComponentActivity,
        request: JunLuoCameraServiceStartRequest,
    ): JunLuoCameraServiceCommandReceipt {
        JunLuoCameraServiceNotifications.ensureChannel(activity)
        val gateFailure = cameraServiceStartupGateFailure(
            activityResumed = activity.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED),
            cameraPermissionGranted = hasPermission(activity, Manifest.permission.CAMERA),
            notificationPermissionGranted = Build.VERSION.SDK_INT < 33 ||
                hasPermission(activity, Manifest.permission.POST_NOTIFICATIONS),
            notificationVisible = JunLuoCameraServiceNotifications.visibilityFailure(activity) == null,
        )
        if (gateFailure != null) return JunLuoCameraServiceCommandReceipt.Rejected(gateFailure)
        if (!isValidCameraServiceStartRequest(request)) {
            return JunLuoCameraServiceCommandReceipt.Rejected(
                JunLuoCameraServiceErrorCodes.INVALID_SESSION_REQUEST,
            )
        }

        val current = JunLuoCameraServiceStore.reconcileIfStale(activity)
        if (JunLuoCameraResourceArbiter.hasExternalLease()) {
            return JunLuoCameraServiceCommandReceipt.Rejected(JunLuoCameraServiceErrorCodes.RESOURCE_BUSY)
        }
        cameraServiceSessionConflict(current, request)?.let { failure ->
            return JunLuoCameraServiceCommandReceipt.Rejected(failure)
        }
        if (isActiveCameraServiceStatus(current.status) && current.sessionId == request.sessionId) {
            return JunLuoCameraServiceCommandReceipt.Accepted(request.sessionId, current.status, current.revision)
        }

        val starting = try {
            JunLuoCameraServiceStore.update(activity) { previous ->
            previous.copy(
                status = JunLuoCameraServiceStatus.STARTING,
                sessionId = request.sessionId,
                sourceKind = request.facing.sourceKind,
                startedAt = request.requestedAt,
                lastHeartbeatAt = request.requestedAt,
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
                persistentNotificationVisible = false,
                lastFailureCode = null,
                stopReasonCode = null,
                cameraResourceOwner = null,
                cameraResourceLeaseId = null,
                cameraResourcePausedAt = null,
                automaticObservation = stopAutomaticObservationState(previous.automaticObservation),
            )
            }
        } catch (_: JunLuoCameraStatePersistException) {
            return JunLuoCameraServiceCommandReceipt.Rejected(JunLuoCameraServiceErrorCodes.STATE_PERSIST_FAILED)
        }
        JunLuoCameraProcessState.pendingSessionId = request.sessionId

        return try {
            ContextCompat.startForegroundService(activity, startIntent(activity, request))
            JunLuoCameraServiceCommandReceipt.Accepted(request.sessionId, starting.status, starting.revision)
        } catch (error: Throwable) {
            JunLuoCameraProcessState.pendingSessionId = null
            val failureCode = if (Build.VERSION.SDK_INT >= 31 && error is ForegroundServiceStartNotAllowedException) {
                JunLuoCameraServiceErrorCodes.FOREGROUND_START_NOT_ALLOWED
            } else {
                JunLuoCameraServiceErrorCodes.FOREGROUND_SERVICE_INVALID
            }
            val settled = runCatching { settleRejectedStart(activity, failureCode) }.isSuccess
            JunLuoCameraServiceCommandReceipt.Rejected(
                if (settled) failureCode else JunLuoCameraServiceErrorCodes.STATE_PERSIST_FAILED,
            )
        }
    }

    fun stop(context: Context, reasonCode: String) {
        val intent = Intent(context, JunLuoCameraSessionService::class.java).apply {
            action = JunLuoCameraSessionService.ACTION_STOP
            putExtra(JunLuoCameraSessionService.EXTRA_STOP_REASON, reasonCode.take(128))
        }
        runCatching { context.startService(intent) }
    }

    internal fun captureOnceForDebug(
        context: Context,
        request: JunLuoCameraServiceCaptureRequest,
        delayMs: Long = 0L,
    ): JunLuoCameraServiceCommandReceipt {
        JunLuoCameraRuntimeConditions.read(context).captureFailure(automatic = false)?.let {
            return JunLuoCameraServiceCommandReceipt.Rejected(it)
        }
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            return JunLuoCameraServiceCommandReceipt.Rejected(JunLuoCameraErrorCodes.PERMISSION_REQUIRED)
        }
        JunLuoCameraServiceNotifications.visibilityFailure(context)?.let { failureCode ->
            return JunLuoCameraServiceCommandReceipt.Rejected(failureCode)
        }
        val reservation = JunLuoCameraResourceArbiter.reserveObservationCapture(context, request)
        if (reservation is JunLuoCameraResourceReceipt.Rejected) {
            return JunLuoCameraServiceCommandReceipt.Rejected(reservation.failureCode)
        }
        val reserved = (reservation as JunLuoCameraResourceReceipt.Accepted).snapshot
        return try {
            context.startService(captureIntent(context, request, delayMs.coerceIn(0L, 5_000L)))
            JunLuoCameraServiceCommandReceipt.Accepted(request.sessionId, reserved.status, reserved.revision)
        } catch (_: Throwable) {
            val settled = runCatching {
                JunLuoCameraServiceStore.update(context) { snapshot ->
                    settleCameraServiceCaptureSnapshot(
                        snapshot,
                        request.requestId,
                        System.currentTimeMillis(),
                        succeeded = false,
                        failureCode = JunLuoCameraServiceErrorCodes.FOREGROUND_SERVICE_INVALID,
                    )
                }
            }.isSuccess
            JunLuoCameraResourceArbiter.forceReleaseObservation(reserved.cameraResourceLeaseId)
            JunLuoCameraServiceCommandReceipt.Rejected(
                if (settled) {
                    JunLuoCameraServiceErrorCodes.FOREGROUND_SERVICE_INVALID
                } else {
                    JunLuoCameraServiceErrorCodes.STATE_PERSIST_FAILED
                },
            )
        }
    }

    internal fun captureOnceForBridge(
        context: Context,
        request: JunLuoCameraServiceCaptureRequest,
    ): JunLuoCameraServiceCommandReceipt {
        if (
            request.deliveryMode != JunLuoCameraCaptureDeliveryMode.BRIDGE_EPHEMERAL &&
            request.deliveryMode != JunLuoCameraCaptureDeliveryMode.AUTOMATIC_EPHEMERAL
        ) {
            return JunLuoCameraServiceCommandReceipt.Rejected(JunLuoCameraServiceErrorCodes.INVALID_BRIDGE_PAYLOAD)
        }
        JunLuoCameraRuntimeConditions.read(context).captureFailure(
            automatic = request.deliveryMode == JunLuoCameraCaptureDeliveryMode.AUTOMATIC_EPHEMERAL,
        )?.let { return JunLuoCameraServiceCommandReceipt.Rejected(it) }
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            return JunLuoCameraServiceCommandReceipt.Rejected(JunLuoCameraErrorCodes.PERMISSION_REQUIRED)
        }
        JunLuoCameraServiceNotifications.visibilityFailure(context)?.let { failureCode ->
            return JunLuoCameraServiceCommandReceipt.Rejected(failureCode)
        }
        val reservation = JunLuoCameraResourceArbiter.reserveObservationCapture(context, request)
        if (reservation is JunLuoCameraResourceReceipt.Rejected) {
            return JunLuoCameraServiceCommandReceipt.Rejected(reservation.failureCode)
        }
        val reserved = (reservation as JunLuoCameraResourceReceipt.Accepted).snapshot
        return try {
            context.startService(captureIntent(context, request, 0L))
            JunLuoCameraServiceCommandReceipt.Accepted(request.sessionId, reserved.status, reserved.revision)
        } catch (_: Throwable) {
            val settled = runCatching {
                JunLuoCameraServiceStore.update(context) { snapshot ->
                    settleCameraServiceCaptureSnapshot(
                        snapshot,
                        request.requestId,
                        System.currentTimeMillis(),
                        succeeded = false,
                        failureCode = JunLuoCameraServiceErrorCodes.FOREGROUND_SERVICE_INVALID,
                    )
                }
            }.isSuccess
            JunLuoCameraResourceArbiter.forceReleaseObservation(reserved.cameraResourceLeaseId)
            JunLuoCameraServiceCommandReceipt.Rejected(
                if (settled) {
                    JunLuoCameraServiceErrorCodes.FOREGROUND_SERVICE_INVALID
                } else {
                    JunLuoCameraServiceErrorCodes.STATE_PERSIST_FAILED
                },
            )
        }
    }

    internal fun cancelCapture(context: Context, sessionId: String, requestId: String, captureGeneration: Long) {
        runCatching {
            context.startService(Intent(context, JunLuoCameraSessionService::class.java).apply {
                action = JunLuoCameraSessionService.ACTION_CANCEL_CAPTURE
                putExtra(JunLuoCameraSessionService.EXTRA_SESSION_ID, sessionId)
                putExtra(JunLuoCameraSessionService.EXTRA_CAPTURE_REQUEST_ID, requestId)
                putExtra(JunLuoCameraSessionService.EXTRA_CAPTURE_GENERATION, captureGeneration)
            })
        }
    }

    internal fun switchFacing(
        context: Context,
        sessionId: String,
        facing: JunLuoCameraFacing,
    ): JunLuoCameraServiceCommandReceipt {
        val current = JunLuoCameraServiceStore.read(context)
        cameraServiceSwitchGateFailure(current, sessionId)?.let {
            return JunLuoCameraServiceCommandReceipt.Rejected(it)
        }
        if (current.sourceKind == facing.sourceKind) {
            return JunLuoCameraServiceCommandReceipt.Accepted(sessionId, current.status, current.revision)
        }
        val updated = try {
            JunLuoCameraServiceStore.update(context) { latest ->
                cameraServiceSwitchGateFailure(latest, sessionId)?.let { throw JunLuoCameraResourceConflictException(it) }
                latest.copy(sourceKind = facing.sourceKind)
            }
        } catch (error: JunLuoCameraResourceConflictException) {
            return JunLuoCameraServiceCommandReceipt.Rejected(error.failureCode)
        } catch (_: JunLuoCameraStatePersistException) {
            return JunLuoCameraServiceCommandReceipt.Rejected(JunLuoCameraServiceErrorCodes.STATE_PERSIST_FAILED)
        }
        val serviceStart = runCatching {
            context.startService(Intent(context, JunLuoCameraSessionService::class.java).apply {
                action = JunLuoCameraSessionService.ACTION_SWITCH_FACING
                putExtra(JunLuoCameraSessionService.EXTRA_SESSION_ID, sessionId)
                putExtra(JunLuoCameraSessionService.EXTRA_FACING, facing.name)
            })
        }
        if (serviceStart.isFailure) {
            val reverted = runCatching {
                JunLuoCameraServiceStore.update(context) { latest ->
                    if (latest.sessionId == sessionId && latest.sourceKind == facing.sourceKind) {
                        latest.copy(sourceKind = current.sourceKind)
                    } else {
                        latest
                    }
                }
            }.isSuccess
            return JunLuoCameraServiceCommandReceipt.Rejected(
                if (reverted) {
                    JunLuoCameraServiceErrorCodes.FOREGROUND_SERVICE_INVALID
                } else {
                    JunLuoCameraServiceErrorCodes.STATE_PERSIST_FAILED
                },
            )
        }
        return JunLuoCameraServiceCommandReceipt.Accepted(sessionId, updated.status, updated.revision)
    }

    internal fun refreshResourceState(context: Context) {
        if (!JunLuoCameraProcessState.serviceAlive) return
        runCatching {
            context.startService(Intent(context, JunLuoCameraSessionService::class.java).apply {
                action = JunLuoCameraSessionService.ACTION_RESOURCE_STATE_CHANGED
            })
        }
    }

    internal fun refreshAutomaticSchedule(
        context: Context,
        sessionId: String,
        scheduleGeneration: Long,
    ) {
        if (!JunLuoCameraProcessState.serviceAlive) return
        runCatching {
            context.startService(Intent(context, JunLuoCameraSessionService::class.java).apply {
                action = JunLuoCameraSessionService.ACTION_AUTOMATIC_TICK
                putExtra(JunLuoCameraSessionService.EXTRA_SESSION_ID, sessionId)
                putExtra(JunLuoCameraSessionService.EXTRA_AUTOMATIC_GENERATION, scheduleGeneration)
            })
        }
    }

    fun readSnapshot(context: Context): JunLuoCameraServiceSnapshot =
        JunLuoCameraServiceStore.reconcileIfStale(context)

    internal fun startIntent(context: Context, request: JunLuoCameraServiceStartRequest) =
        Intent(context, JunLuoCameraSessionService::class.java).apply {
            action = JunLuoCameraSessionService.ACTION_START
            putExtra(JunLuoCameraSessionService.EXTRA_SESSION_ID, request.sessionId)
            putExtra(JunLuoCameraSessionService.EXTRA_FACING, request.facing.name)
            putExtra(JunLuoCameraSessionService.EXTRA_REQUESTED_AT, request.requestedAt)
            request.hardDeadlineAt?.let { putExtra(JunLuoCameraSessionService.EXTRA_HARD_DEADLINE_AT, it) }
            request.lastSuccessfulObservationAt?.let {
                putExtra(JunLuoCameraSessionService.EXTRA_LAST_SUCCESS_AT, it)
            }
        }

    internal fun captureIntent(
        context: Context,
        request: JunLuoCameraServiceCaptureRequest,
        delayMs: Long,
    ) = Intent(context, JunLuoCameraSessionService::class.java).apply {
        action = JunLuoCameraSessionService.ACTION_CAPTURE_ONCE
        putExtra(JunLuoCameraSessionService.EXTRA_SESSION_ID, request.sessionId)
        putExtra(JunLuoCameraSessionService.EXTRA_CAPTURE_REQUEST_ID, request.requestId)
        putExtra(JunLuoCameraSessionService.EXTRA_REQUESTED_AT, request.requestedAt)
        putExtra(JunLuoCameraSessionService.EXTRA_CAPTURE_DELAY_MS, delayMs)
        putExtra(JunLuoCameraSessionService.EXTRA_CAPTURE_GENERATION, request.captureGeneration)
        putExtra(JunLuoCameraSessionService.EXTRA_CAPTURE_DELIVERY_MODE, request.deliveryMode.name)
        request.automaticAttemptId?.let {
            putExtra(JunLuoCameraSessionService.EXTRA_AUTOMATIC_ATTEMPT_ID, it)
        }
    }

    internal fun requestFromIntent(intent: Intent?): JunLuoCameraServiceStartRequest? {
        if (intent?.action != JunLuoCameraSessionService.ACTION_START) return null
        val sessionId = intent.getStringExtra(JunLuoCameraSessionService.EXTRA_SESSION_ID) ?: return null
        val facing = runCatching {
            JunLuoCameraFacing.valueOf(intent.getStringExtra(JunLuoCameraSessionService.EXTRA_FACING).orEmpty())
        }.getOrNull() ?: return null
        val request = JunLuoCameraServiceStartRequest(
            sessionId = sessionId,
            facing = facing,
            requestedAt = intent.getLongExtra(JunLuoCameraSessionService.EXTRA_REQUESTED_AT, 0L),
            hardDeadlineAt = intent.optionalLong(JunLuoCameraSessionService.EXTRA_HARD_DEADLINE_AT),
            lastSuccessfulObservationAt = intent.optionalLong(JunLuoCameraSessionService.EXTRA_LAST_SUCCESS_AT),
        )
        return request.takeIf(::isValidCameraServiceStartRequest)
    }

    internal fun captureRequestFromIntent(intent: Intent?): JunLuoCameraServiceCaptureRequest? {
        if (intent?.action != JunLuoCameraSessionService.ACTION_CAPTURE_ONCE) return null
        val request = JunLuoCameraServiceCaptureRequest(
            sessionId = intent.getStringExtra(JunLuoCameraSessionService.EXTRA_SESSION_ID) ?: return null,
            requestId = intent.getStringExtra(JunLuoCameraSessionService.EXTRA_CAPTURE_REQUEST_ID) ?: return null,
            requestedAt = intent.getLongExtra(JunLuoCameraSessionService.EXTRA_REQUESTED_AT, 0L),
            captureGeneration = intent.getLongExtra(JunLuoCameraSessionService.EXTRA_CAPTURE_GENERATION, 0L),
            deliveryMode = runCatching {
                JunLuoCameraCaptureDeliveryMode.valueOf(
                    intent.getStringExtra(JunLuoCameraSessionService.EXTRA_CAPTURE_DELIVERY_MODE)
                        ?: JunLuoCameraCaptureDeliveryMode.AUDIT_ONLY.name,
                )
            }.getOrNull() ?: return null,
            automaticAttemptId = intent.getStringExtra(
                JunLuoCameraSessionService.EXTRA_AUTOMATIC_ATTEMPT_ID,
            ),
        )
        return request.takeIf(::isValidCameraServiceCaptureRequest)
    }

    private fun settleRejectedStart(context: Context, failureCode: String) {
        JunLuoCameraServiceStore.update(context) { previous ->
            previous.copy(
                status = JunLuoCameraServiceStatus.STOPPED,
                lastHeartbeatAt = System.currentTimeMillis(),
                cameraReady = false,
                cameraState = JunLuoCameraServiceCameraState.IDLE,
                activeCaptureRequestId = null,
                cameraResourceOwner = null,
                cameraResourceLeaseId = null,
                cameraResourcePausedAt = null,
                persistentNotificationVisible = false,
                lastFailureCode = failureCode,
                stopReasonCode = failureCode,
                automaticObservation = stopAutomaticObservationState(previous.automaticObservation),
            )
        }
    }

    private fun hasPermission(context: Context, permission: String): Boolean =
        ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

    private fun Intent.optionalLong(key: String): Long? = if (hasExtra(key)) getLongExtra(key, 0L) else null
}

internal object JunLuoCameraServiceNotifications {
    const val ONGOING_NOTIFICATION_ID = 73051
    const val STOPPED_NOTIFICATION_ID = 73052

    fun ensureChannel(context: Context) {
        if (Build.VERSION.SDK_INT < 26) return
        val manager = context.getSystemService(NotificationManager::class.java)
        val channel = NotificationChannel(
            JUNLUO_CAMERA_NOTIFICATION_CHANNEL_ID,
            context.getString(R.string.junluo_camera_channel_name),
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = context.getString(R.string.junluo_camera_channel_description)
            lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            setSound(null, null)
            enableVibration(false)
            setShowBadge(false)
        }
        manager.createNotificationChannel(channel)
    }

    fun visibilityFailure(context: Context): String? {
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(
                context,
                Manifest.permission.POST_NOTIFICATIONS,
            ) != PackageManager.PERMISSION_GRANTED
        ) {
            return JunLuoCameraServiceErrorCodes.NOTIFICATION_PERMISSION_REQUIRED
        }
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) {
            return JunLuoCameraServiceErrorCodes.NOTIFICATION_CHANNEL_BLOCKED
        }
        if (Build.VERSION.SDK_INT >= 26) {
            val channel = context.getSystemService(NotificationManager::class.java)
                .getNotificationChannel(JUNLUO_CAMERA_NOTIFICATION_CHANNEL_ID)
            if (channel == null || channel.importance == NotificationManager.IMPORTANCE_NONE) {
                return JunLuoCameraServiceErrorCodes.NOTIFICATION_CHANNEL_BLOCKED
            }
        }
        return null
    }

    fun buildOngoing(
        context: Context,
        status: JunLuoCameraServiceStatus,
        facing: JunLuoCameraFacing?,
        cameraState: JunLuoCameraServiceCameraState,
        automaticPhase: JunLuoCameraAutomaticPhase = JunLuoCameraAutomaticPhase.INACTIVE,
    ): Notification {
        val body = when (status) {
            JunLuoCameraServiceStatus.STARTING -> R.string.junluo_camera_notification_starting
            JunLuoCameraServiceStatus.PAUSED_CAMERA_BUSY -> R.string.junluo_camera_notification_manual_paused
            JunLuoCameraServiceStatus.STOPPING -> R.string.junluo_camera_notification_stopping
            else -> when {
                automaticPhase == JunLuoCameraAutomaticPhase.QUIET_PAUSED ->
                    R.string.junluo_camera_notification_automatic_quiet
                automaticPhase == JunLuoCameraAutomaticPhase.PREREQUISITE_BLOCKED ||
                    automaticPhase == JunLuoCameraAutomaticPhase.DEGRADED ->
                    R.string.junluo_camera_notification_automatic_restricted
                automaticPhase == JunLuoCameraAutomaticPhase.EXECUTING && facing == JunLuoCameraFacing.BACK ->
                    R.string.junluo_camera_notification_back_observing
                automaticPhase == JunLuoCameraAutomaticPhase.EXECUTING ->
                    R.string.junluo_camera_notification_front_observing
                cameraState == JunLuoCameraServiceCameraState.OPENING && facing == JunLuoCameraFacing.BACK ->
                    R.string.junluo_camera_notification_back_preview_starting
                cameraState == JunLuoCameraServiceCameraState.OPENING ->
                    R.string.junluo_camera_notification_front_preview_starting
                cameraState == JunLuoCameraServiceCameraState.PREVIEWING && facing == JunLuoCameraFacing.BACK ->
                    R.string.junluo_camera_notification_back_previewing
                cameraState == JunLuoCameraServiceCameraState.PREVIEWING ->
                    R.string.junluo_camera_notification_front_previewing
                cameraState == JunLuoCameraServiceCameraState.IDLE &&
                    automaticPhase == JunLuoCameraAutomaticPhase.INACTIVE ->
                    R.string.junluo_camera_notification_manual_session
                cameraState == JunLuoCameraServiceCameraState.IDLE && facing == JunLuoCameraFacing.BACK ->
                    R.string.junluo_camera_notification_back_standby
                cameraState == JunLuoCameraServiceCameraState.IDLE ->
                    R.string.junluo_camera_notification_front_standby
                facing == JunLuoCameraFacing.BACK ->
                    R.string.junluo_camera_notification_back_observing
                else -> R.string.junluo_camera_notification_front_observing
            }
        }
        val openApp = PendingIntent.getActivity(
            context,
            73050,
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val stopService = PendingIntent.getService(
            context,
            73051,
            Intent(context, JunLuoCameraSessionService::class.java).apply {
                action = JunLuoCameraSessionService.ACTION_STOP
                putExtra(JunLuoCameraSessionService.EXTRA_STOP_REASON, "notification_stop")
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val conditions = JunLuoCameraRuntimeConditions.read(context)
        val runtimeRestriction = when {
            conditions.thermalPaused -> context.getString(R.string.junluo_camera_notification_thermal_paused)
            conditions.lowBatteryPaused -> context.getString(R.string.junluo_camera_notification_low_battery)
            else -> null
        }
        val bodyText = context.getString(body) + (runtimeRestriction?.let { " · $it" } ?: "")
        return NotificationCompat.Builder(context, JUNLUO_CAMERA_NOTIFICATION_CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(context.getString(R.string.junluo_camera_channel_name))
            .setContentText(bodyText)
            .setContentIntent(openApp)
            .setOngoing(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .addAction(0, context.getString(R.string.junluo_camera_notification_stop_action), stopService)
            .build()
    }

    fun postStopped(context: Context, failureCode: String) {
        if (visibilityFailure(context) != null) return
        val notification = NotificationCompat.Builder(context, JUNLUO_CAMERA_NOTIFICATION_CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(context.getString(R.string.junluo_camera_notification_stopped_title))
            .setContentText(failureCode)
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setSilent(true)
            .build()
        NotificationManagerCompat.from(context).notify(STOPPED_NOTIFICATION_ID, notification)
    }

    fun openSettingsIntent(context: Context): Intent = if (Build.VERSION.SDK_INT >= 26) {
        Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS).apply {
            putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
            putExtra(Settings.EXTRA_CHANNEL_ID, JUNLUO_CAMERA_NOTIFICATION_CHANNEL_ID)
        }
    } else {
        Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).apply {
            putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
        }
    }
}
