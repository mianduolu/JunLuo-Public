package com.anonymous.junluo

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.util.TimeZone

/** Local restriction state. Pending facts have no model consumer until chapter 8 is reviewed. */
object PhoneRestrictionRuntime {
    private const val APP_OVERLAY_PREFIX = "restriction-app:"
    private const val PREFS = "junluo_phone_focus_rules"
    private const val KEY = "restriction_state_json"
    private val lock = Any()
    @Volatile private var unsavedState: String? = null

    private fun defaultsJson() = JSONObject().put("warningMs", 3 * 60_000L)
        .put("temporaryMs", 30 * 60_000L).put("maximumTemporaryMs", 2 * 60 * 60_000L)
        .put("appReleaseMs", 10 * 60_000L).put("emergencyMs", 10 * 60_000L)

    private fun readPersistent(context: Context): JSONObject {
        val raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null)
        val state = if (raw == null) JSONObject().put("schemaVersion", 1)
            .put("durations", defaultsJson()).put("emergency", JSONObject.NULL)
            .put("durationsKnown", true).put("pendingEvents", JSONArray())
            .put("configurationKnown", true).put("authorizations", JSONArray())
            .put("instances", JSONArray()).put("appReleases", JSONArray()) else JSONObject(raw)
        require(state.getInt("schemaVersion") == 1)
        durations(state.getJSONObject("durations"))
        emergency(state)
        state.getJSONArray("pendingEvents")
        instanceState(state)
        return state
    }

    private fun read(context: Context): JSONObject = unsavedState?.let { JSONObject(it) } ?: readPersistent(context)

    private fun time(value: JSONObject, key: String, allowZero: Boolean = false): Long {
        val number = value.getDouble(key)
        require(number.isFinite() && number % 1.0 == 0.0 &&
            number >= (if (allowZero) 0 else 1) && number <= 9_007_199_254_740_991.0)
        return number.toLong()
    }

    private fun durations(value: JSONObject) = PhoneRestrictionPolicy.Durations(
        time(value, "warningMs", true), time(value, "temporaryMs"),
        time(value, "maximumTemporaryMs"), time(value, "appReleaseMs"), time(value, "emergencyMs"),
    ).also { require(it.valid()) }

    private fun strings(value: JSONObject, key: String): Set<String> {
        val array = value.getJSONArray(key)
        val list = (0 until array.length()).map { array.getString(it).also { name -> require(name.isNotBlank()) } }
        require(list.distinct().size == list.size)
        return list.toSet()
    }

    private fun configuration(value: JSONObject) = PhoneRestrictionInstances.Configuration(
        durations(value.getJSONObject("durations")), value.getJSONArray("authorizations").let { array ->
            (0 until array.length()).map {
                val grant = array.getJSONObject(it)
                require(!grant.has("planAllowance") || grant.isNull("planAllowance") || grant.get("planAllowance") is JSONObject)
                require(!grant.has("allowTemporary") || grant.get("allowTemporary") is Boolean)
                PhoneRestrictionInstances.Authorization(grant.getString("id"), grant.getString("scope"),
                    strings(grant, "packages"), strings(grant, "phoneAllowlist"), strings(grant, "actors"),
                    strings(grant, "modes"), time(grant, "validFrom", true), time(grant, "validUntil"),
                    time(grant, "maximumTemporaryMs"), grant.optJSONObject("planAllowance")?.let(PhoneRestrictionPlanCodec::allowance),
                    if (grant.has("allowTemporary")) grant.getBoolean("allowTemporary") else true)
            }
        }, if (value.has("defaultMode")) value.getString("defaultMode") else "warning"
    ).also { PhoneRestrictionInstances.validate(it) }

    private fun optionalTime(value: JSONObject, key: String): Long? =
        if (value.isNull(key)) null else time(value, key)

    private fun optionalDuration(value: JSONObject, key: String = "durationMs"): Long? =
        if (!value.has(key) || value.isNull(key)) null else {
            require(value.get(key) is Number)
            time(value, key)
        }

    private fun instanceState(value: JSONObject): PhoneRestrictionInstances.State {
        val source = JSONObject(value.toString())
        if (!source.has("authorizations")) source.put("authorizations", JSONArray())
        val config = configuration(source)
        val records = if (source.has("instances")) source.getJSONArray("instances") else JSONArray()
        val instances = (0 until records.length()).map {
            val record = records.getJSONObject(it)
            val instance = PhoneRestrictionPolicy.Instance(record.getString("id"), record.getString("actor"),
                record.getString("scope"), strings(record, "packages"), record.getString("mode"),
                time(record, "createdAt"), time(record, "warningUntil"), time(record, "endsAt"),
                optionalTime(record, "enteredAt"), optionalTime(record, "endedAt"))
            require(instance.id.isNotBlank() && instance.actor in setOf("I", "you") &&
                instance.scope in setOf("phone", "apps") && instance.mode in setOf("warning", "direct"))
            require(instance.warningUntil >= instance.createdAt && instance.endsAt >= instance.createdAt)
            require(if (instance.scope == "apps") instance.packages.isNotEmpty() else instance.packages.isEmpty())
            val originalEnd = time(record, "originalEndsAt")
            require(originalEnd > instance.createdAt && originalEnd >= instance.endsAt && originalEnd >= instance.warningUntil)
            require(instance.enteredAt == null ||
                instance.enteredAt in instance.warningUntil until originalEnd)
            val endedBy = if (record.isNull("endedBy")) null else record.getString("endedBy")
            val changedBy = if (record.isNull("lastChangedBy")) null else record.getString("lastChangedBy")
            require(endedBy == null || endedBy in setOf("I", "you"))
            require(changedBy == null || changedBy in setOf("I", "you"))
            val authorizationId = record.getString("authorizationId").also { id -> require(id.isNotBlank()) }
            val original = record.optJSONObject("originalRequest")?.let { request ->
                PhoneRestrictionInstances.Start(instance.id, authorizationId, instance.actor,
                    request.getString("scope"), strings(request, "packages"), request.getString("mode"),
                    optionalDuration(request))
            } ?: PhoneRestrictionInstances.Start(instance.id, authorizationId, instance.actor,
                instance.scope, instance.packages, instance.mode)
            require(original.scope in setOf("phone", "apps") && original.mode in setOf("warning", "direct"))
            require(if (original.scope == "apps") original.packages.isNotEmpty() else original.packages.isEmpty())
            val allowlist = if (record.has("phoneAllowlist")) strings(record, "phoneAllowlist") else
                config.authorizations.firstOrNull { it.id == authorizationId }?.phoneAllowlist ?: emptySet()
            require(!record.has("occurrence") || record.isNull("occurrence") || record.get("occurrence") is JSONObject)
            val occurrence = record.optJSONObject("occurrence")?.let(PhoneRestrictionPlanCodec::occurrence)
            require(occurrence == null || (occurrence.id == instance.id && occurrence.startsAt == instance.createdAt &&
                occurrence.endsAt == originalEnd && instance.endsAt <= occurrence.endsAt))
            require(!record.has("originalDurationMs") || record.get("originalDurationMs") is Number)
            val originalDuration = optionalDuration(record, "originalDurationMs")
                ?: (originalEnd - instance.warningUntil).takeIf { occurrence == null && it > 0 }
            require(originalDuration == null || (occurrence == null && originalDuration == originalEnd - instance.warningUntil))
            require(original.durationMs == null || original.durationMs == originalDuration)
            PhoneRestrictionInstances.Record(authorizationId, instance, originalEnd, endedBy,
                time(record, "lastChangedAt"), changedBy, original, allowlist, occurrence, originalDuration)
        }
        val releases = if (source.has("appReleases")) source.getJSONArray("appReleases") else JSONArray()
        val appReleases = (0 until releases.length()).map {
            val release = releases.getJSONObject(it)
            PhoneRestrictionInstances.AppRelease(release.getString("id"), release.getString("instanceId"),
                release.getString("packageName"), release.getString("actor"), time(release, "startedAt"),
                time(release, "until"), optionalDuration(release),
                if (release.has("originalDurationMs")) {
                    require(release.get("originalDurationMs") is Number)
                    time(release, "originalDurationMs")
                } else time(release, "until") - time(release, "startedAt")).also { entry ->
                require(entry.id.isNotBlank() && entry.instanceId.isNotBlank() && entry.packageName.isNotBlank() &&
                    entry.actor in setOf("I", "you") && entry.until > entry.startedAt &&
                    entry.originalDurationMs == entry.until - entry.startedAt &&
                    (entry.durationMs == null || entry.durationMs == entry.originalDurationMs))
            }
        }
        require(instances.map { it.restriction.id }.distinct().size == instances.size)
        require(appReleases.map { it.id }.distinct().size == appReleases.size)
        val known = if (source.has("configurationKnown")) {
            require(source.get("configurationKnown") is Boolean)
            source.getBoolean("configurationKnown")
        } else false
        return PhoneRestrictionInstances.State(config, known, instances, appReleases,
            PhoneRestrictionPlanCodec.plans(source), PhoneRestrictionPlanCodec.appRules(source),
            PhoneRestrictionPlanCodec.paused(source), PhoneRestrictionPlanCodec.resumedAt(source))
    }

    private fun applyInstanceState(value: JSONObject, state: PhoneRestrictionInstances.State, now: Long) {
        PhoneRestrictionPlanCodec.apply(value, state)
        value.put("configurationKnown", state.configurationKnown)
        value.put("defaultMode", state.configuration.defaultMode)
        value.put("authorizations", JSONArray().also { array -> state.configuration.authorizations.forEach {
            array.put(JSONObject().put("id", it.id).put("scope", it.scope).put("packages", JSONArray(it.packages.toList()))
                .put("phoneAllowlist", JSONArray(it.phoneAllowlist.toList())).put("actors", JSONArray(it.actors.toList()))
                .put("modes", JSONArray(it.modes.toList())).put("validFrom", it.validFrom).put("validUntil", it.validUntil)
                .put("maximumTemporaryMs", it.maximumTemporaryMs)
                .put("allowTemporary", it.allowTemporary)
                .put("planAllowance", it.planAllowance?.let(PhoneRestrictionPlanCodec::allowanceJson) ?: JSONObject.NULL))
        } })
        value.put("instances", JSONArray().also { array -> state.instances.forEach { record ->
            val it = record.restriction
            array.put(JSONObject().put("id", it.id).put("authorizationId", record.authorizationId).put("actor", it.actor)
                .put("scope", it.scope).put("packages", JSONArray(it.packages.toList())).put("mode", it.mode)
                .put("createdAt", it.createdAt).put("warningUntil", it.warningUntil).put("endsAt", it.endsAt)
                .put("originalEndsAt", record.originalEndsAt).put("enteredAt", it.enteredAt ?: JSONObject.NULL)
                .put("endedAt", it.endedAt ?: JSONObject.NULL).put("endedBy", record.endedBy ?: JSONObject.NULL)
                .put("lastChangedAt", record.lastChangedAt).put("lastChangedBy", record.lastChangedBy ?: JSONObject.NULL)
                .put("originalRequest", JSONObject().put("scope", record.originalRequest.scope)
                    .put("packages", JSONArray(record.originalRequest.packages.toList())).put("mode", record.originalRequest.mode)
                    .put("durationMs", record.originalRequest.durationMs ?: JSONObject.NULL))
                .also { if (record.originalDurationMs != null) it.put("originalDurationMs", record.originalDurationMs) }
                .put("phoneAllowlist", JSONArray(record.phoneAllowlist.toList()))
                .put("occurrence", record.occurrence?.let(PhoneRestrictionPlanCodec::occurrenceJson) ?: JSONObject.NULL)
                .put("phase", PhoneRestrictionPolicy.phase(it, now)))
        } })
        value.put("appReleases", JSONArray().also { array -> state.appReleases.forEach {
            array.put(JSONObject().put("id", it.id).put("instanceId", it.instanceId).put("packageName", it.packageName)
                .put("actor", it.actor).put("startedAt", it.startedAt).put("until", it.until)
                .put("durationMs", it.durationMs ?: JSONObject.NULL).put("originalDurationMs", it.originalDurationMs))
        } })
    }

    private fun snapshotFields(state: JSONObject, now: Long): JSONObject {
        applyInstanceState(state, instanceState(state), now)
        return state.put("observedAt", now).put("stateSaved", unsavedState == null)
            .put("emergencyActive", PhoneRestrictionPolicy.isEmergencyActive(emergency(state), now))
    }

    private fun changeInstances(context: Context, releaseWindows: Boolean = false, at: Long? = null,
                                transform: (PhoneRestrictionInstances.State, Long) -> PhoneRestrictionInstances.State): String {
        val result = synchronized(lock) {
            check(!PhoneFocusRules.restorePaused)
            val currentJson = read(context)
            val current = instanceState(currentJson)
            val now = at ?: System.currentTimeMillis()
            val next = transform(current, now)
            val nextJson = JSONObject(currentJson.toString())
            applyInstanceState(nextJson, next, now)
            nextJson.put("durations", durationsJson(next.configuration.durations)).put("durationsKnown", true)
            // SharedPreferences updates its in-process map even when commit returns false.
            // Keep callbacks on the previous authority until the disk result is known.
            unsavedState = currentJson.toString()
            val outcome = PhoneRestrictionInstances.persistChange(current, next) {
                runCatching { save(context, nextJson) }.getOrDefault(false)
            }
            if (outcome.stateSaved) unsavedState = null
            val actual = if (outcome.stateSaved) nextJson else currentJson
            JSONObject().put("stateSaved", outcome.stateSaved).put("state", snapshotFields(actual, now))
        }
        // Window calls wait on main; storage mutex is already released.
        if (releaseWindows) {
            val appReleased = PhoneFocusOverlay.dismissForRestriction(context)
            val phoneReleased = PhoneRestrictionWindow.dismissForRestriction(context)
            result.put("overlayReleased", appReleased && phoneReleased)
            PhoneFocusCountdown.hideIfReleased(context)
        }
        reschedule(context)
        return result.toString()
    }

    private fun durationsJson(value: PhoneRestrictionPolicy.Durations) = JSONObject()
        .put("warningMs", value.warningMs).put("temporaryMs", value.temporaryMs)
        .put("maximumTemporaryMs", value.maximumTemporaryMs).put("appReleaseMs", value.appReleaseMs)
        .put("emergencyMs", value.emergencyMs)

    fun configure(context: Context, raw: String) = changeInstances(context) { current, now ->
        PhoneRestrictionInstances.configure(PhoneRestrictionPlans.advance(current, now, TimeZone.getDefault()),
            configuration(JSONObject(raw)), now)
    }.also { PhoneRestrictionScheduler.refreshCollector(context) }

    fun putPlan(context: Context, raw: String) = changeInstances(context) { current, now ->
        PhoneRestrictionPlans.put(current, PhoneRestrictionPlanCodec.plan(JSONObject(raw), now), now, TimeZone.getDefault())
    }.also { PhoneRestrictionScheduler.refreshCollector(context) }

    fun deletePlan(context: Context, raw: String) = changeInstances(context) { current, now ->
        val input = JSONObject(raw)
        PhoneRestrictionPlans.delete(current, input.getString("id"), input.getString("actor"), now, TimeZone.getDefault())
    }

    fun setPlanEnabled(context: Context, id: String, enabled: Boolean) = changeInstances(context) { current, now ->
        PhoneRestrictionPlans.setEnabled(current, id, enabled, now, TimeZone.getDefault())
    }

    fun setPaused(context: Context, paused: Boolean) = changeInstances(context, releaseWindows = true) { current, now ->
        PhoneRestrictionPlans.pause(current, paused, now, TimeZone.getDefault())
    }.also {
        PhoneRestrictionEmergencyNotification.update(context, System.currentTimeMillis())
        PhoneRestrictionScheduler.refreshCollector(context)
    }

    fun setAppTimeRules(context: Context, raw: String) = changeInstances(context) { current, now ->
        val array = JSONArray(raw)
        val rules = (0 until array.length()).map { PhoneRestrictionPlanCodec.appRule(array.getJSONObject(it)) }
        PhoneRestrictionPlans.validateAppRules(current, rules, now)
        current.copy(appTimeRules = rules)
    }.also { PhoneRestrictionScheduler.refreshCollector(context) }

    internal fun reconcilePlans(context: Context, now: Long = System.currentTimeMillis(), zone: TimeZone = TimeZone.getDefault()) {
        synchronized(lock) {
            if (PhoneFocusRules.restorePaused) return
            val json = runCatching { read(context) }.getOrNull() ?: return
            val current = instanceState(json)
            val next = PhoneRestrictionPlans.advance(current, now, zone)
            if (next != current) {
                val updated = JSONObject(json.toString())
                applyInstanceState(updated, next, now)
                unsavedState = json.toString()
                if (runCatching { save(context, updated) }.getOrDefault(false)) unsavedState = null
            }
        }
        reschedule(context, now, zone)
    }

    fun reschedule(context: Context, now: Long = System.currentTimeMillis(), zone: TimeZone = TimeZone.getDefault()) = synchronized(lock) {
        val boundary = if (PhoneFocusRules.restorePaused) null else runCatching {
            val json = read(context)
            val state = instanceState(json)
            val end = if (state.paused) null else emergency(json)?.until?.takeIf { it > now }
            listOfNotNull(PhoneRestrictionPlans.nextBoundary(state, now, zone), end).minOrNull()
        }.getOrNull()
        PhoneRestrictionScheduler.schedule(context, boundary)
    }

    fun shouldRunScheduledExecutor(context: Context, now: Long = System.currentTimeMillis()): Boolean = runCatching {
        val state = instanceState(read(context))
        !state.paused && state.configurationKnown &&
            (state.instances.any { PhoneRestrictionPolicy.phase(it.restriction, now) != "ended" } ||
                state.appTimeRules.any { rule -> rule.times.enabled && state.configuration.authorizations.any {
                    it.id == rule.authorizationId && it.scope == "apps" && rule.packageName in it.packages &&
                        "you" in it.actors && "direct" in it.modes && now in it.validFrom until it.validUntil
                } })
    }.getOrDefault(false)

    /** Technical UI only. Read errors propagate as unknown instead of authorizing a stop. */
    fun executionNeeds(context: Context, now: Long = System.currentTimeMillis()): JSONObject {
        val json = read(context)
        val state = instanceState(json)
        if (PhoneFocusRules.restorePaused || state.paused || !state.configurationKnown)
            return JSONObject().put("collector", false).put("strictPhone", false).put("overlay", false)
                .put("usageAccess", false)
        val current = state.instances.filter { PhoneRestrictionPolicy.phase(it.restriction, now) != "ended" }
        val clock = state.appTimeRules.any { rule -> rule.times.enabled && state.configuration.authorizations.any {
            it.id == rule.authorizationId && it.scope == "apps" && rule.packageName in it.packages &&
                "you" in it.actors && "direct" in it.modes && now in it.validFrom until it.validUntil
        } }
        val needed = current.isNotEmpty() || clock || PhoneRestrictionPolicy.isEmergencyActive(emergency(json), now)
        return JSONObject().put("collector", needed).put("strictPhone", current.any { it.restriction.scope == "phone" })
            .put("overlay", clock || current.any { it.restriction.scope == "apps" }).put("usageAccess", needed)
    }

    fun isAppTimeBlocked(context: Context, packageName: String, now: Long = System.currentTimeMillis()): Boolean =
        !PhoneFocusRules.restorePaused && !isEmergencyActive(context, now) && runCatching {
            PhoneRestrictionPlans.appTimeBlocked(instanceState(read(context)), packageName, now, TimeZone.getDefault())
        }.getOrDefault(false)

    fun hasAppBlocking(context: Context, packageName: String, now: Long = System.currentTimeMillis()): Boolean =
        appBlockingRecords(context, packageName, now).isNotEmpty() || isAppTimeBlocked(context, packageName, now)

    /** Explicit app launch preflight. Null/unknown reads never permit launch; no saved state is changed. */
    fun canLaunchApp(context: Context, packageName: String,
                     now: Long = System.currentTimeMillis()): AppLaunchEntryPolicy.LaunchCheck {
        val reason = AppLaunchEntryPolicy.restrictionBlockReason({
            val json = read(context)
            val state = instanceState(json)
            val known = if (json.has("durationsKnown")) {
                require(json.get("durationsKnown") is Boolean)
                json.getBoolean("durationsKnown")
            } else true
            val ownOrSystem = packageName == context.packageName || PhoneUsageEnvironment.isSystemUiPackage(packageName)
            val homeIntent = android.content.Intent(android.content.Intent.ACTION_MAIN).apply {
                addCategory(android.content.Intent.CATEGORY_HOME)
            }
            // Same exemptions as the collector, but do not turn a failed PackageManager read into an empty set.
            val homes = context.packageManager.queryIntentActivities(homeIntent, 0)
                .mapNotNull { it.activityInfo?.packageName?.trim() }.toSet()
            val defaultHome = context.packageManager.resolveActivity(homeIntent, 0)?.activityInfo?.packageName?.trim()
            val appExempt = ownOrSystem || (packageName in homes && (defaultHome == null || packageName == defaultHome))
            val focus = readLaunchFocus(context, packageName, now)
            val nonCountable = ownOrSystem || (packageName in homes && (appExempt || focus?.appLock != true))
            AppLaunchEntryPolicy.RestrictionRead(state, emergency(json), known, PhoneFocusRules.restorePaused,
                if (nonCountable) null else focus, appExempt)
        }, packageName, now, TimeZone.getDefault())
        return AppLaunchEntryPolicy.LaunchCheck(reason == null, reason)
    }

    private fun readLaunchFocus(context: Context, packageName: String, now: Long): AppLaunchEntryPolicy.FocusRead? {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val raw = prefs.getString("settings_json", "").orEmpty()
        if (raw.isBlank()) return null
        val root = JSONObject(raw)
        fun flag(value: JSONObject, key: String, default: Boolean): Boolean {
            if (!value.has(key)) return default
            require(value.get(key) is Boolean)
            return value.getBoolean(key)
        }
        fun text(value: JSONObject, key: String): String {
            if (!value.has(key)) return ""
            require(value.get(key) is String)
            return value.getString(key)
        }
        fun minutes(value: JSONObject, key: String, default: Int): Long {
            if (!value.has(key)) return default * 60_000L
            val number = value.get(key)
            require(number is Number)
            val numeric = number.toDouble()
            require(numeric.isFinite() && numeric == numeric.toInt().toDouble())
            return numeric.toInt().coerceAtLeast(1) * 60_000L
        }
        if (!flag(root, "enabled", false)) return null
        val jealousy = flag(root, "jealousyEnabled", true)
        if (!root.has("rules")) return null
        val rules = root.getJSONArray("rules")
        for (index in 0 until rules.length()) {
            val item = rules.getJSONObject(index)
            val kind = text(item, "kind")
            if (kind != "blacklist" && kind != "jealousy") continue
            if (kind == "jealousy" && !jealousy) continue
            if (text(item, "source").trim() != packageName) continue
            // The collector uses the first matching package rule, including its original fallback ID/defaults.
            val id = text(item, "id").ifBlank { "$kind:$packageName" }
            val today = java.util.Calendar.getInstance().apply { timeInMillis = now }.let {
                "${it.get(java.util.Calendar.YEAR)}-${it.get(java.util.Calendar.DAY_OF_YEAR)}"
            }
            fun counter(prefix: String, datePrefix: String): Long {
                val used = prefs.getLong("$prefix$id", 0L)
                require(used >= 0)
                return PhoneFocusPolicy.currentDayValue(used, prefs.getString("$datePrefix$id", "").orEmpty(), today)
            }
            val returnAt = PhoneFocusRules.savedReturnAt(context, id)
            return AppLaunchEntryPolicy.FocusRead(counter("usage_ms:", "usage_date:"),
                counter("daily_usage_ms:", "daily_usage_date:"),
                minutes(item, "thresholdMinutes", 15), minutes(item, "dailyLimitMinutes", 60),
                kind == "blacklist" && flag(item, "appLock", false),
                returnAt > 0L, returnAt,
                minutes(item, "returnWindowMinutes", 10))
        }
        return null
    }

    fun start(context: Context, raw: String) = changeInstances(context) { current, now ->
        val request = JSONObject(raw)
        PhoneRestrictionInstances.start(current, PhoneRestrictionInstances.Start(request.getString("id"),
            request.getString("authorizationId"), request.getString("actor"), request.getString("scope"),
            strings(request, "packages"), if (request.has("mode")) request.getString("mode") else null,
            optionalDuration(request)), now)
    }.also { PhoneRestrictionScheduler.refreshCollector(context) }

    fun shorten(context: Context, raw: String) = changeInstances(context) { current, now ->
        val request = JSONObject(raw)
        PhoneRestrictionInstances.shorten(current, request.getString("id"), request.getString("actor"),
            time(request, "expectedEndsAt"), time(request, "until"), now)
    }

    fun end(context: Context, raw: String) = changeInstances(context) { current, now ->
        val request = JSONObject(raw)
        PhoneRestrictionInstances.end(current, request.getString("id"), request.getString("actor"), now)
    }

    fun releaseApp(context: Context, raw: String) = changeInstances(context, releaseWindows = true) { current, now ->
        val request = JSONObject(raw)
        PhoneRestrictionInstances.releaseApp(current, request.getString("id"), request.getString("instanceId"),
            request.getString("packageName"), request.getString("actor"), now, optionalDuration(request))
    }

    private fun iRequest(raw: String): JSONObject = try {
        JSONObject(raw).also {
            if (it.has("actor") && it.opt("actor") != "I") throw PhoneLimitActions.Rejected("invalid_actor")
        }
    } catch (e: PhoneLimitActions.Rejected) { throw e }
      catch (_: org.json.JSONException) { throw PhoneLimitActions.Rejected("invalid_request") }

    private fun iText(request: JSONObject, key: String): String {
        val value = request.opt(key)
        if (value !is String || value.isBlank()) throw PhoneLimitActions.Rejected("invalid_request")
        return value
    }

    private fun iTime(request: JSONObject, key: String): Long {
        val value = request.opt(key)
        if (value !is Number || !value.toDouble().isFinite() || value.toDouble() % 1.0 != 0.0 ||
            value.toDouble() !in 1.0..9_007_199_254_740_991.0) throw PhoneLimitActions.Rejected("invalid_request")
        return value.toLong()
    }

    private fun iDuration(request: JSONObject): Long? =
        if (!request.has("durationMs") || request.isNull("durationMs")) null else iTime(request, "durationMs")

    private fun iPackages(request: JSONObject): Set<String> {
        val array = request.optJSONArray("packages") ?: throw PhoneLimitActions.Rejected("invalid_request")
        val names = (0 until array.length()).map { index ->
            val value = array.opt(index)
            if (value !is String || value.isBlank()) throw PhoneLimitActions.Rejected("invalid_request")
            value
        }
        if (names.distinct().size != names.size) throw PhoneLimitActions.Rejected("invalid_request")
        return names.toSet()
    }

    private fun iState(source: JSONObject, now: Long): PhoneRestrictionInstances.State {
        check(source.opt("configurationKnown") == true && source.opt("durationsKnown") == true &&
            listOf("authorizations", "instances", "appReleases", "plans", "appTimeRules").all {
                source.optJSONArray(it) != null
            } && source.opt("paused") is Boolean && source.opt("resumedAt") is Number)
        time(source, "resumedAt", true)
        val state = instanceState(source)
        val rawRecords = source.getJSONArray("instances")
        for (record in state.instances) if (record.restriction.scope == "phone" &&
            PhoneRestrictionPolicy.phase(record.restriction, now) != "ended") {
            val raw = (0 until rawRecords.length()).map { rawRecords.getJSONObject(it) }
                .first { it.getString("id") == record.restriction.id }
            val array = raw.getJSONArray("phoneAllowlist")
            check((0 until array.length()).all { array.get(it) is String })
            strings(raw, "phoneAllowlist") // No fallback to a later authorization's whitelist.
        }
        return state
    }

    /** Separate proof boundary for I calls; legacy local entry points above retain their behavior. */
    private fun iChange(context: Context, raw: String, action: String, validateOnly: Boolean = false): String {
        val result = synchronized(lock) {
            val now = System.currentTimeMillis()
            val zone = TimeZone.getDefault()
            fun envelope(outcome: String, saved: Boolean, state: JSONObject?) = PhoneRestrictionQuery.clock(now, zone)
                .put("outcome", outcome).put("stateSaved", saved).put("state", state ?: JSONObject.NULL)
            var source: JSONObject? = null
            try {
                val request = iRequest(raw)
                // Do not create defaults, reconcile plans or accept the in-memory shadow of a failed commit.
                val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                source = PhoneRestrictionQuery.savedObject(prefs.getString(KEY, null),
                    !PhoneFocusRules.restorePaused && unsavedState == null, true)
                if (source == null) return@synchronized envelope("unknown", false, null)
                val current = iState(source, now)
                var priorEndsAt: Long? = null
                val next = when (action) {
                    "start" -> PhoneLimitActions.start(current, PhoneRestrictionInstances.Start(
                        iText(request, "id"), iText(request, "authorizationId"), "I", iText(request, "scope"),
                        iPackages(request), if (!request.has("mode") || request.isNull("mode")) null else iText(request, "mode"),
                        iDuration(request)), now)
                    "shorten" -> {
                        val id = iText(request, "id")
                        priorEndsAt = current.instances.firstOrNull { it.restriction.id == id }?.restriction?.endsAt
                        PhoneLimitActions.shorten(current, id, iTime(request, "expectedEndsAt"), iTime(request, "until"), now)
                    }
                    "end" -> PhoneLimitActions.end(current, iText(request, "id"), now)
                    "release" -> {
                        val focus = PhoneRestrictionQuery.savedObject(prefs.getString("settings_json", null), !PhoneFocusRules.restorePaused)
                        PhoneLimitActions.release(current, iText(request, "id"), iText(request, "packageName"), iDuration(request), focus, now)
                    }
                    "plan" -> {
                        if (source.optJSONArray("plans") == null) return@synchronized envelope("unknown", false, null)
                        val inputJson = request.optJSONObject("input") ?: throw PhoneLimitActions.Rejected("invalid_request")
                        if (!request.has("expected") || (!request.isNull("expected") && request.optJSONObject("expected") == null))
                            throw PhoneLimitActions.Rejected("invalid_request")
                        val expectedJson = request.optJSONObject("expected")
                        val expectedSaved = expectedJson?.has("createdAt") == true || expectedJson?.has("futureFrom") == true
                        if (expectedSaved && (expectedJson?.has("createdAt") != true || !expectedJson.has("futureFrom")))
                            throw PhoneLimitActions.Rejected("invalid_request")
                        val input: PhoneRestrictionPlans.Plan
                        val expected: PhoneRestrictionPlans.Plan?
                        try {
                            input = PhoneRestrictionPlanCodec.plan(inputJson, now)
                            expected = expectedJson?.let { PhoneRestrictionPlanCodec.plan(it, if (expectedSaved) null else now) }
                        } catch (_: org.json.JSONException) { throw PhoneLimitActions.Rejected("invalid_request") }
                          catch (_: IllegalArgumentException) { throw PhoneLimitActions.Rejected("invalid_request") }
                        if (validateOnly) {
                            PhoneLimitActions.validatePlan(current, input, expected, now, zone, expectedSaved)
                            current
                        } else PhoneLimitActions.putPlan(current, input, expected, now, zone, expectedSaved)
                    }
                    else -> throw PhoneLimitActions.Rejected("invalid_request")
                }
                val targetId = request.optString("id")
                val ended = when (action) {
                    "start", "shorten", "end" -> next.instances.firstOrNull { it.restriction.id == targetId }
                        ?.let { PhoneRestrictionPolicy.phase(it.restriction, now) == "ended" } == true
                    "release" -> next.appReleases.firstOrNull { it.id == targetId }?.let { now >= it.until } == true
                    else -> false
                }
                if (validateOnly || next == current) return@synchronized envelope(
                    if (validateOnly) "validated" else if (ended) "ended" else "unchanged", true, JSONObject(source.toString()))
                    .also { if (priorEndsAt != null) it.put("priorEndsAt", priorEndsAt) }
                val nextJson = JSONObject(source.toString())
                applyInstanceState(nextJson, next, now)
                // A failed commit can still update Android's in-process map. Keep old callback authority.
                unsavedState = source.toString()
                val saved = try { save(context, nextJson) } catch (_: Exception) { false }
                if (!saved) return@synchronized envelope("unknown", false, null)
                unsavedState = null
                envelope("saved", true, JSONObject(nextJson.toString()))
                    .also { if (priorEndsAt != null) it.put("priorEndsAt", priorEndsAt) }
            } catch (e: PhoneLimitActions.Rejected) {
                envelope("rejected", source != null, source?.let { JSONObject(it.toString()) }).put("reason", e.reason)
            } catch (_: Exception) { envelope("unknown", false, null) }
        }
        if (result.optString("outcome") == "saved") {
            // Commit proof survives failures in later window/scheduler work. Display remains a separate query.
            var failed = false
            if (action == "release" || action == "end" || action == "shorten") {
                runCatching {
                    PhoneFocusOverlay.dismissForRestriction(context)
                    PhoneRestrictionWindow.dismissForRestriction(context)
                    PhoneFocusCountdown.hideIfReleased(context)
                }.onFailure { failed = true }
            }
            runCatching { reschedule(context) }.onFailure { failed = true }
            if (action == "start" || action == "plan")
                runCatching { PhoneRestrictionScheduler.refreshCollector(context) }.onFailure { failed = true }
            if (failed) result.put("postActionFailed", true)
        }
        return result.toString()
    }

    fun startForI(context: Context, raw: String) = iChange(context, raw, "start")
    fun shortenForI(context: Context, raw: String) = iChange(context, raw, "shorten")
    fun endForI(context: Context, raw: String) = iChange(context, raw, "end")
    fun releaseAppForI(context: Context, raw: String) = iChange(context, raw, "release")
    fun validatePlanForI(context: Context, raw: String) = iChange(context, raw, "plan", validateOnly = true)
    fun putPlanForI(context: Context, raw: String) = iChange(context, raw, "plan")

    fun appBlockingRecords(context: Context, packageName: String,
                           now: Long = System.currentTimeMillis()): List<PhoneRestrictionInstances.Record> {
        if (PhoneFocusRules.restorePaused) return emptyList()
        // Like the release gates, this read may run on main while the collector waits for a window.
        return runCatching {
            val state = read(context)
            PhoneRestrictionInstances.appBlockingRecords(instanceState(state), packageName, now, emergency(state))
        }.getOrDefault(emptyList())
    }

    /** Internal display acknowledgement; no model or bridge can claim a physical show. */
    fun recordAppOverlayEntry(context: Context, packageName: String, displayedIds: Set<String>): String =
        changeInstances(context) { current, now ->
            PhoneRestrictionInstances.enteredApps(current, displayedIds, packageName, now, emergency(read(context)))
        }

    fun phoneBlockingRecords(context: Context, packageName: String,
                             now: Long = System.currentTimeMillis()): List<PhoneRestrictionInstances.Record> {
        if (PhoneFocusRules.restorePaused) return emptyList()
        return runCatching {
            val state = read(context)
            PhoneRestrictionInstances.phoneBlockingRecords(instanceState(state), packageName, now, emergency(state))
        }.getOrDefault(emptyList())
    }

    fun phoneAllowedPackages(context: Context, now: Long = System.currentTimeMillis()): Set<String> = runCatching {
        val json = read(context)
        val state = instanceState(json)
        val active = PhoneRestrictionInstances.phoneBlockingRecords(state, "", now, emergency(json))
        if (active.isEmpty()) emptySet() else active.map { it.phoneAllowlist }.reduce { a, b -> a intersect b } +
            state.appReleases.filter { now in it.startedAt until it.until }.map { it.packageName }
    }.getOrDefault(emptySet())

    fun recordPhoneWindowEntry(context: Context, packageName: String, displayedIds: Set<String>): String =
        changeInstances(context) { current, now ->
            PhoneRestrictionInstances.enteredPhone(current, displayedIds, packageName, now, emergency(read(context)))
        }

    fun emergencyDisplay(context: Context): PhoneRestrictionPolicy.Emergency? =
        if (PhoneFocusRules.restorePaused) null else runCatching {
            val state = read(context)
            if (instanceState(state).paused) null else emergency(state)
        }.getOrNull()

    fun warningDisplay(context: Context, packageName: String, now: Long): PhoneRestrictionInstances.Record? {
        if (PhoneFocusRules.restorePaused) return null
        return runCatching {
            val state = read(context)
            if (PhoneRestrictionPolicy.isEmergencyActive(emergency(state), now)) null
            else PhoneRestrictionInstances.warningRecords(instanceState(state), packageName, now)
                .minByOrNull { it.restriction.warningUntil }
        }.getOrNull()
    }

    private fun emergency(state: JSONObject): PhoneRestrictionPolicy.Emergency? {
        val value = state.optJSONObject("emergency") ?: return null
        val id = value.getString("id").also { require(it.isNotBlank()) }
        val startedAt = time(value, "startedAt")
        val until = time(value, "until").also { require(it > startedAt) }
        val extensions = value.getJSONArray("extensions")
        return PhoneRestrictionPolicy.Emergency(id, startedAt, until,
            (0 until extensions.length()).map { index ->
                val extension = extensions.getJSONObject(index)
                PhoneRestrictionPolicy.Extension(extension.getString("id"),
                    time(extension, "occurredAt"), time(extension, "until"))
            }, value.getJSONArray("acceptedStartOperations").let { operations ->
                (0 until operations.length()).map { operations.getString(it) }.toSet()
            })
    }

    private fun emergencyJson(value: PhoneRestrictionPolicy.Emergency) = JSONObject()
        .put("id", value.id).put("startedAt", value.startedAt).put("until", value.until)
        .put("acceptedStartOperations", JSONArray(value.acceptedStartOperations.toList()))
        .put("extensions", JSONArray().also { array -> value.extensions.forEach {
            array.put(JSONObject().put("id", it.id).put("occurredAt", it.occurredAt).put("until", it.until))
        } }).put("endObserved", false)

    private fun event(state: JSONObject, id: String, kind: String, value: PhoneRestrictionPolicy.Emergency,
                      occurredAt: Long, observedAt: Long, actor: String?) {
        state.getJSONArray("pendingEvents").put(JSONObject().put("id", id).put("kind", kind)
            .put("emergencyId", value.id).put("actor", actor ?: JSONObject.NULL)
            .put("occurredAt", occurredAt).put("observedAt", observedAt).put("until", value.until)
            .put("operationIds", JSONArray(value.acceptedStartOperations.toList())))
    }

    private fun save(context: Context, state: JSONObject): Boolean =
        !PhoneFocusRules.restorePaused && state.optBoolean("durationsKnown", true) &&
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().putString(KEY, state.toString()).commit()

    // This gate never waits for the mutation lock while a window callback is on the main thread.
    fun isEmergencyActive(context: Context, now: Long = System.currentTimeMillis()): Boolean {
        return runCatching { PhoneRestrictionPolicy.isEmergencyActive(emergency(read(context)), now) }
            .getOrDefault(false)
    }

    fun isBlockingReleased(context: Context, packageName: String, now: Long = System.currentTimeMillis()): Boolean =
        isEmergencyActive(context, now) || runCatching {
            val state = instanceState(read(context))
            state.paused || PhoneRestrictionInstances.isAppReleased(state, packageName, now)
        }.getOrDefault(false)

    fun isRuleReleased(context: Context, ruleId: String): Boolean {
        if (isEmergencyActive(context)) return true
        appOverlayPackage(ruleId)?.let { return !hasAppBlocking(context, it) }
        val packageName = PhoneFocusRules.blacklistRules(context).firstOrNull { it.id == ruleId }?.source ?: return false
        return isBlockingReleased(context, packageName)
    }

    fun appOverlayRuleId(packageName: String): String = APP_OVERLAY_PREFIX + packageName
    fun appOverlayPackage(ruleId: String): String? =
        ruleId.takeIf { it.startsWith(APP_OVERLAY_PREFIX) }?.removePrefix(APP_OVERLAY_PREFIX)?.takeIf { it.isNotBlank() }

    fun freezeForRestore(context: Context? = null) {
        synchronized(lock) { PhoneFocusRules.setRestorePaused(true) }
        PhoneRestrictionScheduler.cancel(context)
        PhoneRestrictionWindow.dismissForRestore()
    }

    fun discardForRestore(context: Context): Boolean = synchronized(lock) {
        check(PhoneFocusRules.restorePaused)
        val state = runCatching { read(context) }.getOrElse {
            JSONObject().put("schemaVersion", 1).put("durations", defaultsJson()).put("durationsKnown", false)
        }
        val previous = state.toString()
        state.put("configurationKnown", false).put("authorizations", JSONArray()).put("instances", JSONArray())
            .put("appReleases", JSONArray()).put("emergency", JSONObject.NULL).put("pendingEvents", JSONArray())
            .put("plans", JSONArray()).put("appTimeRules", JSONArray()).put("paused", false).put("resumedAt", 0)
        val saved = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, state.toString()).commit()
        unsavedState = if (saved) null else previous
        saved
    }

    fun observeEmergencyEnd(context: Context, now: Long = System.currentTimeMillis()) {
        val changed = synchronized(lock) {
            if (PhoneFocusRules.restorePaused) return@synchronized false
            runCatching {
                val state = read(context)
                val current = emergency(state) ?: return@runCatching false
                val value = state.getJSONObject("emergency")
                if (now >= current.until && !value.optBoolean("endObserved")) {
                    value.put("endObserved", true)
                    event(state, "${current.id}:ended", "emergency_ended", current, current.until, now, null)
                    unsavedState = state.toString()
                    if (save(context, state)) unsavedState = null
                    true
                } else false
            }.getOrDefault(false)
        }
        if (changed) PhoneGuardMessageTaskService.checkEmergencyContact(context)
    }

    fun snapshot(context: Context): String {
        reconcilePlans(context)
        observeEmergencyEnd(context)
        return synchronized(lock) {
            val state = read(context)
            snapshotFields(state, System.currentTimeMillis()).put("scheduleWake", PhoneRestrictionScheduler.status()).toString()
        }
    }

    /** Read saved JSON without defaults, reconciliation, emergency events or window refresh. */
    fun query(context: Context): String {
        val result = synchronized(lock) {
            val prefs = runCatching { context.getSharedPreferences(PREFS, Context.MODE_PRIVATE) }.getOrNull()
            val available = !PhoneFocusRules.restorePaused
            val state = PhoneRestrictionQuery.savedObject(
                runCatching { prefs?.getString(KEY, null) }.getOrNull(), available && unsavedState == null, true)
            val focus = PhoneRestrictionQuery.savedObject(
                runCatching { prefs?.getString("settings_json", null) }.getOrNull(), available)
            PhoneRestrictionQuery.clock(System.currentTimeMillis(), TimeZone.getDefault())
                .put("state", state ?: JSONObject.NULL).put("focusSettings", focus ?: JSONObject.NULL)
        }
        val state = result.optJSONObject("state")
        val focus = result.optJSONObject("focusSettings")
        val legacyLockIds = PhoneRestrictionQuery.legacyLockRuleIds(focus)
        // The query needs the cached observation only. The legacy emergency-log reader can open/upgrade SQLite.
        val usage = runCatching { JSONObject(readUsageSnapshot(context, null)) }.getOrNull()
        result.put("usage", PhoneRestrictionQuery.observedUsage(usage) ?: JSONObject.NULL)
            .put("display", runCatching { PhoneRestrictionWindow.queryDisplay(context, legacyLockIds) }.getOrNull() ?: JSONObject.NULL)
            .put("timeBlockedApps", PhoneRestrictionQuery.timeBlockedApps(state, result.getLong("observedAt"),
                TimeZone.getTimeZone(result.getString("timeZoneId"))) ?: JSONObject.NULL)
        if (PhoneFocusRules.restorePaused) {
            listOf("state", "focusSettings", "display", "timeBlockedApps").forEach { result.put(it, JSONObject.NULL) }
            result.optJSONObject("usage")?.put("restorePaused", true)?.put("usageObservation", JSONObject.NULL)
        }
        return result.toString()
    }

    /** Read existing counters/logs. Never extrapolate a cached foreground app to the read clock. */
    fun usageSnapshot(context: Context): String {
        val state = synchronized(lock) { read(context) }
        return readUsageSnapshot(context, emergency(state))
    }

    private fun readUsageSnapshot(context: Context, current: PhoneRestrictionPolicy.Emergency?): String {
        val now = System.currentTimeMillis()
        val paused = PhoneFocusRules.restorePaused
        val running = PhoneActivityCollectorService.isRunning
        val rawObservation = if (paused || !running) null else PhoneActivityCollectorService.getRestrictionUsageSnapshot()
        var observation = rawObservation?.let { JSONObject(it) }
                ?.takeIf { time(it, "observedAt") <= now }
        val intervals = mutableListOf<PhoneRestrictionPolicy.AppUsageInterval>()
        val usage = current?.let { window ->
            val observedUntil = minOf(window.until, now).coerceAtLeast(window.startedAt)
            val logs = runCatching {
                check(!paused)
                PhoneActivityReporter.queryRestrictionUsageIntervals(context, window.startedAt, observedUntil)
            }.getOrNull()
            logs?.getJSONArray("intervals")?.let { parts ->
                for (index in 0 until parts.length()) {
                    val part = parts.getJSONObject(index)
                    intervals.add(PhoneRestrictionPolicy.AppUsageInterval(part.getString("packageName"),
                        part.getLong("from"), part.getLong("until")))
                }
            }
            JSONObject().put("emergencyId", window.id).put("from", window.startedAt).put("until", window.until)
                .put("observedUntil", observedUntil).put("logsAvailable", logs != null)
                .put("logsTruncated", logs?.getBoolean("truncated") ?: false)
        }
        // Restore may start while SQLite is queried; do not expose a running observation across it.
        val finallyPaused = PhoneFocusRules.restorePaused
        val finallyRunning = PhoneActivityCollectorService.isRunning
        // Late hints may close a segment before the cached observation. Drop that old tail.
        if (finallyPaused || !finallyRunning || PhoneActivityCollectorService.getRestrictionUsageSnapshot() != rawObservation)
            observation = null
        if (usage != null) {
            observation?.optJSONObject("ongoing")?.let { part ->
                intervals.add(PhoneRestrictionPolicy.AppUsageInterval(part.getString("packageName"),
                    part.getLong("from"), part.getLong("until")))
            }
            usage.put("byApp", JSONArray().also { array ->
                PhoneRestrictionPolicy.observedUsageByApp(intervals, current.startedAt, usage.getLong("observedUntil"))
                    .toSortedMap().forEach { (packageName, usedMs) ->
                        array.put(JSONObject().put("packageName", packageName).put("usedMs", usedMs))
                    }
            })
        }
        return JSONObject().put("schemaVersion", 1).put("subject", "you").put("observedAt", now)
            .put("collectorRunning", finallyRunning).put("restorePaused", finallyPaused)
            .put("usageObservation", if (finallyPaused || !finallyRunning) JSONObject.NULL else observation ?: JSONObject.NULL)
            .put("emergencyUsage", usage ?: JSONObject.NULL).toString()
    }

    fun configureDurations(context: Context, raw: String): String = changeInstances(context) { current, now ->
        PhoneRestrictionInstances.configure(current, current.configuration.copy(durations = durations(JSONObject(raw))), now)
            .copy(configurationKnown = current.configurationKnown)
    }

    fun emergency(context: Context, operationId: String, expectedId: String? = null): String {
        require(operationId.isNotBlank())
        var saved = false
        var changed = false
        val state = synchronized(lock) {
            check(!PhoneFocusRules.restorePaused)
            var persistentReadable = true
            val value = try { read(context) } catch (_: Exception) {
                persistentReadable = false
                JSONObject().put("schemaVersion", 1).put("durations", defaultsJson())
                    .put("durationsKnown", false).put("emergency", JSONObject.NULL).put("pendingEvents", JSONArray())
            }
            val current = emergency(value)
            val now = System.currentTimeMillis()
            val durationMs = durations(value.getJSONObject("durations")).emergencyMs
            if (expectedId == null && current?.acceptedStartOperations?.contains(operationId) != true) {
                val events = value.getJSONArray("pendingEvents")
                require((0 until events.length()).none {
                    val entry = events.getJSONObject(it)
                    val operations = entry.optJSONArray("operationIds") ?: JSONArray()
                    entry.optString("kind") == "emergency_started" &&
                        (entry.optString("emergencyId") == operationId ||
                            (0 until operations.length()).any { index -> operations.optString(index) == operationId })
                })
            }
            val next = if (expectedId == null) {
                PhoneRestrictionPolicy.startEmergency(current, operationId, now, durationMs)
            } else {
                PhoneRestrictionPolicy.extendEmergency(requireNotNull(current), expectedId, operationId, now, durationMs)
            }
            if (next != emergency(value)) {
                changed = true
                val previous = emergency(value)
                if (previous != null && previous.id != next.id && !value.getJSONObject("emergency").optBoolean("endObserved")) {
                    event(value, "${previous.id}:ended", "emergency_ended", previous, previous.until, now, null)
                }
                value.put("emergency", emergencyJson(next))
                if (expectedId == null && next.id == previous?.id) {
                    val events = value.getJSONArray("pendingEvents")
                    for (index in 0 until events.length()) {
                        val entry = events.getJSONObject(index)
                        if (entry.optString("kind") == "emergency_started" && entry.optString("emergencyId") == next.id) {
                            entry.put("operationIds", JSONArray(next.acceptedStartOperations.toList()))
                        }
                    }
                } else {
                    val kind = if (expectedId == null) "emergency_started" else "emergency_extended"
                    event(value, "${next.id}:$operationId", kind, next, now, now, "you")
                }
                // Even failed persistence must not withhold the local emergency release.
                unsavedState = value.toString()
                // Unknown persisted settings are not overwritten by fallback defaults.
                saved = persistentReadable && runCatching { readPersistent(context); save(context, value) }.getOrDefault(false)
                if (saved) unsavedState = null
            } else {
                saved = unsavedState == null || runCatching { readPersistent(context); save(context, value) }.getOrDefault(false)
                if (saved) unsavedState = null
            }
            snapshotFields(value, now)
        }
        // Do not hold the storage lock while waiting for the main-thread window removal.
        val active = state.getBoolean("emergencyActive")
        val appReleased = active && PhoneFocusOverlay.dismissForRestriction(context)
        val phoneReleased = active && PhoneRestrictionWindow.dismissForRestriction(context)
        val released = appReleased && phoneReleased
        if (active) PhoneFocusCountdown.hide()
        reschedule(context)
        if (changed) PhoneGuardMessageTaskService.checkEmergencyContact(context)
        return JSONObject().put("stateSaved", saved).put("overlayReleased", released)
            .put("state", state).toString()
    }
}
