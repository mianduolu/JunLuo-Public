import type { SQLiteDatabase } from 'expo-sqlite';
import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import { isLifeSelfMemorySource, loadLifeSelfSource, prepareLifeSelfFragment, renderLifeSelfMaterial,
  validateLifeSelfBinding, lifeSelfOccurrenceKey, type LifeSelfBinding, type LifeSelfSource } from '../life/lifeSelfMemorySource';
import { getTheaterBackstageContext } from '../ai/subjectiveMessages';
import { captureBackupRestoreDataEpoch, canCommitBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { stableMemoryHash } from './memoryAtomicity';
import { buildObservationMemorySourceRefs } from './memorySourceRefs';
import { getReadingMemorySourceContext, readingMemorySourceContextVersion } from '../reading/readingMemoryContext';
import { isReadingMemorySource, readingMemoryOccurrenceKey } from '../reading/readingMemorySource';
import { isShiyingMemorySource, getShiyingMemoryMessageInfo, loadShiyingMemoryMessage, loadShiyingMemorySnapshot,
  parseShiyingMemorySource, makeShiyingMemoryBinding, shiyingMemoryOccurrenceKey,
  validateShiyingMemoryBinding } from '../shiying/shiyingMemorySource';
import { currentMemoryComments } from './memoryCurrentMaterials';
import type { MemoryCandidateReview } from './memoryCandidateReview';
import type { PostMaterialBinding, PostMemoryReadOptions } from '../posts/baiyunPostMemorySource';
import { getMemoryDatabase, loadMemories, memoryFromRow, type MemoryEntry, type MemoryComment, type MemorySourceRefInput } from './memoryStore';
import { scoreMemoryForRecall } from './memoryRecallScoring';
import { weeklyTargetHash } from './memoryWeeklyBasis';
import { isFocusMemorySource, focusMemorySourceSessionId, focusMemoryMessageHash, makeFocusMaterialBinding,
  loadFocusMemoryMessage, validateFocusMaterialBindings, validateFocusCandidateSources,
  type FocusMaterialBinding } from '../focus/focusMemorySource';
import { getVoiceCallMemorySourceInfo, isVoiceCallMemorySource, loadVoiceCallMemoryMessage,
  buildVoiceCallMaterialMessage, loadVoiceCallMemoryRecord, renderVoiceCallMaterial,
  validateVoiceCallMaterialBinding, type VoiceCallMaterialBinding } from '../voiceCall/voiceCallMemorySource';

export type UnderstandingSubject = 'I' | 'you';
export type UnderstandingKind = 'stated' | 'pattern' | 'situational';
export type UnderstandingEvidence =
  | { kind: 'message'; sessionId: string; messageId: string; hash: string }
  | { kind: 'observation'; observationId: string; hash: string }
  | { kind: 'memory'; memoryId: string; hash: string };
export type UnderstandingBasis = { version: 1; subject: UnderstandingSubject; evidence: UnderstandingEvidence[]; hash: string };
export type UnderstandingPatternOccurrence = { sourceMessageIds: string[]; sourceMemoryIds: string[]; sourceObservationIds?: string[] };
export type UnderstandingReview = { targetMemoryId: string | null; targetHash?: string; previousTitle?: string; previousContent?: string;
  observationOccurrenceLinks?: Record<string, string[]>;
  // Absent on legacy drafts: keep them editable, but require a recheck before saving.
  patternEvidence?: UnderstandingPatternOccurrence[] | null;
  understandingKind?: UnderstandingKind; statedQuote?: string | null };
type Reader = Pick<SQLiteDatabase, 'getAllAsync' | 'getFirstAsync'>;
export type UnderstandingMessage = { sessionId: string; message: SubjectiveMessage; hash: string;
  lifeSelfBinding?: LifeSelfBinding; lifeSelfAuthoredContent?: string; lifeSelfSource?: LifeSelfSource;
  shiyingBinding?: import('../shiying/shiyingMemorySource').ShiyingMemoryBinding;
  readingBinding?: import('../reading/readingMemoryOrganizationSource').ReadingOrganizationBinding;
  postBinding?: PostMaterialBinding;
  letterBinding?: import('./letterMemoryIngestion').LetterMaterialBinding; voiceBinding?: VoiceCallMaterialBinding;
  focusBinding?: FocusMaterialBinding };
export type UnderstandingMaterial = { memory: MemoryEntry; comments: MemoryComment[]; sourceRefs: MemorySourceRefInput[]; hash: string; postComparison?: boolean; readingComparison?: boolean; shiyingComparison?: boolean };
export type UnderstandingMaterials = {
  lifeSelfMaterials?: import('./lifeSelfMemoryIngestion').PreparedLifeSelfOrganizationMaterial[];
  shiyingMaterials?: import('../shiying/shiyingMemoryIngestion').PreparedShiyingOrganizationMaterial[];
  hasShiyingContext?: boolean;
  shiyingComparisonTargetIds?: string[];
  shiyingComparisonStateIds?: string[];
  readingMaterials?: import('../reading/readingMemoryIngestion').PreparedReadingOrganizationMaterial[];
  readingComparisonTargetIds?: string[];
  readingReferences?: import('../reading/readingMemoryOrganizationProtocol').ReadingOrganizationReferences;
  renderReadingText?: (references: import('../reading/readingMemoryOrganizationProtocol').ReadingOrganizationReferences) => string;
  postComparisonTargetIds?: string[];
  postComparisonStateIds?: string[];
  currentStateFocusBindings?: Record<string, FocusMaterialBinding[]>;
  currentStatesEnabled?: boolean;
  currentStates?: import('./memoryCurrentStateStore').MemoryCurrentState[];
  currentStateSourceHashes?: Record<string, string>;
  targets: MemoryEntry[]; memories: UnderstandingMaterial[]; messages: UnderstandingMessage[];
  batchMessages: UnderstandingMessage[]; text: string;
  renderFocusText?: (references: ReadonlyMap<string, string>) => string;
  focusReferenceReservedIds?: readonly string[];
  observations?: import('./memoryObservationIngestion').PreparedObservationMaterial[];
  relatedObservations?: Array<Pick<import('./memoryObservationIngestion').PreparedObservationMaterial, 'binding' | 'record' | 'content'>>;
  observationOccurrenceLinks?: Record<string, string[]>;
  dataEpoch?: number | null;
  continuationEnabled?: boolean;
  episodeTargetIds?: string[];
};

/** Related old originals get distinct short references after the current batch. */
export function assignLifeSelfReferences(materials: UnderstandingMaterials) {
  const assigned = new Map<string, string>();
  const used = new Set<string>();
  for (const material of materials.lifeSelfMaterials ?? []) {
    const ref = material.binding.reference;
    const previous = assigned.get(material.binding.sessionId);
    if (used.has(ref) && previous !== ref) throw new Error('LIFE_SELF_MEMORY_REFERENCE_INVALID');
    assigned.set(material.binding.sessionId, ref); used.add(ref);
  }
  for (const original of [...materials.batchMessages, ...materials.messages]) {
    if (!original.lifeSelfSource || !original.lifeSelfBinding) continue;
    let reference = assigned.get(original.sessionId);
    if (!reference) {
      let index = 1;
      const prefix = original.lifeSelfSource.kind === 'exploration' ? 'E' : 'W';
      while (used.has(`${prefix}${index}`)) index++;
      reference = `${prefix}${index}`; used.add(reference); assigned.set(original.sessionId, reference);
    }
    const content = renderLifeSelfMaterial(original.lifeSelfSource, original.lifeSelfBinding, reference);
    original.lifeSelfBinding = { ...original.lifeSelfBinding, reference, sentHash: stableMemoryHash(content) };
    original.message = { ...original.message, content };
  }
  return new Map([...materials.batchMessages, ...materials.messages].flatMap(original => original.lifeSelfBinding
    ? [[original.lifeSelfBinding.reference, original.message.id] as const] : []));
}

function lifeSelfOccurrenceKeys(messages: UnderstandingMessage[]) {
  return Object.fromEntries(messages.filter(source => source.lifeSelfSource).map(source => {
    const original = source.lifeSelfSource!;
    return [source.sessionId, original.kind === 'wish' && original.wishOrigin
      ? `life-self-wish-origin:${JSON.stringify([original.wishOrigin.sourceKind, original.wishOrigin.sourceId])}`
      : original.occurrenceKey];
  }));
}

export function isUnderstandingMemory(memory: { understandingSubject?: unknown }) {
  return memory.understandingSubject === 'I' || memory.understandingSubject === 'you';
}

export function makeUnderstandingBasis(subject: UnderstandingSubject, evidence: UnderstandingEvidence[]): UnderstandingBasis {
  return { version: 1, subject, evidence, hash: stableMemoryHash(JSON.stringify([subject, evidence])) };
}

export function parseUnderstandingBasis(raw: unknown): UnderstandingBasis | undefined {
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!value || value.version !== 1 || !['I', 'you'].includes(value.subject)
      || !Array.isArray(value.evidence) || value.evidence.length < 1 || value.evidence.length > 6) return;
    const keys = new Set<string>();
    for (const item of value.evidence) {
      if (!item || typeof item.hash !== 'string' || !item.hash) return;
      const key = item.kind === 'message' && typeof item.sessionId === 'string' && item.sessionId
        && typeof item.messageId === 'string' && item.messageId ? `message:${item.sessionId}:${item.messageId}`
        : item.kind === 'memory' && typeof item.memoryId === 'string' && item.memoryId ? `memory:${item.memoryId}`
        : item.kind === 'observation' && typeof item.observationId === 'string' && item.observationId ? `observation:${item.observationId}` : null;
      if (!key || keys.has(key)) return;
      keys.add(key);
    }
    if (makeUnderstandingBasis(value.subject, value.evidence).hash !== value.hash) return;
    return value as UnderstandingBasis;
  } catch { return; }
}

