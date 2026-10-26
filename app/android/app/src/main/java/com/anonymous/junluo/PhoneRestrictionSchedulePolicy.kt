package com.anonymous.junluo

import java.util.Calendar
import java.util.GregorianCalendar
import java.util.Locale
import java.util.TimeZone
import org.json.JSONArray
import org.json.JSONObject

/** Pure calendar decisions. No counters, storage, windows, alarms or model calls. */
object PhoneRestrictionSchedulePolicy {
    data class Dates(val localDate: String? = null, val weekdays: Set<Int> = emptySet())
    data class Window(val id: String, val startTime: String, val endTime: String)
    data class Schedule(val id: String, val enabled: Boolean, val dates: Dates,
                        val windows: List<Window>, val mode: String, val warningMs: Long)
    data class AppTimes(val enabled: Boolean, val dates: Dates?,
                        val allowed: List<Window>, val blocked: List<Window>)
    data class Occurrence(val id: String, val scheduleId: String, val windowId: String,
                          val localDate: String, val timeZoneId: String,
                          val startsAt: Long, val warningUntil: Long, val endsAt: Long)

    private val utc = TimeZone.getTimeZone("UTC")
    private const val MAX_SAFE_TIME = 9_007_199_254_740_991L
    private val datePattern = Regex("\\d{4}-\\d{2}-\\d{2}")
    private val clockPattern = Regex("([01]\\d|2[0-3]):[0-5]\\d")

    private fun date(value: String): Calendar {
        require(datePattern.matches(value))
        val parts = value.split('-').map { it.toInt() }
        require(parts[0] in 1..9999)
        return GregorianCalendar(utc, Locale.ROOT).apply {
            // Use the same proleptic Gregorian dates as the TS decoder.
            gregorianChange = java.util.Date(Long.MIN_VALUE)
            isLenient = false
            clear()
            set(parts[0], parts[1] - 1, parts[2], 12, 0, 0)
            timeInMillis // Reject normalized dates such as February 30.
        }
    }
    private fun dateKey(value: Calendar) = String.format(Locale.ROOT, "%04d-%02d-%02d",
        value.get(Calendar.YEAR), value.get(Calendar.MONTH) + 1, value.get(Calendar.DAY_OF_MONTH))
    fun isLocalDate(value: String) = runCatching { date(value); true }.getOrDefault(false)
    private fun shiftDate(value: String, days: Int) = dateKey(date(value).apply { add(Calendar.DATE, days) })
    fun shiftLocalDate(value: String, days: Int) = shiftDate(value, days)
    fun weekdayForDate(value: String) = date(value).get(Calendar.DAY_OF_WEEK).let { if (it == Calendar.SUNDAY) 7 else it - 1 }
    private fun localDate(now: Long, zone: TimeZone) = dateKey(GregorianCalendar(zone, Locale.ROOT).apply {
        timeInMillis = now
    })
    private fun minutes(clock: String): Int {
        require(clockPattern.matches(clock))
        return clock.substring(0, 2).toInt() * 60 + clock.substring(3, 5).toInt()
    }
    private fun validate(dates: Dates) {
        require((dates.localDate != null) != dates.weekdays.isNotEmpty())
        dates.localDate?.let { date(it) }
        require(dates.weekdays.all { it in 1..7 })
    }
    private fun validate(windows: List<Window>) {
        require(windows.map { it.id }.distinct().size == windows.size)
        windows.forEach {
            require(it.id.isNotBlank() && minutes(it.startTime) != minutes(it.endTime))
        }
    }
    fun validate(schedule: Schedule) {
        require(schedule.id.isNotBlank() && schedule.mode in setOf("warning", "direct")
            && schedule.warningMs in 0..MAX_SAFE_TIME && schedule.windows.isNotEmpty())
        validate(schedule.dates); validate(schedule.windows)
    }
    fun validate(times: AppTimes) {
        times.dates?.let { validate(it) }
        validate(times.allowed); validate(times.blocked)
        require(!times.enabled || (times.dates != null && (times.allowed + times.blocked).isNotEmpty()))
    }
    fun matches(dates: Dates, localDate: String): Boolean {
        if (dates.localDate != null) return dates.localDate == localDate
        val weekday = date(localDate).get(Calendar.DAY_OF_WEEK).let { if (it == Calendar.SUNDAY) 7 else it - 1 }
        return weekday in dates.weekdays
    }
    private fun wallTime(localDate: String, minute: Int, zone: TimeZone): Long? = runCatching {
        val day = date(localDate)
        GregorianCalendar(zone, Locale.ROOT).apply {
            gregorianChange = java.util.Date(Long.MIN_VALUE)
            isLenient = false
            clear()
            set(day.get(Calendar.YEAR), day.get(Calendar.MONTH), day.get(Calendar.DAY_OF_MONTH),
                minute / 60, minute % 60, 0)
        }.timeInMillis
    }.getOrNull() // A nonexistent DST clock has no occurrence; it is never silently shifted.

