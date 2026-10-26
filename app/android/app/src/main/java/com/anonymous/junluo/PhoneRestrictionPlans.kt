package com.anonymous.junluo

import java.util.TimeZone

/** Plan decisions over the existing instance state; no storage or usage counters. */
object PhoneRestrictionPlans {
    data class Allowance(val dates: PhoneRestrictionSchedulePolicy.Dates,
                         val windows: List<PhoneRestrictionSchedulePolicy.Window>)
    data class Plan(val schedule: PhoneRestrictionSchedulePolicy.Schedule,
                    val authorizationId: String, val actor: String, val scope: String,
                    val packages: Set<String>, val createdAt: Long, val futureFrom: Long = 0)
    data class AppTimeRule(val id: String, val authorizationId: String, val packageName: String,
                           val times: PhoneRestrictionSchedulePolicy.AppTimes)

    fun validate(allowance: Allowance) {
        PhoneRestrictionSchedulePolicy.validate(PhoneRestrictionSchedulePolicy.Schedule(
            "allowance", true, allowance.dates, allowance.windows, "direct", 0))
    }

    private fun coveredUntil(segments: List<Pair<Long, Long>>, from: Long): Long? {
        var until = from
        for ((start, end) in segments) {
            if (start > until) break
            if (end > until) until = end
        }
        return until.takeIf { it > from }
    }

    fun allowedUntil(allowance: Allowance?, item: PhoneRestrictionSchedulePolicy.Occurrence,
                     from: Long): Long? {
        if (allowance == null) return null
        val spans = (-1..1).flatMap { offset ->
            val day = PhoneRestrictionSchedulePolicy.shiftLocalDate(item.localDate, offset)
            if (PhoneRestrictionSchedulePolicy.matches(allowance.dates, day))
                PhoneRestrictionSchedulePolicy.intervalsForDate(allowance.windows, day, TimeZone.getTimeZone(item.timeZoneId))
            else emptyList()
        }.sortedBy { it.first }
        return coveredUntil(spans, from)
    }

    private fun coversSchedule(allowance: Allowance, schedule: PhoneRestrictionSchedulePolicy.Schedule): Boolean {
        val dates = schedule.dates
        if (allowance.dates.localDate != null) {
            val day = dates.localDate ?: return false
            val zone = TimeZone.getTimeZone("UTC")
            return PhoneRestrictionSchedulePolicy.intervalsForDate(schedule.windows, day, zone).all { (start, end) ->
                val item = PhoneRestrictionSchedulePolicy.Occurrence("", "", "", day, "UTC", start, start, end)
                (allowedUntil(allowance, item, start) ?: start) >= end
            }
        }
        fun minute(clock: String) = clock.substring(0, 2).toLong() * 60 + clock.substring(3).toLong()
        fun segment(window: PhoneRestrictionSchedulePolicy.Window): Pair<Long, Long> {
            val start = minute(window.startTime)
            val end = minute(window.endTime)
            return start to if (end < start) end + 1440 else end
        }
        val spans = (-1..7).filter { ((it % 7 + 7) % 7) + 1 in allowance.dates.weekdays }.flatMap { day ->
            allowance.windows.map { val (start, end) = segment(it); start + day * 1440 to end + day * 1440 }
        }.sortedBy { it.first }
        val days = dates.localDate?.let { setOf(PhoneRestrictionSchedulePolicy.weekdayForDate(it)) } ?: dates.weekdays
        return days.all { day -> schedule.windows.all {
            val (start, end) = segment(it)
            val offset = (day - 1) * 1440L
            (coveredUntil(spans, start + offset) ?: start + offset) >= end + offset
        } }
    }

    fun validatePlan(state: PhoneRestrictionInstances.State, plan: Plan, now: Long) {
        PhoneRestrictionSchedulePolicy.validate(plan.schedule)
        require(plan.actor in setOf("I", "you") && plan.scope in setOf("phone", "apps"))
        require(plan.createdAt > 0 && plan.futureFrom >= 0 && plan.authorizationId.isNotBlank())
        require(plan.packages.all { it.isNotBlank() } &&
            if (plan.scope == "apps") plan.packages.isNotEmpty() else plan.packages.isEmpty())
        require(state.configurationKnown)
        val grant = state.configuration.authorizations.first { it.id == plan.authorizationId }
        require(now in grant.validFrom until grant.validUntil && plan.actor in grant.actors &&
            plan.schedule.mode in grant.modes && plan.scope == grant.scope && plan.packages.all { it in grant.packages })
        require(grant.planAllowance != null && coversSchedule(grant.planAllowance, plan.schedule))
    }