export function understandingMessageValue(sessionId: string, message: SubjectiveMessage) {
  const context = getReadingMemorySourceContext(message) || getTheaterBackstageContext(message);
  const voice = getVoiceCallMemorySourceInfo(message);
  return { sessionId, messageId: message.id, role: message.role, time: message.createdAt,
    ...(context ? { context } : {}), ...(voice ? { delivery: voice.delivery, confidence: voice.confidence, emotionHint: voice.emotionHint } : {}), content: message.content };
}
export function understandingMessageHash(sessionId: string, message: SubjectiveMessage) {
  if (isShiyingMemorySource(sessionId)) {
    const source = getShiyingMemoryMessageInfo(message);
    if (!source || source.sessionId !== sessionId) throw new Error('SHIYING_MEMORY_SOURCE_INVALID');
    return source.sourceHash;
  }
  if (sessionId.startsWith('reading-auto-v1:')) {
    const source = (message as SubjectiveMessage & { readingOrganizationInfo?: { sessionId: string; sourceHash: string } }).readingOrganizationInfo;
    if (!source || source.sessionId !== sessionId || !source.sourceHash) throw new Error('READING_ORGANIZATION_SOURCE_INVALID');
    return source.sourceHash;
  }
  if (sessionId.startsWith('post-source:')) {
    const context = message.postMemoryContext;
    if (!context || context.sessionId !== sessionId || !context.sourceHash
      || stableMemoryHash(message.content) !== context.sentHash) throw new Error('POST_MEMORY_SOURCE_INVALID');
    return context.sourceHash;
  }
  if (isFocusMemorySource(sessionId) && message.focusContext) return focusMemoryMessageHash(message);
  if (isVoiceCallMemorySource(sessionId) && getVoiceCallMemorySourceInfo(message)) return getVoiceCallMemorySourceInfo(message)!.sourceHash;
  const source = getTheaterBackstageContext(message) ? message.theaterBackstage : undefined;
  return stableMemoryHash(JSON.stringify({ ...understandingMessageValue(sessionId, message),
    ...(readingMemorySourceContextVersion(message) ? { readingVersion: readingMemorySourceContextVersion(message) } : {}),
    ...(source ? { theaterBackstage: [source.batchId, source.replyId, source.storyId,
      source.branchId, source.mode, source.useNumber] } : {}) }));
}
function usableMessage(message: SubjectiveMessage) {
  return (message.role === 'I' || message.role === 'you') && !!message.content.trim()
    && message.deliveryStatus !== 'failed';
}
export async function readUnderstandingObservation(observationId: string) {
  const { getCameraObservationRecord } = await import('../camera/cameraObservationStore');
  const { getObservationSourceHash } = await import('./memoryObservationIngestion');
  try {
    const record = await getCameraObservationRecord(observationId);
    return { record, hash: getObservationSourceHash(record) };
  } catch (error) {
    if (error instanceof Error && error.message === 'camera_observation_not_found') return null;
    throw error;
  }
}
export async function validateObservationCandidateSources(candidate: Pick<MemoryCandidateReview, 'observationBindings' | 'sourceRefs'>) {
  const bindings = candidate.observationBindings ?? [];
  if ((candidate.sourceRefs ?? []).some(ref => ref.sessionId.startsWith('observation-source:')
    && (ref.relation ?? 'direct') === 'direct' && !bindings.some(binding => binding.observationId === ref.messageId
      && ref.sessionId === `observation-source:${binding.observationId}`))) return false;
  for (const binding of bindings) {
    if (!(await (await import('./memoryObservationIngestion')).validateObservationBinding(binding))) return false;
  }
  return true;
}
export async function prepareObservationRecheckMaterials(bindings: MemoryCandidateReview['observationBindings'], sessionId: string) {
  const module = await import('./memoryObservationIngestion');
  const result: import('./memoryObservationIngestion').PreparedObservationMaterial[] = [];
  let remaining = 6000;
  for (const binding of bindings ?? []) {
    if (result.some(source => source.binding.observationId === binding.observationId)) continue;
    const current = await readUnderstandingObservation(binding.observationId);
    if (!current) throw new Error('观察记录未找到；原稿和草稿已保留。');
    const fragment = current.hash === binding.sourceHash && await module.validateObservationBinding(binding)
      ? { binding, content: module.renderObservationMaterial(current.record, binding) }
      : module.prepareObservationFragment(current.record, 0, remaining);
    if (!fragment || fragment.content.length + 2 > remaining) throw new Error('观察材料超出本次容量；原稿和草稿已保留。');
    result.push(await module.restoreObservationMaterial(fragment.binding, sessionId));
    remaining -= fragment.content.length + 2;
  }
  return result;
}
export async function loadObservationOccurrenceLinks(observations: Array<Pick<import('./memoryObservationIngestion').PreparedObservationMaterial, 'record'>>) {
  const links: Record<string, string[]> = {};
  if (!observations.length) return links;
  const { loadToolAuditRecord } = await import('../tools/toolAuditStore');
  for (const { record } of observations) {
    const audit = await loadToolAuditRecord(record.actionId);
    if (audit?.toolId !== 'camera.look_once' || audit.status !== 'success' || !audit.cameraReply) continue;
    links[record.observationId] = [...audit.cameraReply.messageIds, ...(audit.sourceMessageId ? [audit.sourceMessageId] : [])]
      .map(id => JSON.stringify([audit.cameraReply!.sessionId, id]));
  }
  return links;
}
function throwIfUnderstandingReadAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw Object.assign(new Error('memory-understanding-read-cancelled'), { name: 'AbortError' });
}

