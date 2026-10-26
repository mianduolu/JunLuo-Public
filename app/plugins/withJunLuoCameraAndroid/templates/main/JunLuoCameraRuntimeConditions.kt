package __PACKAGE_NAME__.camera

import android.app.ActivityManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.SensorPrivacyManager
import android.os.BatteryManager
import android.os.Build
import android.os.PowerManager
import android.os.SystemClock
import androidx.core.content.ContextCompat

internal data class JunLuoCameraRuntimeConditionsSnapshot(
    val batteryPercent: Int?,
    val charging: Boolean?,
    val thermalStatus: Int?,
    val lowBatteryPaused: Boolean,
    val thermalPaused: Boolean,
    val powerSaveMode: Boolean?,
    val batteryOptimizationExempt: Boolean?,
    val backgroundRestricted: Boolean?,
    val cameraPrivacyToggleSupported: Boolean?,
    val checkedAt: Long,
    val simulated: Boolean,
) {
    fun captureFailure(automatic: Boolean, allowExistingFrame: Boolean = false): String? =
        cameraRuntimeCaptureFailure(
            JunLuoCameraRuntimePauseState(lowBatteryPaused, thermalPaused), automatic, allowExistingFrame,
        )
}

/** Live FGS conditions only: no preference, alarm, generation change or recovery capture. */
internal object JunLuoCameraRuntimeConditions {
    private var actualPause = JunLuoCameraRuntimePauseState()
    private var simulatedPause = JunLuoCameraRuntimePauseState()
    private var simulation: Triple<Int?, Boolean?, Int?>? = null
    private var monitoringContext: Context? = null
    private var batteryReceiver: BroadcastReceiver? = null
    private var thermalListener: PowerManager.OnThermalStatusChangedListener? = null
    private var thermalReportingConfirmed = false
    private var lastHeadroomCheckElapsed = Long.MIN_VALUE
    private var headroomAvailable = false

    @Synchronized
    fun read(context: Context): JunLuoCameraRuntimeConditionsSnapshot {
        val power = context.getSystemService(PowerManager::class.java)
        val battery = runCatching {
            context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        }.getOrNull()
        val level = battery?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
        val scale = battery?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
        val percent = if (scale > 0 && level in 0..scale) (level * 100L / scale).toInt() else null
        val batteryStatus = battery?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
        val charging = when (batteryStatus) {
            BatteryManager.BATTERY_STATUS_CHARGING, BatteryManager.BATTERY_STATUS_FULL -> true
            BatteryManager.BATTERY_STATUS_DISCHARGING, BatteryManager.BATTERY_STATUS_NOT_CHARGING -> false
            else -> null
        }
        val thermal = if (Build.VERSION.SDK_INT >= 29) runCatching {
            val status = power.currentThermalStatus.takeIf { it in 0..6 }
            if (status != null && status > PowerManager.THERMAL_STATUS_NONE) thermalReportingConfirmed = true
            if (Build.VERSION.SDK_INT >= 30) {
                val elapsed = SystemClock.elapsedRealtime()
                if (lastHeadroomCheckElapsed == Long.MIN_VALUE || elapsed - lastHeadroomCheckElapsed >= 10_000L) {
                    lastHeadroomCheckElapsed = elapsed
                    headroomAvailable = power.getThermalHeadroom(0).isFinite()
                }
            }
            // Some devices always return NONE without reporting thermals. That is unknown, not proof of normality.
            status?.takeIf { it > 0 || thermalReportingConfirmed || headroomAvailable }
        }.getOrNull() else null
        actualPause = updateCameraRuntimePauseState(actualPause, percent, charging, thermal)
        val debug = simulation
        if (debug != null) simulatedPause = updateCameraRuntimePauseState(simulatedPause, debug.first, debug.second, debug.third)
        return JunLuoCameraRuntimeConditionsSnapshot(
            batteryPercent = if (debug != null && !actualPause.lowBatteryPaused) debug.first else percent,
            charging = if (debug != null && !actualPause.lowBatteryPaused) debug.second else charging,
            thermalStatus = if (debug != null && !actualPause.thermalPaused) debug.third else thermal,
            lowBatteryPaused = actualPause.lowBatteryPaused || (debug != null && simulatedPause.lowBatteryPaused),
            thermalPaused = actualPause.thermalPaused || (debug != null && simulatedPause.thermalPaused),
            powerSaveMode = runCatching { power.isPowerSaveMode }.getOrNull(),
            batteryOptimizationExempt = runCatching { power.isIgnoringBatteryOptimizations(context.packageName) }.getOrNull(),
            backgroundRestricted = if (Build.VERSION.SDK_INT >= 28) runCatching {
                context.getSystemService(ActivityManager::class.java).isBackgroundRestricted
            }.getOrNull() else null,
            cameraPrivacyToggleSupported = if (Build.VERSION.SDK_INT >= 31) runCatching {
                context.getSystemService(SensorPrivacyManager::class.java)
                    .supportsSensorToggle(SensorPrivacyManager.Sensors.CAMERA)
            }.getOrNull() else null,
            checkedAt = System.currentTimeMillis(),
            simulated = debug != null,
        )
    }

    @Synchronized
    fun start(context: Context, onChanged: () -> Unit) {
        stopMonitoring()
        val app = context.applicationContext
        monitoringContext = app
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) = onChanged()
        }
        if (runCatching {
            ContextCompat.registerReceiver(app, receiver, IntentFilter(Intent.ACTION_BATTERY_CHANGED), ContextCompat.RECEIVER_NOT_EXPORTED)
        }.isSuccess) batteryReceiver = receiver
        if (Build.VERSION.SDK_INT >= 29) {
            val power = app.getSystemService(PowerManager::class.java)
            val listener = PowerManager.OnThermalStatusChangedListener { status ->
                synchronized(this) {
                    if (status > PowerManager.THERMAL_STATUS_NONE) thermalReportingConfirmed = true
                    actualPause = updateCameraRuntimePauseState(actualPause, null, null, status)
                }
                onChanged()
            }
            if (runCatching { power.addThermalStatusListener(ContextCompat.getMainExecutor(app), listener) }.isSuccess) {
                thermalListener = listener
            }
        }
        read(app)
    }

    @Synchronized
    fun stopMonitoring() {
        val context = monitoringContext
        batteryReceiver?.let { receiver -> context?.let { runCatching { it.unregisterReceiver(receiver) } } }
        if (Build.VERSION.SDK_INT >= 29) thermalListener?.let { listener ->
            context?.let { runCatching { it.getSystemService(PowerManager::class.java).removeThermalStatusListener(listener) } }
        }
        monitoringContext = null
        batteryReceiver = null
        thermalListener = null
    }

    @Synchronized
    fun setDebugSimulation(batteryPercent: Int?, charging: Boolean?, thermalStatus: Int?) {
        if (!__PACKAGE_NAME__.BuildConfig.DEBUG) return
        simulation = Triple(batteryPercent, charging, thermalStatus)
        simulatedPause = updateCameraRuntimePauseState(simulatedPause, batteryPercent, charging, thermalStatus)
    }

    @Synchronized
    fun clearDebugSimulation() {
        simulation = null
        simulatedPause = JunLuoCameraRuntimePauseState()
    }
}
