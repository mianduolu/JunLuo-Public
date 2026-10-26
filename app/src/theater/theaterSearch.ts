import type { TheaterStoryDetail } from './theaterBranchStore';
import type { TheaterBinding } from './theaterGenerationStore';
import type { TheaterTextVersion } from './theaterStoryTypes';
import { effectiveTheaterAnchors } from './theaterAnchorMaterials';
import { theaterCheckpointCoverage } from './theaterSummaryStore';

export type TheaterSearchScope = 'branch' | 'story';
type Source = TheaterBinding & { id: string; branchName: string; source: string; content: string };
export type TheaterSearchResult = Source & (
  | { kind: 'dialogue' | 'alternative'; positionId: string; versionId: string; ordinal: number;
    speaker: string; version: TheaterTextVersion }
  | { kind: 'branch'; messages: { version: TheaterTextVersion; speaker: string }[] }
  | { kind: 'anchor'; anchorId: string; positionId: string; ordinal: number | null; needsReview: boolean }
  | { kind: 'checkpoint'; checkpointId: string; active: boolean }
);

/** Enumerate only source records. Search has no store, model, adoption, or draft write port. */
export function theaterSearchEntries(detail: TheaterStoryDetail, binding: TheaterBinding,
  scope: TheaterSearchScope): TheaterSearchResult[] {
  if (detail.story.id !== binding.storyId) return [];
  const results: TheaterSearchResult[] = [];
  const all = new Map(detail.versions.map(version => [version.id, version]));
  const alternatives = new Map<string, TheaterTextVersion[]>();
  for (const version of detail.versions) {
    if (version.kind !== 'dialogue' || version.subject !== 'I') continue;
    const group = alternatives.get(version.positionId) ?? [];
    group.push(version); alternatives.set(version.positionId, group);
  }
  for (const item of detail.branches) {
    const branch = item.branch;
    if (scope === 'branch' && branch.id !== binding.branchId) continue;
    const versions = item.adoptions.map(entry => {
      const version = all.get(entry.versionId);
      if (!version || version.positionId !== entry.positionId || version.conversationId !== detail.story.id) {
        throw new Error('theater-search-adoption-mismatch');
      }
      return version;
    });
    const base = { storyId: detail.story.id, branchId: branch.id, branchName: branch.name };
    const id = (kind: string, record: string) => JSON.stringify([detail.story.id, branch.id, kind, record]);
    const names = detail.story.settings.names;
    const messages = versions.filter(version => version.kind === 'dialogue')
      .map(version => ({ version, speaker: names[version.subject!] }));
    results.push({ ...base, id: id('branch', branch.id), kind: 'branch', content: branch.name,
      source: `${branch.name} · 剧情走向`, messages });
    const ordinals = new Map<string, number>();
    for (const version of versions) {
      if (version.kind !== 'dialogue') continue;
      const ordinal = ordinals.size + 1;
      ordinals.set(version.positionId, ordinal);
      const speaker = names[version.subject];
      const source = `${branch.name} · 第 ${ordinal} 句 · ${speaker}`;
      results.push({ ...base, id: id('dialogue', version.id), kind: 'dialogue', content: version.content,
        source, ordinal, speaker, positionId: version.positionId, versionId: version.id, version });
      for (const alternative of alternatives.get(version.positionId) ?? []) {
        if (alternative.id === version.id) continue;
        results.push({ ...base, id: id('alternative', alternative.id), kind: 'alternative',
          content: alternative.content, source, ordinal, speaker, positionId: alternative.positionId,
          versionId: alternative.id, version: alternative });
      }
    }
    const snapshot = { story: detail.story, branch, adoptions: item.adoptions, versions,
      checkpoint: null, anchors: item.anchors };
    const effective = new Set(effectiveTheaterAnchors(snapshot).map(anchor => anchor.id));
    for (const anchor of item.anchors) results.push({ ...base, id: id('anchor', anchor.id), kind: 'anchor',
      anchorId: anchor.id, positionId: anchor.positionId, content: anchor.content,
      source: `${branch.name} · 剧情锚点`, ordinal: ordinals.get(anchor.positionId) ?? null,
      needsReview: !effective.has(anchor.id) });
    for (const checkpoint of item.checkpoints) {
      const active = !branch.staleCheckpointId && branch.activeCheckpointId === checkpoint.id
        && theaterCheckpointCoverage(snapshot, checkpoint) !== null;
      results.push({ ...base, id: id('checkpoint', checkpoint.id), kind: 'checkpoint',
        checkpointId: checkpoint.id, content: checkpoint.content, active,
        source: `${branch.name} · ${active ? '当前使用' : '历史小抄'}` });
    }
  }
  return results;
}

export function searchTheaterStory(detail: TheaterStoryDetail, binding: TheaterBinding,
  scope: TheaterSearchScope, query: string): TheaterSearchResult[] {
  const text = query.trim().toLocaleLowerCase();
  return text ? theaterSearchEntries(detail, binding, scope)
    .filter(result => result.content.toLocaleLowerCase().includes(text)) : [];
}

export function theaterSearchNeedsPreview(result: TheaterSearchResult, binding: TheaterBinding) {
  return result.branchId !== binding.branchId || result.kind === 'alternative'
    || (result.kind === 'checkpoint' && !result.active);
}
