package com.anonymous.junluo

import org.json.JSONArray
import org.json.JSONObject
import java.util.TimeZone

/** I-only decisions over the existing state. No storage, windows, clocks or counter consumption. */
object PhoneLimitActions {
    private const val MAX_SAFE_TIME = 9_007_199_254_740_991L
    private const val MINUTE = 60_000L
    class Rejected(val reason: String) : IllegalArgumentException(reason)
    private fun accept(value: Boolean, reason: String) { if (!value) throw Rejected(reason) }
    private fun active(record: PhoneRestrictionInstances.Record, now: Long) =
        PhoneRestrictionPolicy.phase(record.restriction, now) != "ended"
    private fun grantCurrent(grant: PhoneRestrictionInstances.Authorization, now: Long) =
        "I" in grant.actors && now in grant.validFrom until grant.validUntil
    private fun ready(state: PhoneRestrictionInstances.State, now: Long) {
        accept(now in 1..MAX_SAFE_TIME && state.configurationKnown, "configuration_unavailable")
    }
    private fun duration(value: Long?) = accept(value == null ||
        (value in MINUTE..MAX_SAFE_TIME && value % MINUTE == 0L), "invalid_duration")

    fun start(state: PhoneRestrictionInstances.State, input: PhoneRestrictionInstances.Start,
              now: Long): PhoneRestrictionInstances.State {
        accept(input.id.isNotBlank() && input.actor == "I", "invalid_request")
        duration(input.durationMs)
        state.instances.firstOrNull { it.restriction.id == input.id }?.let { old ->
            val original = old.originalRequest
            accept(old.authorizationId == input.authorizationId && original.actor == "I" &&
                original.scope == input.scope && original.packages == input.packages &&
                original.durationMs == input.durationMs && (input.mode == null || original.mode == input.mode),
                "request_mismatch")
            return state // Never re-evaluate an accepted call against later defaults or deadlines.
        }
        ready(state, now)
        accept(!state.paused, "paused")
        val grant = state.configuration.authorizations.firstOrNull { it.id == input.authorizationId }
        accept(grant != null, "authorization_missing")
        grant!!
        val mode = state.configuration.defaultMode
        accept(grantCurrent(grant, now) && grant.allowTemporary && mode in grant.modes &&
            input.scope == grant.scope && (input.mode == null || input.mode == mode), "start_not_allowed")
        accept(if (input.scope == "phone") input.packages.isEmpty() else
            input.scope == "apps" && input.packages.isNotEmpty() && input.packages.all { it in grant.packages },
            "target_not_allowed")
        val current = state.instances.filter { active(it, now) }
        accept(if (input.scope == "phone") current.none {
            it.restriction.scope == "phone" || it.restriction.packages.any { pkg -> pkg !in grant.phoneAllowlist }
        } else input.packages.none { pkg -> current.any {
            if (it.restriction.scope == "apps") pkg in it.restriction.packages else pkg !in it.phoneAllowlist
        } }, "overlapping_restriction")
        val warning = if (mode == "warning") state.configuration.durations.warningMs else 0L
        val maximum = minOf(state.configuration.durations.maximumTemporaryMs, grant.maximumTemporaryMs,
            grant.validUntil - now - warning, MAX_SAFE_TIME - now - warning)
        accept(maximum >= MINUTE, "duration_not_available")
        accept((input.durationMs ?: state.configuration.durations.temporaryMs) <= maximum, "duration_not_allowed")
        return PhoneRestrictionInstances.start(state, input.copy(mode = mode), now)
    }

    fun canAdjust(state: PhoneRestrictionInstances.State, record: PhoneRestrictionInstances.Record,
                  now: Long): Boolean {
        if (!state.configurationKnown || now !in 1..MAX_SAFE_TIME || !active(record, now)) return false
        val original = state.configuration.authorizations.firstOrNull { it.id == record.authorizationId } ?: return false
        if ("I" in original.actors) return grantCurrent(original, now)
        if (record.restriction.actor != "you") return false
        val management = state.configuration.authorizations.filter {
            grantCurrent(it, now) && it.scope == record.restriction.scope
        }
        return if (record.restriction.scope == "phone") management.isNotEmpty() else
            record.restriction.packages.isNotEmpty() && record.restriction.packages.all { pkg ->
                management.any { pkg in it.packages }
            }
    }

