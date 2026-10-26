package com.anonymous.junluo.chat

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import com.anonymous.junluo.MainActivity
import com.anonymous.junluo.R
import com.facebook.react.ReactApplication
import com.facebook.react.bridge.Arguments
import com.facebook.react.internal.featureflags.ReactNativeNewArchitectureFeatureFlags
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.jstasks.HeadlessJsTaskContext
import com.facebook.react.jstasks.HeadlessJsTaskEventListener

class JunLuoChatReplyBackgroundService : Service(), HeadlessJsTaskEventListener {
    private val ownedTasks = mutableMapOf<Int, String>()
    private var tasks: HeadlessJsTaskContext? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var lastStartId = 0

    override fun onCreate() {
        super.onCreate()
        val manager = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(NotificationChannel(
                CHANNEL_ID, "君落聊天回复", NotificationManager.IMPORTANCE_LOW))
        }
        val open = PendingIntent.getActivity(this, 47023,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        startForeground(47023, NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher).setContentTitle("君落")
            .setContentText("正在处理聊天回复").setContentIntent(open)
            .setSilent(true).setOngoing(true).build())
    }

    @Suppress("DEPRECATION")
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        lastStartId = startId
        val token = intent?.getStringExtra("token")
        val app = application as ReactApplication
        val context = if (ReactNativeNewArchitectureFeatureFlags.enableBridgelessArchitecture())
            app.reactHost?.currentReactContext else app.reactNativeHost.reactInstanceManager.currentReactContext
        if (token.isNullOrBlank() || context == null || !context.hasActiveReactInstance()) {
            if (ownedTasks.isEmpty()) stopSelfResult(startId)
            return START_NOT_STICKY
        }
        if (token in ownedTasks.values) return START_NOT_STICKY
        val taskContext = HeadlessJsTaskContext.getInstance(context)
        tasks = taskContext
        taskContext.addTaskEventListener(this)
        val power = getSystemService(POWER_SERVICE) as PowerManager
        val lock = wakeLock ?: power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK,
            "JunLuo:ChatReply").also { it.setReferenceCounted(false); wakeLock = it }
        // Own bounded lock: other HeadlessJsTaskService instances share and
        // release RN's static lock, which must not put this reply to sleep.
        lock.acquire(HOST_LIMIT_MS)
        try {
            val taskId = taskContext.startTask(HeadlessJsTaskConfig("JunLuoChatReplyBackgroundTask",
                Arguments.createMap().apply { putString("token", token) }, HOST_LIMIT_MS, true))
            ownedTasks[taskId] = token
        } catch (_: Exception) {
            if (ownedTasks.isEmpty()) stopSelfResult(startId)
        }
        return START_NOT_STICKY
    }

    override fun onHeadlessJsTaskStart(taskId: Int) = Unit

    override fun onHeadlessJsTaskFinish(taskId: Int) {
        if (ownedTasks.remove(taskId) == null) return
        if (ownedTasks.isEmpty()) stopSelfResult(lastStartId)
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onTimeout(startId: Int, fgsType: Int) { stopSelf() }

    override fun onDestroy() {
        tasks?.removeTaskEventListener(this)
        ownedTasks.keys.toList().forEach { tasks?.finishTask(it) }
        ownedTasks.clear()
        if (wakeLock?.isHeld == true) wakeLock?.release()
        wakeLock = null
        tasks = null
        stopForeground(STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }

    companion object {
        private const val CHANNEL_ID = "junluo_chat_reply_processing"
        private const val HOST_LIMIT_MS = 15 * 60_000L
    }
}
