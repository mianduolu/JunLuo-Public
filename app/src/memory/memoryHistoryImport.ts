import type { AiConnection } from '../ai/types';
import { organizeImportedHistoryMemoriesWithAi } from './memoryOrganizer';
import { runMemoryOrganizerRequestWithDeadline } from './memoryOrganizerRequestLifecycle';
import type { MemoryDraft } from './memoryStore';

export type HistoryImportChunk = {
  content: string;
  index: number;
  sourceEndAt?: number;
  sourceStartAt?: number;
};

export type HistoryImportPreview = {
  chunks: HistoryImportChunk[];
  cleanedContent: string;
  originalContent: string;
  estimatedCandidates: number;
  fileName: string;
  needsAi: boolean;
  totalChars: number;
};

const DEFAULT_MAX_CHARS = 5200;
const DEFAULT_OVERLAP_CHARS = 420;
export const HISTORY_IMPORT_CHUNKS_PER_RUN = 24;

function stripTimestampNoise(line: string) {
  return line
    .replace(/^\s*\[?\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}日?\s+\d{1,2}:\d{2}(?::\d{2})?\]?\s*/g, '')
    .replace(/^\s*\[?\d{1,2}:\d{2}(?::\d{2})?\]?\s*/g, '')
    .trim();
}

export function cleanHistoryImportText(content: string) {
  const seen = new Map<string, number>();
  const lines = content
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map(stripTimestampNoise)
    .filter((line) => line.length > 0)
    .filter((line) => {
      const normalized = line.replace(/\s+/g, ' ').trim();
      const count = seen.get(normalized) ?? 0;
      seen.set(normalized, count + 1);
      return count < 3;
    });
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function chunkHistoryText(
  content: string,
  options: { maxChars?: number; overlapChars?: number; now?: number } = {},
): HistoryImportChunk[] {
  const cleaned = cleanHistoryImportText(content);
  const maxChars = Math.max(1200, Math.min(9000, options.maxChars ?? DEFAULT_MAX_CHARS));
  const overlapChars = Math.max(0, Math.min(1200, options.overlapChars ?? DEFAULT_OVERLAP_CHARS));
  if (!cleaned) return [];

  const chunks: HistoryImportChunk[] = [];
  let start = 0;
  while (start < cleaned.length) {
    const hardEnd = Math.min(cleaned.length, start + maxChars);
    const boundaryWindow = cleaned.slice(start, hardEnd);
    const paragraphBreak = boundaryWindow.lastIndexOf('\n\n');
    const lineBreak = boundaryWindow.lastIndexOf('\n');
    const softBreak = paragraphBreak > maxChars * 0.55 ? paragraphBreak + 2 : lineBreak > maxChars * 0.55 ? lineBreak + 1 : boundaryWindow.length;
    const end = Math.min(cleaned.length, start + softBreak);
    const chunkContent = cleaned.slice(start, end).trim();
    if (chunkContent) {
      chunks.push({
        content: chunkContent,
        index: chunks.length,
        sourceEndAt: undefined,
        sourceStartAt: undefined,
      });
    }
    if (end >= cleaned.length) break;
    start = Math.max(end - overlapChars, start + 1);
  }
  return chunks;
}

export function parseHistoryTextFile(input: { content: string; name: string; now?: number }): HistoryImportPreview {
  const cleanedContent = cleanHistoryImportText(input.content);
  const chunks = chunkHistoryText(cleanedContent, { now: input.now });
  return {
    chunks,
    cleanedContent,
    originalContent: input.content,
    estimatedCandidates: chunks.length * 6,
    fileName: input.name.trim() || '历史文本',
    needsAi: chunks.length > 0,
    totalChars: cleanedContent.length,
  };
}

function ensureHistoryImportMetadata(candidate: MemoryDraft, chunk: HistoryImportChunk): MemoryDraft {
  const tags = Array.from(new Set(['历史导入', ...(candidate.tags ?? [])]));
  const recallCues = Array.from(new Set([...(candidate.recallCues ?? []), '历史导入']));
  return {
    ...candidate,
    tags,
    recallCues,
    source: 'history-import',
    sourceEndAt: candidate.sourceEndAt ?? chunk.sourceEndAt,
    sourceStartAt: candidate.sourceStartAt ?? chunk.sourceStartAt,
    sourceType: 'digest',
  };
}

export async function generateHistoryImportCandidates(
  ai: { apiKey: string; connection: AiConnection },
  preview: HistoryImportPreview,
  options: { limitChunks?: number } = {},
): Promise<{ candidates: MemoryDraft[]; processed: number; skipped: number }> {
  const limitChunks = Math.max(1, Math.min(preview.chunks.length, options.limitChunks ?? HISTORY_IMPORT_CHUNKS_PER_RUN));
  const candidates: MemoryDraft[] = [];
  let processed = 0;
  let skipped = 0;

  for (const chunk of preview.chunks.slice(0, limitChunks)) {
    try {
      const drafts = await runMemoryOrganizerRequestWithDeadline((signal) => organizeImportedHistoryMemoriesWithAi({
        apiKey: ai.apiKey,
        chunk,
        connection: ai.connection,
        fileLabel: preview.fileName,
        signal,
      }));
      processed += 1;
      candidates.push(...drafts.map((candidate) => ensureHistoryImportMetadata(candidate, chunk)));
    } catch {
      skipped += 1;
    }
  }

  return { candidates, processed, skipped };
}
