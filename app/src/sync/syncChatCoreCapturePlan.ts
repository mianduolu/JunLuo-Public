import type {
  SubjectiveMessage,
} from '../ai/subjectiveMessages';
import type {
  ChatSession,
} from '../chat/chatStorage';
import { assertPrimaryChatSessionId } from '../chat/primaryChat';
import {
  assertChatCoreMutationV1,
  buildChatAttachmentMetadataMutation,
  buildChatDeleteMutation,
  buildChatMessageMutation,
  buildChatSessionMutation,
  buildChatSummaryMutation,
  extractChatAttachmentMetadata,
  sanitizeChatMessageForSync,
  selectChatSummaryForSync,
  type ChatCoreMutationEnvelope,
  type ChatSessionSyncField,
} from './syncChatCore';
import type {
  PlainMutationV1,
} from './syncProtocol';
import type {
  SyncMutationEntityRef,
} from './syncMutationEnvelope';

export type ChatCoreEnvelopeFactory = (
  entity: SyncMutationEntityRef,
) => Promise<ChatCoreMutationEnvelope>;

export type ChatCoreAttachmentObjectIds = Readonly<Record<string, string>>;

function jsonEqual(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sortedSessions(sessions: readonly ChatSession[]) {
  return [...sessions].sort((left, right) => left.id.localeCompare(right.id));
}

function sortedMessages(messages: readonly SubjectiveMessage[]) {
  return [...messages].sort((left, right) => (
    left.createdAt - right.createdAt || left.id.localeCompare(right.id)
  ));
}

async function envelopeFor(
  factory: ChatCoreEnvelopeFactory,
  type: SyncMutationEntityRef['type'],
  id: string,
) {
  return factory({ domain: 'chat', type, id });
}

function sharedSummaryShape(session: ChatSession) {
  return {
    memoryOrganizedThroughId: session.memoryOrganizedThroughId,
    proactiveMemoryReviewedThroughId: session.proactiveMemoryReviewedThroughId,
    summary: selectChatSummaryForSync(session.contextCompression),
  };
}

function changedSessionFields(before: ChatSession, after: ChatSession) {
  const changed: ChatSessionSyncField[] = [];
  for (const field of ['title', 'customTitle', 'createdAt', 'updatedAt'] as const) {
    if (before[field] !== after[field]) changed.push(field);
  }
  return changed;
}

function messageChanged(before: SubjectiveMessage, after: SubjectiveMessage) {
  return !jsonEqual(
    sanitizeChatMessageForSync(before),
    sanitizeChatMessageForSync(after),
  );
}

function buildChatMessageUpsertMutation(input: {
  envelope: ChatCoreMutationEnvelope;
  sessionId: string;
  message: SubjectiveMessage;
  objectRefs?: string[];
}) {
  const mutation = buildChatMessageMutation(input);
  mutation.revision.operation = 'upsert';
  assertChatCoreMutationV1(mutation);
  return mutation;
}

async function appendAttachmentMutations(input: {
  mutations: PlainMutationV1[];
  message: SubjectiveMessage;
  envelopeFactory: ChatCoreEnvelopeFactory;
  objectIds: ChatCoreAttachmentObjectIds;
}) {
  const attachments = extractChatAttachmentMetadata(input.message, input.objectIds)
    .sort((left, right) => left.attachmentId.localeCompare(right.attachmentId));
  for (const attachment of attachments) {
    input.mutations.push(buildChatAttachmentMetadataMutation({
      envelope: await envelopeFor(
        input.envelopeFactory,
        'attachment-metadata',
        attachment.attachmentId,
      ),
      attachment,
    }));
  }
}

async function appendNewSessionMutations(input: {
  mutations: PlainMutationV1[];
  session: ChatSession;
  envelopeFactory: ChatCoreEnvelopeFactory;
  objectIds: ChatCoreAttachmentObjectIds;
}) {
  input.mutations.push(buildChatSessionMutation({
    envelope: await envelopeFor(input.envelopeFactory, 'session', input.session.id),
    session: input.session,
  }));
  if (input.session.messagesLoaded !== false) {
    for (const message of sortedMessages(input.session.messages)) {
      const attachments = extractChatAttachmentMetadata(message, input.objectIds);
      const objectRefs = attachments
        .map((attachment) => attachment.objectId)
        .filter((objectId): objectId is string => !!objectId);
      input.mutations.push(buildChatMessageMutation({
        envelope: await envelopeFor(input.envelopeFactory, 'subjective-message', message.id),
        sessionId: input.session.id,
        message,
        objectRefs,
      }));
      await appendAttachmentMutations({
        mutations: input.mutations,
        message,
        envelopeFactory: input.envelopeFactory,
        objectIds: input.objectIds,
      });
    }
  }
  input.mutations.push(buildChatSummaryMutation({
    envelope: await envelopeFor(input.envelopeFactory, 'message-summary', input.session.id),
    sessionId: input.session.id,
    compression: input.session.contextCompression,
    memoryOrganizedThroughId: input.session.memoryOrganizedThroughId,
    proactiveMemoryReviewedThroughId: input.session.proactiveMemoryReviewedThroughId,
  }));
}

async function appendExistingSessionMutations(input: {
  mutations: PlainMutationV1[];
  before: ChatSession;
  after: ChatSession;
  envelopeFactory: ChatCoreEnvelopeFactory;
  objectIds: ChatCoreAttachmentObjectIds;
}) {
  const changedFields = changedSessionFields(input.before, input.after);
  if (changedFields.length) {
    input.mutations.push(buildChatSessionMutation({
      envelope: await envelopeFor(input.envelopeFactory, 'session', input.after.id),
      session: input.after,
      changedFields,
    }));
  }

  if (input.before.messagesLoaded !== false && input.after.messagesLoaded !== false) {
    const beforeById = new Map(input.before.messages.map((message) => [message.id, message]));
    const afterById = new Map(input.after.messages.map((message) => [message.id, message]));
    for (const beforeMessage of sortedMessages(input.before.messages)) {
      if (afterById.has(beforeMessage.id)) continue;
      input.mutations.push(buildChatDeleteMutation({
        envelope: await envelopeFor(input.envelopeFactory, 'subjective-message', beforeMessage.id),
        entityType: 'subjective-message',
        entityId: beforeMessage.id,
        deletedAt: input.after.updatedAt,
      }));
    }
    for (const afterMessage of sortedMessages(input.after.messages)) {
      const beforeMessage = beforeById.get(afterMessage.id);
      if (beforeMessage && !messageChanged(beforeMessage, afterMessage)) continue;
      const attachments = extractChatAttachmentMetadata(afterMessage, input.objectIds);
      const objectRefs = attachments
        .map((attachment) => attachment.objectId)
        .filter((objectId): objectId is string => !!objectId);
      input.mutations.push((beforeMessage ? buildChatMessageUpsertMutation : buildChatMessageMutation)({
        envelope: await envelopeFor(input.envelopeFactory, 'subjective-message', afterMessage.id),
        sessionId: input.after.id,
        message: afterMessage,
        objectRefs,
      }));
      await appendAttachmentMutations({
        mutations: input.mutations,
        message: afterMessage,
        envelopeFactory: input.envelopeFactory,
        objectIds: input.objectIds,
      });
    }
  }

  if (!jsonEqual(sharedSummaryShape(input.before), sharedSummaryShape(input.after))) {
    input.mutations.push(buildChatSummaryMutation({
      envelope: await envelopeFor(input.envelopeFactory, 'message-summary', input.after.id),
      sessionId: input.after.id,
      compression: input.after.contextCompression,
      memoryOrganizedThroughId: input.after.memoryOrganizedThroughId,
      proactiveMemoryReviewedThroughId: input.after.proactiveMemoryReviewedThroughId,
    }));
  }
}

export async function planChatCoreStateMutations(input: {
  beforeSessions: readonly ChatSession[];
  afterSessions: readonly ChatSession[];
  envelopeFactory: ChatCoreEnvelopeFactory;
  attachmentObjectIds?: ChatCoreAttachmentObjectIds;
}) {
  input.afterSessions.forEach(session => assertPrimaryChatSessionId(session.id));
  const mutations: PlainMutationV1[] = [];
  const objectIds = input.attachmentObjectIds ?? {};
  const beforeById = new Map(input.beforeSessions.map((session) => [session.id, session]));
  const afterById = new Map(input.afterSessions.map((session) => [session.id, session]));

  for (const before of sortedSessions(input.beforeSessions)) {
    if (afterById.has(before.id)) continue;
    mutations.push(buildChatDeleteMutation({
      envelope: await envelopeFor(input.envelopeFactory, 'session', before.id),
      entityType: 'session',
      entityId: before.id,
      deletedAt: Date.now(),
    }));
  }
  for (const after of sortedSessions(input.afterSessions)) {
    const before = beforeById.get(after.id);
    if (!before) {
      await appendNewSessionMutations({
        mutations,
        session: after,
        envelopeFactory: input.envelopeFactory,
        objectIds,
      });
      continue;
    }
    await appendExistingSessionMutations({
      mutations,
      before,
      after,
      envelopeFactory: input.envelopeFactory,
      objectIds,
    });
  }
  return mutations;
}
