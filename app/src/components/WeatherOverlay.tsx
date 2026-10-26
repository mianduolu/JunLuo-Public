import { BlurMask, Canvas, Circle, drawAsImage, Group, Image, Line, LinearGradient, Path, Rect, type SkImage, vec } from '@shopify/react-native-skia';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, PixelRatio, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useDerivedValue, useFrameCallback, useSharedValue, type FrameInfo, type SharedValue } from 'react-native-reanimated';

import {
  JunLuoRainView,
  type JunLuoRainRendererState,
} from './JunLuoRainView';
import { JunLuoFogView } from './JunLuoFogView';
import type { WeatherKind } from '../types/weather';
import type { SkyTheme } from '../utils/sky';
import {
  WEATHER_ANIMATION_STYLE_DEFINITION,
} from '../weather/weatherAnimationStyle';

type Props = {
  active?: boolean;
  cloudRenderingMode?: CloudRenderingMode;
  diagnosticCloudSpriteMode?: CloudSpriteRenderingMode;
  diagnosticDustMode?: DustDiagnosticMode;
  diagnosticThunderstormLightningMode?: ThunderstormLightningRenderingMode;
  diagnosticFogMode?: FogDiagnosticMode;
  dustRenderingMode?: DustRenderingMode;
  fogRenderingMode?: FogRenderingMode;
  hailRenderingMode?: HailRenderingMode;
  kind: WeatherKind;
  diagnosticHailMode?: HailDiagnosticMode;
  diagnosticRainMode?: RainDiagnosticMode;
  diagnosticSnowMode?: SnowDiagnosticMode;
  rainRenderingMode?: RainRenderingMode;
  snowRenderingMode?: SnowRenderingMode;
  starRenderingMode?: StarRenderingMode;
  theme: SkyTheme;
};

export type RainRenderingMode = 'legacy' | 'canvas';
export type PrecipitationDiagnosticMode = 'canvas-static' | 'native-static' | 'native-dynamic';
export type HailDiagnosticMode = PrecipitationDiagnosticMode;
export type RainDiagnosticMode = PrecipitationDiagnosticMode;
export type SnowDiagnosticMode = PrecipitationDiagnosticMode;
export type DustDiagnosticMode = PrecipitationDiagnosticMode;
export type FogDiagnosticMode =
  | 'full'
  | 'static-blurred'
  | 'moving-solid'
  | 'canvas-static'
  | 'native-static'
  | 'native-dynamic'
  | 'native-dynamic-115x'
  | 'native-dynamic-2x'
  | 'native-dynamic-4x';
export type ThunderstormLightningRenderingMode = 'paths' | 'cached-images';
export type CloudSpriteRenderingMode = 'rebuild' | 'stable-pool';
export type CloudRenderingMode = RainRenderingMode;
export type DustRenderingMode = RainRenderingMode;
export type SnowRenderingMode = RainRenderingMode;
export type FogRenderingMode = RainRenderingMode;
export type HailRenderingMode = RainRenderingMode;
export type StarRenderingMode = RainRenderingMode | 'static';

type WeatherLayerKind = Exclude<WeatherKind, 'clear' | 'unknown'>;
type ParticleKind = Exclude<WeatherLayerKind, 'thunderstorm'>;

type ParticleLayer = {
  id: number;
  kind: WeatherLayerKind;
  seed: number;
  startedAt: number;
  exitingAt?: number;
};

type NativePrecipitationLayer = ParticleLayer & {
  generation: number;
  kind: 'hail' | 'rain' | 'snow';
  particles: Particle[];
};

type NativeFogLayer = ParticleLayer & {
  generation: number;
  kind: 'fog';
  particles: Particle[];
};

type NativeDustLayer = ParticleLayer & {
  generation: number;
  kind: 'dust';
  particles: Particle[];
};

type Particle = {
  x: number;
  y: number;
  size: number;
  speed: number;
  opacity: number;
  drift: number;
  phase: number;
  shape?: number[];
};

type CloudSprite = {
  height: number;
  image: SkImage;
  width: number;
};

type Star = {
  x: number;
  y: number;
  size: number;
  opacity: number;
  pulseSpeed: number;
  phase: number;
};

type LightningTiming = {
  delayMs: number;
  periodMs: number;
};

type LightningBolt = LightningTiming & {
  path: string;
};

type LightningSpriteSet = {
  images: SkImage[];
  key: string;
};

type LightningSpriteRequest = {
  key: string;
  promise: Promise<LightningSpriteSet>;
};

let layerId = 0;
let stableCloudSpritePool: CloudSprite[] | null = null;
let stableCloudSpritePoolRequest: Promise<CloudSprite[]> | null = null;
let lightningSpriteCache: LightningSpriteSet | null = null;
let lightningSpriteRequest: LightningSpriteRequest | null = null;
const FAST_WEATHER_FRAME_INTERVAL_MS = 1000 / 24;
const SLOW_WEATHER_FRAME_INTERVAL_MS = 1000 / 12;
const STAR_TWINKLE_FRAME_INTERVAL_MS = 360;
const R3A_FIXED_RAIN_SEED = 13;
const R3A_FIXED_RAIN_TIME_MS = 12_345;
const R3H_FIXED_HAIL_SEED = 29;
const R3H_FIXED_HAIL_TIME_MS = 12_345;
const R3S_FIXED_SNOW_SEED = 37;
const R3S_FIXED_SNOW_TIME_MS = 12_345;
const R3F_FIXED_FOG_SEED = 43;
const R3F_FIXED_FOG_TIME_MS = 12_345;
const R5D_FIXED_DUST_SEED = 47;
const R5D_FIXED_DUST_TIME_MS = 12_345;
const R4F_FOG_PARTICLE_COUNT = 26;
const NATIVE_FOG_OPACITY_SCALE = 1.15;
const STAR_CANVAS_TWINKLE_PERIOD_RANGE_MS = [3_000, 5_000] as const;
const THUNDERSTORM_CLOUD_SEED = 1_913;
const CLOUD_TEXTURE_BLUR_PX = 5;
const CLOUD_TEXTURE_PADDING_PX = CLOUD_TEXTURE_BLUR_PX * 4;
// Cloud blobs are already intentionally soft. Capping only their offscreen
// supersampling avoids fourteen high-density blur surfaces exhausting older
// Android devices without changing their logical size or animation contract.
const CLOUD_TEXTURE_PIXEL_RATIO = Math.min(PixelRatio.get(), 1.5);
const LIGHTNING_TEXTURE_PIXEL_RATIO = Math.min(PixelRatio.get(), 1.5);
const LIGHTNING_TEXTURE_CACHE_LIMIT = 1;
const LIGHTNING_BOLT_TIMINGS = [
  { delayMs: 650, periodMs: 13_700 },
  { delayMs: 5_300, periodMs: 17_300 },
  { delayMs: 9_800, periodMs: 19_100 },
] as const satisfies readonly LightningTiming[];
const DEV_WEATHER_PERFORMANCE_DIAGNOSTICS =
  __DEV__ && process.env.EXPO_PUBLIC_JUNLUO_RUNTIME_DIAGNOSTICS === '1';
const NATIVE_PRECIPITATION_HOME_DIAGNOSTICS =
  process.env.EXPO_PUBLIC_JUNLUO_RAIN_HOME_DIAGNOSTICS === '1'
  || process.env.EXPO_PUBLIC_JUNLUO_HAIL_HOME_DIAGNOSTICS === '1'
  || process.env.EXPO_PUBLIC_JUNLUO_SNOW_HOME_DIAGNOSTICS === '1';
const NATIVE_FOG_HOME_DIAGNOSTICS =
  process.env.EXPO_PUBLIC_JUNLUO_FOG_HOME_DIAGNOSTICS === '1';
const NATIVE_DUST_HOME_DIAGNOSTICS =
  process.env.EXPO_PUBLIC_JUNLUO_DUST_HOME_DIAGNOSTICS === '1';

