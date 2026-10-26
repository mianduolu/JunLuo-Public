package com.anonymous.junluo

/** Decisions for the one local follow-up slot; no animation or usage accounting. */
object PhoneCareFollowUpPolicy {
    fun acceptsRevision(current: Long, expected: Long, next: Long, restoring: Boolean): Boolean =
        !restoring && expected >= 0L && current == expected && next == expected + 1L

    fun isDue(status: String, nextCheckAt: Long, now: Long, restoring: Boolean): Boolean =
        !restoring && status in setOf("waiting", "prepared") && nextCheckAt > 0L && now >= nextCheckAt

    fun isManagedUsage(running: Boolean, restoring: Boolean, screenAvailable: Boolean,
                       counting: Boolean, ownApp: Boolean, enabledBlacklist: Boolean): Boolean =
        running && !restoring && screenAvailable && counting && !ownApp && enabledBlacklist
}
