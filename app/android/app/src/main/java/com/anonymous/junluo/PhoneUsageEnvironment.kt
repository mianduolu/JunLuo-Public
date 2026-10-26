package com.anonymous.junluo

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.hardware.display.DisplayManager
import android.media.session.MediaSessionManager
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import android.view.Display

data class PhoneUsageScreenSnapshot(
    val isInteractive: Boolean,
    val displayState: PhoneUsageDisplayState,
)

object PhoneUsageEnvironment {
    fun readIdleTimeout(context: Context): Long {
        val raw = runCatching {
            Settings.System.getLong(
                context.contentResolver,
                Settings.System.SCREEN_OFF_TIMEOUT,
            )
        }.getOrNull()
        return PhoneUsageTimingPolicy.normalizeIdleTimeout(raw)
    }

    fun readScreen(context: Context): PhoneUsageScreenSnapshot {
        val powerManager = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
        val displayManager = context.getSystemService(Context.DISPLAY_SERVICE) as? DisplayManager
        val display = displayManager?.getDisplay(Display.DEFAULT_DISPLAY)
        val state = when (display?.state) {
            Display.STATE_ON, Display.STATE_VR -> PhoneUsageDisplayState.ON
            Display.STATE_OFF -> PhoneUsageDisplayState.OFF
            Display.STATE_DOZE, Display.STATE_DOZE_SUSPEND -> PhoneUsageDisplayState.DOZE
            else -> {
                if (
                    Build.VERSION.SDK_INT >= Build.VERSION_CODES.P &&
                    display?.state == Display.STATE_ON_SUSPEND
                ) {
                    PhoneUsageDisplayState.SUSPENDED
                } else {
                    PhoneUsageDisplayState.UNKNOWN
                }
            }
        }
        return PhoneUsageScreenSnapshot(
            isInteractive = powerManager?.isInteractive == true,
            displayState = state,
        )
    }

    fun resolveHomePackages(context: Context): Set<String> {
        val intent = Intent(Intent.ACTION_MAIN).apply {
            addCategory(Intent.CATEGORY_HOME)
        }
        return buildSet {
            runCatching {
                context.packageManager
                    .queryIntentActivities(intent, 0)
                    .mapNotNull { it.activityInfo?.packageName?.trim() }
                    .filter { it.isNotBlank() }
            }.getOrDefault(emptyList()).forEach(::add)
            runCatching {
                context.packageManager
                    .resolveActivity(intent, 0)
                    ?.activityInfo
                    ?.packageName
                    ?.trim()
            }.getOrNull()?.takeIf { it.isNotBlank() }?.let(::add)
        }
    }

    fun resolveDefaultHomePackage(context: Context): String? = runCatching {
        context.packageManager.resolveActivity(Intent(Intent.ACTION_MAIN).apply {
            addCategory(Intent.CATEGORY_HOME)
        }, 0)?.activityInfo?.packageName?.trim()?.takeIf { it.isNotBlank() }
    }.getOrNull()

    fun isSystemUiPackage(packageName: String): Boolean {
        val normalized = packageName.trim().lowercase()
        return normalized == "com.android.systemui" ||
            normalized == "com.miui.aod" ||
            normalized.contains("keyguard")
    }

    fun isForegroundVideoPlaying(context: Context, packageName: String): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return false
        val appInfo = runCatching {
            context.packageManager.getApplicationInfo(packageName, 0)
        }.getOrNull() ?: return false
        if (appInfo.category != ApplicationInfo.CATEGORY_VIDEO) return false

        val sessionManager = context.getSystemService(Context.MEDIA_SESSION_SERVICE) as? MediaSessionManager
            ?: return false
        val listener = ComponentName(context, JunLuoNotificationListenerService::class.java)
        val controllers = runCatching {
            sessionManager.getActiveSessions(listener)
        }.getOrDefault(emptyList())
        return controllers.any { controller ->
            if (controller.packageName != packageName) return@any false
            when (controller.playbackState?.state) {
                android.media.session.PlaybackState.STATE_PLAYING,
                android.media.session.PlaybackState.STATE_BUFFERING -> true
                else -> false
            }
        }
    }
}
