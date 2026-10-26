import type { TheaterGenerationSnapshot } from './theaterGenerationStore';
import { composeTheaterPersona } from './theaterTemplates';
import { TheaterGenerationBasisError } from './theaterGenerationStore';
import { buildTheaterAnchorBlock } from './theaterAnchorMaterials';

// Cut the story before windowing or checking the checkpoint: neither an old
// answer nor a summary of its future may leak into a regeneration request.
export function theaterRegenerationPrefix(snapshot: TheaterGenerationSnapshot, positionId: string) {
  const index = snapshot.adoptions.findIndex(entry => entry.positionId === positionId);
  const target = snapshot.versions[index];
  if (index < 0 || target?.kind !== 'dialogue' || target.subject !== 'I') throw new TheaterGenerationBasisError();
  return { ...snapshot, adoptions: snapshot.adoptions.slice(0, index), versions: snapshot.versions.slice(0, index) };
}

export function buildTheaterGenerationMaterials(snapshot: TheaterGenerationSnapshot, opening: boolean) {
  const { story, branch, adoptions, versions, checkpoint } = snapshot;
  if (opening && adoptions.length) throw new Error('theater-opening-requires-empty-branch');
  const messages = adoptions.flatMap((adoption, index): { role: 'I' | 'you'; content: string }[] => {
    const version = versions[index];
    if (!version || version.id !== adoption.versionId || version.positionId !== adoption.positionId
      || version.conversationId !== story.id) throw new Error('theater-material-adoption-mismatch');
    return version.kind === 'dialogue' && version.content.trim()
      ? [{ role: version.subject, content: version.content }] : [];
  });
  let unresolvedStart = messages.length;
  while (unresolvedStart > 0 && messages[unresolvedStart - 1].role === 'you') unresolvedStart--;
  const limit = Number.isFinite(story.settings.contextLimit) ? Math.max(1, Math.floor(story.settings.contextLimit)) : 20;
  const start = Math.min(Math.max(0, messages.length - limit), unresolvedStart);
  const covered = checkpoint?.coveredPositionId
    ? adoptions.findIndex((entry) => entry.positionId === checkpoint.coveredPositionId) : -1;
  const validCheckpoint = !opening && checkpoint?.status === 'saved'
    && checkpoint.id === branch.activeCheckpointId && checkpoint.conversationId === story.id
    && checkpoint.branchId === branch.id && covered >= 0
    && checkpoint.basis.length === covered + 1
    && checkpoint.basis.every((entry, index) => entry.positionId === adoptions[index].positionId
      && entry.versionId === adoptions[index].versionId);
  const settings = story.settings;
  return {
    persona: composeTheaterPersona({ world: settings.world, youIdentity: settings.youIdentity,
      baiyunIdentity: settings.iIdentity, tone: settings.tone }),
    names: { I: settings.names.I, you: settings.names.you },
    anchorBlock: opening ? undefined : buildTheaterAnchorBlock(snapshot),
    storyState: validCheckpoint && checkpoint.content.trim() ? checkpoint.content : undefined,
    messages: messages.slice(start),
    openingPrompt: opening ? settings.openingPrompt : undefined,
    temperature: settings.temperature,
  };
}
