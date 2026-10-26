import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import { createShiyingOrganizationReferences, renderShiyingCorrectionComparison, renderShiyingOrganizationMaterial } from '../shiying/shiyingMemoryOrganizationProtocol';
import { loadShiyingMemorySnapshot, validateShiyingMemoryBinding, type ShiyingMemorySnapshot } from '../shiying/shiyingMemorySource';
import { captureBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { getMemoryDatabase, loadMemory, loadMemories, loadMemoryComments, type MemoryEntry } from './memoryStore';
import { createReadingOrganizationReferences, renderReadingCorrectionComparison, renderReadingOrganizationMaterial,
  type ReadingOrganizationReferences } from '../reading/readingMemoryOrganizationProtocol';
import { validateReadingOrganizationBinding, loadReadingOrganizationSource } from '../reading/readingMemoryOrganizationSource';
import { wholeReadingOrganizationBinding } from '../reading/readingMemoryOrganizationSource';
import { currentMemoryComments } from './memoryCurrentMaterials';
import { searchSimilarMemoryTargetSegments } from './memoryEmbedding';
import { loadMemoryCurrentState, loadMemoryCurrentStates, type MemoryCurrentState } from './memoryCurrentStateStore';
import { loadCurrentStateMaterial } from './memoryCurrentStateContext';
import { scoreCurrentStateText } from './memoryRecall';
import { scoreMemoryForRecall } from './memoryRecallScoring';
import { weeklyTargetHash } from './memoryWeeklyBasis';
import { formatMemoryEventTimeLabel, stableMemoryHash } from './memoryAtomicity';
import { isFocusMemorySource, focusMemorySourceSessionId, loadFocusMemoryMessages,
  loadFocusMemoryMessage, makeFocusMaterialBinding, type FocusMaterialBinding } from '../focus/focusMemorySource';
import { focusLogPurpose } from '../focus/focusOrganizationProtocol';
import { validateVoiceCallMaterialBinding, type VoiceCallMaterialBinding } from '../voiceCall/voiceCallMemorySource';
import { getUnderstandingStatus, isUnderstandingMemory, isConversationMemoryMaterial, materialValue, readUnderstandingMaterial,
  readUnderstandingMessage, readUnderstandingObservation, loadObservationOccurrenceLinks, understandingMessageHash, understandingMessageValue,
  validateUnderstandingMaterials, assignLifeSelfReferences, type UnderstandingMaterials } from './memoryUnderstanding';
import { isObservationMemorySource } from './memorySourceReader';

export function conversationMaterialSegments(messages: readonly SubjectiveMessage[], context: readonly SubjectiveMessage[] = [],
  options: { focusWholeSession?: boolean; postWholeBatch?: boolean; readingActivityCount?: number; lifeSelfWishCount?: number } = {}) {
  if (options.focusWholeSession && messages.some(message => !message.focusContext
    || !isFocusMemorySource(message.focusContext.sessionId))) throw new Error('FOCUS_MEMORY_SOURCE_INVALID');
  if (options.postWholeBatch && messages.some(message => !message.postMemoryContext)) throw new Error('POST_MEMORY_SOURCE_INVALID');
  const count = (options.readingActivityCount === undefined ? messages.length
    : messages.filter(message => !(message as SubjectiveMessage & { readingOrganizationInfo?: unknown }).readingOrganizationInfo).length + options.readingActivityCount)
    - (options.lifeSelfWishCount ?? 0);
  if (!options.focusWholeSession && !options.postWholeBatch && count > 30) throw new Error('memory-conversation-batch-too-large');
  const segments: string[] = [];
  for (let start = 0; start < messages.length; start += 4) {
    const window = messages.slice(start, start + 6);
    segments.push([...(start === 0 ? context.slice(-2) : []), ...window]
      .map(message => `${message.role}: ${message.content}`).join('\n'));
    if (start + 6 >= messages.length) break;
  }
  return segments;
}

function boundedFocusQueries(indices: number[]) {
  // Seven is the existing maximum number of overlapping windows for 30 originals.
  if (indices.length <= 7) return indices;
  return Array.from({ length: 7 }, (_, index) => indices[Math.round(index * (indices.length - 1) / 6)]);
}

export async function prepareConversationMaterials(input: {
  sessionId: string; messages: SubjectiveMessage[]; recalledIds?: string[];
  contextMessages?: SubjectiveMessage[]; signal?: AbortSignal; background?: boolean;
  targetMemoryId?: string; targetCurrentStateId?: string;
  letterBindings?: import('./letterMemoryIngestion').LetterMaterialBinding[];
  voiceBindings?: VoiceCallMaterialBinding[];
  observationMaterials?: import('./memoryObservationIngestion').PreparedObservationMaterial[];
  readingMaterials?: import('../reading/readingMemoryIngestion').PreparedReadingOrganizationMaterial[];
  readingCorrectionTargetIds?: string[];
  shiyingMaterials?: import('../shiying/shiyingMemoryIngestion').PreparedShiyingOrganizationMaterial[];
  lifeSelfMaterials?: import('./lifeSelfMemoryIngestion').PreparedLifeSelfOrganizationMaterial[];
  focusWholeSession?: boolean;
  postBindings?: import('../posts/baiyunPostMemorySource').PostMaterialBinding[];
  postCorrectionTargets?: Array<{ kind: 'memory' | 'current_state'; id: string }>;
}): Promise<UnderstandingMaterials> {
  const check = () => { if (input.signal?.aborted) throw Object.assign(new Error('memory-organizer-cancelled'), { name: 'AbortError' }); };
  check();
  if (input.focusWholeSession && (!isFocusMemorySource(input.sessionId)
    || input.messages.some(message => !message.focusContext
      || focusMemorySourceSessionId(message.focusContext.sessionId) !== focusMemorySourceSessionId(input.sessionId)))) {
    throw new Error('FOCUS_MEMORY_SOURCE_INVALID');
  }
  const focusOriginals = input.focusWholeSession ? new Map((await loadFocusMemoryMessages(input.sessionId))
    .map(message => [message.id, message])) : undefined;
  const database = await getMemoryDatabase();
  if (input.postBindings && !(await (await import('../posts/baiyunPostMemorySource')).validatePostMaterialBindings(input.postBindings, input.messages))) {
    throw new Error('POST_MEMORY_SOURCE_CHANGED');
  }
  const all = (await loadMemories({ includeArchived: false, currentOnly: true }))
    .filter(memory => isUnderstandingMemory(memory) || isConversationMemoryMaterial(memory));
  const materials: UnderstandingMaterials = { targets: [], memories: [], messages: [], batchMessages: [], text: '',
    observations: input.observationMaterials, relatedObservations: [],
    continuationEnabled: true, currentStatesEnabled: true, currentStates: [], currentStateSourceHashes: {}, episodeTargetIds: [], dataEpoch: captureBackupRestoreDataEpoch() };
  materials.postComparisonTargetIds = input.postCorrectionTargets?.filter(target => target.kind === 'memory').map(target => target.id);
  materials.readingMaterials = input.readingMaterials?.length ? input.readingMaterials : undefined;
  materials.lifeSelfMaterials = input.lifeSelfMaterials?.length ? input.lifeSelfMaterials : undefined;
  materials.readingComparisonTargetIds = input.readingCorrectionTargetIds;
  materials.shiyingMaterials = input.shiyingMaterials?.length ? input.shiyingMaterials : undefined;
  materials.shiyingComparisonTargetIds = input.shiyingMaterials?.flatMap(source => source.correctionTargets.filter(target => target.kind === 'memory').map(target => target.id));
  materials.shiyingComparisonStateIds = input.shiyingMaterials?.flatMap(source => source.correctionTargets.filter(target => target.kind === 'current_state').map(target => target.id));
  materials.postComparisonStateIds = input.postCorrectionTargets?.filter(target => target.kind === 'current_state').map(target => target.id);
  materials.observationOccurrenceLinks = await loadObservationOccurrenceLinks(input.observationMaterials ?? []);
  const states: MemoryCurrentState[] = [];
  for (;;) {
    const page = await loadMemoryCurrentStates({ limit: 100, offset: states.length });
    states.push(...page);
    if (page.length < 100) break;
    check();
  }
  for (const message of input.messages) {
    if (message.role === 'I' && message.source === 'proactive-message' && message.deliveryStatus === 'failed') continue;
    const self = input.lifeSelfMaterials?.find(material => material.message.id === message.id);
    if (self) {
      if (!(await (await import('../life/lifeSelfMemorySource')).validateLifeSelfBinding(self.binding, message))) throw new Error('MEMORY_UNDERSTANDING_STALE');
      materials.batchMessages.push({ sessionId: self.binding.sessionId, message, hash: self.binding.sourceHash,
        lifeSelfBinding: self.binding, lifeSelfAuthoredContent: self.source.authoredContent, lifeSelfSource: self.source });
      continue;
    }
    const shiying = input.shiyingMaterials?.flatMap(material => material.bindings).find(binding => binding.messageId === message.id);
    if (shiying) {
      if (!(await validateShiyingMemoryBinding(shiying, message))) throw new Error('MEMORY_UNDERSTANDING_STALE');
      materials.batchMessages.push({ sessionId: shiying.sessionId, message, hash: shiying.sourceHash, shiyingBinding: shiying });
      continue;
    }
    const reading = input.readingMaterials?.find(material => material.message.id === message.id);
    if (reading) {
      if (!(await validateReadingOrganizationBinding(reading.binding, message))) throw new Error('MEMORY_UNDERSTANDING_STALE');
      materials.batchMessages.push({ sessionId: reading.binding.sessionId, message, hash: reading.binding.sourceHash, readingBinding: reading.binding });
      continue;
    }
    const postBinding = input.postBindings?.find(binding => binding.messageId === message.id);
    if (postBinding) {
      materials.batchMessages.push({ sessionId: postBinding.sessionId, message, hash: postBinding.sourceHash, postBinding });
      continue;
    }
    const letterBinding = input.letterBindings?.find(binding => binding.messageId === message.id);
    const voiceBinding = input.voiceBindings?.find(binding => binding.messageId === message.id);
    const focusOriginal = focusOriginals?.get(message.id);
    const current = focusOriginals ? focusOriginal ? { sessionId: focusMemorySourceSessionId(input.sessionId),
      message: focusOriginal, hash: understandingMessageHash(input.sessionId, focusOriginal),
      focusBinding: makeFocusMaterialBinding(focusOriginal) } : null
      : await readUnderstandingMessage(voiceBinding?.sessionId ?? letterBinding?.sessionId ?? input.sessionId, message.id);
    if (voiceBinding) {
      if (!current || current.hash !== voiceBinding.sourceHash || !(await validateVoiceCallMaterialBinding(voiceBinding, message))) throw new Error('MEMORY_UNDERSTANDING_STALE');
      materials.batchMessages.push({ ...current, message, voiceBinding });
    } else if (letterBinding) {
      const { validateLetterBinding } = await import('./letterMemoryIngestion');
      if (!current || !(await validateLetterBinding(letterBinding, message))) throw new Error('MEMORY_UNDERSTANDING_STALE');
      materials.batchMessages.push({ ...current, message, letterBinding });
    } else {
      if (!current || current.hash !== understandingMessageHash(input.sessionId, message)) throw new Error('MEMORY_UNDERSTANDING_STALE');
      materials.batchMessages.push(current);
    }
  }
  const readingActivityCount = input.readingMaterials ? new Set(input.readingMaterials.map(material => JSON.stringify([material.binding.bookId, material.binding.activityId]))).size : undefined;
  const shiyingMessageCount = input.shiyingMaterials?.reduce((sum, material) => sum + material.messages.length, 0) ?? 0;
  const logicalCount = input.messages.length - (input.readingMaterials?.length ?? 0) + (readingActivityCount ?? 0)
    - shiyingMessageCount + (input.shiyingMaterials?.length ?? 0)
    - (input.lifeSelfMaterials?.filter(material => material.source.kind === 'wish').length ?? 0);
  if (!input.focusWholeSession && !input.postBindings && logicalCount + (input.observationMaterials?.length ?? 0) > 30) throw new Error('memory-conversation-batch-too-large');
  const segments = conversationMaterialSegments(materials.batchMessages.map(item => item.message), input.contextMessages,
    { focusWholeSession: input.focusWholeSession, postWholeBatch: !!input.postBindings,
      lifeSelfWishCount: input.lifeSelfMaterials?.filter(material => material.source.kind === 'wish').length,
      readingActivityCount: input.shiyingMaterials?.length ? (readingActivityCount ?? 0) + input.shiyingMaterials.length - shiyingMessageCount : readingActivityCount });
  if (materials.observations?.length) {
    const contents = materials.observations.map(item => item.content);
    // Reuse the existing bounded query windows; observation material is not a chat bubble.
    for (let start = 0; start < contents.length; start += 6) segments.push(contents.slice(start, start + 6).join('\n'));
  }
  const ranks = segments.map(query => all.map(memory => ({ memory, score: scoreMemoryForRecall(memory, query).textScore })));
  const stateRanks = segments.map(query => states.map(state => ({ state, score: scoreCurrentStateText(state, query) })));
  const missing = ranks.flatMap((rank, index) => rank.some(item => item.score >= 0.24)
    || stateRanks[index].some(item => item.score >= 0.24) ? [] : [index]);
  if (missing.length) {
    const queries = input.focusWholeSession || input.postBindings || input.observationMaterials || input.readingMaterials || input.shiyingMaterials || input.lifeSelfMaterials ? boundedFocusQueries(missing) : missing;
    const semantic = await searchSimilarMemoryTargetSegments(queries.map(index => segments[index]), 8,
      { signal: input.signal, budget: input.background ? 'background' : 'interactive',
        eligibleMemoryIds: new Set(all.map(memory => memory.id)), eligibleCurrentStateIds: new Set(states.map(state => state.id)) });
    queries.forEach((index, resultIndex) => {
      const values = semantic[resultIndex].memories;
      const stateValues = semantic[resultIndex].currentStates;
      const best = Math.max(0, ...values.values(), ...stateValues.values());
      for (const item of ranks[index]) {
        const score = values.get(item.memory.id) ?? 0;
        if (score >= Math.max(0.4, best - 0.08)) item.score = Math.max(item.score, score);
      }
      for (const item of stateRanks[index]) {
        const score = stateValues.get(item.state.id) ?? 0;
        if (score >= Math.max(0.4, best - 0.08)) item.score = Math.max(item.score, score);
      }
    });
  }
  check();
  const sorted = ranks.map(rank => rank.filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.memory.id.localeCompare(b.memory.id)).slice(0, 8).map(item => item.memory));
  const header = '【相关的原有认识与依据】\n';
  const readingComparisons = new Map<string, { memory: MemoryEntry; comments: string; readingIds: string[] }>();
  const shiyingComparisons = new Map<string, { memory: MemoryEntry; comments: string; sourceIds: string[] }>();
  const shiyingEvidence = new Map<string, ShiyingMemorySnapshot>();
  const retainShiyingEvidence = async (message: NonNullable<Awaited<ReturnType<typeof readUnderstandingMessage>>>) => {
    if (!message.shiyingBinding) return;
    const snapshot = await loadShiyingMemorySnapshot(message.shiyingBinding.recordId);
    if (!snapshot || !(await validateShiyingMemoryBinding(message.shiyingBinding, message.message))) throw new Error('MEMORY_UNDERSTANDING_STALE');
    shiyingEvidence.set(snapshot.recordId, snapshot);
  };
  const readingEvidence = new Map<string, NonNullable<Awaited<ReturnType<typeof loadReadingOrganizationSource>>>>();
  const readingReferences = () => {
    const paper = createShiyingOrganizationReferences([...(materials.shiyingMaterials ?? []).flatMap(item => item.messages.map(message => message.id)),
      ...materials.messages.filter(message => message.shiyingBinding).map(message => message.message.id)], [],
      [...input.messages.map(message => message.id), ...materials.targets.map(memory => memory.id), ...materials.memories.map(item => item.memory.id)]);
    const reading = createReadingOrganizationReferences([
    ...(materials.readingMaterials ?? []).map(item => item.message.id),
    ...materials.messages.filter(item => item.sessionId.startsWith('reading-auto-v1:')).map(item => item.message.id),
  ], [...readingComparisons.keys(), ...shiyingComparisons.keys()], [...input.messages.map(message => message.id),
    ...materials.targets.map(memory => memory.id), ...materials.memories.map(item => item.memory.id)]);
    return { ...reading, messageRefs: new Map([...reading.messageRefs, ...paper.messageRefs]) };
  };
  const readingText = (references: ReadingOrganizationReferences) => [
    ...[...readingComparisons.values()].map(({ memory, comments, readingIds }) => renderReadingCorrectionComparison({
      reference: references.memoryRefs.get(memory.id)!, kind: memory.source === 'episode-memory' ? '经过' : memory.semanticType,
      understandingSubject: memory.understandingSubject, title: memory.title, content: memory.content,
      time: memory.eventTime ? formatMemoryEventTimeLabel(memory.eventTime) : undefined,
      tags: memory.tags, recallCues: memory.recallCues, rememberedReason: memory.rememberedReason,
      comments: comments || undefined, readingReferences: readingIds.map(id => references.messageRefs.get(id)!),
    })),
    ...materials.messages.filter(item => item.sessionId.startsWith('reading-auto-v1:')).map(item => {
      const original = readingEvidence.get(item.sessionId);
      if (!original) throw new Error('READING_ORGANIZATION_SOURCE_INVALID');
      return renderReadingOrganizationMaterial(original.snapshot, references.messageRefs.get(item.message.id)!,
        { start: 0, end: original.snapshot.bookText.length }, { start: 0, end: item.message.content.length });
    }),
  ].join('\n\n');
  const shiyingText = (references: ReadingOrganizationReferences) => [[...shiyingComparisons.values()].map(({ memory, comments, sourceIds }) =>
    renderShiyingCorrectionComparison({ reference: references.memoryRefs.get(memory.id)!,
      kind: memory.source === 'episode-memory' ? '经过' : memory.semanticType, understandingSubject: memory.understandingSubject,
      title: memory.title, content: memory.content, time: memory.eventTime ? formatMemoryEventTimeLabel(memory.eventTime) : undefined,
      tags: memory.tags, recallCues: memory.recallCues, rememberedReason: memory.rememberedReason,
      comments: comments || undefined, shiyingReferences: sourceIds.map(id => references.messageRefs.get(id)!) })).join('\n\n'),
    ...[...shiyingEvidence].flatMap(([id, snapshot]) => {
      const sources = materials.messages.filter(message => message.shiyingBinding?.recordId === id);
      if (!sources.length) return [];
      const body = sources.find(message => message.shiyingBinding!.part === 'body');
      const image = sources.find(message => message.shiyingBinding!.part === 'image_note');
      return [renderShiyingOrganizationMaterial(snapshot, { body: body ? references.messageRefs.get(body.message.id) : undefined,
        imageNote: image ? references.messageRefs.get(image.message.id) : undefined }, { body: body?.shiyingBinding?.range, imageNote: image?.shiyingBinding?.range })];
    })].filter(Boolean).join('\n\n');
  const stateBlocks = new Map<string, (references?: ReadonlyMap<string, string>) => string>();
  const stateMessageIds = new Map<string, string[]>();
  const stateText = (references?: ReadonlyMap<string, string>) => stateBlocks.size
    ? `\n【相关旧近况】\n${[...stateBlocks.values()].map(render => render(references)).join('\n\n')}` : '';
  const messageId = (id: string, references?: ReadonlyMap<string, string>) => references?.get(id) ?? id;
  const focusContext = (message: SubjectiveMessage, references?: ReadonlyMap<string, string>) => `[messageId=${messageId(message.id, references)}][time=${new Date(message.createdAt).toISOString()}][用途=${focusLogPurpose(message.focusContext?.trigger)}]`;
  const messageValue = (message: typeof materials.messages[number], references?: ReadonlyMap<string, string>) => {
    const value = understandingMessageValue(message.sessionId, message.message);
    return input.focusWholeSession && isFocusMemorySource(message.sessionId)
      ? { ...value, messageId: messageId(value.messageId, references), context: focusContext(message.message, references) } : value;
  };
  const render = (references?: ReadonlyMap<string, string>) => { assignLifeSelfReferences(materials); return JSON.stringify({ targets: materials.targets.filter(m => !readingComparisons.has(m.id) && !shiyingComparisons.has(m.id)).map(m => ({ memoryId: m.id, understandingSubject: m.understandingSubject,
    title: m.title, content: m.content, tags: m.tags, recallCues: m.recallCues, rememberedReason: m.rememberedReason })),
    memories: materials.memories.filter(material => !material.readingComparison && !material.shiyingComparison).map(material => {
      const value = materialValue(material);
      return !references ? value : { ...value,
        memoryId: messageId(value.memoryId, readingReferences().memoryRefs),
        sourceRefs: value.sourceRefs.map(ref => ({ ...ref, messageId: messageId(ref.messageId, references) })),
        ...(value.eventTime?.timeSourceMessageId ? { eventTime: { ...value.eventTime,
          timeSourceMessageId: messageId(value.eventTime.timeSourceMessageId, references) } } : {}),
      };
    }), messages: materials.messages.filter(message => !message.shiyingBinding && (!input.readingMaterials?.length || !message.sessionId.startsWith('reading-auto-v1:'))).map(message => messageValue(message, references)),
    ...(materials.relatedObservations?.length ? { observations: materials.relatedObservations.map(item => item.content) } : {}) }); };
  const fits = () => materials.memories.length + (materials.currentStates?.length ?? 0) <= 6
    && materials.targets.length <= 4 && header.length + render().length + stateText().length
      + (input.readingMaterials?.length ? readingText(readingReferences()).length : 0)
      + shiyingText(readingReferences()).length <= 6000;
  const addState = async (state: MemoryCurrentState, postComparison = false, shiyingComparison = false) => {
    if (materials.currentStates!.length >= 3 || stateBlocks.has(state.id)) return;
    const material = postComparison || shiyingComparison ? await (async () => {
      const snapshot = await (await import('./memoryReadMaterials')).loadCurrentStateReadSnapshot(state.id, 'source', database,
        undefined, { postComparison, shiyingComparison });
      return typeof snapshot === 'string' ? null : { sourceParts: snapshot.parts };
    })() : await loadCurrentStateMaterial(state);
    if (!material) return;
    const focusBindings: FocusMaterialBinding[] = [];
    const focusMessages = new Map<string, SubjectiveMessage>();
    const sourceParts = input.focusWholeSession ? await Promise.all(material.sourceParts.map(async part => {
      if (!part.available || !part.sessionId || !part.messageId || !isFocusMemorySource(part.sessionId)) return part;
      const message = await loadFocusMemoryMessage(part.sessionId, part.messageId);
      if (!message || message.content !== part.content || message.createdAt !== part.createdAt || message.role !== part.role) {
        throw new Error('MEMORY_CURRENT_STATE_STALE');
      }
      focusBindings.push(makeFocusMaterialBinding(message));
      focusMessages.set(message.id, message);
      return { ...part, context: focusContext(message) };
    })) : material.sourceParts;
    const source = (references?: ReadonlyMap<string, string>) => sourceParts.map(part => {
      if (isObservationMemorySource(part.sessionId ?? '')) return `${part.sourceLabel}\n${part.content}`;
      const original = part.messageId ? focusMessages.get(part.messageId) : undefined;
      const context = original ? focusContext(original, references) : part.context;
      return `${context ? `${context}\n` : ''}[${part.sourceLabel}｜${part.role}｜${part.createdAt ? new Date(part.createdAt).toISOString() : '未记录'}｜${part.sessionId}｜${part.messageId ? messageId(part.messageId, references) : part.messageId}｜${part.relation}] ${part.content}`;
    }).join('\n') || '原话未找到';
    stateBlocks.set(state.id, references => `近况编号：${state.id}\n标题：${state.title}\n上次已知情况：${state.content}\n得知时间：${state.knownAt ? new Date(state.knownAt).toISOString() : '未记录'}\n依据：${source(references)}`);
    materials.currentStates!.push(state);
    if (!fits()) { stateBlocks.delete(state.id); materials.currentStates!.pop(); }
    else {
      if (input.focusWholeSession) stateMessageIds.set(state.id, sourceParts.flatMap(part => part.messageId ? [part.messageId] : []));
      materials.currentStateSourceHashes![state.id] = stableMemoryHash(JSON.stringify(material.sourceParts));
      if (focusBindings.length) (materials.currentStateFocusBindings ??= {})[state.id] = focusBindings;
    }
  };
  const seen = new Set<string>();
  const add = async (memory: MemoryEntry, postComparison = false) => {
    check();
    if (seen.has(memory.id)) return;
    seen.add(memory.id);
    const original = { targets: [...materials.targets], memories: [...materials.memories], messages: [...materials.messages],
      relatedObservations: [...(materials.relatedObservations ?? [])] };
    const addMemory = async (id: string, allowEpisode = false) => {
      if (materials.memories.some(item => item.memory.id === id)) return true;
      const value = await readUnderstandingMaterial(database, id, { allowEpisode, postComparison: postComparison && id === memory.id });
      if (!value) return false;
      const snapshot = all.find(item => item.id === id);
      if (snapshot && weeklyTargetHash(snapshot) !== weeklyTargetHash(value.memory)) return false;
      materials.memories.push(value); return true;
    };
    let complete = true;
    if (isUnderstandingMemory(memory)) {
      if ((!postComparison && await getUnderstandingStatus(database, memory) !== 'current') || materials.targets.length >= 4) return;
      materials.targets.push(memory);
      // A stale original is an update target only; its former evidence must not
      // be carried forward as proof of the corrected understanding.
      if (postComparison) { if (!fits()) Object.assign(materials, original); return; }
      for (const evidence of memory.understandingBasis?.evidence ?? []) {
        if (evidence.kind === 'memory') { complete = await addMemory(evidence.memoryId) && complete; continue; }
        if (evidence.kind === 'observation') {
          if ([...(materials.observations ?? []), ...(materials.relatedObservations ?? [])].some(item => item.binding.observationId === evidence.observationId)) continue;
          const current = await readUnderstandingObservation(evidence.observationId);
          const fragment = current && (await import('./memoryObservationIngestion')).prepareObservationFragment(current.record, 0, 6000);
          if (fragment?.binding.full) materials.relatedObservations!.push({ ...fragment, record: current!.record });
          else complete = false;
          continue;
        }
        if ([...materials.batchMessages, ...materials.messages].some(m => m.sessionId === evidence.sessionId && m.message.id === evidence.messageId)) continue;
        const message = await readUnderstandingMessage(evidence.sessionId, evidence.messageId);
        if (message) {
          await retainShiyingEvidence(message);
          if (message.sessionId.startsWith('reading-auto-v1:')) {
            const original = await loadReadingOrganizationSource(message.sessionId);
            if (!original) { complete = false; continue; }
            readingEvidence.set(message.sessionId, original);
            message.readingBinding = wholeReadingOrganizationBinding(original);
          }
          materials.messages.push(message);
        } else complete = false;
      }
      // Corrections are part of the comparison material, not a replacement for its direct evidence.
      const corrections = await database.getAllAsync<{ session_id: string; message_id: string }>(
        "SELECT session_id, message_id FROM memory_source_refs WHERE memory_id = ? AND relation = 'direct' ORDER BY message_created_at DESC", memory.id);
      for (const ref of corrections) {
        if ([...materials.messages, ...materials.batchMessages].some(m => m.sessionId === ref.session_id && m.message.id === ref.message_id)) continue;
        const message = await readUnderstandingMessage(ref.session_id, ref.message_id);
        if (message) {
          await retainShiyingEvidence(message);
          if (message.sessionId.startsWith('reading-auto-v1:')) {
            const original = await loadReadingOrganizationSource(message.sessionId);
            if (!original) continue;
            readingEvidence.set(message.sessionId, original);
            message.readingBinding = wholeReadingOrganizationBinding(original);
          }
          materials.messages.push(message); if (!fits()) materials.messages.pop();
        }
      }
    } else complete = await addMemory(memory.id, true);
    if (!complete || !fits()) Object.assign(materials, original);
  };
  const targets = sorted.flatMap(items => items.filter(isUnderstandingMemory));
  const lanes = ranks.map((rank, index) => [
    ...rank.filter(item => !isUnderstandingMemory(item.memory)).map(item => ({ ...item, key: `memory:${item.memory.id}` })),
    ...stateRanks[index].map(item => ({ ...item, key: `current_state:${item.state.id}` })),
  ].filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.key.localeCompare(b.key)).slice(0, 8));
  for (const id of input.readingCorrectionTargetIds ?? []) {
    const memory = await loadMemory(id);
    if (!memory || memory.type === 'archived') throw new Error('MEMORY_CONTINUATION_TARGET_MISSING');
    const material = isUnderstandingMemory(memory) ? undefined
      : await readUnderstandingMaterial(database, id, { allowEpisode: true, readingComparison: true });
    if (!isUnderstandingMemory(memory) && !material) throw new Error('MEMORY_CONTINUATION_TARGET_UNAVAILABLE');
    const readingIds = (input.readingMaterials ?? []).filter(source => source.correctionTargetIds.includes(id)).map(source => source.message.id);
    if (!readingIds.length) throw new Error('READING_ORGANIZATION_SOURCE_INVALID');
    const comments = currentMemoryComments(memory, await loadMemoryComments(id)).filter(comment => comment.kind !== 'dehydration')
      .map(comment => `${new Date(comment.createdAt).toISOString()} ${comment.author}：${comment.content}`).join('\n');
    readingComparisons.set(id, { memory, comments, readingIds });
    if (isUnderstandingMemory(memory)) materials.targets.push(memory); else materials.memories.push(material!);
    if (!fits()) throw new Error('MEMORY_CONTINUATION_TARGET_UNAVAILABLE');
    seen.add(id);
  }
  for (const id of new Set(materials.shiyingComparisonTargetIds ?? [])) {
    const memory = await loadMemory(id);
    if (!memory || memory.type === 'archived') throw new Error('MEMORY_CONTINUATION_TARGET_MISSING');
    const material = isUnderstandingMemory(memory) ? undefined
      : await readUnderstandingMaterial(database, id, { allowEpisode: true, shiyingComparison: true });
    if (!isUnderstandingMemory(memory) && !material) throw new Error('MEMORY_CONTINUATION_TARGET_UNAVAILABLE');
    const sourceIds = (input.shiyingMaterials ?? []).filter(source => source.correctionTargets.some(target => target.kind === 'memory' && target.id === id))
      .flatMap(source => source.messages.map(message => message.id));
    const comments = currentMemoryComments(memory, await loadMemoryComments(id)).filter(comment => comment.kind !== 'dehydration')
      .map(comment => `${new Date(comment.createdAt).toISOString()} ${comment.author}：${comment.content}`).join('\n');
    shiyingComparisons.set(id, { memory, comments, sourceIds });
    if (isUnderstandingMemory(memory)) materials.targets.push(memory); else materials.memories.push(material!);
    if (!fits()) throw new Error('MEMORY_CONTINUATION_TARGET_UNAVAILABLE');
    seen.add(id);
  }
  for (const target of input.shiyingMaterials?.flatMap(source => source.correctionTargets).filter(target => target.kind === 'current_state') ?? []) {
    const state = await loadMemoryCurrentState(target.id, database);
    if (!state || state.status !== 'active') throw new Error('MEMORY_CURRENT_STATE_TARGET_MISSING');
    await addState(state, false, true);
  }
  for (const target of input.postCorrectionTargets ?? []) {
    if (target.kind === 'current_state') {
      const state = await loadMemoryCurrentState(target.id, database);
      if (!state || state.status !== 'active') throw new Error('MEMORY_CURRENT_STATE_TARGET_MISSING');
      await addState(state, true);
    } else {
      const memory = await loadMemory(target.id);
      if (!memory || memory.type === 'archived') throw new Error('MEMORY_CONTINUATION_TARGET_MISSING');
      await add(memory, true);
    }
  }
  if (input.targetCurrentStateId) {
    const state = states.find(item => item.id === input.targetCurrentStateId);
    if (!state) throw new Error('MEMORY_CURRENT_STATE_TARGET_MISSING');
    await addState(state);
    if (!materials.currentStates!.some(item => item.id === state.id)) throw new Error('MEMORY_CURRENT_STATE_TARGET_UNAVAILABLE');
  }
  if (input.targetMemoryId) {
    const target = all.find(memory => memory.id === input.targetMemoryId)
      ?? (input.postBindings ? await loadMemory(input.targetMemoryId) : null);
    if (!target) throw new Error('MEMORY_CONTINUATION_TARGET_MISSING');
    if (input.postBindings) (materials.postComparisonTargetIds ??= []).push(target.id);
    await add(target, !!input.postBindings);
    if (!materials.targets.some(item => item.id === input.targetMemoryId)
      && !materials.memories.some(item => item.memory.id === input.targetMemoryId)) throw new Error('MEMORY_CONTINUATION_TARGET_UNAVAILABLE');
  }
  // Give every segment a first opportunity; old recall IDs never buy a fixed priority.
  for (let index = 0; index < Math.max(...lanes.map(items => items.length), targets.length, 0); index++) {
    for (const lane of lanes) {
      const item = lane[index];
      if (item) { if ('state' in item) await addState(item.state); else await add(item.memory); }
    }
    if (targets[index]) await add(targets[index]);
    if (materials.memories.length + materials.currentStates!.length >= 6) break;
  }
  materials.episodeTargetIds = materials.memories.map(item => item.memory.id);
  Object.assign(materials.observationOccurrenceLinks!, await loadObservationOccurrenceLinks(materials.relatedObservations ?? []));
  materials.text = (materials.targets.length || materials.memories.length || materials.messages.length ? header + render() : '') + stateText();
  materials.hasShiyingContext = materials.messages.some(message => !!message.shiyingBinding);
  if (input.readingMaterials?.length || input.shiyingMaterials?.length || materials.hasShiyingContext) {
    materials.readingReferences = readingReferences();
    materials.renderReadingText = references => (materials.targets.length || materials.memories.length || materials.messages.length ? header + render(references.messageRefs) : '')
      + stateText(references.messageRefs) + (readingText(references) ? `\n${readingText(references)}` : '')
      + (shiyingText(references) ? `\n${shiyingText(references)}` : '');
    materials.text = materials.renderReadingText(materials.readingReferences);
  }
  if (input.focusWholeSession) materials.renderFocusText = references =>
    (materials.targets.length || materials.memories.length || materials.messages.length ? header + render(references) : '') + stateText(references);
  if (input.focusWholeSession) materials.focusReferenceReservedIds = [...stateMessageIds.values()].flat();
  check();
  await validateUnderstandingMaterials(materials);
  return materials;
}
