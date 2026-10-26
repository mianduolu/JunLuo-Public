package com.anonymous.junluo

import android.content.Context
import org.json.JSONObject

/** One local slot in the existing guardian preferences, separate from phone care. */
internal object BodySignalCareStore {
    private const val KEY = "bodySignalCareState"
    private val lock = Any()

    fun get(context: Context): String? = synchronized(lock) {
        val preferences = context.getSharedPreferences(GUARDIAN_PREFS, Context.MODE_PRIVATE)
        val raw = preferences.getString(KEY, null) ?: return null
        val old = runCatching { JSONObject(raw) }.getOrNull() ?: return raw
        if (old.optInt("schemaVersion") != 1 || PhoneFocusRules.restorePaused) return raw
        val now = System.currentTimeMillis()
        val reset = old.optBoolean("resetForRestore")
        val upgraded = JSONObject().put("schemaVersion", 2)
            .put("revision", old.optLong("revision") + 1)
            .put("deviceProfileId", if (reset) "" else old.optString("deviceProfileId"))
            .put("eligibleSince", now).put("lastReadingId", "").put("lastMeasuredAt", now)
            .put("status", if (reset || old.optString("status") == "idle") "idle" else "active")
            .put("nextCheckAt", 0)
        if (reset) upgraded.put("resetForRestore", true)
        check(preferences.edit().putString(KEY, upgraded.toString()).commit())
        upgraded.toString()
    }

    fun compareAndSet(context: Context, expected: Long, raw: String): Boolean = synchronized(lock) {
        val next = runCatching { JSONObject(raw) }.getOrNull() ?: return false
        val previous = get(context)?.let { runCatching { JSONObject(it) }.getOrNull() }
        if (next.optInt("schemaVersion") != 2 || !BodySignalCarePolicy.acceptsRevision(
                previous?.optLong("revision") ?: 0, expected, next.optLong("revision"),
                PhoneFocusRules.restorePaused,
            )) return false
        context.getSharedPreferences(GUARDIAN_PREFS, Context.MODE_PRIVATE).edit()
            .putString(KEY, raw).commit()
    }

    fun nextCheckAt(context: Context): Long? {
        val slot = get(context)?.let { runCatching { JSONObject(it) }.getOrNull() } ?: return null
        return BodySignalCarePolicy.deadline(slot.optString("status"), slot.optLong("nextCheckAt"),
            PhoneFocusRules.restorePaused, PhoneGuardMessageTaskService.isBodyCareDispatchRunning())
    }

    fun resetForRestore(context: Context): Boolean = synchronized(lock) {
        val previous = get(context)?.let { runCatching { JSONObject(it) }.getOrNull() }
        // Keep a monotonically advancing revision so a pre-restore writer cannot recreate its task.
        val reset = JSONObject().put("schemaVersion", 2)
            .put("revision", (previous?.optLong("revision") ?: 0) + 1)
            .put("status", "idle").put("nextCheckAt", 0).put("resetForRestore", true)
        context.getSharedPreferences(GUARDIAN_PREFS, Context.MODE_PRIVATE).edit()
            .putString(KEY, reset.toString()).commit()
    }
}
