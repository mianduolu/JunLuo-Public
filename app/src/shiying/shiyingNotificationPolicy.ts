import { createShiyingBatchNotificationId } from '../schedule/localNotificationIdentity';

export const SHIYING_NOTIFICATION_TITLE = '拾荧';
export const SHIYING_NOTIFICATION_BODY = '我捡到了一点小仓鼠散落的荧光噢！';
export const SHIYING_NOTIFICATION_CHANNEL = 'junluo-shiying-quiet-v1';

export type ShiyingNotificationPayloadV1 = {
  kind: 'shiying';
  payloadVersion: 1;
  batchId: string;
  operationId: string;
};
export type ShiyingBackfillNotificationPayload = {
  kind: 'shiying'; payloadVersion: 2; batchId: string; operationId: string; taskId: string; entryIds: string[];
};
export type ShiyingNotificationPayload = ShiyingNotificationPayloadV1 | ShiyingBackfillNotificationPayload;
export function createShiyingBackfillNotificationId(taskId: string) { return `junluo.local.v2.shiying.backfill.${taskId}`; }

export type ShiyingOpenRequest = {
  requestId: string;
  batchId: string;
  dataEpoch: number;
};

let featureVisible = false;

export function setShiyingNotificationPolicyFeatureVisible(visible: boolean) {
  featureVisible = visible;
}

export function isShiyingNotificationFeatureVisible() {
  return featureVisible;
}

export function isShiyingNotificationDomain(value: unknown): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && (value as { kind?: unknown }).kind === 'shiying';
}

export function isShiyingNotificationPayload(value: unknown): value is ShiyingNotificationPayload {
  if (!isShiyingNotificationDomain(value)) return false;
  const data = value as ShiyingNotificationPayload;
  if (typeof data.batchId !== 'string' || !/^shiying-batch-v1-[0-9a-f]{64}$/u.test(data.batchId)) return false;
  if (data.payloadVersion === 1) return Object.keys(data).length === 4
    && data.operationId === createShiyingBatchNotificationId(data.batchId);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
  return data.payloadVersion === 2 && Object.keys(data).length === 6 && uuid.test(data.taskId)
    && data.operationId === createShiyingBackfillNotificationId(data.taskId)
    && Array.isArray(data.entryIds) && data.entryIds.length > 0 && data.entryIds.length <= 93
    && data.entryIds.every(id => typeof id === 'string' && uuid.test(id))
    && new Set(data.entryIds).size === data.entryIds.length;
}

export function shiyingNotificationBehavior(data: unknown, appActive = false) {
  if (!isShiyingNotificationDomain(data)) return null;
  return {
    shouldPlaySound: false,
    shouldSetBadge: false,
    shouldShowBanner: false,
    shouldShowList: isShiyingNotificationPayload(data) && !(appActive && featureVisible),
  };
}