export async function readUnderstandingMessage(sessionId: string, messageId: string,
  options: { waitForPendingWrites?: boolean } & PostMemoryReadOptions = {}): Promise<UnderstandingMessage | null> {
  throwIfUnderstandingReadAborted(options.signal);
  if (isLifeSelfMemorySource(sessionId)) {
    const source = await loadLifeSelfSource(sessionId, messageId);
    throwIfUnderstandingReadAborted(options.signal);
    if (!source) return null;
    const fragment = prepareLifeSelfFragment(source, 0, Math.max(6000, source.message.content.length + 2), source.kind === 'exploration' ? 'E1' : 'W1');
    // Keep the complete original for direct reads. A bounded organization fragment
    // is attached separately when that source is actually supplied to a request.
    const binding = fragment && fragment.binding.end === source.body.length ? fragment.binding : undefined;
    return { sessionId, message: source.message, hash: source.sourceHash, lifeSelfSource: source,
      lifeSelfAuthoredContent: source.authoredContent, ...(binding ? { lifeSelfBinding: binding } : {}) };
  }
  if (isShiyingMemorySource(sessionId)) {
    const message = await loadShiyingMemoryMessage(sessionId, messageId);
    const identity = parseShiyingMemorySource(sessionId)!;
    const snapshot = message && await loadShiyingMemorySnapshot(identity.recordId);
    throwIfUnderstandingReadAborted(options.signal);
    return message && snapshot ? { sessionId, message, hash: understandingMessageHash(sessionId, message),
      shiyingBinding: makeShiyingMemoryBinding(snapshot, identity.part, { start: 0, end: message.content.length }) } : null;
  }
  if (sessionId.startsWith('gift-source:')) {
    const message = await (await import('../gifts/giftMemorySource')).readGiftMemoryMessage(sessionId, messageId, options);
    throwIfUnderstandingReadAborted(options.signal);
    return message && usableMessage(message) ? { sessionId, message, hash: understandingMessageHash(sessionId, message) } : null;
  }
  if (sessionId.startsWith('post-source:')) {
    const { loadPostMemorySourceMessage } = await import('../posts/baiyunPostMemorySource');
    const message = await loadPostMemorySourceMessage(sessionId, messageId, options);
    throwIfUnderstandingReadAborted(options.signal);
    return message && usableMessage(message) ? { sessionId, message, hash: understandingMessageHash(sessionId, message) } : null;
  }
  if (isFocusMemorySource(sessionId)) {
    const message = await loadFocusMemoryMessage(sessionId, messageId);
    throwIfUnderstandingReadAborted(options.signal);
    return message ? { sessionId, message, hash: focusMemoryMessageHash(message),
      focusBinding: makeFocusMaterialBinding(message) } : null;
  }
  if (isReadingMemorySource(sessionId)) {
    const { loadReadingMemoryMessage } = await import('../reading/readingMemorySource');
    const message = await loadReadingMemoryMessage(sessionId, messageId);
    throwIfUnderstandingReadAborted(options.signal);
    return message && usableMessage(message) ? { sessionId, message, hash: understandingMessageHash(sessionId, message) } : null;
  }
  if (isVoiceCallMemorySource(sessionId)) {
    const message = await loadVoiceCallMemoryMessage(sessionId, messageId, options);
    throwIfUnderstandingReadAborted(options.signal);
    return message ? { sessionId, message, hash: getVoiceCallMemorySourceInfo(message)!.sourceHash } : null;
  }
  if (sessionId.startsWith('letter:')) {
    const { loadLetterMemoryPart } = await import('../letters/letterMemorySource');
    const part = await loadLetterMemoryPart(sessionId, messageId);
    throwIfUnderstandingReadAborted(options.signal);
    if (!part) return null;
    const message: SubjectiveMessage = { id: part.messageId, role: part.role, createdAt: part.createdAt,
      content: part.content, source: 'letter' };
    return { sessionId, message, hash: part.sourceHash };
  }
  if (options.waitForPendingWrites === false) {
    const { loadChatSessionMessagePage } = await import('../chat/chatStorage');
    let beforeIndex: number | undefined;
    for (;;) {
      throwIfUnderstandingReadAborted(options.signal);
      const page = await loadChatSessionMessagePage(sessionId, { limit: 100, beforeIndex, waitForPendingWrites: false });
      throwIfUnderstandingReadAborted(options.signal);
      const message = page.messages.find(item => item.id === messageId);
      if (message) return usableMessage(message) ? { sessionId, message, hash: understandingMessageHash(sessionId, message) } : null;
      if (!page.startIndex || beforeIndex !== undefined && page.startIndex >= beforeIndex) return null;
      beforeIndex = page.startIndex;
    }
  }
  const { hasChatSessionMessage, loadChatSessionMessage } = await import('../chat/chatStorage');
  throwIfUnderstandingReadAborted(options.signal);
  // A detached message key left by deletion is not a live original quotation.
  const exists = await hasChatSessionMessage(sessionId, messageId);
  throwIfUnderstandingReadAborted(options.signal);
  if (!exists) return null;
  const message = await loadChatSessionMessage(sessionId, messageId);
  throwIfUnderstandingReadAborted(options.signal);
  return message && usableMessage(message) ? { sessionId, message, hash: understandingMessageHash(sessionId, message) } : null;
}

