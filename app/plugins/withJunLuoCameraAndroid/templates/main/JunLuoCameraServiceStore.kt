package __PACKAGE_NAME__.camera

import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.content.Context
import android.os.Build

internal class JunLuoCameraStatePersistException : IllegalStateException(
    JunLuoCameraServiceErrorCodes.STATE_PERSIST_FAILED,
)

internal object JunLuoCameraProcessState {
    @Volatile var serviceAlive = false
    @Volatile var pendingSessionId: String? = null

    fun owns(sessionId: String?): Boolean = sessionId != null && (serviceAlive || pendingSessionId == sessionId)
}

internal object JunLuoCameraServiceStore {
    private const val KEY_SCHEMA_VERSION = "schema_version"
    private const val KEY_REVISION = "revision"
    private const val KEY_STATUS = "status"
    private const val KEY_SESSION_ID = "session_id"
    private const val KEY_SOURCE_KIND = "source_kind"
    private const val KEY_STARTED_AT = "started_at"
    private const val KEY_HEARTBEAT_AT = "heartbeat_at"
    private const val KEY_HARD_DEADLINE_AT = "hard_deadline_at"
    private const val KEY_LAST_SUCCESS_AT = "last_success_at"
    private const val KEY_CAMERA_READY = "camera_ready"
    private const val KEY_CAMERA_STATE = "camera_state"
    private const val KEY_ACTIVE_CAPTURE_REQUEST_ID = "active_capture_request_id"
    private const val KEY_LAST_CAPTURE_REQUEST_ID = "last_capture_request_id"
    private const val KEY_LAST_CAPTURE_COMPLETED_AT = "last_capture_completed_at"
    private const val KEY_LAST_CAPTURE_SUCCEEDED = "last_capture_succeeded"
    private const val KEY_LAST_CAPTURE_BYTE_LENGTH = "last_capture_byte_length"
    private const val KEY_LAST_CAPTURE_FAILURE_CODE = "last_capture_failure_code"
    private const val KEY_NOTIFICATION_VISIBLE = "notification_visible"
    private const val KEY_FAILURE_CODE = "failure_code"
    private const val KEY_STOP_REASON = "stop_reason"
    private const val KEY_RESOURCE_OWNER = "camera_resource_owner"
    private const val KEY_RESOURCE_LEASE_ID = "camera_resource_lease_id"
    private const val KEY_RESOURCE_PAUSED_AT = "camera_resource_paused_at"
    private const val KEY_LAST_SESSION_ID = "last_session_id"
    private const val KEY_AUTO_ENABLED = "automatic_enabled"
    private const val KEY_AUTO_PHASE = "automatic_phase"
    private const val KEY_AUTO_GENERATION = "automatic_generation"
    private const val KEY_AUTO_MINIMUM_MINUTES = "automatic_minimum_minutes"
    private const val KEY_AUTO_MAXIMUM_MINUTES = "automatic_maximum_minutes"
    private const val KEY_AUTO_QUIET_ENABLED = "automatic_quiet_enabled"
    private const val KEY_AUTO_QUIET_START = "automatic_quiet_start"
    private const val KEY_AUTO_QUIET_END = "automatic_quiet_end"
    private const val KEY_AUTO_ANCHOR_AT = "automatic_anchor_at"
    private const val KEY_AUTO_NEXT_OPPORTUNITY_AT = "automatic_next_opportunity_at"
    private const val KEY_AUTO_DEADLINE_AT = "automatic_deadline_at"
    private const val KEY_AUTO_RESUME_AT = "automatic_resume_at"
    private const val KEY_AUTO_QUIET_CATCH_UP = "automatic_quiet_catch_up"
    private const val KEY_AUTO_ACTIVE_ATTEMPT_ID = "automatic_active_attempt_id"
    private const val KEY_AUTO_ACTIVE_REQUEST_ID = "automatic_active_request_id"
    private const val KEY_AUTO_ACTIVE_TRIGGER = "automatic_active_trigger"
    private const val KEY_AUTO_ACTIVE_RETRY_USED = "automatic_active_retry_used"
    private const val KEY_AUTO_FAILURE_COUNT = "automatic_failure_count"
    private const val KEY_AUTO_NEXT_RETRY_AT = "automatic_next_retry_at"
    private const val KEY_AUTO_LAST_ATTEMPT_AT = "automatic_last_attempt_at"
    private const val KEY_AUTO_LAST_ATTEMPT_TRIGGER = "automatic_last_attempt_trigger"
    private const val KEY_AUTO_LAST_FAILURE_CODE = "automatic_last_failure_code"
    private const val KEY_AUTO_OVERDUE_MS = "automatic_overdue_ms"

