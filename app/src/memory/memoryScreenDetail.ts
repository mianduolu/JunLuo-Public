import { getMemoryQualitySignals, type MemoryQualitySignals } from './memoryCalibration';
import {
  explainMemoryDehydrationEligibility,
  type MemoryDehydrationDiagnostic,
} from './memoryDehydration';
import type { MemoryGraphLink } from './memoryGraphMaintenance';
import { buildMemoryHealthReport, type MemoryHealthReport } from './memoryHealthReport';
import { getMemoryEmbeddingStatus } from './memoryEmbedding';
import {
  buildMemoryLifecycleSummary,
  loadActiveMemoryMergeRecovery,
  loadMemoryComments,
  loadMemoryLifecycleEvents,
  loadMemoryGraphLinks,
  type MemoryComment,
  type MemoryEntry,
  type MemoryLifecycleEvent,
  type MemoryMergeRecoverySnapshot,
} from './memoryStore';
import {
  loadMemorySourceDetails,
  type MemorySourceTraceResult,
} from './memorySourceTrace';

export type MemoryScreenDetailSnapshot = {
  comments: MemoryComment[];
  dehydrationDiagnostic: MemoryDehydrationDiagnostic | null;
  embeddingStatus: Awaited<ReturnType<typeof getMemoryEmbeddingStatus>>;
  graphLinks: MemoryGraphLink[];
  healthReport: MemoryHealthReport;
  lifecycleEvents: MemoryLifecycleEvent[];
  lifecycleSummary: string;
  mergeRecovery: MemoryMergeRecoverySnapshot | null;
  qualitySignals: MemoryQualitySignals;
  sourceTrace: MemorySourceTraceResult | null;
};

function buildMemorySourceTraceQuery(memory: MemoryEntry, query?: string) {
  const search = query?.trim();
  if (search) return search;
  return [
    memory.title,
    memory.rememberedReason,
    memory.tags.slice(0, 4).join(' '),
    memory.content.slice(0, 120),
  ].filter(Boolean).join(' ');
}

function emptyMemorySourceTrace(): MemorySourceTraceResult {
  return {
    context: '',
    debug: { candidates: 0, exact: 0, legacyRange: 0, matched: 0, missingMessages: 0, missingRange: 0, none: 0 },
    details: [],
  };
}

async function loadMemorySourceTraceForDetail(
  memory: MemoryEntry,
  query?: string,
): Promise<MemorySourceTraceResult | null> {
  if (memory.source === 'history-import') return emptyMemorySourceTrace();
  try {
    return await loadMemorySourceDetails({
      items: [{ memory, reason: 'direct', score: 1 }],
      route: null,
      userText: buildMemorySourceTraceQuery(memory, query),
    });
  } catch {
    return null;
  }
}

export async function loadMemoryScreenDetailSnapshot(
  memory: MemoryEntry,
  options: { query?: string } = {},
): Promise<MemoryScreenDetailSnapshot> {
  const [
    comments,
    embeddingStatus,
    dehydrationDiagnostic,
    graphLinks,
    qualitySignals,
    healthReport,
    sourceTrace,
    lifecycleEvents,
    mergeRecovery,
  ] = await Promise.all([
    loadMemoryComments(memory.id),
    getMemoryEmbeddingStatus(memory.id),
    explainMemoryDehydrationEligibility(memory),
    loadMemoryGraphLinks(memory.id, { limit: 5 }),
    getMemoryQualitySignals(memory.id),
    buildMemoryHealthReport(memory, { query: options.query ?? '' }),
    loadMemorySourceTraceForDetail(memory, options.query),
    loadMemoryLifecycleEvents(memory.id),
    loadActiveMemoryMergeRecovery(memory.id),
  ]);

  return {
    comments,
    dehydrationDiagnostic,
    embeddingStatus,
    graphLinks,
    healthReport,
    lifecycleEvents,
    lifecycleSummary: buildMemoryLifecycleSummary(lifecycleEvents),
    mergeRecovery,
    qualitySignals,
    sourceTrace,
  };
}

export async function loadMemoryScreenHealthSnapshot(
  memory: MemoryEntry,
  options: { query?: string } = {},
) {
  const [
    dehydrationDiagnostic,
    graphLinks,
    qualitySignals,
    healthReport,
  ] = await Promise.all([
    explainMemoryDehydrationEligibility(memory),
    loadMemoryGraphLinks(memory.id, { limit: 5 }),
    getMemoryQualitySignals(memory.id),
    buildMemoryHealthReport(memory, { query: options.query ?? '' }),
  ]);

  return {
    dehydrationDiagnostic,
    graphLinks,
    healthReport,
    qualitySignals,
  };
}
