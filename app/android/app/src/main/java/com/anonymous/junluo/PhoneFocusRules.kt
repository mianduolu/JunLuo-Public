package com.anonymous.junluo

import android.content.Context
import org.json.JSONObject
import org.json.JSONArray
import java.util.Calendar

object PhoneFocusRules {
    @Volatile var restorePaused = false
        private set

    @Synchronized fun setRestorePaused(paused: Boolean) { restorePaused = paused }
    private const val PREFS = "junluo_phone_focus_rules"
    private const val KEY_SETTINGS = "settings_json"
    private const val KEY_PENDING_TRIGGER = "pending_trigger"
    private const val KEY_CARE_FOLLOW_UP = "care_follow_up"
    private const val KEY_LAST_EXIT_RULE = "last_exit_rule"
    private const val KEY_LAST_EXIT_AT = "last_exit_at"
    private const val KEY_LAUNCH_REQUEST = "launch_request"
    private const val KEY_RETURN_RULE = "return_rule"
    private const val KEY_RETURN_AT = "return_at"
    private const val KEY_USAGE_PREFIX = "usage_ms:"
    private const val KEY_USAGE_DATE_PREFIX = "usage_date:"
    private const val KEY_DAILY_USAGE_PREFIX = "daily_usage_ms:"
    private const val KEY_DAILY_DATE_PREFIX = "daily_usage_date:"

