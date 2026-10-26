import { captureBackupRestoreDataEpoch, subscribeBackupRestoreRuntimeState } from '../backup/backupRestoreCoordinator';
import { initializeSharedExperienceBookmark, loadInnerUpdateState, updateInnerUpdateState } from '../chat/chatAfterglowState';
import { TheaterCoCreationSelectionSession } from './theaterCoCreationSelectionSession';
import { loadTheaterCoCreationSources, theaterNeedsCapacitySelection, clearTheaterCapacitySelection } from './theaterCoCreationRuntime';

export function createTheaterCoCreationSelectionRuntime() {
  const session = new TheaterCoCreationSelectionSession({
    load: loadTheaterCoCreationSources,
    progress: async () => (await loadInnerUpdateState())?.experience
      ?? (await initializeSharedExperienceBookmark(Date.now(), captureBackupRestoreDataEpoch()))?.experience ?? null,
    epoch: captureBackupRestoreDataEpoch,
    needsSelection: theaterNeedsCapacitySelection,
    save: async (source, selection, epoch) => {
      const saved = await updateInnerUpdateState(epoch, state => {
        if (!state?.experience || state.experience.processed[`theater-unit:${source.positionId}`] !== undefined) return state;
        const attempts = state.experience.theaterSelections?.[source.positionId]?.attempts;
        return { ...state, experience: { ...state.experience, updatedAt: selection.updatedAt,
          theaterSelections: { ...state.experience.theaterSelections,
            [source.positionId]: { ...selection, ...(attempts ? { attempts } : {}) } } } };
      });
      if (saved?.experience?.theaterSelections?.[source.positionId]?.updatedAt !== selection.updatedAt) throw new Error('theater-selection-not-saved');
      clearTheaterCapacitySelection(source.positionId);
    },
  });
  const unsubscribe = subscribeBackupRestoreRuntimeState(() => session.invalidate());
  return { session, dispose: unsubscribe };
}