export const WeatherOverlay = memo(function WeatherOverlay({
  active = true,
  cloudRenderingMode = 'canvas',
  diagnosticCloudSpriteMode,
  diagnosticDustMode,
  diagnosticFogMode = 'full',
  diagnosticThunderstormLightningMode = 'cached-images',
  dustRenderingMode = 'canvas',
  fogRenderingMode = 'canvas',
  kind,
  diagnosticHailMode,
  diagnosticRainMode,
  diagnosticSnowMode,
  hailRenderingMode = 'canvas',
  rainRenderingMode = 'canvas',
  snowRenderingMode = 'canvas',
  theme,
  starRenderingMode = 'canvas',
}: Props) {
  const { width, height } = useWindowDimensions();
  const [time, setTime] = useState(Date.now());
  const [isAppActive, setIsAppActive] = useState(AppState.currentState === 'active');
  const [layers, setLayers] = useState<ParticleLayer[]>([]);
  const [diagnosticNativePrecipitationContentReady, setDiagnosticNativePrecipitationContentReady] = useState(false);
  const [diagnosticNativeDustContentReady, setDiagnosticNativeDustContentReady] = useState(false);
  const [diagnosticNativeFogContentReady, setDiagnosticNativeFogContentReady] = useState(false);
  const [nativePrecipitationReadyGenerations, setNativePrecipitationReadyGenerations] = useState<number[]>([]);
  const [nativeFogReadyGenerations, setNativeFogReadyGenerations] = useState<number[]>([]);
  const [nativeDustReadyGenerations, setNativeDustReadyGenerations] = useState<number[]>([]);
  const currentKind = useRef<WeatherKind>('unknown');
  const diagnosticPrecipitationGeneration = useRef(1).current;
  const diagnosticFogGeneration = useRef(2).current;
  const diagnosticDustGeneration = useRef(3).current;
  const diagnosticRenderCount = useRef(0);
  if (DEV_WEATHER_PERFORMANCE_DIAGNOSTICS) {
    diagnosticRenderCount.current += 1;
  }
  const starSeed = getNightStarSeed(new Date(time));
  const stars = useMemo(() => createStars(starSeed), [starSeed]);
  const diagnosticRainParticles = useMemo(
    () => createParticles('rain', R3A_FIXED_RAIN_SEED),
    [],
  );
  const diagnosticHailParticles = useMemo(
    () => createParticles('hail', R3H_FIXED_HAIL_SEED),
    [],
  );
  const diagnosticSnowParticles = useMemo(
    () => createParticles('snow', R3S_FIXED_SNOW_SEED),
    [],
  );
  const diagnosticFogParticles = useMemo(
    () => createParticles('fog', R3F_FIXED_FOG_SEED),
    [],
  );
  const diagnosticDustParticles = useMemo(
    () => createParticles('dust', R5D_FIXED_DUST_SEED),
    [],
  );
  const diagnosticFogCandidateParticles = useMemo(
    () => diagnosticFogParticles.slice(0, R4F_FOG_PARTICLE_COUNT),
    [diagnosticFogParticles],
  );
  const isDiagnosticFogTreatment = kind === 'fog'
    && (
      diagnosticFogMode === 'canvas-static'
      || diagnosticFogMode === 'native-static'
      || diagnosticFogMode === 'native-dynamic'
      || diagnosticFogMode === 'native-dynamic-115x'
      || diagnosticFogMode === 'native-dynamic-2x'
      || diagnosticFogMode === 'native-dynamic-4x'
    );
  const isDiagnosticFogDynamic = diagnosticFogMode === 'native-dynamic'
    || diagnosticFogMode === 'native-dynamic-115x'
    || diagnosticFogMode === 'native-dynamic-2x'
    || diagnosticFogMode === 'native-dynamic-4x';
  const diagnosticFogOpacityScale = diagnosticFogMode === 'native-dynamic-4x'
    ? 4
    : diagnosticFogMode === 'native-dynamic-2x'
      ? 2
      : diagnosticFogMode === 'native-dynamic-115x'
        ? 1.15
        : 1;
  const isDiagnosticDustTreatment = kind === 'dust'
    && diagnosticDustMode !== undefined;
  const diagnosticPrecipitationKind = kind === 'rain' && diagnosticRainMode !== undefined
    ? 'rain'
    : kind === 'hail' && diagnosticHailMode !== undefined
      ? 'hail'
      : kind === 'snow' && diagnosticSnowMode !== undefined
        ? 'snow'
        : undefined;
  const diagnosticPrecipitationMode = diagnosticPrecipitationKind === 'rain'
    ? diagnosticRainMode
    : diagnosticPrecipitationKind === 'hail'
      ? diagnosticHailMode
      : diagnosticPrecipitationKind === 'snow'
        ? diagnosticSnowMode
        : undefined;
  const isDiagnosticPrecipitation = diagnosticPrecipitationKind !== undefined;
  const diagnosticPrecipitationParticles = diagnosticPrecipitationKind === 'hail'
    ? diagnosticHailParticles
    : diagnosticPrecipitationKind === 'snow'
      ? diagnosticSnowParticles
      : diagnosticRainParticles;
  const nativePrecipitationLayers = useMemo<NativePrecipitationLayer[]>(() => {
    if (isDiagnosticPrecipitation || layers.length === 0 || layers.length > 2) return [];
    const precipitationKind = layers[0].kind;
    if (precipitationKind !== 'rain' && precipitationKind !== 'hail' && precipitationKind !== 'snow') return [];
    if (layers.some((layer) => layer.kind !== precipitationKind)) return [];
    if (precipitationKind === 'rain' && rainRenderingMode !== 'canvas') return [];
    if (precipitationKind === 'hail' && hailRenderingMode !== 'canvas') return [];
    if (precipitationKind === 'snow' && snowRenderingMode !== 'canvas') return [];
    return layers.map((layer) => ({
      ...layer,
      generation: layer.id + 1,
      kind: precipitationKind,
      particles: createParticles(precipitationKind, layer.seed),
    }));
  }, [hailRenderingMode, isDiagnosticPrecipitation, layers, rainRenderingMode, snowRenderingMode]);
  const nativePrecipitationGenerationKey = nativePrecipitationLayers.map((layer) => layer.generation).join(',');
  const nativePrecipitationGenerationSet = useMemo(
    () => new Set(nativePrecipitationLayers.map((layer) => layer.generation)),
    [nativePrecipitationLayers],
  );
  const nativePrecipitationReadySet = useMemo(
    () => new Set(nativePrecipitationReadyGenerations),
    [nativePrecipitationReadyGenerations],
  );
  const nativeFogLayers = useMemo<NativeFogLayer[]>(() => {
    if (isDiagnosticFogTreatment || layers.length === 0 || layers.length > 2) return [];
    if (layers.some((layer) => layer.kind !== 'fog')) return [];
    if (fogRenderingMode !== 'canvas') return [];
    return layers.map((layer) => ({
      ...layer,
      generation: layer.id + 1,
      kind: 'fog',
      particles: createParticles('fog', layer.seed).slice(0, R4F_FOG_PARTICLE_COUNT),
    }));
  }, [fogRenderingMode, isDiagnosticFogTreatment, layers]);
  const nativeFogGenerationKey = nativeFogLayers.map((layer) => layer.generation).join(',');
  const nativeFogGenerationSet = useMemo(
    () => new Set(nativeFogLayers.map((layer) => layer.generation)),
    [nativeFogLayers],
  );
  const nativeFogReadySet = useMemo(
    () => new Set(nativeFogReadyGenerations),
    [nativeFogReadyGenerations],
  );
  const nativeDustLayers = useMemo<NativeDustLayer[]>(() => {
    if (isDiagnosticDustTreatment || layers.length === 0 || layers.length > 2) return [];
    if (layers.some((layer) => layer.kind !== 'dust')) return [];
    if (dustRenderingMode !== 'canvas') return [];
    return layers.map((layer) => ({
      ...layer,
      generation: layer.id + 1,
      kind: 'dust',
      particles: createParticles('dust', layer.seed),
    }));
  }, [dustRenderingMode, isDiagnosticDustTreatment, layers]);
  const nativeDustGenerationKey = nativeDustLayers.map((layer) => layer.generation).join(',');
  const nativeDustGenerationSet = useMemo(
    () => new Set(nativeDustLayers.map((layer) => layer.generation)),
    [nativeDustLayers],
  );
  const nativeDustReadySet = useMemo(
    () => new Set(nativeDustReadyGenerations),
    [nativeDustReadyGenerations],
  );
  const hasFadingLayer = layers.some((layer) => layer.exitingAt !== undefined || getLayerOpacity(layer, time) < 1);
  const isNightSky = theme.key === 'night' || theme.key === 'midnight';
  const hasWeatherLayer = layers.some(
    (layer) =>
      layer.kind !== 'thunderstorm'
      && (layer.kind !== 'rain' || rainRenderingMode === 'legacy')
      && (layer.kind !== 'snow' || snowRenderingMode === 'legacy')
      && (layer.kind !== 'fog' || fogRenderingMode === 'legacy')
      && (layer.kind !== 'hail' || hailRenderingMode === 'legacy')
      && (layer.kind !== 'cloudy' || cloudRenderingMode === 'legacy')
      && (layer.kind !== 'dust' || dustRenderingMode === 'legacy'),
  );
  const surfaceActive = active && isAppActive;
  const shouldAnimate =
    !isDiagnosticPrecipitation
    && !isDiagnosticDustTreatment
    && !isDiagnosticFogTreatment
    && surfaceActive
    && (hasFadingLayer || hasWeatherLayer || (starRenderingMode === 'legacy' && isNightSky && (kind === 'clear' || kind === 'unknown')));
  const hasFastWeatherLayer = layers.some(
    (layer) =>
      (layer.kind === 'snow' && (snowRenderingMode === 'legacy' || hasFadingLayer))
      || (layer.kind === 'hail' && (hailRenderingMode === 'legacy' || hasFadingLayer))
      || (layer.kind === 'rain' && (rainRenderingMode === 'legacy' || hasFadingLayer))
      || (layer.kind === 'thunderstorm' && hasFadingLayer),
  );
  const hasSlowWeatherLayer = layers.some(
    (layer) =>
      (layer.kind === 'cloudy' && (cloudRenderingMode === 'legacy' || hasFadingLayer))
      || (layer.kind === 'dust' && (dustRenderingMode === 'legacy' || hasFadingLayer))
      || (layer.kind === 'fog' && (fogRenderingMode === 'legacy' || hasFadingLayer)),
  );
  const hasFastCanvasLayer = layers.some(
    (layer) =>
      layer.kind === 'thunderstorm'
      || (
        layer.kind === 'rain'
        && rainRenderingMode === 'canvas'
        && !nativePrecipitationReadySet.has(layer.id + 1)
      )
      || (
        layer.kind === 'snow'
        && snowRenderingMode === 'canvas'
        && !nativePrecipitationReadySet.has(layer.id + 1)
      )
      || (
        layer.kind === 'hail'
        && hailRenderingMode === 'canvas'
        && !nativePrecipitationReadySet.has(layer.id + 1)
      ),
  );
  const hasSlowCanvasLayer = layers.some(
    (layer) =>
      (layer.kind === 'cloudy' && cloudRenderingMode === 'canvas')
      || (
        layer.kind === 'fog'
        && fogRenderingMode === 'canvas'
        && !nativeFogReadySet.has(layer.id + 1)
      )
      || (
        layer.kind === 'dust'
        && dustRenderingMode === 'canvas'
        && !nativeDustReadySet.has(layer.id + 1)
      ),
  );
  const canvasFrameIntervalMs = isDiagnosticPrecipitation
    || isDiagnosticDustTreatment
    || isDiagnosticFogTreatment
    ? null
    : hasFastCanvasLayer
      ? FAST_WEATHER_FRAME_INTERVAL_MS
      : hasSlowCanvasLayer
        ? SLOW_WEATHER_FRAME_INTERVAL_MS
        : null;
  const canvasTime = useCanvasWeatherTime(surfaceActive, canvasFrameIntervalMs);

  useEffect(() => {
    setDiagnosticNativePrecipitationContentReady(false);
  }, [diagnosticPrecipitationKind, diagnosticPrecipitationMode]);

  useEffect(() => {
    setDiagnosticNativeFogContentReady(false);
  }, [diagnosticFogMode]);

  useEffect(() => {
    setDiagnosticNativeDustContentReady(false);
  }, [diagnosticDustMode]);

  useEffect(() => {
    setNativePrecipitationReadyGenerations((previous) => {
      const next = previous.filter((generation) => nativePrecipitationGenerationSet.has(generation));
      return next.length === previous.length ? previous : next;
    });
  }, [nativePrecipitationGenerationKey, nativePrecipitationGenerationSet]);

  useEffect(() => {
    setNativeFogReadyGenerations((previous) => {
      const next = previous.filter((generation) => nativeFogGenerationSet.has(generation));
      return next.length === previous.length ? previous : next;
    });
  }, [nativeFogGenerationKey, nativeFogGenerationSet]);

  useEffect(() => {
    setNativeDustReadyGenerations((previous) => {
      const next = previous.filter((generation) => nativeDustGenerationSet.has(generation));
      return next.length === previous.length ? previous : next;
    });
  }, [nativeDustGenerationKey, nativeDustGenerationSet]);

  const handleNativePrecipitationState = useCallback((event: JunLuoRainRendererState) => {
    if (event.generation !== diagnosticPrecipitationGeneration) return;
    if (event.state === 'content_ready') {
      setDiagnosticNativePrecipitationContentReady(true);
    } else if (event.state === 'unavailable') {
      setDiagnosticNativePrecipitationContentReady(false);
    }
  }, [diagnosticPrecipitationGeneration]);

  const handleBusinessNativePrecipitationState = useCallback((event: JunLuoRainRendererState) => {
    if (!nativePrecipitationGenerationSet.has(event.generation)) return;
    setNativePrecipitationReadyGenerations((previous) => {
      const isReady = previous.includes(event.generation);
      if (event.state === 'content_ready') {
        return isReady ? previous : [...previous, event.generation];
      }
      if (event.state === 'unavailable') {
        return isReady ? previous.filter((generation) => generation !== event.generation) : previous;
      }
      return previous;
    });
  }, [nativePrecipitationGenerationSet]);

  const handleNativeFogState = useCallback((event: JunLuoRainRendererState) => {
    if (event.generation !== diagnosticFogGeneration) return;
    if (event.state === 'content_ready') {
      setDiagnosticNativeFogContentReady(true);
    } else if (event.state === 'unavailable') {
      setDiagnosticNativeFogContentReady(false);
    }
  }, [diagnosticFogGeneration]);

  const handleNativeDustState = useCallback((event: JunLuoRainRendererState) => {
    if (event.generation !== diagnosticDustGeneration) return;
    if (event.state === 'content_ready') {
      setDiagnosticNativeDustContentReady(true);
    } else if (event.state === 'unavailable') {
      setDiagnosticNativeDustContentReady(false);
    }
  }, [diagnosticDustGeneration]);

  const handleBusinessNativeFogState = useCallback((event: JunLuoRainRendererState) => {
    if (!nativeFogGenerationSet.has(event.generation)) return;
    setNativeFogReadyGenerations((previous) => {
      const isReady = previous.includes(event.generation);
      if (event.state === 'content_ready') {
        return isReady ? previous : [...previous, event.generation];
      }
      if (event.state === 'unavailable') {
        return isReady ? previous.filter((generation) => generation !== event.generation) : previous;
      }
      return previous;
    });
  }, [nativeFogGenerationSet]);

  const handleBusinessNativeDustState = useCallback((event: JunLuoRainRendererState) => {
    if (!nativeDustGenerationSet.has(event.generation)) return;
    setNativeDustReadyGenerations((previous) => {
      const isReady = previous.includes(event.generation);
      if (event.state === 'content_ready') {
        return isReady ? previous : [...previous, event.generation];
      }
      if (event.state === 'unavailable') {
        return isReady ? previous.filter((generation) => generation !== event.generation) : previous;
      }
      return previous;
    });
  }, [nativeDustGenerationSet]);

  useEffect(() => {
    if (!DEV_WEATHER_PERFORMANCE_DIAGNOSTICS) return undefined;

    const startedAt = Date.now();
    const initialRenderCount = diagnosticRenderCount.current;
    return () => {
      console.info('[weather-overlay-performance]', {
        durationMs: Date.now() - startedAt,
        renderCount: diagnosticRenderCount.current - initialRenderCount + 1,
        starRenderingMode,
      });
    };
  }, [starRenderingMode]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      setIsAppActive(state === 'active');
    });

    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (!shouldAnimate) return;

    if (hasFastWeatherLayer) {
      let frameId = 0;
      let previousFrameAt = 0;

      const tick = (frameAt: number) => {
        if (frameAt - previousFrameAt >= FAST_WEATHER_FRAME_INTERVAL_MS) {
          previousFrameAt = frameAt;
          setTime(Date.now());
        }
        frameId = requestAnimationFrame(tick);
      };

      frameId = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(frameId);
    }

    const intervalId = setInterval(() => {
      setTime(Date.now());
    }, hasSlowWeatherLayer ? SLOW_WEATHER_FRAME_INTERVAL_MS : STAR_TWINKLE_FRAME_INTERVAL_MS);

    return () => clearInterval(intervalId);
  }, [hasFastWeatherLayer, hasSlowWeatherLayer, shouldAnimate]);

  useEffect(() => {
    if (kind === currentKind.current) return;
    currentKind.current = kind;
    const changedAt = Date.now();

    setLayers((previousLayers) => {
      const exitingLayers = previousLayers.map((layer) => ({
        ...layer,
        exitingAt: layer.exitingAt ?? changedAt,
      }));

      if (kind === 'clear' || kind === 'unknown') {
        return exitingLayers;
      }

      const nextLayer: ParticleLayer = {
        id: layerId,
        kind,
        seed: layerId * 97 + 13,
        startedAt: changedAt,
      };
      layerId += 1;

      return [...exitingLayers, nextLayer];
    });

    const cleanupTimer = setTimeout(() => {
      setLayers((previousLayers) => previousLayers.filter((layer) => layer.exitingAt === undefined));
    }, WEATHER_ANIMATION_STYLE_DEFINITION.transitionDurationMs + 100);

    return () => clearTimeout(cleanupTimer);
  }, [kind]);

  if (isDiagnosticDustTreatment && diagnosticDustMode) {
    const showCanvasDust = diagnosticDustMode === 'canvas-static' || !diagnosticNativeDustContentReady;
    return (
      <View pointerEvents="none" style={styles.layer}>
        <Canvas pointerEvents="none" style={styles.layer}>
          {surfaceActive ? (
            <Rect x={0} y={0} width={width} height={height}>
              <LinearGradient
                colors={[...theme.colors]}
                end={vec(width / 2, height)}
                positions={getGradientPositions(theme.colors.length)}
                start={vec(width / 2, 0)}
              />
            </Rect>
          ) : null}
          {surfaceActive && showCanvasDust ? (
            <StaticDustLayer
              height={height}
              opacityBoost={getSkyOpacityBoost('dust', getSkyTone(theme))}
              particles={diagnosticDustParticles}
              timeMs={R5D_FIXED_DUST_TIME_MS}
              width={width}
            />
          ) : null}
        </Canvas>
        {diagnosticDustMode === 'native-static' || diagnosticDustMode === 'native-dynamic' ? (
          <JunLuoFogView
            active={surfaceActive}
            animated={diagnosticDustMode === 'native-dynamic'}
            diagnosticTimeMs={diagnosticDustMode === 'native-static' ? R5D_FIXED_DUST_TIME_MS : 0}
            diagnosticsEnabled={diagnosticDustMode === 'native-dynamic'}
            effectKind="dust"
            enabled
            exitingAtMs={-1}
            generation={diagnosticDustGeneration}
            key={diagnosticDustMode}
            layerOpacity={WEATHER_ANIMATION_STYLE_DEFINITION.effects.dust.layerOpacity}
            logicalHeight={height}
            logicalWidth={width}
            onRendererStateChange={handleNativeDustState}
            opacityBoost={getSkyOpacityBoost('dust', getSkyTone(theme))}
            particles={diagnosticDustParticles}
            startedAtMs={0}
            style={styles.layer}
            transitionDurationMs={WEATHER_ANIMATION_STYLE_DEFINITION.transitionDurationMs}
          />
        ) : null}
      </View>
    );
  }

  if (isDiagnosticFogTreatment) {
    const showCanvasFog = diagnosticFogMode === 'canvas-static' || !diagnosticNativeFogContentReady;
    const fogOpacityBoost = getSkyOpacityBoost('fog', getSkyTone(theme));
    return (
      <View pointerEvents="none" style={styles.layer}>
        <Canvas pointerEvents="none" style={styles.layer}>
          {surfaceActive ? (
            <Rect x={0} y={0} width={width} height={height}>
              <LinearGradient
                colors={[...theme.colors]}
                end={vec(width / 2, height)}
                positions={getGradientPositions(theme.colors.length)}
                start={vec(width / 2, 0)}
              />
            </Rect>
          ) : null}
          {surfaceActive && showCanvasFog ? (
            <StaticFogLayer
              height={height}
              opacityBoost={fogOpacityBoost}
              particles={diagnosticFogCandidateParticles}
              timeMs={R3F_FIXED_FOG_TIME_MS}
              width={width}
            />
          ) : null}
        </Canvas>
        {diagnosticFogMode === 'native-static' || isDiagnosticFogDynamic ? (
          <JunLuoFogView
            active={surfaceActive}
            animated={isDiagnosticFogDynamic}
            diagnosticTimeMs={diagnosticFogMode === 'native-static' ? R3F_FIXED_FOG_TIME_MS : 0}
            diagnosticsEnabled={isDiagnosticFogDynamic}
            effectKind="fog"
            enabled
            exitingAtMs={-1}
            generation={diagnosticFogGeneration}
            key={diagnosticFogMode}
            layerOpacity={WEATHER_ANIMATION_STYLE_DEFINITION.effects.fog.layerOpacity}
            logicalHeight={height}
            logicalWidth={width}
            onRendererStateChange={handleNativeFogState}
            opacityBoost={fogOpacityBoost * diagnosticFogOpacityScale}
            particles={diagnosticFogCandidateParticles}
            startedAtMs={0}
            style={styles.layer}
            transitionDurationMs={WEATHER_ANIMATION_STYLE_DEFINITION.transitionDurationMs}
          />
        ) : null}
      </View>
    );
  }

  if (isDiagnosticPrecipitation && diagnosticPrecipitationKind && diagnosticPrecipitationMode) {
    const diagnosticTimeMs = diagnosticPrecipitationKind === 'hail'
      ? R3H_FIXED_HAIL_TIME_MS
      : diagnosticPrecipitationKind === 'snow'
        ? R3S_FIXED_SNOW_TIME_MS
        : R3A_FIXED_RAIN_TIME_MS;
    const showCanvasPrecipitation = diagnosticPrecipitationMode === 'canvas-static'
      || !diagnosticNativePrecipitationContentReady;
    return (
      <View pointerEvents="none" style={styles.layer}>
        <Canvas pointerEvents="none" style={styles.layer}>
          {surfaceActive ? (
            <Rect x={0} y={0} width={width} height={height}>
              <LinearGradient
                colors={[...theme.colors]}
                end={vec(width / 2, height)}
                positions={getGradientPositions(theme.colors.length)}
                start={vec(width / 2, 0)}
              />
            </Rect>
          ) : null}
          {surfaceActive && showCanvasPrecipitation
            ? diagnosticPrecipitationKind === 'hail'
              ? (
                <StaticHailLayer
                  height={height}
                  particles={diagnosticPrecipitationParticles}
                  timeMs={diagnosticTimeMs}
                  width={width}
                />
              )
              : diagnosticPrecipitationKind === 'snow'
                ? (
                  <StaticSnowLayer
                    height={height}
                    particles={diagnosticPrecipitationParticles}
                    timeMs={diagnosticTimeMs}
                    width={width}
                  />
                )
                : (
                <StaticRainLayer
                  height={height}
                  particles={diagnosticPrecipitationParticles}
                  timeMs={diagnosticTimeMs}
                  width={width}
                />
                )
            : null}
        </Canvas>
        {diagnosticPrecipitationMode === 'native-static' || diagnosticPrecipitationMode === 'native-dynamic' ? (
          <JunLuoRainView
            active={surfaceActive}
            animated={diagnosticPrecipitationMode === 'native-dynamic'}
            diagnosticTimeMs={diagnosticPrecipitationMode === 'native-static' ? diagnosticTimeMs : 0}
            diagnosticsEnabled={diagnosticPrecipitationMode === 'native-dynamic'}
            enabled
            effectKind={diagnosticPrecipitationKind}
            exitingAtMs={-1}
            generation={diagnosticPrecipitationGeneration}
            layerOpacity={1}
            logicalHeight={height}
            logicalWidth={width}
            onRendererStateChange={handleNativePrecipitationState}
            particles={diagnosticPrecipitationParticles}
            startedAtMs={0}
            style={styles.layer}
            transitionDurationMs={WEATHER_ANIMATION_STYLE_DEFINITION.transitionDurationMs}
          />
        ) : null}
      </View>
    );
  }

  const canvas = (
    <Canvas pointerEvents="none" style={styles.layer}>
      {surfaceActive ? (
        <Rect x={0} y={0} width={width} height={height}>
          <LinearGradient
            colors={[...theme.colors]}
            end={vec(width / 2, height)}
            positions={getGradientPositions(theme.colors.length)}
            start={vec(width / 2, 0)}
          />
        </Rect>
      ) : null}
      <StarLayer
        height={height}
        opacity={getStarLayerOpacity(kind, theme, layers, time)}
        stars={stars}
        isAppActive={surfaceActive}
        time={time}
        width={width}
        renderingMode={starRenderingMode}
      />
      {layers.map((layer) => (
        <Group key={layer.id} opacity={getLayerOpacity(layer, time)}>
          {(((layer.kind === 'rain' || layer.kind === 'hail' || layer.kind === 'snow')
            && nativePrecipitationReadySet.has(layer.id + 1))
            || (layer.kind === 'fog' && nativeFogReadySet.has(layer.id + 1))
            || (layer.kind === 'dust' && nativeDustReadySet.has(layer.id + 1))) ? null : (
            <WeatherCanvas
              canvasTime={canvasTime}
              cloudRenderingMode={cloudRenderingMode}
              cloudSpriteRenderingMode={
                diagnosticCloudSpriteMode
                ?? (layer.kind === 'cloudy' || layer.kind === 'thunderstorm'
                  ? 'stable-pool'
                  : 'rebuild')
              }
              thunderstormLightningRenderingMode={diagnosticThunderstormLightningMode}
              height={height}
              dustRenderingMode={dustRenderingMode}
              diagnosticFogMode={diagnosticFogMode}
              fogRenderingMode={fogRenderingMode}
              isAppActive={surfaceActive}
              hailRenderingMode={hailRenderingMode}
              kind={layer.kind}
              rainRenderingMode={rainRenderingMode}
              snowRenderingMode={snowRenderingMode}
              seed={layer.seed}
              theme={theme}
              time={time}
              width={width}
            />
          )}
        </Group>
      ))}
    </Canvas>
  );

  return (
    <View pointerEvents="none" style={styles.layer}>
      {canvas}
      {nativePrecipitationLayers.map((layer) => (
        <JunLuoRainView
          active={surfaceActive}
          animated
          diagnosticTimeMs={0}
          diagnosticsEnabled={NATIVE_PRECIPITATION_HOME_DIAGNOSTICS}
          enabled
          effectKind={layer.kind}
          exitingAtMs={layer.exitingAt ?? -1}
          generation={layer.generation}
          key={layer.generation}
          layerOpacity={1}
          logicalHeight={height}
          logicalWidth={width}
          onRendererStateChange={handleBusinessNativePrecipitationState}
          particles={layer.particles}
          startedAtMs={layer.startedAt}
          style={styles.layer}
          transitionDurationMs={WEATHER_ANIMATION_STYLE_DEFINITION.transitionDurationMs}
        />
      ))}
      {nativeFogLayers.map((layer) => (
        <JunLuoFogView
          active={surfaceActive}
          animated
          diagnosticTimeMs={0}
          diagnosticsEnabled={NATIVE_FOG_HOME_DIAGNOSTICS}
          effectKind="fog"
          enabled
          exitingAtMs={layer.exitingAt ?? -1}
          generation={layer.generation}
          key={`fog-${layer.generation}`}
          layerOpacity={WEATHER_ANIMATION_STYLE_DEFINITION.effects.fog.layerOpacity}
          logicalHeight={height}
          logicalWidth={width}
          onRendererStateChange={handleBusinessNativeFogState}
          opacityBoost={getSkyOpacityBoost('fog', getSkyTone(theme)) * NATIVE_FOG_OPACITY_SCALE}
          particles={layer.particles}
          startedAtMs={layer.startedAt}
          style={styles.layer}
          transitionDurationMs={WEATHER_ANIMATION_STYLE_DEFINITION.transitionDurationMs}
        />
      ))}
      {nativeDustLayers.map((layer) => (
        <JunLuoFogView
          active={surfaceActive}
          animated
          diagnosticTimeMs={0}
          diagnosticsEnabled={NATIVE_DUST_HOME_DIAGNOSTICS}
          effectKind="dust"
          enabled
          exitingAtMs={layer.exitingAt ?? -1}
          generation={layer.generation}
          key={`dust-${layer.generation}`}
          layerOpacity={WEATHER_ANIMATION_STYLE_DEFINITION.effects.dust.layerOpacity}
          logicalHeight={height}
          logicalWidth={width}
          onRendererStateChange={handleBusinessNativeDustState}
          opacityBoost={getSkyOpacityBoost('dust', getSkyTone(theme))}
          particles={layer.particles}
          startedAtMs={layer.startedAt}
          style={styles.layer}
          transitionDurationMs={WEATHER_ANIMATION_STYLE_DEFINITION.transitionDurationMs}
        />
      ))}
    </View>
  );
});