    @Volatile private var lastConfirmedSnapshot: JunLuoCameraServiceSnapshot? = null

    @Synchronized
    fun read(context: Context): JunLuoCameraServiceSnapshot {
        val preferences = preferences(context)
        val status = runCatching {
            JunLuoCameraServiceStatus.valueOf(preferences.getString(KEY_STATUS, null).orEmpty())
        }.getOrDefault(JunLuoCameraServiceStatus.STOPPED)
        val cameraState = runCatching {
            JunLuoCameraServiceCameraState.valueOf(preferences.getString(KEY_CAMERA_STATE, null).orEmpty())
        }.getOrDefault(JunLuoCameraServiceCameraState.IDLE)
        val resourceOwner = JunLuoCameraResourceOwner.fromWireValue(
            preferences.getString(KEY_RESOURCE_OWNER, null),
        )
        val automaticObservation = JunLuoCameraAutomaticObservationState(
            enabled = preferences.getBoolean(KEY_AUTO_ENABLED, false),
            phase = JunLuoCameraAutomaticPhase.fromWireValue(
                preferences.getString(KEY_AUTO_PHASE, null),
            ) ?: JunLuoCameraAutomaticPhase.INACTIVE,
            scheduleGeneration = preferences.getLong(KEY_AUTO_GENERATION, 0L).coerceAtLeast(0L),
            minimumIntervalMinutes = preferences.getInt(KEY_AUTO_MINIMUM_MINUTES, 30).coerceIn(5, 1440),
            maximumIntervalMinutes = preferences.getInt(KEY_AUTO_MAXIMUM_MINUTES, 120).coerceIn(5, 1440),
            quietHoursEnabled = preferences.getBoolean(KEY_AUTO_QUIET_ENABLED, false),
            quietStartMinuteOfDay = preferences.getInt(KEY_AUTO_QUIET_START, 0).coerceIn(0, 1439),
            quietEndMinuteOfDay = preferences.getInt(KEY_AUTO_QUIET_END, 9 * 60).coerceIn(0, 1439),
            anchorAt = readNullableLong(preferences, KEY_AUTO_ANCHOR_AT),
            nextOpportunityAt = readNullableLong(preferences, KEY_AUTO_NEXT_OPPORTUNITY_AT),
            hardDeadlineAt = readNullableLong(preferences, KEY_AUTO_DEADLINE_AT),
            resumeAt = readNullableLong(preferences, KEY_AUTO_RESUME_AT),
            quietCatchUpPending = preferences.getBoolean(KEY_AUTO_QUIET_CATCH_UP, false),
            activeAttemptId = preferences.getString(KEY_AUTO_ACTIVE_ATTEMPT_ID, null),
            activeRequestId = preferences.getString(KEY_AUTO_ACTIVE_REQUEST_ID, null),
            activeTriggerKind = JunLuoCameraAutomaticTriggerKind.fromWireValue(
                preferences.getString(KEY_AUTO_ACTIVE_TRIGGER, null),
            ),
            activeRetryUsed = preferences.getBoolean(KEY_AUTO_ACTIVE_RETRY_USED, false),
            consecutiveFailureCount = preferences.getInt(KEY_AUTO_FAILURE_COUNT, 0).coerceAtLeast(0),
            nextRetryAt = readNullableLong(preferences, KEY_AUTO_NEXT_RETRY_AT),
            lastAttemptAt = readNullableLong(preferences, KEY_AUTO_LAST_ATTEMPT_AT),
            lastAttemptTriggerKind = JunLuoCameraAutomaticTriggerKind.fromWireValue(
                preferences.getString(KEY_AUTO_LAST_ATTEMPT_TRIGGER, null),
            ),
            lastFailureCode = preferences.getString(KEY_AUTO_LAST_FAILURE_CODE, null),
            overdueByMs = preferences.getLong(KEY_AUTO_OVERDUE_MS, 0L).coerceAtLeast(0L),
        )
        val stored = JunLuoCameraServiceSnapshot(
            schemaVersion = preferences.getInt(KEY_SCHEMA_VERSION, JUNLUO_CAMERA_SERVICE_SCHEMA_VERSION),
            revision = preferences.getLong(KEY_REVISION, 0L).coerceAtLeast(0L),
            status = status,
            sessionId = preferences.getString(KEY_SESSION_ID, null),
            sourceKind = preferences.getString(KEY_SOURCE_KIND, null),
            startedAt = readNullableLong(preferences, KEY_STARTED_AT),
            lastHeartbeatAt = readNullableLong(preferences, KEY_HEARTBEAT_AT),
            hardDeadlineAt = readNullableLong(preferences, KEY_HARD_DEADLINE_AT),
            lastSuccessfulObservationAt = readNullableLong(preferences, KEY_LAST_SUCCESS_AT),
            cameraReady = preferences.getBoolean(KEY_CAMERA_READY, false),
            cameraState = cameraState,
            activeCaptureRequestId = preferences.getString(KEY_ACTIVE_CAPTURE_REQUEST_ID, null),
            lastCaptureRequestId = preferences.getString(KEY_LAST_CAPTURE_REQUEST_ID, null),
            lastCaptureCompletedAt = readNullableLong(preferences, KEY_LAST_CAPTURE_COMPLETED_AT),
            lastCaptureSucceeded = readNullableBoolean(preferences, KEY_LAST_CAPTURE_SUCCEEDED),
            lastCaptureByteLength = readNullableLong(preferences, KEY_LAST_CAPTURE_BYTE_LENGTH),
            lastCaptureFailureCode = preferences.getString(KEY_LAST_CAPTURE_FAILURE_CODE, null),
            persistentNotificationVisible = preferences.getBoolean(KEY_NOTIFICATION_VISIBLE, false),
            lastFailureCode = preferences.getString(KEY_FAILURE_CODE, null),
            stopReasonCode = preferences.getString(KEY_STOP_REASON, null),
            cameraResourceOwner = resourceOwner,
            cameraResourceLeaseId = preferences.getString(KEY_RESOURCE_LEASE_ID, null),
            cameraResourcePausedAt = readNullableLong(preferences, KEY_RESOURCE_PAUSED_AT),
            lastSessionId = preferences.getString(KEY_LAST_SESSION_ID, null),
            automaticObservation = automaticObservation,
        )
        val migrated = migrateModelObservationSnapshot(stored)
        if (migrated != stored) {
            write(context, migrated)
            JunLuoCameraAutomaticObservationScheduler.cancelAlarm(context)
            JunLuoCameraServiceEventBus.publishSnapshot(migrated)
        }
        return migrated.also { lastConfirmedSnapshot = it }
    }

