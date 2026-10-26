import { formatWeeklyOffer, loadUnprovidedWeeklyOffers, loadWeeklyOffer, recordWeeklyOfferProvided } from '../memory/memoryWeeklyOffer';
import { contactFocusSourceKeys, type ContactMaterialEntry } from './unifiedContactMaterials';
import { contactMessageId, type ContactOpportunity, type ContactSource } from './unifiedContact';
import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import { loadMemorySourceRefs, type MemoryEntry } from '../memory/memoryStore';

async function entry(memory: MemoryEntry, version: string, savedAt: number): Promise<ContactMaterialEntry> {
  return { id: memory.id, version, kind: 'weekly_review', occurredAt: savedAt,
    focusSources: contactFocusSourceKeys(await loadMemorySourceRefs(memory.id)),
    text: formatWeeklyOffer(memory), formatToBudget: maxChars => formatWeeklyOffer(memory, maxChars) };
}

export async function prepareContactWeeklyReviews(): Promise<ContactMaterialEntry[]> {
  return Promise.all((await loadUnprovidedWeeklyOffers()).map(value => entry(value.memory, value.version, value.savedAt)));
}

export async function loadContactWeeklyReview(ref: ContactSource): Promise<ContactMaterialEntry | null> {
  if (ref.kind !== 'weekly_review') return null;
  const memory = await loadWeeklyOffer(ref);
  return memory ? entry(memory, ref.version, memory.updatedAt) : null;
}

export async function recordContactWeeklyReviewProvided(op: ContactOpportunity, message: SubjectiveMessage) {
  if (op.important || message.role !== 'I' || message.source !== 'proactive-message' || message.deliveryStatus === 'failed') return;
  const index = op.messages.findIndex((_text, index) => contactMessageId(op, index) === message.id);
  if (index < 0 || message.content !== op.messages[index]) return;
  for (const ref of op.sources.filter(source => source.kind === 'weekly_review')) {
    await recordWeeklyOfferProvided(ref, { opportunityId: op.id, sessionId: op.sessionId,
      messageId: message.id, savedAt: message.createdAt }, op.epoch);
  }
}