    /** Same legacy demand as its settings mirror; no rule/counter mutation. */
    fun collectorRequired(context: Context): Boolean {
        if (restorePaused) return false
        val raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_SETTINGS, null)
            ?: return false
        val settings = JSONObject(raw)
        val rules = settings.optJSONArray("rules") ?: JSONArray()
        return settings.optBoolean("enabled") || (settings.optBoolean("jealousyEnabled", true) &&
            (0 until rules.length()).any { rules.optJSONObject(it)?.optString("kind") == "jealousy" })
    }

    data class Rule(
        val id: String,
        val kind: String,
        val source: String,
        val title: String,
        val thresholdMinutes: Int,
        val returnWindowMinutes: Int,
        val dailyLimitMinutes: Int,
        val appLock: Boolean = false,
    )

    @Synchronized
    fun saveSettings(context: Context, settingsJson: String): Boolean {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_SETTINGS, settingsJson)
            .apply()
        val followUp = readCareFollowUp(context)
        if (followUp != null && followUp.optString("status") != "finished" &&
            !isCareRuleEnabled(context, followUp.optString("ruleId"))) {
            finishCareSlot(context, followUp, "care_disabled")
        }
        return true
    }

    private fun readCareFollowUp(context: Context): JSONObject? = try {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(KEY_CARE_FOLLOW_UP, null)?.let { JSONObject(it) }
    } catch (_: Exception) { null }

    @Synchronized
    fun getCareFollowUp(context: Context): String? = readCareFollowUp(context)?.toString()

    @Synchronized
    fun compareAndSetCareFollowUp(context: Context, expectedRevision: Long, valueJson: String): Boolean {
        // Empty writes are reserved for restore, and restore retains a revision tombstone.
        if (valueJson.isBlank()) return false
        val current = readCareFollowUp(context)
        val next = try { JSONObject(valueJson) } catch (_: Exception) { return false }
        if (!PhoneCareFollowUpPolicy.acceptsRevision(current?.optLong("revision") ?: 0L,
                expectedRevision, next.optLong("revision"), restorePaused)) return false
        if (next.optInt("schemaVersion") != 1 ||
            next.optString("status") !in setOf("waiting", "prepared", "finished")) return false
        if (current?.optString("status") != "finished" && current?.optBoolean("requestClaimed") == true &&
            !next.optBoolean("requestClaimed")) return false
        if (next.optString("status") != "finished" &&
            !isCareRuleEnabled(context, next.optString("ruleId"))) return false
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString(KEY_CARE_FOLLOW_UP, next.toString()).commit()
    }

    @Synchronized
    fun clearCareFollowUpForRestore(context: Context): Boolean {
        val current = readCareFollowUp(context) ?: JSONObject()
            .put("schemaVersion", 1).put("revision", 0)
            .put("eventId", "").put("triggerId", "").put("ruleId", "")
            .put("sessionId", JSONObject.NULL).put("lastIMessageId", "")
            .put("lastContactAt", 0).put("careReason", "")
            .put("dueAt", 0).put("expiresAt", 0).put("nextCheckAt", 0)
        return finishCareSlot(context, current, "restore")
    }

    private fun finishCareSlot(context: Context, current: JSONObject, reason: String): Boolean {
        current.put("revision", current.optLong("revision") + 1L)
            .put("status", "finished").put("finishedReason", reason).put("requestClaimed", true)
        current.remove("preparedMessage")
        current.remove("pausedYouMessageId")
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString(KEY_CARE_FOLLOW_UP, current.toString()).commit()
    }

    private fun enabledCareRules(context: Context): List<JSONObject> = try {
        val settings = JSONObject(context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(KEY_SETTINGS, "").orEmpty())
        if (!settings.optBoolean("enabled")) emptyList() else {
            val rules = settings.optJSONArray("rules") ?: JSONArray()
            (0 until rules.length()).mapNotNull { rules.optJSONObject(it) }.filter {
                it.optString("kind") == "blacklist" && it.optBoolean("enabled", true)
            }
        }
    } catch (_: Exception) { emptyList() }

    fun isCareRuleEnabled(context: Context, ruleId: String): Boolean =
        !restorePaused && enabledCareRules(context).any {
            it.optString("id").ifBlank { "blacklist:${it.optString("source").trim()}" } == ruleId
        }

    fun isCareManagedApp(context: Context, packageName: String): Boolean =
        !restorePaused && packageName.isNotBlank() && enabledCareRules(context).any {
            it.optString("source").trim() == packageName
        }

    fun blacklistRules(context: Context): List<Rule> {
        if (restorePaused) return emptyList()
        val raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_SETTINGS, "") ?: ""
        if (raw.isBlank()) return emptyList()
        return try {
            val root = JSONObject(raw)
            if (!root.optBoolean("enabled", false)) return emptyList()
            val jealousyEnabled = root.optBoolean("jealousyEnabled", true)
            val rules = root.optJSONArray("rules") ?: return emptyList()
            buildList {
                for (index in 0 until rules.length()) {
                    val item = rules.optJSONObject(index) ?: continue
                    val kind = item.optString("kind")
                    if (kind != "blacklist" && kind != "jealousy") continue
                    if (kind == "jealousy" && !jealousyEnabled) continue
                    val source = item.optString("source").trim()
                    if (source.isBlank()) continue
                    add(
                        Rule(
                            id = item.optString("id").ifBlank { "$kind:$source" },
                            kind = kind,
                            source = source,
                            title = item.optString("title").ifBlank { source },
                            thresholdMinutes = item.optInt("thresholdMinutes", 15).coerceAtLeast(1),
                            returnWindowMinutes = item.optInt("returnWindowMinutes", 10).coerceAtLeast(1),
                            dailyLimitMinutes = item.optInt("dailyLimitMinutes", 60).coerceAtLeast(1),
                            appLock = kind == "blacklist" && item.opt("appLock") == true,
                        ),
                    )
                }
            }
        } catch (_: Exception) {
            emptyList()
        }
    }

    @Synchronized
    fun recordPendingTrigger(context: Context, rule: Rule, packageName: String, durationMs: Long, stage: Int, kind: String, now: Long): String {
        if (restorePaused) return ""
        val triggerId = "${rule.id}:${kind}:${now}"
        val payload = JSONObject()
            .put("triggerId", triggerId)
            .put("ruleId", rule.id)
            .put("appTitle", rule.title)
            .put("appSource", packageName)
            .put("durationMs", durationMs)
            .put("stage", stage)
            .put("kind", kind)
            .put("ruleKind", rule.kind)
            .put("createdAt", now)
            .put("triggeredAt", now)
            .put("overlayShownAt", now)
            .put("authorized", blacklistRules(context).any { it.id == rule.id && it.source == packageName })
            .put("overlayPermission", android.provider.Settings.canDrawOverlays(context))
            .put("attempts", 0)
            .put("status", "pending")
        val payloadText = payload.toString()
        val events = readTriggerEvents(context, now).put(payload)
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .remove(KEY_LAUNCH_REQUEST)
            .putString(KEY_PENDING_TRIGGER, events.toString())
            .commit().also { check(it) { "Could not save phone guard trigger" } }
        return payloadText
    }

    @Synchronized
    fun peekPendingTrigger(context: Context): String {
        val events = readTriggerEvents(context)
        for (index in 0 until events.length()) {
            val event = events.getJSONObject(index)
            if (event.optString("status", "pending") == "pending") return event.toString()
        }
        return ""
    }

    @Synchronized
    fun clearPendingTrigger(context: Context, triggerId: String): Boolean {
        return finishTrigger(context, triggerId, "cancelled")
    }

    @Synchronized
    fun consumePendingTrigger(context: Context): String {
        val payload = peekPendingTrigger(context)
        if (payload.isBlank()) return ""
        finishTrigger(context, JSONObject(payload).optString("triggerId"), "cancelled")
        return payload
    }

    // ponytail: one existing JSON value holds only events inside the 30-minute reply window.
    private fun readTriggerEvents(context: Context, now: Long = System.currentTimeMillis()): JSONArray {
        val raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_PENDING_TRIGGER, "").orEmpty()
        val old = runCatching {
            if (raw.trim().startsWith("[")) JSONArray(raw) else JSONArray().put(JSONObject(raw))
        }.getOrDefault(JSONArray())
        val events = JSONArray()
        for (index in 0 until old.length()) {
            val item = old.optJSONObject(index) ?: continue
            val at = item.optLong("createdAt")
            if (at > 0 && now - at in 0..PhoneFocusPolicy.TRIGGER_TTL_MS) events.put(item)
        }
        return events
    }

    @Synchronized
    fun getTriggerState(context: Context, triggerId: String): String? {
        val events = readTriggerEvents(context)
        for (index in 0 until events.length()) {
            val item = events.getJSONObject(index)
            if (item.optString("triggerId") == triggerId) return item.toString()
        }
        return null
    }

    @Synchronized
    fun claimTriggerAttempt(context: Context, triggerId: String): String? {
        val now = System.currentTimeMillis()
        var claimed: String? = null
        val saved = updateTrigger(context, triggerId) { item ->
            if (!PhoneFocusPolicy.canAttempt(item.optLong("createdAt"), item.optInt("attempts"), item.optString("status", "pending"), now)) return@updateTrigger false
            item.put("attempts", item.optInt("attempts") + 1).put("attemptStartedAt", now)
            claimed = item.toString()
            true
        }
        return if (saved) claimed else null
    }

    @Synchronized
    fun finishTrigger(context: Context, triggerId: String, status: String): Boolean {
        if (status !in setOf("succeeded", "failed", "disabled", "cancelled", "blocked")) return false
        return updateTrigger(context, triggerId) { item ->
            val previous = item.optString("status", "pending")
            if (previous != "pending" && previous != status) return@updateTrigger false
            item.put("status", status)
            true
        }
    }

    @Synchronized
    private fun updateTrigger(context: Context, triggerId: String, change: (JSONObject) -> Boolean): Boolean {
        if (restorePaused) return false
        val events = readTriggerEvents(context)
        for (index in 0 until events.length()) {
            val item = events.getJSONObject(index)
            if (item.optString("triggerId") != triggerId) continue
            if (!change(item)) return false
            return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putString(KEY_PENDING_TRIGGER, events.toString()).commit()
        }
        return false
    }

    @Synchronized
    fun recordReturned(context: Context, triggerId: String, now: Long) {
        // The button may have removed its view before the real activity becomes foreground.
        // Keep using that exact saved click, never treating the click itself as a return.
        var selected = triggerId
        if (selected.isBlank()) {
            val events = readTriggerEvents(context, now)
            var latestClicked: JSONObject? = null
            for (index in 0 until events.length()) {
                val item = events.getJSONObject(index)
                if (item.optLong("returnClickedAt") > (latestClicked?.optLong("returnClickedAt") ?: 0L)) latestClicked = item
            }
            val clicked = latestClicked ?: return
            if (clicked.optLong("returnedAt") > 0L || clicked.optLong("returnClickedAt") > now) return
            selected = clicked.optString("triggerId")
        }
        updateTrigger(context, selected) {
            if (it.optLong("returnedAt") <= 0L) it.put("returnedAt", now)
            true
        }
    }

    @Synchronized
    fun recordOverlayDeparture(context: Context, ruleId: String, foregroundStartedAt: Long, now: Long) {
        if (restorePaused) return
        // A button click in this foreground visit has already registered this exit.
        // Preserve it even if its timestamp is newer than a delayed departure event.
        if (foregroundStartedAt > 0L && savedReturnAt(context, ruleId) >= foregroundStartedAt) return
        recordOverlayExit(context, ruleId, now)
    }

    @Synchronized
    fun recordOverlayExit(context: Context, ruleId: String, now: Long) {
        if (restorePaused) return
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val previousRule = prefs.getString(KEY_RETURN_RULE, "").orEmpty()
        val previousAt = prefs.getLong(KEY_RETURN_AT, 0L)
        val editor = prefs.edit()
        // Preserve an older installed version's single pending return before
        // the compatibility keys move to another App.
        if (previousRule.isNotBlank() && previousRule != ruleId && previousAt > 0L) {
            editor.putLong(returnAtKey(previousRule), maxOf(previousAt, savedReturnAt(context, previousRule)))
        }
        editor
            .putLong(usageKey(ruleId), 0L)
            .putString(usageDateKey(ruleId), localDayKey(now))
            .putString(KEY_LAST_EXIT_RULE, ruleId)
            .putLong(KEY_LAST_EXIT_AT, now)
            .putString(KEY_RETURN_RULE, ruleId)
            .putLong(KEY_RETURN_AT, now)
            .putLong(returnAtKey(ruleId), now)
            .commit()
    }

    @Synchronized
    fun addAccumulatedUsage(context: Context, ruleId: String, durationMs: Long, now: Long): Long {
        if (restorePaused) return 0
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val dayKey = localDayKey(now)
        val current = PhoneFocusPolicy.currentDayValue(prefs.getLong(usageKey(ruleId), 0L), prefs.getString(usageDateKey(ruleId), "").orEmpty(), dayKey)
        if (durationMs <= 0L) return current
        val dailyCurrent = if (prefs.getString(dailyDateKey(ruleId), "") == dayKey) {
            prefs.getLong(dailyUsageKey(ruleId), 0L)
        } else {
            0L
        }
        val dailyDurationMs = PhoneFocusPolicy.addedToday(durationMs, now, startOfLocalDay(now))
        val next = if (savedReturnAt(context, ruleId) > 0L) current else current + dailyDurationMs
        prefs.edit()
            .putLong(usageKey(ruleId), next)
            .putString(usageDateKey(ruleId), dayKey)
            .putString(dailyDateKey(ruleId), dayKey)
            .putLong(dailyUsageKey(ruleId), dailyCurrent + dailyDurationMs)
            .commit()
        return next
    }

    @Synchronized
    fun accumulatedUsage(context: Context, ruleId: String, now: Long = System.currentTimeMillis()): Long {
        if (restorePaused) return 0
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val dayKey = localDayKey(now)
        if (prefs.getString(usageDateKey(ruleId), "") != dayKey) {
            prefs.edit().putLong(usageKey(ruleId), 0L).putString(usageDateKey(ruleId), dayKey).commit()
        }
        return prefs.getLong(usageKey(ruleId), 0L)
    }

    @Synchronized
    fun dailyAccumulatedUsage(context: Context, ruleId: String, now: Long): Long {
        if (restorePaused) return 0
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val dayKey = localDayKey(now)
        if (prefs.getString(dailyDateKey(ruleId), "") == dayKey) {
            return prefs.getLong(dailyUsageKey(ruleId), 0L)
        }
        prefs.edit()
            .putString(dailyDateKey(ruleId), dayKey)
            .putLong(dailyUsageKey(ruleId), 0L)
            .commit()
        return 0L
    }

    @Synchronized
    fun restrictionUsageCounters(context: Context, now: Long): JSONArray {
        check(!restorePaused)
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val dayKey = localDayKey(now)
        return JSONArray().also { array ->
            // The collector samples the first rule per package; expose that same saved counter.
            blacklistRules(context).distinctBy { it.source }.distinctBy { it.id }.forEach { rule ->
                array.put(JSONObject().put("ruleId", rule.id).put("packageName", rule.source)
                    .put("ordinaryUsedMs", PhoneFocusPolicy.currentDayValue(prefs.getLong(usageKey(rule.id), 0L),
                        prefs.getString(usageDateKey(rule.id), "").orEmpty(), dayKey))
                    .put("dailyUsedMs", PhoneFocusPolicy.currentDayValue(prefs.getLong(dailyUsageKey(rule.id), 0L),
                        prefs.getString(dailyDateKey(rule.id), "").orEmpty(), dayKey))
                    .put("ordinaryLimitMs", rule.thresholdMinutes * 60_000L)
                    .put("dailyLimitMs", rule.dailyLimitMinutes * 60_000L)
                    .put("mode", if (rule.kind == "jealousy") "jealousy" else if (rule.appLock) "lock" else "reminder")
                    .put("cooldown", PhoneFocusPolicy.returnEligible(savedReturnAt(context, rule.id) > 0L,
                        savedReturnAt(context, rule.id), rule.returnWindowMinutes * 60_000L, now))
                    .put("returnPending", savedReturnAt(context, rule.id) > 0L))
            }
        }
    }

    /** Capture source knowledge under the same settings lock as the counter observation. */
    @Synchronized
    fun restrictionUsageObservation(context: Context, now: Long): JSONObject {
        val raw = runCatching { context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(KEY_SETTINGS, null) }.getOrNull()
        val known = PhoneRestrictionQuery.legacyLockRuleIds(
            PhoneRestrictionQuery.savedObject(raw, !restorePaused)) != null
        return JSONObject().put("rules", restrictionUsageCounters(context, now)).put("rulesKnown", known)
    }

    @Synchronized
    fun savedReturnAt(context: Context, ruleId: String): Long {
        if (restorePaused) return 0L
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val scoped = prefs.getLong(returnAtKey(ruleId), 0L)
        val legacy = if (prefs.getString(KEY_RETURN_RULE, "") == ruleId) prefs.getLong(KEY_RETURN_AT, 0L) else 0L
        require(scoped >= 0L && legacy >= 0L)
        return maxOf(scoped, legacy)
    }

    private fun clearSavedReturn(context: Context, ruleId: String) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val editor = prefs.edit().remove(returnAtKey(ruleId))
        if (prefs.getString(KEY_RETURN_RULE, "") == ruleId) editor.remove(KEY_RETURN_RULE).remove(KEY_RETURN_AT)
        editor.apply()
    }

    @Synchronized
    fun pendingReturnAt(context: Context, rule: Rule, now: Long): Long? {
        if (restorePaused) return null
        val exitedAt = savedReturnAt(context, rule.id)
        if (exitedAt <= 0L) return null
        val returnWindowMs = rule.returnWindowMinutes * 60_000L
        if (!PhoneFocusPolicy.returnEligible(true, exitedAt, returnWindowMs, now)) {
            clearSavedReturn(context, rule.id)
            return null
        }
        return exitedAt
    }

    @Synchronized
    fun consumeReturnIfEligible(context: Context, rule: Rule, now: Long, expectedExitAt: Long? = null): Boolean {
        if (restorePaused) return false
        if (expectedExitAt != null && savedReturnAt(context, rule.id) != expectedExitAt) return false
        if (pendingReturnAt(context, rule, now) == null) return false
        clearSavedReturn(context, rule.id)
        return true
    }

    @Synchronized
    fun consumeOverlayExit(context: Context): JSONObject? {
        if (restorePaused) return null
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val ruleId = prefs.getString(KEY_LAST_EXIT_RULE, "") ?: ""
        val exitedAt = prefs.getLong(KEY_LAST_EXIT_AT, 0L)
        if (ruleId.isBlank() || exitedAt <= 0L) return null
        prefs.edit().remove(KEY_LAST_EXIT_RULE).remove(KEY_LAST_EXIT_AT).apply()
        return JSONObject().put("ruleId", ruleId).put("exitedAt", exitedAt)
    }

    @Synchronized
    fun recordLaunchRequest(context: Context, ruleId: String, triggerId: String, now: Long) {
        if (restorePaused) return
        updateTrigger(context, triggerId) { it.put("returnClickedAt", now); true }
        val payload = JSONObject()
            .put("targetScreen", "chat")
            .put("source", "phone-guard")
            .put("ruleId", ruleId)
            .put("triggerId", triggerId)
            .put("createdAt", now)
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_LAUNCH_REQUEST, payload.toString())
            .apply()
    }

    @Synchronized
    fun consumeLaunchRequest(context: Context): String {
        if (restorePaused) return ""
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val payload = prefs.getString(KEY_LAUNCH_REQUEST, "") ?: ""
        if (payload.isBlank()) return ""
        prefs.edit().remove(KEY_LAUNCH_REQUEST).apply()
        return payload
    }

    private fun usageKey(ruleId: String) = "$KEY_USAGE_PREFIX$ruleId"
    private fun usageDateKey(ruleId: String) = "$KEY_USAGE_DATE_PREFIX$ruleId"
    private fun dailyUsageKey(ruleId: String) = "$KEY_DAILY_USAGE_PREFIX$ruleId"
    private fun returnAtKey(ruleId: String) = "$KEY_RETURN_AT:$ruleId"
    private fun dailyDateKey(ruleId: String) = "$KEY_DAILY_DATE_PREFIX$ruleId"

    private fun localDayKey(now: Long): String {
        val calendar = Calendar.getInstance().apply { timeInMillis = now }
        return "${calendar.get(Calendar.YEAR)}-${calendar.get(Calendar.DAY_OF_YEAR)}"
    }

    private fun startOfLocalDay(now: Long): Long {
        return Calendar.getInstance().apply {
            timeInMillis = now
            set(Calendar.HOUR_OF_DAY, 0)
            set(Calendar.MINUTE, 0)
            set(Calendar.SECOND, 0)
            set(Calendar.MILLISECOND, 0)
        }.timeInMillis
    }
}