    private fun afterCurrent(state: PhoneRestrictionInstances.State, id: String, now: Long): Long = maxOf(now + 1,
        state.instances.filter { it.occurrence?.scheduleId == id &&
            PhoneRestrictionPolicy.phase(it.restriction, now) != "ended" }
            .maxOfOrNull { it.restriction.endsAt } ?: 0)

    fun put(state: PhoneRestrictionInstances.State, input: Plan, now: Long, zone: TimeZone): PhoneRestrictionInstances.State {
        val current = advance(state, now, zone)
        val old = current.plans.firstOrNull { it.schedule.id == input.schedule.id }
        val same = old != null && input.copy(createdAt = old.createdAt, futureFrom = old.futureFrom) == old
        val next = input.copy(createdAt = old?.createdAt ?: now,
            futureFrom = if (old == null || same) old?.futureFrom ?: 0 else afterCurrent(current, input.schedule.id, now))
        validatePlan(current, next, now)
        return advance(current.copy(plans = current.plans.filterNot { it.schedule.id == next.schedule.id } + next), now, zone)
    }

    fun delete(state: PhoneRestrictionInstances.State, id: String, by: String, now: Long,
               zone: TimeZone): PhoneRestrictionInstances.State {
        require(by in setOf("I", "you"))
        val current = advance(state, now, zone)
        val plan = current.plans.firstOrNull { it.schedule.id == id } ?: return current
        if (by == "I") validatePlan(current, plan, now)
        return current.copy(plans = current.plans.filterNot { it.schedule.id == id })
    }

    /** Explicit local toggle: disabling never needs reapproval of an old, narrowed scope. */
    fun setEnabled(state: PhoneRestrictionInstances.State, id: String, enabled: Boolean, now: Long,
                   zone: TimeZone): PhoneRestrictionInstances.State {
        val current = advance(state, now, zone)
        val old = current.plans.first { it.schedule.id == id }
        if (old.schedule.enabled == enabled) return current
        val next = old.copy(schedule = old.schedule.copy(enabled = enabled), futureFrom = afterCurrent(current, id, now))
        if (enabled) validatePlan(current, next, now)
        return current.copy(plans = current.plans.map { if (it.schedule.id == id) next else it })
    }

    fun pause(state: PhoneRestrictionInstances.State, paused: Boolean, now: Long,
              zone: TimeZone): PhoneRestrictionInstances.State {
        if (state.paused == paused) return state
        val current = advance(state, now, zone)
        return if (paused) current.copy(paused = true, instances = current.instances.map {
            if (PhoneRestrictionPolicy.phase(it.restriction, now) == "ended") it else it.copy(
                restriction = PhoneRestrictionPolicy.end(it.restriction, now), endedBy = "you",
                lastChangedAt = now, lastChangedBy = "you")
        }) else current.copy(paused = false, resumedAt = now)
    }

    fun advance(state: PhoneRestrictionInstances.State, now: Long, zone: TimeZone): PhoneRestrictionInstances.State {
        if (state.paused || !state.configurationKnown) return state
        var next = state
        val knownIds = state.instances.map { it.restriction.id }.toMutableSet()
        for (plan in state.plans) {
            val grant = state.configuration.authorizations.firstOrNull { it.id == plan.authorizationId } ?: continue
            if (now !in grant.validFrom until grant.validUntil || plan.actor !in grant.actors ||
                plan.scope != grant.scope || plan.schedule.mode !in grant.modes) continue
            if (grant.planAllowance == null || !coversSchedule(grant.planAllowance, plan.schedule)) continue
            val packages = plan.packages intersect grant.packages
            if (plan.scope == "apps" && packages.isEmpty()) continue
            for (item in PhoneRestrictionSchedulePolicy.currentAndUpcoming(plan.schedule, now, zone)) {
                if (item.startsAt > now || item.id in knownIds || item.startsAt < plan.futureFrom ||
                    (item.startsAt <= state.resumedAt && plan.createdAt <= state.resumedAt)) continue
                val allowedEnd = allowedUntil(grant.planAllowance, item, now) ?: continue
                val end = minOf(item.endsAt, allowedEnd, grant.validUntil)
                if (end <= now) continue
                val instance = PhoneRestrictionPolicy.Instance(item.id, plan.actor, plan.scope,
                    packages, plan.schedule.mode, item.startsAt, minOf(item.warningUntil, end), end)
                val record = PhoneRestrictionInstances.Record(plan.authorizationId, instance,
                    originalEndsAt = item.endsAt, lastChangedAt = now,
                    phoneAllowlist = grant.phoneAllowlist.toSet(), occurrence = item)
                next = next.copy(instances = next.instances + record)
                knownIds.add(item.id)
            }
        }
        return next
    }

