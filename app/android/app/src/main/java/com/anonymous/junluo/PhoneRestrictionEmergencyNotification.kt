package com.anonymous.junluo

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat

/** Technical local status/action only; notification failure never cancels emergency release. */
object PhoneRestrictionEmergencyNotification {
    private const val CHANNEL = "junluo_phone_restriction_emergency"
    private const val ID = 39108
    private var lastSignature: String? = null
    @Synchronized fun update(context: Context, now: Long) {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val emergency = PhoneRestrictionRuntime.emergencyDisplay(context)
        if (emergency == null || now >= emergency.until) {
            if (lastSignature != "") runCatching { manager.cancel(ID) }
            lastSignature = ""
            return
        }
        val nearEnd = emergency.until - now <= 60_000
        val signature = "${emergency.id}:${emergency.until}:$nearEnd"
        if (signature == lastSignature) return
        runCatching {
            manager.createNotificationChannel(NotificationChannel(CHANNEL, "手机应急使用", NotificationManager.IMPORTANCE_DEFAULT))
            val extend = PendingIntent.getBroadcast(context, ID, Intent(context, PhoneRestrictionEmergencyReceiver::class.java)
                .setAction("junluo.phone.emergency.extend:${emergency.id}:${emergency.until}")
                .putExtra("emergencyId", emergency.id).putExtra("until", emergency.until),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            val open = PendingIntent.getActivity(context, ID, Intent(context, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            val notification = NotificationCompat.Builder(context, CHANNEL)
                .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
                .setContentTitle(if (nearEnd) "应急使用还剩1分钟" else "应急使用中")
                .setContentText("应急倒计时")
                .setWhen(emergency.until).setUsesChronometer(true).setChronometerCountDown(true)
                .setOngoing(true).setContentIntent(open).setSilent(!nearEnd)
                .addAction(0, "延长使用", extend).build()
            manager.notify(ID, notification)
            lastSignature = signature
        }
    }
}

class PhoneRestrictionEmergencyReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val id = intent.getStringExtra("emergencyId")?.takeIf { it.isNotBlank() } ?: return
        val until = intent.getLongExtra("until", 0).takeIf { it > 0 } ?: return
        val pending = goAsync()
        Thread {
            try {
                runCatching {
                    PhoneRestrictionRuntime.emergency(context.applicationContext, "notification-extension:$id:$until", id)
                    PhoneRestrictionEmergencyNotification.update(context.applicationContext, System.currentTimeMillis())
                }
            } finally { pending.finish() }
        }.start()
    }
}
