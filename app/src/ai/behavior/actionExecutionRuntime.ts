import { getBaiyunLocalDateKey } from './actionBehaviorStore';
import {
  createBaiyunContinuityEvent,
  getBaiyunContinuityEvent,
  listBaiyunContinuityEvents,
  listBaiyunContinuityLinks,
  listOpenBaiyunContinuityEvents,
  recordBaiyunContinuityEvidence,
  type CreateBaiyunContinuityEventInput,
} from './continuityLedger';
import type { BaiyunContinuityEvidenceKind } from './continuityEvent';
import type { SystemStatusBatterySnapshot } from '../systemStatusAmbientContext';

export function buildBaiyunLowBatteryCareSourceId(input: {
  bucket: number;
  localDate: string;
  observedAt: number;
}) {
  return ['phone_low_battery', input.localDate, String(input.bucket), String(Math.trunc(input.observedAt))].join(':');
}

/** Factual delivery only: callers supply saved message ids or an actual UI receipt. */
export async function recordBaiyunCareDelivery(input: {
  sourceId: string;
  itemName: string;
  occurredAt?: number;
  messageIds?: readonly string[];
  notificationReceiptId?: string;
  uiReceiptId?: string;
  links?: CreateBaiyunContinuityEventInput['links'];
}) {
  if (!input.messageIds?.length && !input.uiReceiptId) return undefined;
  const occurredAt = input.occurredAt ?? Date.now();
  let event = await createBaiyunContinuityEvent({
    kind: 'care_process', subject: 'you', itemName: input.itemName,
    idempotencyKey: `real-care:${input.sourceId}`,
    source: { kind: 'real_care', sourceId: input.sourceId },
    occurredAt, occurredLocalDate: getBaiyunLocalDateKey(new Date(occurredAt)),
    timezoneOffsetMinutes: new Date(occurredAt).getTimezoneOffset(),
    links: input.links,
  });
  const receipts: Array<{ kind: BaiyunContinuityEvidenceKind; sourceId: string }> = [
    ...(input.messageIds ?? []).map((sourceId) => ({ kind: 'proactive_message_persisted' as const, sourceId })),
    ...(input.notificationReceiptId ? [{ kind: 'notification_dispatch_receipt' as const, sourceId: input.notificationReceiptId }] : []),
    ...(input.uiReceiptId ? [{ kind: 'ui_action_receipt' as const, sourceId: input.uiReceiptId }] : []),
  ];
  for (const receipt of receipts) {
    if (event.status === 'completed' || event.status === 'cancelled') break;
    const operationId = `real-care-receipt:${event.id}:${receipt.kind}:${receipt.sourceId}`;
    event = await recordBaiyunContinuityEvidence({
      eventId: event.id, expectedRevision: event.revision, operationId,
      evidence: { id: operationId, ...receipt, occurredAt, outcome: 'succeeded' },
      reasonCode: 'real_care_delivery_receipt',
    });
  }
  return event;
}

export async function reconcileBaiyunLowBatteryContinuityFromSystemStatus(input: {
  batteryState: SystemStatusBatterySnapshot['state'];
  observedAt?: number;
}) {
  if (input.batteryState !== 'charging' && input.batteryState !== 'full') {
    return { matched: 0, completed: 0 };
  }
  const observedAt = input.observedAt ?? Date.now();
  const events = (await listOpenBaiyunContinuityEvents()).filter((event) => (
    event.kind === 'care_process'
    && event.source.kind === 'real_care'
    && event.source.sourceId.startsWith('phone_low_battery:')
  ));
  let completed = 0;
  for (const event of events) {
    const current = await getBaiyunContinuityEvent(event.id).catch(() => null);
    if (!current || (current.status !== 'open' && current.status !== 'waiting')) continue;
    const operationId = `low-battery-care-recovery:${event.id}`;
    const updated = await recordBaiyunContinuityEvidence({
      eventId: current.id,
      expectedRevision: current.revision,
      operationId,
      evidence: {
        id: operationId,
        kind: 'observed_care_recovery',
        sourceId: `system-status:battery:${input.batteryState}`,
        occurredAt: observedAt,
        outcome: 'succeeded',
      },
      reasonCode: 'phone_started_charging',
    }).catch(() => undefined);
    if (updated?.status === 'completed') completed += 1;
  }
  return { matched: events.length, completed };
}

async function eventsLinkedToScheduleTarget(input: {
  targetKind: 'todo_item' | 'schedule_occurrence';
  targetId: string;
  statuses: readonly ('open' | 'waiting' | 'completed')[];
}) {
  const events = await listBaiyunContinuityEvents({ statuses: input.statuses });
  const linked: typeof events = [];
  for (const event of events) {
    const links = await listBaiyunContinuityLinks(event.id);
    if (links.some((link) => (
      link.relation === 'task'
      && link.targetKind === input.targetKind
      && link.targetId === input.targetId
    ))) {
      linked.push(event);
    }
  }
  return linked;
}

export async function recordBaiyunScheduleCompletionReceipt(input: {
  targetKind: 'todo_item' | 'schedule_occurrence';
  targetId: string;
  occurredAt?: number;
}) {
  const occurredAt = input.occurredAt ?? Date.now();
  const events = await eventsLinkedToScheduleTarget({
    ...input,
    statuses: ['open', 'waiting'],
  });
  let completed = 0;
  for (const event of events) {
    const operationId = [
      'schedule-continuity-completion',
      input.targetKind,
      input.targetId,
      event.id,
    ].join(':');
    const updated = await recordBaiyunContinuityEvidence({
      eventId: event.id,
      expectedRevision: event.revision,
      operationId,
      evidence: {
        id: operationId,
        kind: 'schedule_completion_receipt',
        sourceId: input.targetId,
        occurredAt,
        outcome: 'succeeded',
      },
      reasonCode: 'schedule_completion_receipt',
    }).catch(() => undefined);
    if (updated?.status === 'completed') completed += 1;
  }
  return { matched: events.length, completed };
}

export async function reopenBaiyunScheduleContinuity(input: {
  targetKind: 'todo_item' | 'schedule_occurrence';
  targetId: string;
  reopenRevision: string | number;
  occurredAt?: number;
}) {
  const occurredAt = input.occurredAt ?? Date.now();
  const completedEvents = await eventsLinkedToScheduleTarget({
    ...input,
    statuses: ['completed'],
  });
  const created = [];
  for (const previous of completedEvents) {
    created.push(await createBaiyunContinuityEvent({
      kind: previous.kind,
      subject: previous.subject,
      itemName: previous.itemName,
      parentEventId: previous.id,
      idempotencyKey: [
        'schedule-reopen',
        input.targetKind,
        input.targetId,
        input.reopenRevision,
        previous.id,
      ].join(':'),
      coalescingKey: [
        'schedule-reopen',
        input.targetKind,
        input.targetId,
        input.reopenRevision,
      ].join(':'),
      source: { kind: 'real_life', sourceId: input.targetId },
      occurredAt,
      occurredLocalDate: getBaiyunLocalDateKey(new Date(occurredAt)),
      timezoneOffsetMinutes: new Date(occurredAt).getTimezoneOffset(),
      permissionRequirements: previous.permissionRequirements,
      links: [{
        relation: 'task',
        targetKind: input.targetKind,
        targetId: input.targetId,
      }],
    }));
  }
  return { matched: completedEvents.length, created };
}
