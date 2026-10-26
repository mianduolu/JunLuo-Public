/** Local evidence status; matching query text never establishes a source relationship. */
export type MemorySourceStatus = 'exact' | 'legacy_range' | 'retained_excerpt' | 'missing';

export const memorySourceStatusLabel: Record<MemorySourceStatus, string> = {
  exact: '原话已找到',
  legacy_range: '附近聊天，未确认出处',
  retained_excerpt: '仅剩原话摘录',
  missing: '原话未找到',
};

export const observationSourceStatusLabel = {
  exact: '观察记录已找到',
  retained_excerpt: '仅剩观察摘录',
  missing: '观察记录未找到',
} as const;

export function getMemorySourceStatusLabel(status: MemorySourceStatus, observation = false) {
  return observation && status !== 'legacy_range' ? observationSourceStatusLabel[status] : memorySourceStatusLabel[status];
}

export function getMemorySourceStatus(input: {
  available: boolean; retainedExcerpt: boolean; mode: string;
}): MemorySourceStatus {
  return input.available ? input.mode === 'legacy_range' ? 'legacy_range' : 'exact'
    : input.retainedExcerpt ? 'retained_excerpt' : 'missing';
}