function StarLayer({
  height,
  isAppActive,
  opacity,
  renderingMode,
  stars,
  time,
  width,
}: {
  height: number;
  isAppActive: boolean;
  opacity: number;
  renderingMode: StarRenderingMode;
  stars: Star[];
  time: number;
  width: number;
}) {
  if (opacity <= 0) return null;
  if (renderingMode === 'canvas') {
    return isAppActive ? <CanvasDrivenStarLayer height={height} opacity={opacity} stars={stars} width={width} /> : null;
  }

  if (renderingMode === 'static') {
    return isAppActive ? <StaticStarLayer height={height} opacity={opacity} stars={stars} width={width} /> : null;
  }


  return (
    <Group opacity={opacity}>
      {stars.map((star, index) => {
        const pulse = (Math.sin(time / star.pulseSpeed + star.phase) + 1) / 2;
        const twinkle = pulse ** 2.4;
        const starOpacity = star.opacity * (0.05 + twinkle * 0.95);
        const starRadius = star.size * (0.92 + twinkle * 0.14);

        return (
          <Circle
            key={index}
            color={`rgba(255,255,255,${starOpacity})`}
            cx={star.x * width}
            cy={star.y * height}
            r={starRadius}
          >
            <BlurMask blur={0.5} style="normal" />
          </Circle>
        );
      })}
    </Group>
  );
}

