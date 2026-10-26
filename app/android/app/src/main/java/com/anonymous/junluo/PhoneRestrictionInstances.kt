package com.anonymous.junluo

/** Saved authority and instances. No UI, model calls, scheduler or new usage semantics. */
object PhoneRestrictionInstances {
    private const val MAX_SAFE_TIME = 9_007_199_254_740_991L
    data class Authorization(
        val id: String, val scope: String, val packages: Set<String>, val phoneAllowlist: Set<String>,
        val actors: Set<String>, val modes: Set<String>, val validFrom: Long, val validUntil: Long,
        val maximumTemporaryMs: Long,
        val planAllowance: PhoneRestrictionPlans.Allowance? = null,
        val allowTemporary: Boolean = true,
    )
    data class Configuration(
        val durations: PhoneRestrictionPolicy.Durations,
        val authorizations: List<Authorization>,
        val defaultMode: String = "warning",
    )
    data class Record(
        val authorizationId: String, val restriction: PhoneRestrictionPolicy.Instance,
        val originalEndsAt: Long = restriction.endsAt, val endedBy: String? = null,
        val lastChangedAt: Long = restriction.createdAt, val lastChangedBy: String? = restriction.actor,
        val originalRequest: Start = Start(restriction.id, authorizationId, restriction.actor,
            restriction.scope, restriction.packages, restriction.mode),
        val phoneAllowlist: Set<String> = emptySet(),
        val occurrence: PhoneRestrictionSchedulePolicy.Occurrence? = null,
        val originalDurationMs: Long? = null,
    )
    data class AppRelease(
        val id: String, val instanceId: String, val packageName: String, val actor: String,
        val startedAt: Long, val until: Long,
        val durationMs: Long? = null, val originalDurationMs: Long = until - startedAt,
    )
    data class State(
        val configuration: Configuration = Configuration(PhoneRestrictionPolicy.Durations(), emptyList()),
        val configurationKnown: Boolean = true,
        val instances: List<Record> = emptyList(), val appReleases: List<AppRelease> = emptyList(),
        val plans: List<PhoneRestrictionPlans.Plan> = emptyList(),
        val appTimeRules: List<PhoneRestrictionPlans.AppTimeRule> = emptyList(),
        val paused: Boolean = false, val resumedAt: Long = 0,
    )
    data class Start(
        val id: String, val authorizationId: String, val actor: String, val scope: String,
        val packages: Set<String>, val mode: String? = null,
        val durationMs: Long? = null,
    )
    data class Saved(val state: State, val stateSaved: Boolean)

    private fun actor(value: String) { require(value in setOf("I", "you")) }
    private fun names(value: Set<String>) { require(value.all { it.isNotBlank() }) }
    fun validate(configuration: Configuration) {
        require(configuration.durations.valid())
        require(configuration.defaultMode in setOf("warning", "direct"))
        require(configuration.authorizations.map { it.id }.distinct().size == configuration.authorizations.size)
        configuration.authorizations.forEach {
            require(it.id.isNotBlank() && it.scope in setOf("phone", "apps"))
            names(it.packages); names(it.phoneAllowlist)
            require(if (it.scope == "apps") it.packages.isNotEmpty() && it.phoneAllowlist.isEmpty()
                else it.packages.isEmpty())
            require(it.actors.isNotEmpty() && it.modes.isNotEmpty())
            it.actors.forEach(::actor)
            require(it.modes.all { mode -> mode in setOf("warning", "direct") })
            PhoneRestrictionPolicy.deadline(it.validUntil, 0)
            require(it.validFrom in 0 until it.validUntil && it.maximumTemporaryMs in 1..MAX_SAFE_TIME)
            it.planAllowance?.let(PhoneRestrictionPlans::validate)
        }
    }

