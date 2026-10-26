package com.anonymous.junluo.schedule

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import com.anonymous.junluo.R
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig

class JunLuoScheduleReminderTaskService : HeadlessJsTaskService() {
    override fun onCreate() {
        super.onCreate()
        val manager = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(NotificationChannel(
                CHANNEL_ID, "君落日程处理", NotificationManager.IMPORTANCE_LOW))
        }
        startForeground(47021, NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("君落")
            .setContentText("正在处理日程提醒")
            .setSilent(true)
            .setOngoing(true)
            .build())
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val config = getTaskConfig(intent)
        if (config == null) stopSelf(startId) else startTask(config)
        // A killed reminder must not restart an expired model request.
        return START_NOT_STICKY
    }

    override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig? {
        val eventId = intent?.getStringExtra("eventId") ?: return null
        val phase = intent.getStringExtra("phase") ?: return null
        val scheduledAt = intent.getLongExtra("scheduledAt", 0L)
        return HeadlessJsTaskConfig("JunLuoScheduleReminderTask", Arguments.createMap().apply {
            putString("eventId", eventId)
            putDouble("scheduledAt", scheduledAt.toDouble())
            putString("phase", phase)
            putDouble("prepareAheadMs", intent.getLongExtra("prepareAheadMs", 60_000L).toDouble())
        }, 120_000L, true)
    }

    override fun onDestroy() {
        stopForeground(STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }

    companion object {
        private const val CHANNEL_ID = "junluo_schedule_processing"
    }
}
