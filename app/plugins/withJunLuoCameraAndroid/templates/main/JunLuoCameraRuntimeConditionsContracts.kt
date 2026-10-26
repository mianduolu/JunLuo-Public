package __PACKAGE_NAME__.camera

internal data class JunLuoCameraRuntimePauseState(
    val lowBatteryPaused: Boolean = false,
    val thermalPaused: Boolean = false,
)

internal fun updateCameraRuntimePauseState(
    previous: JunLuoCameraRuntimePauseState,
    batteryPercent: Int?,
    charging: Boolean?,
    thermalStatus: Int?,
): JunLuoCameraRuntimePauseState {
    val battery = batteryPercent?.takeIf { it in 0..100 }
    val thermal = thermalStatus?.takeIf { it in 0..6 }
    return previous.copy(
        lowBatteryPaused = when {
            charging == true || (battery != null && battery >= 25) -> false
            charging == false && battery != null && battery <= 20 -> true
            else -> previous.lowBatteryPaused
        },
        thermalPaused = thermal?.let { it >= 3 } ?: previous.thermalPaused,
    )
}

internal fun cameraRuntimeCaptureFailure(
    state: JunLuoCameraRuntimePauseState,
    automatic: Boolean,
    allowExistingFrame: Boolean = false,
): String? = when {
    allowExistingFrame -> null
    state.thermalPaused -> "camera_thermal_paused"
    automatic && state.lowBatteryPaused -> "camera_low_battery"
    else -> null
}
