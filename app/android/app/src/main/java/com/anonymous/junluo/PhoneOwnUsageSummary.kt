package com.anonymous.junluo

import java.util.Calendar
import java.util.Locale
import java.util.TimeZone

enum class PhoneOwnUsageEventKind { RESUME, PAUSE, STOPPED, SCREEN_ON, SCREEN_OFF, SHUTDOWN, STARTUP }

data class PhoneOwnUsageEvent(val at: Long, val kind: PhoneOwnUsageEventKind, val activity: String = "")
data class PhoneOwnUsageDay(val dateKey: String, val durationMs: Long)
data class PhoneOwnUsageSummaryResult(val days: List<PhoneOwnUsageDay>, val reason: String?)

/** Display-only system foreground time. No collector, focus counter or persistent data is changed. */
object PhoneOwnUsageSummary {
    fun dayStart(at: Long, zone: TimeZone = TimeZone.getDefault()): Long =
        Calendar.getInstance(zone).apply {
            timeInMillis = at
            set(Calendar.HOUR_OF_DAY, 0)
            set(Calendar.MINUTE, 0)
            set(Calendar.SECOND, 0)
            set(Calendar.MILLISECOND, 0)
        }.timeInMillis

    fun previousDay(at: Long, count: Int, zone: TimeZone = TimeZone.getDefault()): Long =
        Calendar.getInstance(zone).apply {
            timeInMillis = dayStart(at, zone)
            add(Calendar.DATE, -count)
        }.timeInMillis

    fun summarize(events: List<PhoneOwnUsageEvent>, days: Int, now: Long,
                  zone: TimeZone = TimeZone.getDefault()): PhoneOwnUsageSummaryResult {
        val dayCount = days.coerceIn(1, 14)
        val firstDay = previousDay(now, dayCount - 1, zone)
        val totals = mutableMapOf<Long, Long>()
        val uncertainDays = mutableSetOf<Long>()
        val activities = mutableSetOf<String>()
        val pausedActivities = mutableSetOf<String>()
        var startedAt: Long? = null
        var knownFrom: Long? = null
        var screenOn = true
        var shutDown = false

        fun split(from: Long, until: Long, uncertain: Boolean = false) {
            var cursor = maxOf(from, firstDay)
            val end = minOf(until, now)
            while (cursor < end) {
                val start = dayStart(cursor, zone)
                val next = Calendar.getInstance(zone).apply {
                    timeInMillis = start
                    add(Calendar.DATE, 1)
                }.timeInMillis
                val chunkEnd = minOf(end, next)
                if (uncertain) uncertainDays.add(start)
                else totals[start] = (totals[start] ?: 0L) + chunkEnd - cursor
                cursor = chunkEnd
            }
        }

        fun close(at: Long, uncertain: Boolean = false) {
            startedAt?.let { split(it, at, uncertain) }
            activities.clear()
            startedAt = null
        }

        events.filter { it.at in 1..now }.sortedBy { it.at }.forEach { event ->
            when (event.kind) {
                PhoneOwnUsageEventKind.RESUME -> if (!shutDown && screenOn) {
                    if (knownFrom == null) knownFrom = event.at
                    if (activities.isEmpty()) startedAt = event.at
                    activities.add(event.activity)
                }
                PhoneOwnUsageEventKind.PAUSE -> if (!shutDown) {
                    if (knownFrom == null) knownFrom = event.at
                    pausedActivities.add(event.activity)
                    if (activities.remove(event.activity) && activities.isEmpty()) close(event.at)
                }
                PhoneOwnUsageEventKind.STOPPED -> if (!shutDown) {
                    if (knownFrom == null) knownFrom = event.at
                    // Consume the stop following a prior pause, including one delivered after a new resume.
                    if (!pausedActivities.remove(event.activity) && activities.remove(event.activity)
                        && activities.isEmpty()) close(event.at)
                }
                PhoneOwnUsageEventKind.SCREEN_ON -> screenOn = true
                PhoneOwnUsageEventKind.SCREEN_OFF -> {
                    if (knownFrom == null) knownFrom = event.at
                    close(event.at)
                    screenOn = false
                }
                PhoneOwnUsageEventKind.SHUTDOWN -> {
                    if (knownFrom == null) knownFrom = event.at
                    close(event.at)
                    shutDown = true
                    pausedActivities.clear()
                }
                PhoneOwnUsageEventKind.STARTUP -> {
                    if (knownFrom == null) knownFrom = event.at
                    // Without a persisted shutdown boundary an open pre-reboot interval is unknown.
                    close(event.at, uncertain = true)
                    pausedActivities.clear()
                    shutDown = false
                    screenOn = true
                }
            }
        }
        if (!shutDown && screenOn) close(now)
        val observedFrom = knownFrom
        val result = (0 until dayCount).mapNotNull { offset ->
            val start = previousDay(now, offset, zone)
            if (observedFrom == null || start < observedFrom || start in uncertainDays) return@mapNotNull null
            val date = Calendar.getInstance(zone).apply { timeInMillis = start }
            PhoneOwnUsageDay(String.format(Locale.US, "%04d-%02d-%02d", date.get(Calendar.YEAR),
                date.get(Calendar.MONTH) + 1, date.get(Calendar.DATE)), totals[start] ?: 0L)
        }
        return PhoneOwnUsageSummaryResult(result, when {
            result.isEmpty() -> "SYSTEM_HISTORY_UNAVAILABLE"
            result.size < dayCount -> "SYSTEM_HISTORY_PARTIAL"
            else -> null
        })
    }
}
