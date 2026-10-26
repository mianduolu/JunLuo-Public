package com.anonymous.junluo

import org.json.JSONArray
import org.json.JSONObject
import java.util.GregorianCalendar
import java.util.Locale
import java.util.TimeZone

/** Read projections only: no defaults, transitions, counter consumption or persistence. */
object PhoneRestrictionQuery {
    fun savedObject(raw: String?, available: Boolean, state: Boolean = false): JSONObject? {
        if (!available || raw.isNullOrBlank()) return null
        return runCatching { JSONObject(raw).also {
            if (state) require(it.opt("schemaVersion") is Number && it.getDouble("schemaVersion") == 1.0)
        } }.getOrNull()
    }

    fun clock(now: Long, zone: TimeZone): JSONObject {
        val day = GregorianCalendar(zone, Locale.ROOT).apply { timeInMillis = now }
        val date = String.format(Locale.ROOT, "%04d-%02d-%02d", day.get(java.util.Calendar.YEAR),
            day.get(java.util.Calendar.MONTH) + 1, day.get(java.util.Calendar.DAY_OF_MONTH))
        day.set(java.util.Calendar.HOUR_OF_DAY, 0)
        day.set(java.util.Calendar.MINUTE, 0)
        day.set(java.util.Calendar.SECOND, 0)
        day.set(java.util.Calendar.MILLISECOND, 0)
        return JSONObject().put("schemaVersion", 1).put("observedAt", now).put("timeZoneId", zone.id)
            .put("localDate", date).put("dayStart", day.timeInMillis)
    }

    fun display(now: Long, screenAvailable: Boolean?, phoneShown: Boolean?, appShown: Boolean?): JSONObject =
        JSONObject().put("observedAt", now)
            .put("phonePageShown", if (screenAvailable == false) false else if (screenAvailable == true) phoneShown ?: JSONObject.NULL else JSONObject.NULL)
            .put("appLockShown", if (screenAvailable == false) false else if (screenAvailable == true) appShown ?: JSONObject.NULL else JSONObject.NULL)

    /** Same first-per-package, then first-per-id selection as the existing counter observation. */
    fun legacyLockRuleIds(settings: JSONObject?): Set<String>? = runCatching {
        require(settings != null && settings.opt("enabled") is Boolean)
        if (!settings.getBoolean("enabled")) return@runCatching emptySet<String>()
        require(!settings.has("jealousyEnabled") || settings.opt("jealousyEnabled") is Boolean)
        val jealousy = settings.optBoolean("jealousyEnabled", true)
        val rules = settings.getJSONArray("rules")
        val packages = mutableSetOf<String>()
        val ids = mutableSetOf<String>()
        buildSet {
            for (index in 0 until rules.length()) {
                val rule = rules.getJSONObject(index)
                require(rule.opt("kind") is String && rule.getString("kind") in setOf("blacklist", "jealousy", "whitelist"))
                val kind = rule.getString("kind")
                if (kind != "blacklist" && kind != "jealousy") continue
                if (kind == "jealousy" && !jealousy) continue
                require(rule.opt("source") is String)
                val source = rule.getString("source").trim()
                require(source.isNotBlank())
                require(!rule.has("id") || rule.opt("id") is String)
                val id = rule.optString("id").ifBlank { "$kind:$source" }
                if (!packages.add(source) || !ids.add(id)) continue
                if (kind == "blacklist" && rule.opt("appLock") == true) add(id)
            }
        }
    }.getOrNull()

    private fun strings(value: JSONObject, key: String): Set<String> {
        val array = value.getJSONArray(key)
        return (0 until array.length()).map {
            val text = array.get(it)
            require(text is String && text.isNotBlank())
            text as String
        }.also { require(it.distinct().size == it.size) }.toSet()
    }

    private fun time(value: JSONObject, key: String): Long {
        val number = value.get(key)
        require(number is Number && number.toDouble().isFinite() && number.toDouble() % 1.0 == 0.0 &&
            number.toDouble() in 0.0..9_007_199_254_740_991.0)
        return number.toLong()
    }

    /** Time conditions alone. Pause, emergency and App-release overlays are reported separately. */
    fun timeBlockedApps(state: JSONObject?, now: Long, zone: TimeZone): JSONObject? = runCatching {
        require(state != null && state.opt("configurationKnown") == true)
        val grants = state.getJSONArray("authorizations")
        val byId = (0 until grants.length()).map { grants.getJSONObject(it) }.associateBy {
            require(it.opt("id") is String && it.getString("id").isNotBlank())
            it.getString("id")
        }
        require(byId.size == grants.length())
        // Validate only the authorization facts this projection uses, retaining unrelated raw fields.
        byId.values.forEach { grant ->
            require(grant.opt("scope") in setOf("phone", "apps"))
            val actors = strings(grant, "actors")
            val modes = strings(grant, "modes")
            val packages = strings(grant, "packages")
            require(actors.isNotEmpty() && actors.all { it in setOf("I", "you") })
            require(modes.isNotEmpty() && modes.all { it in setOf("warning", "direct") })
            require(if (grant.getString("scope") == "phone") packages.isEmpty() else packages.isNotEmpty())
            require(time(grant, "validUntil") > time(grant, "validFrom"))
        }
        require(state.has("appTimeRules"))
        val rules = PhoneRestrictionPlanCodec.appRules(state)
        val packages = rules.filter { rule ->
            val grant = byId[rule.authorizationId]
            grant != null && grant.getString("scope") == "apps" && "you" in strings(grant, "actors") &&
                "direct" in strings(grant, "modes") && rule.packageName in strings(grant, "packages") &&
                now in time(grant, "validFrom") until time(grant, "validUntil") &&
                PhoneRestrictionSchedulePolicy.isTimeBlocked(rule.times, now, zone)
        }.map { it.packageName }.distinct().sorted()
        JSONObject().put("observedAt", now).put("packages", JSONArray(packages))
    }.getOrNull()

    fun observedUsage(usage: JSONObject?): JSONObject? = usage?.let {
        JSONObject(it.toString()).also { copy ->
            copy.optJSONObject("usageObservation")?.let { observation ->
                if (observation.opt("rulesKnown") != true) observation.put("rules", JSONObject.NULL)
            }
        }
    }
}
