import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AppState, StyleSheet, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedProps,
  useSharedValue,
  withDelay,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';

import { colors } from '../theme/colors';

// Mirrors ecg_plot.py _ax_plot/plot_1: one lead, 500 Hz samples, 0.2s major grid with minor divisions.
const VIEWBOX_WIDTH = 320;
const VIEWBOX_HEIGHT = 74;
const ECG_SAMPLE_RATE = 500;
const DISPLAY_SECONDS = 2.8;
const ECG_AMPLITUDE_MV = 1.8;
const RENDER_STRIDE = 4;
const ECG_DRAW_DURATION_MS = Math.round(DISPLAY_SECONDS * 1000);
const ECG_TRAIL_FADE_DURATION_MS = 1950;
const ECG_TRAIL_FADE_STEP_MS = ECG_TRAIL_FADE_DURATION_MS / 3;
const ECG_TRAIL_RESET_STEP_MS = 1;
const MAJOR_TIME_TICK_SECONDS = 0.2;
const MINOR_TICKS_PER_MAJOR = 5;
const MAJOR_VOLTAGE_TICK_MV = 1;
const MINOR_VOLTAGE_TICK_MV = 0.5;

type Props = {
  heartRate?: number;
  readingKey?: number;
  recentValues?: readonly number[];
};

type Beat = {
  bpm: number;
  end: number;
  start: number;
};

type RenderedLead = {
  length: number;
  path: string;
};

const AnimatedPath = Animated.createAnimatedComponent(Path);

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function hasUsableHeartRate(heartRate?: number) {
  return Boolean(heartRate && Number.isFinite(heartRate) && heartRate > 0);
}

function gaussian(x: number, center: number, width: number, amplitude: number) {
  const normalized = (x - center) / width;
  return amplitude * Math.exp(-0.5 * normalized * normalized);
}

function buildVerticalGridPath(stepSeconds: number) {
  const ticks = Math.floor(DISPLAY_SECONDS / stepSeconds) + 1;
  return Array.from({ length: ticks }, (_, index) => {
    const x = (index * stepSeconds * VIEWBOX_WIDTH) / DISPLAY_SECONDS;
    return `M ${x.toFixed(1)} 0 L ${x.toFixed(1)} ${VIEWBOX_HEIGHT}`;
  }).join(' ');
}

function voltageToY(mv: number) {
  const normalized = (ECG_AMPLITUDE_MV - mv) / (ECG_AMPLITUDE_MV * 2);
  return clamp(normalized * VIEWBOX_HEIGHT, 3, VIEWBOX_HEIGHT - 3);
}

function buildHorizontalGridPath(stepMv: number) {
  const rows: string[] = [];
  for (let mv = -ECG_AMPLITUDE_MV; mv <= ECG_AMPLITUDE_MV + 0.001; mv += stepMv) {
    const y = voltageToY(mv);
    rows.push(`M 0 ${y.toFixed(1)} L ${VIEWBOX_WIDTH} ${y.toFixed(1)}`);
  }
  return rows.join(' ');
}

function normalizeBpmValues(heartRate?: number, recentValues: readonly number[] = []) {
  const cleaned = recentValues
    .filter((value) => Number.isFinite(value) && value > 0)
    .slice(0, 8)
    .map((value) => clamp(value, 42, 145));
  if (hasUsableHeartRate(heartRate)) cleaned.unshift(clamp(heartRate ?? 72, 42, 145));
  return cleaned.length ? cleaned : [72];
}

function buildBeatTimeline(values: readonly number[], startSeconds: number, endSeconds: number) {
  const beats: Beat[] = [];
  let cursor = -2;
  let index = 0;

  while (cursor < endSeconds + 2) {
    const bpm = values[index % values.length] ?? values[0] ?? 72;
    const beatSeconds = 60 / bpm;
    const next = cursor + beatSeconds;
    if (next >= startSeconds - 1) {
      beats.push({ bpm, end: next, start: cursor });
    }
    cursor = next;
    index += 1;
  }

  return beats;
}