function useCanvasWeatherTime(
  active: boolean,
  frameIntervalMs: number | null,
) {
  const startedAt = useRef(Date.now()).current;
  const time = useSharedValue(startedAt);
  const lastUpdateAt = useSharedValue(0);
  const updateOnFrame = useCallback(({ timestamp }: FrameInfo) => {
    'worklet';
    if (frameIntervalMs === null) return;

    if (lastUpdateAt.value === 0) {
      lastUpdateAt.value = timestamp;
      return;
    }

    const elapsed = timestamp - lastUpdateAt.value;
    if (elapsed < frameIntervalMs) return;

    const steps = Math.floor(elapsed / frameIntervalMs);
    lastUpdateAt.value += steps * frameIntervalMs;
    time.value += steps * frameIntervalMs;
  }, [frameIntervalMs, lastUpdateAt, time]);
  const frameCallback = useFrameCallback(updateOnFrame, false);

  useEffect(() => {
    const shouldRun = active && frameIntervalMs !== null;
    lastUpdateAt.value = 0;
    frameCallback.setActive(shouldRun);
    return () => frameCallback.setActive(false);
  }, [active, frameCallback, frameIntervalMs, lastUpdateAt]);

  return time;
}

const StaticStarLayer = memo(function StaticStarLayer({
  height,
  opacity,
  stars,
  width,
}: {
  height: number;
  opacity: number;
  stars: Star[];
  width: number;
}) {
  return (
    <Group opacity={opacity}>
      {stars.map((star, index) => {
        const pulse = (Math.sin(star.phase) + 1) / 2;
        const twinkle = pulse ** 2.4;
        const starOpacity = star.opacity * (0.05 + twinkle * 0.95);
        const starRadius = star.size * (0.92 + twinkle * 0.14);

        return (
          <Circle
            key={index}
            color={`rgba(255,255,255,${starOpacity})`}
            cx={star.x * width}
            cy={star.y * height}
            r={starRadius}
          >
            <BlurMask blur={0.5} style="normal" />
          </Circle>
        );
      })}
    </Group>
  );
});

function CanvasDrivenStarLayer({
  height,
  opacity,
  stars,
  width,
}: {
  height: number;
  opacity: number;
  stars: Star[];
  width: number;
}) {
  const startedAt = useRef(Date.now()).current;
  const time = useSharedValue(startedAt);

  useEffect(() => {
    const intervalId = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startedAt) / STAR_TWINKLE_FRAME_INTERVAL_MS)
        * STAR_TWINKLE_FRAME_INTERVAL_MS;
      time.value = startedAt + elapsed;
    }, STAR_TWINKLE_FRAME_INTERVAL_MS);

    return () => clearInterval(intervalId);
  }, [startedAt, time]);

  return (
    <Group opacity={opacity}>
      {stars.map((star, index) => (
        <CanvasDrivenStar
          key={index}
          height={height}
          star={star}
          time={time}
          width={width}
        />
      ))}
    </Group>
  );
}

function CanvasDrivenStar({
  height,
  star,
  time,
  width,
}: {
  height: number;
  star: Star;
  time: SharedValue<number>;
  width: number;
}) {
  const sourceRange = WEATHER_ANIMATION_STYLE_DEFINITION.nightStars.pulseDurationRangeMs;
  const sourceProgress = (star.pulseSpeed - sourceRange[0]) / (sourceRange[1] - sourceRange[0]);
  const targetRange = STAR_CANVAS_TWINKLE_PERIOD_RANGE_MS;
  const canvasPulsePeriodMs = targetRange[0] + sourceProgress * (targetRange[1] - targetRange[0]);
  const canvasPulseSpeed = canvasPulsePeriodMs / (Math.PI * 2);

  const twinkle = useDerivedValue(() => {
    'worklet';
    const pulse = (Math.sin(time.value / canvasPulseSpeed + star.phase) + 1) / 2;
    return pulse ** 2.4;
  }, [canvasPulseSpeed, star.phase, time]);
  const color = useDerivedValue(() => {
    'worklet';
    const starOpacity = star.opacity * (0.05 + twinkle.value * 0.95);
    return `rgba(255,255,255,${starOpacity})`;
  }, [star.opacity, twinkle]);
  const radius = useDerivedValue(() => {
    'worklet';
    return star.size * (0.92 + twinkle.value * 0.14);
  }, [star.size, twinkle]);

  return (
    <Circle color={color} cx={star.x * width} cy={star.y * height} r={radius}>
      <BlurMask blur={0.5} style="normal" />
    </Circle>
  );
}

