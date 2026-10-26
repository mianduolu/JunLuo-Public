package com.anonymous.junluo.sleep

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import com.anonymous.junluo.R
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig

class JunLuoSleepScheduleTaskService : HeadlessJsTaskService() {
    override fun onCreate() {
        super.onCreate()
        val manager = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(NotificationChannel(
                CHANNEL_ID, "君落作息处理", NotificationManager.IMPORTANCE_LOW))
        }
        startForeground(47022, NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("君落")
            .setContentText("正在更新作息")
            .setSilent(true)
            .setOngoing(true)
            .build())
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val config = getTaskConfig(intent)
        if (config == null) stopSelf(startId) else startTask(config)
        return START_NOT_STICKY
    }

    override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig? {
        val id = intent?.getStringExtra("id") ?: return null
        val nightKey = intent.getStringExtra("nightKey") ?: return null
        val phase = intent.getStringExtra("phase") ?: return null
        // Day planning can take 3 x 120s; illustrated reading can take 5 x 60s.
        // Waking also awaits the following state update. Keep their host alive for that chain.
        val timeoutMs = if (phase == "unified_contact" || phase == "day_plan"
            || phase == "reading" || phase == "wake") 480_000L else 120_000L
        return HeadlessJsTaskConfig("JunLuoSleepScheduleTask", Arguments.createMap().apply {
            putString("id", id)
            putDouble("at", intent.getLongExtra("at", 0L).toDouble())
            putString("nightKey", nightKey)
            putString("phase", phase)
        }, timeoutMs, true)
    }

    override fun onDestroy() {
        stopForeground(STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }

    companion object {
        private const val CHANNEL_ID = "junluo_sleep_processing"
    }
}
