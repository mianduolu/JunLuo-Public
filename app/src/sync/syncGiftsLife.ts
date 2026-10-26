import { assertJsonValue, assertPlainMutationV1, type JsonValue, type PlainMutationV1 } from './syncProtocol';
import type { ChatCoreMutationEnvelope } from './syncChatCore';
import { canonicalizeJsonV1 } from './syncCrypto';

export const GIFTS_LIFE_ADAPTER_ID = 'gifts.life' as const;
export const GIFT_SYNC_KINDS = ['gift', 'echo', 'activity', 'understanding'] as const;
export type GiftSyncKind = typeof GIFT_SYNC_KINDS[number];
export type GiftSyncRow = { [key: string]: JsonValue };
export type GiftSyncOriginal = { id: string; storageName: string; objectId: string; plaintextBytes: number; chunkCount: number; mediaType: string };
export type GiftSyncPayload = { schemaVersion: 1; kind: GiftSyncKind; record: GiftSyncRow; originals?: GiftSyncOriginal[] }
  | { schemaVersion: 1; kind: GiftSyncKind; giftId: string; deletedAt: number; deleteRelatedMemory?: boolean };

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function expect(value: unknown): asserts value { if (!value) throw Error('gift-sync-invalid'); }
const integer = (value: unknown, min = 0) => Number.isSafeInteger(value) && Number(value) >= min;
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const originalName = /^gift-original-[0-9a-f-]{36}(?:\.[a-z0-9]{1,16})?$/;
const objectId = /^[A-Za-z0-9_-]{43}$/;
function keys(value: Record<string, unknown>, allowed: string[]) { expect(Object.keys(value).every(key => allowed.includes(key))); }