function WeatherCanvas({
  canvasTime,
  cloudRenderingMode,
  cloudSpriteRenderingMode,
  thunderstormLightningRenderingMode,
  height,
  dustRenderingMode,
  diagnosticFogMode,
  fogRenderingMode,
  isAppActive,
  hailRenderingMode,
  kind,
  rainRenderingMode,
  snowRenderingMode,
  seed,
  theme,
  time,
  width,
}: {
  canvasTime: SharedValue<number>;
  cloudRenderingMode: CloudRenderingMode;
  cloudSpriteRenderingMode: CloudSpriteRenderingMode;
  thunderstormLightningRenderingMode: ThunderstormLightningRenderingMode;
  height: number;
  dustRenderingMode: DustRenderingMode;
  diagnosticFogMode: FogDiagnosticMode;
  fogRenderingMode: FogRenderingMode;
  isAppActive: boolean;
  hailRenderingMode: HailRenderingMode;
  kind: WeatherLayerKind;
  rainRenderingMode: RainRenderingMode;
  snowRenderingMode: SnowRenderingMode;
  seed: number;
  theme: SkyTheme;
  time: number;
  width: number;
}) {
  const particleKind: ParticleKind = kind === 'thunderstorm' ? 'rain' : kind;
  const particles = useMemo(() => createParticles(particleKind, seed), [particleKind, seed]);
  const tone = useMemo(() => getSkyTone(theme), [theme]);
  const cloudSprites = useCloudSprites(particleKind, particles, cloudSpriteRenderingMode);

  if (!isAppActive) return null;

  if (kind === 'thunderstorm') {
    return isAppActive ? (
      <>
        <CanvasDrivenRainLayer height={height} particles={particles} time={canvasTime} width={width} />
        <CanvasDrivenThunderstormLayer
          cloudSpriteRenderingMode={cloudSpriteRenderingMode}
          height={height}
          lightningRenderingMode={thunderstormLightningRenderingMode}
          theme={theme}
          time={canvasTime}
          width={width}
        />
      </>
    ) : null;
  }

  if (kind === 'cloudy' && cloudRenderingMode === 'canvas') {
    return isAppActive ? (
        <CanvasDrivenCloudLayer
        height={height}
        opacityBoost={getSkyOpacityBoost(kind, tone)}
        particles={particles}
          sprites={cloudSprites}
          time={canvasTime}
          width={width}
      />
    ) : null;
  }

  if (kind === 'rain') {
    if (rainRenderingMode === 'canvas') {
      return isAppActive ? (
        <CanvasDrivenRainLayer height={height} particles={particles} time={canvasTime} width={width} />
      ) : null;
    }

    return (
        <Group blendMode="overlay" opacity={WEATHER_ANIMATION_STYLE_DEFINITION.effects.rain.layerOpacity}>
          {particles.map((particle, index) => {
            const y = loop(particle.y + (time / 1000) * particle.speed, height + 80) - 40;
            const x = particle.x * width + y * 0.025;

            return (
              <Line
                key={index}
                p1={{ x, y }}
                p2={{ x, y: y + 20 }}
                color="rgba(255,255,255,0.72)"
                strokeWidth={1.2}
              />
            );
          })}
        </Group>
    );
  }

  if (kind === 'snow' && snowRenderingMode === 'canvas') {
    return isAppActive ? (
      <CanvasDrivenSnowLayer height={height} particles={particles} time={canvasTime} width={width} />
    ) : null;
  }


  if (kind === 'hail' && hailRenderingMode === 'canvas') {
    return isAppActive ? (
      <CanvasDrivenHailLayer height={height} particles={particles} time={canvasTime} width={width} />
    ) : null;
  }

  if (kind === 'snow' || kind === 'hail') {
    const isHail = kind === 'hail';

    return (
        <Group blendMode="overlay" opacity={WEATHER_ANIMATION_STYLE_DEFINITION.effects[kind].layerOpacity}>
          {particles.map((particle, index) => {
            const y = loop(particle.y + (time / 1000) * particle.speed, height + 80) - 40;
            const sway = isHail ? 0 : Math.sin(time / 900 + particle.phase) * particle.drift;
            const x = loop(particle.x * width + sway, width + 40) - 20;

            return (
              <Circle
                key={index}
                cx={x}
                cy={y}
                r={particle.size}
                color={isHail ? 'rgba(255,255,255,0.78)' : 'rgba(255,255,255,0.82)'}
              >
                {isHail ? null : <BlurMask blur={1} style="normal" />}
              </Circle>
            );
          })}
        </Group>
    );
  }
  if (kind === 'dust' && dustRenderingMode === 'canvas') {
    return isAppActive ? (
      <CanvasDrivenDustLayer
        height={height}
        opacityBoost={getSkyOpacityBoost(kind, tone)}
        particles={particles}
        time={canvasTime}
        width={width}
      />
    ) : null;
  }



  if (kind === 'fog' && fogRenderingMode === 'canvas') {
    return isAppActive ? (
      <CanvasDrivenFogLayer
        diagnosticMode={diagnosticFogMode}
        height={height}
        opacityBoost={getSkyOpacityBoost(kind, tone)}
        particles={particles}
        time={canvasTime}
        width={width}
      />
    ) : null;
  }
  return (
      <Group opacity={getMistOpacity(kind)}>
        {particles.map((particle, index) => {
          const travelWidth = width + 120;
          const rawX =
            particle.x * width +
            (time / 1000) * particle.speed +
            Math.sin(time / 1400 + particle.phase) * particle.drift;
          const progress = loop(rawX, travelWidth) / travelWidth;
          const x = progress * travelWidth - 60;
          const y =
            particle.y * height +
            (kind === 'dust' ? Math.sin(time / 420 + particle.phase) * particle.drift * 0.28 : 0);

          return (
            <WeatherMistShape
              key={index}
              cloudSprite={cloudSprites[index]}
              kind={kind}
              opacity={particle.opacity * getCycleFade(progress) * getSkyOpacityBoost(kind, tone)}
              particle={particle}
              x={x}
              y={y}
            />
          );
        })}
      </Group>
  );
}

function CanvasDrivenRainLayer({
  height,
  particles,
  time,
  width,
}: {
  height: number;
  particles: Particle[];
  time: SharedValue<number>;
  width: number;
}) {
  return (
    <Group blendMode="overlay" opacity={WEATHER_ANIMATION_STYLE_DEFINITION.effects.rain.layerOpacity}>
      {particles.map((particle, index) => (
        <CanvasDrivenRaindrop
          key={index}
          height={height}
          particle={particle}
          time={time}
          width={width}
        />
      ))}
    </Group>
  );
}

function StaticRainLayer({
  height,
  particles,
  timeMs,
  width,
}: {
  height: number;
  particles: Particle[];
  timeMs: number;
  width: number;
}) {
  return (
    <Group blendMode="overlay" opacity={WEATHER_ANIMATION_STYLE_DEFINITION.effects.rain.layerOpacity}>
      {particles.map((particle, index) => {
        const y = loop(particle.y + (timeMs / 1000) * particle.speed, height + 80) - 40;
        const x = particle.x * width + y * 0.025;
        return (
          <Line
            key={index}
            p1={{ x, y }}
            p2={{ x, y: y + 20 }}
            color="rgba(255,255,255,0.72)"
            strokeWidth={1.2}
          />
        );
      })}
    </Group>
  );
}

function StaticHailLayer({
  height,
  particles,
  timeMs,
  width,
}: {
  height: number;
  particles: Particle[];
  timeMs: number;
  width: number;
}) {
  return (
    <Group blendMode="overlay" opacity={WEATHER_ANIMATION_STYLE_DEFINITION.effects.hail.layerOpacity}>
      {particles.map((particle, index) => {
        const y = loop(particle.y + (timeMs / 1000) * particle.speed, height + 80) - 40;
        const x = loop(particle.x * width, width + 40) - 20;
        return (
          <Circle
            key={index}
            cx={x}
            cy={y}
            r={particle.size}
            color="rgba(255,255,255,0.78)"
          />
        );
      })}
    </Group>
  );
}

function StaticSnowLayer({
  height,
  particles,
  timeMs,
  width,
}: {
  height: number;
  particles: Particle[];
  timeMs: number;
  width: number;
}) {
  return (
    <Group blendMode="overlay" opacity={WEATHER_ANIMATION_STYLE_DEFINITION.effects.snow.layerOpacity}>
      {particles.map((particle, index) => {
        const y = loop(particle.y + (timeMs / 1000) * particle.speed, height + 80) - 40;
        const sway = Math.sin(timeMs / 900 + particle.phase) * particle.drift;
        const x = loop(particle.x * width + sway, width + 40) - 20;
        return (
          <Circle
            key={index}
            cx={x}
            cy={y}
            r={particle.size}
            color="rgba(255,255,255,0.82)"
          >
            <BlurMask blur={1} style="normal" />
          </Circle>
        );
      })}
    </Group>
  );
}

function CanvasDrivenThunderstormLayer({
  cloudSpriteRenderingMode,
  height,
  lightningRenderingMode,
  theme,
  time,
  width,
}: {
  cloudSpriteRenderingMode: CloudSpriteRenderingMode;
  height: number;
  lightningRenderingMode: ThunderstormLightningRenderingMode;
  theme: SkyTheme;
  time: SharedValue<number>;
  width: number;
}) {
  const particles = useMemo(
    () => createParticles('cloudy', THUNDERSTORM_CLOUD_SEED),
    [],
  );
  const sprites = useCloudSprites('cloudy', particles, cloudSpriteRenderingMode);
  const tone = useMemo(() => getSkyTone(theme), [theme]);

  return (
    <>
      <CanvasDrivenCloudLayer
        height={height}
        opacityBoost={getSkyOpacityBoost('cloudy', tone)}
        particles={particles}
        sprites={sprites}
        time={time}
        width={width}
      />
      <CanvasDrivenLightningLayer
        height={height}
        renderingMode={lightningRenderingMode}
        time={time}
        width={width}
      />
    </>
  );
}

function CanvasDrivenLightningLayer({
  height,
  renderingMode,
  time,
  width,
}: {
  height: number;
  renderingMode: ThunderstormLightningRenderingMode;
  time: SharedValue<number>;
  width: number;
}) {
  const startedAt = useRef(Date.now()).current;
  const elapsedTime = useDerivedValue(() => {
    'worklet';
    return Math.max(0, time.value - startedAt);
  }, [startedAt, time]);
  const sprites = useLightningSpriteSet(width, height, renderingMode === 'cached-images');
  const bolts = useMemo(
    () => (sprites ? [] : createLightningBolts(width, height)),
    [height, sprites, width],
  );

  return (
    <Group>
      {sprites
        ? LIGHTNING_BOLT_TIMINGS.map((timing, index) => (
            <CanvasDrivenCachedLightningBolt
              height={height}
              image={sprites.images[index]}
              key={`cached-${index}`}
              time={elapsedTime}
              timing={timing}
              width={width}
            />
          ))
        : bolts.map((bolt, index) => (
            <CanvasDrivenPathLightningBolt
              bolt={bolt}
              key={`path-${index}`}
              time={elapsedTime}
            />
          ))}
    </Group>
  );
}

function CanvasDrivenCachedLightningBolt({
  height,
  image,
  time,
  timing,
  width,
}: {
  height: number;
  image: SkImage;
  time: SharedValue<number>;
  timing: LightningTiming;
  width: number;
}) {
  const intensity = useLightningIntensity(timing, time);

  return (
    <Image
      fit="fill"
      height={height}
      image={image}
      opacity={intensity}
      width={width}
      x={0}
      y={0}
    />
  );
}

function CanvasDrivenPathLightningBolt({
  bolt,
  time,
}: {
  bolt: LightningBolt;
  time: SharedValue<number>;
}) {
  const intensity = useLightningIntensity(bolt, time);
  const glowColor = useDerivedValue(() => {
    'worklet';
    return `rgba(218,228,240,${intensity.value * 0.05})`;
  }, [intensity]);
  const middleColor = useDerivedValue(() => {
    'worklet';
    return `rgba(224,232,242,${intensity.value * 0.12})`;
  }, [intensity]);
  const coreColor = useDerivedValue(() => {
    'worklet';
    return `rgba(234,239,246,${intensity.value * 0.2})`;
  }, [intensity]);

  return (
    <>
      <Path color={glowColor} path={bolt.path} style="stroke" strokeCap="round" strokeJoin="round" strokeWidth={28}>
        <BlurMask blur={5} style="normal" />
      </Path>
      <Path color={middleColor} path={bolt.path} style="stroke" strokeCap="round" strokeJoin="round" strokeWidth={13} />
      <Path color={coreColor} path={bolt.path} style="stroke" strokeCap="round" strokeJoin="round" strokeWidth={5.5} />
    </>
  );
}

function useLightningIntensity(
  timing: LightningTiming,
  time: SharedValue<number>,
) {
  const intensity = useDerivedValue(() => {
    'worklet';
    if (time.value < timing.delayMs) return 0;

    const activeDurationMs = 1_400;
    const fadeInDurationMs = 360;
    const holdUntilMs = 540;
    const cycleTime = (time.value - timing.delayMs) % timing.periodMs;

    if (cycleTime >= activeDurationMs) return 0;
    if (cycleTime < fadeInDurationMs) return cycleTime / fadeInDurationMs;
    if (cycleTime < holdUntilMs) return 1;
    return 1 - (cycleTime - holdUntilMs) / (activeDurationMs - holdUntilMs);
  }, [time, timing.delayMs, timing.periodMs]);
  return intensity;
}

