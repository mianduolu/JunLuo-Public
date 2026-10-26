import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import { getChatStorageResidencySnapshot } from './chatStorage';
import {
  CHAT_HISTORY_RESIDENCY_MARKER_PREFIX,
  createChatHistoryResidencyTracker,
  normalizeChatHistoryDiagnosticProfile,
  type ChatHistoryResidencyPhase,
} from './chatHistoryResidencyDiagnosticsCore';

export const chatHistoryDiagnosticProfile = normalizeChatHistoryDiagnosticProfile(
  process.env.EXPO_PUBLIC_JUNLUO_CHAT_HISTORY_DIAGNOSTIC_PROFILE,
);

export const chatHistoryResidencyDiagnosticsEnabled = chatHistoryDiagnosticProfile !== null;

const tracker = createChatHistoryResidencyTracker();
const emittedPhases = new Set<ChatHistoryResidencyPhase>();
const pendingTimers = new Map<ChatHistoryResidencyPhase, ReturnType<typeof setTimeout>>();

export function canLoadHistoryDiagnosticOlderPage() {
  return !chatHistoryResidencyDiagnosticsEnabled || tracker.canLoadOlderPage();
}

export function noteHistoryDiagnosticPageLoaded(messages: readonly SubjectiveMessage[]) {
  if (!chatHistoryResidencyDiagnosticsEnabled) return false;
  return tracker.registerLoadedPage(messages);
}

export function registerHistoryDiagnosticMountedRow(message: SubjectiveMessage) {
  if (!chatHistoryResidencyDiagnosticsEnabled) return () => undefined;
  return tracker.registerMountedRow(message);
}

export function scheduleHistoryResidencySnapshot(
  phase: ChatHistoryResidencyPhase,
  residentMessageCount: number,
  options: { clearLoadedPageIds?: boolean; delayMs?: number } = {},
) {
  if (
    !chatHistoryResidencyDiagnosticsEnabled
    || emittedPhases.has(phase)
    || pendingTimers.has(phase)
  ) return;
  const timer = setTimeout(() => {
    pendingTimers.delete(phase);
    if (emittedPhases.has(phase)) return;
    emittedPhases.add(phase);
    const snapshot = tracker.snapshot(
      phase,
      residentMessageCount,
      getChatStorageResidencySnapshot(),
    );
    console.info(`${CHAT_HISTORY_RESIDENCY_MARKER_PREFIX}${JSON.stringify(snapshot)}`);
    if (options.clearLoadedPageIds) tracker.clearLoadedPageIds();
  }, options.delayMs ?? 350);
  pendingTimers.set(phase, timer);
}

export function hasHistoryDiagnosticLoadedPage() {
  return chatHistoryResidencyDiagnosticsEnabled && !tracker.canLoadOlderPage();
}
