package com.anonymous.junluo

import android.app.Activity
import android.app.KeyguardManager
import android.content.ComponentName
import android.content.Context
import android.content.pm.LauncherActivityInfo
import android.content.pm.LauncherApps
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Rect
import android.os.Build
import android.os.Looper
import android.os.PowerManager
import android.os.Process
import android.os.UserHandle
import android.os.UserManager
import android.util.Base64
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.ReadableType
import com.facebook.react.bridge.WritableMap
import com.facebook.react.common.LifecycleState
import java.io.ByteArrayOutputStream
import kotlin.math.roundToInt

/** Public LauncherApps only. Identity and icons exist solely in this request, without a disk cache. */
object AppLaunchEntries {
    private fun profiles(launcher: LauncherApps, users: UserManager): List<UserHandle> {
        val profiles = if (Build.VERSION.SDK_INT >= 26) launcher.profiles else users.userProfiles
        require(profiles.isNotEmpty() && Process.myUserHandle() in profiles)
        return profiles.distinct()
    }

    private fun serial(users: UserManager, profile: UserHandle): String =
        users.getSerialNumberForUser(profile).also { require(it >= 0) }.toString()

    private fun identity(info: LauncherActivityInfo, profileSerial: String) = AppLaunchEntryPolicy.Identity(
        info.componentName.packageName, info.componentName.flattenToString(), profileSerial)

