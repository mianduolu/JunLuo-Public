import { sendTheaterCompletion, type TheaterCompletionOptions } from '../ai/openAiCompatibleProvider';
import {
  captureBackupRestoreDataEpoch, canCommitBackupRestoreDataEpoch,
  runBackupRestoreDataEpochCommit, subscribeBackupRestoreRuntimeState,
} from '../backup/backupRestoreCoordinator';
import { buildTheaterGenerationMaterials } from './theaterGenerationMaterials';
import { TheaterGenerationSession } from './theaterGenerationSession';
import { createTheaterGenerationRepository } from './theaterGenerationStore';
import type { TheaterStoryDatabase } from './theaterStoryStore';

type Model = Pick<TheaterCompletionOptions, 'apiKey' | 'connection'>;

// The feature owner creates ONE instance and passes it to every theater view.
// It must supply an already-migrated database after activation is authorized.
// No database opening, migration, model request or view-lifetime disposal here.
export function createTheaterGenerationRuntime(options: {
  database: TheaterStoryDatabase;
  getModel: () => Model | null;
  createId: () => string;
  saveAlternative?: ConstructorParameters<typeof TheaterGenerationSession>[0]['saveAlternative'];
  onReplySaved?: ConstructorParameters<typeof TheaterGenerationSession>[0]['onReplySaved'];
}) {
  return new TheaterGenerationSession({
    repository: createTheaterGenerationRepository(options.database),
    saveAlternative: options.saveAlternative,
    onReplySaved: options.onReplySaved,
    epoch: {
      captureDataEpoch: captureBackupRestoreDataEpoch,
      canCommitDataEpoch: canCommitBackupRestoreDataEpoch,
      runDataEpochCommit: runBackupRestoreDataEpochCommit,
      subscribeRuntimeState: subscribeBackupRestoreRuntimeState,
    },
    modelReady: () => options.getModel() !== null,
    createId: options.createId,
    reply: (snapshot, opening, signal) => {
      const model = options.getModel();
      if (!model) throw new Error('theater-model-not-configured');
      return sendTheaterCompletion({ ...model, ...buildTheaterGenerationMaterials(snapshot, opening), signal });
    },
  });
}
