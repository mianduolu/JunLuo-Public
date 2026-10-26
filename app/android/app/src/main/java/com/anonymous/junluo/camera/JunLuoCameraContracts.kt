package com.anonymous.junluo.camera

import java.io.File
import java.io.FileInputStream
import java.security.MessageDigest

const val JUNLUO_CAMERA_TARGET_WIDTH = 640
const val JUNLUO_CAMERA_TARGET_HEIGHT = 480
const val JUNLUO_CAMERA_TARGET_FPS = 15
const val JUNLUO_CAMERA_BIND_TIMEOUT_MS = 8_000L
const val JUNLUO_CAMERA_CAPTURE_TIMEOUT_MS = 10_000L

enum class JunLuoCameraFacing {
    FRONT,
    BACK;

    val sourceKind: String
        get() = if (this == FRONT) "android_front" else "android_back"
}

enum class JunLuoCameraCoreState {
    STOPPED,
    STARTING,
    RUNNING,
    SWITCHING,
    BUSY,
    ERROR,
    RELEASED,
}

data class JunLuoCameraSnapshot(
    val state: JunLuoCameraCoreState,
    val facing: JunLuoCameraFacing?,
    val previewStreaming: Boolean,
    val requestedPreviewFps: IntRange?,
    val previewWidth: Int?,
    val previewHeight: Int?,
    val captureWidth: Int?,
    val captureHeight: Int?,
    val lastFailureCode: String?,
)

data class JunLuoCameraAvailability(
    val facing: JunLuoCameraFacing,
    val available: Boolean,
    val checkedAt: Long,
    val failureCode: String? = null,
)

sealed class JunLuoCameraStartReceipt {
    data class Success(
        val facing: JunLuoCameraFacing,
        val startedAt: Long,
        val previewWidth: Int?,
        val previewHeight: Int?,
        val captureWidth: Int?,
        val captureHeight: Int?,
        val requestedPreviewFps: IntRange?,
    ) : JunLuoCameraStartReceipt()

    data class Failure(
        val facing: JunLuoCameraFacing,
        val failedAt: Long,
        val failureCode: String,
    ) : JunLuoCameraStartReceipt()
}

sealed class JunLuoCameraSwitchReceipt {
    data class Success(
        val facing: JunLuoCameraFacing,
        val sourceKind: String,
        val occurredAt: Long,
    ) : JunLuoCameraSwitchReceipt()

    data class Failure(
        val occurredAt: Long,
        val failureCode: String,
    ) : JunLuoCameraSwitchReceipt()
}

sealed class JunLuoCameraCaptureResult {
    data class Success(
        val requestId: String,
        val facing: JunLuoCameraFacing,
        val sourceKind: String,
        val capturedAt: Long,
        val temporaryPath: String,
        val encodedWidth: Int,
        val encodedHeight: Int,
        val width: Int,
        val height: Int,
        val rotation: Int,
        val mirrored: Boolean,
        val sha256: String,
        val byteLength: Long,
    ) : JunLuoCameraCaptureResult()

    data class Failure(
        val requestId: String,
        val failedAt: Long,
        val failureCode: String,
    ) : JunLuoCameraCaptureResult()
}

data class JunLuoCameraStopReceipt(
    val stopped: Boolean,
    val occurredAt: Long,
    val reasonCode: String,
)

fun interface JunLuoCameraCoreListener {
    fun onSnapshotChanged(snapshot: JunLuoCameraSnapshot)
}

internal data class JunLuoCameraExifTransform(
    val rotation: Int,
    val mirrored: Boolean,
)

internal object JunLuoCameraErrorCodes {
    const val PERMISSION_REQUIRED = "camera_permission_required"
    const val UNAVAILABLE = "camera_unavailable"
    const val BUSY = "camera_busy"
    const val DISABLED = "camera_disabled"
    const val DISCONNECTED = "camera_disconnected"
    const val DO_NOT_DISTURB = "camera_do_not_disturb"
    const val STREAM_CONFIG_FAILED = "camera_stream_config_failed"
    const val START_TIMEOUT = "camera_start_timeout"
    const val NOT_RUNNING = "camera_not_running"
    const val OPERATION_IN_PROGRESS = "camera_operation_in_progress"
    const val CAPTURE_IN_PROGRESS = "camera_capture_in_progress"
    const val FILE_IO_FAILED = "camera_file_io_failed"
    const val CAPTURE_FAILED = "camera_capture_failed"
    const val CAPTURE_CANCELLED = "camera_capture_cancelled"
    const val RELEASED = "camera_released"
    const val UNKNOWN = "camera_unknown_error"
}

internal object JunLuoCameraFailureMapper {
    fun fromCameraUnavailableReason(reason: Int): String = when (reason) {
        1 -> JunLuoCameraErrorCodes.DISABLED
        2 -> JunLuoCameraErrorCodes.DISCONNECTED
        4, 5 -> JunLuoCameraErrorCodes.BUSY
        6 -> JunLuoCameraErrorCodes.DO_NOT_DISTURB
        else -> JunLuoCameraErrorCodes.UNKNOWN
    }

