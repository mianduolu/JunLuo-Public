import type { MessageImage, SubjectiveMessage } from '../ai/subjectiveMessages';

export type ChatImageCardSources = {
  question: { messageId: string; revision: string };
  reviewQuestions: { messageId: string; revision: string }[];
  images: { messageId: string; imageId: string; revision: string }[];
  existingCardId?: string;
};

// Same local fingerprint used for other chat source revisions; no raw source copy or storage import.
function revision(value: unknown) {
  const text = JSON.stringify(value);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function imageIdentity(image: MessageImage, includeLocalUri = true) {
  return [image.id, image.cacheId, includeLocalUri ? image.uri : null, image.name, image.mimeType,
    image.size, image.width, image.height, image.source, image.createdAt];
}

export function chatImageQuestionRevision(message: SubjectiveMessage): string {
  const quote = message.replyTo;
  return revision([message.id, message.role, message.content, message.createdAt,
    quote ? [quote.id, quote.role, quote.content, quote.createdAt] : null]);
}

export function chatImageSourceRevision(message: SubjectiveMessage, image: MessageImage): string {
  return revision([chatImageQuestionRevision(message), imageIdentity(image)]);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function nonempty(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function timestamp(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }

export function isChatImageVisionAttempt(value: unknown): value is NonNullable<MessageImage['visionAttempt']> {
  return record(value) && nonempty(value.id) && timestamp(value.startedAt)
    && Object.keys(value).every(key => key === 'id' || key === 'startedAt');
}

export function isChatImageReviewAttempt(value: unknown): value is NonNullable<SubjectiveMessage['chatImageReviewAttempt']> {
  return record(value) && nonempty(value.executionId) && timestamp(value.startedAt)
    && Object.keys(value).every(key => key === 'executionId' || key === 'startedAt');
}

export function isChatImageVisionReview(value: unknown): value is NonNullable<MessageImage['visionReview']> {
  return record(value) && nonempty(value.question) && nonempty(value.summary) && timestamp(value.observedAt)
    && nonempty(value.sourceMessageId) && nonempty(value.sourceRevision) && nonempty(value.executionId)
    && Object.keys(value).every(key => ['question', 'summary', 'observedAt', 'sourceMessageId', 'sourceRevision', 'executionId'].includes(key));
}

export function isChatImageObservationMetadata(image: Record<string, unknown>): boolean {
  return (image.visionAttempt === undefined || isChatImageVisionAttempt(image.visionAttempt))
    && (image.visionObservedAt === undefined || timestamp(image.visionObservedAt))
    && (image.visionReview === undefined || isChatImageVisionReview(image.visionReview));
}

/** A stale send-window snapshot must not erase durable attempts or newer observations. */
export function preserveStoredChatImageRecords(incoming: SubjectiveMessage, stored: SubjectiveMessage): SubjectiveMessage {
  if (incoming.id !== stored.id || incoming.role !== stored.role || incoming.createdAt !== stored.createdAt) return incoming;
  const sameQuestion = chatImageQuestionRevision(incoming) === chatImageQuestionRevision(stored);
  return {
    ...incoming,
    ...(stored.chatImageReviewAttempt ? { chatImageReviewAttempt: stored.chatImageReviewAttempt } : {}),
    ...(incoming.images ? { images: incoming.images.map(image => {
      const old = stored.images?.find(candidate => candidate.id === image.id);
      // A synchronized original can be materialized at another device-local URI.
      // Active request revisions still bind the URI; only durable metadata retention ignores it.
      if (!old || JSON.stringify(imageIdentity(old, false)) !== JSON.stringify(imageIdentity(image, false))) return image;
      if (!sameQuestion) {
        return { ...image, visionStatus: 'error' as const, visionSummary: undefined,
          visionObservedAt: undefined, visionReview: undefined, visionError: undefined,
          visionAttempt: old.visionAttempt ?? image.visionAttempt };
      }
      if (!old.visionAttempt && old.visionObservedAt === undefined && !old.visionReview
        && old.visionSummary === undefined && old.visionError === undefined) return image;
      const firstObservation = image.visionObservedAt !== undefined
        && (old.visionObservedAt === undefined || image.visionObservedAt > old.visionObservedAt) ? image : old;
      const review = image.visionReview && (!old.visionReview
        || image.visionReview.observedAt > old.visionReview.observedAt) ? image.visionReview : old.visionReview;
      return { ...image, visionStatus: firstObservation.visionStatus, visionSummary: firstObservation.visionSummary,
        visionError: firstObservation.visionError, visionAttempt: old.visionAttempt ?? image.visionAttempt,
        visionObservedAt: firstObservation.visionObservedAt, visionReview: review };
    }) } : {}),
  };
}
