package com.anonymous.junluo

/** Small decisions shared by the native collector and its offline tests. */
object PhoneFocusPolicy {
    const val TRIGGER_TTL_MS = 30 * 60_000L

    fun canAttempt(createdAt: Long, attempts: Int, status: String, now: Long): Boolean =
        createdAt > 0 && now >= createdAt && now - createdAt <= TRIGGER_TTL_MS &&
            status == "pending" && attempts in 0..1

    fun addedToday(durationMs: Long, now: Long, dayStartedAt: Long): Long =
        minOf(durationMs.coerceAtLeast(0), (now - dayStartedAt).coerceAtLeast(0))

    fun currentDayValue(value: Long, savedDay: String, today: String): Long =
        if (savedDay == today) value.coerceAtLeast(0) else 0

    fun acceptsForeground(eventAt: Long, latestAt: Long): Boolean = eventAt > latestAt

    fun observedStart(eventAt: Long, collectorStartedAt: Long, countedUntil: Long): Long =
        maxOf(eventAt, collectorStartedAt, countedUntil)

    fun stagesToAdd(current: Int, requested: Int): IntRange =
        (current + 1)..requested.coerceIn(1, 3)

    data class Countdown(val untilOverlayMs: Long, val dailyRemainingMs: Long)

    fun countdown(ordinaryRemainingMs: Long, dailyRemainingMs: Long): Countdown = Countdown(
        minOf(ordinaryRemainingMs, dailyRemainingMs).coerceAtLeast(0L),
        dailyRemainingMs.coerceAtLeast(0L),
    )

    fun countdownText(remainingMs: Long): String {
        val positive = remainingMs.coerceAtLeast(0L)
        val seconds = positive / 1000 + if (positive % 1000 > 0) 1 else 0
        return "${seconds / 60}:${(seconds % 60).toString().padStart(2, '0')}"
    }

    data class Display(val stage: Int, val startsMessage: Boolean)

    fun display(visible: Boolean, stage: Int, thresholdMet: Boolean, maximum: Boolean): Display? = when {
        maximum && (!visible || stage < 3) -> Display(3, !visible)
        visible || !thresholdMet -> null
        else -> Display(1, true)
    }

    fun ignoreOwnWindow(ownPackage: Boolean, applicationWindow: Boolean?, knownOverlay: Boolean): Boolean =
        ownPackage && (applicationWindow == false || (applicationWindow == null && knownOverlay))

    fun returnEligible(sameRule: Boolean, exitedAt: Long, windowMs: Long, now: Long): Boolean =
        sameRule && exitedAt > 0 && now - exitedAt in 0..windowMs
}
