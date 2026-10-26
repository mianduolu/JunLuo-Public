import {
  emptyWishCollaboration,
  readWishCollaboration,
  type WishCollaborationState,
  type WishConfirmation,
  type WishDiscussion,
} from '../wishPool/wishPoolDiscussionState';

function same(left: unknown, right: unknown) {
  return stableJson(left) === stableJson(right);
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => (
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item
  )) ?? 'undefined';
}

function unionImmutable<T extends { id: string }>(left: T[], right: T[]): T[] {
  const entries = new Map(left.map((item) => [item.id, item]));
  for (const item of right) {
    const old = entries.get(item.id);
    if (old && !same(old, item)) throw new Error('Conflicting wish history.');
    entries.set(item.id, item);
  }
  return [...entries.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function mergeConfirmation(left: WishConfirmation, right: WishConfirmation): WishConfirmation {
  const { deliveredWithReply: leftDelivery, ...leftFact } = left;
  const { deliveredWithReply: rightDelivery, ...rightFact } = right;
  if (!same(leftFact, rightFact)) throw new Error('Conflicting joint wish confirmation.');
  const deliveredWithReply = [leftDelivery, rightDelivery].filter((item) => !!item)
    .sort((a, b) => a.persistedAt - b.persistedAt || a.messageId.localeCompare(b.messageId))[0];
  return { ...leftFact, ...(deliveredWithReply ? { deliveredWithReply } : {}) };
}

// Per-wish wire record: the wish and its joint decision travel atomically.
// The store still uses its existing global collaboration arrays.
export function mergeWishCollaboration(
  wishId: string,
  left: WishCollaborationState | undefined,
  right: WishCollaborationState | undefined,
  concurrent: boolean,
): WishCollaborationState | undefined {
  if (!left && !right) return undefined;
  const before = left ?? emptyWishCollaboration();
  const after = right ?? emptyWishCollaboration();
  const confirmations = new Map(before.confirmations.map((item) => [item.id, item]));
  for (const item of after.confirmations) {
    const old = confirmations.get(item.id);
    confirmations.set(item.id, old ? mergeConfirmation(old, item) : item);
  }
  const discussions = new Map(before.discussions.map((item) => [item.id, item]));
  for (const item of after.discussions) {
    const old = discussions.get(item.id);
    if (!old) { discussions.set(item.id, item); continue; }
    if (old.wishId !== item.wishId || old.sourceId !== item.sourceId
      || old.conversationId !== item.conversationId || old.createdAt !== item.createdAt) {
      throw new Error('Conflicting wish discussion identity.');
    }
    if (old.closedAt !== undefined || item.closedAt !== undefined) {
      if (old.closedAt !== undefined && item.closedAt !== undefined && !same(old, item)) {
        throw new Error('Conflicting closed wish discussion.');
      }
      discussions.set(item.id, old.closedAt !== undefined ? old : item);
      continue;
    }
    if (same(old, item)) continue;
    // A causal successor's higher discussion version already invalidates the old card.
    // Preserve its own saved reply; only a same-version change or concurrent edit needs rebinding.
    if (!concurrent && old.revision !== item.revision) {
      discussions.set(item.id, old.revision > item.revision ? old : item);
      continue;
    }
    const chosen = [old, item].sort((a, b) => b.revision - a.revision
      || b.updatedAt - a.updatedAt || stableJson(b).localeCompare(stableJson(a)))[0];
    const textChanged = old.pendingText !== item.pendingText || old.purpose !== item.purpose;
    const forkedConsent = old.decision !== item.decision || !same(old.reply, item.reply);
    const merged: WishDiscussion = textChanged || forkedConsent
      ? { ...chosen, revision: Math.max(old.revision, item.revision) + 1, decision: 'talking',
        updatedAt: Math.max(old.updatedAt, item.updatedAt) }
      : chosen;
    if (textChanged || forkedConsent) {
      merged.lastDraftReply = chosen.reply ?? chosen.lastDraftReply;
      delete merged.reply;
    }
    discussions.set(item.id, merged);
  }
  return readWishCollaboration({
    discussions: [...discussions.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)),
    confirmations: [...confirmations.values()].sort((a, b) => a.confirmedAt - b.confirmedAt || a.id.localeCompare(b.id)),
    progressNotes: unionImmutable(before.progressNotes, after.progressNotes),
  }, [{ id: wishId }]);
}