function useLightningSpriteSet(
  width: number,
  height: number,
  enabled: boolean,
) {
  const key = getLightningSpriteKey(width, height);
  const [spriteSet, setSpriteSet] = useState<LightningSpriteSet | null>(() => (
    enabled && lightningSpriteCache?.key === key ? lightningSpriteCache : null
  ));

  useEffect(() => {
    let cancelled = false;

    if (!enabled) {
      setSpriteSet(null);
      return () => {
        cancelled = true;
      };
    }

    if (lightningSpriteCache?.key === key) {
      setSpriteSet(lightningSpriteCache);
      return () => {
        cancelled = true;
      };
    }

    void loadLightningSpriteSet(width, height).then(
      (nextSpriteSet) => {
        if (!cancelled) setSpriteSet(nextSpriteSet);
      },
      () => {
        if (!cancelled) setSpriteSet(null);
      },
    );

    return () => {
      cancelled = true;
    };
  }, [enabled, height, key, width]);

  return enabled && spriteSet?.key === key ? spriteSet : null;
}

function getLightningSpriteKey(width: number, height: number) {
  const pixelWidth = Math.max(1, Math.ceil(width * LIGHTNING_TEXTURE_PIXEL_RATIO));
  const pixelHeight = Math.max(1, Math.ceil(height * LIGHTNING_TEXTURE_PIXEL_RATIO));
  return `${pixelWidth}x${pixelHeight}`;
}

function loadLightningSpriteSet(width: number, height: number) {
  const key = getLightningSpriteKey(width, height);
  if (lightningSpriteCache?.key === key) return Promise.resolve(lightningSpriteCache);
  if (lightningSpriteRequest?.key === key) return lightningSpriteRequest.promise;

  let request!: LightningSpriteRequest;
  const promise = createLightningSpriteSet(width, height, key).then(
    (nextSpriteSet) => {
      if (lightningSpriteRequest !== request) {
        disposeLightningSpriteSet(nextSpriteSet);
        throw new Error('lightning-sprite-request-superseded');
      }

      if (
        LIGHTNING_TEXTURE_CACHE_LIMIT === 1
        && lightningSpriteCache
        && lightningSpriteCache.key !== nextSpriteSet.key
      ) {
        disposeLightningSpriteSet(lightningSpriteCache);
      }
      lightningSpriteCache = nextSpriteSet;
      lightningSpriteRequest = null;
      return nextSpriteSet;
    },
    (error) => {
      if (lightningSpriteRequest === request) lightningSpriteRequest = null;
      throw error;
    },
  );
  request = { key, promise };
  lightningSpriteRequest = request;
  return promise;
}

async function createLightningSpriteSet(
  width: number,
  height: number,
  key: string,
): Promise<LightningSpriteSet> {
  const pixelWidth = Math.max(1, Math.ceil(width * LIGHTNING_TEXTURE_PIXEL_RATIO));
  const pixelHeight = Math.max(1, Math.ceil(height * LIGHTNING_TEXTURE_PIXEL_RATIO));
  const renderBolts = createLightningBolts(pixelWidth, pixelHeight);
  const images: SkImage[] = [];

  try {
    for (const bolt of renderBolts) {
      images.push(await createLightningSpriteImage(bolt, pixelWidth, pixelHeight));
    }
  } catch (error) {
    images.forEach((image) => image.dispose());
    throw error;
  }

  return { images, key };
}

async function createLightningSpriteImage(
  bolt: LightningBolt,
  pixelWidth: number,
  pixelHeight: number,
) {
  const scale = LIGHTNING_TEXTURE_PIXEL_RATIO;
  return drawAsImage(
    <>
      <Path color="rgba(218,228,240,0.05)" path={bolt.path} style="stroke" strokeCap="round" strokeJoin="round" strokeWidth={28 * scale}>
        <BlurMask blur={5 * scale} style="normal" />
      </Path>
      <Path color="rgba(224,232,242,0.12)" path={bolt.path} style="stroke" strokeCap="round" strokeJoin="round" strokeWidth={13 * scale} />
      <Path color="rgba(234,239,246,0.2)" path={bolt.path} style="stroke" strokeCap="round" strokeJoin="round" strokeWidth={5.5 * scale} />
    </>,
    { width: pixelWidth, height: pixelHeight },
  );
}

function disposeLightningSpriteSet(spriteSet: LightningSpriteSet) {
  spriteSet.images.forEach((image) => image.dispose());
}

function createLightningBolts(width: number, height: number): LightningBolt[] {
  const point = (x: number, y: number) => `${(x * width).toFixed(1)} ${(y * height).toFixed(1)}`;

  return [
    {
      ...LIGHTNING_BOLT_TIMINGS[0],
      path: [
        `M ${point(0.21, -0.12)}`,
        `L ${point(0.25, 0.08)}`,
        `L ${point(0.3, 0.19)}`,
        `L ${point(0.27, 0.3)}`,
        `L ${point(0.34, 0.41)}`,
        `L ${point(0.3, 0.53)}`,
        `L ${point(0.38, 0.65)}`,
        `L ${point(0.34, 0.76)}`,
        `L ${point(0.4, 0.89)}`,
        `L ${point(0.36, 1.03)}`,
        `L ${point(0.43, 1.13)}`,
        `M ${point(0.27, 0.3)}`,
        `L ${point(0.17, 0.39)}`,
        `L ${point(0.13, 0.49)}`,
        `M ${point(0.34, 0.41)}`,
        `L ${point(0.45, 0.49)}`,
        `L ${point(0.49, 0.57)}`,
      ].join(' '),
    },
    {
      ...LIGHTNING_BOLT_TIMINGS[1],
      path: [
        `M ${point(0.79, -0.12)}`,
        `L ${point(0.74, 0.07)}`,
        `L ${point(0.68, 0.18)}`,
        `L ${point(0.72, 0.29)}`,
        `L ${point(0.64, 0.4)}`,
        `L ${point(0.69, 0.51)}`,
        `L ${point(0.63, 0.65)}`,
        `L ${point(0.69, 0.79)}`,
        `L ${point(0.64, 0.94)}`,
        `L ${point(0.71, 1.08)}`,
        `M ${point(0.72, 0.29)}`,
        `L ${point(0.81, 0.38)}`,
        `L ${point(0.84, 0.47)}`,
        `M ${point(0.69, 0.51)}`,
        `L ${point(0.58, 0.59)}`,
      ].join(' '),
    },
    {
      ...LIGHTNING_BOLT_TIMINGS[2],
      path: [
        `M ${point(0.57, -0.12)}`,
        `L ${point(0.52, 0.11)}`,
        `L ${point(0.46, 0.22)}`,
        `L ${point(0.51, 0.33)}`,
        `L ${point(0.45, 0.44)}`,
        `L ${point(0.5, 0.55)}`,
        `L ${point(0.44, 0.69)}`,
        `L ${point(0.5, 0.82)}`,
        `L ${point(0.46, 0.97)}`,
        `L ${point(0.53, 1.1)}`,
        `M ${point(0.51, 0.33)}`,
        `L ${point(0.38, 0.41)}`,
        `L ${point(0.34, 0.5)}`,
        `M ${point(0.5, 0.55)}`,
        `L ${point(0.58, 0.62)}`,
      ].join(' '),
    },
  ];
}
function CanvasDrivenRaindrop({
  height,
  particle,
  time,
  width,
}: {
  height: number;
  particle: Particle;
  time: SharedValue<number>;
  width: number;
}) {
  const p1 = useDerivedValue(() => {
    'worklet';
    const travelHeight = height + 80;
    const rawY = particle.y + (time.value / 1000) * particle.speed;
    const y = ((rawY % travelHeight) + travelHeight) % travelHeight - 40;
    return { x: particle.x * width + y * 0.025, y };
  }, [height, particle.speed, particle.x, particle.y, time, width]);
  const p2 = useDerivedValue(() => {
    'worklet';
    return { x: p1.value.x, y: p1.value.y + 20 };
  }, [p1]);

  return (
    <Line
      p1={p1}
      p2={p2}
      color="rgba(255,255,255,0.72)"
      strokeWidth={1.2}
    />
  );
}


function CanvasDrivenSnowLayer({
  height,
  particles,
  time,
  width,
}: {
  height: number;
  particles: Particle[];
  time: SharedValue<number>;
  width: number;
}) {
  return (
    <Group blendMode="overlay" opacity={WEATHER_ANIMATION_STYLE_DEFINITION.effects.snow.layerOpacity}>
      {particles.map((particle, index) => (
        <CanvasDrivenSnowflake
          key={index}
          height={height}
          particle={particle}
          time={time}
          width={width}
        />
      ))}
    </Group>
  );
}

function CanvasDrivenSnowflake({
  height,
  particle,
  time,
  width,
}: {
  height: number;
  particle: Particle;
  time: SharedValue<number>;
  width: number;
}) {
  const cy = useDerivedValue(() => {
    'worklet';
    const travelHeight = height + 80;
    const rawY = particle.y + (time.value / 1000) * particle.speed;
    return ((rawY % travelHeight) + travelHeight) % travelHeight - 40;
  }, [height, particle.speed, particle.y, time]);
  const cx = useDerivedValue(() => {
    'worklet';
    const travelWidth = width + 40;
    const sway = Math.sin(time.value / 900 + particle.phase) * particle.drift;
    const rawX = particle.x * width + sway;
    return ((rawX % travelWidth) + travelWidth) % travelWidth - 20;
  }, [particle.drift, particle.phase, particle.x, time, width]);

  return (
    <Circle cx={cx} cy={cy} r={particle.size} color="rgba(255,255,255,0.82)">
      <BlurMask blur={1} style="normal" />
    </Circle>
  );
}

function CanvasDrivenHailLayer({
  height,
  particles,
  time,
  width,
}: {
  height: number;
  particles: Particle[];
  time: SharedValue<number>;
  width: number;
}) {
  return (
    <Group blendMode="overlay" opacity={WEATHER_ANIMATION_STYLE_DEFINITION.effects.hail.layerOpacity}>
      {particles.map((particle, index) => (
        <CanvasDrivenHailstone
          key={index}
          height={height}
          particle={particle}
          time={time}
          width={width}
        />
      ))}
    </Group>
  );
}

function CanvasDrivenHailstone({
  height,
  particle,
  time,
  width,
}: {
  height: number;
  particle: Particle;
  time: SharedValue<number>;
  width: number;
}) {
  const cy = useDerivedValue(() => {
    'worklet';
    const travelHeight = height + 80;
    const rawY = particle.y + (time.value / 1000) * particle.speed;
    return ((rawY % travelHeight) + travelHeight) % travelHeight - 40;
  }, [height, particle.speed, particle.y, time]);
  const cx = useDerivedValue(() => {
    'worklet';
    const travelWidth = width + 40;
    const rawX = particle.x * width;
    return ((rawX % travelWidth) + travelWidth) % travelWidth - 20;
  }, [particle.x, width]);

  return (
    <Circle cx={cx} cy={cy} r={particle.size} color="rgba(255,255,255,0.78)" />
  );
}

function CanvasDrivenCloudLayer({
  height,
  opacityBoost,
  particles,
  sprites,
  time,
  width,
}: {
  height: number;
  opacityBoost: number;
  particles: Particle[];
  sprites: CloudSprite[];
  time: SharedValue<number>;
  width: number;
}) {
  return (
    <Group opacity={WEATHER_ANIMATION_STYLE_DEFINITION.effects.cloudy.layerOpacity}>
      {particles.map((particle, index) => {
        const sprite = sprites[index];
        if (!sprite) return null;

        return (
          <CanvasDrivenCloudSprite
            key={index}
            height={height}
            opacityBoost={opacityBoost}
            particle={particle}
            sprite={sprite}
            time={time}
            width={width}
          />
        );
      })}
    </Group>
  );
}