/** Rechecks reread one bounded letter part; old offsets are reusable only for the same full source. */
export async function prepareRecheckMessages(sources: UnderstandingMessage[],
  previousBindings: import('./letterMemoryIngestion').LetterMaterialBinding[] = [],
  previousVoiceBindings: VoiceCallMaterialBinding[] = []) {
  const { prepareLetterFragment, validateLetterBinding } = await import('./letterMemoryIngestion');
  const { loadLetterMemoryPart } = await import('../letters/letterMemorySource');
  const originals: UnderstandingMessage[] = [];
  const letterBindings: import('./letterMemoryIngestion').LetterMaterialBinding[] = [];
  const voiceBindings: VoiceCallMaterialBinding[] = [];
  let voiceRemaining = 6000 - '【本次通话材料】\n原话范围：片段\n'.length;
  for (const source of sources) {
    if (originals.some(item => item.sessionId === source.sessionId && item.message.id === source.message.id)) continue;
    if (isVoiceCallMemorySource(source.sessionId)) {
      const record = await loadVoiceCallMemoryRecord(source.sessionId);
      const turn = record?.turns.find(item => source.message.id === `voice-call-turn:${encodeURIComponent(item.turnId)}:${item.role}`);
      if (!record || !turn) throw new Error('MEMORY_SOURCE_CHANGED');
      const previous = previousVoiceBindings.find(binding => binding.sessionId === source.sessionId && binding.messageId === source.message.id);
      const reusable = previous && await validateVoiceCallMaterialBinding(previous);
      const start = reusable ? previous.start : 0;
      const ceiling = reusable ? previous.end : turn.text.length;
      const header = renderVoiceCallMaterial({ ...source.message, content: '' }).length + 1;
      const { takeWeeklySentencePrefix } = await import('./memoryWeeklyMaterialText');
      const content = takeWeeklySentencePrefix(turn.text.slice(start, ceiling), voiceRemaining - header);
      if (!content.trim()) {
        if (!voiceBindings.length) throw new Error('MEMORY_VOICE_SENTENCE_TOO_LONG');
        break;
      }
      const prepared = buildVoiceCallMaterialMessage(record, turn, start, start + content.length);
      originals.push({ sessionId: source.sessionId, message: prepared.message, hash: prepared.binding.sourceHash, voiceBinding: prepared.binding });
      voiceBindings.push(prepared.binding);
      voiceRemaining -= renderVoiceCallMaterial(prepared.message, prepared.binding).length + 1;
      if (start + content.length < ceiling) break;
      continue;
    }
    if (!source.sessionId.startsWith('letter:')) { originals.push(source); continue; }
    if (letterBindings.length) continue;
    const part = await loadLetterMemoryPart(source.sessionId, source.message.id);
    if (!part) throw new Error('MEMORY_SOURCE_CHANGED');
    const previous = previousBindings.find(binding => binding.sessionId === source.sessionId && binding.messageId === source.message.id);
    const start = previous && await validateLetterBinding(previous) ? previous.start : 0;
    const prepared = prepareLetterFragment(part, start);
    if (!prepared) throw new Error('信件单句过长，暂未整理');
    originals.push({ sessionId: source.sessionId, message: prepared.message, hash: part.sourceHash, letterBinding: prepared.binding });
    letterBindings.push(prepared.binding);
  }
  const chatSessions = [...new Set(originals.filter(source => !source.sessionId.startsWith('letter:') && !isVoiceCallMemorySource(source.sessionId)).map(source => source.sessionId))];
  return { originals, sessionId: chatSessions[0] ?? originals[0]?.sessionId ?? '', letterBindings, voiceBindings };
}
export function isUnderstandingEvidenceMemory(memory: MemoryEntry) {
  return !isUnderstandingMemory(memory) && memory.type !== 'archived' && memory.type !== 'feel'
    && memory.source !== 'weekly-context' && memory.source !== 'episode-memory'
    && memory.source !== 'assistant-life-state' && memory.atomicKind !== 'stage_conclusion'
    && !memory.tags.some(tag => ['周脉络', '阶段记忆', '碎碎念', 'whisper', '白云动态'].includes(tag));
}
export function isConversationMemoryMaterial(memory: MemoryEntry) {
  return isUnderstandingEvidenceMemory(memory) || (!isUnderstandingMemory(memory) && memory.type !== 'archived'
    && memory.type !== 'feel' && memory.source !== 'weekly-context'
    && !memory.tags.some(tag => ['周脉络', '碎碎念', 'whisper', '白云动态'].includes(tag))
    && (memory.source === 'episode-memory' || memory.atomicKind === 'stage_conclusion'));
}
export function materialValue(material: Omit<UnderstandingMaterial, 'hash'>) {
  const { memory: m, comments, sourceRefs } = material;
  return { memoryId: m.id, title: m.title, content: m.content, domain: m.domain, tags: m.tags,
    recallCues: m.recallCues, rememberedReason: m.rememberedReason, semanticType: m.semanticType,
    atomicKind: m.atomicKind, importance: m.importance, eventTime: m.eventTime, eventAt: m.eventAt,
    date: m.date, source: m.source, sourceType: m.sourceType,
    comments: comments.map(c => ({ id: c.id, content: c.content, kind: c.kind, author: c.author, createdAt: c.createdAt })), sourceRefs };
}
export async function readUnderstandingMaterial(database: Reader, memoryId: string,
  options: { allowEpisode?: boolean; postComparison?: boolean; readingComparison?: boolean; shiyingComparison?: boolean } & PostMemoryReadOptions = {}): Promise<UnderstandingMaterial | null> {
  const row = await database.getFirstAsync<Parameters<typeof memoryFromRow>[0] & {
    understanding_comments_json: string | null; understanding_refs_json: string | null;
  }>(`SELECT m.*,
    CASE WHEN EXISTS(SELECT 1 FROM memory_comments WHERE memory_id=m.id AND typeof(created_at)<>'integer') THEN NULL
    ELSE (SELECT json_group_array(json_object('id',id,'memory_id',memory_id,'content',content,'source_type',source_type,
      'kind',kind,'author',author,'source',source,'created_at',created_at))
      FROM (SELECT * FROM memory_comments WHERE memory_id=m.id ORDER BY created_at DESC,id ASC)) END AS understanding_comments_json,
    CASE WHEN EXISTS(SELECT 1 FROM memory_source_refs WHERE memory_id=m.id AND typeof(message_created_at)<>'integer') THEN NULL
    ELSE (SELECT json_group_array(json_object('session_id',session_id,'message_id',message_id,'role',role,
      'message_created_at',message_created_at,'relation',relation,'excerpt',excerpt))
      FROM (SELECT * FROM memory_source_refs WHERE memory_id=m.id ORDER BY session_id,message_id,relation)) END AS understanding_refs_json
    FROM memories m WHERE m.id=?`, memoryId);
  if (!row) return null;
  const memory = memoryFromRow(row);
  if (!(options.allowEpisode ? isConversationMemoryMaterial(memory) : isUnderstandingEvidenceMemory(memory))) return null;
  const rows: Array<{ id: string; memory_id: string; content: string; source_type: MemoryComment['sourceType']; kind: MemoryComment['kind']; author: string; source: string | null; created_at: number }> = row.understanding_comments_json === null
    ? await database.getAllAsync('SELECT * FROM memory_comments WHERE memory_id = ? ORDER BY created_at DESC, id ASC', memoryId)
    : JSON.parse(row.understanding_comments_json);
  const comments = currentMemoryComments(memory, rows.map(r => ({ id: r.id, memoryId: r.memory_id, content: r.content,
    sourceType: r.source_type, kind: r.kind, author: r.author, source: r.source ?? undefined, createdAt: r.created_at })))
    .filter(c => c.kind !== 'dehydration');
  const refs: Array<{ session_id: string; message_id: string; role: 'I' | 'you'; message_created_at: number; relation: 'direct' | 'derived'; excerpt: string | null }> = row.understanding_refs_json === null
    ? await database.getAllAsync('SELECT * FROM memory_source_refs WHERE memory_id = ? ORDER BY session_id, message_id, relation', memoryId)
    : JSON.parse(row.understanding_refs_json);
  const sourceRefs = refs.map(r => ({ sessionId: r.session_id, messageId: r.message_id, role: r.role,
    messageCreatedAt: r.message_created_at, relation: r.relation, ...(r.excerpt ? { excerpt: r.excerpt } : {}) }));
  if (!options.postComparison && sourceRefs.some(ref => ref.relation === 'direct' && ref.sessionId.startsWith('post-source:'))
    && (await (await import('../posts/baiyunPostMemoryBasis')).getPostDerivedStatus(
    database, 'memory', memoryId, sourceRefs, options)).status !== 'current') return null;
  const material = { memory, comments, sourceRefs };
  if (!options.readingComparison && !(await (await import('../reading/readingMemoryOrganizationSource'))
    .isReadingOrganizationMemoryCurrent(database, memoryId, sourceRefs))) return null;
  if (!options.shiyingComparison && sourceRefs.some(ref => isShiyingMemorySource(ref.sessionId)) && !(await (await import('../shiying/shiyingMemorySource'))
    .isShiyingOrganizationMemoryCurrent(database, memoryId, sourceRefs))) return null;
  return { ...material, hash: stableMemoryHash(JSON.stringify(materialValue(material))), ...(options.postComparison ? { postComparison: true } : {}),
    ...(options.readingComparison ? { readingComparison: true } : {}), ...(options.shiyingComparison ? { shiyingComparison: true } : {}) };
}

