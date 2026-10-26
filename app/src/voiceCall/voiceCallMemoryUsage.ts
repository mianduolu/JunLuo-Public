import { canCommitBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { createMemoryUsageReceipt, settleSavedMemoryUsage, commitMemoryReplyUsage,
  type MemoryUsageReceipt } from '../memory/memoryReplyUsage';
import type { MemoryBundle } from '../memory/memoryOrchestrator';
import { isCurrentStateReference } from '../memory/memoryReadReference';
import { currentStateVersion, loadMemoryCurrentState } from '../memory/memoryCurrentStateStore';
import { isVoiceCallMemoryUsageReceipt } from './voiceCallRecordFormat';

export { isVoiceCallMemoryUsageReceipt } from './voiceCallRecordFormat';

/** Host-only evidence of the actual request. Contains identities, never memory prose. */
export type VoiceCallMemoryUsageReceipt = {
  version: 1;
  callId: string;
  turnId: string;
  dataEpoch: number | null;
  receipt: MemoryUsageReceipt;
  currentStates: Array<{ currentStateId: string; version: string; sourceVersion?: string }>;
};

export function createVoiceCallMemoryUsageReceipt(
  callId: string, turnId: string, dataEpoch: number | null, bundle?: MemoryBundle | null,
): VoiceCallMemoryUsageReceipt {
  return {
    version: 1, callId, turnId, dataEpoch,
    receipt: createMemoryUsageReceipt(`voice-call:${callId}:${turnId}`, bundle?.memoryUsageReferences ?? []),
    currentStates: (bundle?.memoryMentionItems ?? []).flatMap(item => isCurrentStateReference(item)
      && bundle?.visibleMemoryIds?.has(JSON.stringify(['current_state', item.currentState.id]))
      ? [{ currentStateId: item.currentState.id, version: item.version, sourceVersion: item.sourceVersion }] : []),
  };
}

/** The caller has persisted and reread the formal call card before entering here. */
export async function settleVoiceCallMemoryUsage(record: {
  callId: string;
  turns: readonly { turnId: string; role: 'I' | 'you'; text: string }[];
  memoryUsageReceipts?: readonly VoiceCallMemoryUsageReceipt[];
}, savedAt: number, canCommit?: () => boolean,
options?: { recoveryDataEpoch?: number | null }): Promise<void> {
  if (!Number.isFinite(savedAt) || savedAt <= 0) return;
  const receipts = new Map((record.memoryUsageReceipts ?? []).filter(isVoiceCallMemoryUsageReceipt)
    .map(receipt => [receipt.receipt.operationId, receipt]));
  for (const receipt of receipts.values()) {
    const savedTurn = record.turns.find(turn => turn.role === 'I' && turn.turnId === receipt.turnId && !!turn.text.trim());
    if (receipt.callId !== record.callId || !savedTurn) continue;
    // Only the startup caller that reread this formal card may rebind a persisted receipt.
    const dataEpoch = options?.recoveryDataEpoch === undefined ? receipt.dataEpoch : options.recoveryDataEpoch;
    const current = () => canCommitBackupRestoreDataEpoch(dataEpoch) && (canCommit?.() ?? true);
    if (!current()) continue;
    await settleSavedMemoryUsage({ receipt: receipt.receipt, savedAt, dataEpoch, canCommit: current });
    if (!receipt.currentStates.length) continue;
    for (let attempt = 0; attempt <= 3 && current(); attempt++) {
      try {
        const references = [];
        for (const ref of receipt.currentStates) {
          const state = await loadMemoryCurrentState(ref.currentStateId);
          if (!state || state.status !== 'active' || state.expiresAt !== undefined && state.expiresAt <= Date.now()
            || currentStateVersion(state) !== ref.version) continue;
          references.push({ targetKind: 'current_state' as const, currentState: state,
            version: ref.version, sourceVersion: ref.sourceVersion });
        }
        await commitMemoryReplyUsage({ dataEpoch, references, receipts: [],
          messages: [{ id: receipt.receipt.operationId, role: 'I', content: savedTurn.text, createdAt: savedAt }],
          canCommit: current,
          validateReference: async (ref, transaction) => {
            if (!isCurrentStateReference(ref)) return false;
            const state = await loadMemoryCurrentState(ref.currentState.id, transaction);
            return !!state && (state.expiresAt === undefined || state.expiresAt > Date.now());
          } });
        break;
      } catch {
        if (attempt === 3 && current()) console.warn('[voice-call] usage settlement failed', { operationId: receipt.receipt.operationId });
      }
    }
  }
}