    @Synchronized
    fun update(
        context: Context,
        transform: (JunLuoCameraServiceSnapshot) -> JunLuoCameraServiceSnapshot,
    ): JunLuoCameraServiceSnapshot {
        val previous = read(context)
        val next = advanceCameraServiceSnapshot(previous, transform(previous))
        if (next != previous) {
            write(context, next)
            lastConfirmedSnapshot = next
            JunLuoCameraServiceEventBus.publishSnapshot(next)
        }
        return next
    }

    @Synchronized
    fun reconcileIfStale(context: Context): JunLuoCameraServiceSnapshot {
        val snapshot = read(context)
        if (!isActiveCameraServiceStatus(snapshot.status) || JunLuoCameraProcessState.owns(snapshot.sessionId)) {
            return snapshot
        }
        val now = System.currentTimeMillis()
        val taskRemovedAt = findMiuiSwipeUpTaskRemovalAt(context, snapshot)
        val reconciled = if (taskRemovedAt != null) {
            reconcileTaskRemovedCameraServiceSnapshot(snapshot, taskRemovedAt)
        } else {
            reconcileTerminatedCameraServiceSnapshot(snapshot, now)
        }
        write(context, reconciled)
        lastConfirmedSnapshot = reconciled
        JunLuoCameraServiceEventBus.publishSnapshot(reconciled)
        return reconciled
    }