export async function understandingBasisMatches(database: Reader, raw: unknown, postOptions: PostMemoryReadOptions = {}) {
  throwIfUnderstandingReadAborted(postOptions.signal);
  const basis = parseUnderstandingBasis(raw);
  if (!basis) return false;
  const committedOnly = basis.evidence.some(evidence => evidence.kind === 'message' && isVoiceCallMemorySource(evidence.sessionId));
  for (const evidence of basis.evidence) {
    throwIfUnderstandingReadAborted(postOptions.signal);
    const current = evidence.kind === 'observation' ? await readUnderstandingObservation(evidence.observationId)
      : evidence.kind === 'memory' ? await readUnderstandingMaterial(database, evidence.memoryId, postOptions)
      : await readUnderstandingMessage(evidence.sessionId, evidence.messageId, { ...postOptions, database, waitForPendingWrites: !committedOnly });
    throwIfUnderstandingReadAborted(postOptions.signal);
    if (!current || current.hash !== evidence.hash) return false;
  }
  return true;
}
export async function getUnderstandingStatus(database: Reader, memory: Pick<MemoryEntry, 'understandingSubject' | 'understandingBasis'>,
  postOptions: PostMemoryReadOptions = {}): Promise<'current' | 'stale' | 'unverified'> {
  throwIfUnderstandingReadAborted(postOptions.signal);
  if (!isUnderstandingMemory(memory)) return 'current';
  const basis = parseUnderstandingBasis(memory.understandingBasis);
  if (!basis || basis.subject !== memory.understandingSubject) return 'unverified';
  return await understandingBasisMatches(database, basis, postOptions) ? 'current' : 'stale';
}
export async function isUnderstandingCandidateCurrent(database: Reader, candidate: Pick<MemoryCandidateReview, 'understandingSubject' | 'understandingBasis' | 'understandingReview' | 'sourceRefs' | 'focusBindings' | 'postBindings'> & { voiceBindings?: VoiceCallMaterialBinding[]; lifeSelfBindings?: LifeSelfBinding[] },
  postOptions: PostMemoryReadOptions = {}) {
  if (!isUnderstandingMemory(candidate)) return true;
  if (!(await validateFocusCandidateSources(candidate))) return false;
  if ((candidate.postBindings?.length || candidate.sourceRefs?.some(ref => ref.sessionId.startsWith('post-source:')))
    && !(await (await import('../posts/baiyunPostMemorySource')).validatePostCandidateSources(candidate, { ...postOptions, database }))) return false;
  for (const binding of candidate.voiceBindings ?? []) if (!(await validateVoiceCallMaterialBinding(binding, undefined, { waitForPendingWrites: false }))) return false;
  for (const binding of candidate.lifeSelfBindings ?? []) if (!(await validateLifeSelfBinding(binding))) return false;
  const basis = parseUnderstandingBasis(candidate.understandingBasis);
  if (!basis || !candidate.understandingReview || candidate.understandingReview.patternEvidence === undefined
    || await getUnderstandingStatus(database, candidate, postOptions) !== 'current') return false;
  const materials: UnderstandingMaterial[] = [];
  const messages: UnderstandingMessage[] = [];
  if (candidate.understandingReview.patternEvidence !== null) {
    for (const evidence of basis.evidence) {
      if (evidence.kind !== 'memory') continue;
      const material = await readUnderstandingMaterial(database, evidence.memoryId, postOptions);
      if (!material || material.hash !== evidence.hash) return false;
      materials.push(material);
    }
  }
  if (candidate.understandingReview.understandingKind === 'stated'
    || basis.evidence.some(item => item.kind === 'message' && isLifeSelfMemorySource(item.sessionId))) {
    const committedOnly = basis.evidence.some(item => item.kind === 'message' && isVoiceCallMemorySource(item.sessionId));
    for (const evidence of basis.evidence) {
      if (evidence.kind !== 'message') continue;
      const message = await readUnderstandingMessage(evidence.sessionId, evidence.messageId,
        { ...postOptions, database, waitForPendingWrites: !committedOnly });
      if (!message || message.hash !== evidence.hash) return false;
      if (isLifeSelfMemorySource(evidence.sessionId)) {
        const binding = candidate.lifeSelfBindings?.find(value => value.sessionId === evidence.sessionId && value.messageId === evidence.messageId);
        if (!binding || !message.lifeSelfSource || !(await validateLifeSelfBinding(binding))) return false;
        const content = renderLifeSelfMaterial(message.lifeSelfSource, binding);
        const ref = candidate.sourceRefs?.find(value => value.relation === 'direct' && value.sessionId === evidence.sessionId && value.messageId === evidence.messageId);
        if (ref?.excerpt !== content) return false;
        messages.push({ ...message, message: { ...message.message, content }, lifeSelfBinding: binding });
        continue;
      }
      if (candidate.understandingReview.understandingKind !== 'stated') { messages.push(message); continue; }
      // The immutable direct excerpt is the material actually supplied, including
      // letter/voice fragments. An unread part of the full source cannot prove it.
      const ref = candidate.sourceRefs?.find(ref => ref.relation === 'direct' && ref.sessionId === evidence.sessionId
        && ref.messageId === evidence.messageId && ref.role === message.message.role);
      if (typeof ref?.excerpt !== 'string' || !ref.excerpt || !message.message.content.includes(ref.excerpt)) return false;
      messages.push({ ...message, message: { ...message.message, content: ref.excerpt } });
    }
  }
  for (const material of materials) for (const ref of material.sourceRefs) {
    if (!isLifeSelfMemorySource(ref.sessionId) || messages.some(value => value.sessionId === ref.sessionId && value.message.id === ref.messageId)) continue;
    const source = await readUnderstandingMessage(ref.sessionId, ref.messageId, { ...postOptions, database });
    if (!source) return false;
    messages.push(source);
  }
  try { parseUnderstandingReviewEvidence(candidate.understandingReview, basis.subject, basis.evidence, materials, messages,
    candidate.understandingReview.observationOccurrenceLinks); }
  catch { return false; }
  const target = candidate.understandingReview;
  if (target.targetMemoryId === null) return true;
  const row = await database.getFirstAsync<Parameters<typeof memoryFromRow>[0]>('SELECT * FROM memories WHERE id = ?', target.targetMemoryId);
  if (!row) return false;
  const memory = memoryFromRow(row);
  return memory.type !== 'archived' && memory.understandingSubject === candidate.understandingSubject
    && weeklyTargetHash(memory) === target.targetHash;
}

