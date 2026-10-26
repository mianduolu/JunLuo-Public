import { assertJsonValue, type JsonValue } from './syncProtocol';

export type SyncDurableIntentState = 'prepared' | 'business_written' | 'captured';

export type SyncDurableIntent = {
  operationId: string;
  adapterId: string;
  intent: JsonValue;
  state: SyncDurableIntentState;
  createdAt: number;
  updatedAt: number;
};

const NEXT_STATE: Record<SyncDurableIntentState, SyncDurableIntentState | null> = {
  prepared: 'business_written',
  business_written: 'captured',
  captured: null,
};

export function assertSyncDurableIntent(intent: SyncDurableIntent) {
  if (!intent.operationId || intent.operationId.length > 160) {
    throw new Error('operationId 格式无效。');
  }
  if (!intent.adapterId || intent.adapterId.length > 160) {
    throw new Error('adapterId 格式无效。');
  }
  assertJsonValue(intent.intent, 'intent');
  if (
    !Number.isSafeInteger(intent.createdAt)
    || intent.createdAt < 0
    || !Number.isSafeInteger(intent.updatedAt)
    || intent.updatedAt < intent.createdAt
  ) {
    throw new Error('durable intent 时间无效。');
  }
}

export function assertSyncDurableIntentTransition(
  from: SyncDurableIntentState,
  to: SyncDurableIntentState,
) {
  if (from === to) return;
  if (NEXT_STATE[from] !== to) {
    throw new Error(`durable intent 不能从 ${from} 跳到 ${to}。`);
  }
}

