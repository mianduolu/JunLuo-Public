package __PACKAGE_NAME__.camera

import java.util.Calendar

const val JUNLUO_CAMERA_AUTOMATIC_WATCHDOG_MS = 330_000L
const val JUNLUO_CAMERA_MODEL_OBSERVATION_MODE = "model_choice_v1"

enum class JunLuoCameraAutomaticPhase(val wireValue: String) {
    INACTIVE("inactive"),
    WAITING_MINIMUM("waiting_minimum"),
    OPPORTUNITY_OPEN("opportunity_open"),
    DEADLINE_DUE("deadline_due"),
    QUIET_PAUSED("quiet_paused"),
    PREREQUISITE_BLOCKED("prerequisite_blocked"),
    EXECUTING("executing"),
    RETRY_WAITING("retry_waiting"),
    DEGRADED("degraded");

    companion object {
        fun fromWireValue(value: String?): JunLuoCameraAutomaticPhase? =
            entries.firstOrNull { it.wireValue == value }
    }
}

enum class JunLuoCameraAutomaticTriggerKind(val wireValue: String) {
    ACTION_OPPORTUNITY("action_opportunity"),
    MAX_INTERVAL_DEADLINE("max_interval_deadline"),
    RETRY_AFTER_FAILURE("retry_after_failure");

    companion object {
        fun fromWireValue(value: String?): JunLuoCameraAutomaticTriggerKind? =
            entries.firstOrNull { it.wireValue == value }
    }
}

data class JunLuoCameraAutomaticObservationState(
    val enabled: Boolean = false,
    val phase: JunLuoCameraAutomaticPhase = JunLuoCameraAutomaticPhase.INACTIVE,
    val scheduleGeneration: Long = 0L,
    val minimumIntervalMinutes: Int = 30,
    val maximumIntervalMinutes: Int = 120,
    val quietHoursEnabled: Boolean = false,
    val quietStartMinuteOfDay: Int = 0,
    val quietEndMinuteOfDay: Int = 9 * 60,
    val anchorAt: Long? = null,
    val nextOpportunityAt: Long? = null,
    val hardDeadlineAt: Long? = null,
    val resumeAt: Long? = null,
    val quietCatchUpPending: Boolean = false,
    val activeAttemptId: String? = null,
    val activeRequestId: String? = null,
    val activeTriggerKind: JunLuoCameraAutomaticTriggerKind? = null,
    val activeRetryUsed: Boolean = false,
    val consecutiveFailureCount: Int = 0,
    val nextRetryAt: Long? = null,
    val lastAttemptAt: Long? = null,
    val lastAttemptTriggerKind: JunLuoCameraAutomaticTriggerKind? = null,
    val lastFailureCode: String? = null,
    val overdueByMs: Long = 0L,
)

data class JunLuoCameraAutomaticPolicyRequest(
    val sessionId: String?,
    val enabled: Boolean,
    val minimumIntervalMinutes: Int,
    val maximumIntervalMinutes: Int,
    val quietHoursEnabled: Boolean,
    val quietStartMinuteOfDay: Int,
    val quietEndMinuteOfDay: Int,
    val latestSuccessfulObservationAt: Long?,
)

data class JunLuoCameraAutomaticCompletionRequest(
    val sessionId: String,
    val attemptId: String,
    val requestId: String,
    val scheduleGeneration: Long,
    val outcome: String,
    val failureCode: String?,
    val observationId: String?,
    val capturedAt: Long?,
)

internal class JunLuoCameraAutomaticStaleAttemptException : IllegalStateException()

internal object JunLuoCameraAutomaticDebugClock {
    @Volatile var offsetMs: Long = 0L
}

internal fun junLuoCameraAutomaticNow(): Long =
    System.currentTimeMillis() + JunLuoCameraAutomaticDebugClock.offsetMs

internal fun isValidAutomaticPolicy(request: JunLuoCameraAutomaticPolicyRequest): Boolean {
    if (request.sessionId != null && !isValidCameraRequestId(request.sessionId)) return false
    if (request.minimumIntervalMinutes !in 5..1440) return false
    if (request.maximumIntervalMinutes !in 5..1440) return false
    if (request.quietStartMinuteOfDay !in 0 until 1440) return false
    if (request.quietEndMinuteOfDay !in 0 until 1440) return false
    if (request.quietHoursEnabled && request.quietStartMinuteOfDay == request.quietEndMinuteOfDay) return false
    if (request.latestSuccessfulObservationAt != null && request.latestSuccessfulObservationAt <= 0L) return false
    return true
}