export async function prepareUnderstandingMaterials(input: {
  sessionId: string; messages: SubjectiveMessage[]; recalledIds?: string[]; targetMemoryId?: string; targetCurrentStateId?: string;
  continuationEnabled?: boolean; contextMessages?: SubjectiveMessage[]; signal?: AbortSignal; background?: boolean;
  focusWholeSession?: boolean;
  letterBindings?: import('./letterMemoryIngestion').LetterMaterialBinding[];
  voiceBindings?: VoiceCallMaterialBinding[];
  observationMaterials?: import('./memoryObservationIngestion').PreparedObservationMaterial[];
  readingMaterials?: import('../reading/readingMemoryIngestion').PreparedReadingOrganizationMaterial[];
  readingCorrectionTargetIds?: string[];
  shiyingMaterials?: import('../shiying/shiyingMemoryIngestion').PreparedShiyingOrganizationMaterial[];
  lifeSelfMaterials?: import('./lifeSelfMemoryIngestion').PreparedLifeSelfOrganizationMaterial[];
}): Promise<UnderstandingMaterials> {
  if (input.continuationEnabled) return (await import('./memoryConversationMaterials')).prepareConversationMaterials(input);
  const database = await getMemoryDatabase();
  const all = await loadMemories({ includeArchived: false });
  const query = input.messages.map(m => m.content).join('\n');
  const recalled = new Set(input.recalledIds);
  const ranked = all.map(memory => ({ memory, score: recalled.has(memory.id) ? 2 : scoreMemoryForRecall(memory, query).textScore }))
    .filter(item => item.score > 0 || item.memory.id === input.targetMemoryId)
    .sort((a, b) => Number(b.memory.id === input.targetMemoryId) - Number(a.memory.id === input.targetMemoryId) || b.score - a.score);
  const materials: UnderstandingMaterials = { targets: [], memories: [], messages: [], batchMessages: [], text: '',
    observations: input.observationMaterials, relatedObservations: [], lifeSelfMaterials: input.lifeSelfMaterials,
    dataEpoch: captureBackupRestoreDataEpoch() };
  materials.observationOccurrenceLinks = await loadObservationOccurrenceLinks(input.observationMaterials ?? []);
  for (const message of input.messages) {
    if (!usableMessage(message)) continue;
    const self = input.lifeSelfMaterials?.find(material => material.message.id === message.id);
    if (self) {
      if (!(await validateLifeSelfBinding(self.binding, message))) throw new Error('MEMORY_UNDERSTANDING_STALE');
      materials.batchMessages.push({ sessionId: self.binding.sessionId, message, hash: self.binding.sourceHash,
        lifeSelfBinding: self.binding, lifeSelfAuthoredContent: self.source.authoredContent, lifeSelfSource: self.source });
      continue;
    }
    const letterBinding = input.letterBindings?.find(binding => binding.messageId === message.id);
    const voiceBinding = input.voiceBindings?.find(binding => binding.messageId === message.id);
    const sessionId = voiceBinding?.sessionId ?? letterBinding?.sessionId ?? input.sessionId;
    const stored = await readUnderstandingMessage(sessionId, message.id);
    if (voiceBinding) {
      if (!stored || stored.hash !== voiceBinding.sourceHash || !(await validateVoiceCallMaterialBinding(voiceBinding, message))) throw new Error('MEMORY_UNDERSTANDING_STALE');
      materials.batchMessages.push({ ...stored, message, voiceBinding });
    } else if (letterBinding) {
      if (!stored || stored.hash !== letterBinding.sourceHash
        || !(await (await import('./letterMemoryIngestion')).validateLetterBinding(letterBinding, message))) throw new Error('MEMORY_UNDERSTANDING_STALE');
      materials.batchMessages.push({ ...stored, message, letterBinding });
    } else {
      if (!stored || stored.hash !== understandingMessageHash(sessionId, message)) throw new Error('MEMORY_UNDERSTANDING_STALE');
      materials.batchMessages.push(stored);
    }
  }
  const render = () => { assignLifeSelfReferences(materials); return JSON.stringify({
    targets: materials.targets.map(m => ({ memoryId: m.id, understandingSubject: m.understandingSubject,
      title: m.title, content: m.content, tags: m.tags, recallCues: m.recallCues, rememberedReason: m.rememberedReason })),
    memories: materials.memories.map(materialValue), messages: materials.messages.map(m => understandingMessageValue(m.sessionId, m.message)),
    ...(materials.relatedObservations?.length ? { observations: materials.relatedObservations.map(item => item.content) } : {}),
  }); };
  const fits = () => render().length + '【相关的原有认识与依据】\n'.length <= 6000;
  const addMemory = async (id: string) => {
    if (materials.memories.some(m => m.memory.id === id)) return;
    if (materials.memories.length >= 6) return;
    const material = await readUnderstandingMaterial(database, id);
    if (!material) return;
    materials.memories.push(material);
    if (!fits()) materials.memories.pop();
  };
  for (const { memory } of ranked) {
    if (!isUnderstandingMemory(memory) || materials.targets.length >= 4) continue;
    const previous = { targets: [...materials.targets], memories: [...materials.memories], messages: [...materials.messages],
      relatedObservations: [...(materials.relatedObservations ?? [])] };
    let observationsComplete = true;
    materials.targets.push(memory);
    if (!fits()) { materials.targets.pop(); continue; }
    for (const evidence of memory.understandingBasis?.evidence ?? []) {
      if (evidence.kind === 'memory') { await addMemory(evidence.memoryId); continue; }
      if (evidence.kind === 'observation') {
        if ([...(materials.observations ?? []), ...(materials.relatedObservations ?? [])].some(item => item.binding.observationId === evidence.observationId)) continue;
        const current = await readUnderstandingObservation(evidence.observationId);
        const fragment = current && (await import('./memoryObservationIngestion')).prepareObservationFragment(current.record, 0, 6000);
        if (fragment?.binding.full) {
          materials.relatedObservations!.push({ ...fragment, record: current!.record });
          if (!fits()) { materials.relatedObservations!.pop(); observationsComplete = false; }
        } else observationsComplete = false;
        continue;
      }
      if ([...materials.messages, ...materials.batchMessages].some(m => m.message.id === evidence.messageId)) continue;
      const message = await readUnderstandingMessage(evidence.sessionId, evidence.messageId);
      if (!message) continue;
      materials.messages.push(message);
      if (!fits()) materials.messages.pop();
    }
    const corrections = await database.getAllAsync<{ session_id: string; message_id: string }>(
      "SELECT session_id, message_id FROM memory_source_refs WHERE memory_id = ? AND relation = 'direct' ORDER BY message_created_at DESC", memory.id);
    for (const ref of corrections) {
      if ([...materials.messages, ...materials.batchMessages].some(m => m.message.id === ref.message_id)) continue;
      const message = await readUnderstandingMessage(ref.session_id, ref.message_id);
      if (!message) continue;
      materials.messages.push(message);
      if (!fits()) materials.messages.pop();
    }
    if (!observationsComplete) Object.assign(materials, previous);
  }
  for (const { memory } of ranked) await addMemory(memory.id);
  Object.assign(materials.observationOccurrenceLinks!, await loadObservationOccurrenceLinks(materials.relatedObservations ?? []));
  materials.text = materials.targets.length || materials.memories.length || materials.messages.length
    ? `【相关的原有认识与依据】\n${render()}` : '';
  return materials;
}

