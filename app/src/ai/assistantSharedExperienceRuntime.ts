import { canCommitBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { initializeSharedExperienceBookmark, loadInnerUpdateState, updateInnerUpdateState,
  finishFirstPaperChatSupplement, innerMaterialKey, INTERNAL_PAPER_MAX_ATTEMPTS, INTERNAL_PAPER_RETRY_INTERVAL_MS,
  type SharedExperienceBatch, type SharedExperienceState } from '../chat/chatAfterglowState';
import { resolveChatAfterglowCandidate, type ChatAfterglowBookmark } from '../chat/chatAfterglowProbe';
import { loadChatStateFast, loadChatSessionMessage, loadChatSessionMessageOrder, loadChatSessionMessagePage } from '../chat/chatStorage';
import { prepareFirstPaperChat, reloadChatSupplement } from '../chat/firstPaperChatMaterial';
import { loadJunluoDesireState, updateJunluoInnerStatePair } from '../life/junluoInnerStateStore';
import { applyJunluoWants, settleJunluoDesireTime } from '../life/junluoDesireMetabolism';
import { applyJunluoAffectBasket } from '../life/junluoInnerStateGeneration';
import { isJunluoWantsAwake, isWantsClockOwner, refreshJunluoDesireClock } from '../life/junluoDesireRuntime';
import { isAutomaticRemoteAiAllowed, loadAutomaticRemoteAiPolicy } from '../runtime/automaticRemoteAiPolicy';
import { isChatReplyInFlight } from './aiRuntimeScheduler';
import { runBudgetedAiCall, runBudgetedAiCallPair } from './aiCallBudget';
import { prepareAssistantWants } from './assistantStateGenerator';
import { prepareAssistantAffect } from './assistantAffectGenerator';
import { loadSharedExperienceCandidates, reloadSharedExperienceCandidate, reloadCurrentSharedExperienceCandidate,
  sharedExperienceRefKey, sharedExperienceReference, type SharedExperienceCandidate } from './assistantSharedExperienceMaterial';
import { crossPageChatExclusions, isCrossPageExperience, renderCrossPageDocument, splitCrossPageDocument } from './assistantCrossPageExperience';
import { ASSISTANT_INTERNAL_PAPER_REQUEST_TIMEOUT_MS } from './assistantLifeShortJsonRequest';
import { appendAssistantLifeGenerationDiagnostic, recordAssistantLifeTransport, updateAssistantLifePersistenceDiagnostic } from './assistantLifeGenerationDiagnostics';
import type { AssistantInnerStateUpdateInput } from './assistantInnerStateRuntime';
import { THEATER_CREATION_BUDGET, theaterMaterialLength } from '../theater/theaterCoCreationMaterial';
import { prepareNearbyOutingMaterial, selectNearbyOutingMaterial, appendNearbyOutingMaterial,
  nearbyOutingSourcesMatch } from '../nearby/nearbyOutingMaterial';

const READING_INTERVAL = 30 * 60_000;
type Paper = 'wants' | 'affect';
const answered = (batch: SharedExperienceBatch, paper: Paper) => batch[paper].result !== undefined;
const partGenerationKey = (batch: SharedExperienceBatch) => `${batch.generationKey}${batch.segments ? `:part-${batch.segments.index}` : ''}`;
const operationId = (batch: SharedExperienceBatch) => `${partGenerationKey(batch)}:wants`;
const samePart = (left: SharedExperienceBatch | undefined, right: SharedExperienceBatch) => !!left
  && left.generationKey === right.generationKey && innerMaterialKey(left.refs) === innerMaterialKey(right.refs)
  && innerMaterialKey(left.segments ?? null) === innerMaterialKey(right.segments ?? null)
  && innerMaterialKey(left.chatSupplement ?? null) === innerMaterialKey(right.chatSupplement ?? null)
  && innerMaterialKey(left.outingRefs ?? null) === innerMaterialKey(right.outingRefs ?? null)
  && innerMaterialKey(left.theaterSelection ?? null) === innerMaterialKey(right.theaterSelection ?? null);
// Only parsed answers when the existing bookmark write failed; never another source-text queue.
let unsaved: { epoch: number | null; batch: SharedExperienceBatch } | undefined;
let running: Promise<boolean> | undefined;

function retainTheaterSelection(state: SharedExperienceState, batch: SharedExperienceBatch, now: number) {
  const old = batch.theaterSelection, previous = state.theaterSelections?.[batch.refs[0].id];
  const selected = previous && previous.updatedAt >= (old?.updatedAt ?? 0) ? previous : old;
  return selected ? { ...state.theaterSelections, [batch.refs[0].id]: { ...selected, updatedAt: now,
    attempts: { wants: Math.max(batch.wants.attempts, previous?.attempts?.wants ?? 0),
      affect: Math.max(batch.affect.attempts, previous?.attempts?.affect ?? 0) } } } : state.theaterSelections;
}

export function finishSharedExperienceBatch(state: SharedExperienceState, batch: SharedExperienceBatch,
  now: number, outcome: 'saved' | 'skipped'): SharedExperienceState {
  if (outcome === 'saved' && batch.segments && batch.segments.index + 1 < batch.segments.ends.length) {
    return { ...state, updatedAt: now, batch: { ...batch,
      ...(batch.outingRefs ? { outingRefs: [] } : {}),
      ...(batch.chatSupplement ? { chatSupplement: { ...batch.chatSupplement, unreadRefs: [], backgroundRefs: [] } } : {}),
      segments: { ...batch.segments, index: batch.segments.index + 1 }, wants: { attempts: 0 }, affect: { attempts: 0 } } };
  }
  const { batch: _batch, ...rest } = state;
  const theaterSelections = { ...state.theaterSelections };
  if (batch.kind === 'theater') for (const ref of batch.refs) delete theaterSelections[ref.id];
  return { ...rest, updatedAt: now,
    ...(state.theaterSelections ? { theaterSelections } : {}),
    processed: { ...state.processed, ...Object.fromEntries(batch.refs.map(ref => [sharedExperienceRefKey(ref), ref.revision])) },
    focus: batch.kind === 'focus' ? { ...state.focus, [batch.ownerId]: {
      throughAt: batch.throughAt, throughElapsedSeconds: batch.throughElapsedSeconds!,
    } } : state.focus,
    lastFinished: { generationKey: batch.generationKey, at: now, outcome } };
}

async function beforeChat(bookmark: ChatAfterglowBookmark, beforeAt: number) {
  const excluded = await crossPageChatExclusions((await loadInnerUpdateState())?.experience);
  const { sessions } = await loadChatStateFast({ activeMessageLimit: 1 });
  return resolveChatAfterglowCandidate({ bookmark, beforeAt, sessions, minimumRounds: 1,
    loadOrder: loadChatSessionMessageOrder, loadPage: loadChatSessionMessagePage,
    isUsableMessage: message => !excluded.has(message.id) && !message.voiceCallRecord
      && !!message.content.trim() && message.deliveryStatus !== 'failed' });
}

async function perform(input: AssistantInnerStateUpdateInput, excluded = new Set<string>()): Promise<boolean> {
  if (!isWantsClockOwner()) return false;
  const now = input.now ?? Date.now();
  const initial = await initializeSharedExperienceBookmark(now, input.dataEpoch);
  if (!initial?.experience) return false;
  const canCommit = () => !input.signal?.aborted && !isChatReplyInFlight() && canCommitBackupRestoreDataEpoch(input.dataEpoch);
  const canProceed = async () => canCommit() && isAutomaticRemoteAiAllowed(await loadAutomaticRemoteAiPolicy())
    && canCommit();
  const change = (update: (current: SharedExperienceState) => SharedExperienceState) =>
    updateInnerUpdateState(input.dataEpoch, state => state?.experience && canCommit()
      ? { ...state, experience: update(state.experience) } : state);
  const localDiagnostic = async (batch: SharedExperienceBatch, reason: string) => {
    await Promise.all((['wants', 'affect'] as const).map(flow => appendAssistantLifeGenerationDiagnostic({
      flow, stage: 'local', attemptedAt: Date.now(), generationKey: batch.generationKey,
      contextSource: 'afterglow', model: input.connection.model, status: 'failure', outputChars: 0,
      responseFormatRequested: input.connection.chatJsonOutputEnabled === true,
      interruptionReason: reason, persistenceStatus: 'interrupted',
      requests: [{ paper: 'inner', status: 'not-started', reason, outputChars: 0 }],
    }).catch(() => undefined)));
  };
  const finish = async (batch: SharedExperienceBatch, outcome: 'saved' | 'skipped', reason?: string,
    consumeChat = true) => {
    const order = consumeChat && batch.chatSupplement
      ? await loadChatSessionMessageOrder(batch.chatSupplement.sessionId) : [];
    await updateInnerUpdateState(input.dataEpoch, state => {
      if (!state?.experience || !canCommit() || !samePart(state.experience.batch, batch)) return state;
      const next = consumeChat ? finishFirstPaperChatSupplement(state, batch.chatSupplement, order) : state;
      return { ...next, ...(outcome === 'saved' && batch.outingRefs?.length ? { materials: { ...next.materials,
        life: { ...next.materials.life, ...Object.fromEntries(batch.outingRefs.map(ref => [ref.id, ref.revision])) } } } : {}),
        ...(outcome === 'saved' && batch.chatSupplement ? { generatedAt: Date.now(), updatedAt: Date.now() } : {}),
        experience: finishSharedExperienceBatch(state.experience, batch, Date.now(), outcome) };
    });
    if (reason) await localDiagnostic(batch, reason);
    else for (const flow of ['wants', 'affect'] as const) await updateAssistantLifePersistenceDiagnostic(
      batch.generationKey, { flow, status: 'saved', savedParts: [] }).catch(() => undefined);
  };
  if (unsaved?.epoch !== input.dataEpoch) unsaved = undefined;
  if (!await canProceed()) return !!initial.experience.batch;
  if (unsaved) {
    const retained = unsaved.batch;
    const saved = await change(state => samePart(state.batch, retained)
      ? { ...state, batch: retained, updatedAt: Date.now() } : state);
    if (saved?.experience?.batch?.generationKey === retained.generationKey
      && innerMaterialKey(saved.experience.batch) !== innerMaterialKey(retained)) return true;
    unsaved = undefined;
  }
  let state = (await loadInnerUpdateState())!;
  let batch = state.experience?.batch;
  let candidate: SharedExperienceCandidate | null = null;
  const chatMatches = async (value: SharedExperienceBatch) =>
    await nearbyOutingSourcesMatch(value.outingRefs ?? [])
    && (!value.chatSupplement || await reloadChatSupplement(value.chatSupplement, loadChatSessionMessage));

  if (batch) {
    // Both numeric records were atomically saved. A failed bookmark write only needs finishing.
    if ((await loadJunluoDesireState()).recentProcessedOperations.some(op => op.operationId === operationId(batch!))) {
      await finish(batch, 'saved'); return true;
    }
    if (!await chatMatches(batch)) {
      await finish(batch, 'skipped', 'shared-chat-source-changed', false); return true;
    }
    candidate = await reloadSharedExperienceCandidate(batch);
    if (!candidate) {
      if (batch.outingRefs?.length) {
        await finish(batch, 'skipped', 'shared-source-changed', false); return true;
      }
      if (batch.kind === 'theater') {
        const held = batch;
        // Retain spent attempts and original selection, but free the existing single active slot.
        await change(latest => {
          if (!samePart(latest.batch, held)) return latest;
          const { batch: _batch, ...rest } = latest;
          return { ...rest, updatedAt: now, theaterSelections: retainTheaterSelection(latest, held, now) };
        });
        (await import('../theater/theaterCoCreationRuntime')).markTheaterCoCreationCapacityBlocked(held);
        excluded.add(`theater:${held.ownerId}`);
        return perform(input, excluded);
      }
      if (batch.segments && batch.segments.index > 0) {
        await finish(batch, 'skipped', 'shared-source-changed-after-partial-adoption'); return true;
      }
      const current = await reloadCurrentSharedExperienceCandidate(batch);
      if (!current) { await finish(batch, 'skipped', 'shared-source-deleted'); return true; }
      const refs = sharedExperienceReference(current);
      const reset = (paper: Paper) => ({ attempts: batch![paper].attempts,
        ...(batch![paper].attempts ? { retryAt: Date.now() + INTERNAL_PAPER_RETRY_INTERVAL_MS } : {}) });
      const { segments: _segments, ...previousBatch } = batch;
      batch = { ...previousBatch, ...refs, preparedAt: Date.now(), wants: reset('wants'), affect: reset('affect') };
      const refreshed = batch;
      await change(latest => latest.batch?.generationKey === refreshed.generationKey
        ? { ...latest, batch: refreshed, updatedAt: Date.now() } : latest);
      await localDiagnostic(batch, 'shared-source-changed'); return true;
    }
    if ((['wants', 'affect'] as const).some(paper => !answered(batch!, paper)
      && batch![paper].attempts >= INTERNAL_PAPER_MAX_ATTEMPTS)) {
      await finish(batch, 'skipped', 'shared-pair-skipped-after-three-attempts'); return true;
    }
  } else {
    const eligible = (await loadSharedExperienceCandidates(state.experience!, now, 1)).filter(item =>
      !excluded.has(`${item.kind}:${item.ownerId}`));
    eligible.sort((a, b) => a.throughAt - b.throughAt || a.ownerId.localeCompare(b.ownerId));
    const first = eligible[0];
    if (!first) return false;
    // Preserve the two existing chat bookmarks. Only their older unread portions are caught up.
    if (state.pending || state.retry || await beforeChat(state, first.throughAt + 1)) {
      const result = await (await import('./assistantInnerStateRuntime')).resumeInnerBeforeSharedExperience({ ...input, sharedCatchupBefore: first.throughAt + 1 });
      if (result !== 'capacity-blocked') return true;
    }
    if (state.affect && (state.affect.pending || state.affect.retry || await beforeChat(state.affect, first.throughAt + 1))) {
      const result = await (await import('./assistantAffectRuntime')).resumeAffectBeforeSharedExperience({ ...input, sharedCatchupBefore: first.throughAt + 1 });
      if (result !== 'capacity-blocked') return true;
    }
    // A waiting older cross-page episode is a chronological boundary, not permission to read its ending first.
    if (first.kind === 'theater' && now - (state.experience!.lastCrossPageAttemptAt ?? -Infinity) < READING_INTERVAL) {
      excluded.add(`theater:${first.ownerId}`); return perform(input, excluded);
    }
    if (isCrossPageExperience(first.kind)
      && now - (state.experience!.lastCrossPageAttemptAt ?? -Infinity) < READING_INTERVAL) return true;
    if (first.kind === 'reading' && now - (state.experience!.lastReadingAttemptAt ?? -Infinity) < READING_INTERVAL) return true;
    // Do not place a later main-chat round between the two halves of a long experience batch.
    const nextChats = await Promise.all([beforeChat(state, Infinity), state.affect ? beforeChat(state.affect, Infinity) : null]);
    const nextChatAt = Math.min(...nextChats.filter(Boolean).map(item => item!.rounds[0].at(-1)!.createdAt),
      ...eligible.filter(item => item.kind !== first.kind || item.ownerId !== first.ownerId).map(item => item.throughAt));
    for (let units = 6; units >= 1; units--) {
      const selected = (await loadSharedExperienceCandidates(state.experience!, now, units))
        .find(item => item.kind === first.kind && item.ownerId === first.ownerId);
      if (selected && selected.throughAt < nextChatAt) { candidate = selected; break; }
    }
    if (!candidate) candidate = first;
    const refs = sharedExperienceReference(candidate);
    batch = { ...refs, preparedAt: now,
      generationKey: `experience-${innerMaterialKey([state.experience!.activatedAt, refs])}`,
      wants: { attempts: refs.theaterSelection?.attempts?.wants ?? 0 },
      affect: { attempts: refs.theaterSelection?.attempts?.affect ?? 0 } };
    if (batch.kind === 'theater' && [batch.wants, batch.affect].some(paper => paper.attempts >= INTERNAL_PAPER_MAX_ATTEMPTS)) {
      const exhausted = batch;
      await change(latest => latest.batch ? latest : finishSharedExperienceBatch(latest, exhausted, now, 'skipped'));
      return true;
    }
  }

  const commitPair = async (current: SharedExperienceBatch) => {
    if (!answered(current, 'wants') || !answered(current, 'affect')) return;
    const valid = async () => await canProceed() && samePart((await loadInnerUpdateState())?.experience?.batch, current)
      && !!await reloadSharedExperienceCandidate(current) && await chatMatches(current) && canCommit();
    if (!await valid()) return;
    const refreshed = await refreshJunluoDesireClock();
    const sleeping = !await isJunluoWantsAwake();
    if (refreshed?.clock.context?.awake !== !sleeping) return;
    const saved = await updateJunluoInnerStatePair(latest => {
      const at = Date.now();
      if (latest.desire.recentProcessedOperations.some(op => op.operationId === operationId(current))) return latest;
      if (latest.desire.clock.context?.awake !== !sleeping) return latest;
      const affect = current.affect.result === null ? latest.affect : applyJunluoAffectBasket({
        state: latest.affect, basket: current.affect.result!, generationKey: partGenerationKey(current), now: at, sleeping });
      let desire = applyJunluoWants({ state: latest.desire, changes: current.wants.result ?? [], now: at,
        operationId: operationId(current), allowSleepingSettlement: true });
      if (desire.clock.context) desire = settleJunluoDesireTime({ state: desire, now: at,
        nextContext: { ...desire.clock.context, relationshipChoice: affect.relationshipChoice.value } });
      return { desire, affect };
    }, { dataEpoch: input.dataEpoch, shouldCommit: async () => await valid()
      && sleeping === !await isJunluoWantsAwake() });
    if (saved?.desire.recentProcessedOperations.some(op => op.operationId === operationId(current))) await finish(current, 'saved');
  };
  if (answered(batch, 'wants') && answered(batch, 'affect')) { await commitPair(batch); return true; }
  if (!input.apiKey.trim()) return true;
  let activeBatch = batch;
  let admission: import('./aiCallBudget').AiRequestAdmission;
  const started: Partial<Record<Paper, number>> = {};
  const begin = async (paper: Paper) => {
    if (!await canProceed() || !await reloadSharedExperienceCandidate(activeBatch)
      || !await chatMatches(activeBatch)) throw new Error('shared-source-no-longer-current');
    const at = Date.now();
    let registered = false;
    const saved = await updateInnerUpdateState(input.dataEpoch, current => {
      if (!current?.experience || !canCommit()) return current;
      const existing = current.experience.batch;
      if (existing && (existing.generationKey !== activeBatch.generationKey
        || innerMaterialKey(existing.refs) !== innerMaterialKey(activeBatch.refs)
        || innerMaterialKey(existing.chatSupplement ?? null) !== innerMaterialKey(activeBatch.chatSupplement ?? null)
        || innerMaterialKey(existing.outingRefs ?? null) !== innerMaterialKey(activeBatch.outingRefs ?? null)
        || (existing.segments?.index ?? 0) !== (activeBatch.segments?.index ?? 0))) return current;
      const currentBatch = existing ? { ...existing,
        ...(activeBatch.segments && existing.wants.attempts === 0 && existing.affect.attempts === 0
          ? { segments: activeBatch.segments } : {}) } : activeBatch;
      if (answered(currentBatch, paper) || currentBatch[paper].attempts >= INTERNAL_PAPER_MAX_ATTEMPTS
        || at < (currentBatch[paper].retryAt ?? 0)) return current;
      activeBatch = { ...currentBatch, [paper]: { attempts: currentBatch[paper].attempts + 1,
        retryAt: at + ASSISTANT_INTERNAL_PAPER_REQUEST_TIMEOUT_MS + INTERNAL_PAPER_RETRY_INTERVAL_MS } };
      registered = true;
      return { ...current, ...(paper === 'wants' ? { lastAttemptAt: at }
        : { affect: { ...current.affect!, lastAttemptAt: at } }), experience: { ...current.experience,
          updatedAt: at, batch: activeBatch, ...(currentBatch.kind === 'reading' ? { lastReadingAttemptAt: at } : {}),
          ...(isCrossPageExperience(currentBatch.kind) || currentBatch.kind === 'theater' ? { lastCrossPageAttemptAt: at } : {}) } };
    });
    if (!registered || saved?.experience?.batch?.[paper].attempts !== activeBatch[paper].attempts
      || saved.experience.batch.generationKey !== activeBatch.generationKey) throw new Error('shared-attempt-not-saved');
    started[paper] = at;
  };
  const transport = (paper: Paper) => (value: Parameters<typeof recordAssistantLifeTransport>[1]) =>
    recordAssistantLifeTransport({ flow: paper,
      generationKey: activeBatch.generationKey, requestId: `${operationId(activeBatch)}:${paper}:${activeBatch[paper].attempts}`,
      attemptOrdinal: activeBatch[paper].attempts, contextSource: 'afterglow', model: input.connection.model,
      responseFormatRequested: input.connection.chatJsonOutputEnabled === true }, value);
  let postLookKind: 'posts' | 'comments' | 'both' | undefined;
  const prepare = async (selected: SharedExperienceCandidate) => {
    // An old persisted batch without the optional field keeps its original material contract.
    const chat = state.experience!.batch && !activeBatch.chatSupplement ? undefined : await prepareFirstPaperChat({
      bookmark: state, sessions: (await loadChatStateFast({ activeMessageLimit: 1 })).sessions,
      throughAt: selected.throughAt, excludeIds: await crossPageChatExclusions(state.experience),
      loadOrder: loadChatSessionMessageOrder, loadMessage: loadChatSessionMessage,
      ...(activeBatch.chatSupplement && state.experience!.batch ? { frozen: activeBatch.chatSupplement } : {}),
    });
    const outings = await prepareNearbyOutingMaterial({ through: selected.throughAt,
      activatedAt: state.materials.activatedAt, read: state.materials.life,
      ...(state.experience!.batch ? { refs: activeBatch.outingRefs ?? [] } : {}) });
    let selectedChatCount = chat?.maxSupplementCount ?? 0;
    const selectOutings = (count: number, chatCount: number) => {
      const supplement = chat?.select(0, chatCount).chatSupplement;
      return selectNearbyOutingMaterial({ segments: outings, through: selected.throughAt, limit: count,
        providedChat: supplement ? [{ sessionId: supplement.sessionId,
          messageIds: new Set([...supplement.unreadRefs, ...supplement.backgroundRefs].map(ref => ref.id)) }] : [] });
    };
    const wants = await prepareAssistantWants({ ...input, source: 'life',
      outingCount: Math.min(6, outings.length),
      chatSupplementCount: chat?.maxSupplementCount ?? 0, fixedChatSelection: !!state.experience!.batch,
      onChatSupplementSelected: count => {
        selectedChatCount = count;
        const selectedChat = chat?.select(0, count).chatSupplement;
        const { chatSupplement: _old, ...previous } = activeBatch;
        activeBatch = { ...previous, ...(selectedChat ? { chatSupplement: selectedChat } : {}) };
      },
      onOutingSelected: count => {
        if (!state.experience!.batch || activeBatch.outingRefs !== undefined)
          activeBatch = { ...activeBatch, outingRefs: selectOutings(count, selectedChatCount).refs };
      },
      postLookKind: postLookKind = await isJunluoWantsAwake() ? await import('../posts/baiyunPostReplyRuntime')
        .then(runtime => runtime.preparePostLookPaper({ key: activeBatch.generationKey, lane: 'shared', dataEpoch: input.dataEpoch }))
        .catch(() => undefined) : undefined,
      materialForRounds: (_rounds, count, outingCount = outings.length) => ({
        text: appendNearbyOutingMaterial(selected.material, [], selectOutings(outingCount, count ?? selectedChatCount).entries),
        ...(chat ? { conversation: chat.select(0, count ?? chat.maxSupplementCount).conversation } : {}) }),
      onRequestStart: assertTransportReady => admission.beforeTransport(() => begin('wants'), assertTransportReady), onTransportAttempt: transport('wants') });
    return { wants, affect: await prepareAssistantAffect({ ...input, now, messages: [], lifeMaterial: selected.material,
      onRequestStart: assertTransportReady => admission.beforeTransport(() => begin('affect'), assertTransportReady), onTransportAttempt: transport('affect') }) };
  };
  const selectedPart = () => candidate!.document && activeBatch.segments ? { ...candidate!,
    material: renderCrossPageDocument(candidate!.document, activeBatch.segments) } : candidate!;
  let prepared = await prepare(selectedPart());
  // Both envelopes must fit before either request is paid. Shrink only whole source units.
  if (!state.experience!.batch) {
    for (let units = 5; (!prepared.wants.fits || !prepared.affect.fits) && units >= 1; units--) {
      const smaller = (await loadSharedExperienceCandidates(state.experience!, now, units)).find(item =>
        item.ownerId === activeBatch.ownerId && item.kind === activeBatch.kind && item.throughAt <= activeBatch.throughAt);
      if (!smaller) continue;
      candidate = smaller;
      const refs = sharedExperienceReference(smaller);
      activeBatch = { ...activeBatch, ...refs, generationKey: `experience-${innerMaterialKey([state.experience!.activatedAt, refs])}` };
      prepared = await prepare(smaller);
    }
  }
  if ((!prepared.wants.fits || !prepared.affect.fits) && candidate?.document
    && (!activeBatch.segments || activeBatch.wants.attempts === 0 && activeBatch.affect.attempts === 0)) {
    const segments = await splitCrossPageDocument(candidate.document, async material => {
      const part = await prepare({ ...candidate!, material });
      return part.wants.fits && part.affect.fits;
    }, activeBatch.segments);
    if (segments) {
      activeBatch = { ...activeBatch, segments };
      prepared = await prepare(selectedPart());
    }
  }
  if (!prepared.wants.fits || !prepared.affect.fits
    || activeBatch.kind === 'theater' && theaterMaterialLength(candidate.material) > THEATER_CREATION_BUDGET) {
    await localDiagnostic(activeBatch, 'context-too-long');
    if (activeBatch.kind === 'theater') {
      (await import('../theater/theaterCoCreationRuntime')).markTheaterCoCreationCapacityBlocked(activeBatch);
      if (state.experience!.batch) await change(latest => {
        if (!samePart(latest.batch, activeBatch)) return latest;
        const { batch: _batch, ...rest } = latest;
        return { ...rest, updatedAt: now, theaterSelections: retainTheaterSelection(latest, activeBatch, now) };
      });
      excluded.add(`theater:${activeBatch.ownerId}`);
      return perform(input, excluded);
    }
    if (state.experience!.batch) return true;
    if (isCrossPageExperience(activeBatch.kind)) return true;
    excluded.add(`${activeBatch.kind}:${activeBatch.ownerId}`);
    return perform(input, excluded);
  }
  const attempt = async (paper: Paper, requestAdmission: import('./aiCallBudget').AiRequestAdmission) => {
    admission = requestAdmission;
    if (!await canProceed() || answered(activeBatch, paper) || Date.now() < (activeBatch[paper].retryAt ?? 0)) return;
    const result = await prepared[paper].execute();
    if (started[paper] === undefined) return;
    await appendAssistantLifeGenerationDiagnostic({ ...result.diagnostics, flow: paper, stage: 'request',
      attemptedAt: started[paper]!, requestId: `${operationId(activeBatch)}:${paper}:${activeBatch[paper].attempts}`,
      attemptOrdinal: activeBatch[paper].attempts, generationKey: activeBatch.generationKey,
      contextSource: 'afterglow', model: input.connection.model, status: result.status,
      ...(paper === 'wants' ? { extraFields: result.value?.issues ?? result.parseIssues } : {}),
      persistenceStatus: result.status === 'success' ? 'pending' : 'interrupted',
      requests: [{ ...result.diagnostics, paper: 'inner', status: result.status, reason: result.reason }],
    }).catch(() => undefined);
    let sourcesCurrent: boolean | undefined;
    if ((result.status === 'success' && result.value
      || paper === 'wants' && postLookKind && 'lookAtPost' in result && typeof result.lookAtPost === 'boolean')
      && await canProceed()) {
      try { sourcesCurrent = !!await reloadSharedExperienceCandidate(activeBatch) && await chatMatches(activeBatch); }
      catch { sourcesCurrent = undefined; } // Retain the paid answer; commitPair must verify before adoption.
    } else sourcesCurrent = false;
    // Local only: do not launch another request while the paired budget lease is held.
    // A valid first-paper choice is independent of either wants or affect basket validity.
    if (paper === 'wants' && postLookKind && 'lookAtPost' in result && typeof result.lookAtPost === 'boolean'
      && sourcesCurrent === true && await isJunluoWantsAwake() && canCommit()) {
      await import('../posts/baiyunPostReplyRuntime').then(runtime => runtime.acceptPostLookDecision({
        key: activeBatch.generationKey, lane: 'shared', kind: postLookKind,
        decision: result.lookAtPost as boolean, dataEpoch: input.dataEpoch,
      })).catch(() => undefined);
    }
    const acceptable = result.status === 'success' && result.value && sourcesCurrent !== false && await canProceed();
    const value = result.value;
    activeBatch = { ...activeBatch, [paper]: { attempts: activeBatch[paper].attempts,
      ...(acceptable ? { result: paper === 'wants' ? (value as { wants: SharedExperienceBatch['wants']['result'] }).wants
        : (value as { affect: SharedExperienceBatch['affect']['result'] }).affect }
        : { retryAt: Date.now() + INTERNAL_PAPER_RETRY_INTERVAL_MS }) } };
    unsaved = { epoch: input.dataEpoch, batch: activeBatch };
    const retained = activeBatch;
    const saved = await change(latest => samePart(latest.batch, retained)
      ? { ...latest, batch: retained, updatedAt: Date.now() } : latest);
    if (innerMaterialKey(saved?.experience?.batch ?? null) === innerMaterialKey(retained)) unsaved = undefined;
  };
  const due = (paper: Paper) => !answered(activeBatch, paper) && Date.now() >= (activeBatch[paper].retryAt ?? 0);
  if (due('wants') && due('affect')) {
    await runBudgetedAiCallPair('afterglow', admission => attempt('wants', admission), admission => attempt('affect', admission), {
      purpose: 'inner-wants', secondPurpose: 'inner-affect',
      connection: input.connection, dataEpoch: input.dataEpoch, secondKind: 'affectState', shouldContinue: () => canCommit() && !unsaved,
      sharedExperienceContinuation: activeBatch.segments && activeBatch.segments.index > 0
        && activeBatch.wants.attempts === 0 && activeBatch.affect.attempts === 0 ? {
          generationKey: activeBatch.generationKey, partIndex: activeBatch.segments.index } : undefined,
      shouldRecordAttempt: index => started[index === 1 ? 'wants' : 'affect'] !== undefined });
  } else for (const paper of ['wants', 'affect'] as const) if (due(paper)) {
    await runBudgetedAiCall(paper === 'wants' ? 'afterglow' : 'affectState', 'background', admission => attempt(paper, admission), {
      purpose: paper === 'wants' ? 'inner-wants' : 'inner-affect',
      connection: input.connection, dataEpoch: input.dataEpoch, shouldRecordSuccess: () => started[paper] !== undefined });
    break;
  }
  const final = (await loadInnerUpdateState())?.experience?.batch;
  if (final?.generationKey === activeBatch.generationKey) {
    if ((['wants', 'affect'] as const).some(paper => !answered(final, paper) && final[paper].attempts >= INTERNAL_PAPER_MAX_ATTEMPTS))
      await finish(final, 'skipped', 'shared-pair-skipped-after-three-attempts');
    else await commitPair(final);
  }
  return true;
}

/** The two existing paper entrypoints share this in-flight promise, not another scheduler. */
export function runAssistantSharedExperienceUpdate(input: AssistantInnerStateUpdateInput): Promise<boolean> {
  if (running) return running;
  const work = (async () => {
    let handled = false;
    for (;;) {
      const before = (await loadInnerUpdateState())?.experience?.batch;
      handled = await perform(input) || handled;
      const after = (await loadInnerUpdateState())?.experience?.batch;
      // Continue only this already-started long source. Never drain unrelated waiting episodes in a loop.
      if (!after?.segments || after.segments.index <= (before?.segments?.index ?? 0)
        || before && before.generationKey !== after.generationKey) return handled;
    }
  })().catch(async () => {
    if (canCommitBackupRestoreDataEpoch(input.dataEpoch)) {
      const state = await loadInnerUpdateState().catch(() => null);
      await appendAssistantLifeGenerationDiagnostic({ flow: 'wants', stage: 'local', attemptedAt: Date.now(),
        generationKey: state?.experience?.batch?.generationKey ?? 'experience-local', contextSource: 'afterglow',
        model: input.connection.model, status: 'failure', outputChars: 0, persistenceStatus: 'pending',
        responseFormatRequested: input.connection.chatJsonOutputEnabled === true,
        interruptionReason: 'shared-read-or-save-failed',
        requests: [{ paper: 'inner', status: 'not-started', reason: 'shared-read-or-save-failed', outputChars: 0 }],
      }).catch(() => undefined);
    }
    return true;
  }).finally(() => {
    if (running === work) running = undefined;
    void isJunluoWantsAwake().then(awake => awake
      ? import('../posts/baiyunPostReplyRuntime').then(runtime => runtime.drainPostReplies()) : undefined).catch(() => undefined);
  });
  running = work;
  return work;
}
