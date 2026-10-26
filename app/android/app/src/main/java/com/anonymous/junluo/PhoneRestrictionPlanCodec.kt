package com.anonymous.junluo

import org.json.JSONArray
import org.json.JSONObject

/** Codec for optional chapter-4 fields in the existing native state JSON. */
object PhoneRestrictionPlanCodec {
    private fun time(value: JSONObject, key: String, zero: Boolean = false): Long {
        val number = value.get(key)
        require(number is Number && number.toDouble().isFinite() && number.toDouble() % 1.0 == 0.0 &&
            number.toDouble() in (if (zero) 0.0 else 1.0)..9_007_199_254_740_991.0)
        return number.toLong()
    }
    private fun text(value: JSONObject, key: String): String {
        val entry = value.get(key)
        require(entry is String && entry.isNotBlank())
        return entry
    }
    private fun packages(value: JSONObject): Set<String> {
        val array = value.getJSONArray("packages")
        val names = (0 until array.length()).map { array.get(it).also { item -> require(item is String && item.isNotBlank()) } as String }
        require(names.distinct().size == names.size)
        return names.toSet()
    }
    fun allowance(value: JSONObject): PhoneRestrictionPlans.Allowance {
        val surrogate = JSONObject(value.toString()).put("id", "allowance").put("enabled", true)
            .put("mode", "direct").put("warningMs", 0)
        val schedule = requireNotNull(PhoneRestrictionSchedulePolicy.parseSchedule(surrogate.toString()))
        return PhoneRestrictionPlans.Allowance(schedule.dates, schedule.windows)
    }
    fun allowanceJson(value: PhoneRestrictionPlans.Allowance): JSONObject {
        PhoneRestrictionPlans.validate(value)
        val result = JSONObject(PhoneRestrictionSchedulePolicy.scheduleJson(PhoneRestrictionSchedulePolicy.Schedule(
            "allowance", true, value.dates, value.windows, "direct", 0)))
        listOf("id", "enabled", "mode", "warningMs").forEach { result.remove(it) }
        return result
    }
    fun plan(value: JSONObject, createdAt: Long? = null): PhoneRestrictionPlans.Plan {
        val schedule = requireNotNull(PhoneRestrictionSchedulePolicy.parseSchedule(value.getJSONObject("schedule").toString()))
        val actor = text(value, "actor").also { require(it in setOf("I", "you")) }
        val scope = text(value, "scope").also { require(it in setOf("phone", "apps")) }
        val names = packages(value)
        require(if (scope == "apps") names.isNotEmpty() else names.isEmpty())
        return PhoneRestrictionPlans.Plan(schedule, text(value, "authorizationId"), actor, scope, names,
            createdAt ?: time(value, "createdAt"), if (createdAt == null) time(value, "futureFrom", true) else 0)
    }
    fun planJson(value: PhoneRestrictionPlans.Plan) = JSONObject()
        .put("schedule", JSONObject(PhoneRestrictionSchedulePolicy.scheduleJson(value.schedule)))
        .put("authorizationId", value.authorizationId).put("actor", value.actor).put("scope", value.scope)
        .put("packages", JSONArray(value.packages.toList())).put("createdAt", value.createdAt).put("futureFrom", value.futureFrom)

    fun occurrence(value: JSONObject): PhoneRestrictionSchedulePolicy.Occurrence {
        val item = PhoneRestrictionSchedulePolicy.Occurrence(text(value, "id"), text(value, "scheduleId"),
            text(value, "windowId"), text(value, "localDate"), text(value, "timeZoneId"),
            time(value, "startsAt"), time(value, "warningUntil"), time(value, "endsAt"))
        require(item.warningUntil in item.startsAt..item.endsAt && item.endsAt > item.startsAt)
        require(PhoneRestrictionSchedulePolicy.isLocalDate(item.localDate))
        require(item.id == JSONArray(listOf(item.scheduleId, item.windowId, item.localDate)).toString())
        require(java.util.TimeZone.getTimeZone(item.timeZoneId).id == item.timeZoneId)
        return item
    }
    fun occurrenceJson(value: PhoneRestrictionSchedulePolicy.Occurrence) = JSONObject()
        .put("id", value.id).put("scheduleId", value.scheduleId).put("windowId", value.windowId)
        .put("localDate", value.localDate).put("timeZoneId", value.timeZoneId).put("startsAt", value.startsAt)
        .put("warningUntil", value.warningUntil).put("endsAt", value.endsAt)

    fun appRule(value: JSONObject) = PhoneRestrictionPlans.AppTimeRule(text(value, "id"),
        text(value, "authorizationId"), text(value, "packageName"),
        requireNotNull(PhoneRestrictionSchedulePolicy.parseAppTimes(value.getJSONObject("times").toString())))
    private fun appRuleJson(value: PhoneRestrictionPlans.AppTimeRule) = JSONObject()
        .put("id", value.id).put("authorizationId", value.authorizationId).put("packageName", value.packageName)
        .put("times", JSONObject(PhoneRestrictionSchedulePolicy.appTimesJson(value.times)))
    fun plans(value: JSONObject): List<PhoneRestrictionPlans.Plan> {
        val array = if (value.has("plans")) value.getJSONArray("plans") else JSONArray()
        return (0 until array.length()).map { plan(array.getJSONObject(it)) }.also {
            require(it.map { plan -> plan.schedule.id }.distinct().size == it.size)
        }
    }
    fun appRules(value: JSONObject): List<PhoneRestrictionPlans.AppTimeRule> {
        val array = if (value.has("appTimeRules")) value.getJSONArray("appTimeRules") else JSONArray()
        return (0 until array.length()).map { appRule(array.getJSONObject(it)) }.also {
            require(it.map { rule -> rule.id }.distinct().size == it.size)
        }
    }
    fun paused(value: JSONObject): Boolean {
        if (!value.has("paused")) return false
        require(value.get("paused") is Boolean)
        return value.getBoolean("paused")
    }
    fun resumedAt(value: JSONObject) = if (value.has("resumedAt")) time(value, "resumedAt", true) else 0
    fun apply(value: JSONObject, state: PhoneRestrictionInstances.State) {
        value.put("plans", JSONArray(state.plans.map(::planJson)))
            .put("appTimeRules", JSONArray(state.appTimeRules.map(::appRuleJson)))
            .put("paused", state.paused).put("resumedAt", state.resumedAt)
    }
}