function parseUnderstandingPatternEvidence(raw: unknown, evidence: UnderstandingEvidence[], materials: UnderstandingMaterial[],
  observationLinks: Record<string, string[]> = {}, occurrenceKeys: Record<string, string> = {}): UnderstandingPatternOccurrence[] | null {
  if (raw === null) return null;
  const invalid = () => new Error('memory-understanding-pattern-evidence-invalid');
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > 6) throw invalid();
  // A delivered chat copy and its original letter are the same real source.
  const linkedObservations = new Map(Object.entries(observationLinks).flatMap(([id, keys]) => keys.map(key => [key, id] as const)));
  const sourceKey = (sessionId: string, messageId: string) => {
    if (isLifeSelfMemorySource(sessionId)) {
      const key = occurrenceKeys[sessionId] ?? lifeSelfOccurrenceKey(sessionId);
      if (!key) throw invalid();
      return key;
    }
    if (isFocusMemorySource(sessionId)) return focusMemorySourceSessionId(sessionId);
    if (isShiyingMemorySource(sessionId)) {
      const key = shiyingMemoryOccurrenceKey(sessionId);
      if (!key) throw invalid();
      return key;
    }
    if (isReadingMemorySource(sessionId)) {
      const key = readingMemoryOccurrenceKey(sessionId);
      if (!key) throw invalid();
      return key;
    }
    return linkedObservations.has(JSON.stringify([sessionId, messageId]))
      ? JSON.stringify([`observation-source:${linkedObservations.get(JSON.stringify([sessionId, messageId]))}`, linkedObservations.get(JSON.stringify([sessionId, messageId]))])
      : /^letter-.+-(original|reply)$/.test(messageId)
      ? JSON.stringify(['letter-source', messageId]) : JSON.stringify([sessionId,
        isVoiceCallMemorySource(sessionId) ? messageId.replace(/:(I|you)$/, '') : messageId]);
  };
  const selected = new Map(evidence.map(item => [item.kind === 'message' ? `message:${item.messageId}`
    : item.kind === 'observation' ? `observation:${item.observationId}` : `memory:${item.memoryId}`, item]));
  const assigned = new Set<string>();
  const occurrences: Set<string>[] = [];
  const groups = raw.map((group): UnderstandingPatternOccurrence => {
    if (!group || !Array.isArray(group.sourceMessageIds) || !Array.isArray(group.sourceMemoryIds)
      || group.sourceObservationIds !== undefined && !Array.isArray(group.sourceObservationIds)
      || [...group.sourceMessageIds, ...group.sourceMemoryIds, ...(group.sourceObservationIds ?? [])].some(id => typeof id !== 'string' || !id)) throw invalid();
    const keys: string[] = [...group.sourceMessageIds.map((id: string) => `message:${id}`), ...group.sourceMemoryIds.map((id: string) => `memory:${id}`),
      ...(group.sourceObservationIds ?? []).map((id: string) => `observation:${id}`)];
    if (!keys.length || keys.length > 6) throw invalid();
    const sources = new Set<string>();
    for (const key of keys) {
      const item = selected.get(key);
      if (!item || assigned.has(key)) throw invalid();
      assigned.add(key);
      if (item.kind === 'message') sources.add(sourceKey(item.sessionId, item.messageId));
      else if (item.kind === 'observation') sources.add(sourceKey(`observation-source:${item.observationId}`, item.observationId));
      else {
        const material = materials.find(m => m.memory.id === item.memoryId);
        if (!material) throw invalid();
        if (!material.sourceRefs.length) sources.add(`memory:${item.memoryId}`);
        for (const ref of material.sourceRefs) sources.add(sourceKey(ref.sessionId, ref.messageId));
      }
    }
    occurrences.push(sources);
    return { sourceMessageIds: [...group.sourceMessageIds], sourceMemoryIds: [...group.sourceMemoryIds],
      ...(group.sourceObservationIds ? { sourceObservationIds: [...group.sourceObservationIds] } : {}) };
  });
  // An original and a card derived entirely from it cannot stand in for two
  // occurrences. A shared background quotation alone does not merge events.
  if (occurrences.some((sources, index) => occurrences.some((other, otherIndex) => index !== otherIndex
    && [...sources].every(key => other.has(key))))) throw invalid();
  const selfKinds = new Set(occurrences.flatMap(sources => [...sources].filter(key => key.startsWith('life-self'))
    .map(key => key.startsWith('life-self-v1:exploration:') ? 'exploration' : 'wish')));
  // Without a recorded cross-source link, two records are not proof of two
  // independent real events. Never replace that missing link with word matching.
  if (selfKinds.size && (selfKinds.size > 1 || occurrences.some(sources => [...sources].some(key => !key.startsWith('life-self'))))) throw invalid();
  return groups;
}

function parseUnderstandingReviewEvidence(item: { understandingKind?: unknown; statedQuote?: unknown; patternEvidence?: unknown },
  subject: UnderstandingSubject, evidence: UnderstandingEvidence[], materials: UnderstandingMaterial[], messages: UnderstandingMessage[],
  observationLinks?: Record<string, string[]>)
  : Pick<Required<UnderstandingReview>, 'understandingKind' | 'statedQuote' | 'patternEvidence'> {
  const kind = item.understandingKind;
  if (kind !== 'stated' && kind !== 'pattern' && kind !== 'situational') throw new Error('memory-understanding-kind-invalid');
  if (kind === 'stated') {
    const quote = item.statedQuote;
    if (typeof quote !== 'string' || !quote.trim() || !messages.some(source => source.message.role === subject
      && source.message.content.includes(quote) && (!isLifeSelfMemorySource(source.sessionId)
        || !!source.lifeSelfAuthoredContent?.includes(quote)) && evidence.some(selected => selected.kind === 'message'
        && selected.sessionId === source.sessionId && selected.messageId === source.message.id))) {
      throw new Error('memory-understanding-stated-quote-invalid');
    }
  } else if (item.statedQuote !== null) throw new Error('memory-understanding-stated-quote-invalid');
  if (kind === 'pattern' ? item.patternEvidence === null : item.patternEvidence !== null) {
    throw new Error('memory-understanding-pattern-evidence-invalid');
  }
  return { understandingKind: kind, statedQuote: item.statedQuote as string | null,
    patternEvidence: parseUnderstandingPatternEvidence(item.patternEvidence, evidence, materials, observationLinks, lifeSelfOccurrenceKeys(messages)) };
}

export function understandingCandidateEvidence(item: {
  understandingSubject?: unknown; understandingKind?: unknown; statedQuote?: unknown;
  targetMemoryId?: unknown; sourceMessageIds?: unknown; sourceMemoryIds?: unknown; sourceObservationIds?: unknown; patternEvidence?: unknown;
}, materials?: UnderstandingMaterials) {
  if (!materials || (item.understandingSubject !== 'I' && item.understandingSubject !== 'you')
    || (item.targetMemoryId !== null && typeof item.targetMemoryId !== 'string')
    || !Array.isArray(item.sourceMessageIds) || !Array.isArray(item.sourceMemoryIds)) throw new Error('memory-understanding-contract-invalid');
  const observationIds = item.sourceObservationIds ?? [];
  if (!Array.isArray(observationIds)) throw new Error('memory-understanding-evidence-invalid');
  const ids = [...item.sourceMessageIds, ...item.sourceMemoryIds, ...observationIds];
  if (!ids.length || ids.length > 6 || ids.some(id => typeof id !== 'string' || !id)
    || new Set(item.sourceMessageIds).size !== item.sourceMessageIds.length
    || new Set(item.sourceMemoryIds).size !== item.sourceMemoryIds.length
    || new Set(observationIds).size !== observationIds.length) throw new Error('memory-understanding-evidence-invalid');
  const target = materials.targets.find(m => m.id === item.targetMemoryId);
  if (item.targetMemoryId !== null && (!target || target.understandingSubject !== item.understandingSubject)) throw new Error('memory-understanding-target-invalid');
  const evidence: UnderstandingEvidence[] = [];
  const refs = new Map<string, MemorySourceRefInput>();
  const selectedObservations = observationIds.map(id => {
    const source = [...(materials.observations ?? []), ...(materials.relatedObservations ?? [])].find(item => item.binding.observationId === id);
    if (!source) throw new Error('memory-understanding-evidence-invalid');
    evidence.push({ kind: 'observation', observationId: id, hash: source.binding.sourceHash });
    return source;
  });
  for (const ref of buildObservationMemorySourceRefs(selectedObservations.map(item => item.binding))) refs.set(`${ref.sessionId}:${ref.messageId}`, ref);
  for (const id of item.sourceMessageIds) {
    const matches = [...materials.batchMessages, ...materials.messages].filter(m => m.message.id === id);
    if (matches.length !== 1) throw new Error('memory-understanding-evidence-invalid');
    const { sessionId, message, hash } = matches[0];
    evidence.push({ kind: 'message', sessionId, messageId: id, hash });
    refs.set(`${sessionId}:${id}`, { sessionId, messageId: id, role: message.role, messageCreatedAt: message.createdAt, relation: 'direct', excerpt: message.content });
  }
  for (const id of item.sourceMemoryIds) {
    const material = materials.memories.find(m => m.memory.id === id);
    if (!material || material.postComparison || material.readingComparison || material.shiyingComparison || !isUnderstandingEvidenceMemory(material.memory)) throw new Error('memory-understanding-evidence-invalid');
    evidence.push({ kind: 'memory', memoryId: id, hash: material.hash });
    for (const ref of material.sourceRefs) {
      const key = `${ref.sessionId}:${ref.messageId}`;
      if (!refs.has(key)) refs.set(key, { ...ref, relation: 'derived' });
    }
  }
  return { understandingSubject: item.understandingSubject as UnderstandingSubject, understandingBasis: makeUnderstandingBasis(item.understandingSubject, evidence),
    understandingReview: { targetMemoryId: target?.id ?? null,
      ...(Object.keys(materials.observationOccurrenceLinks ?? {}).length ? { observationOccurrenceLinks: materials.observationOccurrenceLinks } : {}),
      ...parseUnderstandingReviewEvidence(item, item.understandingSubject, evidence, materials.memories,
        [...materials.batchMessages, ...materials.messages], materials.observationOccurrenceLinks),
      ...(target ? { targetHash: weeklyTargetHash(target), previousTitle: target.title, previousContent: target.content } : {}) },
    sourceRefs: [...refs.values()] };
}

