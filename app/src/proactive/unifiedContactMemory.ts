import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import { buildMemoryRecall, memoryLocalRecallQuery, type StructuredMemoryQuery } from '../memory/memoryRecall';
import { loadMemory, loadMemorySourceRefs, isTimelineEligibleMemory, selectRefreshedMemoryRecallItems,
  type MemoryEntry, type MemoryComment, type MemoryRecallItem } from '../memory/memoryStore';
import { createMemoryMaterialPreparation, memoryUsageCommentsHash, type MemoryMaterialPreparation } from '../memory/memoryCurrentMaterials';
import { memorySurfacingBlockReason } from '../memory/memorySurfacing';
import { stableMemoryHash, formatMemoryEventTimeLabel, getMemoryOccurrenceStart } from '../memory/memoryAtomicity';
import { takeWeeklySentencePrefix } from '../memory/memoryWeeklyMaterialText';
import { createMemoryUsageReceipt, settleSavedMemoryUsage } from '../memory/memoryReplyUsage';
import { canCommitBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { CONTACT_PAST_MEMORY_PREFIX, contactMessageId, contactPastMemoryOffer, isContactPastMemorySource,
  type ContactOpportunity, type ContactSource, type UnifiedContactState } from './unifiedContact';
import type { ContactMaterialEntry } from './unifiedContactMaterials';

type PastMemoryVersion = [1, string, string, string];
const supplements = (comments: readonly MemoryComment[]) => comments.filter(comment => comment.kind !== 'dehydration');
const heading = ['【想起的往事】', 'I 想和 you 聊聊以前的事。',
  'I 记清是谁做了什么，也分清想做的事和已经发生的事。'].join('\n');
export const CONTACT_PAST_MEMORY_MIN_CHARS = `${heading}\n标题：x\n正文（全文）：x`.length;

function parseVersion(value: string): PastMemoryVersion | undefined {
  if (value.length > 512) return;
  try {
    const parts: unknown = JSON.parse(value);
    if (Array.isArray(parts) && parts.length === 4 && parts[0] === 1
      && parts.slice(1).every(part => typeof part === 'string' && /^[a-f0-9]+$/i.test(part))) return parts as PastMemoryVersion;
  } catch { /* A malformed locator cannot certify a saved memory. */ }
}

export function isContactPastMemoryEligible(memory: MemoryEntry, now = Date.now()) {
  return isTimelineEligibleMemory(memory) && memory.source !== 'weekly-context'
    && !memorySurfacingBlockReason(memory, now);
}

/** Only the approved record format; no generated summary or fabricated source quote. */
export function formatContactPastMemory(memory: MemoryEntry, comments: readonly MemoryComment[], maxChars: number): string {
  if (!memory.title.trim() || !Number.isFinite(maxChars)) return '';
  const time = getMemoryOccurrenceStart(memory.eventTime) !== undefined || memory.eventTime?.timeExpression?.trim()
    ? formatMemoryEventTimeLabel(memory.eventTime) : '';
  const header = [heading, `标题：${memory.title}`,
    ...(time ? [`发生时间：${time}`] : [])].join('\n');
  const body = takeWeeklySentencePrefix(memory.content, maxChars - header.length - '\n正文（全文）：'.length);
  if (!body.trim()) return '';
  let text = `${header}\n正文（${body === memory.content ? '全文' : '片段'}）：${body}`;
  const originalNotes = supplements(comments).map(comment => comment.content).filter(content => content.trim()).join('\n');
  if (originalNotes) {
    const notes = takeWeeklySentencePrefix(originalNotes, maxChars - text.length - '\n补记（全文）：'.length);
    if (notes.trim()) text += `\n补记（${notes === originalNotes ? '全文' : '片段'}）：${notes}`;
  }
  return text.length <= maxChars ? text : '';
}

function entryFor(memory: MemoryEntry, preparation: MemoryMaterialPreparation): ContactMaterialEntry | null {
  const usage = preparation.usageReferences([memory])[0];
  if (!usage) return null;
  const comments = supplements(preparation.commentsFor(memory.id));
  const version = JSON.stringify([1, usage.targetHash, memoryUsageCommentsHash(comments),
    stableMemoryHash(JSON.stringify(preparation.sourceRefsFor(memory.id)))] satisfies PastMemoryVersion);
  const id = `${CONTACT_PAST_MEMORY_PREFIX}${memory.id}`;
  if (id.length > 512 || version.length > 512) return null;
  const text = formatContactPastMemory(memory, comments, 1000);
  if (!text) return null;
  return { id, version, text, pastMemory: true, sameSource: `memory:${memory.id}`,
    occurredAt: getMemoryOccurrenceStart(memory.eventTime),
    formatToBudget: maxChars => formatContactPastMemory(memory, comments, maxChars) };
}

/** Restored opportunities read their exact record; they never repeat the vector query. */
export async function loadContactPastMemory(ref: ContactSource,
  _writing?: { sessionId: string; messages: readonly SubjectiveMessage[] }): Promise<ContactMaterialEntry | null> {
  const offered = contactPastMemoryOffer(ref);
  if (!offered || !parseVersion(ref.version)) return null;
  const memory = await loadMemory(offered.id);
  if (!memory) return null;
  // Only the card and its comments are supplied. Ordinary missing chat sources
  // remain usable, and no chat writer is re-entered from beforeAppend.
  const preparation = createMemoryMaterialPreparation();
  const current = await preparation.refresh([memory], isContactPastMemoryEligible);
  const entry = current[0] && entryFor(current[0], preparation);
  return entry && entry.id === ref.id && entry.version === ref.version ? entry : null;
}

export type ContactPastMemoryPreparation = {
  entry: ContactMaterialEntry;
  refresh(): Promise<ContactMaterialEntry | null>;
};

/** The caller already owns a real, eligible ordinary-contact opportunity. */
export async function prepareContactPastMemory(input: {
  messages: readonly SubjectiveMessage[]; own: readonly ContactMaterialEntry[];
  state: UnifiedContactState; signal: AbortSignal;
}): Promise<ContactPastMemoryPreparation | null> {
  const recent = input.messages.filter(message => message.deliveryStatus !== 'failed'
    && message.source !== 'proactive-message' && (message.role === 'I' || message.role === 'you')).slice(-6);
  const query: StructuredMemoryQuery = { userText: recent.map(message => `${message.role}：${message.content}`).join('\n'),
    activeContext: input.own.map(item => item.text).join('\n') };
  if (!query.userText.trim() && !query.activeContext?.trim()) return null;
  const preparation = createMemoryMaterialPreparation({ signal: input.signal });
  const result = await buildMemoryRecall(query, { allowRerank: false, touch: false,
    materialPreparation: preparation, signal: input.signal });
  preparation.assertCurrent(input.signal);
  const relevant = result.items.filter(item => item.relevanceTier !== undefined && item.relevanceTier !== 'weak'
    && isContactPastMemoryEligible(item.memory));
  const current = await preparation.refresh(relevant.map(item => item.memory), isContactPastMemoryEligible, input.signal);
  const selected = selectRefreshedMemoryRecallItems(relevant, memoryLocalRecallQuery(query), preparation, current, { requireRelevant: true });
  let chosen: MemoryRecallItem | undefined;
  let entry: ContactMaterialEntry | null = null;
  const previous = input.state.lastOrdinaryCurrentStateOffer?.pastMemory;
  for (const item of selected) {
    const candidate = entryFor(item.memory, preparation);
    if (!candidate || previous?.id === item.memory.id && previous.version === candidate.version) continue;
    chosen = item; entry = candidate; break;
  }
  if (!chosen || !entry) return null;
  let original = chosen;
  let version = entry.version;
  let changed = preparation.wasRefreshed(chosen.memory.id);
  let omitted = false;
  const initialEntry = entry;
  return { entry: initialEntry, refresh: async () => {
    if (omitted) return null;
    preparation.assertCurrent(input.signal);
    // This contact supplies the current card and supplements, not its background
    // compression. Compare the actual offered version across preparation passes.
    const fresh = createMemoryMaterialPreparation({ signal: input.signal });
    const current = await fresh.refresh([original.memory], isContactPastMemoryEligible, input.signal);
    const candidate = current[0] && entryFor(current[0], fresh);
    if (!candidate || candidate.version !== version && changed) { omitted = true; return null; }
    const revised = candidate.version !== version;
    const selected = selectRefreshedMemoryRecallItems([original], memoryLocalRecallQuery(query), {
      ...fresh, wasRefreshed: () => revised, wasOnlySurfaceMuteRefreshed: () => false,
    }, current, { requireRelevant: true });
    if (!selected[0]) { omitted = true; return null; }
    original = selected[0]; version = candidate.version; changed ||= revised;
    return candidate;
  } };
}

/** Only the first real stored bubble settles this opportunity's memory reference. */
export async function recordContactPastMemoryProvided(op: ContactOpportunity, message: SubjectiveMessage): Promise<void> {
  if (op.important || op.phoneEmergency || op.pastMemoryUsageResult || message.id !== contactMessageId(op, 0)
    || message.role !== 'I' || message.source !== 'proactive-message' || message.deliveryStatus === 'failed'
    || message.content !== op.messages[0] || !canCommitBackupRestoreDataEpoch(op.epoch)) return;
  const ref = op.sources.find(isContactPastMemorySource);
  const offered = ref && contactPastMemoryOffer(ref);
  const version = ref && parseVersion(ref.version);
  if (!ref || !offered || !version) return;
  // Bound local read failures separately; an unavailable statistics write must
  // neither regenerate an already saved body nor hold this opportunity forever.
  let current: ContactMaterialEntry | null = null;
  let read = false;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (!canCommitBackupRestoreDataEpoch(op.epoch)) return;
    try { current = await loadContactPastMemory(ref); read = true; break; } catch { /* local only */ }
  }
  if (!read) {
    op.pastMemoryUsageResult = 'failed';
    console.warn('[unified-contact] past-memory usage read failed', { opportunityId: op.id });
    return;
  }
  if (!current) { op.pastMemoryUsageResult = 'skipped'; return; }
  await settleSavedMemoryUsage({ receipt: createMemoryUsageReceipt(op.id, [{ memoryId: offered.id,
    targetHash: version[1], commentsHash: version[2] }]), savedAt: message.createdAt, dataEpoch: op.epoch,
  commentsScope: 'supplements', validateReference: async (reference, transaction) =>
    stableMemoryHash(JSON.stringify(await loadMemorySourceRefs(reference.memoryId, transaction))) === version[3],
  onResult: result => { op.pastMemoryUsageResult = result; } });
}
