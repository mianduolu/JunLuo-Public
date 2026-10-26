package com.anonymous.junluo.sleep

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.content.ContextCompat
import com.facebook.react.HeadlessJsTaskService

class JunLuoSleepScheduleReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        try {
            if (intent.action in setOf(Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED,
                    Intent.ACTION_TIME_CHANGED, Intent.ACTION_TIMEZONE_CHANGED,
                    "android.app.action.SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED")) {
                SleepScheduleAlarms.restore(context)
                return
            }
            val id = intent.getStringExtra("id") ?: return
            val at = intent.getLongExtra("at", 0L)
            val nightKey = intent.getStringExtra("nightKey") ?: return
            val phase = intent.getStringExtra("phase") ?: return
            if (!SleepScheduleAlarms.take(context, id, at, nightKey, phase)) return
            ContextCompat.startForegroundService(context,
                Intent(context, JunLuoSleepScheduleTaskService::class.java).apply {
                    putExtra("id", id)
                    putExtra("at", at)
                    putExtra("nightKey", nightKey)
                    putExtra("phase", phase)
                })
            HeadlessJsTaskService.acquireWakeLockNow(context)
        } catch (error: Exception) {
            Log.e("JunLuoSleepSchedule", "Could not start sleep schedule task", error)
        }
    }
}
