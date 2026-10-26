package com.anonymous.junluo.camera

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.BitmapFactory
import android.hardware.display.DisplayManager
import android.os.Handler
import android.os.Looper
import android.util.Range
import android.util.Size
import android.view.OrientationEventListener
import android.view.Surface
import android.view.View
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.CameraState
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.Preview
import androidx.camera.core.resolutionselector.AspectRatioStrategy
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.exifinterface.media.ExifInterface
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.Observer
import java.io.File
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

class JunLuoCameraCore(context: Context) {
    private val appContext = context.applicationContext
    private val mainHandler = Handler(Looper.getMainLooper())
    private val mainExecutor = ContextCompat.getMainExecutor(appContext)
    private val displayManager = appContext.getSystemService(DisplayManager::class.java)
    private val ioExecutor: ExecutorService = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "JunLuoCameraCaptureIo").apply { isDaemon = true }
    }

    private var state = JunLuoCameraCoreState.STOPPED
    private var facing: JunLuoCameraFacing? = null
    private var listener: JunLuoCameraCoreListener? = null
    private var previewStreaming = false
    private var requestedPreviewFps: IntRange? = null
    private var previewWidth: Int? = null
    private var previewHeight: Int? = null
    private var captureWidth: Int? = null
    private var captureHeight: Int? = null
    private var lastFailureCode: String? = null
    private var headless = false
    private var released = false
    private var generation = 0L

    private var cameraProvider: ProcessCameraProvider? = null
    private var lifecycleOwner: LifecycleOwner? = null
    private var previewView: PreviewView? = null
    private var previewImplementationMode = PreviewView.ImplementationMode.COMPATIBLE
    private var camera: Camera? = null
    private var preview: Preview? = null
    private var imageCapture: ImageCapture? = null
    private var cameraStateObserver: Observer<CameraState>? = null
    private var streamStateObserver: Observer<PreviewView.StreamState>? = null
    private var previewLayoutListener: View.OnLayoutChangeListener? = null
    private var previewDisplayListener: DisplayManager.DisplayListener? = null
    private var orientationListener: OrientationEventListener? = null
    private var currentImageRotation = Surface.ROTATION_0

    private var pendingStartCallback: ((JunLuoCameraStartReceipt) -> Unit)? = null
    private var pendingSwitchCallback: ((JunLuoCameraSwitchReceipt) -> Unit)? = null
    private var pendingFacing: JunLuoCameraFacing? = null
    private var previousFacing: JunLuoCameraFacing? = null
    private var switchOriginalFailure: String? = null
    private var rollingBackSwitch = false
    private var fpsFallbackAttempted = false
    private var bindTimeout: Runnable? = null

    private var captureInFlight = false
    private var captureRequestId: String? = null
    private var captureOutputFile: File? = null
    private var captureGeneration = -1L
    private var captureCallback: ((JunLuoCameraCaptureResult) -> Unit)? = null
    private var captureTimeout: Runnable? = null

    fun getAvailability(
        requestedFacing: JunLuoCameraFacing,
        callback: (JunLuoCameraAvailability) -> Unit,
    ) {
        requireMainThread()
        if (released) {
            callback(availabilityFailure(requestedFacing, JunLuoCameraErrorCodes.RELEASED))
            return
        }
        if (!hasCameraPermission()) {
            callback(availabilityFailure(requestedFacing, JunLuoCameraErrorCodes.PERMISSION_REQUIRED))
            return
        }
        val future = ProcessCameraProvider.getInstance(appContext)
        future.addListener({
            val result = try {
                val provider = future.get()
                if (provider.hasCamera(selectorFor(requestedFacing))) {
                    JunLuoCameraAvailability(requestedFacing, true, System.currentTimeMillis())
                } else {
                    availabilityFailure(requestedFacing, JunLuoCameraErrorCodes.UNAVAILABLE)
                }
            } catch (throwable: Throwable) {
                availabilityFailure(requestedFacing, mapProviderFailure(throwable))
            }
            callback(result)
        }, mainExecutor)
    }

    fun start(
        owner: LifecycleOwner,
        targetPreviewView: PreviewView,
        requestedFacing: JunLuoCameraFacing,
        targetListener: JunLuoCameraCoreListener,
        targetImplementationMode: PreviewView.ImplementationMode = PreviewView.ImplementationMode.COMPATIBLE,
        callback: (JunLuoCameraStartReceipt) -> Unit,
    ) {
        startInternal(owner, targetPreviewView, requestedFacing, targetListener, targetImplementationMode, callback)
    }

    fun startHeadless(
        lifecycleOwner: LifecycleOwner,
        facing: JunLuoCameraFacing,
        listener: JunLuoCameraCoreListener,
        callback: (JunLuoCameraStartReceipt) -> Unit,
    ) {
        startInternal(
            lifecycleOwner,
            null,
            facing,
            listener,
            PreviewView.ImplementationMode.COMPATIBLE,
            callback,
        )
    }

    private fun startInternal(
        owner: LifecycleOwner,
        targetPreviewView: PreviewView?,
        requestedFacing: JunLuoCameraFacing,
        targetListener: JunLuoCameraCoreListener,
        targetImplementationMode: PreviewView.ImplementationMode,
        callback: (JunLuoCameraStartReceipt) -> Unit,
    ) {
        requireMainThread()
        JunLuoCameraRuntimeConditions.read(appContext).captureFailure(automatic = false)?.let {
            callback(startFailure(requestedFacing, it))
            return
        }
        val operationFailure = JunLuoCameraOperationRules.startFailureCode(state, released)
        if (operationFailure != null) {
            callback(startFailure(requestedFacing, operationFailure))
            return
        }
        if (!hasCameraPermission()) {
            transitionToFailure(JunLuoCameraErrorCodes.PERMISSION_REQUIRED)
            callback(startFailure(requestedFacing, JunLuoCameraErrorCodes.PERMISSION_REQUIRED))
            return
        }

        listener = targetListener
        generation += 1
        cleanupBoundUseCases()
        cancelPendingBind(JunLuoCameraErrorCodes.NOT_RUNNING)
        lifecycleOwner = owner
        previewView = targetPreviewView
        previewImplementationMode = targetImplementationMode
        headless = targetPreviewView == null
        pendingStartCallback = callback
        pendingFacing = requestedFacing
        previousFacing = null
        switchOriginalFailure = null
        rollingBackSwitch = false
        fpsFallbackAttempted = false
        state = JunLuoCameraCoreState.STARTING
        facing = requestedFacing
        lastFailureCode = null
        startOrientationTracking()
        emitSnapshot()
        beginBind(requestedFacing, useTargetFps = !headless, expectedGeneration = generation)
    }

    fun switchFacing(
        requestedFacing: JunLuoCameraFacing,
        callback: (JunLuoCameraSwitchReceipt) -> Unit,
    ) {
        requireMainThread()
        val operationFailure = JunLuoCameraOperationRules.switchFailureCode(state, captureInFlight, released)
        if (operationFailure != null) {
            callback(switchFailure(operationFailure))
            return
        }
        val currentFacing = facing
        if (currentFacing == requestedFacing) {
            callback(JunLuoCameraSwitchReceipt.Success(requestedFacing, requestedFacing.sourceKind, System.currentTimeMillis()))
            return
        }
        if (currentFacing == null || !JunLuoCameraModeRules.bindingOwnerReady(
                lifecycleOwnerAvailable = lifecycleOwner != null,
                previewViewAvailable = previewView != null,
                headless = headless,
            )
        ) {
            callback(switchFailure(JunLuoCameraErrorCodes.NOT_RUNNING))
            return
        }

        generation += 1
        pendingSwitchCallback = callback
        pendingFacing = requestedFacing
        previousFacing = currentFacing
        switchOriginalFailure = null
        rollingBackSwitch = false
        fpsFallbackAttempted = false
        state = JunLuoCameraCoreState.SWITCHING
        lastFailureCode = null
        emitSnapshot()
        cleanupBoundUseCases()
        beginBind(requestedFacing, useTargetFps = !headless, expectedGeneration = generation)
    }

    fun captureOnce(
        requestId: String,
        outputFile: File,
        callback: (JunLuoCameraCaptureResult) -> Unit,
    ) {
        requireMainThread()
        JunLuoCameraRuntimeConditions.read(appContext).captureFailure(automatic = false)?.let {
            callback(captureFailure(requestId, it))
            return
        }
        val operationFailure = JunLuoCameraOperationRules.captureFailureCode(
            state = state,
            previewStreaming = JunLuoCameraModeRules.captureStreamReady(previewStreaming, headless),
            captureReady = imageCapture != null && facing != null,
            captureInFlight = captureInFlight,
            released = released,
        )
        if (operationFailure != null) {
            callback(captureFailure(requestId, operationFailure))
            return
        }
        if (!hasCameraPermission()) {
            callback(captureFailure(requestId, JunLuoCameraErrorCodes.PERMISSION_REQUIRED))
            return
        }
        if (!isValidCameraRequestId(requestId) || !isCameraOutputInsideCache(appContext.cacheDir, outputFile)) {
            callback(captureFailure(requestId, JunLuoCameraErrorCodes.FILE_IO_FAILED))
            return
        }

        val activeCapture = imageCapture ?: run {
            callback(captureFailure(requestId, JunLuoCameraErrorCodes.NOT_RUNNING))
            return
        }
        val activeFacing = facing ?: run {
            callback(captureFailure(requestId, JunLuoCameraErrorCodes.NOT_RUNNING))
            return
        }
        val parent = outputFile.parentFile
        if (
            parent == null || (!parent.exists() && !parent.mkdirs()) ||
            (outputFile.exists() && !JunLuoCameraTemporaryFileManager.deleteManagedOrFallback(
                appContext, outputFile, JunLuoCameraFrameCleanupTrigger.CAPTURE_CANCELLED,
            ))
        ) {
            callback(captureFailure(requestId, JunLuoCameraErrorCodes.FILE_IO_FAILED))
            return
        }

        captureInFlight = true
        captureRequestId = requestId
        captureOutputFile = outputFile
        captureGeneration = generation
        captureCallback = callback
        val expectedGeneration = generation
        val metadata = ImageCapture.Metadata().apply {
            isReversedHorizontal = activeFacing == JunLuoCameraFacing.FRONT
        }
        val outputOptions = ImageCapture.OutputFileOptions.Builder(outputFile)
            .setMetadata(metadata)
            .build()

        val timeoutRunnable = Runnable {
            if (isCurrentCapture(requestId, expectedGeneration)) {
                finishCapture(captureFailure(requestId, JunLuoCameraErrorCodes.CAPTURE_CANCELLED), deleteOutput = true)
            }
        }
        captureTimeout = timeoutRunnable
        mainHandler.postDelayed(timeoutRunnable, JUNLUO_CAMERA_CAPTURE_TIMEOUT_MS)

        activeCapture.takePicture(
            outputOptions,
            ioExecutor,
            object : ImageCapture.OnImageSavedCallback {
                override fun onImageSaved(outputFileResults: ImageCapture.OutputFileResults) {
                    val result = inspectCaptureFile(requestId, activeFacing, outputFile)
                    mainHandler.post {
                        if (!isCurrentCapture(requestId, expectedGeneration)) {
                            JunLuoCameraTemporaryFileManager.deleteManagedOrFallback(
                                appContext, outputFile, JunLuoCameraFrameCleanupTrigger.CAPTURE_CANCELLED,
                            )
                            return@post
                        }
                        finishCapture(result, deleteOutput = result is JunLuoCameraCaptureResult.Failure)
                    }
                }

                override fun onError(exception: ImageCaptureException) {
                    val result = captureFailure(
                        requestId,
                        JunLuoCameraFailureMapper.fromImageCaptureError(exception.imageCaptureError),
                    )
                    mainHandler.post {
                        if (!isCurrentCapture(requestId, expectedGeneration)) {
                            JunLuoCameraTemporaryFileManager.deleteManagedOrFallback(
                                appContext, outputFile, JunLuoCameraFrameCleanupTrigger.CAPTURE_CANCELLED,
                            )
                            return@post
                        }
                        finishCapture(result, deleteOutput = true)
                    }
                }
            },
        )
    }

    fun cancelCaptureRequest(requestId: String): Boolean {
        requireMainThread()
        if (!captureInFlight || captureRequestId != requestId) return false
        cancelCapture(JunLuoCameraErrorCodes.CAPTURE_CANCELLED)
        return true
    }

    fun stop(reasonCode: String): JunLuoCameraStopReceipt {
        requireMainThread()
        val now = System.currentTimeMillis()
        if (released) return JunLuoCameraStopReceipt(false, now, reasonCode)
        val stopped = JunLuoCameraOperationRules.stopWouldChangeState(state)
        generation += 1
        cancelPendingBind(JunLuoCameraErrorCodes.NOT_RUNNING)
        cancelCapture(JunLuoCameraErrorCodes.CAPTURE_CANCELLED)
        cleanupBoundUseCases()
        stopOrientationTracking()
        lifecycleOwner = null
        previewView = null
        headless = false
        state = JunLuoCameraCoreState.STOPPED
        facing = null
        lastFailureCode = null
        emitSnapshot()
        return JunLuoCameraStopReceipt(stopped, now, reasonCode)
    }

    fun snapshot(): JunLuoCameraSnapshot = JunLuoCameraSnapshot(
        state = state,
        facing = facing,
        previewStreaming = previewStreaming,
        requestedPreviewFps = requestedPreviewFps,
        previewWidth = previewWidth,
        previewHeight = previewHeight,
        captureWidth = captureWidth,
        captureHeight = captureHeight,
        lastFailureCode = lastFailureCode,
    )

    fun release() {
        requireMainThread()
        if (!JunLuoCameraOperationRules.releaseWouldChangeState(state)) return
        stop("camera_core_release")
        released = true
        state = JunLuoCameraCoreState.RELEASED
        lastFailureCode = null
        emitSnapshot()
        listener = null
        ioExecutor.shutdownNow()
    }

    @SuppressLint("MissingPermission")
    private fun beginBind(
        requestedFacing: JunLuoCameraFacing,
        useTargetFps: Boolean,
        expectedGeneration: Long,
    ) {
        if (expectedGeneration != generation || released) return
        pendingFacing = requestedFacing
        facing = requestedFacing
        requestedPreviewFps = if (!headless && useTargetFps) {
            JUNLUO_CAMERA_TARGET_FPS..JUNLUO_CAMERA_TARGET_FPS
        } else {
            null
        }
        scheduleBindTimeout(expectedGeneration)

        val existingProvider = cameraProvider
        if (existingProvider != null) {
            bindWithProvider(existingProvider, requestedFacing, useTargetFps, expectedGeneration)
            return
        }

        val future = ProcessCameraProvider.getInstance(appContext)
        future.addListener({
            if (expectedGeneration != generation || released || pendingFacing != requestedFacing) return@addListener
            try {
                val provider = future.get()
                cameraProvider = provider
                bindWithProvider(provider, requestedFacing, useTargetFps, expectedGeneration)
            } catch (throwable: Throwable) {
                failBind(mapProviderFailure(throwable), expectedGeneration)
            }
        }, mainExecutor)
    }

    @SuppressLint("MissingPermission")
    private fun bindWithProvider(
        provider: ProcessCameraProvider,
        requestedFacing: JunLuoCameraFacing,
        useTargetFps: Boolean,
        expectedGeneration: Long,
    ) {
        if (expectedGeneration != generation || released) return
        JunLuoCameraRuntimeConditions.read(appContext).captureFailure(automatic = false)?.let {
            failBind(it, expectedGeneration)
            return
        }
        if (!hasCameraPermission()) {
            failBind(JunLuoCameraErrorCodes.PERMISSION_REQUIRED, expectedGeneration)
            return
        }
        val owner = lifecycleOwner
        val targetView = previewView
        if (!JunLuoCameraModeRules.bindingOwnerReady(owner != null, targetView != null, headless)) {
            failBind(JunLuoCameraErrorCodes.NOT_RUNNING, expectedGeneration)
            return
        }
        val selector = selectorFor(requestedFacing)
        try {
            if (!provider.hasCamera(selector)) {
                failBind(JunLuoCameraErrorCodes.UNAVAILABLE, expectedGeneration)
                return
            }
            cleanupBoundUseCases()

            val resolutionSelector = ResolutionSelector.Builder()
                .setAspectRatioStrategy(AspectRatioStrategy.RATIO_4_3_FALLBACK_AUTO_STRATEGY)
                .setResolutionStrategy(
                    ResolutionStrategy(
                        Size(JUNLUO_CAMERA_TARGET_WIDTH, JUNLUO_CAMERA_TARGET_HEIGHT),
                        ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER,
                    ),
                )
                .build()
            val newImageCapture = ImageCapture.Builder()
                .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
                .setFlashMode(ImageCapture.FLASH_MODE_OFF)
                .setResolutionSelector(resolutionSelector)
                .setTargetRotation(currentImageRotation)
                .build()
            val newCamera: Camera
            val newPreview: Preview?
            if (headless) {
                newPreview = null
                newCamera = provider.bindToLifecycle(requireNotNull(owner), selector, newImageCapture)
            } else {
                val visiblePreviewView = requireNotNull(targetView)
                visiblePreviewView.implementationMode = previewImplementationMode
                visiblePreviewView.scaleType = PreviewView.ScaleType.FIT_CENTER
                val displayRotation = visiblePreviewView.display?.rotation ?: Surface.ROTATION_0
                val previewBuilder = Preview.Builder()
                    .setResolutionSelector(resolutionSelector)
                    .setTargetRotation(displayRotation)
                if (useTargetFps) {
                    previewBuilder.setTargetFrameRate(Range(JUNLUO_CAMERA_TARGET_FPS, JUNLUO_CAMERA_TARGET_FPS))
                }
                newPreview = previewBuilder.build()
                newPreview.setSurfaceProvider(visiblePreviewView.surfaceProvider)
                newCamera = provider.bindToLifecycle(requireNotNull(owner), selector, newPreview, newImageCapture)
            }

            preview = newPreview
            imageCapture = newImageCapture
            camera = newCamera
            previewStreaming = false
            readBoundResolutions()
            observeBoundCamera(requireNotNull(owner), targetView, newCamera, expectedGeneration)
            targetView?.let(::installPreviewRotationListener)
            emitSnapshot()
        } catch (throwable: Throwable) {
            if (!headless && throwable is IllegalArgumentException && useTargetFps && !fpsFallbackAttempted) {
                fpsFallbackAttempted = true
                cleanupBoundUseCases()
                beginBind(requestedFacing, useTargetFps = false, expectedGeneration = expectedGeneration)
            } else {
                val code = if (throwable is IllegalArgumentException) {
                    JunLuoCameraErrorCodes.STREAM_CONFIG_FAILED
                } else {
                    mapProviderFailure(throwable)
                }
                failBind(code, expectedGeneration)
            }
        }
    }

    private fun observeBoundCamera(
        owner: LifecycleOwner,
        targetView: PreviewView?,
        boundCamera: Camera,
        expectedGeneration: Long,
    ) {
        val cameraObserver = Observer<CameraState> { cameraState ->
            if (expectedGeneration != generation || boundCamera !== camera) return@Observer
            val error = cameraState.error
            if (error == null) {
                if (headless && cameraState.type == CameraState.Type.OPEN && hasPendingBind()) {
                    finishBindSuccess()
                }
                return@Observer
            }
            val code = JunLuoCameraFailureMapper.fromCameraStateError(error.code)
            if (code == JunLuoCameraErrorCodes.STREAM_CONFIG_FAILED && requestedPreviewFps != null && !fpsFallbackAttempted) {
                fpsFallbackAttempted = true
                cleanupBoundUseCases()
                pendingFacing?.let { beginBind(it, useTargetFps = false, expectedGeneration = expectedGeneration) }
                return@Observer
            }
            if (hasPendingBind()) {
                failBind(code, expectedGeneration)
            } else {
                cleanupBoundUseCases()
                stopOrientationTracking()
                transitionToFailure(code)
            }
        }
        cameraStateObserver = cameraObserver
        boundCamera.cameraInfo.cameraState.observe(owner, cameraObserver)

        if (targetView == null) return
        val streamObserver = Observer<PreviewView.StreamState> { streamState ->
            if (expectedGeneration != generation || targetView !== previewView) return@Observer
            previewStreaming = streamState == PreviewView.StreamState.STREAMING
            if (previewStreaming && hasPendingBind()) {
                finishBindSuccess()
            } else {
                emitSnapshot()
            }
        }
        streamStateObserver = streamObserver
        targetView.previewStreamState.observe(owner, streamObserver)
    }

    private fun finishBindSuccess() {
        cancelBindTimeout()
        readBoundResolutions()
        state = JunLuoCameraCoreState.RUNNING
        lastFailureCode = null
        previewStreaming = !headless && previewStreaming
        val activeFacing = pendingFacing ?: facing ?: JunLuoCameraFacing.FRONT
        facing = activeFacing
        emitSnapshot()

        val startCallback = pendingStartCallback
        if (startCallback != null) {
            clearPendingBindFields()
            startCallback(
                JunLuoCameraStartReceipt.Success(
                    facing = activeFacing,
                    startedAt = System.currentTimeMillis(),
                    previewWidth = previewWidth,
                    previewHeight = previewHeight,
                    captureWidth = captureWidth,
                    captureHeight = captureHeight,
                    requestedPreviewFps = requestedPreviewFps,
                ),
            )
            return
        }

        val switchCallback = pendingSwitchCallback
        if (switchCallback != null) {
            val originalFailure = switchOriginalFailure
            val rollbackSucceeded = rollingBackSwitch
            clearPendingBindFields()
            if (rollbackSucceeded) {
                switchCallback(switchFailure(originalFailure ?: JunLuoCameraErrorCodes.UNKNOWN))
            } else {
                switchCallback(
                    JunLuoCameraSwitchReceipt.Success(
                        facing = activeFacing,
                        sourceKind = activeFacing.sourceKind,
                        occurredAt = System.currentTimeMillis(),
                    ),
                )
            }
        }
    }

    private fun failBind(failureCode: String, expectedGeneration: Long) {
        if (expectedGeneration != generation || released) return
        cancelBindTimeout()
        cleanupBoundUseCases()

        if (failureCode != "camera_thermal_paused" &&
            pendingSwitchCallback != null && !rollingBackSwitch && previousFacing != null) {
            switchOriginalFailure = failureCode
            rollingBackSwitch = true
            fpsFallbackAttempted = false
            beginBind(previousFacing!!, useTargetFps = !headless, expectedGeneration = expectedGeneration)
            return
        }

        stopOrientationTracking()
        val finalFailure = switchOriginalFailure ?: failureCode
        state = if (finalFailure == JunLuoCameraErrorCodes.BUSY) JunLuoCameraCoreState.BUSY else JunLuoCameraCoreState.ERROR
        lastFailureCode = finalFailure
        previewStreaming = false
        emitSnapshot()

        pendingStartCallback?.let { callback ->
            val failedFacing = pendingFacing ?: facing ?: JunLuoCameraFacing.FRONT
            clearPendingBindFields()
            callback(startFailure(failedFacing, finalFailure))
            return
        }
        pendingSwitchCallback?.let { callback ->
            clearPendingBindFields()
            callback(switchFailure(finalFailure))
        }
    }

    private fun transitionToFailure(failureCode: String) {
        state = if (failureCode == JunLuoCameraErrorCodes.BUSY) JunLuoCameraCoreState.BUSY else JunLuoCameraCoreState.ERROR
        lastFailureCode = failureCode
        previewStreaming = false
        emitSnapshot()
    }

    private fun scheduleBindTimeout(expectedGeneration: Long) {
        cancelBindTimeout()
        val timeout = Runnable {
            if (expectedGeneration == generation && hasPendingBind()) {
                failBind(JunLuoCameraErrorCodes.START_TIMEOUT, expectedGeneration)
            }
        }
        bindTimeout = timeout
        mainHandler.postDelayed(timeout, JUNLUO_CAMERA_BIND_TIMEOUT_MS)
    }

    private fun cancelBindTimeout() {
        bindTimeout?.let(mainHandler::removeCallbacks)
        bindTimeout = null
    }

    private fun cancelPendingBind(failureCode: String) {
        cancelBindTimeout()
        val startCallback = pendingStartCallback
        val switchCallback = pendingSwitchCallback
        val failedFacing = pendingFacing ?: facing ?: JunLuoCameraFacing.FRONT
        clearPendingBindFields()
        startCallback?.invoke(startFailure(failedFacing, failureCode))
        switchCallback?.invoke(switchFailure(failureCode))
    }

    private fun clearPendingBindFields() {
        pendingStartCallback = null
        pendingSwitchCallback = null
        pendingFacing = null
        previousFacing = null
        switchOriginalFailure = null
        rollingBackSwitch = false
        fpsFallbackAttempted = false
    }

    private fun hasPendingBind(): Boolean = pendingStartCallback != null || pendingSwitchCallback != null

    private fun readBoundResolutions() {
        preview?.resolutionInfo?.resolution?.let { size ->
            previewWidth = size.width
            previewHeight = size.height
        }
        imageCapture?.resolutionInfo?.resolution?.let { size ->
            captureWidth = size.width
            captureHeight = size.height
        }
    }

    private fun installPreviewRotationListener(targetView: PreviewView) {
        previewLayoutListener?.let(targetView::removeOnLayoutChangeListener)
        previewDisplayListener?.let(displayManager::unregisterDisplayListener)
        val layoutListener = View.OnLayoutChangeListener { _, _, _, _, _, _, _, _, _ ->
            updatePreviewRotation(targetView)
        }
        val displayListener = object : DisplayManager.DisplayListener {
            override fun onDisplayAdded(displayId: Int) = Unit

            override fun onDisplayRemoved(displayId: Int) = Unit

            override fun onDisplayChanged(displayId: Int) {
                if (targetView.display?.displayId != displayId) return
                // The callback can arrive before PreviewView exposes the new rotation, especially for 180° changes.
                targetView.postOnAnimation { updatePreviewRotation(targetView) }
            }
        }
        previewLayoutListener = layoutListener
        previewDisplayListener = displayListener
        targetView.addOnLayoutChangeListener(layoutListener)
        displayManager.registerDisplayListener(displayListener, mainHandler)
        updatePreviewRotation(targetView)
    }

    private fun updatePreviewRotation(targetView: PreviewView) {
        if (targetView !== previewView || preview == null) return
        preview?.targetRotation = targetView.display?.rotation ?: Surface.ROTATION_0
        readBoundResolutions()
        emitSnapshot()
    }

    private fun startOrientationTracking() {
        stopOrientationTracking()
        currentImageRotation = previewView?.display?.rotation
            ?: displayManager.getDisplay(android.view.Display.DEFAULT_DISPLAY)?.rotation
            ?: Surface.ROTATION_0
        orientationListener = object : OrientationEventListener(appContext) {
            override fun onOrientationChanged(orientation: Int) {
                if (orientation == ORIENTATION_UNKNOWN) return
                val rotation = when (orientation) {
                    in 45..134 -> Surface.ROTATION_270
                    in 135..224 -> Surface.ROTATION_180
                    in 225..314 -> Surface.ROTATION_90
                    else -> Surface.ROTATION_0
                }
                currentImageRotation = rotation
                imageCapture?.targetRotation = rotation
            }
        }.also { tracking ->
            if (tracking.canDetectOrientation()) tracking.enable()
        }
    }

    private fun stopOrientationTracking() {
        orientationListener?.disable()
        orientationListener = null
    }

    private fun cleanupBoundUseCases() {
        cameraStateObserver?.let { observer -> camera?.cameraInfo?.cameraState?.removeObserver(observer) }
        cameraStateObserver = null
        streamStateObserver?.let { observer -> previewView?.previewStreamState?.removeObserver(observer) }
        streamStateObserver = null
        previewLayoutListener?.let { layoutListener -> previewView?.removeOnLayoutChangeListener(layoutListener) }
        previewLayoutListener = null
        previewDisplayListener?.let(displayManager::unregisterDisplayListener)
        previewDisplayListener = null
        preview?.setSurfaceProvider(null)
        val useCases = listOfNotNull(preview, imageCapture)
        if (useCases.isNotEmpty()) {
            try {
                cameraProvider?.unbind(*useCases.toTypedArray())
            } catch (_: Exception) {
                // The owned use cases may already have been unbound by the lifecycle.
            }
        }
        camera = null
        preview = null
        imageCapture = null
        previewStreaming = false
        previewWidth = null
        previewHeight = null
        captureWidth = null
        captureHeight = null
    }

    private fun inspectCaptureFile(
        requestId: String,
        activeFacing: JunLuoCameraFacing,
        outputFile: File,
    ): JunLuoCameraCaptureResult = try {
        if (!outputFile.isFile || outputFile.length() <= 0L) {
            captureFailure(requestId, JunLuoCameraErrorCodes.FILE_IO_FAILED)
        } else {
            val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeFile(outputFile.absolutePath, options)
            if (options.outWidth <= 0 || options.outHeight <= 0) {
                captureFailure(requestId, JunLuoCameraErrorCodes.FILE_IO_FAILED)
            } else {
                val exif = ExifInterface(outputFile)
                val transform = normalizeCameraExifTransform(exif.rotationDegrees, exif.isFlipped)
                val dimensions = orientedCameraDimensions(options.outWidth, options.outHeight, transform.rotation)
                JunLuoCameraCaptureResult.Success(
                    requestId = requestId,
                    facing = activeFacing,
                    sourceKind = activeFacing.sourceKind,
                    capturedAt = System.currentTimeMillis(),
                    temporaryPath = outputFile.absolutePath,
                    encodedWidth = options.outWidth,
                    encodedHeight = options.outHeight,
                    width = dimensions.first,
                    height = dimensions.second,
                    rotation = transform.rotation,
                    mirrored = transform.mirrored,
                    sha256 = sha256CameraFile(outputFile),
                    byteLength = outputFile.length(),
                )
            }
        }
    } catch (_: Exception) {
        captureFailure(requestId, JunLuoCameraErrorCodes.FILE_IO_FAILED)
    }

    private fun isCurrentCapture(requestId: String, expectedGeneration: Long): Boolean =
        captureGeneration == expectedGeneration && JunLuoCameraOperationRules.isCaptureCallbackCurrent(
            currentGeneration = generation,
            expectedGeneration = expectedGeneration,
            activeRequestId = captureRequestId,
            expectedRequestId = requestId,
            captureInFlight = captureInFlight,
            released = released,
        )

    private fun finishCapture(result: JunLuoCameraCaptureResult, deleteOutput: Boolean) {
        val callback = captureCallback
        val outputFile = captureOutputFile
        captureTimeout?.let(mainHandler::removeCallbacks)
        captureTimeout = null
        captureInFlight = false
        captureRequestId = null
        captureOutputFile = null
        captureGeneration = -1L
        captureCallback = null
        if (deleteOutput) outputFile?.let { file ->
            JunLuoCameraTemporaryFileManager.deleteManagedOrFallback(
                appContext, file, JunLuoCameraFrameCleanupTrigger.CAPTURE_CANCELLED,
            )
        }
        callback?.invoke(result)
    }

    private fun cancelCapture(failureCode: String) {
        if (!captureInFlight) return
        val requestId = captureRequestId ?: "unknown"
        finishCapture(captureFailure(requestId, failureCode), deleteOutput = true)
    }

    private fun hasCameraPermission(): Boolean = ContextCompat.checkSelfPermission(
        appContext,
        Manifest.permission.CAMERA,
    ) == PackageManager.PERMISSION_GRANTED

    private fun selectorFor(requestedFacing: JunLuoCameraFacing): CameraSelector =
        if (requestedFacing == JunLuoCameraFacing.FRONT) CameraSelector.DEFAULT_FRONT_CAMERA
        else CameraSelector.DEFAULT_BACK_CAMERA

    private fun mapProviderFailure(throwable: Throwable): String {
        var current: Throwable? = throwable
        while (current != null) {
            if (current is SecurityException) return JunLuoCameraErrorCodes.PERMISSION_REQUIRED
            if (current is androidx.camera.core.CameraUnavailableException) {
                return JunLuoCameraFailureMapper.fromCameraUnavailableReason(current.reason)
            }
            current = current.cause
        }
        return JunLuoCameraErrorCodes.UNKNOWN
    }

    private fun availabilityFailure(requestedFacing: JunLuoCameraFacing, failureCode: String) =
        JunLuoCameraAvailability(requestedFacing, false, System.currentTimeMillis(), failureCode)

    private fun startFailure(requestedFacing: JunLuoCameraFacing, failureCode: String) =
        JunLuoCameraStartReceipt.Failure(requestedFacing, System.currentTimeMillis(), failureCode)

    private fun switchFailure(failureCode: String) =
        JunLuoCameraSwitchReceipt.Failure(System.currentTimeMillis(), failureCode)

    private fun captureFailure(requestId: String, failureCode: String) =
        JunLuoCameraCaptureResult.Failure(requestId, System.currentTimeMillis(), failureCode)

    private fun emitSnapshot() {
        listener?.onSnapshotChanged(snapshot())
    }

    private fun requireMainThread() {
        check(Looper.myLooper() == Looper.getMainLooper()) {
            "JunLuoCameraCore public methods must be called on the Android main thread."
        }
    }
}
