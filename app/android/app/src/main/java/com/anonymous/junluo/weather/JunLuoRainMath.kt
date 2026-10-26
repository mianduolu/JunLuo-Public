package com.anonymous.junluo.weather

internal data class JunLuoRainParticleSpec(
  val x: Double,
  val y: Double,
  val size: Double,
  val speed: Double,
  val opacity: Double,
  val drift: Double,
  val phase: Double,
)

internal data class JunLuoRainPosition(val x: Double, val y: Double)

internal object JunLuoRainMath {
  fun layerOpacity(
    timeMs: Double,
    startedAtMs: Double,
    exitingAtMs: Double?,
    transitionDurationMs: Double,
    layerOpacity: Double,
  ): Double {
    if (transitionDurationMs <= 0.0) return layerOpacity.coerceIn(0.0, 1.0)
    val transitionOpacity = if (exitingAtMs != null) {
      1.0 - (timeMs - exitingAtMs) / transitionDurationMs
    } else {
      (timeMs - startedAtMs) / transitionDurationMs
    }
    return (transitionOpacity.coerceIn(0.0, 1.0) * layerOpacity).coerceIn(0.0, 1.0)
  }

  fun monotonicWallTimeMs(
    wallTimeBaseMs: Double,
    monotonicBaseMs: Double,
    monotonicNowMs: Double,
  ): Double = wallTimeBaseMs + (monotonicNowMs - monotonicBaseMs)

  fun position(
    particle: JunLuoRainParticleSpec,
    timeMs: Double,
    logicalWidth: Double,
    logicalHeight: Double,
  ): JunLuoRainPosition {
    val y = positionY(particle, timeMs, logicalHeight)
    return JunLuoRainPosition(
      x = particle.x * logicalWidth + y * 0.025,
      y = y,
    )
  }

  fun writeLinePoints(
    particle: JunLuoRainParticleSpec,
    timeMs: Double,
    logicalWidth: Double,
    logicalHeight: Double,
    density: Float,
    points: FloatArray,
    offset: Int,
  ) {
    val y = positionY(particle, timeMs, logicalHeight)
    val x = particle.x * logicalWidth + y * 0.025
    val canvasX = (x * density).toFloat()
    val canvasY = (y * density).toFloat()
    points[offset] = canvasX
    points[offset + 1] = canvasY
    points[offset + 2] = canvasX
    points[offset + 3] = canvasY + 20f * density
  }

  fun writeHailCircle(
    particle: JunLuoRainParticleSpec,
    timeMs: Double,
    logicalWidth: Double,
    logicalHeight: Double,
    density: Float,
    circles: FloatArray,
    offset: Int,
  ) {
    val y = positionY(particle, timeMs, logicalHeight)
    val travelWidth = logicalWidth + 40.0
    val x = modulo(particle.x * logicalWidth, travelWidth) - 20.0
    circles[offset] = (x * density).toFloat()
    circles[offset + 1] = (y * density).toFloat()
    circles[offset + 2] = (particle.size * density).toFloat()
  }

  fun writeSnowCircle(
    particle: JunLuoRainParticleSpec,
    timeMs: Double,
    logicalWidth: Double,
    logicalHeight: Double,
    density: Float,
    circles: FloatArray,
    offset: Int,
  ) {
    val y = positionY(particle, timeMs, logicalHeight)
    val travelWidth = logicalWidth + 40.0
    val sway = kotlin.math.sin(timeMs / 900.0 + particle.phase) * particle.drift
    val x = modulo(particle.x * logicalWidth + sway, travelWidth) - 20.0
    circles[offset] = (x * density).toFloat()
    circles[offset + 1] = (y * density).toFloat()
    circles[offset + 2] = (particle.size * density).toFloat()
  }

  private fun positionY(
    particle: JunLuoRainParticleSpec,
    timeMs: Double,
    logicalHeight: Double,
  ): Double {
    val travelHeight = logicalHeight + 80.0
    val rawY = particle.y + (timeMs / 1000.0) * particle.speed
    return modulo(rawY, travelHeight) - 40.0
  }

  private fun modulo(value: Double, modulus: Double): Double =
    ((value % modulus) + modulus) % modulus
}
