import type {
  SyncDurableIntent,
} from './syncRecoveryIntent';

export type SyncDurableIntentRecoveryHandler = {
  adapterId: string;
  kind: string;
  recover(intent: SyncDurableIntent): Promise<void>;
};

export type SyncStartupRecoveryReport = {
  recoveredOperationIds: string[];
  unresolved: Array<{
    operationId: string;
    adapterId: string;
    kind: string | null;
    reason: 'unknown-handler' | 'recovery-failed';
    error?: string;
  }>;
};

function intentKind(intent: SyncDurableIntent) {
  if (!intent.intent || typeof intent.intent !== 'object' || Array.isArray(intent.intent)) return null;
  const kind = (intent.intent as Record<string, unknown>).kind;
  return typeof kind === 'string' ? kind : null;
}

export function createSyncRecoveryDispatcher(
  handlers: readonly SyncDurableIntentRecoveryHandler[],
) {
  const byKey = new Map<string, SyncDurableIntentRecoveryHandler>();
  for (const handler of handlers) {
    if (!handler.adapterId || !handler.kind) throw new Error('sync recovery handler 标识不能为空。');
    const key = `${handler.adapterId}\u0000${handler.kind}`;
    if (byKey.has(key)) throw new Error(`sync recovery handler 重复：${handler.adapterId}/${handler.kind}。`);
    byKey.set(key, handler);
  }

  return async function recoverSyncDurableIntents(
    intents: readonly SyncDurableIntent[],
  ): Promise<SyncStartupRecoveryReport> {
    const report: SyncStartupRecoveryReport = {
      recoveredOperationIds: [],
      unresolved: [],
    };
    for (const intent of intents) {
      const kind = intentKind(intent);
      const handler = kind === null ? undefined : byKey.get(`${intent.adapterId}\u0000${kind}`);
      if (!handler) {
        report.unresolved.push({
          operationId: intent.operationId,
          adapterId: intent.adapterId,
          kind,
          reason: 'unknown-handler',
        });
        continue;
      }
      try {
        await handler.recover(intent);
        report.recoveredOperationIds.push(intent.operationId);
      } catch (error) {
        report.unresolved.push({
          operationId: intent.operationId,
          adapterId: intent.adapterId,
          kind,
          reason: 'recovery-failed',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return report;
  };
}