    fun fromCameraStateError(errorCode: Int): String = when (errorCode) {
        1, 2 -> JunLuoCameraErrorCodes.BUSY
        4 -> JunLuoCameraErrorCodes.STREAM_CONFIG_FAILED
        5 -> JunLuoCameraErrorCodes.DISABLED
        6 -> JunLuoCameraErrorCodes.DISCONNECTED
        7 -> JunLuoCameraErrorCodes.DO_NOT_DISTURB
        else -> JunLuoCameraErrorCodes.UNKNOWN
    }

    fun fromImageCaptureError(errorCode: Int): String = when (errorCode) {
        1 -> JunLuoCameraErrorCodes.FILE_IO_FAILED
        2 -> JunLuoCameraErrorCodes.CAPTURE_FAILED
        3, 4 -> JunLuoCameraErrorCodes.NOT_RUNNING
        else -> JunLuoCameraErrorCodes.UNKNOWN
    }
}

internal object JunLuoCameraOperationRules {
    fun startFailureCode(state: JunLuoCameraCoreState, released: Boolean): String? = when {
        released -> JunLuoCameraErrorCodes.RELEASED
        state == JunLuoCameraCoreState.STARTING ||
            state == JunLuoCameraCoreState.SWITCHING ||
            state == JunLuoCameraCoreState.RUNNING -> JunLuoCameraErrorCodes.OPERATION_IN_PROGRESS
        else -> null
    }

    fun switchFailureCode(
        state: JunLuoCameraCoreState,
        captureInFlight: Boolean,
        released: Boolean,
    ): String? = when {
        released -> JunLuoCameraErrorCodes.RELEASED
        captureInFlight -> JunLuoCameraErrorCodes.CAPTURE_IN_PROGRESS
        state == JunLuoCameraCoreState.STARTING || state == JunLuoCameraCoreState.SWITCHING ->
            JunLuoCameraErrorCodes.OPERATION_IN_PROGRESS
        state != JunLuoCameraCoreState.RUNNING -> JunLuoCameraErrorCodes.NOT_RUNNING
        else -> null
    }

    fun captureFailureCode(
        state: JunLuoCameraCoreState,
        previewStreaming: Boolean,
        captureReady: Boolean,
        captureInFlight: Boolean,
        released: Boolean,
    ): String? = when {
        released -> JunLuoCameraErrorCodes.RELEASED
        state != JunLuoCameraCoreState.RUNNING || !previewStreaming || !captureReady ->
            JunLuoCameraErrorCodes.NOT_RUNNING
        captureInFlight -> JunLuoCameraErrorCodes.CAPTURE_IN_PROGRESS
        else -> null
    }

    fun isCaptureCallbackCurrent(
        currentGeneration: Long,
        expectedGeneration: Long,
        activeRequestId: String?,
        expectedRequestId: String,
        captureInFlight: Boolean,
        released: Boolean,
    ): Boolean = captureInFlight && activeRequestId == expectedRequestId &&
        currentGeneration == expectedGeneration && !released

    fun stopWouldChangeState(state: JunLuoCameraCoreState): Boolean =
        state != JunLuoCameraCoreState.STOPPED && state != JunLuoCameraCoreState.RELEASED

    fun releaseWouldChangeState(state: JunLuoCameraCoreState): Boolean =
        state != JunLuoCameraCoreState.RELEASED
}

internal object JunLuoCameraModeRules {
    fun bindingOwnerReady(
        lifecycleOwnerAvailable: Boolean,
        previewViewAvailable: Boolean,
        headless: Boolean,
    ): Boolean = lifecycleOwnerAvailable && (headless || previewViewAvailable)

    fun captureStreamReady(previewStreaming: Boolean, headless: Boolean): Boolean =
        headless || previewStreaming
}

internal fun normalizeCameraRotation(rotation: Int): Int = when (rotation) {
    0, 90, 180, 270 -> rotation
    else -> 0
}

internal fun normalizeCameraExifTransform(rotation: Int, mirrored: Boolean): JunLuoCameraExifTransform =
    JunLuoCameraExifTransform(normalizeCameraRotation(rotation), mirrored)

internal fun orientedCameraDimensions(
    encodedWidth: Int,
    encodedHeight: Int,
    rotation: Int,
): Pair<Int, Int> = if (normalizeCameraRotation(rotation) == 90 || normalizeCameraRotation(rotation) == 270) {
    encodedHeight to encodedWidth
} else {
    encodedWidth to encodedHeight
}

internal fun isValidCameraRequestId(requestId: String): Boolean =
    requestId.matches(Regex("[A-Za-z0-9._-]{1,128}"))

internal fun isCameraOutputInsideCache(cacheDirectory: File, outputFile: File): Boolean = try {
    val cachePath = cacheDirectory.canonicalFile.toPath()
    val outputPath = outputFile.canonicalFile.toPath()
    outputPath.startsWith(cachePath) && outputPath != cachePath
} catch (_: Exception) {
    false
}

internal fun sha256CameraFile(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    FileInputStream(file).use { input ->
        val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
        while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            if (count > 0) digest.update(buffer, 0, count)
        }
    }
    return digest.digest().joinToString("") { byte -> "%02x".format(byte) }
}