    fun configure(current: State, next: Configuration, now: Long): State {
        validate(next)
        val grants = next.authorizations.associateBy { it.id }
        return current.copy(configuration = next, configurationKnown = true,
            instances = current.instances.map { record ->
                val previous = record.restriction
                if (PhoneRestrictionPolicy.phase(previous, now) == "ended") return@map record
                fun ended(value: PhoneRestrictionPolicy.Instance = previous) = record.copy(
                    restriction = PhoneRestrictionPolicy.end(value, now), endedBy = "you",
                    lastChangedAt = now, lastChangedBy = "you")
                val grant = grants[record.authorizationId]
                if (grant == null || previous.actor !in grant.actors || previous.mode !in grant.modes ||
                    now !in grant.validFrom until grant.validUntil ||
                    (record.occurrence == null && !grant.allowTemporary)) return@map ended()
                val packages = when {
                    previous.scope == "apps" && grant.scope == "apps" -> previous.packages intersect grant.packages
                    previous.scope == "apps" -> previous.packages - grant.phoneAllowlist
                    grant.scope == "apps" -> grant.packages - record.phoneAllowlist
                    else -> emptySet()
                }
                val scope = if (previous.scope == "apps" || grant.scope == "apps") "apps" else "phone"
                if (scope == "apps" && packages.isEmpty()) return@map ended()
                val allowlist = if (scope == "phone") record.phoneAllowlist + grant.phoneAllowlist
                    else record.phoneAllowlist
                val until = if (record.occurrence != null) {
                    val allowed = PhoneRestrictionPlans.allowedUntil(grant.planAllowance, record.occurrence, now)
                        ?: return@map ended()
                    minOf(previous.endsAt, grant.validUntil, allowed)
                } else {
                    val cap = minOf(grant.maximumTemporaryMs, next.durations.maximumTemporaryMs, MAX_SAFE_TIME - previous.warningUntil)
                    minOf(previous.endsAt, grant.validUntil, PhoneRestrictionPolicy.deadline(previous.warningUntil, cap))
                }
                val restricted = previous.copy(scope = scope, packages = packages, endsAt = until,
                    warningUntil = if (record.occurrence != null) minOf(previous.warningUntil, until) else previous.warningUntil)
                if (until <= now) return@map ended(restricted)
                if (restricted == previous && allowlist == record.phoneAllowlist) record
                else record.copy(restriction = restricted, phoneAllowlist = allowlist,
                    lastChangedAt = now, lastChangedBy = "you")
            })
    }

    fun start(current: State, request: Start, now: Long): State {
        require(!current.paused)
        actor(request.actor)
        require(request.id.isNotBlank())
        require(request.durationMs == null || request.durationMs in 1..MAX_SAFE_TIME)
        current.instances.firstOrNull { it.restriction.id == request.id }?.let {
            val original = it.originalRequest
            require(original.authorizationId == request.authorizationId && original.actor == request.actor &&
                original.scope == request.scope && original.packages == request.packages &&
                original.durationMs == request.durationMs &&
                (request.mode == null || (original.mode ?: it.restriction.mode) == request.mode))
            return current // Including an ended instance: repeating its id never creates another deadline.
        }
        require(current.configurationKnown)
        val grant = current.configuration.authorizations.first { it.id == request.authorizationId }
        require(grant.allowTemporary)
        val mode = request.mode ?: current.configuration.defaultMode
        require(now in grant.validFrom until grant.validUntil)
        require(request.actor in grant.actors && mode in grant.modes && request.scope == grant.scope)
        require(request.packages.all { it in grant.packages })
        val durations = current.configuration.durations
        val duration = request.durationMs ?: durations.temporaryMs
        require(duration <= minOf(durations.maximumTemporaryMs, grant.maximumTemporaryMs))
        val original = request.copy(packages = request.packages.toSet(), mode = mode)
        val value = PhoneRestrictionPolicy.startTemporary(request.id, request.actor, request.scope,
            original.packages, mode, now, durations.copy(temporaryMs = duration), grant.validUntil)
        return current.copy(instances = current.instances + Record(request.authorizationId, value,
            originalRequest = original, phoneAllowlist = grant.phoneAllowlist.toSet(), originalDurationMs = duration))
    }

    fun shorten(current: State, id: String, by: String, expectedEndsAt: Long, until: Long, now: Long): State {
        actor(by)
        val record = current.instances.first { it.restriction.id == id }
        if (record.restriction.endsAt == until && record.lastChangedBy == by) return current
        requireAdjustmentAuthority(current, record, by, now)
        require(record.restriction.endsAt == expectedEndsAt)
        val shortened = PhoneRestrictionPolicy.shorten(record.restriction, until, now)
        val next = record.copy(restriction = if (record.occurrence != null) shortened.copy(
            warningUntil = minOf(shortened.warningUntil, until)) else shortened,
            lastChangedAt = now, lastChangedBy = by)
        return replace(current, next)
    }

    fun end(current: State, id: String, by: String, now: Long): State {
        actor(by)
        val record = current.instances.first { it.restriction.id == id }
        if (PhoneRestrictionPolicy.phase(record.restriction, now) == "ended") return current
        requireAdjustmentAuthority(current, record, by, now)
        return replace(current, record.copy(restriction = PhoneRestrictionPolicy.end(record.restriction, now),
            endedBy = by, lastChangedAt = now, lastChangedBy = by))
    }

    private fun replace(current: State, next: Record) = current.copy(instances = current.instances.map {
        if (it.restriction.id == next.restriction.id) next else it
    })

    private fun requireAdjustmentAuthority(current: State, record: Record, by: String, now: Long) {
        if (by == "you") return // A local explicit withdrawal never needs I's permission.
        val grant = current.configuration.authorizations.first { it.id == record.authorizationId }
        require(current.configurationKnown && by in grant.actors && now in grant.validFrom until grant.validUntil)
    }