    private fun interval(window: Window, localDate: String, zone: TimeZone): Pair<Long, Long>? {
        val startMinute = minutes(window.startTime)
        val endMinute = minutes(window.endTime)
        val startsAt = wallTime(localDate, startMinute, zone) ?: return null
        val endsOn = if (endMinute < startMinute) shiftDate(localDate, 1) else localDate
        val endsAt = wallTime(endsOn, endMinute, zone) ?: return null
        return if (startsAt > 0 && endsAt > startsAt && endsAt <= MAX_SAFE_TIME) startsAt to endsAt else null
    }

    fun intervalsForDate(windows: List<Window>, startsOn: String, zone: TimeZone): List<Pair<Long, Long>> {
        validate(windows); date(startsOn)
        return windows.mapNotNull { interval(it, startsOn, zone) }.sortedBy { it.first }
    }

    fun nextAppTimeBoundary(times: AppTimes, now: Long, zone: TimeZone): Long? {
        validate(times)
        if (!times.enabled) return null
        val today = localDate(now, zone)
        val dates = times.dates!!
        val days = dates.localDate?.let { listOf(it) } ?: (-1..7).map { shiftDate(today, it) }
        // Midnight changes which selected day applies even without a window boundary there.
        val boundaries = days.flatMap { day ->
            if (!matches(dates, day)) emptyList() else
                (intervalsForDate(times.allowed, day, zone) + intervalsForDate(times.blocked, day, zone))
                    .flatMap { listOf(it.first, it.second) } +
                    listOfNotNull(wallTime(day, 0, zone), wallTime(shiftDate(day, 1), 0, zone))
        }
        return boundaries.filter { it > now }.minOrNull()
    }

    /** Dates and keys belong to the start day, including the unselected next-day tail. */
    fun occurrencesForDate(schedule: Schedule, startsOn: String, zone: TimeZone): List<Occurrence> {
        validate(schedule); date(startsOn)
        if (!schedule.enabled || !matches(schedule.dates, startsOn)) return emptyList()
        return schedule.windows.mapNotNull { window ->
            val (start, end) = interval(window, startsOn, zone) ?: return@mapNotNull null
            Occurrence(JSONArray(listOf(schedule.id, window.id, startsOn)).toString(), schedule.id,
                window.id, startsOn, zone.id, start,
                start + if (schedule.mode == "warning") minOf(schedule.warningMs, end - start) else 0L, end)
        }.sortedWith(compareBy<Occurrence> { it.startsAt }.thenBy { it.id })
    }

    /** Candidates in the supplied zone. 4B must keep an existing occurrence's saved epoch by ID,
     * rather than replacing it with a recomputed candidate; permission/edit/deduplication live there. */
    fun currentAndUpcoming(schedule: Schedule, now: Long, zone: TimeZone): List<Occurrence> {
        require(now in 1..MAX_SAFE_TIME); validate(schedule)
        val today = localDate(now, zone)
        val dates = schedule.dates.localDate?.let { listOf(it) }
            ?: (-1..7).map { shiftDate(today, it) }
        return dates.flatMap { occurrencesForDate(schedule, it, zone) }.filter { now < it.endsAt }
            .sortedWith(compareBy<Occurrence> { it.startsAt }.thenBy { it.id })
    }
    fun phase(occurrence: Occurrence, now: Long): String = when {
        now >= occurrence.endsAt -> "ended"
        now < occurrence.startsAt -> "upcoming"
        now < occurrence.warningUntil -> "warning"
        else -> "restriction_due"
    }