    fun validateAppRules(state: PhoneRestrictionInstances.State, rules: List<AppTimeRule>, now: Long) {
        require(state.configurationKnown && rules.map { it.id }.distinct().size == rules.size)
        rules.forEach {
            require(it.id.isNotBlank() && it.authorizationId.isNotBlank() && it.packageName.isNotBlank())
            PhoneRestrictionSchedulePolicy.validate(it.times)
            if (!it.times.enabled) return@forEach
            val grant = state.configuration.authorizations.first { grant -> grant.id == it.authorizationId }
            require(grant.scope == "apps" && "you" in grant.actors && "direct" in grant.modes &&
                it.packageName in grant.packages && now in grant.validFrom until grant.validUntil)
        }
    }

    fun appTimeBlocked(state: PhoneRestrictionInstances.State, packageName: String, now: Long, zone: TimeZone): Boolean {
        if (state.paused || !state.configurationKnown || PhoneRestrictionInstances.isAppReleased(state, packageName, now)) return false
        return state.appTimeRules.any { rule ->
            val grant = state.configuration.authorizations.firstOrNull { it.id == rule.authorizationId }
            rule.packageName == packageName && grant != null && grant.scope == "apps" &&
                "you" in grant.actors && "direct" in grant.modes && packageName in grant.packages &&
                now in grant.validFrom until grant.validUntil && PhoneRestrictionSchedulePolicy.isTimeBlocked(rule.times, now, zone)
        }
    }

    fun nextBoundary(state: PhoneRestrictionInstances.State, now: Long, zone: TimeZone): Long? {
        if (state.paused || !state.configurationKnown) return null
        // A failed instance commit must retry soon, preserving the same original epoch deadline.
        if (advance(state, now, zone) != state) return now + 1_000
        val activePlans = state.plans.filter { plan ->
            state.configuration.authorizations.any { grant ->
                grant.id == plan.authorizationId && grant.validUntil > now && grant.scope == plan.scope &&
                    plan.actor in grant.actors && plan.schedule.mode in grant.modes &&
                    grant.planAllowance != null && coversSchedule(grant.planAllowance, plan.schedule)
            }
        }
        val activeClockRules = state.appTimeRules.filter { rule ->
            state.configuration.authorizations.any { grant -> grant.id == rule.authorizationId && grant.validUntil > now &&
                grant.scope == "apps" && "you" in grant.actors && "direct" in grant.modes && rule.packageName in grant.packages }
        }
        val grantIds = activePlans.filter { it.schedule.enabled }.map { it.authorizationId }.toSet() +
            activeClockRules.filter { it.times.enabled }.map { it.authorizationId } +
            state.instances.filter { PhoneRestrictionPolicy.phase(it.restriction, now) != "ended" }.map { it.authorizationId }
        val deadlines = state.instances.filter { it.restriction.endedAt == null }.flatMap {
            listOf(it.restriction.warningUntil, it.restriction.endsAt)
        } + state.appReleases.map { it.until } + state.configuration.authorizations.filter { it.id in grantIds }
            .flatMap { listOf(it.validFrom, it.validUntil) } +
            activePlans.flatMap { plan -> PhoneRestrictionSchedulePolicy.currentAndUpcoming(plan.schedule, now, zone)
                .filter { it.startsAt >= plan.futureFrom && (it.startsAt > state.resumedAt || plan.createdAt > state.resumedAt) }
                .flatMap { listOf(it.startsAt, it.warningUntil, it.endsAt) } } +
            activeClockRules.mapNotNull { PhoneRestrictionSchedulePolicy.nextAppTimeBoundary(it.times, now, zone) }
        return deadlines.filter { it > now }.minOrNull()
    }
}
