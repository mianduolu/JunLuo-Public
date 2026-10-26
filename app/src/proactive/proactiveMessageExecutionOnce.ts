import { loadBackendSettings } from '../backend/backendClient';
import { loadChatState } from '../chat/chatStorage';
import { createAndroidSyncExecutionOnceController } from '../sync/syncExecutionOnceExpo';
import type {
  SyncExecutionOutcomeV2,
} from '../sync/syncExecutionClaimV2Protocol';
import { loadCurrentSyncRelayEnrollment } from '../sync/syncRelayClientExpo';

import {
  createProactiveAgentTaskMessageIdPrefix,
  createProactiveMessageDeliveryMessageIdPrefix,
  runProactiveAgentTaskHandlingOnce,
  runProactiveMessageDeliveryOnce,
  type ProactiveMessageDeliveryIdentity,
} from './proactiveMessageExecutionOnceCore';
import {
  applyAgentTaskExecutionReceipt,
  cancelAgentTask,
  loadAgentTaskById,
} from './agentTaskStore';

async function hasAgentTaskDeliveryEvidence(taskId: string) {
  const prefix = `${createProactiveAgentTaskMessageIdPrefix(taskId)}-`;
  const { sessions } = await loadChatState();
  return sessions.some((session) => (
    session.messages.some((message) => message.id.startsWith(prefix))
  ));
}

export async function hasProactiveMessageDeliveryEvidence(
  identity: ProactiveMessageDeliveryIdentity,
) {
  const prefix = `${createProactiveMessageDeliveryMessageIdPrefix(identity)}-`;
  const { sessions } = await loadChatState();
  return sessions.some((session) => (
    session.messages.some((message) => message.id.startsWith(prefix))
  ));
}

export async function executeProactiveMessageDeliveryOnce(
  identity: ProactiveMessageDeliveryIdentity,
  callbacks: {
    applyReceipt(
      outcome: SyncExecutionOutcomeV2,
      completedAt: number,
    ): Promise<void>;
    executeLocally(): Promise<SyncExecutionOutcomeV2>;
    reconcileLocally(): Promise<SyncExecutionOutcomeV2 | null>;
  },
) {
  const enrollment = await loadCurrentSyncRelayEnrollment();
  return runProactiveMessageDeliveryOnce(identity, {
    ...callbacks,
    syncEnrollmentReady: enrollment !== null,
    hasDeliveryEvidence: () => hasProactiveMessageDeliveryEvidence(identity),
    loadRelayBaseUrl: async () => (await loadBackendSettings()).baseUrl,
    createCoordinator: async (baseUrl) => (
      await createAndroidSyncExecutionOnceController({ baseUrl })
    ).coordinator,
  });
}

export async function executeProactiveAgentTaskHandlingOnce(
  taskId: string,
  executeLocally: () => Promise<SyncExecutionOutcomeV2>,
) {
  const enrollment = await loadCurrentSyncRelayEnrollment();
  return runProactiveAgentTaskHandlingOnce(taskId, {
    syncEnrollmentReady: enrollment !== null,
    loadTask: loadAgentTaskById,
    executeLocally,
    hasDeliveryEvidence: hasAgentTaskDeliveryEvidence,
    applyReceipt: async (id, outcome, completedAt) => {
      await applyAgentTaskExecutionReceipt(id, outcome, completedAt);
    },
    loadRelayBaseUrl: async () => (await loadBackendSettings()).baseUrl,
    createCoordinator: async (baseUrl) => (
      await createAndroidSyncExecutionOnceController({ baseUrl })
    ).coordinator,
  });
}

export async function cancelAgentTaskOnce(taskId: string) {
  const result = await executeProactiveAgentTaskHandlingOnce(
    taskId,
    async () => (
      await cancelAgentTask(taskId) ? 'cancelled' : 'failed'
    ),
  );
  return result.outcome === 'cancelled';
}