    /** Only the clock condition. Daily/ordinary usage, cooldown and releases stay separate. */
    fun isTimeBlocked(times: AppTimes, now: Long, zone: TimeZone): Boolean {
        require(now in 1..MAX_SAFE_TIME); validate(times)
        if (!times.enabled) return false
        val dates = times.dates!!
        val today = localDate(now, zone)
        val yesterday = shiftDate(today, -1)
        fun active(windows: List<Window>, day: String): Boolean = matches(dates, day) && windows.any {
            interval(it, day, zone)?.let { span -> now >= span.first && now < span.second } == true
        }
        val allowed = active(times.allowed, today) || active(times.allowed, yesterday)
        val blocked = active(times.blocked, today) || active(times.blocked, yesterday)
        val applies = matches(dates, today) || allowed || blocked
        return applies && (blocked || (times.allowed.isNotEmpty() && !allowed))
    }

    private fun dates(value: JSONObject): Dates {
        if (value.has("localDate")) {
            require(!value.has("weekdays") && value.get("localDate") is String)
            return Dates(value.getString("localDate")).also { validate(it) }
        }
        val array = value.getJSONArray("weekdays")
        val days = (0 until array.length()).map {
            val number = array.get(it)
            require(number is Number && number.toDouble() % 1.0 == 0.0 && number.toDouble() in 1.0..7.0)
            number.toInt()
        }
        require(days.distinct().size == days.size)
        return Dates(weekdays = days.toSet()).also { validate(it) }
    }
    private fun windows(value: JSONObject, key: String): List<Window> {
        val array = value.getJSONArray(key)
        return (0 until array.length()).map {
            val window = array.getJSONObject(it)
            require(listOf("id", "startTime", "endTime").all { name -> window.get(name) is String })
            Window(window.getString("id"), window.getString("startTime"), window.getString("endTime"))
        }.also { validate(it) }
    }
    fun parseSchedule(raw: String): Schedule? = runCatching {
        val value = JSONObject(raw)
        require(value.get("id") is String && value.get("enabled") is Boolean && value.get("mode") is String)
        val warning = value.get("warningMs")
        require(warning is Number && warning.toDouble().isFinite() && warning.toDouble() % 1.0 == 0.0
            && warning.toDouble() in 0.0..MAX_SAFE_TIME.toDouble())
        Schedule(value.getString("id"), value.getBoolean("enabled"), dates(value.getJSONObject("dates")),
            windows(value, "windows"), value.getString("mode"), warning.toLong()).also { validate(it) }
    }.getOrNull()
    fun parseAppTimes(raw: String): AppTimes? = runCatching {
        val value = JSONObject(raw)
        require(value.get("enabled") is Boolean && value.has("dates"))
        AppTimes(value.getBoolean("enabled"), if (value.isNull("dates")) null else dates(value.getJSONObject("dates")),
            windows(value, "allowed"), windows(value, "blocked")).also { validate(it) }
    }.getOrNull()
    private fun datesJson(dates: Dates): JSONObject = dates.localDate?.let { JSONObject().put("localDate", it) }
        ?: JSONObject().put("weekdays", JSONArray(dates.weekdays.sorted()))
    private fun windowsJson(windows: List<Window>) = JSONArray().also { array -> windows.forEach {
        array.put(JSONObject().put("id", it.id).put("startTime", it.startTime).put("endTime", it.endTime))
    } }
    fun scheduleJson(schedule: Schedule): String {
        validate(schedule)
        return JSONObject().put("id", schedule.id).put("enabled", schedule.enabled).put("dates", datesJson(schedule.dates))
            .put("windows", windowsJson(schedule.windows)).put("mode", schedule.mode).put("warningMs", schedule.warningMs).toString()
    }
    fun appTimesJson(times: AppTimes): String {
        validate(times)
        return JSONObject().put("enabled", times.enabled).put("dates", times.dates?.let { datesJson(it) } ?: JSONObject.NULL)
            .put("allowed", windowsJson(times.allowed)).put("blocked", windowsJson(times.blocked)).toString()
    }
}