function sampleSyntheticLead(timeSeconds: number, beat: Beat) {
  const beatSeconds = beat.end - beat.start;
  const phase = clamp((timeSeconds - beat.start) / beatSeconds, 0, 1);
  const rateLift = clamp((beat.bpm - 64) / 64, -0.32, 0.82);
  const amplitudeScale = clamp(0.86 + rateLift * 0.42, 0.72, 1.36);
  const baseline = Math.sin(timeSeconds * Math.PI * 2 * 0.18) * 0.035;

  return (
    baseline +
    amplitudeScale *
      (gaussian(phase, 0.18, 0.034, 0.11) +
        gaussian(phase, 0.34, 0.014, -0.20) +
        gaussian(phase, 0.385, 0.010, 1.06) +
        gaussian(phase, 0.425, 0.018, -0.32) +
        gaussian(phase, 0.66, 0.074, 0.28))
  );
}

function findBeat(beats: readonly Beat[], timeSeconds: number) {
  return beats.find((beat) => timeSeconds >= beat.start && timeSeconds < beat.end) ?? beats[beats.length - 1];
}

function buildFlatPath(): RenderedLead {
  const baseline = VIEWBOX_HEIGHT / 2;
  return {
    length: VIEWBOX_WIDTH,
    path: `M 0 ${baseline.toFixed(1)} L ${VIEWBOX_WIDTH} ${baseline.toFixed(1)}`,
  };
}

function buildLeadPath(heartRate?: number, recentValues: readonly number[] = []): RenderedLead {
  if (!hasUsableHeartRate(heartRate)) return buildFlatPath();

  const values = normalizeBpmValues(heartRate, recentValues);
  const sampleCount = Math.floor(DISPLAY_SECONDS * ECG_SAMPLE_RATE);
  const beats = buildBeatTimeline(values, 0, DISPLAY_SECONDS);
  const path: string[] = [];
  let length = 0;
  let previousX: number | undefined;
  let previousY: number | undefined;

  for (let sample = 0; sample <= sampleCount; sample += RENDER_STRIDE) {
    const timeSeconds = sample / ECG_SAMPLE_RATE;
    const beat = findBeat(beats, timeSeconds);
    const signalMv = beat ? sampleSyntheticLead(timeSeconds, beat) : 0;
    const x = (sample * VIEWBOX_WIDTH) / sampleCount;
    const y = voltageToY(signalMv);
    if (previousX !== undefined && previousY !== undefined) {
      length += Math.hypot(x - previousX, y - previousY);
    }
    path.push(`${path.length ? 'L' : 'M'} ${x.toFixed(1)} ${y.toFixed(1)}`);
    previousX = x;
    previousY = y;
  }

  return {
    length: Math.max(1, length),
    path: path.join(' '),
  };
}

const minorGridPath = `${buildVerticalGridPath(MAJOR_TIME_TICK_SECONDS / MINOR_TICKS_PER_MAJOR)} ${buildHorizontalGridPath(MINOR_VOLTAGE_TICK_MV)}`;
const majorGridPath = `${buildVerticalGridPath(MAJOR_TIME_TICK_SECONDS)} ${buildHorizontalGridPath(MAJOR_VOLTAGE_TICK_MV)}`;

