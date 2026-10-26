package com.anonymous.junluo.weather

import android.graphics.BlendMode
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RadialGradient
import android.graphics.RectF
import android.graphics.Shader
import android.os.Build
import android.os.SystemClock
import android.util.Log
import android.view.Choreographer
import android.view.View
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.bridge.ReactContext
import com.facebook.react.uimanager.events.RCTEventEmitter
import kotlin.math.max
import kotlin.math.roundToInt

internal class JunLuoFogView(
  private val reactContext: ReactContext,
) : View(reactContext), LifecycleEventListener {
  private val density = resources.displayMetrics.density
  private val framePacer = JunLuoRainFramePacer(JunLuoRainFramePacer.FOG_TARGET_FPS)
  private val monotonicTimeBaseMs = System.nanoTime() / NANOS_PER_MILLISECOND
  private val wallTimeBaseMs = System.currentTimeMillis().toDouble()
  private val basePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    isFilterBitmap = true
  }
  private val overlayPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    isFilterBitmap = true
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) blendMode = BlendMode.OVERLAY
  }
  private val destinationRect = RectF()
  private val frameCallback = Choreographer.FrameCallback { frameTimeNanos ->
    frameCallbackPosted = false
    if (!shouldAnimate()) return@FrameCallback

    if (lastVsyncNanos == 0L) {
      lastVsyncNanos = frameTimeNanos
    } else {
      val deltaNanos = frameTimeNanos - lastVsyncNanos
      lastVsyncNanos = frameTimeNanos
      if (framePacer.consume(deltaNanos)) {
        updateGeometry(resolveAnimatedTimeMs(frameTimeNanos / NANOS_PER_MILLISECOND))
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
  private var disposed = false
  private var effectKind = EFFECT_FOG
  private var enabled = false
  private var exitingAtMs = -1.0
  private var frameCallbackPosted = false
  private var generation = 0
  private var hostResumed = true
  private var lastContentGeneration = -1
  private var lastStateSignature = ""
  private var lastVsyncNanos = 0L
  private var layerOpacity = 1.0
  private var logicalHeight = 0.0
  private var logicalWidth = 0.0
  private var opacities = FloatArray(0)
  private var opacityBoost = 1.0
  private var particles: List<JunLuoRainParticleSpec> = emptyList()
  private var positions = FloatArray(0)
  private var spriteBucketIndices = IntArray(0)
  private var spriteBytes = 0L
  private var spriteHalfSizes = FloatArray(0)
  private var sprites: List<Bitmap> = emptyList()
  private var startedAtMs = 0.0
  private var transitionDurationMs = 1000.0
  private var diagnosticDrawCount = 0L
  private var diagnosticFrameCount = 0L
  private var diagnosticFirstGeometryTimeMs = 0.0
  private var diagnosticLastGeometryTimeMs = 0.0
  private var diagnosticFirstComputedX = 0f
  private var diagnosticLastComputedX = 0f
  private var diagnosticMinComputedX = Float.POSITIVE_INFINITY
  private var diagnosticMaxComputedX = Float.NEGATIVE_INFINITY
  private var diagnosticGeometryUpdateCount = 0L
  private var diagnosticFirstDrawX = 0f
  private var diagnosticLastDrawX = 0f
  private var diagnosticMinDrawX = Float.POSITIVE_INFINITY
  private var diagnosticMaxDrawX = Float.NEGATIVE_INFINITY
  private var diagnosticStartedAtNanos = 0L

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

  fun setDiagnosticTimeMs(value: Double) {
    diagnosticTimeMs = value
    rebuild()
  }

  fun setDiagnosticsEnabled(value: Boolean) {
    if (diagnosticsEnabled && !value) stopDiagnostics()
    diagnosticsEnabled = value
    updateFrameLoop()
  }

  fun setEffectKind(value: String?) {
    val nextKind = if (value == EFFECT_DUST) EFFECT_DUST else EFFECT_FOG
    if (effectKind == nextKind) return
    effectKind = nextKind
    rebuildResources()
    rebuild()
  }

  fun setRenderEnabled(value: Boolean) {
    enabled = value
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

  fun setOpacityBoost(value: Double) {
    opacityBoost = value
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
    rebuildResources()
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
    val transitionOpacity = JunLuoRainMath.layerOpacity(
      timeMs = resolveTimeMs(),
      startedAtMs = startedAtMs,
      exitingAtMs = exitingAtMs.takeIf { it >= 0.0 },
      transitionDurationMs = transitionDurationMs,
      layerOpacity = layerOpacity,
    )

    for (index in particles.indices) {
      val particleOpacity = opacities[index] * opacityBoost * transitionOpacity
      if (particleOpacity <= 0.0) continue
      val x = positions[index * POSITION_FIELD_COUNT]
      val y = positions[index * POSITION_FIELD_COUNT + 1]
      val halfSize = spriteHalfSizes[index]
      val sprite = sprites[spriteBucketIndices[index]]
      destinationRect.set(x - halfSize, y - halfSize, x + halfSize, y + halfSize)
      basePaint.alpha = (255.0 * particleOpacity * BASE_OPACITY).roundToInt().coerceIn(0, 255)
      canvas.drawBitmap(sprite, null, destinationRect, basePaint)
      overlayPaint.alpha = (255.0 * particleOpacity * OVERLAY_OPACITY).roundToInt().coerceIn(0, 255)
      canvas.drawBitmap(sprite, null, destinationRect, overlayPaint)
    }

    if (animated && diagnosticStartedAtNanos != 0L) recordDrawDiagnostics()
    if (lastContentGeneration == generation) return
    lastContentGeneration = generation
    post {
      if (lastContentGeneration == generation && canDraw()) emitState("content_ready")
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
    releaseSprites()
    opacities = FloatArray(0)
    positions = FloatArray(0)
    spriteBucketIndices = IntArray(0)
    spriteHalfSizes = FloatArray(0)
    lastContentGeneration = -1
  }

  private fun rebuildResources() {
    releaseSprites()
    positions = FloatArray(particles.size * POSITION_FIELD_COUNT)
    opacities = FloatArray(particles.size)
    spriteBucketIndices = IntArray(particles.size)
    spriteHalfSizes = FloatArray(particles.size)
    if (JunLuoFogSpriteMath.totalBytes(density.toDouble()) > JunLuoFogSpriteMath.MAX_SPRITE_BYTES) return

    val nextSprites = ArrayList<Bitmap>(JunLuoFogSpriteMath.SIZE_BUCKETS.size)
    try {
      JunLuoFogSpriteMath.SIZE_BUCKETS.forEach { bucketSize ->
        nextSprites += createFogSprite(bucketSize)
      }
    } catch (_: OutOfMemoryError) {
      nextSprites.forEach(Bitmap::recycle)
      return
    } catch (_: IllegalArgumentException) {
      nextSprites.forEach(Bitmap::recycle)
      return
    }
    sprites = nextSprites
    spriteBytes = sprites.sumOf { it.allocationByteCount.toLong() }

    particles.forEachIndexed { index, particle ->
      val bucketIndex = JunLuoFogSpriteMath.bucketIndex(particle.size)
      val bucketSize = JunLuoFogSpriteMath.SIZE_BUCKETS[bucketIndex]
      spriteBucketIndices[index] = bucketIndex
      spriteHalfSizes[index] = ((bucketSize + JunLuoFogSpriteMath.BLUR_RADIUS * 3.0) * density).toFloat()
    }
  }

  private fun createFogSprite(bucketSize: Double): Bitmap {
    val pixelRatio = minOf(density.toDouble(), JunLuoFogSpriteMath.MAX_PIXEL_RATIO).toFloat()
    val pixelSize = JunLuoFogSpriteMath.pixelSize(bucketSize, density.toDouble())
    val center = pixelSize / 2f
    val particleRadius = (bucketSize * pixelRatio).toFloat()
    val blurRadius = (JunLuoFogSpriteMath.BLUR_RADIUS * pixelRatio).toFloat()
    val outerRadius = particleRadius + blurRadius * 3f
    val red = if (effectKind == EFFECT_DUST) DUST_RED else 255
    val green = if (effectKind == EFFECT_DUST) DUST_GREEN else 255
    val blue = if (effectKind == EFFECT_DUST) DUST_BLUE else 255
    val gradient = RadialGradient(
      center,
      center,
      outerRadius,
      intArrayOf(
        Color.argb(255, red, green, blue),
        Color.argb(255, red, green, blue),
        Color.argb(214, red, green, blue),
        Color.argb(128, red, green, blue),
        Color.argb(41, red, green, blue),
        Color.argb(0, red, green, blue),
      ),
      floatArrayOf(
        0f,
        max(0f, (particleRadius - blurRadius * 2f) / outerRadius),
        max(0f, (particleRadius - blurRadius) / outerRadius),
        particleRadius / outerRadius,
        (particleRadius + blurRadius) / outerRadius,
        1f,
      ),
      Shader.TileMode.CLAMP,
    )
    val bitmap = Bitmap.createBitmap(pixelSize, pixelSize, Bitmap.Config.ARGB_8888)
    val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { shader = gradient }
    Canvas(bitmap).drawCircle(center, center, outerRadius, paint)
    paint.shader = null
    bitmap.prepareToDraw()
    return bitmap
  }

  private fun releaseSprites() {
    sprites.forEach { sprite ->
      if (!sprite.isRecycled) sprite.recycle()
    }
    sprites = emptyList()
    spriteBytes = 0L
  }

  private fun rebuild() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
      emitState("unavailable", "api_unsupported")
      invalidate()
      stopFrameLoop()
      return
    }
    if (!hasValidSpec()) {
      if (enabled) emitState("unavailable", "invalid_spec")
      invalidate()
      stopFrameLoop()
      return
    }

    updateGeometry(resolveTimeMs())
    emitState("ready")
    invalidate()
    updateFrameLoop()
  }

  private fun updateGeometry(timeMs: Double) {
    particles.forEachIndexed { index, particle ->
      JunLuoFogMath.writeParticle(
        particle = particle,
        timeMs = timeMs,
        logicalWidth = logicalWidth,
        logicalHeight = logicalHeight,
        density = density,
        positions = positions,
        positionOffset = index * POSITION_FIELD_COUNT,
        opacities = opacities,
        opacityOffset = index,
        verticalDriftScale = if (effectKind == EFFECT_DUST) JunLuoFogMath.DUST_VERTICAL_DRIFT_SCALE else 0.0,
      )
    }
    recordGeometryDiagnostics(timeMs)
  }

  private fun recordGeometryDiagnostics(timeMs: Double) {
    if (!diagnosticsEnabled || diagnosticStartedAtNanos == 0L || positions.isEmpty()) return
    val computedX = positions[0]
    if (diagnosticGeometryUpdateCount == 0L) {
      diagnosticFirstGeometryTimeMs = timeMs
      diagnosticFirstComputedX = computedX
    }
    diagnosticLastGeometryTimeMs = timeMs
    diagnosticLastComputedX = computedX
    diagnosticMinComputedX = minOf(diagnosticMinComputedX, computedX)
    diagnosticMaxComputedX = maxOf(diagnosticMaxComputedX, computedX)
    diagnosticGeometryUpdateCount += 1
  }

  private fun recordDrawDiagnostics() {
    if (positions.isEmpty()) return
    val drawX = positions[0]
    if (diagnosticDrawCount == 0L) diagnosticFirstDrawX = drawX
    diagnosticLastDrawX = drawX
    diagnosticMinDrawX = minOf(diagnosticMinDrawX, drawX)
    diagnosticMaxDrawX = maxOf(diagnosticMaxDrawX, drawX)
    diagnosticDrawCount += 1
  }

  private fun canDraw(): Boolean = active && enabled && hasValidSpec()

  private fun hasValidSpec(): Boolean =
    logicalWidth > 0.0
      && logicalHeight > 0.0
      && (animated || diagnosticTimeMs >= 0.0)
      && startedAtMs.isFinite()
      && exitingAtMs.isFinite()
      && transitionDurationMs > 0.0
      && layerOpacity in 0.0..1.0
      && opacityBoost > 0.0
      && particles.isNotEmpty()
      && sprites.size == JunLuoFogSpriteMath.SIZE_BUCKETS.size
      && spriteBytes in 1..JunLuoFogSpriteMath.MAX_SPRITE_BYTES
      && opacities.size == particles.size
      && positions.size == particles.size * POSITION_FIELD_COUNT
      && spriteBucketIndices.size == particles.size
      && spriteHalfSizes.size == particles.size

  private fun resolveTimeMs(): Double =
    if (animated) resolveAnimatedTimeMs(System.nanoTime() / NANOS_PER_MILLISECOND) else diagnosticTimeMs

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
    diagnosticFirstGeometryTimeMs = 0.0
    diagnosticLastGeometryTimeMs = 0.0
    diagnosticFirstComputedX = 0f
    diagnosticLastComputedX = 0f
    diagnosticMinComputedX = Float.POSITIVE_INFINITY
    diagnosticMaxComputedX = Float.NEGATIVE_INFINITY
    diagnosticGeometryUpdateCount = 0L
    diagnosticFirstDrawX = 0f
    diagnosticLastDrawX = 0f
    diagnosticMinDrawX = Float.POSITIVE_INFINITY
    diagnosticMaxDrawX = Float.NEGATIVE_INFINITY
    val firstParticle = particles.firstOrNull()
    Log.i(
      DIAGNOSTIC_TAG,
      "F4_START generation=$generation targetFps=${JunLuoRainFramePacer.FOG_TARGET_FPS} particleCount=${particles.size} spriteCount=${sprites.size} spriteBytes=$spriteBytes opacityBoost=$opacityBoost logicalWidth=$logicalWidth density=$density firstParticleSpeed=${firstParticle?.speed ?: 0.0} firstParticleDrift=${firstParticle?.drift ?: 0.0}",
    )
  }

  private fun stopDiagnostics() {
    if (diagnosticStartedAtNanos == 0L) return
    val durationMs = (SystemClock.elapsedRealtimeNanos() - diagnosticStartedAtNanos) / 1_000_000L
    val timeAdvanceMs = if (diagnosticGeometryUpdateCount > 0L) {
      diagnosticLastGeometryTimeMs - diagnosticFirstGeometryTimeMs
    } else {
      0.0
    }
    val computedRangePx = if (diagnosticGeometryUpdateCount > 0L) {
      diagnosticMaxComputedX - diagnosticMinComputedX
    } else {
      0f
    }
    val drawRangePx = if (diagnosticDrawCount > 0L) diagnosticMaxDrawX - diagnosticMinDrawX else 0f
    var minBaseAlpha = 255
    var maxBaseAlpha = 0
    opacities.forEach { opacity ->
      val alpha = (255.0 * opacity * opacityBoost * layerOpacity * BASE_OPACITY).roundToInt().coerceIn(0, 255)
      minBaseAlpha = minOf(minBaseAlpha, alpha)
      maxBaseAlpha = maxOf(maxBaseAlpha, alpha)
    }
    if (opacities.isEmpty()) minBaseAlpha = 0
    Log.i(
      DIAGNOSTIC_TAG,
      "F4_STOP generation=$generation targetFps=${JunLuoRainFramePacer.FOG_TARGET_FPS} durationMs=$durationMs frameCount=$diagnosticFrameCount drawCount=$diagnosticDrawCount geometryUpdateCount=$diagnosticGeometryUpdateCount timeAdvanceMs=$timeAdvanceMs firstComputedX=$diagnosticFirstComputedX lastComputedX=$diagnosticLastComputedX computedRangePx=$computedRangePx firstDrawX=$diagnosticFirstDrawX lastDrawX=$diagnosticLastDrawX drawRangePx=$drawRangePx particleCount=${particles.size} spriteCount=${sprites.size} spriteBytes=$spriteBytes opacityBoost=$opacityBoost minBaseAlpha=$minBaseAlpha maxBaseAlpha=$maxBaseAlpha",
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
    const val BASE_OPACITY = 0.64
    const val DIAGNOSTIC_TAG = "JunLuoFogView"
    const val DUST_BLUE = 90
    const val DUST_GREEN = 149
    const val DUST_RED = 194
    const val EFFECT_DUST = "dust"
    const val EFFECT_FOG = "fog"
    const val NANOS_PER_MILLISECOND = 1_000_000.0
    const val OVERLAY_OPACITY = 0.14
    const val PARTICLE_FIELD_COUNT = 7
    const val POSITION_FIELD_COUNT = 2
  }
}
