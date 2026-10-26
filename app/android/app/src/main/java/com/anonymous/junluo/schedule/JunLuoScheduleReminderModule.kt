package com.anonymous.junluo.schedule

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.uimanager.ViewManager
import org.json.JSONObject

class JunLuoScheduleReminderPackage : ReactPackage {
    override fun createNativeModules(context: ReactApplicationContext): List<NativeModule> =
        listOf(JunLuoScheduleReminderModule(context))
    override fun createViewManagers(context: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
}

class JunLuoScheduleReminderModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
    override fun getName() = "JunLuoScheduleReminder"

    @ReactMethod
    fun replaceTasks(tasks: ReadableArray, promise: Promise) {
        try {
            val times = mutableMapOf<String, ScheduleReminderWakeTask>()
            for (index in 0 until tasks.size()) {
                val task = tasks.getMap(index) ?: continue
                val eventId = task.getString("eventId") ?: continue
                val time = task.getDouble("scheduledAt")
                val ahead = if (task.hasKey("prepareAheadMs") && !task.isNull("prepareAheadMs"))
                    task.getDouble("prepareAheadMs") else 60_000.0
                require(ahead.isFinite() && ahead >= 0 && ahead <= Long.MAX_VALUE.toDouble()) {
                    "Invalid reminder preparation offset"
                }
                if (eventId.isNotBlank() && time.isFinite() && time > 0)
                    times[eventId] = ScheduleReminderWakeTask(time.toLong(), ahead.toLong())
            }
            promise.resolve(ScheduleReminderAlarms.replace(reactApplicationContext, times))
        } catch (error: Exception) {
            promise.reject("schedule_alarm_failed", error)
        }
    }

    @ReactMethod
    fun cancelTask(eventId: String, promise: Promise) {
        try {
            ScheduleReminderAlarms.cancel(reactApplicationContext, eventId)
            promise.resolve(null)
        } catch (error: Exception) {
            promise.reject("schedule_alarm_cancel_failed", error)
        }
    }
}

internal data class ScheduleReminderWakeTask(val scheduledAt: Long, val prepareAheadMs: Long = 60_000L)

internal object ScheduleReminderAlarms {
    private val phases = mapOf("prepare" to -60_000L, "deliver" to 0L, "deadline" to 30_000L)
    private fun prefs(context: Context) = context.getSharedPreferences("junluo_schedule_reminder_tasks", Context.MODE_PRIVATE)
    private fun alarm(context: Context) = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
    private fun read(context: Context, eventId: String): JSONObject? =
        prefs(context).getString(eventId, null)?.let { JSONObject(it) }

    private fun pending(context: Context, eventId: String, time: Long, phase: String,
        prepareAheadMs: Long = 60_000L): PendingIntent =
        PendingIntent.getBroadcast(context, 0,
            Intent(context, JunLuoScheduleReminderReceiver::class.java).apply {
                data = Uri.Builder().scheme("junluo-schedule").authority("reminder")
                    .appendPath(eventId).appendPath(phase).build()
                putExtra("eventId", eventId)
                putExtra("scheduledAt", time)
                putExtra("phase", phase)
                putExtra("prepareAheadMs", prepareAheadMs)
            }, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

    @Synchronized
    fun replace(context: Context, tasks: Map<String, ScheduleReminderWakeTask>): Boolean {
        val now = System.currentTimeMillis()
        val upcoming = tasks.filterValues { it.scheduledAt + 30_000L > now }
        prefs(context).all.keys.filter { it !in upcoming }.forEach { cancel(context, it) }
        val alarm = alarm(context)
        val canSchedule = Build.VERSION.SDK_INT < Build.VERSION_CODES.S || alarm.canScheduleExactAlarms()
        for ((eventId, task) in upcoming) {
            val time = task.scheduledAt
            var record = read(context, eventId)
            if (record == null || record.optLong("scheduledAt") != time) {
                cancel(context, eventId)
                record = JSONObject().put("scheduledAt", time).put("prepareAheadMs", task.prepareAheadMs)
                prefs(context).edit().putString(eventId, record.toString()).apply()
            } else if (record.optLong("prepareAheadMs", 60_000L) != task.prepareAheadMs) {
                record.put("prepareAheadMs", task.prepareAheadMs)
                prefs(context).edit().putString(eventId, record.toString()).apply()
            }
            if (!canSchedule) continue
            for ((phase, legacyOffset) in phases) {
                if (record.optBoolean(phase)) continue
                val offset = if (phase == "prepare") -task.prepareAheadMs else legacyOffset
                alarm.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP,
                    maxOf(now, time + offset), pending(context, eventId, time, phase, task.prepareAheadMs))
            }
        }
        return canSchedule
    }

    @Synchronized
    fun cancel(context: Context, eventId: String) {
        for (phase in phases.keys) {
            val pending = pending(context, eventId, 0, phase)
            alarm(context).cancel(pending)
            pending.cancel()
        }
        prefs(context).edit().remove(eventId).apply()
    }

    @Synchronized
    fun take(context: Context, eventId: String, time: Long, phase: String,
        prepareAheadMs: Long = 60_000L): Boolean {
        if (phase !in phases) return false
        val record = read(context, eventId) ?: return false
        if (record.optLong("scheduledAt") != time || record.optBoolean(phase)) return false
        if (record.optLong("prepareAheadMs", 60_000L) != prepareAheadMs) return false
        if (phase != "deadline" && System.currentTimeMillis() > time + 30_000L) return false
        if (phase == "deadline") {
            prefs(context).edit().remove(eventId).apply()
        } else {
            record.put(phase, true)
            prefs(context).edit().putString(eventId, record.toString()).apply()
        }
        return true
    }

    @Synchronized
    fun restore(context: Context) {
        val tasks = prefs(context).all.keys.associateWith {
            val record = read(context, it)
            ScheduleReminderWakeTask(record?.optLong("scheduledAt") ?: 0L,
                record?.optLong("prepareAheadMs", 60_000L) ?: 60_000L)
        }
        replace(context, tasks)
    }
}