function CanvasDrivenCloudSprite({
  height,
  opacityBoost,
  particle,
  sprite,
  time,
  width,
}: {
  height: number;
  opacityBoost: number;
  particle: Particle;
  sprite: CloudSprite;
  time: SharedValue<number>;
  width: number;
}) {
  const progress = useDerivedValue(() => {
    'worklet';
    const travelWidth = width + 120;
    const rawX =
      particle.x * width
      + (time.value / 1000) * particle.speed
      + Math.sin(time.value / 1400 + particle.phase) * particle.drift;
    const loopedX = ((rawX % travelWidth) + travelWidth) % travelWidth;
    return loopedX / travelWidth;
  }, [particle.drift, particle.phase, particle.speed, particle.x, time, width]);
  const imageX = useDerivedValue(() => {
    'worklet';
    return progress.value * (width + 120) - 60 - sprite.width / 2;
  }, [progress, sprite.width, width]);
  const baseOpacity = useDerivedValue(() => {
    'worklet';
    return particle.opacity * getCycleFadeWorklet(progress.value) * opacityBoost * 0.72;
  }, [opacityBoost, particle.opacity, progress]);
  const overlayOpacity = useDerivedValue(() => {
    'worklet';
    return particle.opacity * getCycleFadeWorklet(progress.value) * opacityBoost * 0.18;
  }, [opacityBoost, particle.opacity, progress]);
  const imageY = particle.y * height - sprite.height / 2;

  return (
    <>
      <Image fit="fill" height={sprite.height} image={sprite.image} opacity={baseOpacity} width={sprite.width} x={imageX} y={imageY} />
      <Image blendMode="overlay" fit="fill" height={sprite.height} image={sprite.image} opacity={overlayOpacity} width={sprite.width} x={imageX} y={imageY} />
    </>
  );
}

function CanvasDrivenFogLayer({
  diagnosticMode,
  height,
  opacityBoost,
  particles,
  time,
  width,
}: {
  diagnosticMode: FogDiagnosticMode;
  height: number;
  opacityBoost: number;
  particles: Particle[];
  time: SharedValue<number>;
  width: number;
}) {
  return (
    <Group opacity={WEATHER_ANIMATION_STYLE_DEFINITION.effects.fog.layerOpacity}>
      {particles.map((particle, index) => (
        diagnosticMode === 'static-blurred' ? (
          <StaticBlurredFogParticle
            key={index}
            height={height}
            opacityBoost={opacityBoost}
            particle={particle}
            width={width}
          />
        ) : (
          <CanvasDrivenFogParticle
            key={index}
            height={height}
            opacityBoost={opacityBoost}
            particle={particle}
            time={time}
            width={width}
            withBlur={diagnosticMode !== 'moving-solid'}
          />
        )
      ))}
    </Group>
  );
}

function StaticFogLayer({
  height,
  opacityBoost,
  particles,
  timeMs,
  width,
}: {
  height: number;
  opacityBoost: number;
  particles: Particle[];
  timeMs: number;
  width: number;
}) {
  return (
    <Group opacity={WEATHER_ANIMATION_STYLE_DEFINITION.effects.fog.layerOpacity}>
      {particles.map((particle, index) => {
        const travelWidth = width + 120;
        const rawX = particle.x * width
          + (timeMs / 1000) * particle.speed
          + Math.sin(timeMs / 1400 + particle.phase) * particle.drift;
        const progress = loop(rawX, travelWidth) / travelWidth;
        const cx = progress * travelWidth - 60;
        const cy = particle.y * height;
        const opacity = particle.opacity * getCycleFade(progress) * opacityBoost;
        return (
          <Group key={index}>
            <Circle cx={cx} cy={cy} r={particle.size} color={`rgba(255,255,255,${opacity * 0.64})`}>
              <BlurMask blur={26} style="normal" />
            </Circle>
            <Circle blendMode="overlay" cx={cx} cy={cy} r={particle.size} color={`rgba(255,255,255,${opacity * 0.14})`}>
              <BlurMask blur={26} style="normal" />
            </Circle>
          </Group>
        );
      })}
    </Group>
  );
}

function StaticDustLayer({
  height,
  opacityBoost,
  particles,
  timeMs,
  width,
}: {
  height: number;
  opacityBoost: number;
  particles: Particle[];
  timeMs: number;
  width: number;
}) {
  return (
    <Group opacity={WEATHER_ANIMATION_STYLE_DEFINITION.effects.dust.layerOpacity}>
      {particles.map((particle, index) => {
        const travelWidth = width + 120;
        const rawX = particle.x * width
          + (timeMs / 1000) * particle.speed
          + Math.sin(timeMs / 1400 + particle.phase) * particle.drift;
        const progress = loop(rawX, travelWidth) / travelWidth;
        const cx = progress * travelWidth - 60;
        const cy = particle.y * height
          + Math.sin(timeMs / 420 + particle.phase) * particle.drift * 0.28;
        const opacity = particle.opacity * getCycleFade(progress) * opacityBoost;
        return (
          <Group key={index}>
            <Circle cx={cx} cy={cy} r={particle.size} color={`rgba(194,149,90,${opacity * 0.64})`}>
              <BlurMask blur={26} style="normal" />
            </Circle>
            <Circle blendMode="overlay" cx={cx} cy={cy} r={particle.size} color={`rgba(194,149,90,${opacity * 0.14})`}>
              <BlurMask blur={26} style="normal" />
            </Circle>
          </Group>
        );
      })}
    </Group>
  );
}

function StaticBlurredFogParticle({
  height,
  opacityBoost,
  particle,
  width,
}: {
  height: number;
  opacityBoost: number;
  particle: Particle;
  width: number;
}) {
  const travelWidth = width + 120;
  const rawX = particle.x * width + Math.sin(particle.phase) * particle.drift;
  const progress = (((rawX % travelWidth) + travelWidth) % travelWidth) / travelWidth;
  const cx = progress * travelWidth - 60;
  const cy = particle.y * height;
  const opacity = particle.opacity * getCycleFadeWorklet(progress) * opacityBoost;

  return (
    <>
      <Circle cx={cx} cy={cy} r={particle.size} color={`rgba(255,255,255,${opacity * 0.64})`}>
        <BlurMask blur={26} style="normal" />
      </Circle>
      <Circle blendMode="overlay" cx={cx} cy={cy} r={particle.size} color={`rgba(255,255,255,${opacity * 0.14})`}>
        <BlurMask blur={26} style="normal" />
      </Circle>
    </>
  );
}

function CanvasDrivenFogParticle({
  height,
  opacityBoost,
  particle,
  time,
  width,
  withBlur,
}: {
  height: number;
  opacityBoost: number;
  particle: Particle;
  time: SharedValue<number>;
  width: number;
  withBlur: boolean;
}) {
  const progress = useDerivedValue(() => {
    'worklet';
    const travelWidth = width + 120;
    const rawX =
      particle.x * width
      + (time.value / 1000) * particle.speed
      + Math.sin(time.value / 1400 + particle.phase) * particle.drift;
    const loopedX = ((rawX % travelWidth) + travelWidth) % travelWidth;
    return loopedX / travelWidth;
  }, [particle.drift, particle.phase, particle.speed, particle.x, time, width]);
  const cx = useDerivedValue(() => {
    'worklet';
    return progress.value * (width + 120) - 60;
  }, [progress, width]);
  const baseColor = useDerivedValue(() => {
    'worklet';
    const opacity = particle.opacity * getCycleFadeWorklet(progress.value) * opacityBoost;
    return `rgba(255,255,255,${opacity * 0.64})`;
  }, [opacityBoost, particle.opacity, progress]);
  const overlayColor = useDerivedValue(() => {
    'worklet';
    const opacity = particle.opacity * getCycleFadeWorklet(progress.value) * opacityBoost;
    return `rgba(255,255,255,${opacity * 0.14})`;
  }, [opacityBoost, particle.opacity, progress]);
  const cy = particle.y * height;

  return (
    <>
      <Circle cx={cx} cy={cy} r={particle.size} color={baseColor}>
        {withBlur ? <BlurMask blur={26} style="normal" /> : null}
      </Circle>
      <Circle blendMode="overlay" cx={cx} cy={cy} r={particle.size} color={overlayColor}>
        {withBlur ? <BlurMask blur={26} style="normal" /> : null}
      </Circle>
    </>
  );
}

function CanvasDrivenDustLayer({
  height,
  opacityBoost,
  particles,
  time,
  width,
}: {
  height: number;
  opacityBoost: number;
  particles: Particle[];
  time: SharedValue<number>;
  width: number;
}) {
  return (
    <Group opacity={WEATHER_ANIMATION_STYLE_DEFINITION.effects.dust.layerOpacity}>
      {particles.map((particle, index) => (
        <CanvasDrivenDustParticle
          key={index}
          height={height}
          opacityBoost={opacityBoost}
          particle={particle}
          time={time}
          width={width}
        />
      ))}
    </Group>
  );
}

function CanvasDrivenDustParticle({
  height,
  opacityBoost,
  particle,
  time,
  width,
}: {
  height: number;
  opacityBoost: number;
  particle: Particle;
  time: SharedValue<number>;
  width: number;
}) {
  const progress = useDerivedValue(() => {
    'worklet';
    const travelWidth = width + 120;
    const rawX =
      particle.x * width
      + (time.value / 1000) * particle.speed
      + Math.sin(time.value / 1400 + particle.phase) * particle.drift;
    const loopedX = ((rawX % travelWidth) + travelWidth) % travelWidth;
    return loopedX / travelWidth;
  }, [particle.drift, particle.phase, particle.speed, particle.x, time, width]);
  const cx = useDerivedValue(() => {
    'worklet';
    return progress.value * (width + 120) - 60;
  }, [progress, width]);
  const cy = useDerivedValue(() => {
    'worklet';
    return particle.y * height + Math.sin(time.value / 420 + particle.phase) * particle.drift * 0.28;
  }, [height, particle.drift, particle.phase, particle.y, time]);
  const baseColor = useDerivedValue(() => {
    'worklet';
    const opacity = particle.opacity * getCycleFadeWorklet(progress.value) * opacityBoost;
    return `rgba(194,149,90,${opacity * 0.64})`;
  }, [opacityBoost, particle.opacity, progress]);
  const overlayColor = useDerivedValue(() => {
    'worklet';
    const opacity = particle.opacity * getCycleFadeWorklet(progress.value) * opacityBoost;
    return `rgba(194,149,90,${opacity * 0.14})`;
  }, [opacityBoost, particle.opacity, progress]);

  return (
    <>
      <Circle cx={cx} cy={cy} r={particle.size} color={baseColor}>
        <BlurMask blur={26} style="normal" />
      </Circle>
      <Circle blendMode="overlay" cx={cx} cy={cy} r={particle.size} color={overlayColor}>
        <BlurMask blur={26} style="normal" />
      </Circle>
    </>
  );
}

function useCloudSprites(
  kind: ParticleKind,
  particles: Particle[],
  renderingMode: CloudSpriteRenderingMode,
) {
  const [sprites, setSprites] = useState<CloudSprite[]>([]);

  useEffect(() => {
    if (kind !== 'cloudy') {
      setSprites([]);
      return;
    }

    let cancelled = false;

    if (renderingMode === 'stable-pool') {
      setSprites([]);
      void getStableCloudSpritePool().then(
        (pool) => {
          if (cancelled) return;
          setSprites(pool.map((sprite, index) => {
            const particle = particles[index];
            if (!particle) return sprite;
            return { ...sprite, ...getCloudSpriteLogicalSize(particle) };
          }));
        },
        () => {
          if (!cancelled) setSprites([]);
        },
      );
      return () => {
        cancelled = true;
      };
    }

    const createdSprites: CloudSprite[] = [];
    setSprites([]);

    void (async () => {
      try {
        for (const particle of particles) {
          const sprite = await createCloudSprite(particle);
          if (cancelled) {
            sprite.image.dispose();
            return;
          }
          createdSprites.push(sprite);
        }
        if (!cancelled) setSprites(createdSprites);
      } catch {
        createdSprites.forEach((sprite) => sprite.image.dispose());
        if (!cancelled) setSprites([]);
      }
    })();

    return () => {
      cancelled = true;
      createdSprites.forEach((sprite) => sprite.image.dispose());
    };
  }, [kind, particles, renderingMode]);

  return sprites;
}

