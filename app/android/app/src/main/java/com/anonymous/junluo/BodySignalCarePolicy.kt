package com.anonymous.junluo

internal object BodySignalCarePolicy {
    fun acceptsRevision(current: Long, expected: Long, next: Long, restorePaused: Boolean): Boolean =
        !restorePaused && expected >= 0 && current == expected && next == current + 1

    fun deadline(status: String, nextCheckAt: Long, restorePaused: Boolean, dispatchRunning: Boolean): Long? =
        nextCheckAt.takeIf { !restorePaused && !dispatchRunning && status != "finished" && it > 0 }

    fun earliest(samplingAt: Long?, careAt: Long?): Long? =
        listOfNotNull(samplingAt?.takeIf { it > 0 }, careAt?.takeIf { it > 0 }).minOrNull()

    fun samplingDue(samplingAt: Long?, now: Long): Boolean = samplingAt != null && samplingAt <= now
}
