package com.anonymous.junluo

internal const val SCHEDULED_SAMPLING_INTERVAL_MS = 30L * 60L * 1000L
internal const val SCHEDULED_SAMPLING_MAX_WINDOW_MS = 120L * 1000L
internal const val SCHEDULED_SAMPLING_READING_GAP_MS = 15L * 1000L
internal const val WEARABLE_BATTERY_FRESH_MS = 6L * 60L * 60L * 1000L

internal enum class GuardianSamplingMode(val wireValue: String) {
    MANUAL_5_MINUTE("manual_5_minute"),
    SCHEDULED_2_MINUTE("scheduled_2_minute");

    companion object {
        fun fromWire(value: String?): GuardianSamplingMode? = entries.firstOrNull {
            it.wireValue == value
        }
    }
}

internal enum class GuardianScheduledSamplingStatus(val wireValue: String) {
    DISABLED("disabled"), WAITING("waiting"), EVALUATING("evaluating"),
    SAMPLING("sampling"), PAUSED("paused"), SKIPPED("skipped"), ERROR("error");

    companion object {
        fun fromWire(value: String?): GuardianScheduledSamplingStatus = entries.firstOrNull {
            it.wireValue == value
        } ?: DISABLED
    }
}

internal enum class ScheduledSamplingTrigger(val wireValue: String) {
    ENABLED("enabled"), NATIVE_TIMER("native_timer"), ALARM("alarm"),
    FOREGROUND("foreground"), DEVICE_READY("device_ready"), SETTINGS_RESUME("settings_resume");

    companion object {
        fun fromWire(value: String?): ScheduledSamplingTrigger = entries.firstOrNull {
            it.wireValue == value
        } ?: NATIVE_TIMER
    }
}

internal enum class ScheduledSamplingReason(val wireValue: String) {
    DUE("due"), DISABLED("disabled"), COOLDOWN("cooldown"), PAUSED("paused"),
    GUARDIAN_NOT_READY("guardian_not_ready"), DEVICE_ABSENT("device_absent"),
    PERMISSION_MISSING("permission_missing"), LOW_PHONE_BATTERY("low_phone_battery"),
    LOW_WEARABLE_BATTERY("low_wearable_battery"), BATTERY_SAVER("battery_saver"),
    THERMAL_SEVERE("thermal_severe"), MANUAL_SESSION_ACTIVE("manual_session_active"),
    UNSUPPORTED_DEVICE("unsupported_device");
}

internal enum class ScheduledSamplingResult(val wireValue: String) {
    COMPLETED("completed"), NO_DATA("no_data"), SKIPPED("skipped"),
    STOPPED("stopped"), WRITE_FAILED("write_failed"), DISCONNECTED("disconnected");
}

internal data class ScheduledSamplingDecisionInput(
    val now: Long,
    val enabled: Boolean,
    val pauseUntil: Long?,
    val nextDueAt: Long?,
    val supportedDevice: Boolean,
    val manualSessionActive: Boolean,
    val permissionsGranted: Boolean,
    val appeared: Boolean,
    val guardianReady: Boolean,
    val phoneBatteryPercent: Int?,
    val phoneCharging: Boolean,
    val powerSaveMode: Boolean,
    val thermalSevere: Boolean,
    val wearableBatteryPercent: Int? = null,
    val wearableBatteryMeasuredAt: Long? = null,
)

internal object BodySignalScheduledSamplingPolicy {
    fun decide(input: ScheduledSamplingDecisionInput): ScheduledSamplingReason {
        if (!input.enabled) return ScheduledSamplingReason.DISABLED
        if (input.pauseUntil != null && input.pauseUntil > input.now) return ScheduledSamplingReason.PAUSED
        if (!input.supportedDevice) return ScheduledSamplingReason.UNSUPPORTED_DEVICE
        if (input.manualSessionActive) return ScheduledSamplingReason.MANUAL_SESSION_ACTIVE
        if (input.nextDueAt != null && input.nextDueAt > input.now) return ScheduledSamplingReason.COOLDOWN
        if (!input.permissionsGranted || input.phoneBatteryPercent == null) {
            return ScheduledSamplingReason.PERMISSION_MISSING
        }
        if (!input.appeared) return ScheduledSamplingReason.DEVICE_ABSENT
        if (!input.guardianReady) return ScheduledSamplingReason.GUARDIAN_NOT_READY
        if (input.powerSaveMode) return ScheduledSamplingReason.BATTERY_SAVER
        if (input.thermalSevere) return ScheduledSamplingReason.THERMAL_SEVERE
        if (!input.phoneCharging && input.phoneBatteryPercent <= 15) {
            return ScheduledSamplingReason.LOW_PHONE_BATTERY
        }
        val wearableFresh = input.wearableBatteryMeasuredAt?.let {
            input.now - it in 0L..WEARABLE_BATTERY_FRESH_MS
        } == true
        if (wearableFresh && input.wearableBatteryPercent != null && input.wearableBatteryPercent <= 20) {
            return ScheduledSamplingReason.LOW_WEARABLE_BATTERY
        }
        return ScheduledSamplingReason.DUE
    }

    fun hasSecondSeparatedReading(firstReadingAt: Long?, candidateAt: Long): Boolean =
        firstReadingAt != null && candidateAt - firstReadingAt >= SCHEDULED_SAMPLING_READING_GAP_MS
}