    fun releaseApp(current: State, id: String, instanceId: String, packageName: String, by: String, now: Long,
                   durationMs: Long? = null): State {
        actor(by)
        require(id.isNotBlank() && packageName.isNotBlank())
        require(durationMs == null || durationMs in 1..MAX_SAFE_TIME)
        current.appReleases.firstOrNull { it.id == id }?.let {
            require(it.instanceId == instanceId && it.packageName == packageName && it.actor == by &&
                it.durationMs == durationMs)
            return current // A repeated/late operation does not restart ten minutes.
        }
        val record = current.instances.first { it.restriction.id == instanceId }
        require(PhoneRestrictionPolicy.phase(record.restriction, now) != "ended")
        val grant = current.configuration.authorizations.first { it.id == record.authorizationId }
        require(current.configurationKnown && now in grant.validFrom until grant.validUntil)
        require(by == "you" || by in grant.actors)
        require(if (record.restriction.scope == "apps") packageName in record.restriction.packages
            else packageName !in record.phoneAllowlist)
        val duration = durationMs ?: current.configuration.durations.appReleaseMs
        require(duration <= current.configuration.durations.appReleaseMs)
        val release = AppRelease(id, instanceId, packageName, by, now,
            PhoneRestrictionPolicy.deadline(now, duration), durationMs, duration)
        return current.copy(appReleases = current.appReleases + release)
    }

    fun isAppReleased(state: State, packageName: String, now: Long): Boolean = state.appReleases.any {
        it.packageName == packageName && now >= it.startedAt && now < it.until
    }

    /** Only currently authorized, applicable warnings may supply the visible countdown. */
    fun warningRecords(state: State, packageName: String, now: Long): List<Record> {
        if (state.paused || !state.configurationKnown || isAppReleased(state, packageName, now)) return emptyList()
        return state.instances.filter { record ->
            val restriction = record.restriction
            val grant = state.configuration.authorizations.firstOrNull { it.id == record.authorizationId }
            grant != null && restriction.actor in grant.actors && restriction.mode in grant.modes &&
                now in grant.validFrom until grant.validUntil &&
                PhoneRestrictionPolicy.phase(restriction, now) == "warning" &&
                if (restriction.scope == "apps") packageName in restriction.packages
                else packageName !in record.phoneAllowlist
        }
    }

    fun blockingInstanceIds(state: State, packageName: String, now: Long,
                            emergency: PhoneRestrictionPolicy.Emergency? = null): List<String> {
        if (state.paused || !state.configurationKnown || PhoneRestrictionPolicy.isEmergencyActive(emergency, now) ||
            isAppReleased(state, packageName, now)) return emptyList()
        return state.instances.filter { record ->
            val grant = state.configuration.authorizations.firstOrNull { it.id == record.authorizationId }
            grant != null && record.restriction.actor in grant.actors && record.restriction.mode in grant.modes &&
                now in grant.validFrom until grant.validUntil &&
                PhoneRestrictionPolicy.shouldBlock(record.restriction, packageName, now,
                    phoneAllowlist = record.phoneAllowlist)
        }.map { it.restriction.id }
    }

    /** App overlays never borrow whole-phone authority. Deadlines remain on the saved instances. */
    fun appBlockingRecords(state: State, packageName: String, now: Long,
                           emergency: PhoneRestrictionPolicy.Emergency? = null): List<Record> {
        val eligible = blockingInstanceIds(state, packageName, now, emergency).toSet()
        return state.instances.filter { it.restriction.scope == "apps" && it.restriction.id in eligible }
    }

    fun phoneBlockingRecords(state: State, packageName: String, now: Long,
                             emergency: PhoneRestrictionPolicy.Emergency? = null): List<Record> {
        val eligible = blockingInstanceIds(state, packageName, now, emergency).toSet()
        return state.instances.filter { it.restriction.scope == "phone" && it.restriction.id in eligible }
    }

    fun enteredPhone(state: State, displayedIds: Set<String>, packageName: String, now: Long,
                     emergency: PhoneRestrictionPolicy.Emergency? = null): State {
        val eligible = phoneBlockingRecords(state, packageName, now, emergency)
            .map { it.restriction.id }.toSet() intersect displayedIds
        return state.copy(instances = state.instances.map { record ->
            if (record.restriction.id !in eligible || record.restriction.enteredAt != null) record
            else record.copy(restriction = PhoneRestrictionPolicy.entered(record.restriction, now))
        })
    }

    /** Call only after the matching physical overlay succeeded; recheck current eligibility. */
    fun enteredApps(state: State, displayedIds: Set<String>, packageName: String, now: Long,
                    emergency: PhoneRestrictionPolicy.Emergency? = null): State {
        val eligible = appBlockingRecords(state, packageName, now, emergency)
            .map { it.restriction.id }.toSet() intersect displayedIds
        return state.copy(instances = state.instances.map { record ->
            if (record.restriction.id !in eligible || record.restriction.enteredAt != null) record
            else record.copy(restriction = PhoneRestrictionPolicy.entered(record.restriction, now))
        })
    }

    /** New restrictions/configuration take effect only after a true native commit. Emergency differs. */
    fun persistChange(current: State, next: State, write: (State) -> Boolean): Saved =
        if (write(next)) Saved(next, true) else Saved(current, false)
}
