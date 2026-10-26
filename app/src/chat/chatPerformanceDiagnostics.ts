export type ChatPerformanceScenario =
  | 'mount'
  | 'scroll'
  | 'keyboard'
  | 'typing'
  | 'poke';

export type ChatPerformanceSubtreeSummary = {
  commits: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
};

export type ChatPerformanceSummary = {
  scenario: ChatPerformanceScenario;
  pid: number;
  pssKb: number;
  jankyPercent: number;
  p99FrameMs: number;
  reactSubtrees: Record<string, ChatPerformanceSubtreeSummary>;
};

export const CHAT_PERFORMANCE_DIAGNOSTICS_ENABLED =
  __DEV__ && process.env.EXPO_PUBLIC_JUNLUO_RUNTIME_DIAGNOSTICS === '1';

const FLUSH_DELAY_MS = 2000;

type ProfilerBucket = {
  durations: number[];
  timer: ReturnType<typeof setTimeout> | null;
};

const profilerBuckets = new Map<string, ProfilerBucket>();

function percentile(values: number[], ratio: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))];
}

function rounded(value: number) {
  return Math.round(value * 100) / 100;
}

function flushProfilerBucket(id: string) {
  const bucket = profilerBuckets.get(id);
  if (!bucket?.durations.length) return;
  const durations = bucket.durations.splice(0);
  bucket.timer = null;
  const summary: ChatPerformanceSubtreeSummary & { id: string } = {
    id,
    commits: durations.length,
    p50Ms: rounded(percentile(durations, 0.5)),
    p95Ms: rounded(percentile(durations, 0.95)),
    maxMs: rounded(Math.max(...durations)),
  };
  console.info(`[JunLuoChatPerf] profiler-summary ${JSON.stringify(summary)}`);
}

export function recordChatProfilerRender(id: string, actualDuration: number) {
  if (!CHAT_PERFORMANCE_DIAGNOSTICS_ENABLED || !Number.isFinite(actualDuration)) return;
  const bucket = profilerBuckets.get(id) ?? { durations: [], timer: null };
  bucket.durations.push(actualDuration);
  if (!bucket.timer) {
    bucket.timer = setTimeout(() => flushProfilerBucket(id), FLUSH_DELAY_MS);
  }
  profilerBuckets.set(id, bucket);
}