function BodySignalEcgStripView({ heartRate, readingKey, recentValues = [] }: Props) {
  const progress = useSharedValue(1);
  const trailOpacity = useSharedValue(0);
  const [isAppActive, setIsAppActive] = useState(AppState.currentState === 'active');
  const active = hasUsableHeartRate(heartRate);
  const recentValuesKey = recentValues.join(',');
  const stableRecentValues = useMemo(
    () => (recentValuesKey ? recentValuesKey.split(',').map(Number) : []),
    [recentValuesKey],
  );

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      setIsAppActive(state === 'active');
    });

    return () => subscription.remove();
  }, []);

  const incomingTrace = useMemo(
    () => buildLeadPath(heartRate, stableRecentValues),
    [heartRate, stableRecentValues],
  );
  const incomingTraceRef = useRef(incomingTrace);
  const displayedTraceRef = useRef(incomingTrace);
  const [displayedTrace, setDisplayedTrace] = useState(incomingTrace);
  const [trailTrace, setTrailTrace] = useState(incomingTrace);
  const [cycleVersion, setCycleVersion] = useState(0);

  useEffect(() => {
    incomingTraceRef.current = incomingTrace;
  }, [incomingTrace]);

  const animatedProps = useAnimatedProps(() => ({
    strokeDashoffset: displayedTrace.length * (1 - progress.value),
  }), [displayedTrace.length]);
  const trailAnimatedProps = useAnimatedProps(() => ({
    opacity: trailOpacity.value,
  }), [trailOpacity]);

  const beginNextCycle = useCallback(() => {
    const previousTrace = displayedTraceRef.current;
    const nextTrace = incomingTraceRef.current;

    displayedTraceRef.current = nextTrace;
    setTrailTrace(previousTrace);
    setDisplayedTrace(nextTrace);
    setCycleVersion((version) => version + 1);
  }, []);

  useLayoutEffect(() => {
    if (!active || !isAppActive || cycleVersion === 0) return;

    cancelAnimation(progress);
    cancelAnimation(trailOpacity);
    progress.value = 0;
    trailOpacity.value = 1;
    progress.value = withTiming(1, {
      duration: ECG_DRAW_DURATION_MS,
      easing: Easing.linear,
    });
    trailOpacity.value = withSequence(
      withDelay(ECG_TRAIL_FADE_STEP_MS, withTiming(2 / 3, { duration: ECG_TRAIL_RESET_STEP_MS })),
      withDelay(ECG_TRAIL_FADE_STEP_MS, withTiming(1 / 3, { duration: ECG_TRAIL_RESET_STEP_MS })),
      withDelay(ECG_TRAIL_FADE_STEP_MS, withTiming(0, { duration: ECG_TRAIL_RESET_STEP_MS })),
    );
  }, [active, cycleVersion, isAppActive, progress, trailOpacity]);

  useEffect(() => {
    if (!active || !isAppActive) return undefined;

    beginNextCycle();
    const cycleTimer = setInterval(beginNextCycle, ECG_DRAW_DURATION_MS);
    return () => clearInterval(cycleTimer);
  }, [active, beginNextCycle, isAppActive, readingKey]);

  useEffect(() => {
    if (isAppActive) return;
    setTrailTrace(displayedTraceRef.current);
    cancelAnimation(progress);
    progress.value = 1;
    cancelAnimation(trailOpacity);
    trailOpacity.value = 0;
  }, [isAppActive, progress, trailOpacity]);

  useEffect(() => () => {
    cancelAnimation(progress);
    cancelAnimation(trailOpacity);
  }, [progress, trailOpacity]);

  return (
    <View style={styles.container}>
      <Svg
        height="100%"
        pointerEvents="none"
        viewBox={`0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`}
        width="100%"
      >
        <Path d={minorGridPath} fill="none" opacity={0.24} stroke="#F2B9B1" strokeWidth={0.5} />
        <Path d={majorGridPath} fill="none" opacity={0.34} stroke="#D98980" strokeWidth={0.8} />
        <AnimatedPath
          animatedProps={trailAnimatedProps}
          d={trailTrace.path}
          fill="none"
          stroke={colors.primary}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.4}
        />
        <AnimatedPath
          animatedProps={animatedProps}
          d={displayedTrace.path}
          fill="none"
          stroke={colors.primary}
          strokeDasharray={[displayedTrace.length, displayedTrace.length]}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2.2}
        />
      </Svg>
    </View>
  );
}

function equalRecentValues(left: readonly number[] = [], right: readonly number[] = []) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export const BodySignalEcgStrip = memo(
  BodySignalEcgStripView,
  (previous, next) =>
    previous.heartRate === next.heartRate
    && previous.readingKey === next.readingKey
    && equalRecentValues(previous.recentValues, next.recentValues),
);

const styles = StyleSheet.create({
  container: {
    backgroundColor: 'rgba(255,255,255,0.62)',
    borderRadius: 8,
    height: 88,
    marginTop: 10,
    overflow: 'hidden',
  },
});
