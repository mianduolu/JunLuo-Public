package com.anonymous.junluo

/** Time decisions only. A due restriction is not evidence that a window was shown. */
object PhoneRestrictionPolicy {
    private const val MAX_SAFE_TIME = 9_007_199_254_740_991L

    data class Durations(
        val warningMs: Long = 3 * 60_000L,
        val temporaryMs: Long = 30 * 60_000L,
        val maximumTemporaryMs: Long = 2 * 60 * 60_000L,
        val appReleaseMs: Long = 10 * 60_000L,
        val emergencyMs: Long = 10 * 60_000L,
    ) {
        fun valid(): Boolean = warningMs in 0..MAX_SAFE_TIME &&
            listOf(temporaryMs, maximumTemporaryMs, appReleaseMs, emergencyMs)
                .all { it in 1..MAX_SAFE_TIME } && temporaryMs <= maximumTemporaryMs
    }

    data class Instance(
        val id: String,
        val actor: String,
        val scope: String,
        val packages: Set<String>,
        val mode: String,
        val createdAt: Long,
        val warningUntil: Long,
        val endsAt: Long,
        val enteredAt: Long? = null,
        val endedAt: Long? = null,
    )

    data class Extension(val id: String, val occurredAt: Long, val until: Long)
    data class Emergency(
        val id: String,
        val startedAt: Long,
        val until: Long,
        val extensions: List<Extension> = emptyList(),
        val acceptedStartOperations: Set<String> = setOf(id),
    )

    fun deadline(start: Long, duration: Long): Long {
        require(start in 1..MAX_SAFE_TIME && duration in 0..(MAX_SAFE_TIME - start))
        return start + duration
    }

    fun startTemporary(
        id: String, actor: String, scope: String, packages: Set<String>, mode: String,
        now: Long, durations: Durations, authorizedUntil: Long,
    ): Instance {
        require(id.isNotBlank() && actor in setOf("I", "you"))
        require(scope in setOf("phone", "apps") && (scope != "apps" || packages.isNotEmpty()))
        require(packages.all { it.isNotBlank() } && mode in setOf("warning", "direct"))
        require(durations.valid())
        val warningUntil = deadline(now, if (mode == "warning") durations.warningMs else 0)
        val endsAt = deadline(warningUntil, durations.temporaryMs)
        require(endsAt <= authorizedUntil)
        return Instance(id, actor, scope, packages, mode, now, warningUntil, endsAt)
    }

    fun phase(instance: Instance, now: Long): String = when {
        instance.endedAt != null || now >= instance.endsAt -> "ended"
        now < instance.warningUntil -> "warning"
        else -> "restriction_due"
    }

    fun entered(instance: Instance, now: Long): Instance {
        require(phase(instance, now) == "restriction_due")
        return if (instance.enteredAt != null) instance else instance.copy(enteredAt = now)
    }

    fun shorten(instance: Instance, until: Long, now: Long): Instance {
        require(phase(instance, now) != "ended" && until in now..instance.endsAt)
        return instance.copy(endsAt = until)
    }

    fun end(instance: Instance, now: Long): Instance =
        if (instance.endedAt != null) instance else instance.copy(endedAt = now)

    fun isEmergencyActive(emergency: Emergency?, now: Long): Boolean =
        emergency != null && now >= emergency.startedAt && now < emergency.until

    fun startEmergency(current: Emergency?, id: String, now: Long, durationMs: Long): Emergency {
        require(id.isNotBlank() && durationMs > 0)
        // A repeated long press is not the separate, explicit extension action.
        if (current != null && id in current.acceptedStartOperations) return current
        if (isEmergencyActive(current, now)) return current!!.copy(
            acceptedStartOperations = current.acceptedStartOperations + id)
        return Emergency(id, now, deadline(now, durationMs))
    }

    fun extendEmergency(
        current: Emergency, expectedId: String, operationId: String, now: Long, durationMs: Long,
    ): Emergency {
        require(current.id == expectedId && operationId.isNotBlank() && durationMs > 0)
        if (current.extensions.any { it.id == operationId }) return current
        require(isEmergencyActive(current, now))
        val until = deadline(current.until, durationMs)
        return current.copy(until = until,
            extensions = current.extensions + Extension(operationId, now, until))
    }

    fun shouldBlock(
        instance: Instance, packageName: String, now: Long, emergency: Emergency? = null,
        appReleaseUntil: Long = 0, phoneAllowlist: Set<String> = emptySet(),
    ): Boolean = phase(instance, now) == "restriction_due" &&
        !isEmergencyActive(emergency, now) && now >= appReleaseUntil &&
        if (instance.scope == "phone") packageName !in phoneAllowlist else packageName in instance.packages

    data class UsageInterval(val from: Long, val until: Long)
    data class AppUsageInterval(val packageName: String, val from: Long, val until: Long)

    fun observedUsageByApp(intervals: List<AppUsageInterval>, from: Long, until: Long): Map<String, Long> {
        require(until >= from)
        return intervals.filter { it.packageName.isNotBlank() && it.from > 0 && it.until > it.from }
            .groupBy { it.packageName }.mapValues { (_, parts) ->
                observedUsage(parts.map { UsageInterval(it.from, it.until) }, from, until)
            }.filterValues { it > 0 }
    }

    /** Union real observed intervals, clipped to a day/emergency window; no guessed gaps. */
    fun observedUsage(intervals: List<UsageInterval>, from: Long, until: Long): Long {
        require(until >= from)
        var countedUntil = from
        var total = 0L
        for (part in intervals.sortedBy { it.from }) {
            val start = maxOf(from, part.from, countedUntil)
            val end = minOf(until, part.until)
            if (end > start) {
                total += end - start
                countedUntil = end
            }
        }
        return total
    }
}
