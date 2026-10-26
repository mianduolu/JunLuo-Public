export type WishDiscussionPurpose = 'cast_coin' | 'revise' | 'progress' | 'complete' | 'release';
export type WishDiscussionDecision = 'talking' | 'yes' | 'no';

// Host evidence, not model output. Callers supply this only after saving the I reply.
export type WishSavedReply = { messageId: string; persistedAt: number };
export type WishDiscussion = {
  id: string;
  wishId: string;
  purpose: WishDiscussionPurpose;
  sourceId: string;
  conversationId: string;
  revision: number;
  pendingText: string;
  decision: WishDiscussionDecision;
  reply?: WishSavedReply & { requestRevision: number };
  // Provenance for unchanged pendingText after consent is revoked. Never consent.
  lastDraftReply?: WishSavedReply;
  createdAt: number;
  updatedAt: number;
  closedAt?: number;
};

export type WishConfirmation = {
  id: string;
  discussionId: string;
  revision: number;
  wishId: string;
  wishOwner: 'I' | 'you';
  wishContent: string;
  purpose: WishDiscussionPurpose;
  decision: 'yes' | 'no';
  pendingText: string;
  reply: WishSavedReply & { requestRevision: number };
  confirmedBy: 'you';
  sourceId: string;
  confirmedAt: number;
  deliveredWithReply?: WishSavedReply;
};

export type WishProgressNote = {
  id: string;
  wishId: string;
  content: string;
  recordedAt: number;
  replyMessageId: string;
  confirmationId: string;
};

export type WishCollaborationState = {
  discussions: WishDiscussion[];
  progressNotes: WishProgressNote[];
  confirmations: WishConfirmation[];
};

export function emptyWishCollaboration(): WishCollaborationState {
  return { discussions: [], progressNotes: [], confirmations: [] };
}

export function isWishDiscussionPurpose(value: unknown): value is WishDiscussionPurpose {
  return value === 'cast_coin' || value === 'revise' || value === 'progress' || value === 'complete' || value === 'release';
}

export function isWishDiscussionDecision(value: unknown): value is WishDiscussionDecision {
  return value === 'talking' || value === 'yes' || value === 'no';
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function id(value: unknown): value is string {
  return typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 200;
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function time(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function revision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

export function isWishSavedReply(value: unknown): value is WishSavedReply {
  return record(value) && id(value.messageId) && time(value.persistedAt);
}

function isDiscussionReply(value: unknown, currentRevision: unknown) {
  return record(value) && revision(value.requestRevision)
    && value.requestRevision === (currentRevision as number) - 1 && isWishSavedReply(value);
}

function discussion(value: unknown): value is WishDiscussion {
  if (!record(value) || !id(value.id) || !id(value.wishId) || !id(value.sourceId)
    || !id(value.conversationId) || !revision(value.revision) || !text(value.pendingText)
    || !isWishDiscussionPurpose(value.purpose) || !isWishDiscussionDecision(value.decision)
    || !time(value.createdAt) || !time(value.updatedAt)
    || (value.lastDraftReply !== undefined && !isWishSavedReply(value.lastDraftReply))
    || (value.closedAt !== undefined && !time(value.closedAt))) return false;
  if (value.reply === undefined) return value.decision === 'talking';
  return isDiscussionReply(value.reply, value.revision);
}

function confirmation(value: unknown): value is WishConfirmation {
  return record(value) && id(value.id) && id(value.discussionId) && id(value.wishId)
    && revision(value.revision) && (value.wishOwner === 'I' || value.wishOwner === 'you')
    && text(value.wishContent) && isWishDiscussionPurpose(value.purpose)
    && (value.decision === 'yes' || value.decision === 'no') && text(value.pendingText)
    && isDiscussionReply(value.reply, value.revision)
    && value.confirmedBy === 'you' && id(value.sourceId) && time(value.confirmedAt)
    && (value.deliveredWithReply === undefined || isWishSavedReply(value.deliveredWithReply));
}

// Do not salvage a partial v2: dropping a version, consent or note could change a joint decision.
// Old v1 normalization remains in the store. Sync/backup v2 support belongs to chapter 4.
export function readWishCollaboration(value: unknown, wishes: readonly { id: string }[]): WishCollaborationState {
  if (!record(value) || !Array.isArray(value.discussions) || !value.discussions.every(discussion)
    || !Array.isArray(value.confirmations) || !value.confirmations.every(confirmation)
    || !Array.isArray(value.progressNotes)) throw new Error('Invalid wish collaboration data.');
  const discussions = value.discussions as WishDiscussion[];
  const confirmations = value.confirmations as WishConfirmation[];
  const wishIds = new Set(wishes.map((wish) => wish.id));
  const unique = (ids: string[]) => new Set(ids).size === ids.length;
  if (!unique(discussions.map((item) => item.id)) || !unique(discussions.map((item) => item.sourceId))
    || !unique(confirmations.map((item) => item.id)) || !unique(confirmations.map((item) => item.discussionId))
    || discussions.filter((item) => item.closedAt === undefined).length > 1
    || discussions.some((item) => !wishIds.has(item.wishId))) throw new Error('Invalid wish discussion references.');
  for (const item of discussions) {
    const saved = confirmations.find((entry) => entry.discussionId === item.id);
    if ((item.closedAt !== undefined) !== !!saved) throw new Error('Invalid wish discussion closure.');
  }
  for (const saved of confirmations) {
    const item = discussions.find((entry) => entry.id === saved.discussionId);
    if (!item || item.wishId !== saved.wishId || item.revision !== saved.revision
      || item.purpose !== saved.purpose || item.pendingText !== saved.pendingText
      || item.decision !== saved.decision || item.closedAt !== saved.confirmedAt
      || item.reply?.messageId !== saved.reply.messageId
      || item.reply.persistedAt !== saved.reply.persistedAt) throw new Error('Invalid wish confirmation references.');
  }
  for (const note of value.progressNotes) {
    if (!record(note) || !id(note.id) || !id(note.wishId) || !text(note.content)
      || !time(note.recordedAt) || !id(note.replyMessageId) || !id(note.confirmationId)) {
      throw new Error('Invalid wish progress note.');
    }
    const saved = confirmations.find((entry) => entry.id === note.confirmationId);
    if (!saved || saved.purpose !== 'progress' || saved.decision !== 'yes'
      || saved.wishId !== note.wishId || saved.pendingText !== note.content
      || saved.confirmedAt !== note.recordedAt || saved.reply.messageId !== note.replyMessageId) {
      throw new Error('Invalid wish progress references.');
    }
  }
  const progressNotes = value.progressNotes as WishProgressNote[];
  if (!unique(progressNotes.map((item) => item.id)) || !unique(progressNotes.map((item) => item.confirmationId))
    || confirmations.some((item) => item.purpose === 'progress' && item.decision === 'yes'
      && !progressNotes.some((note) => note.confirmationId === item.id))) throw new Error('Missing or repeated wish progress.');
  return { discussions, confirmations, progressNotes };
}
