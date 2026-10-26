package com.anonymous.junluo.schedule

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.content.ContextCompat
import com.facebook.react.HeadlessJsTaskService

class JunLuoScheduleReminderReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        try {
            if (intent.action == Intent.ACTION_BOOT_COMPLETED ||
                intent.action == Intent.ACTION_MY_PACKAGE_REPLACED ||
                intent.action == "android.app.action.SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED") {
                ScheduleReminderAlarms.restore(context)
                return
            }
            val eventId = intent.getStringExtra("eventId") ?: return
            val time = intent.getLongExtra("scheduledAt", 0L)
            val phase = intent.getStringExtra("phase") ?: return
            val prepareAheadMs = intent.getLongExtra("prepareAheadMs", 60_000L)
            if (!ScheduleReminderAlarms.take(context, eventId, time, phase, prepareAheadMs)) return
            ContextCompat.startForegroundService(context,
                Intent(context, JunLuoScheduleReminderTaskService::class.java).apply {
                    putExtra("eventId", eventId)
                    putExtra("scheduledAt", time)
                    putExtra("phase", phase)
                    putExtra("prepareAheadMs", prepareAheadMs)
                })
            HeadlessJsTaskService.acquireWakeLockNow(context)
        } catch (error: Exception) {
            Log.e("JunLuoScheduleReminder", "Could not start schedule reminder task", error)
        }
    }
}
