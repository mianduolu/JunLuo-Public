package com.anonymous.junluo

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import java.util.concurrent.atomic.AtomicBoolean

class MiBand6RealtimeHeartRateService : Service() {
    interface Listener {
        fun onSampleTick(tickId: Int)
        fun onStopRequested(reason: String)
        fun onStopped(reason: String)
    }

    companion object {
        private const val CHANNEL_ID = "junluo_mi_band_6_heart_rate"
        private const val NOTIFICATION_ID = 9326
        private const val DEFAULT_DURATION_MS = 5L * 60L * 1000L
        private const val MAX_DURATION_MS = 5L * 60L * 1000L
        private const val STOP_GRACE_MS = 2_000L
        private const val SAMPLE_INTERVAL_MS = 15_000L
        private const val MAX_MISSED_SAMPLE_TICKS = 3
        const val ACTION_ACK_SAMPLE_TICK = "com.anonymous.junluo.action.MI_BAND_6_HEART_RATE_ACK_SAMPLE_TICK"

        const val ACTION_START = "com.anonymous.junluo.action.MI_BAND_6_HEART_RATE_START"
        const val ACTION_STOP = "com.anonymous.junluo.action.MI_BAND_6_HEART_RATE_STOP"
        const val ACTION_FINISH = "com.anonymous.junluo.action.MI_BAND_6_HEART_RATE_FINISH"
        const val EXTRA_DURATION_MS = "durationMs"
        const val EXTRA_TICK_ID = "tickId"
        const val EXTRA_REASON = "reason"

        @Volatile private var listener: Listener? = null
        @Volatile var isRunning = false
            private set
        @Volatile var endsAt: Long = 0L
            private set

        fun setListener(next: Listener?) {
            listener = next
        }
    }

    private val handler = Handler(Looper.getMainLooper())
    private val stopping = AtomicBoolean(false)
    private var stopReason = "manual"
    private var issuedSampleTickId = 0
    private var acknowledgedSampleTickId = 0
    private var wakeLock: PowerManager.WakeLock? = null
    private val timeoutRunnable = Runnable { requestStop("timeout") }
    private val sampleTickRunnable = object : Runnable {
        override fun run() {
            if (!isRunning || stopping.get()) return
            if (issuedSampleTickId - acknowledgedSampleTickId >= MAX_MISSED_SAMPLE_TICKS) {
                requestStop("write_failed")
                return
            }
            issuedSampleTickId += 1
            listener?.onSampleTick(issuedSampleTickId)
            handler.postDelayed(this, SAMPLE_INTERVAL_MS)
        }
    }

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> startSession(intent.getLongExtra(EXTRA_DURATION_MS, DEFAULT_DURATION_MS))
            ACTION_STOP -> requestStop("manual")
            ACTION_FINISH -> finishSession(intent.getStringExtra(EXTRA_REASON) ?: stopReason)
            ACTION_ACK_SAMPLE_TICK -> acknowledgeSampleTick(
                intent.getIntExtra(EXTRA_TICK_ID, 0)
            )
            else -> if (!isRunning) stopSelf()
        }
        return START_NOT_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onTaskRemoved(rootIntent: Intent?) {
        requestStop("task_removed")
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        finishSession(stopReason)
        super.onDestroy()
    }

    private fun startSession(requestedDurationMs: Long) {
        if (isRunning) return
        val durationMs = requestedDurationMs.coerceIn(1_000L, MAX_DURATION_MS)
        stopping.set(false)
        stopReason = "manual"
        endsAt = System.currentTimeMillis() + durationMs
        isRunning = true
        acquireWakeLock(durationMs + STOP_GRACE_MS + 2_000L)
        val notification = buildNotification()
        issuedSampleTickId = 0
        acknowledgedSampleTickId = 0
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
        handler.postDelayed(timeoutRunnable, durationMs)
        handler.postDelayed(sampleTickRunnable, SAMPLE_INTERVAL_MS)
    }

    private fun requestStop(reason: String) {
        if (!isRunning || !stopping.compareAndSet(false, true)) return
        stopReason = reason
        handler.removeCallbacks(timeoutRunnable)
        handler.removeCallbacks(sampleTickRunnable)
        listener?.onStopRequested(reason)
        handler.postDelayed({ finishSession(reason) }, STOP_GRACE_MS)
    }

    private fun acknowledgeSampleTick(tickId: Int) {
        if (!isRunning || tickId <= 0) return
        acknowledgedSampleTickId = maxOf(acknowledgedSampleTickId, tickId)
    }

    private fun finishSession(reason: String) {
        val wasRunning = isRunning
        stopReason = reason
        isRunning = false
        endsAt = 0L
        stopping.set(true)
        handler.removeCallbacksAndMessages(null)
        releaseWakeLock()
        stopForeground(STOP_FOREGROUND_REMOVE)
        if (wasRunning) listener?.onStopped(reason)
        stopSelf()
    }

    private fun acquireWakeLock(timeoutMs: Long) {
        val manager = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = manager.newWakeLock(
            PowerManager.PARTIAL_WAKE_LOCK,
            "JunLuo:MiBand6RealtimeHeartRate"
        ).apply {
            setReferenceCounted(false)
            acquire(timeoutMs)
        }
    }

    private fun releaseWakeLock() {
        wakeLock?.let { lock -> if (lock.isHeld) lock.release() }
        wakeLock = null
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                getString(R.string.mi_band_6_heart_rate_channel_name),
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = getString(R.string.mi_band_6_heart_rate_channel_description)
                lockscreenVisibility = Notification.VISIBILITY_PRIVATE
                setShowBadge(false)
            }
        )
    }

    private fun buildNotification(): Notification {
        val contentIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val stopIntent = PendingIntent.getService(
            this,
            1,
            Intent(this, MiBand6RealtimeHeartRateService::class.java).apply {
                action = ACTION_STOP
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(getString(R.string.mi_band_6_heart_rate_notification_title))
            .setContentText(getString(R.string.mi_band_6_heart_rate_notification_text))
            .setContentIntent(contentIntent)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .addAction(
                0,
                getString(R.string.mi_band_6_heart_rate_notification_stop),
                stopIntent
            )
            .build()
    }
}
