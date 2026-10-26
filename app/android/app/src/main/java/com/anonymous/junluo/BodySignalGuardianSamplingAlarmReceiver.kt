package com.anonymous.junluo

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.SystemClock

internal object BodySignalGuardianSamplingAlarm {
    private const val REQUEST_CODE = 9329
    private const val WINDOW_MS = 10L * 60L * 1000L
    private const val ACTION = "com.anonymous.junluo.guardian.SAMPLING_ALARM"

    fun schedule(context: Context, dueAt: Long) {
        val elapsedAt = SystemClock.elapsedRealtime() + (dueAt - System.currentTimeMillis()).coerceAtLeast(1_000L)
        context.getSystemService(AlarmManager::class.java).setWindow(
            AlarmManager.ELAPSED_REALTIME_WAKEUP,
            elapsedAt,
            WINDOW_MS,
            pendingIntent(context),
        )
    }

    fun cancel(context: Context) {
        context.getSystemService(AlarmManager::class.java).cancel(pendingIntent(context))
    }

    private fun pendingIntent(context: Context): PendingIntent = PendingIntent.getBroadcast(
        context,
        REQUEST_CODE,
        Intent(context, BodySignalGuardianSamplingAlarmReceiver::class.java).setAction(ACTION),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
}

class BodySignalGuardianSamplingAlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        if (PhoneFocusRules.restorePaused) return
        val now = System.currentTimeMillis()
        PhoneGuardMessageTaskService.checkBodySignalCare(context, now)
        val state = BodySignalGuardianStore.load(context)
        if (state.scheduledSamplingEnabled && (state.nextSamplingDueAt == null || state.nextSamplingDueAt <= now)) {
            BodySignalGuardianController.start(context, BodySignalGuardianController.ACTION_SCHEDULE_EVALUATE) {
                putExtra(BodySignalGuardianController.EXTRA_SAMPLING_TRIGGER, ScheduledSamplingTrigger.ALARM.wireValue)
            }
        } else {
            BodySignalGuardianService.refreshCareWake(context)
        }
    }
}
