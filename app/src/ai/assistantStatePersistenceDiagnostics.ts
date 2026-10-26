import AsyncStorage from '@react-native-async-storage/async-storage';

export const ASSISTANT_STATE_PERSISTENCE_DIAGNOSTIC_KEY = 'junluo.assistant.statePersistenceDiagnostic.v1';

export type AssistantStatePersistenceDiagnostic = {
  occurredAt: number;
  status: 'local-saved-sync-pending';
};

let persistenceDiagnosticQueue: Promise<void> = Promise.resolve();

function enqueuePersistenceDiagnosticWrite(operation: () => Promise<void>) {
  persistenceDiagnosticQueue = persistenceDiagnosticQueue.then(operation, operation);
  return persistenceDiagnosticQueue;
}

export async function loadAssistantStatePersistenceDiagnostic(): Promise<AssistantStatePersistenceDiagnostic | null> {
  const raw = await AsyncStorage.getItem(ASSISTANT_STATE_PERSISTENCE_DIAGNOSTIC_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<AssistantStatePersistenceDiagnostic>;
    return parsed.status === 'local-saved-sync-pending'
      && typeof parsed.occurredAt === 'number'
      && Number.isFinite(parsed.occurredAt)
      ? { occurredAt: parsed.occurredAt, status: parsed.status }
      : null;
  } catch {
    return null;
  }
}

export function recordAssistantStateSyncPending(occurredAt = Date.now()) {
  return enqueuePersistenceDiagnosticWrite(() => AsyncStorage.setItem(
    ASSISTANT_STATE_PERSISTENCE_DIAGNOSTIC_KEY,
    JSON.stringify({ occurredAt, status: 'local-saved-sync-pending' } satisfies AssistantStatePersistenceDiagnostic),
  ));
}

export function clearAssistantStatePersistenceDiagnostic() {
  return enqueuePersistenceDiagnosticWrite(() => AsyncStorage.removeItem(
    ASSISTANT_STATE_PERSISTENCE_DIAGNOSTIC_KEY,
  ));
}
