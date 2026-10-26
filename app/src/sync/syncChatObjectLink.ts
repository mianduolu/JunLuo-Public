import {
  assertChatCoreMutationV1,
} from './syncChatCore';
import type {
  PlainMutationV1,
} from './syncProtocol';

type JsonRecord = Record<string, unknown>;

function recordOf(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象。`);
  }
  return value as JsonRecord;
}

function attachmentLookupKey(payload: JsonRecord) {
  if (payload.kind === 'voice') return payload.attachmentId;
  const metadata = recordOf(payload.metadata, 'chat attachment metadata');
  return metadata.id;
}

export function linkChatCoreMutationsToObjects(
  mutations: readonly PlainMutationV1[],
  attachmentObjectIds: Readonly<Record<string, string>>,
) {
  const refsByMessageId = new Map<string, string[]>();
  const linked = mutations.map((mutation): PlainMutationV1 => {
    if (
      mutation.entity.domain !== 'chat'
      || mutation.entity.type !== 'attachment-metadata'
      || mutation.revision.operation === 'delete'
    ) {
      return mutation;
    }
    const payload = recordOf(mutation.payload, 'chat attachment payload');
    const lookupKey = attachmentLookupKey(payload);
    const objectId = typeof lookupKey === 'string'
      ? attachmentObjectIds[lookupKey]
      : undefined;
    if (!objectId) return mutation;
    const messageId = payload.messageId;
    if (typeof messageId !== 'string') {
      throw new Error('chat attachment payload 缺少 messageId。');
    }
    const messageRefs = refsByMessageId.get(messageId) ?? [];
    if (!messageRefs.includes(objectId)) messageRefs.push(objectId);
    refsByMessageId.set(messageId, messageRefs);
    const next: PlainMutationV1 = {
      ...mutation,
      payload: {
        ...mutation.payload as JsonRecord,
        objectId,
      },
      objectRefs: [objectId],
    };
    assertChatCoreMutationV1(next);
    return next;
  });
  return linked.map((mutation): PlainMutationV1 => {
    if (
      mutation.entity.domain !== 'chat'
      || mutation.entity.type !== 'subjective-message'
      || mutation.revision.operation === 'delete'
    ) {
      return mutation;
    }
    const refs = refsByMessageId.get(mutation.entity.id) ?? [];
    if (!refs.length) return mutation;
    const next: PlainMutationV1 = {
      ...mutation,
      objectRefs: [...new Set([...mutation.objectRefs, ...refs])].sort(),
    };
    assertChatCoreMutationV1(next);
    return next;
  });
}
