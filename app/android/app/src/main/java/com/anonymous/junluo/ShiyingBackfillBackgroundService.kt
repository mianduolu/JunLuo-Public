package com.anonymous.junluo

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import com.facebook.react.ReactApplication
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactContext
import com.facebook.react.internal.featureflags.ReactNativeNewArchitectureFeatureFlags
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.jstasks.HeadlessJsTaskContext
import com.facebook.react.jstasks.HeadlessJsTaskEventListener
import com.facebook.react.modules.core.DeviceEventManagerModule

// This host holds only work explicitly started in the existing JS process.
// A null/late intent cannot create a runtime, load a task or send a request.
class ShiyingBackfillBackgroundService : Service(), HeadlessJsTaskEventListener {
    private val handler = Handler(Looper.getMainLooper())
    private var taskId: String? = null
    private var hostToken: String? = null
    private var headlessTaskId: Int? = null
    private var tasks: HeadlessJsTaskContext? = null
    private var reactContext: ReactContext? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var endReason = "destroyed"
    private val deadline = Runnable { end("time_limit") }

    override fun onCreate() {
        super.onCreate()
        activeInstance = this
        val manager = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(NotificationChannel(
                CHANNEL_ID, "拾荧补捡进度", NotificationManager.IMPORTANCE_LOW).apply {
                setSound(null, null)
                enableVibration(false)
                setShowBadge(false)
            })
        }
    }

    @Suppress("DEPRECATION")
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val requestedId = intent?.getStringExtra("taskId")
        val requestedToken = intent?.getStringExtra("hostToken")
        // The module's pending callback is the only authority to start a host.
        // Expired bridge calls and cold intents are not executable requests.
        if (requestedId.isNullOrBlank() || requestedToken.isNullOrBlank() ||
            !pendingStarts.containsKey(requestedToken)) {
            if (hostToken == null) stopSelfResult(startId)
            return START_NOT_STICKY
        }
        if (hostToken != null) {
            settleStart(requestedToken, false)
            return START_NOT_STICKY
        }
        val app = application as ReactApplication
        val context = if (ReactNativeNewArchitectureFeatureFlags.enableBridgelessArchitecture())
            app.reactHost?.currentReactContext else app.reactNativeHost.reactInstanceManager.currentReactContext
        if (context == null || !context.hasActiveReactInstance()) {
            settleStart(requestedToken, false)
            stopSelfResult(startId)
            return START_NOT_STICKY
        }
        taskId = requestedId
        hostToken = requestedToken
        reactContext = context
        try {
            startForeground(NOTIFICATION_ID, notification(
                intent?.getIntExtra("completedDays", 0) ?: 0, intent?.getIntExtra("totalDays", 1) ?: 1))
            val power = getSystemService(POWER_SERVICE) as PowerManager
            wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK,
                "JunLuo:ShiyingBackfill").apply {
                setReferenceCounted(false)
                acquire(HOST_LIMIT_MS)
            }
            val taskContext = HeadlessJsTaskContext.getInstance(context)
            tasks = taskContext
            taskContext.addTaskEventListener(this)
            headlessTaskId = taskContext.startTask(HeadlessJsTaskConfig(
                "JunLuoShiyingBackfillBackgroundTask", Arguments.createMap().apply {
                    putString("taskId", requestedId)
                    putString("hostToken", requestedToken)
                }, HOST_LIMIT_MS, true))
            handler.postDelayed(deadline, HOST_LIMIT_MS)
            settleStart(requestedToken, true)
        } catch (_: Exception) {
            settleStart(requestedToken, false)
            end("start_failed")
        }
        return START_NOT_STICKY
    }

    private fun notification(completedDays: Int, totalDays: Int): Notification {
        val open = PendingIntent.getActivity(this, NOTIFICATION_ID,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher).setContentTitle("拾荧正在补捡")
            .setContentText("已完成 ${completedDays}／${totalDays} 个日期")
            .setContentIntent(open).setSilent(true).setOnlyAlertOnce(true)
            .setOngoing(true).setPriority(NotificationCompat.PRIORITY_LOW).build()
    }

    private fun matches(id: String, token: String) = taskId == id && hostToken == token

    private fun update(id: String, token: String, completedDays: Int, totalDays: Int): Boolean {
        if (!matches(id, token)) return false
        return try {
            (getSystemService(NOTIFICATION_SERVICE) as NotificationManager)
                .notify(NOTIFICATION_ID, notification(completedDays, totalDays))
            true
        } catch (_: Exception) { false }
    }

    private fun end(reason: String) {
        endReason = reason
        // Stop within the Android onTimeout deadline, not after awaiting JS.
        stopSelf()
    }

    override fun onHeadlessJsTaskStart(taskId: Int) = Unit

    override fun onHeadlessJsTaskFinish(taskId: Int) {
        if (headlessTaskId != taskId) return
        headlessTaskId = null
        end("headless_finished")
    }

    override fun onTimeout(startId: Int, fgsType: Int) { end("system_timeout") }
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        handler.removeCallbacks(deadline)
        tasks?.removeTaskEventListener(this)
        headlessTaskId?.let { tasks?.finishTask(it) }
        headlessTaskId = null
        if (wakeLock?.isHeld == true) wakeLock?.release()
        wakeLock = null
        tasks = null
        stopForeground(STOP_FOREGROUND_REMOVE)
        val id = taskId
        val token = hostToken
        if (id != null && token != null) {
            settleStart(token, false)
            settleStop(token, true)
            val context = reactContext
            if (context?.hasActiveReactInstance() == true) {
                runCatching {
                    context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                        .emit(END_EVENT, Arguments.createMap().apply {
                            putString("taskId", id)
                            putString("hostToken", token)
                            putString("reason", endReason)
                        })
                }
            }
        }
        if (activeInstance === this) activeInstance = null
        hostToken = null
        taskId = null
        reactContext = null
        super.onDestroy()
    }

    companion object {
        const val HOST_LIMIT_MS = 6 * 60 * 60_000L
        const val END_EVENT = "JunLuoShiyingBackfillBackgroundEnd"
        private const val CHANNEL_ID = "junluo_shiying_backfill_processing"
        private const val NOTIFICATION_ID = 47024
        private var activeInstance: ShiyingBackfillBackgroundService? = null
        private val pendingStarts = mutableMapOf<String, (Boolean) -> Unit>()
        private val pendingStops = mutableMapOf<String, (Boolean) -> Unit>()

        // All companion operations run on the UI thread, like service callbacks.
        fun awaitStart(token: String, completion: (Boolean) -> Unit) {
            pendingStarts[token] = completion
        }

        fun settleStart(token: String, started: Boolean) {
            pendingStarts.remove(token)?.invoke(started)
        }

        fun awaitStop(token: String, completion: (Boolean) -> Unit) {
            pendingStops[token] = completion
        }

        fun settleStop(token: String, stopped: Boolean) {
            pendingStops.remove(token)?.invoke(stopped)
        }

        fun update(id: String, token: String, completedDays: Int, totalDays: Int): Boolean =
            activeInstance?.update(id, token, completedDays, totalDays) ?: false

        fun stop(id: String, token: String): Boolean {
            val instance = activeInstance ?: return false
            if (!instance.matches(id, token)) return false
            instance.end("stopped")
            return true
        }
    }
}