export function giftSyncEntityId(kind: GiftSyncKind, row: Record<string, unknown>) {
  if (kind === 'gift') return String(row.id);
  if (kind === 'echo') return JSON.stringify([row.gift_id, row.id]);
  if (kind === 'activity') return JSON.stringify([row.gift_id, row.attachment_id, row.viewer]);
  return JSON.stringify([row.gift_id, row.gift_revision, row.attachment_id]);
}
export function giftSyncGiftId(payload: GiftSyncPayload) {
  return 'record' in payload ? String(payload.kind === 'gift' ? payload.record.id : payload.record.gift_id) : payload.giftId;
}
export function giftSyncOriginalRecords(record: Record<string, unknown>): Record<string, unknown>[] {
  expect(Array.isArray(record.attachments));
  return [record.cover, ...record.attachments.map(item => object(item) && item.kind !== 'url' ? item.original : null)]
    .filter((value): value is Record<string, unknown> => object(value));
}
function assertOriginal(value: unknown) {
  expect(object(value)); keys(value, ['id', 'storageName', 'originalName', 'mimeType', 'byteSize']);
  expect(text(value.id) && text(value.storageName) && originalName.test(value.storageName)
    && typeof value.originalName === 'string' && text(value.mimeType) && integer(value.byteSize, 1));
}
function supplementalIds(row: Record<string, unknown>): string[] {
  const ids = row.supplementalAttachmentIds, attachments = row.attachments;
  if (ids === undefined) return [];
  expect(Array.isArray(ids) && ids.every(text) && new Set(ids).size === ids.length
    && Array.isArray(attachments) && ids.length <= attachments.length);
  expect(ids.every((id, index) => {
    const attachment = attachments[attachments.length - ids.length + index];
    return object(attachment) && attachment.id === id;
  }));
  if (ids.length) expect(row.deliveryStatus === 'delivered' && row.receptionStatus === 'opened' && integer(row.openedAt));
  return ids;
}
export function assertGiftSyncPayload(value: unknown, kind: string, id: string, deleting: boolean): asserts value is GiftSyncPayload {
  expect(object(value) && value.schemaVersion === 1 && value.kind === kind && GIFT_SYNC_KINDS.includes(kind as GiftSyncKind));
  if (deleting) {
    keys(value, ['schemaVersion', 'kind', 'giftId', 'deletedAt', 'deleteRelatedMemory']);
    expect(text(value.giftId) && integer(value.deletedAt) && (value.deleteRelatedMemory === undefined || typeof value.deleteRelatedMemory === 'boolean'));
    if (kind === 'gift') expect(id === value.giftId);
    else {
      const parts: unknown = JSON.parse(id);
      expect(Array.isArray(parts) && parts[0] === value.giftId);
      if (kind === 'echo') expect(parts.length === 2 && text(parts[1]));
      else if (kind === 'activity') expect(parts.length === 3 && text(parts[1]) && ['I', 'you'].includes(String(parts[2])));
      else expect(parts.length === 3 && integer(parts[1], 1) && text(parts[2]));
    }
    return;
  }
  keys(value, ['schemaVersion', 'kind', 'record', 'originals']);
  expect(object(value.record)); const row = value.record;
  expect(giftSyncEntityId(kind as GiftSyncKind, row) === id);
  if (kind === 'gift') {
    keys(row, ['id', 'revision', 'sender', 'title', 'note', 'cover', 'attachments', 'deliveryStatus', 'receptionStatus',
      'scheduledAt', 'scheduledTimeZone', 'deliveredAt', 'openedAt', 'receptionDecidedAt', 'receptionNextAt', 'receptionTimeZone', 'createdAt', 'updatedAt', 'supplementalAttachmentIds']);
    expect(text(row.id) && integer(row.revision, 1) && ['I', 'you'].includes(String(row.sender))
      && typeof row.title === 'string' && typeof row.note === 'string' && Array.isArray(row.attachments)
      && ['draft', 'scheduled', 'delivered', 'withdrawn'].includes(String(row.deliveryStatus))
      && ['unopened', 'deferred', 'opened', 'declined'].includes(String(row.receptionStatus))
      && integer(row.createdAt) && integer(row.updatedAt));
    for (const key of ['scheduledAt', 'deliveredAt', 'openedAt']) expect(row[key] === null || integer(row[key]));
    for (const key of ['receptionDecidedAt', 'receptionNextAt']) expect(row[key] == null || integer(row[key]));
    for (const key of ['scheduledTimeZone', 'receptionTimeZone']) expect(row[key] == null || typeof row[key] === 'string');
    if (row.cover !== null) assertOriginal(row.cover);
    const attachmentIds = new Set<string>();
    for (const item of row.attachments as unknown[]) {
      expect(object(item) && text(item.id) && !attachmentIds.has(item.id)); attachmentIds.add(item.id);
      if (item.kind === 'url') {
        keys(item, ['id', 'kind', 'url']); expect(typeof item.url === 'string');
        const url = new URL(item.url); expect(['http:', 'https:'].includes(url.protocol));
      } else { keys(item, ['id', 'kind', 'original']); expect(['image', 'audio', 'html'].includes(String(item.kind))); assertOriginal(item.original); }
    }
    supplementalIds(row);
    expect(Array.isArray(value.originals)); const originals = giftSyncOriginalRecords(row);
    const byId = new Map(originals.map(original => [original.id, original]));
    for (const original of originals) expect(canonicalizeJsonV1(original as JsonValue) === canonicalizeJsonV1(byId.get(original.id) as JsonValue));
    expect(value.originals.length === byId.size);
    const seen = new Set<string>();
    for (const item of value.originals) {
      expect(object(item)); keys(item, ['id', 'storageName', 'objectId', 'plaintextBytes', 'chunkCount', 'mediaType']);
      expect(text(item.id) && !seen.has(item.id) && text(item.objectId) && objectId.test(item.objectId)
        && integer(item.plaintextBytes, 1) && integer(item.chunkCount, 1) && text(item.mediaType)); seen.add(item.id);
      const source = byId.get(item.id); expect(source && source.storageName === item.storageName
        && source.byteSize === item.plaintextBytes && source.mimeType === item.mediaType);
    }
  } else {
    expect(text(row.gift_id)); expect(value.originals === undefined);
    if (kind === 'echo') {
      keys(row, ['gift_id', 'id', 'gift_revision', 'sequence', 'subject', 'content', 'created_at', 'origin', 'reply_to_id', 'attachment_id', 'original_id', 'read_at']);
      expect(text(row.id) && integer(row.gift_revision, 1) && integer(row.sequence, 1) && ['I', 'you'].includes(String(row.subject))
        && typeof row.content === 'string' && integer(row.created_at) && ['message', 'understanding', 'reply'].includes(String(row.origin)));
      for (const key of ['reply_to_id', 'attachment_id', 'original_id']) expect(row[key] === null || text(row[key]));
      expect(row.read_at === null || integer(row.read_at));
    } else if (kind === 'activity') {
      keys(row, ['gift_id', 'attachment_id', 'viewer', 'revision', 'record_json']);
      expect(text(row.attachment_id) && ['I', 'you'].includes(String(row.viewer)) && integer(row.revision) && typeof row.record_json === 'string');
      const activity: unknown = JSON.parse(row.record_json); expect(object(activity) && activity.revision === row.revision && object(activity.progress));
      keys(activity, ['revision', 'progress', 'progressUpdatedAt', 'lastPlayedAt']);
      keys(activity.progress, ['state', 'storage', 'summary']);
      expect('state' in activity.progress && object(activity.progress.storage) && typeof activity.progress.summary === 'string'
        && Object.values(activity.progress.storage).every(item => typeof item === 'string'));
      expect(activity.progressUpdatedAt === null || integer(activity.progressUpdatedAt));
      expect(activity.lastPlayedAt === null || integer(activity.lastPlayedAt));
    } else {
      keys(row, ['gift_id', 'gift_revision', 'attachment_id', 'original_id', 'subject', 'content', 'understood_at']);
      expect(integer(row.gift_revision, 1) && text(row.attachment_id) && text(row.original_id) && row.subject === 'I'
        && typeof row.content === 'string' && integer(row.understood_at));
    }
  }
  assertJsonValue(value);
}

