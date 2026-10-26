package com.anonymous.junluo

import android.app.Notification
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification

class JunLuoNotificationListenerService : NotificationListenerService() {
    override fun onListenerConnected() {
        super.onListenerConnected()
        BodySignalNavigationNotificationEvidence.reconcile(
            applicationContext,
            runCatching { activeNotifications }.getOrDefault(emptyArray()),
        )
    }

    override fun onNotificationPosted(notification: StatusBarNotification?) {
        if (notification == null || notification.packageName == packageName) return
        if (BodySignalNavigationNotificationEvidence.onPosted(applicationContext, notification)) return
        val flags = notification.notification.flags
        if (flags and Notification.FLAG_ONGOING_EVENT != 0) return
        if (flags and Notification.FLAG_GROUP_SUMMARY != 0) return

        val appTitle = runCatching {
            val appInfo = packageManager.getApplicationInfo(notification.packageName, 0)
            packageManager.getApplicationLabel(appInfo).toString()
        }.getOrDefault(notification.packageName)

        PhoneActivityReporter.report(
            applicationContext,
            PhoneActivityReporter.ReportPayload(
                kind = "notification",
                source = notification.packageName,
                title = appTitle,
                summary = "$appTitle 有一条新通知",
                started_at = notification.postTime,
                sensitive_level = "private"
            )
        )
    }

    override fun onNotificationRemoved(notification: StatusBarNotification?) {
        if (notification == null) return
        BodySignalNavigationNotificationEvidence.onRemoved(applicationContext, notification)
    }
}
