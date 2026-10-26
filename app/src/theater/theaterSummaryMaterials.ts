import type { TheaterGenerationSnapshot } from './theaterGenerationStore';
import { composeTheaterPersona } from './theaterTemplates';
import { theaterCheckpointCoverage } from './theaterSummaryStore';
import { buildTheaterAnchorBlock } from './theaterAnchorMaterials';

/** A summary is cumulative: never apply the reply's recent-message window here. */
export function buildTheaterSummaryMaterials(snapshot: TheaterGenerationSnapshot) {
  const settings = snapshot.story.settings;
  const covered = snapshot.checkpoint && snapshot.checkpoint.id === snapshot.branch.activeCheckpointId
    ? theaterCheckpointCoverage(snapshot, snapshot.checkpoint) : null;
  return {
    persona: composeTheaterPersona({ world: settings.world, youIdentity: settings.youIdentity,
      baiyunIdentity: settings.iIdentity, tone: settings.tone }),
    names: { I: settings.names.I, you: settings.names.you },
    anchorBlock: buildTheaterAnchorBlock(snapshot),
    messages: theaterSummaryMessageSources(snapshot).map(({ role, content }) => ({ role, content })),
    previousStoryState: covered !== null ? snapshot.checkpoint!.content : undefined,
  };
}

/** The returned order is the model's one-based source_message_index, not the whole-story ordinal. */
export function theaterSummaryMessageSources(snapshot: TheaterGenerationSnapshot) {
  const { story, branch, adoptions, versions, checkpoint } = snapshot;
  const covered = checkpoint && checkpoint.id === branch.activeCheckpointId
    ? theaterCheckpointCoverage(snapshot, checkpoint) : null;
  return adoptions.flatMap((adoption, index): {
    role: 'I' | 'you'; content: string; positionId: string; sourceVersionId: string;
  }[] => {
    const version = versions[index];
    if (!version || version.id !== adoption.versionId || version.positionId !== adoption.positionId
      || version.conversationId !== story.id) throw new Error('theater-material-adoption-mismatch');
    return (covered === null || index > covered) && version.kind === 'dialogue' && version.content.trim()
      ? [{ role: version.subject, content: version.content,
        positionId: adoption.positionId, sourceVersionId: adoption.versionId }] : [];
  });
}