internal fun automaticPolicyTargetsCurrentSession(
    snapshot: JunLuoCameraServiceSnapshot,
    requestedSessionId: String?,
): Boolean = if (isActiveCameraServiceStatus(snapshot.status)) {
    snapshot.sessionId == requestedSessionId
} else {
    requestedSessionId == null
}

internal fun isValidAutomaticCompletion(request: JunLuoCameraAutomaticCompletionRequest): Boolean {
    if (!isValidCameraRequestId(request.sessionId)) return false
    if (!isValidCameraRequestId(request.attemptId)) return false
    if (!isValidCameraRequestId(request.requestId)) return false
    if (request.scheduleGeneration < 0L) return false
    if (request.outcome !in setOf("success", "prerequisite_blocked", "failure")) return false
    return if (request.outcome == "success") {
        isValidCameraRequestId(request.observationId.orEmpty()) &&
            request.capturedAt != null && request.capturedAt > 0L &&
            request.failureCode == null
    } else {
        !request.failureCode.isNullOrBlank() &&
            request.failureCode.length <= 128 &&
            request.observationId == null &&
            request.capturedAt == null
    }
}

internal fun isAutomaticQuietAt(
    state: JunLuoCameraAutomaticObservationState,
    now: Long,
): Boolean {
    if (!state.quietHoursEnabled) return false
    val calendar = Calendar.getInstance().apply { timeInMillis = now }
    val minute = calendar.get(Calendar.HOUR_OF_DAY) * 60 + calendar.get(Calendar.MINUTE)
    return if (state.quietStartMinuteOfDay < state.quietEndMinuteOfDay) {
        minute >= state.quietStartMinuteOfDay && minute < state.quietEndMinuteOfDay
    } else {
        minute >= state.quietStartMinuteOfDay || minute < state.quietEndMinuteOfDay
    }
}

internal fun nextAutomaticQuietEndAt(
    state: JunLuoCameraAutomaticObservationState,
    now: Long,
): Long? {
    if (!state.quietHoursEnabled) return null
    val calendar = Calendar.getInstance().apply {
        timeInMillis = now
        set(Calendar.SECOND, 0)
        set(Calendar.MILLISECOND, 0)
    }
    val minute = calendar.get(Calendar.HOUR_OF_DAY) * 60 + calendar.get(Calendar.MINUTE)
    calendar.set(Calendar.HOUR_OF_DAY, state.quietEndMinuteOfDay / 60)
    calendar.set(Calendar.MINUTE, state.quietEndMinuteOfDay % 60)
    val endIsToday = if (state.quietStartMinuteOfDay < state.quietEndMinuteOfDay) {
        minute < state.quietEndMinuteOfDay
    } else {
        minute < state.quietEndMinuteOfDay
    }
    if (!endIsToday || calendar.timeInMillis <= now) calendar.add(Calendar.DAY_OF_YEAR, 1)
    return calendar.timeInMillis
}

internal fun recomputeAutomaticObservationState(
    state: JunLuoCameraAutomaticObservationState,
    now: Long,
    sessionActive: Boolean,
): JunLuoCameraAutomaticObservationState {
    if (!state.enabled || !sessionActive) {
        return state.copy(
            enabled = false,
            phase = JunLuoCameraAutomaticPhase.INACTIVE,
            nextOpportunityAt = null,
            hardDeadlineAt = null,
            resumeAt = null,
            quietCatchUpPending = false,
            activeAttemptId = null,
            activeRequestId = null,
            activeTriggerKind = null,
            activeRetryUsed = false,
            nextRetryAt = null,
            overdueByMs = 0L,
        )
    }
    // A never-used session is immediately eligible; do not manufacture a success.
    val anchor = listOfNotNull(state.anchorAt, state.lastAttemptAt).maxOrNull()
    val opportunityAt = anchor?.let { it + state.minimumIntervalMinutes * 60_000L }
    val quiet = isAutomaticQuietAt(state, now)
    val interrupted = quiet && state.phase == JunLuoCameraAutomaticPhase.EXECUTING
    return state.copy(
        phase = when {
            quiet -> JunLuoCameraAutomaticPhase.QUIET_PAUSED
            state.phase == JunLuoCameraAutomaticPhase.EXECUTING -> JunLuoCameraAutomaticPhase.EXECUTING
            opportunityAt != null && now < opportunityAt -> JunLuoCameraAutomaticPhase.WAITING_MINIMUM
            else -> JunLuoCameraAutomaticPhase.OPPORTUNITY_OPEN
        },
        scheduleGeneration = state.scheduleGeneration + if (interrupted) 1L else 0L,
        nextOpportunityAt = opportunityAt,
        hardDeadlineAt = null,
        resumeAt = if (quiet) nextAutomaticQuietEndAt(state, now) else null,
        quietCatchUpPending = false,
        activeAttemptId = if (quiet) null else state.activeAttemptId,
        activeRequestId = if (quiet) null else state.activeRequestId,
        activeTriggerKind = if (quiet) null else state.activeTriggerKind,
        activeRetryUsed = if (quiet) false else state.activeRetryUsed,
        nextRetryAt = null,
        overdueByMs = 0L,
    )
}

