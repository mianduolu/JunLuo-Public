import type { WeatherKind } from '../types/weather';

export type WeatherParticleEffectDefinition = {
  weatherKind: Exclude<WeatherKind, 'clear' | 'unknown' | 'thunderstorm'>;
  effectId: string;
  assetId: string;
  particleCount: number;
  sizeRange: readonly [number, number];
  speedRange: readonly [number, number];
  opacityRange: readonly [number, number];
  driftRange: readonly [number, number];
  layerOpacity: number;
};

export const WEATHER_ANIMATION_STYLE_DEFINITION = Object.freeze({
  styleId: 'junluo-procedural-weather',
  styleVersion: 1,
  rendererFamily: 'procedural-skia',
  transitionDurationMs: 1000,
  nightStars: {
    effectId: 'night-stars-v1',
    assetId: 'procedural/night-stars-v1',
    particleCount: 66,
    sizeRange: [0.7, 2.05] as const,
    opacityRange: [0.34, 0.8] as const,
    pulseDurationRangeMs: [260, 680] as const,
  },
  effects: {
    cloudy: {
      weatherKind: 'cloudy',
      effectId: 'cloud-blob-v1',
      assetId: 'procedural/cloud-blob-v1',
      particleCount: 14,
      sizeRange: [62, 154],
      speedRange: [5, 10],
      opacityRange: [0.42, 0.6],
      driftRange: [0.8, 2],
      layerOpacity: 1,
    },
    rain: {
      weatherKind: 'rain',
      effectId: 'rain-streak-v1',
      assetId: 'procedural/rain-streak-v1',
      particleCount: 32,
      sizeRange: [1, 1],
      speedRange: [395, 530],
      opacityRange: [1, 1],
      driftRange: [0, 0],
      layerOpacity: 0.42,
    },
    snow: {
      weatherKind: 'snow',
      effectId: 'snow-flake-v1',
      assetId: 'procedural/snow-flake-v1',
      particleCount: 28,
      sizeRange: [1.8, 4.2],
      speedRange: [42, 76],
      opacityRange: [0.42, 0.64],
      driftRange: [8, 26],
      layerOpacity: 0.54,
    },
    hail: {
      weatherKind: 'hail',
      effectId: 'hail-stone-v1',
      assetId: 'procedural/hail-stone-v1',
      particleCount: 16,
      sizeRange: [3.8, 6.6],
      speedRange: [345, 495],
      opacityRange: [0.52, 0.76],
      driftRange: [0, 0],
      layerOpacity: 0.48,
    },
    fog: {
      weatherKind: 'fog',
      effectId: 'fog-mist-v1',
      assetId: 'procedural/fog-mist-v1',
      particleCount: 38,
      sizeRange: [34, 106],
      speedRange: [5, 10],
      opacityRange: [0.14, 0.26],
      driftRange: [8, 30],
      layerOpacity: 0.66,
    },
    dust: {
      weatherKind: 'dust',
      effectId: 'dust-mist-v1',
      assetId: 'procedural/dust-mist-v1',
      particleCount: 38,
      sizeRange: [34, 106],
      speedRange: [5, 10],
      opacityRange: [0.14, 0.26],
      driftRange: [8, 30],
      layerOpacity: 0.72,
    },
  } satisfies Record<
    WeatherParticleEffectDefinition['weatherKind'],
    WeatherParticleEffectDefinition
  >,
});

export type WeatherAnimationStyleDefinition =
  typeof WEATHER_ANIMATION_STYLE_DEFINITION;