export async function validateUnderstandingCandidates<T extends Pick<MemoryCandidateReview, 'understandingSubject' | 'understandingBasis' | 'understandingReview' | 'sourceRefs'>>(candidates: T[]) {
  const database = candidates.some(isUnderstandingMemory) ? await getMemoryDatabase() : null;
  for (const candidate of candidates) {
    if (database && !(await isUnderstandingCandidateCurrent(database, candidate))) throw new Error('MEMORY_UNDERSTANDING_STALE');
  }
  return candidates;
}

export async function validateUnderstandingMaterials(materials?: UnderstandingMaterials) {
  if (!materials) return;
  if (materials.dataEpoch !== undefined && !canCommitBackupRestoreDataEpoch(materials.dataEpoch)) throw new Error('MEMORY_UNDERSTANDING_STALE');
  const database = await getMemoryDatabase();
  for (const source of [...(materials.observations ?? []), ...(materials.relatedObservations ?? [])]) {
    if (!(await (await import('./memoryObservationIngestion')).validateObservationBinding(source.binding))) throw new Error('MEMORY_OBSERVATION_STALE');
  }
  if (!(await validateFocusMaterialBindings(Object.values(materials.currentStateFocusBindings ?? {}).flat()))) {
    throw new Error('MEMORY_CURRENT_STATE_STALE');
  }
  if (materials.currentStates?.length) {
    const { loadMemoryCurrentState, currentStateVersion } = await import('./memoryCurrentStateStore');
    for (const state of materials.currentStates) {
      const current = await loadMemoryCurrentState(state.id, database);
      if (!current || current.status !== 'active' || currentStateVersion(current) !== currentStateVersion(state)) throw new Error('MEMORY_CURRENT_STATE_STALE');
      const expectedSource = materials.currentStateSourceHashes?.[state.id];
      if (expectedSource) {
        const snapshot = await (await import('./memoryReadMaterials')).loadCurrentStateReadSnapshot(state.id, 'source', database,
          undefined, { postComparison: materials.postComparisonStateIds?.includes(state.id),
            shiyingComparison: materials.shiyingComparisonStateIds?.includes(state.id) });
        if (typeof snapshot === 'string' || stableMemoryHash(JSON.stringify(snapshot.parts)) !== expectedSource) throw new Error('MEMORY_CURRENT_STATE_STALE');
      }
    }
  }
  const allMessages = [...materials.messages, ...materials.batchMessages];
  for (const material of materials.lifeSelfMaterials ?? []) {
    if (!(await validateLifeSelfBinding(material.binding, material.message)) || material.content !== material.message.content) throw new Error('MEMORY_UNDERSTANDING_STALE');
  }
  const postMessages = allMessages.filter(message => message.sessionId.startsWith('post-source:'));
  if (postMessages.length) {
    const { loadPostMemoryKnowledgeSnapshot, loadPostMemoryOriginals, isPostMaterialBinding } = await import('../posts/baiyunPostMemorySource');
    const originals = await loadPostMemoryOriginals([...new Set(postMessages.map(source => source.sessionId.slice('post-source:'.length)))],
      { database, knowledge: await loadPostMemoryKnowledgeSnapshot(database) });
    const originalById = new Map(originals.map(original => [JSON.stringify([original.sessionId, original.messageId]), original]));
    for (const source of postMessages) {
      const original = originalById.get(JSON.stringify([source.sessionId, source.message.id]));
      if (!original || original.sourceHash !== source.hash || original.role !== source.message.role
        || original.createdAt !== source.message.createdAt) throw new Error('MEMORY_UNDERSTANDING_STALE');
      const binding = source.postBinding;
      if (binding) {
        if (!isPostMaterialBinding(binding) || binding.sessionId !== source.sessionId || binding.messageId !== source.message.id
          || binding.sourceHash !== original.sourceHash || binding.end > original.content.length
          || original.content.slice(binding.start, binding.end) !== source.message.content
          || stableMemoryHash(source.message.content) !== binding.sentHash) throw new Error('MEMORY_UNDERSTANDING_STALE');
      } else if (source.message.content !== original.content) throw new Error('MEMORY_UNDERSTANDING_STALE');
      if (understandingMessageHash(source.sessionId, source.message) !== original.sourceHash) throw new Error('MEMORY_UNDERSTANDING_STALE');
    }
  }
  const focusMessages = allMessages.filter(message => isFocusMemorySource(message.sessionId));
  if (focusMessages.some(message => !message.focusBinding)
    || !(await validateFocusMaterialBindings(focusMessages.map(message => message.focusBinding!),
      focusMessages.map(message => message.message)))) throw new Error('MEMORY_UNDERSTANDING_STALE');
  for (const message of allMessages) {
    if (isLifeSelfMemorySource(message.sessionId)) {
      if (!message.lifeSelfBinding || message.hash !== message.lifeSelfBinding.sourceHash
        || !(await validateLifeSelfBinding(message.lifeSelfBinding, message.message))) throw new Error('MEMORY_UNDERSTANDING_STALE');
      continue;
    }
    if (message.sessionId.startsWith('post-source:')) continue;
    if (message.postBinding) throw new Error('MEMORY_UNDERSTANDING_STALE');
    if (isShiyingMemorySource(message.sessionId)) {
      if (!message.shiyingBinding || !(await validateShiyingMemoryBinding(message.shiyingBinding, message.message))
        || message.hash !== message.shiyingBinding.sourceHash) throw new Error('MEMORY_UNDERSTANDING_STALE');
      continue;
    }
    if (isFocusMemorySource(message.sessionId)) {
      if (message.hash !== message.focusBinding!.sourceHash) throw new Error('MEMORY_UNDERSTANDING_STALE');
      continue;
    }
    if (message.readingBinding && !(await (await import('../reading/readingMemoryOrganizationSource'))
      .validateReadingOrganizationBinding(message.readingBinding, message.message))) throw new Error('MEMORY_UNDERSTANDING_STALE');
    if (message.voiceBinding && !(await validateVoiceCallMaterialBinding(message.voiceBinding, message.message))) throw new Error('MEMORY_UNDERSTANDING_STALE');
    if (message.letterBinding && !(await (await import('./letterMemoryIngestion')).validateLetterBinding(message.letterBinding, message.message))) {
      throw new Error('MEMORY_UNDERSTANDING_STALE');
    }
    if ((await readUnderstandingMessage(message.sessionId, message.message.id, { database }))?.hash !== message.hash) throw new Error('MEMORY_UNDERSTANDING_STALE');
  }
  for (const memory of materials.memories) {
    if ((await readUnderstandingMaterial(database, memory.memory.id, { allowEpisode: materials.continuationEnabled,
      postComparison: memory.postComparison, readingComparison: memory.readingComparison, shiyingComparison: memory.shiyingComparison }))?.hash !== memory.hash) throw new Error('MEMORY_UNDERSTANDING_STALE');
  }
  for (const target of materials.targets) {
    const row = await database.getFirstAsync<Parameters<typeof memoryFromRow>[0]>('SELECT * FROM memories WHERE id = ?', target.id);
    if (!row || weeklyTargetHash(memoryFromRow(row)) !== weeklyTargetHash(target)) throw new Error('MEMORY_UNDERSTANDING_STALE');
  }
}