internal fun applyAutomaticObservationPolicy(
    snapshot: JunLuoCameraServiceSnapshot,
    request: JunLuoCameraAutomaticPolicyRequest,
    now: Long,
): JunLuoCameraServiceSnapshot {
    val current = snapshot.automaticObservation
    val activeSession = snapshot.status == JunLuoCameraServiceStatus.RUNNING && snapshot.sessionId != null
    val enabled = request.enabled && activeSession
    val latestSuccess = listOfNotNull(
        snapshot.lastSuccessfulObservationAt, current.anchorAt, request.latestSuccessfulObservationAt,
    ).maxOrNull()
    val policyChanged = current.enabled != enabled ||
        current.minimumIntervalMinutes != request.minimumIntervalMinutes ||
        current.quietHoursEnabled != request.quietHoursEnabled ||
        current.quietStartMinuteOfDay != request.quietStartMinuteOfDay ||
        current.quietEndMinuteOfDay != request.quietEndMinuteOfDay
    val anchorChanged = latestSuccess != current.anchorAt
    val invalidated = policyChanged || anchorChanged
    val candidate = current.copy(
        enabled = enabled,
        phase = if (invalidated) JunLuoCameraAutomaticPhase.INACTIVE else current.phase,
        scheduleGeneration = current.scheduleGeneration + if (invalidated) 1L else 0L,
        minimumIntervalMinutes = request.minimumIntervalMinutes,
        maximumIntervalMinutes = request.maximumIntervalMinutes, // Legacy sync-only field.
        quietHoursEnabled = request.quietHoursEnabled,
        quietStartMinuteOfDay = request.quietStartMinuteOfDay,
        quietEndMinuteOfDay = request.quietEndMinuteOfDay,
        anchorAt = latestSuccess,
        activeAttemptId = if (invalidated) null else current.activeAttemptId,
        activeRequestId = if (invalidated) null else current.activeRequestId,
        activeTriggerKind = if (invalidated) null else current.activeTriggerKind,
        activeRetryUsed = if (invalidated) false else current.activeRetryUsed,
        consecutiveFailureCount = if (anchorChanged) 0 else current.consecutiveFailureCount,
        lastFailureCode = if (anchorChanged) null else current.lastFailureCode,
    )
    return snapshot.copy(
        lastSuccessfulObservationAt = latestSuccess,
        hardDeadlineAt = null,
        automaticObservation = recomputeAutomaticObservationState(candidate, now, activeSession),
    )
}

internal fun automaticObservationOpportunityGateFailure(
    snapshot: JunLuoCameraServiceSnapshot,
    sessionId: String,
    scheduleGeneration: Long,
    now: Long,
    enforceMinimumInterval: Boolean,
): String? {
    val state = snapshot.automaticObservation
    if (snapshot.sessionId != sessionId || state.scheduleGeneration != scheduleGeneration) {
        return JunLuoCameraServiceErrorCodes.AUTOMATIC_ATTEMPT_STALE
    }
    if (snapshot.status != JunLuoCameraServiceStatus.RUNNING || !state.enabled ||
        isAutomaticQuietAt(state, now)) return JunLuoCameraServiceErrorCodes.AUTOMATIC_OPPORTUNITY_NOT_AVAILABLE
    if (state.phase == JunLuoCameraAutomaticPhase.EXECUTING || state.activeAttemptId != null) {
        return JunLuoCameraServiceErrorCodes.RESOURCE_BUSY
    }
    val anchor = listOfNotNull(state.lastAttemptAt, snapshot.lastSuccessfulObservationAt, state.anchorAt).maxOrNull()
    if (enforceMinimumInterval && anchor != null && now < anchor + state.minimumIntervalMinutes * 60_000L) {
        return JunLuoCameraServiceErrorCodes.AUTOMATIC_OPPORTUNITY_NOT_AVAILABLE
    }
    return null
}

