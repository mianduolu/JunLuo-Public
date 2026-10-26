package com.anonymous.junluo

import android.content.Context
import org.json.JSONObject

// Shared by legacy reads and the guardian; no address, raw packet or authentication data.
internal object MiBand6BatteryStore {
    private fun preferences(context: Context) = context.getSharedPreferences(GUARDIAN_PREFS, Context.MODE_PRIVATE)
    private fun key(profileId: String) = "battery_refresh:$profileId"
    private fun load(context: Context, profileId: String): JSONObject = runCatching {
        JSONObject(preferences(context).getString(key(profileId), "{}") ?: "{}")
    }.getOrDefault(JSONObject())

    @Synchronized
    fun claim(context: Context, profileId: String, trigger: String, now: Long): String? {
        if (profileId.isBlank()) return "battery_profile_missing"
        val record = load(context, profileId)
        MiBand6BatteryProtocol.refreshError(trigger, now, record.optLong("lastAttempt"),
            record.optLong("lastAutomatic"), record.optLong("lastManualSuccess"))?.let { return it }
        record.put("lastAttempt", now)
        record.put("trigger", trigger)
        if (trigger != "manual") record.put("lastAutomatic", now)
        return if (preferences(context).edit().putString(key(profileId), record.toString()).commit()) null
            else "battery_save_failed"
    }

    @Synchronized
    fun matchesAttempt(context: Context, profileId: String, trigger: String, attemptedAt: Long): Boolean {
        val record = load(context, profileId)
        return attemptedAt > 0 && record.optLong("lastAttempt") == attemptedAt && record.optString("trigger") == trigger
    }

    @Synchronized
    fun complete(context: Context, profileId: String, trigger: String, value: MiBand6BatteryValue,
        measuredAt: Long): GuardianLedgerEvent? {
        val event = BodySignalGuardianLedger.recordBattery(context, profileId, value, measuredAt) ?: return null
        val record = load(context, profileId)
        if (trigger == "manual") record.put("lastManualSuccess", maxOf(measuredAt, record.optLong("lastManualSuccess")))
        preferences(context).edit().putString(key(profileId), record.toString()).commit()
        val state = BodySignalGuardianStore.load(context)
        if (state.enabled) restoreSaved(context, profileId, value.percent, measuredAt)
        return event
    }

    @Synchronized
    fun restoreSaved(context: Context, profileId: String, percent: Int, measuredAt: Long): Boolean {
        if (BodySignalGuardianStore.load(context).deviceProfileId != profileId || percent !in 0..100
            || measuredAt <= 0 || measuredAt > System.currentTimeMillis()) return false
        val previous = trusted(context, profileId)
        if (previous != null && measuredAt <= previous.second) return true
        return preferences(context).edit().putString("battery_policy_cache", JSONObject()
            .put("deviceProfileId", profileId).put("percent", percent).put("measuredAt", measuredAt).toString()).commit()
    }

    @Synchronized
    fun trusted(context: Context, profileId: String?): Pair<Int, Long>? {
        if (profileId == null) return null
        val record = runCatching { JSONObject(preferences(context).getString("battery_policy_cache", "{}") ?: "{}") }.getOrNull()
            ?: return null
        if (record.optString("deviceProfileId") != profileId) return null
        val percent = record.optInt("percent", -1)
        val measuredAt = record.optLong("measuredAt")
        return if (percent in 0..100 && measuredAt > 0) percent to measuredAt else null
    }

    @Synchronized
    fun clearCache(context: Context) {
        preferences(context).edit().remove("battery_policy_cache").commit()
    }
}
