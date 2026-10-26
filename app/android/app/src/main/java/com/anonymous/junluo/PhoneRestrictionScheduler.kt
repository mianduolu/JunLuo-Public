package com.anonymous.junluo

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import org.json.JSONObject

/** One native boundary alarm; its receiver reloads the authoritative state. */
object PhoneRestrictionScheduler {
    const val ACTION = "com.anonymous.junluo.action.RESTRICTION_BOUNDARY"
    private var appContext: Context? = null
    private var scheduledAt: Long? = null
    private var mode = "none"
    private var reason: String? = null
    private var requestedExact: Boolean? = null
    private fun pending(context: Context) = PendingIntent.getBroadcast(context, 9249,
        Intent(context, PhoneRestrictionAlarmReceiver::class.java).setAction(ACTION),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

    @Synchronized fun schedule(context: Context, at: Long?) {
        appContext = context.applicationContext
        val manager = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager
        if (manager == null) {
            scheduledAt = at; mode = if (at == null) "none" else "failed"
            reason = if (at == null) null else "ALARM_SERVICE_UNAVAILABLE"
            requestedExact = null
            return
        }
        val exact = Build.VERSION.SDK_INT < 31 || manager.canScheduleExactAlarms()
        val nextMode = if (at == null) "none" else if (exact) "exact" else "inexact"
        if (at == scheduledAt && (mode == nextMode ||
            (mode == "inexact" && reason == "EXACT_ALARM_UNAVAILABLE" && requestedExact == exact))) return
        manager.cancel(pending(context))
        scheduledAt = at
        reason = null
        mode = nextMode
        requestedExact = exact
        if (at == null) return
        try {
            if (exact) manager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pending(context))
            else {
                manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pending(context))
                reason = "EXACT_ALARM_UNAVAILABLE"
            }
        } catch (_: SecurityException) {
            runCatching { manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pending(context)) }
                .onSuccess { mode = "inexact"; reason = "EXACT_ALARM_UNAVAILABLE" }
                .onFailure { mode = "failed"; reason = "ALARM_SCHEDULE_FAILED" }
        } catch (_: Exception) {
            mode = "failed"; reason = "ALARM_SCHEDULE_FAILED"
        }
    }
    @Synchronized fun cancel(context: Context? = null) {
        (context ?: appContext)?.let { schedule(it, null) }
    }
    @Synchronized fun delivered() { scheduledAt = null; mode = "none"; reason = null; requestedExact = null }
    @Synchronized fun dispatchFailed() { reason = "COLLECTOR_START_FAILED" }
    fun executionNeeds(context: Context): JSONObject {
        val needs = PhoneRestrictionRuntime.executionNeeds(context)
        val legacy = PhoneFocusRules.collectorRequired(context)
        return needs.put("collector", legacy || needs.getBoolean("collector"))
            .put("usageAccess", legacy || needs.getBoolean("usageAccess"))
            .put("overlay", needs.getBoolean("overlay") || PhoneFocusRules.blacklistRules(context).isNotEmpty())
    }

    fun recover(context: Context) {
        if (PhoneFocusRules.restorePaused) return
        PhoneRestrictionRuntime.reconcilePlans(context)
        PhoneRestrictionRuntime.observeEmergencyEnd(context)
        refreshCollector(context)
    }

    /** A settings save may stop legacy collection only when no new executor still needs it. */
    fun reconcileCollectorRequirement(context: Context): Boolean {
        if (PhoneFocusRules.restorePaused) return false
        recover(context)
        if (executionNeeds(context).getBoolean("collector")) return true
        context.stopService(Intent(context, PhoneActivityCollectorService::class.java))
        return true
    }

    fun refreshCollector(context: Context) {
        if (PhoneFocusRules.restorePaused || PhoneActivityCollectorService.requestRestrictionRefresh()) return
        if (!executionNeeds(context).getBoolean("collector")) return
        val service = Intent(context, PhoneActivityCollectorService::class.java)
            .setAction(PhoneActivityCollectorService.ACTION_RESTRICTION_TICK)
        if (!PhoneActivityCollectorService.requestStart(context, service)) dispatchFailed()
    }
    @Synchronized fun status() = JSONObject().put("mode", mode).put("at", scheduledAt ?: JSONObject.NULL)
        .put("reason", reason ?: JSONObject.NULL)
}

class PhoneRestrictionAlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        val action = intent?.action ?: return
        val accepted = setOf(PhoneRestrictionScheduler.ACTION, Intent.ACTION_BOOT_COMPLETED,
            Intent.ACTION_MY_PACKAGE_REPLACED, Intent.ACTION_TIME_CHANGED, Intent.ACTION_TIMEZONE_CHANGED,
            AlarmManager.ACTION_SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED)
        if (action !in accepted) return
        if (action == PhoneRestrictionScheduler.ACTION || action == AlarmManager.ACTION_SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED)
            PhoneRestrictionScheduler.delivered()
        val result = goAsync()
        Thread {
            try {
                // A failed state read remains unknown to the technical status bridge.
                runCatching { PhoneRestrictionScheduler.recover(context) }
            } finally { result.finish() }
        }.start()
    }
}
