export type MemoryRetrievalStageName =
  | 'recall_candidates'
  | 'recall_selected'
  | 'background_candidates'
  | 'background_selected'
  | 'care_pool_candidates'
  | 'current_state_selected'
  | 'anchor_candidates'
  | 'anchor_selected'
  | 'reflection_candidates'
  | 'reflection_selected'
  | 'spoken_mentions'
  | 'source_trace'
  | 'context_final';

export type MemoryRetrievalStage = {
  droppedIds?: string[];
  inputCount: number;
  name: MemoryRetrievalStageName;
  note?: string;
  outputCount: number;
  tookMs: number;
};

export type MemoryRetrievalTrace = {
  endedAt?: number;
  finalCount?: number;
  id: string;
  input: string;
  source?: string;
  stages: MemoryRetrievalStage[];
  startedAt: number;
  totalMs?: number;
};

export type MemoryRetrievalTraceSummary = {
  averageFinalCount: number;
  emptyFinalCount: number;
  recentCount: number;
  topDroppedStages: Array<{ count: number; label: string; stage: MemoryRetrievalStageName }>;
  totalDropped: number;
};

const RECENT_TRACE_LIMIT = 50;
const recentTraces: MemoryRetrievalTrace[] = [];

export function startMemoryRetrievalTrace(input: unknown): MemoryRetrievalTrace {
  const startedAt = Date.now();
  const queryText = typeof input === 'string'
    ? input
    : input && typeof input === 'object'
      ? [
        'userText' in input ? String((input as { userText?: unknown }).userText ?? '') : '',
        'activeContext' in input ? String((input as { activeContext?: unknown }).activeContext ?? '') : '',
      ].filter(Boolean).join('\n')
      : '';
  return {
    id: `memory-trace-${startedAt}-${Math.random().toString(36).slice(2, 8)}`,
    input: queryText.trim().slice(0, 240),
    startedAt,
    stages: [],
  };
}

export function recordMemoryRetrievalStage(
  trace: MemoryRetrievalTrace,
  stage: Omit<MemoryRetrievalStage, 'tookMs'> & { startedAt?: number },
) {
  const now = Date.now();
  trace.stages.push({
    droppedIds: stage.droppedIds?.slice(0, 20),
    inputCount: Math.max(0, stage.inputCount),
    name: stage.name,
    note: stage.note,
    outputCount: Math.max(0, stage.outputCount),
    tookMs: stage.startedAt ? Math.max(0, now - stage.startedAt) : 0,
  });
}

export function finishMemoryRetrievalTrace(
  trace: MemoryRetrievalTrace,
  result: { finalCount?: number; source?: string } = {},
) {
  const endedAt = Date.now();
  const finished: MemoryRetrievalTrace = {
    ...trace,
    endedAt,
    finalCount: result.finalCount,
    source: result.source,
    totalMs: Math.max(0, endedAt - trace.startedAt),
  };
  recentTraces.unshift(finished);
  if (recentTraces.length > RECENT_TRACE_LIMIT) recentTraces.length = RECENT_TRACE_LIMIT;
  return finished;
}

export function loadRecentMemoryRetrievalTraces(options: { limit?: number } = {}) {
  const limit = Math.max(1, Math.min(RECENT_TRACE_LIMIT, options.limit ?? 12));
  return recentTraces.slice(0, limit);
}

export function buildRecentMemoryRetrievalTraceSummary(options: { limit?: number } = {}): MemoryRetrievalTraceSummary {
  const traces = loadRecentMemoryRetrievalTraces(options);
  const droppedByStage = new Map<MemoryRetrievalStageName, number>();
  let emptyFinalCount = 0;
  let finalCountSeen = 0;
  let finalCountTotal = 0;
  let totalDropped = 0;
  traces.forEach((trace) => {
    if (typeof trace.finalCount === 'number') {
      finalCountSeen += 1;
      finalCountTotal += trace.finalCount;
      if (trace.finalCount === 0) emptyFinalCount += 1;
    }
    trace.stages.forEach((stage) => {
      const dropped = Math.max(0, stage.inputCount - stage.outputCount);
      if (!dropped) return;
      totalDropped += dropped;
      droppedByStage.set(stage.name, (droppedByStage.get(stage.name) ?? 0) + dropped);
    });
  });
  return {
    averageFinalCount: finalCountSeen ? Number((finalCountTotal / finalCountSeen).toFixed(1)) : 0,
    emptyFinalCount,
    recentCount: traces.length,
    topDroppedStages: Array.from(droppedByStage.entries())
      .map(([stage, count]) => ({ count, label: describeMemoryRetrievalStage(stage), stage }))
      .sort((left, right) => right.count - left.count)
      .slice(0, 3),
    totalDropped,
  };
}

export function describeMemoryRetrievalStage(stage: MemoryRetrievalStageName) {
  const labels: Record<MemoryRetrievalStageName, string> = {
    anchor_candidates: '长期坐标候选',
    anchor_selected: '长期坐标想起',
    background_candidates: '背景候选',
    background_selected: '背景想起',
    care_pool_candidates: '惦记候选',
    current_state_selected: '当前状态想起',
    context_final: '最终想起',
    recall_candidates: '普通召回候选',
    recall_selected: '普通召回想起',
    reflection_candidates: '白云动态候选',
    reflection_selected: '白云动态想起',
    spoken_mentions: '主动递出',
    source_trace: '原文追溯',
  };
  return labels[stage];
}

