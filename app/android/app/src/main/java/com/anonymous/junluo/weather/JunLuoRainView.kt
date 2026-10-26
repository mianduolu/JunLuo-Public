package com.anonymous.junluo.weather

import android.graphics.BlendMode
import android.graphics.BlurMaskFilter
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.os.Build
import android.os.SystemClock
import android.util.Log
import android.view.Choreographer
import android.view.View
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.bridge.ReactContext
import com.facebook.react.uimanager.events.RCTEventEmitter
import kotlin.math.roundToInt

internal class JunLuoRainView(
  private val reactContext: ReactContext,
) : View(reactContext), LifecycleEventListener {
  private val density = resources.displayMetrics.density
  private var framePacer = JunLuoRainFramePacer()
  private val monotonicTimeBaseMs = System.nanoTime() / NANOS_PER_MILLISECOND
  private val wallTimeBaseMs = System.currentTimeMillis().toDouble()
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = Color.WHITE
    alpha = BASE_RAIN_ALPHA
    strokeCap = Paint.Cap.BUTT
    strokeWidth = 1.2f * density
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      blendMode = BlendMode.OVERLAY
    }
  }
  private val snowPaint by lazy(LazyThreadSafetyMode.NONE) {
    Paint(Paint.ANTI_ALIAS_FLAG).apply {
      color = Color.WHITE
      alpha = BASE_SNOW_ALPHA
      maskFilter = BlurMaskFilter(SNOW_BLUR_RADIUS * density, BlurMaskFilter.Blur.NORMAL)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        blendMode = BlendMode.OVERLAY
      }
    }
  }
  private val frameCallback = Choreographer.FrameCallback { frameTimeNanos ->
    frameCallbackPosted = false
    if (!shouldAnimate()) return@FrameCallback

    if (lastVsyncNanos == 0L) {
      lastVsyncNanos = frameTimeNanos
    } else {
      val deltaNanos = frameTimeNanos - lastVsyncNanos
      lastVsyncNanos = frameTimeNanos
      if (framePacer.consume(deltaNanos)) {
        updatePoints(resolveAnimatedTimeMs(frameTimeNanos / NANOS_PER_MILLISECOND))
        diagnosticFrameCount += 1
        invalidate()
      }
    }
    postNextFrame()
  }
  private var active = false
  private var animated = false
  private var diagnosticsEnabled = false
  private var diagnosticTimeMs = 0.0
  private var enabled = false
  private var effectKind = EFFECT_RAIN
  private var exitingAtMs = -1.0
  private var frameCallbackPosted = false
  private var generation = 0
  private var hostResumed = true
  private var lastVsyncNanos = 0L
  private var lastContentGeneration = -1
  private var lastStateSignature = ""
  private var layerOpacity = 1.0
  private var logicalHeight = 0.0
  private var logicalWidth = 0.0
  private var particles: List<JunLuoRainParticleSpec> = emptyList()
  private var circles = FloatArray(0)
  private var points = FloatArray(0)
  private var startedAtMs = 0.0
  private var transitionDurationMs = 1000.0
  private var diagnosticDrawCount = 0L
  private var diagnosticFrameCount = 0L
  private var diagnosticStartedAtNanos = 0L
  private var disposed = false

  init {
    isClickable = false
    isFocusable = false
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
    setWillNotDraw(false)
    reactContext.addLifecycleEventListener(this)
  }

  fun setActive(value: Boolean) {
    active = value
    rebuild()
  }

  fun setAnimated(value: Boolean) {
    animated = value
    rebuild()
  }

  fun setDiagnosticsEnabled(value: Boolean) {
    if (diagnosticsEnabled && !value) stopDiagnostics()
    diagnosticsEnabled = value
    updateFrameLoop()
  }

  fun setDiagnosticTimeMs(value: Double) {
    diagnosticTimeMs = value
    rebuild()
  }

  fun setRenderEnabled(value: Boolean) {
    enabled = value
    rebuild()
  }

  fun setEffectKind(value: String?) {
    val nextKind = value ?: EFFECT_RAIN
    if (effectKind != nextKind) {
      lastContentGeneration = -1
      framePacer = JunLuoRainFramePacer(targetFpsForEffect(nextKind))
      lastVsyncNanos = 0L
    }
    effectKind = nextKind
    rebuild()
  }

  fun setExitingAtMs(value: Double) {
    exitingAtMs = value
    rebuild()
  }

  fun setGeneration(value: Int) {
    if (generation != value) lastContentGeneration = -1
    generation = value
    rebuild()
  }

  fun setLayerOpacity(value: Double) {
    layerOpacity = value
    rebuild()
  }

  fun setLogicalHeight(value: Double) {
    logicalHeight = value
    rebuild()
  }

  fun setLogicalWidth(value: Double) {
    logicalWidth = value
    rebuild()
  }

  fun setParticles(values: List<Double>) {
    particles = values.chunked(PARTICLE_FIELD_COUNT).mapNotNull { fields ->
      if (fields.size != PARTICLE_FIELD_COUNT || fields.any { !it.isFinite() }) return@mapNotNull null
      JunLuoRainParticleSpec(
        x = fields[0],
        y = fields[1],
        size = fields[2],
        speed = fields[3],
        opacity = fields[4],
        drift = fields[5],
        phase = fields[6],
      )
    }
    rebuild()
  }

  fun setStartedAtMs(value: Double) {
    startedAtMs = value
    rebuild()
  }

  fun setTransitionDurationMs(value: Double) {
    transitionDurationMs = value
    rebuild()
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    if (!canDraw()) return
    val opacity = JunLuoRainMath.layerOpacity(
      timeMs = resolveTimeMs(),
      startedAtMs = startedAtMs,
      exitingAtMs = exitingAtMs.takeIf { it >= 0.0 },
      transitionDurationMs = transitionDurationMs,
      layerOpacity = layerOpacity,
    )
    if (opacity > 0.0) {
      paint.alpha = (baseEffectAlpha() * opacity).roundToInt()
      if (effectKind == EFFECT_HAIL || effectKind == EFFECT_SNOW) {
        val circlePaint = if (effectKind == EFFECT_SNOW) {
          snowPaint.apply { alpha = paint.alpha }
        } else {
          paint
        }
        var offset = 0
        while (offset < circles.size) {
          canvas.drawCircle(circles[offset], circles[offset + 1], circles[offset + 2], circlePaint)
          offset += HAIL_CIRCLE_FIELD_COUNT
        }
      } else {
        canvas.drawLines(points, paint)
      }
    }
    if (animated && diagnosticStartedAtNanos != 0L) diagnosticDrawCount += 1
    if (lastContentGeneration == generation) return
    lastContentGeneration = generation
    post {
      if (lastContentGeneration == generation && canDraw()) {
        emitState("content_ready")
      }
    }
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    updateFrameLoop()
  }

  override fun onDetachedFromWindow() {
    stopFrameLoop()
    super.onDetachedFromWindow()
  }

  override fun onHostResume() {
    hostResumed = true
    updateFrameLoop()
  }

  override fun onHostPause() {
    hostResumed = false
    stopFrameLoop()
  }

  override fun onHostDestroy() {
    dispose()
  }

  fun dispose() {
    if (disposed) return
    disposed = true
    stopFrameLoop()
    reactContext.removeLifecycleEventListener(this)
    active = false
    animated = false
    enabled = false
    particles = emptyList()
    circles = FloatArray(0)
    points = FloatArray(0)
    lastContentGeneration = -1
  }

  private fun rebuild() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
      circles = FloatArray(0)
      points = FloatArray(0)
      emitState("unavailable", "api_unsupported")
      invalidate()
      stopFrameLoop()
      return
    }
    if (!hasValidSpec()) {
      circles = FloatArray(0)
      points = FloatArray(0)
      if (enabled) emitState("unavailable", "invalid_spec")
      invalidate()
      stopFrameLoop()
      return
    }

    if (effectKind == EFFECT_HAIL || effectKind == EFFECT_SNOW) {
      points = FloatArray(0)
      if (circles.size != particles.size * HAIL_CIRCLE_FIELD_COUNT) {
        circles = FloatArray(particles.size * HAIL_CIRCLE_FIELD_COUNT)
      }
    } else {
      circles = FloatArray(0)
      if (points.size != particles.size * RAIN_POINT_FIELD_COUNT) {
        points = FloatArray(particles.size * RAIN_POINT_FIELD_COUNT)
      }
    }
    updatePoints(resolveTimeMs())
    emitState("ready")
    invalidate()
    updateFrameLoop()
  }

  private fun updatePoints(timeMs: Double) {
    if (effectKind == EFFECT_SNOW) {
      particles.forEachIndexed { index, particle ->
        JunLuoRainMath.writeSnowCircle(
          particle = particle,
          timeMs = timeMs,
          logicalWidth = logicalWidth,
          logicalHeight = logicalHeight,
          density = density,
          circles = circles,
          offset = index * HAIL_CIRCLE_FIELD_COUNT,
        )
      }
    } else if (effectKind == EFFECT_HAIL) {
      particles.forEachIndexed { index, particle ->
        JunLuoRainMath.writeHailCircle(
          particle = particle,
          timeMs = timeMs,
          logicalWidth = logicalWidth,
          logicalHeight = logicalHeight,
          density = density,
          circles = circles,
          offset = index * HAIL_CIRCLE_FIELD_COUNT,
        )
      }
    } else {
      particles.forEachIndexed { index, particle ->
        JunLuoRainMath.writeLinePoints(
          particle = particle,
          timeMs = timeMs,
          logicalWidth = logicalWidth,
          logicalHeight = logicalHeight,
          density = density,
          points = points,
          offset = index * RAIN_POINT_FIELD_COUNT,
        )
      }
    }
  }

  private fun canDraw(): Boolean = active && enabled && hasGeometry() && hasValidSpec()

  private fun hasGeometry(): Boolean =
    if (effectKind == EFFECT_HAIL || effectKind == EFFECT_SNOW) circles.isNotEmpty() else points.isNotEmpty()

  private fun hasValidSpec(): Boolean =
    logicalWidth > 0.0
      && logicalHeight > 0.0
      && (animated || diagnosticTimeMs >= 0.0)
      && startedAtMs.isFinite()
      && exitingAtMs.isFinite()
      && transitionDurationMs > 0.0
      && layerOpacity in 0.0..1.0
      && (effectKind == EFFECT_RAIN || effectKind == EFFECT_HAIL || effectKind == EFFECT_SNOW)
      && particles.isNotEmpty()

  private fun baseEffectAlpha(): Int =
    when (effectKind) {
      EFFECT_HAIL -> BASE_HAIL_ALPHA
      EFFECT_SNOW -> BASE_SNOW_ALPHA
      else -> BASE_RAIN_ALPHA
    }

  private fun targetFpsForEffect(kind: String): Long =
    when (kind) {
      EFFECT_HAIL -> JunLuoRainFramePacer.HAIL_TARGET_FPS
      EFFECT_SNOW -> JunLuoRainFramePacer.SNOW_TARGET_FPS
      else -> JunLuoRainFramePacer.RAIN_TARGET_FPS
    }

  private fun resolveTimeMs(): Double =
    if (animated) {
      resolveAnimatedTimeMs(System.nanoTime() / NANOS_PER_MILLISECOND)
    } else {
      diagnosticTimeMs
    }

  private fun resolveAnimatedTimeMs(monotonicNowMs: Double): Double =
    JunLuoRainMath.monotonicWallTimeMs(
      wallTimeBaseMs = wallTimeBaseMs,
      monotonicBaseMs = monotonicTimeBaseMs,
      monotonicNowMs = monotonicNowMs,
    )

  private fun shouldAnimate(): Boolean =
    !disposed && animated && canDraw() && hostResumed && isAttachedToWindow

  private fun updateFrameLoop() {
    if (shouldAnimate()) startFrameLoop() else stopFrameLoop()
  }

  private fun startFrameLoop() {
    startDiagnostics()
    if (frameCallbackPosted) return
    lastVsyncNanos = 0L
    framePacer.reset()
    postNextFrame()
  }

  private fun postNextFrame() {
    if (frameCallbackPosted || !shouldAnimate()) return
    frameCallbackPosted = true
    Choreographer.getInstance().postFrameCallback(frameCallback)
  }

  private fun stopFrameLoop() {
    if (frameCallbackPosted) {
      Choreographer.getInstance().removeFrameCallback(frameCallback)
      frameCallbackPosted = false
    }
    lastVsyncNanos = 0L
    framePacer.reset()
    stopDiagnostics()
  }

  private fun startDiagnostics() {
    if (!diagnosticsEnabled || diagnosticStartedAtNanos != 0L) return
    diagnosticStartedAtNanos = SystemClock.elapsedRealtimeNanos()
    diagnosticFrameCount = 0L
    diagnosticDrawCount = 0L
    Log.i(DIAGNOSTIC_TAG, "R3B_START generation=$generation effect=$effectKind targetFps=${framePacer.targetFps}")
  }

  private fun stopDiagnostics() {
    if (diagnosticStartedAtNanos == 0L) return
    val durationMs = (SystemClock.elapsedRealtimeNanos() - diagnosticStartedAtNanos) / 1_000_000L
    Log.i(
      DIAGNOSTIC_TAG,
      "R3B_STOP generation=$generation effect=$effectKind targetFps=${framePacer.targetFps} durationMs=$durationMs frameCount=$diagnosticFrameCount drawCount=$diagnosticDrawCount",
    )
    diagnosticStartedAtNanos = 0L
  }

  private fun emitState(state: String, reason: String? = null) {
    val signature = "$generation:$state:${reason.orEmpty()}"
    if (signature == lastStateSignature) return
    lastStateSignature = signature
    val event = Arguments.createMap().apply {
      putInt("generation", generation)
      putString("state", state)
      if (reason != null) putString("reason", reason)
    }
    reactContext
      .getJSModule(RCTEventEmitter::class.java)
      .receiveEvent(id, "topRendererStateChange", event)
  }

  private companion object {
    const val BASE_HAIL_ALPHA = (255 * 0.78 * 0.48).toInt()
    const val BASE_RAIN_ALPHA = (255 * 0.72 * 0.42).toInt()
    const val BASE_SNOW_ALPHA = (255 * 0.82 * 0.54).toInt()
    const val DIAGNOSTIC_TAG = "JunLuoRainView"
    const val EFFECT_HAIL = "hail"
    const val EFFECT_RAIN = "rain"
    const val EFFECT_SNOW = "snow"
    const val HAIL_CIRCLE_FIELD_COUNT = 3
    const val NANOS_PER_MILLISECOND = 1_000_000.0
    const val PARTICLE_FIELD_COUNT = 7
    const val RAIN_POINT_FIELD_COUNT = 4
    const val SNOW_BLUR_RADIUS = 1f
  }
}