    private fun findMiuiSwipeUpTaskRemovalAt(
        context: Context,
        snapshot: JunLuoCameraServiceSnapshot,
    ): Long? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return null
        val exitInfo = runCatching {
            context.getSystemService(ActivityManager::class.java)
                .getHistoricalProcessExitReasons(context.packageName, 0, 1)
                .firstOrNull()
        }.getOrNull() ?: return null
        return exitInfo.timestamp.takeIf { exitTimestamp ->
            isCameraServiceMiuiSwipeUpTaskRemoval(
                userRequested = exitInfo.reason == ApplicationExitInfo.REASON_USER_REQUESTED,
                description = exitInfo.description,
                exitTimestamp = exitTimestamp,
                sessionStartedAt = snapshot.startedAt,
            )
        }
    }

    private fun write(context: Context, snapshot: JunLuoCameraServiceSnapshot) {
        val committed = preferences(context).edit()
            .putInt(KEY_SCHEMA_VERSION, JUNLUO_CAMERA_SERVICE_SCHEMA_VERSION)
            .putLong(KEY_REVISION, snapshot.revision)
            .putString(KEY_STATUS, snapshot.status.name)
            .putNullableString(KEY_SESSION_ID, snapshot.sessionId)
            .putNullableString(KEY_SOURCE_KIND, snapshot.sourceKind)
            .putNullableLong(KEY_STARTED_AT, snapshot.startedAt)
            .putNullableLong(KEY_HEARTBEAT_AT, snapshot.lastHeartbeatAt)
            .putNullableLong(KEY_HARD_DEADLINE_AT, snapshot.hardDeadlineAt)
            .putNullableLong(KEY_LAST_SUCCESS_AT, snapshot.lastSuccessfulObservationAt)
            .putBoolean(KEY_CAMERA_READY, snapshot.cameraReady)
            .putString(KEY_CAMERA_STATE, snapshot.cameraState.name)
            .putNullableString(KEY_ACTIVE_CAPTURE_REQUEST_ID, snapshot.activeCaptureRequestId)
            .putNullableString(KEY_LAST_CAPTURE_REQUEST_ID, snapshot.lastCaptureRequestId)
            .putNullableLong(KEY_LAST_CAPTURE_COMPLETED_AT, snapshot.lastCaptureCompletedAt)
            .putNullableBoolean(KEY_LAST_CAPTURE_SUCCEEDED, snapshot.lastCaptureSucceeded)
            .putNullableLong(KEY_LAST_CAPTURE_BYTE_LENGTH, snapshot.lastCaptureByteLength)
            .putNullableString(KEY_LAST_CAPTURE_FAILURE_CODE, snapshot.lastCaptureFailureCode)
            .putBoolean(KEY_NOTIFICATION_VISIBLE, snapshot.persistentNotificationVisible)
            .putNullableString(KEY_FAILURE_CODE, snapshot.lastFailureCode)
            .putNullableString(KEY_STOP_REASON, snapshot.stopReasonCode)
            .putNullableString(KEY_RESOURCE_OWNER, snapshot.cameraResourceOwner?.wireValue)
            .putNullableString(KEY_RESOURCE_LEASE_ID, snapshot.cameraResourceLeaseId)
            .putNullableLong(KEY_RESOURCE_PAUSED_AT, snapshot.cameraResourcePausedAt)
            .putNullableString(KEY_LAST_SESSION_ID, snapshot.lastSessionId)
            .putBoolean(KEY_AUTO_ENABLED, snapshot.automaticObservation.enabled)
            .putString(KEY_AUTO_PHASE, snapshot.automaticObservation.phase.wireValue)
            .putLong(KEY_AUTO_GENERATION, snapshot.automaticObservation.scheduleGeneration)
            .putInt(KEY_AUTO_MINIMUM_MINUTES, snapshot.automaticObservation.minimumIntervalMinutes)
            .putInt(KEY_AUTO_MAXIMUM_MINUTES, snapshot.automaticObservation.maximumIntervalMinutes)
            .putBoolean(KEY_AUTO_QUIET_ENABLED, snapshot.automaticObservation.quietHoursEnabled)
            .putInt(KEY_AUTO_QUIET_START, snapshot.automaticObservation.quietStartMinuteOfDay)
            .putInt(KEY_AUTO_QUIET_END, snapshot.automaticObservation.quietEndMinuteOfDay)
            .putNullableLong(KEY_AUTO_ANCHOR_AT, snapshot.automaticObservation.anchorAt)
            .putNullableLong(KEY_AUTO_NEXT_OPPORTUNITY_AT, snapshot.automaticObservation.nextOpportunityAt)
            .putNullableLong(KEY_AUTO_DEADLINE_AT, snapshot.automaticObservation.hardDeadlineAt)
            .putNullableLong(KEY_AUTO_RESUME_AT, snapshot.automaticObservation.resumeAt)
            .putBoolean(KEY_AUTO_QUIET_CATCH_UP, snapshot.automaticObservation.quietCatchUpPending)
            .putNullableString(KEY_AUTO_ACTIVE_ATTEMPT_ID, snapshot.automaticObservation.activeAttemptId)
            .putNullableString(KEY_AUTO_ACTIVE_REQUEST_ID, snapshot.automaticObservation.activeRequestId)
            .putNullableString(KEY_AUTO_ACTIVE_TRIGGER, snapshot.automaticObservation.activeTriggerKind?.wireValue)
            .putBoolean(KEY_AUTO_ACTIVE_RETRY_USED, snapshot.automaticObservation.activeRetryUsed)
            .putInt(KEY_AUTO_FAILURE_COUNT, snapshot.automaticObservation.consecutiveFailureCount)
            .putNullableLong(KEY_AUTO_NEXT_RETRY_AT, snapshot.automaticObservation.nextRetryAt)
            .putNullableLong(KEY_AUTO_LAST_ATTEMPT_AT, snapshot.automaticObservation.lastAttemptAt)
            .putNullableString(KEY_AUTO_LAST_ATTEMPT_TRIGGER, snapshot.automaticObservation.lastAttemptTriggerKind?.wireValue)
            .putNullableString(KEY_AUTO_LAST_FAILURE_CODE, snapshot.automaticObservation.lastFailureCode)
            .putLong(KEY_AUTO_OVERDUE_MS, snapshot.automaticObservation.overdueByMs)
            .commit()
        if (!committed) throw JunLuoCameraStatePersistException()
    }

    private fun preferences(context: Context) = context.applicationContext.getSharedPreferences(
        JUNLUO_CAMERA_SERVICE_STORE_NAME,
        Context.MODE_PRIVATE,
    )

    private fun readNullableLong(preferences: android.content.SharedPreferences, key: String): Long? =
        if (preferences.contains(key)) preferences.getLong(key, 0L) else null

    private fun readNullableBoolean(preferences: android.content.SharedPreferences, key: String): Boolean? =
        if (preferences.contains(key)) preferences.getBoolean(key, false) else null

    private fun android.content.SharedPreferences.Editor.putNullableLong(key: String, value: Long?) = apply {
        if (value == null) remove(key) else putLong(key, value)
    }

    private fun android.content.SharedPreferences.Editor.putNullableString(key: String, value: String?) = apply {
        if (value == null) remove(key) else putString(key, value)
    }

    private fun android.content.SharedPreferences.Editor.putNullableBoolean(key: String, value: Boolean?) = apply {
        if (value == null) remove(key) else putBoolean(key, value)
    }
}