/** An opened original remains the version that was actually received. */
export function assertGiftSyncFrozenOriginal(previous: GiftSyncRow | null, next: GiftSyncRow) {
  if (!previous) return;
  expect(previous.id === next.id && previous.sender === next.sender && previous.createdAt === next.createdAt);
  if (previous.openedAt === null) return;
  for (const key of ['title', 'note', 'cover', 'openedAt']) {
    expect(canonicalizeJsonV1(previous[key]) === canonicalizeJsonV1(next[key]));
  }
  const before = previous.attachments, after = next.attachments;
  expect(Array.isArray(before) && Array.isArray(after) && after.length >= before.length);
  expect(before.every((attachment, index) => canonicalizeJsonV1(attachment) === canonicalizeJsonV1(after[index])));
  const added = after.slice(before.length).map(attachment => {
    expect(object(attachment) && text(attachment.id)); return attachment.id;
  });
  expect(canonicalizeJsonV1(supplementalIds(next)) === canonicalizeJsonV1([...supplementalIds(previous), ...added]));
  if (added.length) expect(previous.revision === next.revision && previous.deliveredAt === next.deliveredAt);
}
export function assertGiftsLifeMutationV1(value: unknown): asserts value is PlainMutationV1 {
  assertPlainMutationV1(value);
  expect(value.entity.domain === 'gifts' && value.revision.schemaVersion === 1 && value.sensitivity === 'high'
    && value.retentionClass === 'relationship-history' && value.revision.operation !== 'restore');
  assertGiftSyncPayload(value.payload, value.entity.type, value.entity.id, value.revision.operation === 'delete');
  const payload = value.payload as unknown as GiftSyncPayload;
  const refs = 'record' in payload && payload.kind === 'gift' ? [...new Set(payload.originals!.map(item => item.objectId))].sort() : [];
  expect(JSON.stringify([...value.objectRefs].sort()) === JSON.stringify(refs));
}
export function buildGiftSyncMutation(envelope: ChatCoreMutationEnvelope, entityId: string, payload: GiftSyncPayload): PlainMutationV1 {
  const mutation: PlainMutationV1 = { protocolVersion: 1, mutationId: envelope.mutationId, vaultId: envelope.vaultId,
    sourceDeviceId: envelope.sourceDeviceId, sourceSequence: envelope.sourceSequence, createdAt: envelope.createdAt,
    entity: { domain: 'gifts', type: payload.kind, id: entityId },
    revision: { id: envelope.revisionId, parents: envelope.parentRevisionIds, operation: 'record' in payload ? 'upsert' : 'delete', schemaVersion: 1 },
    sensitivity: 'high', retentionClass: 'relationship-history', payload: payload as unknown as JsonValue,
    objectRefs: 'record' in payload && payload.kind === 'gift' ? [...new Set(payload.originals!.map(item => item.objectId))].sort() : [] };
  assertGiftsLifeMutationV1(mutation); return mutation;
}

/** Concurrent saves remain whole branches; any real deletion keeps the gift absent. */
export function selectGiftSyncHead(heads: readonly PlainMutationV1[]): PlainMutationV1 | null {
  heads.forEach(assertGiftsLifeMutationV1);
  const deleted = heads.filter(head => head.revision.operation === 'delete').sort((a, b) => {
    const left = a.payload as unknown as GiftSyncPayload, right = b.payload as unknown as GiftSyncPayload;
    const full = Number('deleteRelatedMemory' in right && right.deleteRelatedMemory) - Number('deleteRelatedMemory' in left && left.deleteRelatedMemory);
    return full || b.createdAt - a.createdAt || b.revision.id.localeCompare(a.revision.id);
  });
  return deleted[0] ?? (heads.length === 1 ? heads[0] : null);
}
