package com.anonymous.junluo.weather

import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.min
import kotlin.math.sin

internal data class JunLuoFogPosition(
  val progress: Double,
  val x: Double,
  val y: Double,
)

internal object JunLuoFogMath {
  fun position(
    particle: JunLuoRainParticleSpec,
    timeMs: Double,
    logicalWidth: Double,
    logicalHeight: Double,
    verticalDriftScale: Double = 0.0,
  ): JunLuoFogPosition {
    val travelWidth = logicalWidth + 120.0
    val rawX = particle.x * logicalWidth +
      (timeMs / 1000.0) * particle.speed +
      sin(timeMs / 1400.0 + particle.phase) * particle.drift
    val progress = modulo(rawX, travelWidth) / travelWidth
    return JunLuoFogPosition(
      progress = progress,
      x = progress * travelWidth - 60.0,
      y = particle.y * logicalHeight +
        sin(timeMs / DUST_VERTICAL_DRIFT_PERIOD_MS + particle.phase) * particle.drift * verticalDriftScale,
    )
  }

  fun writeParticle(
    particle: JunLuoRainParticleSpec,
    timeMs: Double,
    logicalWidth: Double,
    logicalHeight: Double,
    density: Float,
    positions: FloatArray,
    positionOffset: Int,
    opacities: FloatArray,
    opacityOffset: Int,
    verticalDriftScale: Double = 0.0,
  ) {
    val travelWidth = logicalWidth + 120.0
    val rawX = particle.x * logicalWidth +
      (timeMs / 1000.0) * particle.speed +
      sin(timeMs / 1400.0 + particle.phase) * particle.drift
    val progress = modulo(rawX, travelWidth) / travelWidth
    positions[positionOffset] = ((progress * travelWidth - 60.0) * density).toFloat()
    positions[positionOffset + 1] = ((particle.y * logicalHeight +
      sin(timeMs / DUST_VERTICAL_DRIFT_PERIOD_MS + particle.phase) * particle.drift * verticalDriftScale) * density).toFloat()
    opacities[opacityOffset] = (particle.opacity * cycleFade(progress)).toFloat()
  }

  const val DUST_VERTICAL_DRIFT_SCALE = 0.28
  private const val DUST_VERTICAL_DRIFT_PERIOD_MS = 420.0

  private fun cycleFade(progress: Double): Double {
    val fadeRange = 0.18
    if (progress < fadeRange) return progress / fadeRange
    if (progress > 1.0 - fadeRange) return (1.0 - progress) / fadeRange
    return 1.0
  }

  private fun modulo(value: Double, modulus: Double): Double =
    ((value % modulus) + modulus) % modulus
}

internal object JunLuoFogSpriteMath {
  const val BLUR_RADIUS = 26.0
  const val MAX_PIXEL_RATIO = 1.5
  const val MAX_SPRITE_BYTES = 4L * 1024L * 1024L
  val SIZE_BUCKETS = doubleArrayOf(34.0, 58.0, 82.0, 106.0)

  fun bucketIndex(size: Double): Int {
    var bestIndex = 0
    var bestDistance = Double.POSITIVE_INFINITY
    for (index in SIZE_BUCKETS.indices) {
      val distance = abs(SIZE_BUCKETS[index] - size)
      if (distance < bestDistance) {
        bestDistance = distance
        bestIndex = index
      }
    }
    return bestIndex
  }

  fun pixelSize(bucketSize: Double, density: Double): Int {
    val pixelRatio = min(density, MAX_PIXEL_RATIO)
    val outerRadius = bucketSize + BLUR_RADIUS * 3.0
    return ceil(outerRadius * 2.0 * pixelRatio).toInt()
  }

  fun totalBytes(density: Double): Long = SIZE_BUCKETS.sumOf { bucketSize ->
    val size = pixelSize(bucketSize, density).toLong()
    size * size * ARGB_BYTES_PER_PIXEL
  }

  private const val ARGB_BYTES_PER_PIXEL = 4L
}
