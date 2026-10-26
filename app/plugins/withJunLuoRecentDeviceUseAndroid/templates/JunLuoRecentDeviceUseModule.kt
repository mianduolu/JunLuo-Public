package {packageName}.recentuse

import android.app.AppOpsManager
import android.app.KeyguardManager
import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.Context
import android.os.Build
import android.os.PowerManager
import android.os.Process
import android.os.SystemClock
import android.os.UserManager
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import java.util.UUID
import kotlin.math.abs

/** Read-only OS interaction evidence; no package names, content, listeners or services. */
class JunLuoRecentDeviceUseModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
    private val runtimeEpoch = UUID.randomUUID().toString()
    private var queriedThrough = 0L
    private var latestInteraction = 0L
    private var previousWall = 0L
    private var previousMonotonic = 0L

    override fun getName(): String = "JunLuoRecentDeviceUse"

    @ReactMethod
    fun getMonotonicTime(promise: Promise) { promise.resolve(SystemClock.elapsedRealtime().toDouble()) }

    @ReactMethod
    @Synchronized
    fun readSample(promise: Promise) {
        try { promise.resolve(read()) }
        catch (_: Exception) { promise.resolve(result("unknown")) }
    }

    private fun read(): WritableMap {
        if (Build.VERSION.SDK_INT < 23) return result("unsupported")
        val context = reactApplicationContext
        val power = context.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return result("unknown")
        val keyguard = context.getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager ?: return result("unknown")
        if (!power.isInteractive) return result("suspended")
        if (keyguard.isDeviceLocked) return result("locked")
        if (Build.VERSION.SDK_INT >= 24) {
            val user = context.getSystemService(Context.USER_SERVICE) as? UserManager ?: return result("unknown")
            if (!user.isUserUnlocked) return result("locked")
        }
        val ops = context.getSystemService(Context.APP_OPS_SERVICE) as? AppOpsManager ?: return result("unknown")
        val mode = if (Build.VERSION.SDK_INT >= 29) {
            ops.unsafeCheckOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), context.packageName)
        } else {
            @Suppress("DEPRECATION")
            ops.checkOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), context.packageName)
        }
        if (mode != AppOpsManager.MODE_ALLOWED) return result("permission_missing")
        val wall = System.currentTimeMillis()
        val monotonic = SystemClock.elapsedRealtime()
        if (previousWall > 0 && abs((wall - previousWall) - (monotonic - previousMonotonic)) > 1_000L) {
            latestInteraction = 0L
            queriedThrough = wall
            previousWall = wall
            previousMonotonic = monotonic
            return result("unknown")
        }
        previousWall = wall
        previousMonotonic = monotonic
        val usage = context.getSystemService(Context.USAGE_STATS_SERVICE) as? UsageStatsManager ?: return result("unknown")
        val start = if (queriedThrough > 0) maxOf(wall - LOOKBACK_MS, queriedThrough - 1_000L) else wall - LOOKBACK_MS
        val events = usage.queryEvents(start, wall) ?: return result("unknown")
        val event = UsageEvents.Event()
        while (events.hasNextEvent()) {
            events.getNextEvent(event)
            if (event.eventType == UsageEvents.Event.USER_INTERACTION && event.timeStamp in start..wall) {
                latestInteraction = maxOf(latestInteraction, event.timeStamp)
            }
        }
        queriedThrough = wall
        return if (latestInteraction > 0) result("ready", latestInteraction) else result("unknown")
    }

    private fun result(status: String, interaction: Long = 0L): WritableMap = Arguments.createMap().apply {
        putString("runtimeEpoch", runtimeEpoch)
        putDouble("sampledMonotonicMs", SystemClock.elapsedRealtime().toDouble())
        putString("sampleStatus", status)
        if (status == "ready" && interaction > 0 && interaction <= System.currentTimeMillis()) {
            putString("inputToken", interaction.toString())
            putDouble("inputAgeMs", (System.currentTimeMillis() - interaction).toDouble())
        } else {
            putNull("inputToken")
            putNull("inputAgeMs")
        }
    }

    companion object { private const val LOOKBACK_MS = 24L * 60L * 60L * 1_000L }
}
