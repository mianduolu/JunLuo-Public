package com.anonymous.junluo.portrait

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.PixelFormat
import android.net.Uri
import android.opengl.GLES20
import android.opengl.GLSurfaceView
import android.opengl.GLUtils
import android.opengl.Matrix
import android.os.SystemClock
import android.util.Log
import android.view.Choreographer
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.views.imagehelper.ResourceDrawableIdHelper
import java.lang.ref.WeakReference
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer
import java.net.HttpURLConnection
import java.net.URL
import java.util.Random
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import javax.microedition.khronos.egl.EGLConfig
import javax.microedition.khronos.opengles.GL10
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.min

internal class JunLuoPortraitSurfaceView(
  private val reactContext: ThemedReactContext,
) : GLSurfaceView(reactContext), GLSurfaceView.Renderer, LifecycleEventListener {
  private data class MotionTrack(
    val durationsMs: FloatArray,
    val targets: FloatArray,
    val totalDurationMs: Float,
  )

  private val decodeExecutor = Executors.newSingleThreadExecutor { runnable ->
    Thread(runnable, "JunLuoPortraitDecode").apply { isDaemon = true }
  }
  private val disposed = AtomicBoolean(false)
  private val hostPaused = AtomicBoolean(false)
  private val displayActive = AtomicBoolean(true)
  private val sourceGeneration = AtomicInteger(0)
  private val latestQueuedDecodeGeneration = AtomicInteger(-1)
  private val uploadedGeneration = AtomicInteger(-1)
  private val sourceChangeCount = AtomicInteger(0)
  private val decodeCountValue = AtomicInteger(0)
  private val uploadCountValue = AtomicInteger(0)
  private val deleteCountValue = AtomicInteger(0)
  private val staleDecodeCount = AtomicInteger(0)
  private val frameCount = AtomicLong(0)
  private val lastDecodeMs = AtomicLong(0)
  private val lastUploadMs = AtomicLong(0)
  private val bitmapLock = Any()

  @Volatile private var currentSourceName: String? = null
  private var pendingBitmap: Bitmap? = null
  private var pendingGeneration = 0
  private var textureId = 0
  private var textureWidth = 1
  private var textureHeight = 1
  private var liveTextureCount = 0
  private var peakLiveTextureCount = 0
  private var programId = 0
  private var positionHandle = -1
  private var textureCoordinateHandle = -1
  private var matrixHandle = -1
  private var samplerHandle = -1
  private var surfaceWidth = 1
  private var surfaceHeight = 1
  private var animationStartedNs = 0L
  private var frameCallbackPosted = false

  private val density = resources.displayMetrics.density
  private val modelMatrix = FloatArray(16)
  private val vertexBuffer = floatBufferOf(
    -1f, -1f,
    1f, -1f,
    -1f, 1f,
    1f, 1f,
  )
  private val textureCoordinateBuffer = floatBufferOf(
    0f, 1f,
    1f, 1f,
    0f, 0f,
    1f, 0f,
  )
  private val horizontalTrack = createMotionTrack(seed = 0x4A554E4CL, limit = 1.4f, segments = 20)
  private val verticalTrack = createMotionTrack(seed = 0x504F5254L, limit = 3.5f, segments = 20)
  private val rotationTrack = createMotionTrack(seed = 0x53555246L, limit = 2f, segments = 20)
  private val frameCallback = Choreographer.FrameCallback {
    frameCallbackPosted = false
    if (disposed.get() || isRenderingPaused() || !isAttachedToWindow) return@FrameCallback
    requestRender()
    postNextFrameCallback()
  }

  init {
    setEGLContextClientVersion(2)
    setEGLConfigChooser(8, 8, 8, 8, 0, 0)
    holder.setFormat(PixelFormat.TRANSLUCENT)
    setBackgroundColor(Color.TRANSPARENT)
    setZOrderOnTop(true)
    preserveEGLContextOnPause = true
    setRenderer(this)
    renderMode = RENDERMODE_WHEN_DIRTY
    reactContext.addLifecycleEventListener(this)
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    claimSurfaceOwnership()
    startFrameCallbacks()
  }

  override fun onDetachedFromWindow() {
    stopFrameCallbacks()
    super.onDetachedFromWindow()
  }

  fun setSourceName(sourceName: String?) {
    val normalized = sourceName?.trim()?.takeIf { it.isNotEmpty() }
    if (normalized == currentSourceName) return

    currentSourceName = normalized
    sourceChangeCount.incrementAndGet()
    val generation = sourceGeneration.incrementAndGet()
    recyclePendingBitmap()
    if (normalized != null && !isRenderingPaused()) {
      requestDecode(normalized, generation)
    }
  }

  fun setActive(active: Boolean) {
    if (disposed.get()) return
    alpha = if (active) 1f else 0f
    if (displayActive.getAndSet(active) == active) return
    if (!active) {
      stopFrameCallbacks()
      recyclePendingBitmap()
      return
    }
    if (hostPaused.get()) return
    startFrameCallbacks()
    val sourceName = currentSourceName ?: return
    requestDecode(sourceName, sourceGeneration.get())
  }

  override fun onSurfaceCreated(gl: GL10?, config: EGLConfig?) {
    GLES20.glClearColor(0f, 0f, 0f, 0f)
    GLES20.glEnable(GLES20.GL_BLEND)
    GLES20.glBlendFunc(GLES20.GL_ONE, GLES20.GL_ONE_MINUS_SRC_ALPHA)
    programId = createProgram(VERTEX_SHADER, FRAGMENT_SHADER)
    positionHandle = GLES20.glGetAttribLocation(programId, "aPosition")
    textureCoordinateHandle = GLES20.glGetAttribLocation(programId, "aTextureCoordinate")
    matrixHandle = GLES20.glGetUniformLocation(programId, "uMatrix")
    samplerHandle = GLES20.glGetUniformLocation(programId, "uTexture")
    textureId = 0
    uploadedGeneration.set(-1)
    liveTextureCount = 0
    animationStartedNs = System.nanoTime()

    val sourceName = currentSourceName ?: return
    val generation = sourceGeneration.get()
    if (!hasPendingBitmapFor(generation) && !isRenderingPaused() && !disposed.get()) {
      requestDecode(sourceName, generation)
    }
  }

  override fun onSurfaceChanged(gl: GL10?, width: Int, height: Int) {
    surfaceWidth = width.coerceAtLeast(1)
    surfaceHeight = height.coerceAtLeast(1)
    GLES20.glViewport(0, 0, surfaceWidth, surfaceHeight)
  }

  override fun onDrawFrame(gl: GL10?) {
    uploadPendingTexture()
    GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT)
    if (textureId != 0 && programId != 0) {
      drawCurrentTexture()
    }
    frameCount.incrementAndGet()
  }

  private fun uploadPendingTexture() {
    val pending = synchronized(bitmapLock) {
      val bitmap = pendingBitmap ?: return
      val generation = pendingGeneration
      pendingBitmap = null
      Pair(bitmap, generation)
    }
    val bitmap = pending.first
    val generation = pending.second
    if (generation != sourceGeneration.get() || disposed.get() || isRenderingPaused()) {
      bitmap.recycle()
      staleDecodeCount.incrementAndGet()
      latestQueuedDecodeGeneration.compareAndSet(generation, -1)
      return
    }

    val startedAt = SystemClock.elapsedRealtimeNanos()
    val generatedTexture = IntArray(1)
    GLES20.glGenTextures(1, generatedTexture, 0)
    val nextTextureId = generatedTexture[0]
    if (nextTextureId == 0) {
      bitmap.recycle()
      latestQueuedDecodeGeneration.compareAndSet(generation, -1)
      return
    }

    GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, nextTextureId)
    GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR)
    GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR)
    GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE)
    GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE)
    GLUtils.texImage2D(GLES20.GL_TEXTURE_2D, 0, bitmap, 0)
    if (generation != sourceGeneration.get() || disposed.get() || isRenderingPaused()) {
      GLES20.glDeleteTextures(1, generatedTexture, 0)
      bitmap.recycle()
      staleDecodeCount.incrementAndGet()
      latestQueuedDecodeGeneration.compareAndSet(generation, -1)
      return
    }

    val oldTextureId = textureId
    textureId = nextTextureId
    uploadedGeneration.set(generation)
    textureWidth = bitmap.width.coerceAtLeast(1)
    textureHeight = bitmap.height.coerceAtLeast(1)
    uploadCountValue.incrementAndGet()
    liveTextureCount += 1
    peakLiveTextureCount = maxOf(peakLiveTextureCount, liveTextureCount)
    if (oldTextureId != 0) {
      GLES20.glDeleteTextures(1, intArrayOf(oldTextureId), 0)
      deleteCountValue.incrementAndGet()
      liveTextureCount = (liveTextureCount - 1).coerceAtLeast(0)
    }
    bitmap.recycle()
    lastUploadMs.set((SystemClock.elapsedRealtimeNanos() - startedAt) / 1_000_000L)
    latestQueuedDecodeGeneration.compareAndSet(generation, -1)
    logDiagnostics("source_ready")
  }

  private fun drawCurrentTexture() {
    val elapsedMs = ((System.nanoTime() - animationStartedNs) / 1_000_000L).toFloat()
    val translationX = sampleTrack(horizontalTrack, elapsedMs) * density * 2f / surfaceWidth
    val translationY = -sampleTrack(verticalTrack, elapsedMs) * density * 2f / surfaceHeight
    val rotation = sampleTrack(rotationTrack, elapsedMs)
    val maxWidth = surfaceWidth * CONTENT_SCALE
    val maxHeight = surfaceHeight * CONTENT_SCALE
    val bitmapScale = min(maxWidth / textureWidth, maxHeight / textureHeight)
    val scaleX = textureWidth * bitmapScale / surfaceWidth
    val scaleY = textureHeight * bitmapScale / surfaceHeight

    Matrix.setIdentityM(modelMatrix, 0)
    Matrix.translateM(modelMatrix, 0, translationX, translationY, 0f)
    Matrix.rotateM(modelMatrix, 0, rotation, 0f, 0f, 1f)
    Matrix.scaleM(modelMatrix, 0, scaleX, scaleY, 1f)

    GLES20.glUseProgram(programId)
    vertexBuffer.position(0)
    GLES20.glEnableVertexAttribArray(positionHandle)
    GLES20.glVertexAttribPointer(positionHandle, 2, GLES20.GL_FLOAT, false, 0, vertexBuffer)
    textureCoordinateBuffer.position(0)
    GLES20.glEnableVertexAttribArray(textureCoordinateHandle)
    GLES20.glVertexAttribPointer(textureCoordinateHandle, 2, GLES20.GL_FLOAT, false, 0, textureCoordinateBuffer)
    GLES20.glUniformMatrix4fv(matrixHandle, 1, false, modelMatrix, 0)
    GLES20.glActiveTexture(GLES20.GL_TEXTURE0)
    GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, textureId)
    GLES20.glUniform1i(samplerHandle, 0)
    GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4)
    GLES20.glDisableVertexAttribArray(positionHandle)
    GLES20.glDisableVertexAttribArray(textureCoordinateHandle)
  }

  private fun requestDecode(sourceName: String, generation: Int) {
    if (disposed.get() || decodeExecutor.isShutdown) return
    if (uploadedGeneration.get() == generation || hasPendingBitmapFor(generation)) return
    if (latestQueuedDecodeGeneration.getAndSet(generation) == generation) return
    if (uploadedGeneration.get() == generation || hasPendingBitmapFor(generation)) {
      latestQueuedDecodeGeneration.compareAndSet(generation, -1)
      return
    }
    decodeExecutor.execute {
      var handedToGl = false
      try {
        if (disposed.get() || generation != sourceGeneration.get()) return@execute
        val startedAt = SystemClock.elapsedRealtimeNanos()
        decodeCountValue.incrementAndGet()
        val bitmap = runCatching { decodeBitmap(sourceName) }.getOrNull()
        lastDecodeMs.set((SystemClock.elapsedRealtimeNanos() - startedAt) / 1_000_000L)
        if (bitmap == null) {
          logDiagnostics("decode_failed")
          return@execute
        }
        if (generation != sourceGeneration.get() || disposed.get() || isRenderingPaused()) {
          bitmap.recycle()
          staleDecodeCount.incrementAndGet()
          return@execute
        }
        synchronized(bitmapLock) {
          pendingBitmap?.recycle()
          pendingBitmap = bitmap
          pendingGeneration = generation
        }
        handedToGl = true
        requestRender()
      } finally {
        if (!handedToGl) {
          latestQueuedDecodeGeneration.compareAndSet(generation, -1)
        }
      }
    }
  }

  private fun decodeBitmap(sourceName: String): Bitmap? {
    val options = BitmapFactory.Options().apply {
      inScaled = false
      inPreferredConfig = Bitmap.Config.ARGB_8888
    }
    if (sourceName.startsWith("http://") || sourceName.startsWith("https://")) {
      val connection = URL(sourceName).openConnection() as HttpURLConnection
      connection.connectTimeout = 5_000
      connection.readTimeout = 5_000
      connection.useCaches = true
      return try {
        connection.inputStream.use { stream ->
          BitmapFactory.decodeStream(stream, null, options)
        }
      } finally {
        connection.disconnect()
      }
    }
    if (sourceName.startsWith("file://") || sourceName.startsWith("content://")) {
      return reactContext.contentResolver.openInputStream(Uri.parse(sourceName))?.use { stream ->
        BitmapFactory.decodeStream(stream, null, options)
      }
    }
    val resourceId = ResourceDrawableIdHelper.getResourceDrawableId(reactContext, sourceName)
    return resourceId.takeIf { it != 0 }?.let { id ->
      BitmapFactory.decodeResource(resources, id, options)
    }
  }

  private fun hasPendingBitmapFor(generation: Int): Boolean = synchronized(bitmapLock) {
    pendingBitmap != null && pendingGeneration == generation
  }

  private fun recyclePendingBitmap() {
    synchronized(bitmapLock) {
      val generation = pendingGeneration
      val hadPendingBitmap = pendingBitmap != null
      pendingBitmap?.recycle()
      pendingBitmap = null
      if (hadPendingBitmap) {
        latestQueuedDecodeGeneration.compareAndSet(generation, -1)
      }
    }
  }

  private fun isRenderingPaused(): Boolean = hostPaused.get() || !displayActive.get()

  override fun onHostResume() {
    if (disposed.get() || !hostPaused.compareAndSet(true, false)) return
    onResume()
    if (!displayActive.get()) return
    startFrameCallbacks()
    val sourceName = currentSourceName ?: return
    requestDecode(sourceName, sourceGeneration.get())
  }

  override fun onHostPause() {
    if (disposed.get() || !hostPaused.compareAndSet(false, true)) return
    stopFrameCallbacks()
    recyclePendingBitmap()
    onPause()
  }

  override fun onHostDestroy() {
    dispose()
  }

  private fun claimSurfaceOwnership() {
    val previous = synchronized(OWNER_LOCK) {
      val previousOwner = currentOwner?.get()?.takeUnless { it === this }
      currentOwner = WeakReference(this)
      previousOwner
    }
    previous?.dispose()
  }

  private fun releaseSurfaceOwnership() {
    synchronized(OWNER_LOCK) {
      if (currentOwner?.get() === this) currentOwner = null
    }
  }

  fun dispose() {
    if (!disposed.compareAndSet(false, true)) return
    alpha = 0f
    releaseSurfaceOwnership()
    reactContext.removeLifecycleEventListener(this)
    stopFrameCallbacks()
    sourceGeneration.incrementAndGet()
    recyclePendingBitmap()
    decodeExecutor.shutdownNow()
    runCatching {
      queueEvent {
        releaseGlResources()
        logDiagnostics("release")
      }
      requestRender()
    }
  }

  private fun releaseGlResources() {
    if (textureId != 0) {
      GLES20.glDeleteTextures(1, intArrayOf(textureId), 0)
      textureId = 0
      uploadedGeneration.set(-1)
      deleteCountValue.incrementAndGet()
      liveTextureCount = 0
    }
    if (programId != 0) {
      GLES20.glDeleteProgram(programId)
      programId = 0
    }
  }

  private fun startFrameCallbacks() {
    postNextFrameCallback()
  }

  private fun postNextFrameCallback() {
    if (frameCallbackPosted || disposed.get() || isRenderingPaused() || !isAttachedToWindow) return
    frameCallbackPosted = true
    Choreographer.getInstance().postFrameCallbackDelayed(frameCallback, FRAME_INTERVAL_MS)
  }

  private fun stopFrameCallbacks() {
    if (!frameCallbackPosted) return
    Choreographer.getInstance().removeFrameCallback(frameCallback)
    frameCallbackPosted = false
  }

  private fun logDiagnostics(event: String) {
    val decodeCount = decodeCountValue.get()
    val uploadCount = uploadCountValue.get()
    Log.i(
      TAG,
      "event=$event source_changes=${sourceChangeCount.get()} decode_count=$decodeCount " +
        "upload_count=$uploadCount delete_count=${deleteCountValue.get()} " +
        "live_textures=$liveTextureCount peak_live_textures=$peakLiveTextureCount " +
        "stale_decodes=${staleDecodeCount.get()} last_decode_ms=${lastDecodeMs.get()} " +
        "last_upload_ms=${lastUploadMs.get()} frames=${frameCount.get()}",
    )
  }

  private fun createMotionTrack(seed: Long, limit: Float, segments: Int): MotionTrack {
    val random = Random(seed)
    val rawDurations = FloatArray(segments)
    val targets = FloatArray(segments)
    var rawTotal = 0f
    var index = 0
    while (index < segments) {
      val duration = 700f + random.nextFloat() * 750f
      rawDurations[index] = duration
      rawTotal += duration
      targets[index] = if (index == segments - 1) 0f else (random.nextFloat() * 2f - 1f) * limit
      index += 1
    }
    val durations = FloatArray(segments)
    index = 0
    while (index < segments) {
      durations[index] = rawDurations[index] * MOTION_LOOP_MS / rawTotal
      index += 1
    }
    return MotionTrack(durations, targets, MOTION_LOOP_MS)
  }

  private fun sampleTrack(track: MotionTrack, elapsedMs: Float): Float {
    var remaining = elapsedMs % track.totalDurationMs
    var previous = 0f
    var index = 0
    while (index < track.durationsMs.size) {
      val duration = track.durationsMs[index]
      if (remaining <= duration) {
        val progress = (remaining / duration).coerceIn(0f, 1f)
        val eased = (0.5 - 0.5 * cos(progress * PI)).toFloat()
        return previous + (track.targets[index] - previous) * eased
      }
      remaining -= duration
      previous = track.targets[index]
      index += 1
    }
    return 0f
  }

  private fun createProgram(vertexSource: String, fragmentSource: String): Int {
    val vertexShader = compileShader(GLES20.GL_VERTEX_SHADER, vertexSource)
    val fragmentShader = compileShader(GLES20.GL_FRAGMENT_SHADER, fragmentSource)
    if (vertexShader == 0 || fragmentShader == 0) return 0
    val program = GLES20.glCreateProgram()
    GLES20.glAttachShader(program, vertexShader)
    GLES20.glAttachShader(program, fragmentShader)
    GLES20.glLinkProgram(program)
    val linkStatus = IntArray(1)
    GLES20.glGetProgramiv(program, GLES20.GL_LINK_STATUS, linkStatus, 0)
    GLES20.glDeleteShader(vertexShader)
    GLES20.glDeleteShader(fragmentShader)
    if (linkStatus[0] == 0) {
      Log.e(TAG, "program_link_failed ${GLES20.glGetProgramInfoLog(program)}")
      GLES20.glDeleteProgram(program)
      return 0
    }
    return program
  }

  private fun compileShader(type: Int, source: String): Int {
    val shader = GLES20.glCreateShader(type)
    GLES20.glShaderSource(shader, source)
    GLES20.glCompileShader(shader)
    val compileStatus = IntArray(1)
    GLES20.glGetShaderiv(shader, GLES20.GL_COMPILE_STATUS, compileStatus, 0)
    if (compileStatus[0] == 0) {
      Log.e(TAG, "shader_compile_failed ${GLES20.glGetShaderInfoLog(shader)}")
      GLES20.glDeleteShader(shader)
      return 0
    }
    return shader
  }

  private fun floatBufferOf(vararg values: Float): FloatBuffer = ByteBuffer
    .allocateDirect(values.size * Float.SIZE_BYTES)
    .order(ByteOrder.nativeOrder())
    .asFloatBuffer()
    .apply { put(values); position(0) }

  companion object {
    private val OWNER_LOCK = Any()
    private var currentOwner: WeakReference<JunLuoPortraitSurfaceView>? = null
    private const val TAG = "JunLuoPortraitSurface"
    private const val CONTENT_SCALE = 60f / 70f
    private const val MOTION_LOOP_MS = 24_000f
    private const val FRAME_INTERVAL_MS = 50L
    private const val VERTEX_SHADER = """
      uniform mat4 uMatrix;
      attribute vec4 aPosition;
      attribute vec2 aTextureCoordinate;
      varying vec2 vTextureCoordinate;
      void main() {
        gl_Position = uMatrix * aPosition;
        vTextureCoordinate = aTextureCoordinate;
      }
    """
    private const val FRAGMENT_SHADER = """
      precision mediump float;
      uniform sampler2D uTexture;
      varying vec2 vTextureCoordinate;
      void main() {
        gl_FragColor = texture2D(uTexture, vTextureCoordinate);
      }
    """
  }
}
