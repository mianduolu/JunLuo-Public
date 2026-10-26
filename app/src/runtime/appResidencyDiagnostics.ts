import type { ChatSession } from '../chat/chatStorage';
import { getChatStorageResidencySnapshot } from '../chat/chatStorage';
import {
  createAppResidencyRecorder,
  summarizeChatRuntimeResidency,
  type AppResidencyLifecycleSnapshot,
  type ChatRuntimeResidencySnapshot,
} from './appResidencyDiagnosticsCore';

export {
  createAppResidencyLifecycleTracker,
  normalizeAppResidencyScreen,
  type AppResidencyLifecycleInput,
  type AppResidencyLifecycleSnapshot,
  type AppResidencyScreen,
} from './appResidencyDiagnosticsCore';

export const appResidencyDiagnosticsEnabled =
  process.env.EXPO_PUBLIC_JUNLUO_RESIDENCY_DIAGNOSTICS === '1';

let chatRuntimeResidencySnapshot: ChatRuntimeResidencySnapshot = {
  residentMessageCount: 0,
  residentSessionCount: 0,
};

const recorder = createAppResidencyRecorder({
  emit: (line) => console.info(line),
  enabled: appResidencyDiagnosticsEnabled,
  readChatRuntime: () => chatRuntimeResidencySnapshot,
  readChatStorage: getChatStorageResidencySnapshot,
});

export function updateChatRuntimeResidencySnapshot(sessions: readonly ChatSession[]) {
  if (!appResidencyDiagnosticsEnabled) return;
  chatRuntimeResidencySnapshot = summarizeChatRuntimeResidency(sessions);
}

export function recordAppResidencySnapshot(lifecycle: AppResidencyLifecycleSnapshot) {
  return recorder.record(lifecycle);
}
