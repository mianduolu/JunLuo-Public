import AsyncStorage from '@react-native-async-storage/async-storage';

import { createToolExecutionAttemptJournal } from './toolExecutionAttemptJournal';

export const localToolExecutionAttemptJournal = createToolExecutionAttemptJournal({
  storage: AsyncStorage,
});

export async function scanLocalToolExecutionAttempts(currentDataEpoch: number) {
  await localToolExecutionAttemptJournal.markStaleEpoch(currentDataEpoch);
  return localToolExecutionAttemptJournal.list();
}

export function markLocalToolExecutionAttemptsStale() {
  return localToolExecutionAttemptJournal.markAllUnsettledStale();
}
