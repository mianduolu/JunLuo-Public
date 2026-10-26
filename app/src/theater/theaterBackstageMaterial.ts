import type { TheaterGenerationSnapshot } from './theaterGenerationStore';
import type { TheaterTextVersion } from './theaterStoryTypes';
import { theaterCheckpointCoverage } from './theaterSummaryStore';
import { effectiveTheaterAnchors } from './theaterAnchorMaterials';

export type BackstageSource = {
  binding: { storyId: string; branchId: string };
  title: string;
  branchName: string;
  names: { I: string; you: string };
  world: string;
  checkpoint: { id: string; content: string } | null;
  anchors: { id: string; content: string }[];
  lines: { id: string; subject: 'I' | 'you'; content: string }[];
  revision: string;
};

export type BackstageSelection = {
  world: { included: boolean; text: string };
  checkpoint: { included: boolean; text: string };
  anchorIds: string[];
  lineIds: string[];
};

export function buildBackstageSource(
  snapshot: TheaterGenerationSnapshot,
  allVersions: TheaterTextVersion[] = snapshot.versions,
): BackstageSource {
  const { story, branch, adoptions, versions, checkpoint } = snapshot;
  if (branch.conversationId !== story.id || versions.length !== adoptions.length
    || adoptions.some((entry, index) => {
      const version = versions[index];
      return !version || version.id !== entry.versionId || version.positionId !== entry.positionId
        || version.conversationId !== story.id;
    })) throw new Error('theater-backstage-adoption-mismatch');

  const known = new Map(allVersions.filter(v => v.conversationId === story.id).map(v => [v.id, v]));
  versions.forEach(version => known.set(version.id, version));
  const origins = [...known.values()].filter(v => v.kind === 'dialogue' && v.subject === 'I'
    && v.origin === 'generated' && v.coCreation);
  const dialogue = versions.filter((v): v is TheaterTextVersion & { kind: 'dialogue' } => v.kind === 'dialogue');
  const units: typeof dialogue[] = [];
  let pending: typeof dialogue = [];
  dialogue.forEach((version, index) => {
    if (version.subject === 'you') { pending.push(version); return; }
    // The original saved generation proves this position was completed. An edited
    // adopted version is a story quote, never a newly completed co-creation event.
    const completed = origins.some(origin => {
      if (origin.positionId !== version.positionId) return false;
      const receipt = origin.coCreation!;
      if (!Number.isSafeInteger(receipt.completedAt) || receipt.completedAt < origin.createdAt
        || receipt.youVersionIds.length !== pending.length) return false;
      if (!pending.length) return index === 0;
      return receipt.youVersionIds.every((id, ordinal) => {
        const original = known.get(id);
        return original?.kind === 'dialogue' && original.subject === 'you'
          && original.positionId === pending[ordinal].positionId;
      });
    });
    if (completed) units.push([...pending, version]);
    pending = [];
  });
  const selected = units.slice(-2).flat();
  const validCheckpoint = !branch.staleCheckpointId && checkpoint?.id === branch.activeCheckpointId
    && theaterCheckpointCoverage(snapshot, checkpoint) !== null ? checkpoint : null;
  const anchors = effectiveTheaterAnchors(snapshot);
  const binding = { storyId: story.id, branchId: branch.id };
  return {
    binding, title: story.title, branchName: branch.name, names: { ...story.settings.names },
    world: story.settings.world,
    checkpoint: validCheckpoint ? { id: validCheckpoint.id, content: validCheckpoint.content } : null,
    anchors: anchors.map(({ id, content }) => ({ id, content })),
    lines: selected.map(({ id, subject, content }) => ({ id, subject, content })),
    // Compare actual source text and version evidence, not editable names or timestamps.
    revision: JSON.stringify([binding, story.settings.world, validCheckpoint, anchors,
      selected.map(v => [v.id, v.positionId, v.kind, v.subject, v.content, v.origin]),
      origins.filter(v => selected.some(line => line.positionId === v.positionId))
        .map(v => [v.id, v.positionId, v.coCreation])]),
  };
}

export function fullBackstageSelection(source: BackstageSource): BackstageSelection {
  return {
    world: { included: !!source.world.trim(), text: source.world },
    checkpoint: { included: !!source.checkpoint, text: source.checkpoint?.content ?? '' },
    anchorIds: source.anchors.map(anchor => anchor.id),
    lineIds: source.lines.map(line => line.id),
  };
}

export function renderBackstageCard(source: BackstageSource, selection: BackstageSelection, mode: 'full' | 'slim'): string {
  const sections = [
    '【小剧场·幕后小卡】\n这是 I 与 you 一起写的故事，you 想和 I 一起聊聊这个故事。',
    `故事：${source.title}\n走向：${source.branchName}`,
  ];
  const add = (title: string, content: string) => {
    if (content.trim()) sections.push(`【${title}】\n${content}`);
  };
  if (mode === 'full' && source.world.trim() && selection.world.included) add('世界设定', selection.world.text);
  if (source.checkpoint && selection.checkpoint.included) add('前情小抄', selection.checkpoint.text);
  add('剧情锚点', source.anchors.filter(anchor => selection.anchorIds.includes(anchor.id)).map(anchor => anchor.content).join('\n'));
  if (mode === 'full') add('最近台词', source.lines.filter(line => selection.lineIds.includes(line.id))
    .map(line => `${line.subject}：${line.content}`).join('\n'));
  return sections.join('\n\n');
}
