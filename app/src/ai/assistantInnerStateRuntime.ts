import { canCommitBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { resolveChatAfterglowCandidate, trimChatAfterglowCandidate, formatChatAfterglowMessageTime, formatChatAfterglowConversation, compareChatAfterglowPositions, type ChatAfterglowCandidate } from '../chat/chatAfterglowProbe';
import { chatExperienceRevisionValue } from '../chat/chatPokeExperience';
import { prepareFirstPaperChat, firstPaperMessageRevision, reloadChatSupplement } from '../chat/firstPaperChatMaterial';
import { hasReadPokeReply, loadUnreadPokeFacts, pokeMaterialRefs, pokeMaterialSourcesMatch, pruneReadPokeFacts } from '../chat/chatPokeMaterial';
import { finishInnerUpdateBatch, initializeInnerUpdateBookmark, innerMaterialKey, INNER_STATE_MIN_INTERVAL_MS,
  INTERNAL_PAPER_MAX_ATTEMPTS, INTERNAL_PAPER_RETRY_INTERVAL_MS,
  loadInnerUpdateState, updateInnerUpdateState, type InnerUpdatePending, type InnerUpdateState,
  type InternalPaperRetry, type ChatSupplement } from '../chat/chatAfterglowState';
import { loadChatSessionMessage, loadChatSessionMessageOrder, loadChatSessionMessagePage, loadChatStateFast } from '../chat/chatStorage';
import { loadJunluoDesireState, updateJunluoDesireState } from '../life/junluoInnerStateStore';
import { applyJunluoWants } from '../life/junluoDesireMetabolism';
import { isJunluoWantsAwake, isWantsClockOwner, refreshJunluoDesireClock } from '../life/junluoDesireRuntime';
import type { AssistantState } from './assistantState';
import { getTheaterBackstageContext, type SubjectiveMessage } from './subjectiveMessages';
import { generateAssistantWants } from './assistantStateGenerator';
import { ASSISTANT_INTERNAL_PAPER_REQUEST_TIMEOUT_MS } from './assistantLifeShortJsonRequest';
import { prepareWantsMaterial, wantsMaterialSourcesMatch } from './assistantWantsMaterial';
import { prepareMusicPlaybackMaterial, musicPlaybackMaterialRefs, musicPlaybackMaterialSourcesMatch,
  isMusicPlaybackMaterialId } from '../music/musicPlaybackMaterial';
import { crossPageChatExclusions } from './assistantCrossPageExperience';
import { prepareNearbyOutingMaterial, selectNearbyOutingMaterial, appendNearbyOutingMaterial,
  isNearbyOutingMaterialId, nearbyOutingSourcesMatch } from '../nearby/nearbyOutingMaterial';
import { appendAssistantLifeGenerationDiagnostic, recordAssistantLifeTransport, updateAssistantLifePersistenceDiagnostic } from './assistantLifeGenerationDiagnostics';
import type { AssistantLifeGenerationFailureReason } from './assistantLifeGenerationShared';
import { runBudgetedAiCall } from './aiCallBudget';
import { isChatReplyInFlight } from './aiRuntimeScheduler';
import { isAutomaticRemoteAiAllowed, loadAutomaticRemoteAiPolicy } from '../runtime/automaticRemoteAiPolicy';
import type { AiConnection, AiProfile } from './types';

export type AssistantInnerStateUpdateInput = {
  apiKey: string; connection: AiConnection; currentState: AssistantState; dataEpoch: number | null;
  profile?: AiProfile; now?: number; signal?: AbortSignal;
  /** Only the shared-activity bridge may finish older, incomplete-sized chat batches. */
  sharedCatchupBefore?: number;
};
const operationId = (pending: InnerUpdatePending) => `${pending.generationKey}:wants`;
type FixedSources = Pick<InternalPaperRetry, 'generationKey' | 'sessionId' | 'refs' | 'materials' | 'chatSupplement'>;
function sameBatch(left: FixedSources | undefined, right: FixedSources | undefined) {
  if (!left || !right) return left === right;
  if (left.generationKey !== right.generationKey) return false;
  if (!left.chatSupplement && !right.chatSupplement
    && ![...left.materials, ...right.materials].some(ref => isNearbyOutingMaterialId(ref.id))) return true;
  const sources = (batch: FixedSources) => [batch.sessionId, batch.refs, batch.materials, batch.chatSupplement];
  return innerMaterialKey(sources(left)) === innerMaterialKey(sources(right));
}
const isCoolingDown = (state: InnerUpdateState, now: number) =>
  state.retry ? now < state.retry.retryAfter
    : state.lastAttemptAt !== undefined && now - state.lastAttemptAt < INNER_STATE_MIN_INTERVAL_MS;
function sourceRefs(candidate: ChatAfterglowCandidate<SubjectiveMessage> | null, partitioned = false) {
  return candidate?.messages.map(message => ({ id: message.id, createdAt: message.createdAt,
    revision: partitioned ? firstPaperMessageRevision(message) : innerMaterialKey(chatExperienceRevisionValue(message)) })) ?? [];
}
async function sourcesMatch(pending: Pick<InnerUpdatePending, 'sessionId' | 'refs' | 'materials' | 'chatSupplement'>) {
  const messages: SubjectiveMessage[] = [];
  if (pending.sessionId) {
    const loaded = await Promise.all(pending.refs.map(ref => loadChatSessionMessage(pending.sessionId!, ref.id)));
    if (!loaded.every((message, i) => message && message.createdAt === pending.refs[i].createdAt
      && message.deliveryStatus !== 'failed'
      && (pending.chatSupplement ? firstPaperMessageRevision(message)
        : innerMaterialKey(chatExperienceRevisionValue(message))) === pending.refs[i].revision)) return false;
    messages.push(...loaded as SubjectiveMessage[]);
  }
  return await reloadChatSupplement(pending.chatSupplement, loadChatSessionMessage)
    && await pokeMaterialSourcesMatch(pending.materials.filter(ref => ref.kind === 'poke'), messages, pending.sessionId)
    && await musicPlaybackMaterialSourcesMatch(pending.materials.filter(ref => isMusicPlaybackMaterialId(ref.id)))
    && await nearbyOutingSourcesMatch(pending.materials)
    && await wantsMaterialSourcesMatch(pending.materials.filter(ref => ref.kind !== 'poke'
      && !isMusicPlaybackMaterialId(ref.id) && !isNearbyOutingMaterialId(ref.id)));
}
async function recordLocalFailure(input: AssistantInnerStateUpdateInput, generationKey: string, reason: string) {
  await appendAssistantLifeGenerationDiagnostic({
    flow: 'wants', stage: 'local', interruptionReason: reason,
    persistenceStatus: reason === 'local-save-failed' || reason === 'budget-record-save-failed' ? 'pending' : 'interrupted',
    attemptedAt: Date.now(), contextSource: 'afterglow', generationKey, model: input.connection.model.trim(),
    responseFormatRequested: input.connection.chatJsonOutputEnabled === true, status: 'failure', outputChars: 0,
    requests: [{ paper: 'inner', status: 'not-started', reason, outputChars: 0 }],
  }).catch(() => undefined);
}
// Parsed values only, retained if the existing pending journal itself could not be saved.
let unsavedResult: { epoch: number | null; pending: InnerUpdatePending } | undefined;

async function skipRetry(input: AssistantInnerStateUpdateInput, batch: InternalPaperRetry, reason: string) {
  const order = batch.sessionId ? await loadChatSessionMessageOrder(batch.sessionId) : [];
  const supplementOrder = batch.chatSupplement ? await loadChatSessionMessageOrder(batch.chatSupplement.sessionId) : [];
  await updateInnerUpdateState(input.dataEpoch, state => state && sameBatch(state.retry, batch) && !state.pending
    ? finishInnerUpdateBatch(state, { ...batch, source: batch.sessionId ? 'afterglow' : 'life',
      materialKey: innerMaterialKey([batch.sessionId, batch.refs, batch.materials]) }, Date.now(), order, 'skipped', supplementOrder) : state);
  await recordLocalFailure(input, batch.generationKey, reason);
}

async function failedAttempt(input: AssistantInnerStateUpdateInput, batch: FixedSources) {
  const failedKey = batch.generationKey;
  const saved = await updateInnerUpdateState(input.dataEpoch, state => state?.retry && sameBatch(state.retry, batch) && !state.pending
    ? { ...state, retry: { ...state.retry, retryAfter: Date.now() + INTERNAL_PAPER_RETRY_INTERVAL_MS } } : state);
  if (saved?.retry?.generationKey === failedKey && saved.retry.attempts >= INTERNAL_PAPER_MAX_ATTEMPTS)
    await skipRetry(input, saved.retry, 'batch-skipped-after-three-attempts');
}

async function commitPending(input: AssistantInnerStateUpdateInput, pending: InnerUpdatePending,
  canProceed: () => Promise<boolean>, canCommit: () => boolean) {
  const stillValid = async () => await canProceed() && sameBatch((await loadInnerUpdateState())?.pending, pending)
    && await sourcesMatch(pending) && canCommit();
  const discardChanged = async () => {
    if (!canCommit() || await sourcesMatch(pending)) return;
    const applied = pending.applied || (await loadJunluoDesireState()).recentProcessedOperations
      .some(operation => operation.operationId === operationId(pending));
    const order = pending.sessionId ? await loadChatSessionMessageOrder(pending.sessionId) : [];
    const supplementOrder = pending.chatSupplement ? await loadChatSessionMessageOrder(pending.chatSupplement.sessionId) : [];
    await updateInnerUpdateState(input.dataEpoch, state => {
      if (!state || !sameBatch(state.pending, pending) || !canCommit()) return state;
      if (applied) return finishInnerUpdateBatch(state, pending, Date.now(), order, 'saved', supplementOrder);
      const { pending: _pending, ...next } = state;
      return next;
    });
    await recordLocalFailure(input, pending.generationKey, applied ? 'source-changed-after-save' : 'source-changed');
  };
  try {
    if (!await stillValid()) { await discardChanged(); return; }
    if (!pending.applied) {
      const refreshed = await refreshJunluoDesireClock();
      const sleeping = !await isJunluoWantsAwake();
      if (refreshed?.clock.context?.awake !== !sleeping) return;
      const saved = await updateJunluoDesireState(current => current.clock.context?.awake !== !sleeping ? current : applyJunluoWants({
        state: current, changes: pending.wants ?? [], now: Date.now(), operationId: operationId(pending),
        allowSleepingSettlement: true,
      }), { dataEpoch: input.dataEpoch, shouldCommit: async () => await stillValid()
        && sleeping === !await isJunluoWantsAwake() });
      if (!saved?.recentProcessedOperations.some(operation => operation.operationId === operationId(pending))) return;
    }
    pending = { ...pending, applied: true };
    await updateInnerUpdateState(input.dataEpoch, state => state && sameBatch(state.pending, pending) && canCommit()
      ? { ...state, pending } : state);
    if (!await stillValid()) { await discardChanged(); return; }
    const order = pending.sessionId ? await loadChatSessionMessageOrder(pending.sessionId) : [];
    const supplementOrder = pending.chatSupplement ? await loadChatSessionMessageOrder(pending.chatSupplement.sessionId) : [];
    await updateInnerUpdateState(input.dataEpoch, state => state && sameBatch(state.pending, pending) && canCommit()
      ? finishInnerUpdateBatch(state, pending, Date.now(), order, 'saved', supplementOrder) : state);
    await updateAssistantLifePersistenceDiagnostic(pending.generationKey, { status: 'saved', savedParts: [] }).catch(() => undefined);
  } catch {
    await discardChanged();
    if (canCommit()) await recordLocalFailure(input, pending.generationKey, 'local-save-failed');
  }
}
async function performInnerStateUpdate(input: AssistantInnerStateUpdateInput) {
  if (!isWantsClockOwner()) return;
  const now = input.now ?? Date.now();
  const canCommit = () => !input.signal?.aborted && !isChatReplyInFlight() && canCommitBackupRestoreDataEpoch(input.dataEpoch);
  const canProceed = async () => canCommit() && isAutomaticRemoteAiAllowed(await loadAutomaticRemoteAiPolicy())
    && canCommit();
  // Establish the activation cursor independently of policy and sleep.
  const state = await initializeInnerUpdateBookmark(now, input.dataEpoch);
  await refreshJunluoDesireClock(now);
  if (!state || !await canProceed()) return;
  if (unsavedResult && unsavedResult.epoch !== input.dataEpoch) unsavedResult = undefined;
  if (unsavedResult) {
    const retained = unsavedResult.pending;
    if (await sourcesMatch(retained)) {
      const saved = await updateInnerUpdateState(input.dataEpoch, current =>
        current && !current.pending && ((!retained.chatSupplement
          && !retained.materials.some(ref => isNearbyOutingMaterialId(ref.id)))
          || sameBatch(current.retry, retained)) && canCommit()
          ? { ...current, pending: retained } : current);
      if (!sameBatch(saved?.pending, retained)) { unsavedResult = undefined; return; }
    }
    unsavedResult = undefined;
  }
  const latest = await loadInnerUpdateState();
  if (!latest || !await canProceed()) return;
  await pruneReadPokeFacts(latest.materials.pokes, latest.affect?.pokes, input.dataEpoch);
  if (latest.pending) { await commitPending(input, latest.pending, canProceed, canCommit); return; }
  if (!input.apiKey.trim()) return;
  if (isCoolingDown(latest, now) && (input.sharedCatchupBefore === undefined || latest.retry)) return;
  const retry = latest.retry;
  // A restored voyage batch must keep its original complete source version.
  // Never replace an old/changed reference with today's page before retrying.
  const webRetryRefs = retry?.materials.filter(ref => ref.kind === 'life'
    && (ref.id.startsWith('web-voyage:') || ref.id.startsWith('github-voyage:'))) ?? [];
  if (retry && webRetryRefs.length && !await wantsMaterialSourcesMatch(webRetryRefs)) {
    await skipRetry(input, retry, 'batch-source-unavailable'); return;
  }
  if (retry && (retry.chatSupplement || retry.materials.some(ref => isNearbyOutingMaterialId(ref.id))) && !await sourcesMatch(retry)) {
    await skipRetry(input, retry, 'batch-source-unavailable'); return;
  }
  const sleepCatchup = !await isJunluoWantsAwake();
  // Keep the frozen source set: an unrequested dream batch waits for waking.
  if (sleepCatchup && retry?.materials.some(ref => ref.kind === 'dream')) return;
  if (retry && retry.attempts >= INTERNAL_PAPER_MAX_ATTEMPTS) {
    await skipRetry(input, retry, 'batch-skipped-after-three-attempts'); return;
  }
  const { sessions } = await loadChatStateFast({ activeMessageLimit: 1 });
  const excludeSessionIds = new Set<string>();
  const crossPageIds = await crossPageChatExclusions(latest.experience);
  let capacityBlocked = false;
  while (await canProceed()) {
    let conversation = await resolveChatAfterglowCandidate({
      bookmark: latest, batch: retry, loadOrder: loadChatSessionMessageOrder,
      beforeAt: retry ? undefined : input.sharedCatchupBefore,
      isUsableMessage: message => !crossPageIds.has(message.id)
        && (!message.pokeInteraction || !hasReadPokeReply(latest.materials.pokes, message.pokeInteraction.id)),
      loadPage: (sessionId, options) => loadChatSessionMessagePage(sessionId, options), sessions, excludeSessionIds,
    });
    const pokeFacts = await loadUnreadPokeFacts({ sessionId: conversation?.sessionId,
      through: conversation?.messages.at(-1)?.createdAt ?? now, activatedAt: latest.activatedAt,
      read: latest.materials.pokes, refs: retry?.materials.filter(ref => ref.kind === 'poke'), dataEpoch: input.dataEpoch });
    const originalConversation = conversation;
    const baseMaterialForRounds = input.sharedCatchupBefore !== undefined && !retry
      ? () => ({ text: '', refs: [], conversation: undefined, renderConversation: undefined, hasOpportunity: !!conversation, lifeEntries: [] })
      : await prepareWantsMaterial({ state: latest, sessionId: conversation?.sessionId,
        rounds: conversation?.rounds, now, batchMaterials: retry?.materials.filter(ref => !isNearbyOutingMaterialId(ref.id)), pokeFacts, sleepCatchup });
    const materialForRounds = (count: number, omittedChat?: { sessionId: string; messageIds: ReadonlySet<string> }) => {
      const base = baseMaterialForRounds(count, omittedChat);
      const messages = originalConversation?.rounds.slice(0, count).flat() ?? [];
      const facts = pokeFacts.filter(fact => fact.pokedAt <= (messages.at(-1)?.createdAt ?? -Infinity));
      const pokes = pokeMaterialRefs(messages, facts);
      return { ...base, refs: [...base.refs, ...pokes],
        conversation: base.conversation ?? (pokes.length || messages.some(message => getTheaterBackstageContext(message))
          ? formatChatAfterglowConversation(messages, facts) : undefined) };
    };
    let selectedMaterial = materialForRounds(conversation?.rounds.length ?? 0);
    if (!conversation && !selectedMaterial.hasOpportunity) {
      if (sleepCatchup) return;
      if (retry) await skipRetry(input, retry, 'batch-source-unavailable');
      return capacityBlocked ? 'capacity-blocked' as const : undefined;
    }
    // The ordinary opportunity is already established. An old retry keeps its old input contract.
    const chat = !retry || retry.chatSupplement ? await prepareFirstPaperChat({ bookmark: latest, sessions,
      conversation, throughAt: conversation?.messages.at(-1)?.createdAt ?? now, excludeIds: crossPageIds,
      loadOrder: loadChatSessionMessageOrder, loadMessage: loadChatSessionMessage, frozen: retry?.chatSupplement }) : undefined;
    let supplementCount = chat?.maxSupplementCount ?? 0;
    let selectedRoundCount = conversation?.rounds.length ?? 0;
    let chatSupplement: ChatSupplement | undefined = chat?.select(selectedRoundCount, supplementCount).chatSupplement;
    const source = conversation ? 'afterglow' : 'life';
    let requestedRefs = sourceRefs(conversation, !!chatSupplement);
    let materialKey = innerMaterialKey([conversation?.sessionId, requestedRefs, selectedMaterial.refs]);
    const generationKey = retry?.generationKey ?? (conversation
      ? `inner:chat:${latest.activatedAt}:${conversation.sessionId}:${conversation.messages[0].id}`
      : `inner:life:${materialKey}`);
    const postLookKind = sleepCatchup ? undefined : await import('../posts/baiyunPostReplyRuntime')
      .then(runtime => runtime.preparePostLookPaper({ key: generationKey, lane: 'inner', dataEpoch: input.dataEpoch }))
      .catch(() => undefined);
    // Background only: the ordinary opportunity and stable batch identity above
    // are decided without music. Shared-experience catch-up keeps its old input.
    const music = input.sharedCatchupBefore !== undefined ? [] : await prepareMusicPlaybackMaterial({
      from: conversation?.messages[0]?.createdAt ?? latest.generatedAt ?? latest.materials.activatedAt,
      through: conversation?.messages.at(-1)?.createdAt ?? now,
      read: latest.materials.life,
      refs: retry?.materials.filter(ref => isMusicPlaybackMaterialId(ref.id)),
    });
    const outings = await prepareNearbyOutingMaterial({ through: conversation?.messages.at(-1)?.createdAt ?? now,
      activatedAt: latest.materials.activatedAt, read: latest.materials.life, refs: retry?.materials });
    const outingForRounds = (count: number, extras: number, limit: number) => {
      const supplement = chat?.select(count, extras).chatSupplement;
      const providedChat = [
        ...(originalConversation ? [{ sessionId: originalConversation.sessionId,
          messageIds: new Set(originalConversation.rounds.slice(0, count).flat().map(message => message.id)) }] : []),
        ...(supplement ? [{ sessionId: supplement.sessionId,
          messageIds: new Set([...supplement.unreadRefs, ...supplement.backgroundRefs].map(ref => ref.id)) }] : []),
      ];
      return selectNearbyOutingMaterial({ segments: outings, limit,
        through: originalConversation?.rounds.slice(0, count).flat().at(-1)?.createdAt ?? now,
        lifeEntries: materialForRounds(count).lifeEntries, providedChat });
    };
    let startedAt: number | undefined;
    let claimedBatch: InternalPaperRetry | undefined;
    const attemptOrdinal = (retry?.attempts ?? 0) + 1;
    const requestId = `${generationKey}:request:${attemptOrdinal}`;
    let generated: Awaited<ReturnType<typeof generateAssistantWants>> | null = null;
    const result = await runBudgetedAiCall('afterglow', 'background', async admission => {
      if (!await canProceed()) return null;
      return generated = await generateAssistantWants({
        ...input, source, postLookKind,
        onTransportAttempt: transport => { void recordAssistantLifeTransport({ flow: 'wants', requestId, attemptOrdinal,
          generationKey, contextSource: source === 'afterglow' ? 'afterglow' : 'state', model: input.connection.model,
          responseFormatRequested: input.connection.chatJsonOutputEnabled === true }, transport); },
        conversationRounds: conversation?.rounds.map(round => round.map(message => ({ role: message.role,
          content: message.content, time: formatChatAfterglowMessageTime(message.createdAt) }))),
        chatSupplementCount: supplementCount, fixedChatSelection: !!retry?.chatSupplement
          || !!retry?.materials.some(ref => isNearbyOutingMaterialId(ref.id)), outingCount: Math.min(6, outings.length),
        materialForRounds: (count, extras = supplementCount, outingCount = outings.length) => {
          const selected = chat?.select(count, extras).chatSupplement;
          const base = materialForRounds(count, selected ? { sessionId: selected.sessionId,
            messageIds: new Set([...selected.unreadRefs, ...selected.backgroundRefs].map(ref => ref.id)) } : undefined);
          const text = appendNearbyOutingMaterial(base.text, base.lifeEntries ?? [], outingForRounds(count, extras, outingCount).entries);
          return chat ? { ...base, text, conversation: chat.select(count, extras, base.renderConversation ?? base.conversation,
            pokeFacts.filter(fact => fact.pokedAt <= (originalConversation?.rounds.slice(0, count).flat().at(-1)?.createdAt ?? now))).conversation } : { ...base, text };
        },
        musicForRounds: count => {
          const through = originalConversation?.rounds.slice(0, count).flat().at(-1)?.createdAt ?? now;
          return music.filter(event => event.createdAt <= through);
        },
        onConversationSelected: count => {
          selectedRoundCount = count;
          if (conversation) conversation = trimChatAfterglowCandidate(conversation, count);
          requestedRefs = sourceRefs(conversation, !!chatSupplement);
          selectedMaterial = materialForRounds(count);
          materialKey = innerMaterialKey([conversation?.sessionId, requestedRefs, selectedMaterial.refs]);
        },
        onChatSupplementSelected: count => {
          supplementCount = count;
          chatSupplement = chat?.select(selectedRoundCount, count).chatSupplement;
          requestedRefs = sourceRefs(conversation, !!chatSupplement);
        },
        onMusicSelected: events => {
          selectedMaterial = { ...selectedMaterial, refs: [...selectedMaterial.refs, ...musicPlaybackMaterialRefs(events)] };
          materialKey = innerMaterialKey([conversation?.sessionId, requestedRefs, selectedMaterial.refs]);
        },
        onOutingSelected: count => {
          const selected = outingForRounds(selectedRoundCount, supplementCount, count);
          selectedMaterial = { ...selectedMaterial, refs: [...selectedMaterial.refs, ...selected.refs] };
          materialKey = innerMaterialKey([conversation?.sessionId, requestedRefs, selectedMaterial.refs]);
        },
        onRequestStart: assertTransportReady => admission.beforeTransport(async () => {
          // If sleep began during preparation, rebuild the restricted materials next time.
          if (!sleepCatchup && !await isJunluoWantsAwake()) throw new Error('inner-update-cancelled');
          if (!await canProceed() || !await sourcesMatch({ sessionId: conversation?.sessionId, refs: requestedRefs,
            materials: selectedMaterial.refs, chatSupplement })) throw new Error('inner-update-cancelled');
          const actualStartedAt = Date.now();
          let claimed = false;
          const saved = await updateInnerUpdateState(input.dataEpoch, current => {
            if (!current || current.pending || !canCommit()
              || isCoolingDown(current, actualStartedAt) && (input.sharedCatchupBefore === undefined || current.retry)
              || !sameBatch(current.retry, retry)
              || (current.retry?.attempts ?? 0) >= INTERNAL_PAPER_MAX_ATTEMPTS) return current;
            const end = conversation?.messages.reduce((last, message) => compareChatAfterglowPositions(message, last) > 0 ? message : last);
            const batch: InternalPaperRetry = {
              ...(chatSupplement ? { chatSupplement } : {}),
              generationKey, attemptedAt: actualStartedAt,
              attempts: ((current.retry?.attempts ?? 0) + 1) as InternalPaperRetry['attempts'],
              // If the process dies in flight, allow the full timeout before the retry wait.
              retryAfter: actualStartedAt + ASSISTANT_INTERNAL_PAPER_REQUEST_TIMEOUT_MS + INTERNAL_PAPER_RETRY_INTERVAL_MS,
              ...(current.retry?.sessionId ? { sessionId: current.retry.sessionId, end: current.retry.end }
                : conversation && end ? { sessionId: conversation.sessionId, end: { id: end.id, createdAt: end.createdAt } } : {}),
              refs: current.retry?.refs.map(ref => requestedRefs.find(item => item.id === ref.id) ?? ref) ?? requestedRefs,
              materials: current.retry?.materials.filter(ref => !isMusicPlaybackMaterialId(ref.id)
                || selectedMaterial.refs.some(item => item.id === ref.id))
                .map(ref => selectedMaterial.refs.find(item => item.kind === ref.kind && item.id === ref.id) ?? ref)
                ?? selectedMaterial.refs,
            };
            claimed = true;
            claimedBatch = batch;
            return { ...current, lastAttemptAt: actualStartedAt, retry: batch };
          });
          if (!claimed || saved?.lastAttemptAt !== actualStartedAt || !await canProceed()) throw new Error('inner-update-no-longer-due');
          startedAt = actualStartedAt;
        }, assertTransportReady),
      }).catch(() => null);
    }, { connection: input.connection, dataEpoch: input.dataEpoch, purpose: 'inner-wants', shouldRecordSuccess: () => startedAt !== undefined })
      .catch(async () => {
        await recordLocalFailure(input, generationKey, 'budget-record-save-failed');
        return { ok: true as const, value: generated };
      });
    if (!result.ok || !result.value) {
      if (startedAt !== undefined && claimedBatch) await failedAttempt(input, claimedBatch);
      return;
    }
    const inner = result.value;
    if (startedAt === undefined) {
      if (inner.reason === 'context-too-long') {
        capacityBlocked = true;
        await recordLocalFailure(input, generationKey, 'context-too-long');
        if (conversation && !retry) { excludeSessionIds.add(conversation.sessionId); continue; }
      }
      return;
    }
    if (!canCommit()) {
      await recordLocalFailure(input, generationKey, 'result-no-longer-current');
      if (claimedBatch) await failedAttempt(input, claimedBatch); return;
    }
    await appendAssistantLifeGenerationDiagnostic({
      flow: 'wants', stage: 'request', requestId, attemptOrdinal,
      ...inner.diagnostics, attemptedAt: startedAt, contextSource: source === 'afterglow' ? 'afterglow' : 'state',
      extraFields: inner.value?.issues ?? inner.parseIssues,
      persistenceStatus: inner.status === 'success' ? 'pending' : 'interrupted',
      failureReason: inner.status === 'failure' ? inner.reason as AssistantLifeGenerationFailureReason : undefined,
      generationKey, materialFingerprint: materialKey, model: input.connection.model.trim(),
      operationIds: inner.value ? [`${generationKey}:wants`] : [],
      requests: [{ ...inner.diagnostics, paper: 'inner', reason: inner.reason, status: inner.status }],
      scheduleSlot: input.currentState.scheduleSlot, status: inner.status,
    }).catch(() => undefined);
    // The optional decision survives an invalid wants basket, but not changed source facts.
    if (postLookKind && typeof inner.lookAtPost === 'boolean' && await isJunluoWantsAwake()
      && await sourcesMatch({ sessionId: conversation?.sessionId, refs: requestedRefs, materials: selectedMaterial.refs, chatSupplement }).catch(() => false)
      && canCommit()) {
      await import('../posts/baiyunPostReplyRuntime').then(runtime => runtime.acceptPostLookDecision({
        key: generationKey, lane: 'inner', kind: postLookKind, decision: inner.lookAtPost, dataEpoch: input.dataEpoch,
      })).catch(() => undefined);
    }
    // Unknown source availability may be journaled, never adopted until commitPending revalidates it.
    const sourcesUnchanged = inner.status === 'success'
      ? await sourcesMatch({ sessionId: conversation?.sessionId, refs: requestedRefs, materials: selectedMaterial.refs, chatSupplement }).catch(() => undefined) : false;
    if (inner.status !== 'success' || !inner.value || !await canProceed() || sourcesUnchanged === false) {
      if (inner.status === 'success') await recordLocalFailure(input, generationKey, 'result-no-longer-current');
      if (claimedBatch) await failedAttempt(input, claimedBatch); return;
    }
    const end = conversation?.messages.reduce((last, message) => compareChatAfterglowPositions(message, last) > 0 ? message : last);
    const pending: InnerUpdatePending = {
      ...(chatSupplement ? { chatSupplement } : {}),
      generationKey, source, materialKey, attemptedAt: startedAt, refs: requestedRefs,
      ...(conversation && end ? { sessionId: conversation.sessionId, end: { id: end.id, createdAt: end.createdAt } } : {}),
      wants: inner.value.wants, materials: selectedMaterial.refs, applied: false,
    };
    unsavedResult = { epoch: input.dataEpoch, pending };
    const persisted = await updateInnerUpdateState(input.dataEpoch, current =>
      current && !current.pending && sameBatch(current.retry, pending) && canCommit() ? { ...current, pending } : current);
    if (!sameBatch(persisted?.pending, pending)) { unsavedResult = undefined; return; }
    unsavedResult = undefined;
    await commitPending(input, pending, canProceed, canCommit);
    return;
  }
}
let pendingInnerUpdate: Promise<void> | undefined;
export function runAssistantInnerStateUpdate(input: AssistantInnerStateUpdateInput): Promise<void> {
  if (pendingInnerUpdate) return pendingInnerUpdate;
  const update = (async () => {
    if (await (await import('./assistantSharedExperienceRuntime')).runAssistantSharedExperienceUpdate(input)) return;
    await performInnerStateUpdate(input);
  })().catch(() => undefined).finally(() => {
    if (pendingInnerUpdate === update) pendingInnerUpdate = undefined;
    // This is outside the first paper's budget lease and does not delay its local commit.
    void isJunluoWantsAwake().then(awake => awake
      ? import('../posts/baiyunPostReplyRuntime').then(runtime => runtime.drainPostReplies()) : undefined).catch(() => undefined);
  });
  pendingInnerUpdate = update;
  return update;
}

/** Called under the existing shared-experience runner, never recursively through its entry. */
export const resumeInnerBeforeSharedExperience = performInnerStateUpdate;