function getStableCloudSpritePool() {
  if (stableCloudSpritePool) return Promise.resolve(stableCloudSpritePool);
  if (stableCloudSpritePoolRequest) return stableCloudSpritePoolRequest;

  const request = (async () => {
    const createdSprites: CloudSprite[] = [];
    try {
      const particles = createParticles('cloudy', THUNDERSTORM_CLOUD_SEED);
      for (const particle of particles) {
        createdSprites.push(await createCloudSprite(particle));
      }
      stableCloudSpritePool = createdSprites;
      return createdSprites;
    } catch (error) {
      createdSprites.forEach((sprite) => sprite.image.dispose());
      throw error;
    }
  })();

  stableCloudSpritePoolRequest = request;
  void request.then(
    () => {
      if (stableCloudSpritePoolRequest === request) stableCloudSpritePoolRequest = null;
    },
    () => {
      if (stableCloudSpritePoolRequest === request) stableCloudSpritePoolRequest = null;
    },
  );
  return request;
}

async function createCloudSprite(particle: Particle) {
  const { width, height } = getCloudSpriteLogicalSize(particle);
  const pixelWidth = Math.ceil(width * CLOUD_TEXTURE_PIXEL_RATIO);
  const pixelHeight = Math.ceil(height * CLOUD_TEXTURE_PIXEL_RATIO);
  const path = createCloudBlobPath(
    pixelWidth / 2,
    pixelHeight / 2,
    particle.size * CLOUD_TEXTURE_PIXEL_RATIO,
    particle.shape ?? [],
  );
  const image = await drawAsImage(
    <Path path={path} color="white">
      <BlurMask blur={CLOUD_TEXTURE_BLUR_PX * CLOUD_TEXTURE_PIXEL_RATIO} style="normal" />
    </Path>,
    { width: pixelWidth, height: pixelHeight },
  );

  return { height, image, width };
}

function getCloudSpriteLogicalSize(particle: Particle) {
  const horizontalExtent = particle.size * 1.8 + CLOUD_TEXTURE_PADDING_PX;
  const verticalExtent = particle.size * 0.8 + CLOUD_TEXTURE_PADDING_PX;
  return {
    width: Math.ceil(horizontalExtent * 2),
    height: Math.ceil(verticalExtent * 2),
  };
}

function WeatherMistShape({
  cloudSprite,
  kind,
  opacity,
  particle,
  x,
  y,
}: {
  cloudSprite?: CloudSprite;
  kind: ParticleKind;
  opacity: number;
  particle: Particle;
  x: number;
  y: number;
}) {
  if (kind !== 'cloudy') {
    return (
      <>
        <Circle cx={x} cy={y} r={particle.size} color={getMistColor(kind, opacity * 0.64)}>
          <BlurMask blur={26} style="normal" />
        </Circle>
        <Circle blendMode="overlay" cx={x} cy={y} r={particle.size} color={getMistColor(kind, opacity * 0.14)}>
          <BlurMask blur={26} style="normal" />
        </Circle>
      </>
    );
  }

  if (!cloudSprite) return null;
  const imageX = x - cloudSprite.width / 2;
  const imageY = y - cloudSprite.height / 2;

  return (
    <>
      <Image
        fit="fill"
        height={cloudSprite.height}
        image={cloudSprite.image}
        opacity={opacity * 0.72}
        width={cloudSprite.width}
        x={imageX}
        y={imageY}
      />
      <Image
        blendMode="overlay"
        fit="fill"
        height={cloudSprite.height}
        image={cloudSprite.image}
        opacity={opacity * 0.18}
        width={cloudSprite.width}
        x={imageX}
        y={imageY}
      />
    </>
  );
}

function createParticles(kind: ParticleKind, seed: number) {
  const random = makeRandom(seed);
  const effect = WEATHER_ANIMATION_STYLE_DEFINITION.effects[kind];

  if (kind === 'rain') {
    return Array.from({ length: effect.particleCount }, () => ({
      x: random(),
      y: random() * 720,
      size: randomInRange(effect.sizeRange, random),
      speed: randomInRange(effect.speedRange, random),
      opacity: randomInRange(effect.opacityRange, random),
      drift: randomInRange(effect.driftRange, random),
      phase: random() * Math.PI * 2,
    }));
  }

  if (kind === 'snow') {
    return Array.from({ length: effect.particleCount }, () => ({
      x: random(),
      y: random() * 760,
      size: randomInRange(effect.sizeRange, random),
      speed: randomInRange(effect.speedRange, random),
      opacity: randomInRange(effect.opacityRange, random),
      drift: randomInRange(effect.driftRange, random),
      phase: random() * Math.PI * 2,
    }));
  }

  if (kind === 'hail') {
    return Array.from({ length: effect.particleCount }, () => ({
      x: random(),
      y: random() * 760,
      size: randomInRange(effect.sizeRange, random),
      speed: randomInRange(effect.speedRange, random),
      opacity: randomInRange(effect.opacityRange, random),
      drift: randomInRange(effect.driftRange, random),
      phase: random() * Math.PI * 2,
    }));
  }

  return Array.from({ length: effect.particleCount }, (_, index) => ({
    x: random(),
    y: kind === 'cloudy'
      ? getLayeredY(index, effect.particleCount, random)
      : random(),
    size: randomInRange(effect.sizeRange, random),
    speed: randomInRange(effect.speedRange, random),
    opacity: randomInRange(effect.opacityRange, random),
    drift: randomInRange(effect.driftRange, random),
    phase: random() * Math.PI * 2,
    shape: kind === 'cloudy' ? createCloudShape(random) : undefined,
  }));
}

function getMistColor(kind: ParticleKind, opacity: number) {
  if (kind === 'dust') return `rgba(194,149,90,${opacity})`;
  return `rgba(255,255,255,${opacity})`;
}

function getMistOpacity(kind: ParticleKind) {
  return WEATHER_ANIMATION_STYLE_DEFINITION.effects[kind].layerOpacity;
}

function getSkyOpacityBoost(kind: ParticleKind, tone: number) {
  if (kind === 'fog') {
    if (tone > 0.72) return 1.8;
    if (tone > 0.58) return 1.35;
    return 1;
  }

  if (kind !== 'cloudy') return 1;
  if (tone > 0.72) return 1.35;
  if (tone > 0.58) return 1.18;
  return 1;
}

function getSkyTone(theme: SkyTheme) {
  const tones = theme.colors.map((color) => {
    const { r, g, b } = hexToRgb(color);
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  });

  return tones.reduce((sum, tone) => sum + tone, 0) / tones.length;
}

function hexToRgb(hex: string) {
  const value = hex.replace('#', '');

  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16),
  };
}

function getLayeredY(index: number, count: number, random: () => number) {
  const band = index % 4;
  const bandHeight = 1 / 4;
  const base = band * bandHeight;
  const jitter = random() * bandHeight;
  const breathingRoom = count > 0 ? 0.03 : 0;

  return Math.min(0.98, base + jitter + breathingRoom);
}

function loop(value: number, max: number) {
  return ((value % max) + max) % max;
}

function getCycleFade(progress: number) {
  const fadeRange = 0.18;

  if (progress < fadeRange) return progress / fadeRange;
  if (progress > 1 - fadeRange) return (1 - progress) / fadeRange;
  return 1;
}

function getCycleFadeWorklet(progress: number) {
  'worklet';
  const fadeRange = 0.18;

  if (progress < fadeRange) return progress / fadeRange;
  if (progress > 1 - fadeRange) return (1 - progress) / fadeRange;
  return 1;
}

function getLayerOpacity(layer: ParticleLayer, time: number) {
  const fadeDuration = WEATHER_ANIMATION_STYLE_DEFINITION.transitionDurationMs;

  if (layer.exitingAt !== undefined) {
    return Math.max(0, 1 - (time - layer.exitingAt) / fadeDuration);
  }

  return Math.max(0, Math.min(1, (time - layer.startedAt) / fadeDuration));
}

function getGradientPositions(count: number) {
  if (count <= 2) return [0, 1];
  return Array.from({ length: count }, (_, index) => index / (count - 1));
}

function getStarLayerOpacity(kind: WeatherKind, theme: SkyTheme, layers: ParticleLayer[], time: number) {
  const isNightSky = theme.key === 'night' || theme.key === 'midnight';
  const noWeatherAnimation = kind === 'clear' || kind === 'unknown';

  if (!isNightSky || !noWeatherAnimation) return 0;

  const remainingWeatherOpacity = layers.reduce(
    (maximum, layer) => Math.max(maximum, getLayerOpacity(layer, time)),
    0,
  );

  return Math.max(0, 1 - remainingWeatherOpacity);
}

function createStars(seed: number) {
  const random = makeRandom(seed);
  const style = WEATHER_ANIMATION_STYLE_DEFINITION.nightStars;

  return Array.from({ length: style.particleCount }, () => ({
    x: 0.04 + random() * 0.92,
    y: 0.02 + random() * 0.93,
    size: randomInRange(style.sizeRange, random),
    opacity: randomInRange(style.opacityRange, random),
    pulseSpeed: randomInRange(
      style.pulseDurationRangeMs,
      random,
    ),
    phase: random() * Math.PI * 2,
  }));
}

function getNightStarSeed(date: Date) {
  const nightDate = new Date(date);

  // Keep evening and the following early morning on one stable night sky.
  if (nightDate.getHours() < 5) {
    nightDate.setDate(nightDate.getDate() - 1);
  }

  return nightDate.getFullYear() * 10000 + (nightDate.getMonth() + 1) * 100 + nightDate.getDate();
}

function createCloudShape(random: () => number) {
  return Array.from({ length: 16 }, (_, index) => {
    const crest = index > 6 && index < 12 ? 0.16 : 0;
    const dip = index % 5 === 0 ? -0.12 : 0;
    return 0.7 + crest + dip + random() * 0.46;
  });
}

function createCloudBlobPath(cx: number, cy: number, size: number, shape: number[]) {
  const points = shape.map((radius, index) => {
    const angle = (index / shape.length) * Math.PI * 2;
    const horizontalSquash = 1.22 + Math.sin(angle * 2) * 0.08;
    const verticalSquash = 0.48 + Math.cos(angle * 3) * 0.05;

    return {
      x: cx + Math.cos(angle) * size * horizontalSquash * radius,
      y: cy + Math.sin(angle) * size * verticalSquash * radius,
    };
  });

  if (points.length === 0) return '';

  const commands = [`M ${points[0].x} ${points[0].y}`];

  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    const control = {
      x: (current.x + next.x) / 2,
      y: (current.y + next.y) / 2,
    };

    commands.push(`Q ${current.x} ${current.y} ${control.x} ${control.y}`);
  }

  commands.push('Z');
  return commands.join(' ');
}

function makeRandom(seed: number) {
  let value = seed || 1;

  return () => {
    value = (value * 1664525 + 1013904223) % 4294967296;
    return value / 4294967296;
  };
}

function randomInRange(
  range: readonly [number, number],
  random: () => number,
) {
  return range[0] + random() * (range[1] - range[0]);
}

const styles = StyleSheet.create({
  layer: {
    ...StyleSheet.absoluteFillObject,
  },
});