    private fun badgedIcon(context: Context, info: LauncherActivityInfo): String {
        val drawable = info.getBadgedIcon(0)
        val size = (48 * context.resources.displayMetrics.density).roundToInt().coerceIn(48, 144)
        val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val bounds = Rect(drawable.bounds)
        return try {
            drawable.setBounds(0, 0, size, size)
            drawable.draw(Canvas(bitmap))
            ByteArrayOutputStream().use { output ->
                check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, output))
                "data:image/png;base64," + Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP)
            }
        } finally {
            drawable.bounds = bounds
            bitmap.recycle()
        }
    }

    fun list(context: Context): WritableMap {
        val launcher = context.getSystemService(Context.LAUNCHER_APPS_SERVICE) as? LauncherApps
        val users = context.getSystemService(Context.USER_SERVICE) as? UserManager
        if (launcher == null || users == null) return listingResult(false, false, "NATIVE_UNAVAILABLE", emptyList())
        return try {
            var metadataMissing = false
            val result = AppLaunchEntryPolicy.collect(profiles(launcher, users)) { profile ->
                val profileSerial = serial(users, profile)
                // This public type API does not exist below 35. Do not invent profile roles on older phones.
                val profileType = if (Build.VERSION.SDK_INT >= 35)
                    checkNotNull(launcher.getLauncherUserInfo(profile)).userType.also { require(it.isNotBlank()) }
                else null
                launcher.getActivityList(null, profile).mapNotNull { info ->
                    require(info.user == profile)
                    val identity = identity(info, profileSerial)
                    if (!AppLaunchEntryPolicy.validIdentity(identity) ||
                        !launcher.isActivityEnabled(info.componentName, profile) ||
                        !launcher.isPackageEnabled(identity.packageName, profile)) null
                    else {
                        val title = AppLaunchEntryPolicy.systemTitle(info.label)
                        if (title == null) {
                            metadataMissing = true
                            null
                        } else AppLaunchEntryPolicy.Entry(identity, profile == Process.myUserHandle(), title,
                            profileType, AppLaunchEntryPolicy.badgeLabel(profileType), badgedIcon(context, info))
                    }
                }
            }
            val complete = result.complete && !metadataMissing
            listingResult(true, complete, if (complete) null else "APP_QUERY_INCOMPLETE", result.entries)
        } catch (_: Exception) { listingResult(true, false, "APP_QUERY_FAILED", emptyList()) }
    }

    private fun listingResult(available: Boolean, complete: Boolean, reason: String?,
                              entries: List<AppLaunchEntryPolicy.Entry>): WritableMap = Arguments.createMap().apply {
        putBoolean("available", available)
        putBoolean("complete", complete)
        if (reason != null) putString("reason", reason)
        putArray("entries", Arguments.createArray().apply {
            entries.forEach { entry -> pushMap(Arguments.createMap().apply {
                putString("packageName", entry.identity.packageName)
                putString("componentName", entry.identity.componentName)
                putString("profileSerial", entry.identity.profileSerial)
                putBoolean("isCurrentProfile", entry.isCurrentProfile)
                putString("title", entry.title)
                entry.profileType?.let { putString("profileType", it) }
                entry.badgeLabel?.let { putString("badgeLabel", it) }
                entry.iconUri?.let { putString("iconUri", it) }
            }) }
        })
    }

    private fun launchResult(available: Boolean, launched: Boolean, reason: String): WritableMap =
        Arguments.createMap().apply {
            putBoolean("available", available)
            putBoolean("launched", launched)
            putString("reason", reason)
        }

    private fun requestedIdentity(input: ReadableMap): AppLaunchEntryPolicy.Identity? = try {
        fun string(key: String): String {
            require(input.hasKey(key) && !input.isNull(key) && input.getType(key) == ReadableType.String)
            return checkNotNull(input.getString(key))
        }
        AppLaunchEntryPolicy.Identity(string("packageName"), string("componentName"), string("profileSerial"))
            .takeIf { AppLaunchEntryPolicy.validIdentity(it) }
    } catch (_: Exception) { null }

    private fun hostBlockReason(context: ReactApplicationContext, activity: Activity?): String? = try {
        val power = checkNotNull(context.getSystemService(Context.POWER_SERVICE) as? PowerManager)
        val keyguard = checkNotNull(context.getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager)
        // A RN Modal may briefly own window focus while this same current Activity remains resumed.
        val foreground = context.lifecycleState == LifecycleState.RESUMED && activity != null &&
            !activity.isFinishing && !activity.isDestroyed
        AppLaunchEntryPolicy.hostBlockReason(foreground, power.isInteractive,
            keyguard.isKeyguardLocked || keyguard.isDeviceLocked)
    } catch (_: Exception) { "HOST_STATE_UNAVAILABLE" }

    fun launch(context: ReactApplicationContext, activity: Activity?, input: ReadableMap): WritableMap {
        if (Looper.myLooper() != Looper.getMainLooper()) return launchResult(true, false, "HOST_STATE_UNAVAILABLE")
        val request = requestedIdentity(input) ?: return launchResult(true, false, "INVALID_APP_ENTRY")
        hostBlockReason(context, activity)?.let { return launchResult(true, false, it) }
        val launcher = context.getSystemService(Context.LAUNCHER_APPS_SERVICE) as? LauncherApps
        val users = context.getSystemService(Context.USER_SERVICE) as? UserManager
        if (launcher == null || users == null) return launchResult(false, false, "NATIVE_UNAVAILABLE")
        val selected: Pair<UserHandle, ComponentName> = try {
            val profile = profiles(launcher, users).map { it to serial(users, it) }
                .singleOrNull { it.second == request.profileSerial }?.first
                ?: return launchResult(true, false, "PROFILE_UNAVAILABLE")
            val entries = launcher.getActivityList(request.packageName, profile).map { info ->
                require(info.user == profile)
                AppLaunchEntryPolicy.Entry(identity(info, request.profileSerial), profile == Process.myUserHandle(), "")
            }
            val exact = AppLaunchEntryPolicy.exactIdentity(request, entries)
                ?: return launchResult(true, false, "APP_ENTRY_UNAVAILABLE")
            val component = checkNotNull(ComponentName.unflattenFromString(exact.componentName))
            if (!launcher.isActivityEnabled(component, profile) || !launcher.isPackageEnabled(exact.packageName, profile))
                return launchResult(true, false, "APP_ENTRY_UNAVAILABLE")
            if (serial(users, profile) != request.profileSerial) return launchResult(true, false, "PROFILE_UNAVAILABLE")
            profile to component
        } catch (_: Exception) { return launchResult(true, false, "APP_ENTRY_STATE_UNAVAILABLE") }
        // These final gates run on main immediately before dispatch, not when JS first selected the icon.
        hostBlockReason(context, activity)?.let { return launchResult(true, false, it) }
        val restriction = PhoneRestrictionRuntime.canLaunchApp(context, request.packageName)
        if (!restriction.allowed) return launchResult(true, false, restriction.reason ?: "RESTRICTION_UNAVAILABLE")
        return try {
            launcher.startMainActivity(selected.second, selected.first, null, null)
            // A returned dispatch is not evidence that the target became visible or foreground.
            launchResult(true, true, "LAUNCHED")
        } catch (_: Exception) { launchResult(true, false, "LAUNCH_OUTCOME_UNKNOWN") }
    }
}
