package com.anonymous.junluo

enum class PhoneUsageDisplayState {
    ON,
    OFF,
    DOZE,
    SUSPENDED,
    UNKNOWN,
}

enum class PhoneUsageStopReason {
    NONE,
    NO_FOREGROUND,
    APP_SWITCH,
    HOME,
    OWN_APP,
    SYSTEM_UI,
    SCREEN_OFF,
    DOZE,
    IDLE_TIMEOUT,
    VIDEO_STOPPED,
    COLLECTOR_STOP,
}

data class PhoneUsageTimingInput(
    val foregroundPackage: String?,
    val foregroundStartedAt: Long,
    val lastInteractionAt: Long,
    val systemIdleTimeoutMs: Long,
    val isInteractive: Boolean,
    val displayState: PhoneUsageDisplayState,
    val isHomePackage: Boolean,
    val isOwnPackage: Boolean,
    val isSystemUiPackage: Boolean,
    val isVideoPlaying: Boolean,
    val wasVideoExempt: Boolean,
    val videoStateChangedAt: Long?,
    val lastClosedAt: Long,
    val lastClosedPackage: String?,
    val now: Long,
)

data class PhoneUsageTimingDecision(
    val isCounting: Boolean,
    val segmentStartedAt: Long?,
    val segmentEndedAt: Long?,
    val nextIdleDeadlineAt: Long?,
    val videoExempt: Boolean,
    val stopReason: PhoneUsageStopReason,
)

object PhoneUsageTimingPolicy {
    const val DEFAULT_IDLE_TIMEOUT_MS = 10L * 60L * 1_000L
    const val MAX_REASONABLE_IDLE_TIMEOUT_MS = 60L * 60L * 1_000L

    fun normalizeIdleTimeout(value: Long?): Long {
        return value
            ?.takeIf { it > 0L && it <= MAX_REASONABLE_IDLE_TIMEOUT_MS }
            ?: DEFAULT_IDLE_TIMEOUT_MS
    }

    fun decide(input: PhoneUsageTimingInput): PhoneUsageTimingDecision {
        val packageName = input.foregroundPackage?.trim().orEmpty()
        if (packageName.isBlank()) return stopped(PhoneUsageStopReason.NO_FOREGROUND)
        if (input.isHomePackage) return stopped(PhoneUsageStopReason.HOME)
        if (input.isOwnPackage) return stopped(PhoneUsageStopReason.OWN_APP)
        if (input.isSystemUiPackage) return stopped(PhoneUsageStopReason.SYSTEM_UI)

        val timeoutMs = normalizeIdleTimeout(input.systemIdleTimeoutMs)
        val interactionAt = maxOf(input.foregroundStartedAt, input.lastInteractionAt)
        val alreadyClosed = input.lastClosedPackage == packageName && input.lastClosedAt >= interactionAt
        if (alreadyClosed) {
            return stopped(
                if (input.wasVideoExempt) PhoneUsageStopReason.VIDEO_STOPPED
                else PhoneUsageStopReason.IDLE_TIMEOUT
            )
        }

        val segmentStartedAt = if (
            input.lastClosedPackage == packageName &&
            input.lastClosedAt >= input.foregroundStartedAt
        ) {
            interactionAt
        } else {
            input.foregroundStartedAt
        }.coerceAtLeast(0L)

        val idleDeadlineAt = safeAdd(interactionAt, timeoutMs)
        if (!input.isInteractive || input.displayState == PhoneUsageDisplayState.OFF) {
            return stopped(
                reason = PhoneUsageStopReason.SCREEN_OFF,
                startedAt = segmentStartedAt,
                endedAt = hardStopAt(input, idleDeadlineAt),
            )
        }
        if (
            input.displayState == PhoneUsageDisplayState.DOZE ||
            input.displayState == PhoneUsageDisplayState.SUSPENDED ||
            input.displayState == PhoneUsageDisplayState.UNKNOWN
        ) {
            return stopped(
                reason = PhoneUsageStopReason.DOZE,
                startedAt = segmentStartedAt,
                endedAt = hardStopAt(input, idleDeadlineAt),
            )
        }

        if (input.now < idleDeadlineAt) {
            return PhoneUsageTimingDecision(
                isCounting = true,
                segmentStartedAt = segmentStartedAt,
                segmentEndedAt = null,
                nextIdleDeadlineAt = idleDeadlineAt,
                videoExempt = false,
                stopReason = PhoneUsageStopReason.NONE,
            )
        }
        if (input.isVideoPlaying) {
            return PhoneUsageTimingDecision(
                isCounting = true,
                segmentStartedAt = segmentStartedAt,
                segmentEndedAt = null,
                nextIdleDeadlineAt = null,
                videoExempt = true,
                stopReason = PhoneUsageStopReason.NONE,
            )
        }

        val reason = if (input.wasVideoExempt) {
            PhoneUsageStopReason.VIDEO_STOPPED
        } else {
            PhoneUsageStopReason.IDLE_TIMEOUT
        }
        val endedAt = if (reason == PhoneUsageStopReason.VIDEO_STOPPED) {
            input.videoStateChangedAt
                ?.coerceIn(idleDeadlineAt, input.now)
                ?: input.now
        } else {
            idleDeadlineAt
        }
        return stopped(reason, segmentStartedAt, endedAt)
    }

    private fun stopped(
        reason: PhoneUsageStopReason,
        startedAt: Long? = null,
        endedAt: Long? = null,
    ) = PhoneUsageTimingDecision(
        isCounting = false,
        segmentStartedAt = startedAt,
        segmentEndedAt = endedAt,
        nextIdleDeadlineAt = null,
        videoExempt = false,
        stopReason = reason,
    )

    private fun hardStopAt(input: PhoneUsageTimingInput, idleDeadlineAt: Long): Long {
        return if (!input.wasVideoExempt && input.now >= idleDeadlineAt) {
            idleDeadlineAt
        } else {
            input.now
        }
    }

    private fun safeAdd(left: Long, right: Long): Long {
        if (right > 0L && left > Long.MAX_VALUE - right) return Long.MAX_VALUE
        return left + right
    }
}
