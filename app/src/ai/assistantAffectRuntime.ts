import { captureBackupRestoreDataEpoch, canCommitBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { resolveChatAfterglowCandidate, compareChatAfterglowPositions, type ChatAfterglowCandidate } from '../chat/chatAfterglowProbe';
import { initializeAffectBookmark, initializeSharedExperienceBookmark, loadAffectUpdateState, updateAffectUpdateState, finishAffectUpdateBatch,
  innerMaterialKey, loadInnerUpdateState, INNER_STATE_MIN_INTERVAL_MS, INTERNAL_PAPER_MAX_ATTEMPTS, INTERNAL_PAPER_RETRY_INTERVAL_MS,
  type InternalPaperRetry, type AffectUpdatePending, type AffectUpdateState } from '../chat/chatAfterglowState';
import { loadChatStateFast, loadChatSessionMessage, loadChatSessionMessageOrder, loadChatSessionMessagePage } from '../chat/chatStorage';
import { loadJunluoAffectState, updateJunluoAffectState } from '../life/junluoInnerStateStore';
import { applyJunluoAffectBasket } from '../life/junluoInnerStateGeneration';
import { isJunluoWantsAwake, isWantsClockOwner } from '../life/junluoDesireRuntime';
import { isAutomaticRemoteAiAllowed, loadAutomaticRemoteAiPolicy } from '../runtime/automaticRemoteAiPolicy';
import { loadAssistantState } from './assistantState';
import { isChatReplyInFlight } from './aiRuntimeScheduler';
import { runBudgetedAiCall } from './aiCallBudget';
import { buildNearStatusLifeMaterialSnapshot, collectAssistantSchedule, hasConsumedLifeMaterial, lifeMaterialSourceRevision, nearStatusLifeSourcesMatch } from './lifeMaterialHub';
import { formatNearStatusLifeEntries, selectNearStatusLifeEntries } from './nearStatusLifeMaterialFormat';
import { generateAssistantAffect } from './assistantAffectGenerator';
import { ASSISTANT_INTERNAL_PAPER_REQUEST_TIMEOUT_MS } from './assistantLifeShortJsonRequest';
import { appendAssistantLifeGenerationDiagnostic, recordAssistantLifeTransport, updateAssistantLifePersistenceDiagnostic } from './assistantLifeGenerationDiagnostics';
import type { AssistantInnerStateUpdateInput } from './assistantInnerStateRuntime';
import type { SubjectiveMessage } from './subjectiveMessages';
import { crossPageChatExclusions } from './assistantCrossPageExperience';
import { chatExperienceRevisionValue } from '../chat/chatPokeExperience';
import { hasReadPokeReply, loadUnreadPokeFacts, pokeMaterialRefs, pokeMaterialSourcesMatch, pruneReadPokeFacts } from '../chat/chatPokeMaterial';
import { loadCameraModelObservationInnerMaterials, cameraModelObservationInnerSourcesMatch,
  isCameraModelObservationMaterialId } from '../camera/cameraModelObservationInnerMaterial';
import { prepareMusicPlaybackMaterial, musicPlaybackMaterialRefs, musicPlaybackMaterialSourcesMatch,
  isMusicPlaybackMaterialId } from '../music/musicPlaybackMaterial';
import { readContactWaitingMessages, type ContactWaiting } from '../proactive/contactWaiting';

type AffectUpdateInput = AssistantInnerStateUpdateInput & {
  contactWaiting?: ContactWaiting;
  canRefreshContactWaiting?: () => Promise<boolean>;
};

export const AFFECT_LIFE_INTERVAL_MS = 30 * 60_000;
const operationId = (pending: AffectUpdatePending) => `${pending.generationKey}:affect`;
const refsFor = (candidate: ChatAfterglowCandidate<SubjectiveMessage> | null) => candidate?.messages.map(message => ({
  id: message.id, createdAt: message.createdAt, revision: innerMaterialKey(chatExperienceRevisionValue(message)),
})) ?? [];
const failureDelay = (state: AffectUpdateState, now: number) => now < (state.retry?.retryAfter ?? state.retryAfter ?? 0);

async function sourcesMatch(pending: Pick<AffectUpdatePending, 'sessionId' | 'refs' | 'lifeRefs' | 'pokeRefs' | 'contactWaiting'>) {
  if (pending.contactWaiting && !await readContactWaitingMessages(pending.contactWaiting)) return false;
  const messages: SubjectiveMessage[] = [];
  if (pending.sessionId) for (const ref of pending.refs) {
    const message = await loadChatSessionMessage(pending.sessionId, ref.id);
    if (!message || message.createdAt !== ref.createdAt || message.deliveryStatus === 'failed'
      || innerMaterialKey(chatExperienceRevisionValue(message)) !== ref.revision) return false;
    messages.push(message);
  }
  if (!await pokeMaterialSourcesMatch(pending.pokeRefs ?? [], messages, pending.sessionId)) return false;
  if (pending.lifeRefs.length) {
    const cameraRefs = pending.lifeRefs.filter(ref => isCameraModelObservationMaterialId(ref.id));
    if (!await cameraModelObservationInnerSourcesMatch(cameraRefs)) return false;
    if (!await musicPlaybackMaterialSourcesMatch(pending.lifeRefs.filter(ref => isMusicPlaybackMaterialId(ref.id)))) return false;
    const otherRefs = pending.lifeRefs.filter(ref => !isCameraModelObservationMaterialId(ref.id) && !isMusicPlaybackMaterialId(ref.id));
    if (otherRefs.length) {
      const life = await buildNearStatusLifeMaterialSnapshot(Date.now(), { includeAssistantSchedule: true });
      if (!await nearStatusLifeSourcesMatch(otherRefs, life.items, life.debug?.dropped)) return false;
    }
  }
  return true;
}

async function diagnostic(input: AssistantInnerStateUpdateInput, generationKey: string, reason: string) {
  await appendAssistantLifeGenerationDiagnostic({ attemptedAt: Date.now(), generationKey, contextSource: 'afterglow',
    flow: 'affect', stage: 'local', interruptionReason: reason,
    persistenceStatus: reason === 'local-save-failed' || reason === 'budget-record-save-failed' ? 'pending' : 'interrupted',
    model: input.connection.model, responseFormatRequested: input.connection.chatJsonOutputEnabled === true,
    status: 'failure', outputChars: 0,
    requests: [{ paper: 'inner', status: 'not-started', reason, outputChars: 0 }],
  }).catch(() => undefined);
}

// Only parsed fields while the existing pending journal is temporarily unavailable.
let unsaved: { epoch: number | null; pending: AffectUpdatePending } | undefined;

async function skipRetry(input: AssistantInnerStateUpdateInput, batch: InternalPaperRetry, reason: string) {
  const order = batch.sessionId ? await loadChatSessionMessageOrder(batch.sessionId) : [];
  await updateAffectUpdateState(input.dataEpoch, state => state.retry?.generationKey === batch.generationKey && !state.pending
    ? finishAffectUpdateBatch(state, { ...batch, lifeRefs: batch.materials.filter(ref => ref.kind !== 'poke'),
      pokeRefs: batch.materials.filter(ref => ref.kind === 'poke') }, Date.now(), order, 'skipped') : state);
  await diagnostic(input, batch.generationKey, reason);
}

async function failedAttempt(input: AssistantInnerStateUpdateInput, generationKey: string) {
  const saved = await updateAffectUpdateState(input.dataEpoch, state => state.retry?.generationKey === generationKey && !state.pending
    ? { ...state, retry: { ...state.retry, retryAfter: Date.now() + INTERNAL_PAPER_RETRY_INTERVAL_MS } } : state);
  if (saved?.retry?.generationKey === generationKey && saved.retry.attempts >= INTERNAL_PAPER_MAX_ATTEMPTS)
    await skipRetry(input, saved.retry, 'batch-skipped-after-three-attempts');
}

async function commitPending(input: AssistantInnerStateUpdateInput, pending: AffectUpdatePending,
  canProceed: () => Promise<boolean>, canCommit: () => boolean) {
  const valid = async () => await canProceed() && await sourcesMatch(pending) && canCommit();
  const discardChanged = async () => {
    if (!await canProceed() || await sourcesMatch(pending)) return;
    const applied = pending.applied || (await loadJunluoAffectState()).recentProcessedOperations.some(op => op.operationId === operationId(pending));
    // A choice already saved is a real state transition, even when the remaining
    // source-dependent work is discarded. Finish its clock notification first.
    if (applied && pending.affect?.relationshipChoice) {
      const synced = await updateJunluoAffectState(current => current, { dataEpoch: input.dataEpoch,
        shouldCommit: canProceed,
        relationshipChoiceOperationId: `${pending.generationKey}:relationship-choice:${pending.affect.relationshipChoice}` });
      if (!synced) return;
    }
    const order = pending.sessionId ? await loadChatSessionMessageOrder(pending.sessionId) : [];
    await updateAffectUpdateState(input.dataEpoch, state => {
      if (state.pending?.generationKey !== pending.generationKey) return state;
      if (applied) return finishAffectUpdateBatch(state, pending, Date.now(), order);
      const { pending: _pending, ...rest } = state;
      return rest;
    });
    await diagnostic(input, pending.generationKey, applied ? 'source-changed-after-save' : 'source-changed');
  };
  try {
    if (!await valid()) { await discardChanged(); return; }
    if (!pending.applied && pending.affect !== null) {
      const choice = pending.affect.relationshipChoice;
      const sleeping = !await isJunluoWantsAwake();
      const saved = await updateJunluoAffectState(state => applyJunluoAffectBasket({
        state, basket: pending.affect!, generationKey: pending.generationKey, now: Date.now(), sleeping,
      }), { dataEpoch: input.dataEpoch, shouldCommit: async () => await valid()
          && sleeping === !await isJunluoWantsAwake(),
        ...(choice ? { relationshipChoiceOperationId: `${pending.generationKey}:relationship-choice:${choice}` } : {}),
      });
      if (!saved?.recentProcessedOperations.some(op => op.operationId === operationId(pending))) { await discardChanged(); return; }
    }
    pending = { ...pending, applied: true };
    await updateAffectUpdateState(input.dataEpoch, state => state.pending?.generationKey === pending.generationKey && canCommit()
      ? { ...state, pending } : state);
    if (!await valid()) { await discardChanged(); return; }
    const order = pending.sessionId ? await loadChatSessionMessageOrder(pending.sessionId) : [];
    await updateAffectUpdateState(input.dataEpoch, state => state.pending?.generationKey === pending.generationKey && canCommit()
      ? finishAffectUpdateBatch(state, pending, Date.now(), order) : state);
    await updateAssistantLifePersistenceDiagnostic(pending.generationKey, { status: 'saved', savedParts: [] }).catch(() => undefined);
  } catch {
    await discardChanged();
    if (canCommit()) await diagnostic(input, pending.generationKey, 'local-save-failed');
  }
}

async function performWaiting(input: AffectUpdateInput, state: AffectUpdateState,
  canProceed: () => Promise<boolean>, canCommit: () => boolean) {
  const retry = state.retry;
  if (retry && !retry.contactWaiting) return;
  const waiting = retry?.contactWaiting ?? input.contactWaiting;
  if (!waiting) return;
  const messages = await readContactWaitingMessages(waiting);
  if (!messages) {
    if (retry) await skipRetry(input, retry, 'contact-wait-source-changed');
    return;
  }
  // A retry can be saved by the ordinary life tick, but only a due contact buys another request.
  if (!input.contactWaiting || !input.canRefreshContactWaiting) return;
  const now = input.now ?? Date.now();
  const cooling = (latest: AffectUpdateState, at: number) => at - (latest.lastAttemptAt ?? latest.generatedAt ?? latest.activatedAt) < AFFECT_LIFE_INTERVAL_MS;
  if (cooling(state, now) || !await isJunluoWantsAwake() || !await input.canRefreshContactWaiting()) return;
  if (retry && retry.attempts >= INTERNAL_PAPER_MAX_ATTEMPTS) {
    await skipRetry(input, retry, 'batch-skipped-after-three-attempts'); return;
  }
  const life = await buildNearStatusLifeMaterialSnapshot(now, { includeAssistantSchedule: true });
  const lifeItems = selectNearStatusLifeEntries(retry
    ? life.items.filter(item => retry.materials.some(ref => ref.id === item.id))
    : life.items.filter(item => item.occurredAt > state.activatedAt && !hasConsumedLifeMaterial(state.life[item.id], item)));
  const lifeRefs = retry ? retry.materials : lifeItems.map(item => ({ id: item.id, createdAt: item.occurredAt,
    revision: lifeMaterialSourceRevision(item) }));
  const source = { contactWaiting: waiting, refs: [], lifeRefs };
  if (!await sourcesMatch(source)) {
    if (retry) await skipRetry(input, retry, 'contact-wait-source-changed');
    return;
  }
  const generationKey = retry?.generationKey ?? `affect:contact-wait:${innerMaterialKey([waiting, now])}`;
  let startedAt: number | undefined;
  let generated: Awaited<ReturnType<typeof generateAssistantAffect>> | null = null;
  const result = await runBudgetedAiCall('affectState', 'background', async admission => {
    if (!await canProceed()) return null;
    return generated = await generateAssistantAffect({ ...input, contactWaiting: waiting,
      currentState: await loadAssistantState(), now, messages, lifeMaterial: formatNearStatusLifeEntries(lifeItems),
      onTransportAttempt: transport => { void recordAssistantLifeTransport({ flow: 'affect', generationKey,
        requestId: `${generationKey}:request:${(retry?.attempts ?? 0) + 1}`, attemptOrdinal: (retry?.attempts ?? 0) + 1,
        contextSource: 'afterglow', model: input.connection.model,
        responseFormatRequested: input.connection.chatJsonOutputEnabled === true }, transport); },
      onRequestStart: assertTransportReady => admission.beforeTransport(async () => {
        if (!await canProceed() || !await isJunluoWantsAwake() || !await input.canRefreshContactWaiting!()
          || !await sourcesMatch(source)) throw Error('contact-wait-no-longer-due');
        const at = Date.now();
        let claimed = false;
        const saved = await updateAffectUpdateState(input.dataEpoch, latest => {
          if (latest.pending || failureDelay(latest, at) || cooling(latest, at) || !canCommit()
            || latest.retry?.generationKey !== retry?.generationKey) return latest;
          claimed = true;
          const batch: InternalPaperRetry = { contactWaiting: waiting, generationKey, attemptedAt: at,
            attempts: ((retry?.attempts ?? 0) + 1) as InternalPaperRetry['attempts'],
            retryAfter: at + ASSISTANT_INTERNAL_PAPER_REQUEST_TIMEOUT_MS + INTERNAL_PAPER_RETRY_INTERVAL_MS,
            refs: [], materials: lifeRefs.map(ref => ({ ...ref, kind: 'life' as const })) };
          return { ...latest, lastAttemptAt: at, retry: batch };
        });
        if (!claimed || saved?.lastAttemptAt !== at || !await canProceed()) throw Error('contact-wait-no-longer-due');
        startedAt = at;
      }, assertTransportReady),
    });
  }, { connection: input.connection, dataEpoch: input.dataEpoch, purpose: 'inner-affect',
    shouldRecordSuccess: () => startedAt !== undefined }).catch(async () => {
    await diagnostic(input, generationKey, 'budget-record-save-failed');
    return { ok: true as const, value: generated };
  });
  if (!result.ok || !result.value || startedAt === undefined) {
    if (startedAt !== undefined) await failedAttempt(input, generationKey);
    return;
  }
  const paper = result.value;
  await appendAssistantLifeGenerationDiagnostic({ ...paper.diagnostics, attemptedAt: startedAt, generationKey,
    flow: 'affect', stage: 'request', requestId: `${generationKey}:request:${(retry?.attempts ?? 0) + 1}`,
    attemptOrdinal: (retry?.attempts ?? 0) + 1, model: input.connection.model, contextSource: 'afterglow',
    status: paper.status, persistenceStatus: paper.status === 'success' ? 'pending' : 'interrupted',
    extraFields: paper.value?.issues, operationIds: paper.value ? [`${generationKey}:affect`] : [],
    requests: [{ ...paper.diagnostics, paper: 'inner', status: paper.status, reason: paper.reason }],
  }).catch(() => undefined);
  const sourcesUnchanged = paper.status === 'success' ? await sourcesMatch(source).catch(() => undefined) : false;
  if (paper.status !== 'success' || !paper.value || !await canProceed() || sourcesUnchanged === false) {
    await failedAttempt(input, generationKey); return;
  }
  const pending: AffectUpdatePending = { ...source, generationKey, attemptedAt: startedAt,
    affect: paper.value.affect, applied: false };
  unsaved = { epoch: input.dataEpoch, pending };
  const saved = await updateAffectUpdateState(input.dataEpoch, latest => !latest.pending && canCommit() ? { ...latest, pending } : latest);
  if (saved?.pending?.generationKey !== generationKey) return;
  unsaved = undefined;
  await commitPending(input, pending, canProceed, canCommit);
}

async function perform(input: AffectUpdateInput) {
  const now = input.now ?? Date.now();
  const canCommit = () => !input.signal?.aborted && !isChatReplyInFlight() && canCommitBackupRestoreDataEpoch(input.dataEpoch);
  const canProceed = async () => canCommit() && isAutomaticRemoteAiAllowed(await loadAutomaticRemoteAiPolicy())
    && canCommit();
  const initialized = await initializeAffectBookmark(now, input.dataEpoch);
  if (!initialized || !await canProceed()) return;
  if (unsaved?.epoch !== input.dataEpoch) unsaved = undefined;
  if (unsaved) {
    const pending = unsaved.pending;
    if (await sourcesMatch(pending)) {
      const saved = await updateAffectUpdateState(input.dataEpoch, state => !state.pending && canCommit() ? { ...state, pending } : state);
      if (saved?.pending?.generationKey !== pending.generationKey) return;
    }
    unsaved = undefined;
  }
  const state = await loadAffectUpdateState();
  if (!state || !await canProceed()) return;
  await pruneReadPokeFacts((await loadInnerUpdateState())?.materials.pokes, state.pokes, input.dataEpoch);
  if (state.pending) { await commitPending(input, state.pending, canProceed, canCommit); return; }
  if (!input.apiKey.trim() || failureDelay(state, now)) return;
  if (input.contactWaiting || state.retry?.contactWaiting) return performWaiting(input, state, canProceed, canCommit);
  const retry = state.retry;
  const sleepCatchup = !await isJunluoWantsAwake();
  const sleepCoolingDown = (current: AffectUpdateState, at: number) => sleepCatchup && !retry
    && input.sharedCatchupBefore === undefined && current.lastAttemptAt !== undefined
    && at - current.lastAttemptAt < INNER_STATE_MIN_INTERVAL_MS;
  if (sleepCoolingDown(state, now)) return;
  if (retry && retry.attempts >= INTERNAL_PAPER_MAX_ATTEMPTS) {
    await skipRetry(input, retry, 'batch-skipped-after-three-attempts'); return;
  }
  const { sessions } = await loadChatStateFast({ activeMessageLimit: 1 });
  const life = await buildNearStatusLifeMaterialSnapshot(now, { includeAssistantSchedule: true,
    sleepRefs: retry?.materials, excludeSharedExperience: !retry });
  if (life.debug?.dropped.length && retry) await nearStatusLifeSourcesMatch(retry.materials.filter(ref =>
    ref.kind === 'life' && !isCameraModelObservationMaterialId(ref.id) && !isMusicPlaybackMaterialId(ref.id)),
    life.items, life.debug.dropped);
  const retryWeb = retry?.materials.filter(ref => ref.kind === 'life'
    && (ref.id.startsWith('web-voyage:') || ref.id.startsWith('github-voyage:'))) ?? [];
  if (retry && retryWeb.length && !await nearStatusLifeSourcesMatch(retryWeb, life.items, life.debug?.dropped)) {
    await skipRetry(input, retry, 'batch-source-unavailable'); return;
  }
  const unreadLife = life.items.filter(item => item.occurredAt > state.activatedAt && !hasConsumedLifeMaterial(state.life[item.id], item));
  // Only a new saved result or schedule change buys a life opportunity; ordinary observations and edits do not.
  const independentLifeItems = selectNearStatusLifeEntries(unreadLife.filter(item =>
    item.affectResultAt !== undefined && item.affectResultAt > state.activatedAt
    && !Object.hasOwn(state.life, item.id)
    && (!sleepCatchup || ['co-reading', 'web-voyage', 'github-voyage'].includes(item.source))));
  const lifeDue = independentLifeItems.length > 0
    && (state.lastAttemptAt === undefined || now - state.lastAttemptAt >= AFFECT_LIFE_INTERVAL_MS);
  const camera = input.sharedCatchupBefore !== undefined && !retry ? []
    : await loadCameraModelObservationInnerMaterials({ now, activatedAt: state.activatedAt,
      read: state.life, refs: retry?.materials });
  const excluded = new Set<string>();
  const crossPageIds = await crossPageChatExclusions((await loadInnerUpdateState())?.experience);
  let capacityBlocked = false;
  while (await canProceed()) {
    const candidateInput = { bookmark: state, batch: retry, sessions, excludeSessionIds: excluded,
      isUsableMessage: (message: SubjectiveMessage) => !crossPageIds.has(message.id)
        && (!message.pokeInteraction || !hasReadPokeReply(state.pokes, message.pokeInteraction.id))
        && Boolean(message.content.trim()) && message.deliveryStatus !== 'failed',
      loadOrder: loadChatSessionMessageOrder, loadPage: loadChatSessionMessagePage,
      beforeAt: retry ? undefined : input.sharedCatchupBefore,
    };
    const sixRoundConversation = retry ? null : await resolveChatAfterglowCandidate({ ...candidateInput,
      minimumRounds: input.sharedCatchupBefore !== undefined || sleepCatchup ? 1 : 6 });
    const chatTriggered = sixRoundConversation !== null;
    if (!retry && !chatTriggered && (!lifeDue || input.sharedCatchupBefore !== undefined))
      return capacityBlocked ? 'capacity-blocked' as const : undefined;
    let conversation = sixRoundConversation
      ?? await resolveChatAfterglowCandidate({ ...candidateInput, minimumRounds: 1 });
    if (!retry && !chatTriggered && conversation && independentLifeItems.every(item =>
      item.source === 'assistant-schedule' && item.occurredAt > conversation!.messages.at(-1)!.createdAt)) {
      // A later real schedule change keeps its existing life opportunity without rewriting an older chat batch.
      conversation = null;
    }
    // A due life paper can carry the oldest complete chat rounds, but remains on
    // the life interval even when it carries chat. Six-round opportunities stay unchanged.
    const sleepLife = await collectAssistantSchedule(now, {
      sleepFrom: conversation?.messages[0]?.createdAt,
      sleepThrough: conversation?.messages.at(-1)?.createdAt ?? now,
      sleepRefs: retry?.materials });
    const sleepItems = sleepLife.filter(item => retry ? retry.materials.some(ref => ref.id === item.id)
      : !hasConsumedLifeMaterial(state.life[item.id], item));
    const lifeItems = retry ? selectNearStatusLifeEntries([...life.items.filter(item => item.source !== 'assistant-schedule'), ...sleepItems, ...camera]
      .filter(item => retry.materials.some(ref => ref.id === item.id)))
      : input.sharedCatchupBefore !== undefined ? [] : selectNearStatusLifeEntries([
        ...(chatTriggered ? unreadLife : independentLifeItems).filter(item => item.source !== 'assistant-schedule'), ...sleepItems, ...camera]);
    // A frozen retry without completed chat or a saved result waits for waking.
    if (sleepCatchup && !conversation && !lifeItems.some(item =>
      ['co-reading', 'web-voyage', 'github-voyage'].includes(item.source)
      && item.affectResultAt !== undefined && item.affectResultAt > state.activatedAt
      && !Object.hasOwn(state.life, item.id))) return;
    if (!retry && !chatTriggered && !lifeItems.some(item => item.affectResultAt !== undefined
      && item.affectResultAt > state.activatedAt && !Object.hasOwn(state.life, item.id))) return;
    if (retry && !conversation && !lifeItems.length) {
      await skipRetry(input, retry, 'batch-source-unavailable'); return;
    }
    const baseLifeRefs = lifeItems.map(item => ({ id: item.id, createdAt: item.occurredAt, revision: lifeMaterialSourceRevision(item) }));
    let lifeRefs = baseLifeRefs;
    const refs = refsFor(conversation);
    const pokeFacts = await loadUnreadPokeFacts({ sessionId: conversation?.sessionId,
      through: conversation?.messages.at(-1)?.createdAt ?? now, activatedAt: state.activatedAt,
      read: state.pokes, refs: retry?.materials.filter(ref => ref.kind === 'poke'), dataEpoch: input.dataEpoch });
    const pokeRefs = pokeMaterialRefs(conversation?.messages ?? [], pokeFacts);
    const generationKey = retry?.generationKey ?? `affect:${state.activatedAt}:${innerMaterialKey([conversation?.sessionId, refs, lifeRefs, ...(pokeRefs.length ? [pokeRefs] : [])])}`;
    const music = input.sharedCatchupBefore !== undefined ? [] : await prepareMusicPlaybackMaterial({
      from: conversation?.messages[0]?.createdAt ?? state.generatedAt ?? state.activatedAt,
      through: conversation?.messages.at(-1)?.createdAt ?? now, read: state.life,
      refs: retry?.materials.filter(ref => isMusicPlaybackMaterialId(ref.id)),
    });
    let startedAt: number | undefined;
    let generated: Awaited<ReturnType<typeof generateAssistantAffect>> | null = null;
    const result = await runBudgetedAiCall('affectState', 'background', async admission => {
      if (!await canProceed()) return null;
      return generated = await generateAssistantAffect({ ...input, currentState: await loadAssistantState(), now,
        onTransportAttempt: transport => { void recordAssistantLifeTransport({ flow: 'affect', generationKey,
          requestId: `${generationKey}:request:${(retry?.attempts ?? 0) + 1}`, attemptOrdinal: (retry?.attempts ?? 0) + 1,
          contextSource: conversation ? 'afterglow' : 'state', model: input.connection.model,
          responseFormatRequested: input.connection.chatJsonOutputEnabled === true }, transport); },
        messages: conversation?.messages ?? [], pokeFacts, lifeMaterial: formatNearStatusLifeEntries(lifeItems),
        music, onMusicSelected: events => {
          lifeRefs = [...baseLifeRefs, ...musicPlaybackMaterialRefs(events).map(({ id, createdAt, revision }) => ({ id, createdAt, revision }))];
        },
        onRequestStart: assertTransportReady => admission.beforeTransport(async () => {
          if (sleepCatchup !== !await isJunluoWantsAwake()) throw new Error('affect-cancelled');
          if (!await canProceed() || !await sourcesMatch({ sessionId: conversation?.sessionId, refs, lifeRefs, pokeRefs })) throw new Error('affect-cancelled');
          const at = Date.now();
          let claimed = false;
          const saved = await updateAffectUpdateState(input.dataEpoch, latest => {
            if (latest.pending || failureDelay(latest, at) || sleepCoolingDown(latest, at) || !canCommit()
              || latest.retry?.generationKey !== retry?.generationKey
              || (latest.retry?.attempts ?? 0) >= INTERNAL_PAPER_MAX_ATTEMPTS
              || !retry && !chatTriggered && latest.lastAttemptAt !== undefined && at - latest.lastAttemptAt < AFFECT_LIFE_INTERVAL_MS) return latest;
            const end = conversation?.messages.reduce((last, message) => compareChatAfterglowPositions(message, last) > 0 ? message : last);
            const batch: InternalPaperRetry = {
              generationKey, attemptedAt: at,
              attempts: ((latest.retry?.attempts ?? 0) + 1) as InternalPaperRetry['attempts'],
              retryAfter: at + ASSISTANT_INTERNAL_PAPER_REQUEST_TIMEOUT_MS + INTERNAL_PAPER_RETRY_INTERVAL_MS,
              ...(latest.retry?.sessionId ? { sessionId: latest.retry.sessionId, end: latest.retry.end }
                : conversation && end ? { sessionId: conversation.sessionId, end: { id: end.id, createdAt: end.createdAt } } : {}),
              refs: latest.retry?.refs.map(ref => refs.find(item => item.id === ref.id) ?? ref) ?? refs,
              materials: latest.retry?.materials.filter(ref => !isMusicPlaybackMaterialId(ref.id)
                || lifeRefs.some(item => item.id === ref.id)).map(ref => ({ ...ref,
                ...((ref.kind === 'poke' ? pokeRefs : lifeRefs).find(item => item.id === ref.id) ?? {}) }))
                ?? [...lifeRefs.map(ref => ({ ...ref, kind: 'life' as const })), ...pokeRefs],
            };
            claimed = true;
            const { retryAfter: _legacyDelay, ...rest } = latest;
            return { ...rest, lastAttemptAt: at, retry: batch };
          });
          if (!claimed || saved?.lastAttemptAt !== at || !await canProceed()) throw new Error('affect-no-longer-due');
          startedAt = at;
        }, assertTransportReady),
      });
    }, { connection: input.connection, dataEpoch: input.dataEpoch, purpose: 'inner-affect', shouldRecordSuccess: () => startedAt !== undefined })
      .catch(async () => {
        await diagnostic(input, generationKey, 'budget-record-save-failed');
        return { ok: true as const, value: generated };
      });
    if (!result.ok || !result.value) {
      if (startedAt !== undefined) await failedAttempt(input, generationKey);
      return;
    }
    const paper = result.value;
    if (startedAt === undefined) {
      if (paper.reason === 'context-too-long') {
        capacityBlocked = true;
        await diagnostic(input, generationKey, 'context-too-long');
        if (conversation && !retry) { excluded.add(conversation.sessionId); continue; }
      }
      return;
    }
    if (!canCommit()) {
      await diagnostic(input, generationKey, 'result-no-longer-current');
      await failedAttempt(input, generationKey); return;
    }
    await appendAssistantLifeGenerationDiagnostic({ ...paper.diagnostics, attemptedAt: startedAt, generationKey,
      flow: 'affect', stage: 'request', requestId: `${generationKey}:request:${(retry?.attempts ?? 0) + 1}`,
      attemptOrdinal: (retry?.attempts ?? 0) + 1,
      model: input.connection.model, contextSource: conversation ? 'afterglow' : 'state', status: paper.status,
      extraFields: paper.value?.issues,
      persistenceStatus: paper.status === 'success' ? 'pending' : 'interrupted',
      operationIds: paper.value ? [`${generationKey}:affect`] : [],
      requests: [{ ...paper.diagnostics, paper: 'inner', status: paper.status, reason: paper.reason }],
    }).catch(() => undefined);
    // Unknown source availability may be journaled, never adopted until commitPending revalidates it.
    const sourcesUnchanged = paper.status === 'success'
      ? await sourcesMatch({ sessionId: conversation?.sessionId, refs, lifeRefs, pokeRefs }).catch(() => undefined) : false;
    if (paper.status !== 'success' || !paper.value || !await canProceed() || sourcesUnchanged === false) {
      if (paper.status === 'success') await diagnostic(input, generationKey, 'result-no-longer-current');
      await failedAttempt(input, generationKey); return;
    }
    const end = conversation?.messages.reduce((last, message) => compareChatAfterglowPositions(message, last) > 0 ? message : last);
    const pending: AffectUpdatePending = { generationKey, attemptedAt: startedAt, refs, lifeRefs,
      ...(pokeRefs.length ? { pokeRefs: pokeRefs.map(({ id, createdAt, revision }) => ({ id, createdAt, revision })) } : {}),
      ...(conversation && end ? { sessionId: conversation.sessionId, end: { id: end.id, createdAt: end.createdAt } } : {}),
      affect: paper.value.affect, applied: false,
    };
    unsaved = { epoch: input.dataEpoch, pending };
    const saved = await updateAffectUpdateState(input.dataEpoch, latest => !latest.pending && canCommit() ? { ...latest, pending } : latest);
    if (saved?.pending?.generationKey !== generationKey) return;
    unsaved = undefined;
    await commitPending(input, pending, canProceed, canCommit);
    return;
  }
}

let running: Promise<void> | undefined;
export function runAssistantAffectUpdate(input?: AffectUpdateInput): Promise<void> {
  if (running) return running;
  const work = (async () => {
    if (!isWantsClockOwner()) return;
    if (!input) {
      const epoch = captureBackupRestoreDataEpoch();
      await initializeAffectBookmark(Date.now(), epoch);
      await initializeSharedExperienceBookmark(Date.now(), epoch);
      if (isChatReplyInFlight() || !isAutomaticRemoteAiAllowed(await loadAutomaticRemoteAiPolicy())) return;
      const { loadAiConfigPreferencesSnapshot, resolveLifeCreativeConfig } = await import('./AiConfigPreferences');
      const config = await loadAiConfigPreferencesSnapshot();
      const resolved = resolveLifeCreativeConfig(config);
      if (!resolved.connection || !resolved.apiKey?.trim()) return;
      input = { apiKey: resolved.apiKey, connection: resolved.connection, profile: config.profile,
        currentState: await loadAssistantState(), dataEpoch: epoch };
    }
    if (!input.contactWaiting && await (await import('./assistantSharedExperienceRuntime')).runAssistantSharedExperienceUpdate(input)) return;
    await perform(input);
  })().catch(() => undefined).finally(() => { if (running === work) running = undefined; });
  running = work;
  return work;
}

export const resumeAffectBeforeSharedExperience = perform;
