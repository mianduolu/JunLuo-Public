package com.anonymous.junluo.sleep

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

class JunLuoSleepSchedulePackage : ReactPackage {
    override fun createNativeModules(context: ReactApplicationContext): List<NativeModule> =
        listOf(JunLuoSleepScheduleModule(context))
    override fun createViewManagers(context: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
}

class JunLuoSleepScheduleModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
    override fun getName() = "JunLuoSleepSchedule"

    @ReactMethod
    fun replaceTasks(tasks: ReadableArray, promise: Promise) {
        try {
            val records = mutableMapOf<String, JSONObject>()
            for (index in 0 until tasks.size()) {
                val task = tasks.getMap(index) ?: continue
                val id = task.getString("id") ?: continue
                val nightKey = task.getString("nightKey") ?: continue
                val phase = task.getString("phase") ?: continue
                val at = task.getDouble("at")
                if (id.isBlank() || nightKey.isBlank() || !at.isFinite() || at <= 0 ||
                    phase !in setOf("prepare", "prepare_retry", "sleep", "wake", "contact", "sleep_status", "unified_contact", "reading", "day_plan", "activity_start")) continue
                records[id] = JSONObject().put("at", at.toLong())
                    .put("nightKey", nightKey).put("phase", phase)
            }
            promise.resolve(SleepScheduleAlarms.replace(reactApplicationContext, records))
        } catch (error: Exception) {
            promise.reject("sleep_alarm_failed", error)
        }
    }
}

internal object SleepScheduleAlarms {
    private fun prefs(context: Context) = context.getSharedPreferences("junluo_sleep_schedule_tasks", Context.MODE_PRIVATE)
    private fun alarm(context: Context) = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
    private fun read(context: Context, id: String): JSONObject? =
        prefs(context).getString(id, null)?.let { JSONObject(it) }

    private fun pending(context: Context, id: String, record: JSONObject): PendingIntent =
        PendingIntent.getBroadcast(context, 0,
            Intent(context, JunLuoSleepScheduleReceiver::class.java).apply {
                data = Uri.Builder().scheme("junluo-sleep").authority("schedule").appendPath(id).build()
                putExtra("id", id)
                putExtra("at", record.optLong("at"))
                putExtra("nightKey", record.optString("nightKey"))
                putExtra("phase", record.optString("phase"))
            }, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

    private fun sameTask(left: JSONObject, right: JSONObject): Boolean =
        left.optLong("at") == right.optLong("at") &&
            left.optString("nightKey") == right.optString("nightKey") &&
            left.optString("phase") == right.optString("phase")

    @Synchronized
    fun replace(context: Context, tasks: Map<String, JSONObject>): Boolean {
        prefs(context).all.keys.filter { it !in tasks }.forEach { cancel(context, it) }
        val alarm = alarm(context)
        val canSchedule = Build.VERSION.SDK_INT < Build.VERSION_CODES.S || alarm.canScheduleExactAlarms()
        for ((id, task) in tasks) {
            var record = read(context, id)
            if (record == null || !sameTask(record, task)) {
                cancel(context, id)
                record = task
                prefs(context).edit().putString(id, record.toString()).apply()
            }
            if (canSchedule && !record.optBoolean("consumed")) {
                alarm.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP,
                    maxOf(System.currentTimeMillis(), record.optLong("at")), pending(context, id, record))
            }
        }
        return canSchedule
    }

    private fun cancel(context: Context, id: String) {
        val pending = pending(context, id, JSONObject())
        alarm(context).cancel(pending)
        pending.cancel()
        prefs(context).edit().remove(id).apply()
    }

    @Synchronized
    fun take(context: Context, id: String, at: Long, nightKey: String, phase: String): Boolean {
        val record = read(context, id) ?: return false
        if (record.optBoolean("consumed") || record.optLong("at") != at ||
            record.optString("nightKey") != nightKey || record.optString("phase") != phase) return false
        record.put("consumed", true)
        prefs(context).edit().putString(id, record.toString()).apply()
        return true
    }

    @Synchronized
    fun restore(context: Context) {
        val now = System.currentTimeMillis()
        val records = prefs(context).all.keys.mapNotNull { id -> read(context, id)?.let {
            if (shouldRestore(it.optString("phase"), it.optLong("at"), now)) id to it else null
        } }.toMap()
        replace(context, records)
    }

    internal fun shouldRestore(phase: String, at: Long, now: Long): Boolean = phase != "wake" || at >= now
}
