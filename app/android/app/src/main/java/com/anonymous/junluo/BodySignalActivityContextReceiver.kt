package com.anonymous.junluo

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Settings
import android.util.Log
import com.google.android.gms.location.ActivityRecognitionResult
import com.google.android.gms.location.ActivityTransition
import com.google.android.gms.location.ActivityTransitionResult
import com.google.android.gms.location.DetectedActivity
import org.json.JSONArray
import org.json.JSONObject

class BodySignalActivityContextReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val receivedAt = System.currentTimeMillis()
        if (intent.action == FALLBACK_ACTION) {
            receiveActivityFallback(context, intent, prefs, receivedAt)
            return
        }
        receiveActivityTransitions(context, intent, prefs, receivedAt)
    }

    fun recordStepActivity(context: Context, activity: String, observedAt: Long) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val bootCount = currentBootCount(context)
        val stateBoot = prefs.getInt(LAST_FALLBACK_BOOT, Int.MIN_VALUE)
        val previous = if (stateBoot == bootCount) prefs.getString(LAST_FALLBACK_ACTIVITY, null) else null
        if (previous == activity) {
            prefs.edit()
                .putLong(LAST_OBSERVATION_AT, observedAt)
                .putInt(LAST_CONFIDENCE, 100)
                .commit()
            return
        }

        val ledger = runCatching { JSONArray(prefs.getString(LEDGER, "[]")) }.getOrElse { JSONArray() }
        if (previous != null) appendEvent(ledger, bootCount, previous, "exit", observedAt, "step-detector")
        appendEvent(ledger, bootCount, activity, "enter", observedAt, "step-detector")
        prefs.edit()
            .putString(LEDGER, trimLedger(ledger).toString())
            .putLong(LAST_EVENT_AT, observedAt)
            .putLong(LAST_OBSERVATION_AT, observedAt)
            .putLong(LAST_FALLBACK_EVENT_AT, observedAt)
            .putInt(LAST_CONFIDENCE, 100)
            .putInt(LAST_EVENT_COUNT, if (previous == null) 1 else 2)
            .putInt(LAST_FALLBACK_BOOT, bootCount)
            .putString(LAST_FALLBACK_ACTIVITY, activity)
            .putString(LAST_ACTIVITY, activity)
            .putString(LAST_TRANSITION, "enter")
            .apply {
                if (activity == "walking") putLong(LAST_STEP_AT, observedAt)
            }
            .remove(LAST_ERROR_CODE)
            .commit()
        Log.i(TAG, "Step detector activity accepted: $activity")
        BodySignalActivityContextModule.emitLedgerChanged(context)
    }

    private fun receiveActivityTransitions(
        context: Context,
        intent: Intent,
        prefs: android.content.SharedPreferences,
        receivedAt: Long,
    ) {
        val result = runCatching { ActivityTransitionResult.extractResult(intent) }.getOrNull()
        if (result == null) {
            prefs.edit()
                .putLong(LAST_RECEIVER_AT, receivedAt)
                .putBoolean(LAST_RESULT_PRESENT, false)
                .putInt(LAST_EVENT_COUNT, 0)
                .putString(LAST_ERROR_CODE, "missing_transition_result")
                .commit()
            Log.w(TAG, "Activity transition broadcast had no transition result")
            return
        }
        val ledger = runCatching { JSONArray(prefs.getString(LEDGER, "[]")) }.getOrElse { JSONArray() }
        val bootCount = runCatching {
            Settings.Global.getInt(context.contentResolver, Settings.Global.BOOT_COUNT)
        }.getOrDefault(-1)
        var acceptedEventCount = 0
        var lastActivity: String? = null
        var lastTransition: String? = null
        result.transitionEvents.forEach { event ->
            val activity = activityName(event.activityType) ?: return@forEach
            val transition = when (event.transitionType) {
                ActivityTransition.ACTIVITY_TRANSITION_ENTER -> "enter"
                ActivityTransition.ACTIVITY_TRANSITION_EXIT -> "exit"
                else -> return@forEach
            }
            if (activity == "still" && transition == "enter" && hasRecentStep(prefs, receivedAt)) {
                return@forEach
            }
            val observedAt = System.currentTimeMillis()
            ledger.put(JSONObject().apply {
                put("eventId", "activity:$bootCount:$observedAt:${event.elapsedRealTimeNanos}")
                put("activity", activity)
                put("transition", transition)
                put("observedAt", observedAt)
                put("bootCount", bootCount)
            })
            acceptedEventCount += 1
            lastActivity = activity
            lastTransition = transition
            updateFallbackStateFromTransition(prefs, bootCount, activity, transition, observedAt)
            Log.i(TAG, "Activity transition received: $activity/$transition")
        }
        val trimmed = JSONArray()
        val first = maxOf(0, ledger.length() - MAX_EVENTS)
        for (index in first until ledger.length()) trimmed.put(ledger.getJSONObject(index))
        prefs.edit()
            .putString(LEDGER, trimmed.toString())
            .putLong(LAST_RECEIVER_AT, receivedAt)
            .putBoolean(LAST_RESULT_PRESENT, true)
            .putInt(LAST_EVENT_COUNT, acceptedEventCount)
            .apply {
                if (lastActivity != null && lastTransition != null) {
                    putString(LAST_ACTIVITY, lastActivity)
                    putString(LAST_TRANSITION, lastTransition)
                    putLong(LAST_EVENT_AT, receivedAt)
                }
                if (acceptedEventCount > 0) remove(LAST_ERROR_CODE)
                else putString(LAST_ERROR_CODE, "no_supported_transition")
            }
            .commit()
        if (acceptedEventCount > 0) BodySignalActivityContextModule.emitLedgerChanged(context)
    }

    private fun receiveActivityFallback(
        context: Context,
        intent: Intent,
        prefs: android.content.SharedPreferences,
        receivedAt: Long,
    ) {
        val result = runCatching { ActivityRecognitionResult.extractResult(intent) }.getOrNull()
        val detected = result?.mostProbableActivity
        val activity = detected?.let { activityName(it.type) }
        if (detected == null || activity == null || detected.confidence < MIN_FALLBACK_CONFIDENCE) {
            prefs.edit()
                .putLong(LAST_RECEIVER_AT, receivedAt)
                .putBoolean(LAST_RESULT_PRESENT, result != null)
                .putInt(LAST_EVENT_COUNT, 0)
                .apply {
                    if (detected != null) putInt(LAST_CONFIDENCE, detected.confidence)
                    putString(
                        LAST_ERROR_CODE,
                        when {
                            result == null -> "missing_activity_result"
                            activity == null -> "unsupported_activity"
                            else -> "low_activity_confidence"
                        },
                    )
                }
                .commit()
            return
        }
        if (activity == "still" && hasRecentStep(prefs, receivedAt)) {
            prefs.edit()
                .putLong(LAST_RECEIVER_AT, receivedAt)
                .putBoolean(LAST_RESULT_PRESENT, true)
                .putInt(LAST_EVENT_COUNT, 0)
                .putInt(LAST_CONFIDENCE, detected.confidence)
                .remove(LAST_ERROR_CODE)
                .commit()
            return
        }

        val bootCount = currentBootCount(context)
        val stateBoot = prefs.getInt(LAST_FALLBACK_BOOT, Int.MIN_VALUE)
        val previous = if (stateBoot == bootCount) prefs.getString(LAST_FALLBACK_ACTIVITY, null) else null
        val lastFallbackEventAt = if (stateBoot == bootCount) prefs.getLong(LAST_FALLBACK_EVENT_AT, 0L) else 0L
        val ledger = runCatching { JSONArray(prefs.getString(LEDGER, "[]")) }.getOrElse { JSONArray() }
        var acceptedEventCount = 0

        if (previous != activity) {
            if (previous != null) {
                appendEvent(ledger, bootCount, previous, "exit", receivedAt, "fallback")
                acceptedEventCount += 1
            }
            appendEvent(ledger, bootCount, activity, "enter", receivedAt, "fallback")
            acceptedEventCount += 1
        } else if (receivedAt - lastFallbackEventAt >= FALLBACK_HEARTBEAT_MS) {
            appendEvent(ledger, bootCount, activity, "enter", receivedAt, "fallback-heartbeat")
            acceptedEventCount += 1
        }

        val trimmed = trimLedger(ledger)
        prefs.edit()
            .putString(LEDGER, trimmed.toString())
            .putLong(LAST_RECEIVER_AT, receivedAt)
            .putLong(LAST_OBSERVATION_AT, receivedAt)
            .putInt(LAST_CONFIDENCE, detected.confidence)
            .putBoolean(LAST_RESULT_PRESENT, true)
            .putInt(LAST_EVENT_COUNT, acceptedEventCount)
            .putInt(LAST_FALLBACK_BOOT, bootCount)
            .putString(LAST_FALLBACK_ACTIVITY, activity)
            .apply {
                if (acceptedEventCount > 0) {
                    putLong(LAST_EVENT_AT, receivedAt)
                    putLong(LAST_FALLBACK_EVENT_AT, receivedAt)
                    putString(LAST_ACTIVITY, activity)
                    putString(LAST_TRANSITION, "enter")
                }
                remove(LAST_ERROR_CODE)
            }
            .commit()
        if (acceptedEventCount > 0) {
            Log.i(TAG, "Activity fallback accepted: $activity/${detected.confidence}")
            BodySignalActivityContextModule.emitLedgerChanged(context)
        }
    }

    private fun updateFallbackStateFromTransition(
        prefs: android.content.SharedPreferences,
        bootCount: Int,
        activity: String,
        transition: String,
        observedAt: Long,
    ) {
        val editor = prefs.edit().putInt(LAST_FALLBACK_BOOT, bootCount)
        if (transition == "enter") {
            editor.putString(LAST_FALLBACK_ACTIVITY, activity)
                .putLong(LAST_FALLBACK_EVENT_AT, observedAt)
        } else if (prefs.getString(LAST_FALLBACK_ACTIVITY, null) == activity) {
            editor.remove(LAST_FALLBACK_ACTIVITY)
                .putLong(LAST_FALLBACK_EVENT_AT, observedAt)
        }
        editor.apply()
    }

    private fun appendEvent(
        ledger: JSONArray,
        bootCount: Int,
        activity: String,
        transition: String,
        observedAt: Long,
        source: String,
    ) {
        ledger.put(JSONObject().apply {
            put("eventId", "activity:$bootCount:$observedAt:$source:$activity:$transition")
            put("activity", activity)
            put("transition", transition)
            put("observedAt", observedAt)
            put("bootCount", bootCount)
        })
    }

    private fun trimLedger(ledger: JSONArray): JSONArray {
        val trimmed = JSONArray()
        val first = maxOf(0, ledger.length() - MAX_EVENTS)
        for (index in first until ledger.length()) trimmed.put(ledger.getJSONObject(index))
        return trimmed
    }

    private fun currentBootCount(context: Context): Int = runCatching {
        Settings.Global.getInt(context.contentResolver, Settings.Global.BOOT_COUNT)
    }.getOrDefault(-1)

    private fun hasRecentStep(prefs: android.content.SharedPreferences, now: Long): Boolean {
        val lastStepAt = prefs.getLong(LAST_STEP_AT, 0L)
        return BodySignalStepActivityFallback.hasRecentStep(now)
            || (lastStepAt > 0L && now - lastStepAt < STEP_ACTIVITY_HOLD_MS)
    }

    private fun activityName(type: Int): String? = when (type) {
        DetectedActivity.STILL -> "still"
        DetectedActivity.WALKING -> "walking"
        DetectedActivity.ON_FOOT -> "walking"
        DetectedActivity.RUNNING -> "running"
        DetectedActivity.ON_BICYCLE -> "on_bicycle"
        DetectedActivity.IN_VEHICLE -> "in_vehicle"
        else -> null
    }

    companion object {
        const val ACTION = "com.anonymous.junluo.BODY_SIGNAL_ACTIVITY_TRANSITION"
        const val FALLBACK_ACTION = "com.anonymous.junluo.BODY_SIGNAL_ACTIVITY_FALLBACK"
        const val LEDGER = "ledger"
        const val LAST_ACTIVITY = "last_activity"
        const val LAST_CONFIDENCE = "last_confidence"
        const val LAST_ERROR_CODE = "last_error_code"
        const val LAST_EVENT_AT = "last_event_at"
        const val LAST_EVENT_COUNT = "last_event_count"
        const val LAST_OBSERVATION_AT = "last_observation_at"
        const val LAST_RECEIVER_AT = "last_receiver_at"
        const val LAST_RESULT_PRESENT = "last_result_present"
        const val LAST_STEP_AT = "last_step_at"
        const val LAST_TRANSITION = "last_transition"
        const val MAX_EVENTS = 512
        const val PREFS = "body_signal_activity_context"
        private const val FALLBACK_HEARTBEAT_MS = 5 * 60_000L
        private const val LAST_FALLBACK_ACTIVITY = "last_fallback_activity"
        private const val LAST_FALLBACK_BOOT = "last_fallback_boot"
        private const val LAST_FALLBACK_EVENT_AT = "last_fallback_event_at"
        private const val MIN_FALLBACK_CONFIDENCE = 50
        private const val STEP_ACTIVITY_HOLD_MS = 2 * 60_000L
        private const val TAG = "BodySignalActivity"
    }
}
