import type { MemoryCandidateReview } from '../memory/memoryCandidateReview';

export const FOCUS_ORGANIZATION_TRIGGER = 'focus-organization-result';
export const FOCUS_SUMMARY_RECENT_MS = 24 * 60 * 60 * 1000;

export type FocusOrganizationRecord = {
  version: 1;
  summary: string;
  /** undefined is a failed part; [] is a successful part with no candidates. */
  candidates?: MemoryCandidateReview[];
  registered: boolean;
};

export const focusOrganizationLogId = (sessionId: string) => `${sessionId}:organization`;
export const isFocusOrganizationLog = (log: { trigger: string }) => log.trigger === FOCUS_ORGANIZATION_TRIGGER;

/** Decode cached review identities, never regenerate them or turn a malformed part into success. */
export function parseFocusOrganizationRecord(content: string): FocusOrganizationRecord | null {
  if (content.length > 40_000) return null;
  let value: unknown;
  try { value = JSON.parse(content); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || typeof record.summary !== 'string' || typeof record.registered !== 'boolean') return null;
  let candidates: MemoryCandidateReview[] | undefined;
  if (Array.isArray(record.candidates) && record.candidates.length <= 2) {
    const ids = new Set<string>();
    const valid = record.candidates.every(candidate => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)
        || typeof candidate.reviewId !== 'string' || !candidate.reviewId.trim() || ids.has(candidate.reviewId)
        || typeof candidate.title !== 'string' || typeof candidate.content !== 'string' || !candidate.content.trim()
        || typeof candidate.origin !== 'string' || !candidate.origin.trim()) return false;
      ids.add(candidate.reviewId);
      return true;
    });
    if (valid) candidates = record.candidates as MemoryCandidateReview[];
  }
  return { version: 1, summary: record.summary, candidates, registered: record.registered && candidates !== undefined };
}