internal fun beginAutomaticObservationAttempt(
    state: JunLuoCameraAutomaticObservationState,
    now: Long,
    attemptId: String,
    requestId: String,
): JunLuoCameraAutomaticObservationState = state.copy(
    phase = JunLuoCameraAutomaticPhase.EXECUTING,
    activeAttemptId = attemptId,
    activeRequestId = requestId,
    activeTriggerKind = JunLuoCameraAutomaticTriggerKind.ACTION_OPPORTUNITY,
    activeRetryUsed = false,
    lastAttemptAt = now,
    lastAttemptTriggerKind = JunLuoCameraAutomaticTriggerKind.ACTION_OPPORTUNITY,
    nextRetryAt = null,
    lastFailureCode = null,
)

internal fun retryAutomaticObservationAttempt(
    snapshot: JunLuoCameraServiceSnapshot,
    sessionId: String,
    generation: Long,
    attemptId: String,
    requestId: String,
    nextRequestId: String?,
    now: Long,
): JunLuoCameraAutomaticObservationState? {
    val state = snapshot.automaticObservation
    if (snapshot.status != JunLuoCameraServiceStatus.RUNNING || snapshot.sessionId != sessionId ||
        !state.enabled || isAutomaticQuietAt(state, now) ||
        state.phase != JunLuoCameraAutomaticPhase.EXECUTING ||
        state.scheduleGeneration != generation || state.activeAttemptId != attemptId ||
        state.activeRequestId != requestId || state.activeRetryUsed ||
        nextRequestId == requestId) return null
    return state.copy(activeRetryUsed = true, activeRequestId = nextRequestId ?: requestId)
}

internal fun completeAutomaticObservationAttempt(
    state: JunLuoCameraAutomaticObservationState,
    request: JunLuoCameraAutomaticCompletionRequest,
    now: Long,
): JunLuoCameraAutomaticObservationState? {
    if (
        !state.enabled || isAutomaticQuietAt(state, now) || state.phase != JunLuoCameraAutomaticPhase.EXECUTING ||
        state.scheduleGeneration != request.scheduleGeneration ||
        state.activeAttemptId != request.attemptId || state.activeRequestId != request.requestId
    ) return null
    val succeeded = request.outcome == "success"
    if (succeeded && request.capturedAt == null) return null
    return recomputeAutomaticObservationState(
        state.copy(
            phase = JunLuoCameraAutomaticPhase.INACTIVE,
            scheduleGeneration = state.scheduleGeneration + 1L,
            anchorAt = if (succeeded) listOfNotNull(state.anchorAt, request.capturedAt).maxOrNull() else state.anchorAt,
            activeAttemptId = null,
            activeRequestId = null,
            activeTriggerKind = null,
            activeRetryUsed = false,
            consecutiveFailureCount = if (succeeded) 0 else state.consecutiveFailureCount +
                if (request.outcome == "failure") 1 else 0,
            nextRetryAt = null,
            lastFailureCode = if (succeeded) null else request.failureCode,
        ),
        now,
        sessionActive = true,
    )
}

internal fun stopAutomaticObservationState(
    state: JunLuoCameraAutomaticObservationState,
): JunLuoCameraAutomaticObservationState = state.copy(
    enabled = false,
    phase = JunLuoCameraAutomaticPhase.INACTIVE,
    scheduleGeneration = state.scheduleGeneration + 1L,
    nextOpportunityAt = null,
    hardDeadlineAt = null,
    resumeAt = null,
    quietCatchUpPending = false,
    activeAttemptId = null,
    activeRequestId = null,
    activeTriggerKind = null,
    activeRetryUsed = false,
    nextRetryAt = null,
    overdueByMs = 0L,
)

internal fun migrateModelObservationSnapshot(snapshot: JunLuoCameraServiceSnapshot): JunLuoCameraServiceSnapshot =
    if (snapshot.schemaVersion == JUNLUO_CAMERA_SERVICE_SCHEMA_VERSION) snapshot else advanceCameraServiceSnapshot(
        snapshot,
        snapshot.copy(
            hardDeadlineAt = null,
            automaticObservation = stopAutomaticObservationState(snapshot.automaticObservation).copy(
                anchorAt = snapshot.lastSuccessfulObservationAt,
                consecutiveFailureCount = 0,
            ),
        ),
    )
