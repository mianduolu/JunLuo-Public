import type { TheaterGenerationSnapshot } from './theaterGenerationStore';
import { theaterSummaryMessageSources } from './theaterSummaryMaterials';

export type TheaterSummaryCandidate = {
  content: string;
  positionId: string | null;
  sourceVersionId: string | null;
};
export type TheaterSummaryResult = {
  summary: string;
  candidates: TheaterSummaryCandidate[];
  incompleteCandidates: boolean;
};

/** Parse the complete response only. No string salvage, guessed sources, or extra model call. */
export function parseTheaterSummaryResult(input: string, snapshot: TheaterGenerationSnapshot): TheaterSummaryResult {
  let parsed: unknown;
  try { parsed = JSON.parse(input); } catch { throw new Error('theater-summary-result-invalid'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || !('summary' in parsed) || typeof parsed.summary !== 'string' || !parsed.summary.trim()) {
    throw new Error('theater-summary-result-invalid');
  }
  const value = parsed as Record<string, unknown>;
  const sources = theaterSummaryMessageSources(snapshot);
  const candidates: TheaterSummaryCandidate[] = [];
  let incompleteCandidates = !Array.isArray(value.anchor_candidates);
  if (Array.isArray(value.anchor_candidates)) {
    for (const item of value.anchor_candidates) {
      if (!item || typeof item !== 'object' || Array.isArray(item)
        || typeof item.content !== 'string' || !item.content.trim()) {
        incompleteCandidates = true;
        continue;
      }
      const index = item.source_message_index;
      const source = typeof index === 'number' && Number.isInteger(index) && index >= 1
        ? sources[index - 1] : undefined;
      candidates.push({ content: item.content, positionId: source?.positionId ?? null,
        sourceVersionId: source?.sourceVersionId ?? null });
    }
  }
  return { summary: parsed.summary, candidates, incompleteCandidates };
}
