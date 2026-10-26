import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import type { AiConnection } from '../ai/types';
import {
  canCommitBackupRestoreDataEpoch,
  runBackupRestoreDataEpochCommit,
} from '../backup/backupRestoreCoordinator';
import { proposeConversationMemory } from './memoryOrganizer';
import { createMemory, loadMemories } from './memoryStore';

export type ExperienceMemoryMetadata = {
  source: string;
  sourceEndAt: number;
  sourceStartAt: number;
};

export type ExperienceOrganizerConfig = {
  apiKey: string;
  connection: AiConnection;
};

export type ExperienceOrganizerOptions = {
  dataEpoch?: number | null;
};

function normalizeMemoryText(value: string) {
  return value.replace(/\s+/g, '').toLowerCase();
}

export async function organizeAndPersistExperience(
  transcript: SubjectiveMessage[],
  metadata: ExperienceMemoryMetadata,
  organizerConfig?: ExperienceOrganizerConfig,
  options: ExperienceOrganizerOptions = {},
) {
  if (!organizerConfig?.apiKey.trim() || !transcript.length) return [];
  const canPersist = () => options.dataEpoch === undefined
    || canCommitBackupRestoreDataEpoch(options.dataEpoch);
  if (!canPersist()) return [];
  const candidates = await proposeConversationMemory({
    apiKey: organizerConfig.apiKey,
    connection: organizerConfig.connection,
    messages: transcript,
  });
  if (!candidates.length || !canPersist()) return [];

  const existing = await loadMemories();
  if (!canPersist()) return [];
  const known = new Set(existing.filter(memory => !memory.understandingSubject).map((memory) => normalizeMemoryText(memory.content)));
  const persistCandidates = async () => {
    const savedIds: string[] = [];
    for (const candidate of candidates) {
      const normalized = normalizeMemoryText(candidate.content);
      if (!normalized || known.has(normalized)) continue;
      known.add(normalized);
      const id = await createMemory({
        ...candidate,
        source: metadata.source,
        sourceEndAt: metadata.sourceEndAt,
        sourceStartAt: metadata.sourceStartAt,
      }, {
        continuationAi: organizerConfig,
        dataEpoch: options.dataEpoch,
      });
      savedIds.push(id);
    }
    return savedIds;
  };
  if (options.dataEpoch === undefined) return persistCandidates();
  const persisted = await runBackupRestoreDataEpochCommit(options.dataEpoch, persistCandidates);
  return persisted.committed ? persisted.value : [];
}
