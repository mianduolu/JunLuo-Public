import type { TheaterGenerationSnapshot } from './theaterGenerationStore';
import type { TheaterAnchor } from './theaterStoryTypes';

type AnchorSnapshot = TheaterGenerationSnapshot & { anchors?: TheaterAnchor[] };

/** This also works on a regeneration prefix; its target and future have no positions here. */
export function effectiveTheaterAnchors(snapshot: AnchorSnapshot): TheaterAnchor[] {
  const positions = new Map(snapshot.adoptions.map((entry, index) => [entry.positionId, index]));
  return (snapshot.anchors ?? []).filter(anchor => {
    const index = positions.get(anchor.positionId);
    const version = index === undefined ? undefined : snapshot.versions[index];
    return anchor.confirmed && anchor.content.trim().length > 0
      && anchor.conversationId === snapshot.story.id && anchor.branchId === snapshot.branch.id
      && version?.kind === 'dialogue' && version.conversationId === snapshot.story.id
      && version.positionId === anchor.positionId && version.id === anchor.sourceVersionId
      && version.id === snapshot.adoptions[index!].versionId;
  }).sort((a, b) => positions.get(a.positionId)! - positions.get(b.positionId)!);
}

/** New, unused anchors do not invalidate an already assembled request or delivered candidates. */
export function theaterUsedAnchorsUnchanged(used: readonly TheaterAnchor[], current: AnchorSnapshot): boolean {
  const effective = new Map(effectiveTheaterAnchors(current).map(anchor => [anchor.id, anchor]));
  return used.every(anchor => {
    const now = effective.get(anchor.id);
    return now !== undefined && now.conversationId === anchor.conversationId && now.branchId === anchor.branchId
      && now.positionId === anchor.positionId && now.sourceVersionId === anchor.sourceVersionId
      && now.content === anchor.content && now.source === anchor.source && now.updatedAt === anchor.updatedAt;
  });
}

export function buildTheaterAnchorBlock(snapshot: AnchorSnapshot): string | undefined {
  const anchors = effectiveTheaterAnchors(snapshot);
  if (!anchors.length) return undefined;
  const ordinals = new Map<string, number>();
  snapshot.adoptions.forEach((entry, index) => {
    if (snapshot.versions[index]?.kind === 'dialogue') ordinals.set(entry.positionId, ordinals.size + 1);
  });
  return [
    '【剧情锚点】',
    '保留以下已确认事实及其来由，承接后续剧情中的变化。',
    ...anchors.map(anchor => `第 ${ordinals.get(anchor.positionId)} 句：${anchor.content}`),
  ].join('\n');
}
