package com.anonymous.junluo

import android.app.Notification
import android.content.ComponentName
import android.content.Context
import android.provider.Settings
import android.service.notification.StatusBarNotification

object BodySignalNavigationNotificationEvidence {
    private const val PREFS = "body_signal_navigation_notification_evidence"
    private const val ACTIVE = "active"
    private const val LAST_SOURCE = "last_source"
    private const val LAST_OBSERVED_AT = "last_observed_at"
    const val ENTER_KIND = "body_signal_navigation_enter"
    const val EXIT_KIND = "body_signal_navigation_exit"

    private val mapApps = mapOf(
        "com.autonavi.minimap" to "amap",
        "com.baidu.BaiduMap" to "baidu_map",
        "com.tencent.map" to "tencent_map",
        "com.google.android.apps.maps" to "google_maps",
    )
    private val activeKeys = linkedSetOf<String>()

    @Synchronized
    fun onPosted(context: Context, notification: StatusBarNotification): Boolean {
        if (!isNavigationNotification(notification)) return false
        val token = notificationToken(notification)
        if (!activeKeys.add(token)) return true
        if (activeKeys.size == 1) {
            recordTransition(context, ENTER_KIND, notification.packageName, notification.postTime)
        }
        return true
    }

    @Synchronized
    fun onRemoved(context: Context, notification: StatusBarNotification): Boolean {
        if (notification.packageName !in mapApps) return false
        if (!activeKeys.remove(notificationToken(notification))) return false
        if (activeKeys.isEmpty()) {
            recordTransition(context, EXIT_KIND, notification.packageName, System.currentTimeMillis())
        }
        return true
    }

    @Synchronized
    fun reconcile(context: Context, notifications: Array<StatusBarNotification>) {
        val previousActive = preferences(context).getBoolean(ACTIVE, false)
        val current = notifications.filter(::isNavigationNotification)
        activeKeys.clear()
        current.forEach { activeKeys.add(notificationToken(it)) }
        val currentActive = activeKeys.isNotEmpty()
        if (!previousActive && currentActive) {
            val first = current.first()
            recordTransition(context, ENTER_KIND, first.packageName, first.postTime)
        } else if (previousActive && !currentActive) {
            val previousSource = preferences(context).getString(LAST_SOURCE, null) ?: "navigation"
            recordTransition(context, EXIT_KIND, previousSource, System.currentTimeMillis())
        }
    }

    fun isListenerEnabled(context: Context): Boolean {
        val expected = ComponentName(context, JunLuoNotificationListenerService::class.java)
        val enabled = Settings.Secure.getString(
            context.contentResolver,
            "enabled_notification_listeners",
        ).orEmpty()
        return enabled.split(':')
            .mapNotNull(ComponentName::unflattenFromString)
            .any { it == expected }
    }

    fun isActive(context: Context): Boolean =
        isListenerEnabled(context) && preferences(context).getBoolean(ACTIVE, false)

    fun lastObservedAt(context: Context): Long =
        preferences(context).getLong(LAST_OBSERVED_AT, 0L)

    private fun isNavigationNotification(notification: StatusBarNotification): Boolean {
        if (notification.packageName !in mapApps) return false
        val flags = notification.notification.flags
        if (flags and Notification.FLAG_ONGOING_EVENT == 0) return false
        return flags and Notification.FLAG_GROUP_SUMMARY == 0
    }

    private fun notificationToken(notification: StatusBarNotification): String =
        "${notification.packageName}:${notification.key}"

    private fun recordTransition(context: Context, kind: String, source: String, observedAt: Long) {
        val active = kind == ENTER_KIND
        preferences(context).edit()
            .putBoolean(ACTIVE, active)
            .putLong(LAST_OBSERVED_AT, observedAt)
            .putString(LAST_SOURCE, source)
            .commit()
        PhoneActivityReporter.report(
            context,
            PhoneActivityReporter.ReportPayload(
                kind = kind,
                source = source,
                title = mapApps[source] ?: "navigation",
                summary = kind,
                started_at = observedAt,
                sensitive_level = "blocked",
            ),
        )
        BodySignalActivityContextModule.emitLedgerChanged(context)
    }

    private fun preferences(context: Context) =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
}
