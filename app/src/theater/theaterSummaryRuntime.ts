import { generateTheaterStoryState, preflightTheaterSummary } from '../ai/openAiCompatibleProvider';
import { captureBackupRestoreDataEpoch, canCommitBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit,
  subscribeBackupRestoreRuntimeState } from '../backup/backupRestoreCoordinator';
import type { createTheaterGenerationRuntime } from './theaterGenerationRuntime';
import type { TheaterGenerationSession } from './theaterGenerationSession';
import { createTheaterSummaryRepository } from './theaterSummaryStore';
import { buildTheaterSummaryMaterials } from './theaterSummaryMaterials';
import { TheaterSummarySession } from './theaterSummarySession';
import type { TheaterAnchorSession } from './theaterAnchorSession';

// Receives the same migrated DB and request owner as the unmounted branch runtime.
export function createTheaterSummaryRuntime(options: Parameters<typeof createTheaterGenerationRuntime>[0], generation: TheaterGenerationSession, anchors?: TheaterAnchorSession) {
  return new TheaterSummarySession({ repository: createTheaterSummaryRepository(options.database), generation,
    anchors, createId: options.createId, modelReady: () => options.getModel() !== null,
    epoch: { captureDataEpoch: captureBackupRestoreDataEpoch, canCommitDataEpoch: canCommitBackupRestoreDataEpoch,
      runDataEpochCommit: runBackupRestoreDataEpochCommit, subscribeRuntimeState: subscribeBackupRestoreRuntimeState },
    preflight: snapshot => {
      const model = options.getModel(); if (!model) throw new Error('theater-model-not-configured');
      preflightTheaterSummary({ connection: model.connection, ...buildTheaterSummaryMaterials(snapshot) });
    },
    generate: (snapshot, signal) => {
      const model = options.getModel(); if (!model) throw new Error('theater-model-not-configured');
      return generateTheaterStoryState({ ...model, ...buildTheaterSummaryMaterials(snapshot), signal });
    },
  });
}