    fun shorten(state: PhoneRestrictionInstances.State, id: String, expectedEndsAt: Long,
                until: Long, now: Long): PhoneRestrictionInstances.State {
        ready(state, now)
        accept(id.isNotBlank() && expectedEndsAt in 1..MAX_SAFE_TIME && until in 1..MAX_SAFE_TIME, "invalid_request")
        val record = state.instances.firstOrNull { it.restriction.id == id }
        accept(record != null, "instance_missing")
        record!!
        if (!active(record, now)) return state
        accept(until <= expectedEndsAt, "invalid_request")
        if (record.restriction.endsAt == until && record.lastChangedBy == "I") return state
        accept(canAdjust(state, record, now), "adjustment_not_allowed")
        accept(record.restriction.endsAt == expectedEndsAt, "deadline_changed")
        accept(until >= now, "deadline_elapsed")
        if (until == record.restriction.endsAt) return state
        val next = record.copy(restriction = record.restriction.copy(endsAt = until,
            warningUntil = if (record.occurrence != null) minOf(record.restriction.warningUntil, until)
                else record.restriction.warningUntil), lastChangedAt = now, lastChangedBy = "I")
        return state.copy(instances = state.instances.map { if (it.restriction.id == id) next else it })
    }

    fun end(state: PhoneRestrictionInstances.State, id: String, now: Long): PhoneRestrictionInstances.State {
        ready(state, now)
        val record = state.instances.firstOrNull { it.restriction.id == id }
        accept(record != null, "instance_missing")
        record!!
        if (!active(record, now)) return state
        accept(canAdjust(state, record, now), "adjustment_not_allowed")
        val next = record.copy(restriction = PhoneRestrictionPolicy.end(record.restriction, now),
            endedBy = "I", lastChangedAt = now, lastChangedBy = "I")
        return state.copy(instances = state.instances.map { if (it.restriction.id == id) next else it })
    }

    fun canReleasePackage(state: PhoneRestrictionInstances.State, packageName: String, now: Long): Boolean =
        state.configurationKnown && now in 1..MAX_SAFE_TIME && packageName.isNotBlank() &&
            state.configuration.authorizations.any { grant -> grantCurrent(grant, now) &&
                if (grant.scope == "apps") packageName in grant.packages else packageName !in grant.phoneAllowlist }

    /** The adopted first-per-package and first-per-id selection includes reminders and jealousy. */
    fun focusReleaseSource(settings: JSONObject?, packageName: String): String? {
        if (settings == null || settings.opt("enabled") !is Boolean) return null
        if (!settings.getBoolean("enabled")) return null
        accept(!settings.has("jealousyEnabled") || settings.opt("jealousyEnabled") is Boolean, "focus_source_invalid")
        val rules = settings.optJSONArray("rules") ?: throw Rejected("focus_source_invalid")
        val packages = mutableSetOf<String>()
        val ids = mutableSetOf<String>()
        for (index in 0 until rules.length()) {
            val rule = rules.optJSONObject(index) ?: throw Rejected("focus_source_invalid")
            accept(rule.opt("kind") is String, "focus_source_invalid")
            val kind = rule.getString("kind")
            if (kind != "blacklist" && kind != "jealousy") continue
            if (kind == "jealousy" && !settings.optBoolean("jealousyEnabled", true)) continue
            accept(rule.opt("source") is String && rule.getString("source").trim().isNotBlank(), "focus_source_invalid")
            val source = rule.getString("source").trim()
            accept(!rule.has("id") || rule.opt("id") is String, "focus_source_invalid")
            val id = rule.optString("id").ifBlank { "$kind:$source" }
            if (!packages.add(source) || !ids.add(id)) continue
            if (source == packageName) return JSONArray(listOf("focus", id)).toString()
        }
        return null
    }

    fun release(state: PhoneRestrictionInstances.State, id: String, packageName: String,
                durationMs: Long?, focus: JSONObject?, now: Long): PhoneRestrictionInstances.State {
        accept(id.isNotBlank() && packageName.isNotBlank(), "invalid_request")
        duration(durationMs)
        state.appReleases.firstOrNull { it.id == id }?.let { old ->
            accept(old.actor == "I" && old.packageName == packageName && old.durationMs == durationMs, "request_mismatch")
            return state // Do not choose a new anchor or restart an expired window on retry.
        }
        ready(state, now)
        accept(canReleasePackage(state, packageName, now), "release_not_allowed")
        val instance = state.instances.firstOrNull { active(it, now) &&
            if (it.restriction.scope == "apps") packageName in it.restriction.packages else packageName !in it.phoneAllowlist }
        val anchor = instance?.restriction?.id ?: focusReleaseSource(focus, packageName)
            ?: state.appTimeRules.firstOrNull { rule ->
                val grant = state.configuration.authorizations.firstOrNull { it.id == rule.authorizationId }
                rule.packageName == packageName && rule.times.enabled && grant != null && grant.scope == "apps" &&
                    "you" in grant.actors && "direct" in grant.modes && packageName in grant.packages &&
                    now in grant.validFrom until grant.validUntil
            }?.let { JSONArray(listOf("appTime", it.id)).toString() }
        accept(anchor != null, "restriction_source_missing")
        val value = durationMs ?: state.configuration.durations.appReleaseMs
        accept(value <= state.configuration.durations.appReleaseMs && value <= MAX_SAFE_TIME - now, "duration_not_allowed")
        val release = PhoneRestrictionInstances.AppRelease(id, anchor!!, packageName, "I", now, now + value, durationMs, value)
        return state.copy(appReleases = state.appReleases + release)
    }

    private fun planValue(plan: PhoneRestrictionPlans.Plan) = plan.copy(createdAt = 1, futureFrom = 0,
        schedule = plan.schedule.copy(windows = plan.schedule.windows.sortedWith(
            compareBy<PhoneRestrictionSchedulePolicy.Window> { it.id }.thenBy { it.startTime }.thenBy { it.endTime })))

    private fun absoluteWindows(plan: PhoneRestrictionPlans.Plan, grant: PhoneRestrictionInstances.Authorization,
                                zone: TimeZone) {
        val schedule = plan.schedule
        val date = schedule.dates.localDate
        if (date != null) {
            val spans = PhoneRestrictionSchedulePolicy.intervalsForDate(schedule.windows, date, zone)
            accept(spans.size == schedule.windows.size && spans.all { (start, end) ->
                start >= grant.validFrom && end <= grant.validUntil }, "plan_window_not_allowed")
            return
        }
        // Repeats remain bounded by the existing grant. Only its absolute edges can cut a weekly span.
        val boundaries = listOf(grant.validFrom) + if (grant.validUntil == MAX_SAFE_TIME) emptyList() else listOf(grant.validUntil)
        for (boundary in boundaries) {
            val day = PhoneRestrictionQuery.clock(boundary, zone).getString("localDate")
            accept(PhoneRestrictionSchedulePolicy.isLocalDate(day), "plan_window_not_allowed")
            for (offset in -1..7) {
                val selected = PhoneRestrictionSchedulePolicy.shiftLocalDate(day, offset)
                if (!PhoneRestrictionSchedulePolicy.matches(schedule.dates, selected)) continue
                val spans = PhoneRestrictionSchedulePolicy.intervalsForDate(schedule.windows, selected, zone)
                for ((start, end) in spans) if (end > grant.validFrom && start < grant.validUntil)
                    accept(start >= grant.validFrom && end <= grant.validUntil, "plan_window_not_allowed")
            }
        }
    }

    fun validatePlan(state: PhoneRestrictionInstances.State, input: PhoneRestrictionPlans.Plan,
                     expected: PhoneRestrictionPlans.Plan?, now: Long, zone: TimeZone, expectedSaved: Boolean = false) {
        ready(state, now)
        accept(input.actor == "I", "plan_not_allowed")
        val old = state.plans.firstOrNull { it.schedule.id == input.schedule.id }
        if (old == null) accept(expected == null, "plan_changed") else {
            accept(expected != null && (planValue(old) == planValue(expected) || planValue(old) == planValue(input)), "plan_changed")
            if (expectedSaved) accept(expected != null && old.createdAt == expected.createdAt &&
                old.futureFrom == expected.futureFrom, "plan_changed")
            accept(old.actor == "I" && input.authorizationId == old.authorizationId && input.scope == old.scope &&
                input.packages == old.packages && input.schedule.mode == old.schedule.mode &&
                input.schedule.warningMs == old.schedule.warningMs && input.schedule.enabled == old.schedule.enabled,
                "plan_binding_changed")
        }
        val grant = state.configuration.authorizations.firstOrNull { it.id == input.authorizationId }
        accept(grant != null && grantCurrent(grant, now), "plan_not_allowed")
        if (old == null) accept(input.schedule.enabled && input.schedule.mode == state.configuration.defaultMode &&
            input.schedule.warningMs == (if (input.schedule.mode == "warning") state.configuration.durations.warningMs else 0L),
            "plan_settings_changed")
        try { PhoneRestrictionPlans.validatePlan(state, input, now) }
        catch (_: IllegalArgumentException) { throw Rejected("plan_not_allowed") }
        catch (_: NoSuchElementException) { throw Rejected("plan_not_allowed") }
        absoluteWindows(input, grant!!, zone)
    }

    fun putPlan(state: PhoneRestrictionInstances.State, input: PhoneRestrictionPlans.Plan,
                expected: PhoneRestrictionPlans.Plan?, now: Long, zone: TimeZone,
                expectedSaved: Boolean = false): PhoneRestrictionInstances.State {
        validatePlan(state, input, expected, now, zone, expectedSaved)
        val old = state.plans.firstOrNull { it.schedule.id == input.schedule.id }
        if (old != null && planValue(old) == planValue(input)) return state
        return PhoneRestrictionPlans.put(state, input, now, zone)
    }
}
