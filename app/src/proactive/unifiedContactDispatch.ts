import { Platform } from 'react-native';
import { getProactiveDeviceControl, isProactiveControlWait, withSharedContactLedger } from './proactiveDeviceControl';
import { beginProactiveBudgetRequest, getProactiveBudgetRetryAt, releaseUnstartedProactiveBudgetRequest, isAiCostDeferred } from '../ai/aiCallBudget';
import { isChatReplyInFlight, runScheduledAiCall } from '../ai/aiRuntimeScheduler';
import { loadAiConfigPreferencesSnapshot, resolveLifeCreativeConfig } from '../ai/AiConfigPreferences';
import { buildNearStatusLifeMaterialSnapshot, isFocusSummaryLifeMaterialId, loadReferencedFocusSummaryLifeMaterial } from '../ai/lifeMaterialHub';
import { listBaiyunContinuityEvents, listBaiyunContinuityLinks, listChatCareMatters } from '../ai/behavior/continuityLedger';
import { buildChatCareContext, formatCareLocalTime, toChatCareItem } from '../ai/behavior/chatCareUpdates';
import { isHeartCareMatter } from '../ai/behavior/heartCareMatter';
import { buildProactiveBadEnvelopeSnapshot, saveBaiyunLatestBadEnvelopeSnapshot } from '../ai/behavior/actionChatBadEnvelopeCache';
import { formatChatAfterglowMessageTime } from '../chat/chatAfterglowProbe';
import { loadJunluoAffectState, loadJunluoDesireState } from '../life/junluoInnerStateStore';
import { loadJunluoDesireSnapshot, isJunluoWantsAwake } from '../life/junluoDesireRuntime';
import { loadActiveFocusSession } from '../focus/focusStore';
import { isAutomaticRemoteAiAllowed, loadAutomaticRemoteAiPolicy } from '../runtime/automaticRemoteAiPolicy';
import { captureBackupRestoreDataEpoch, canCommitBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit, subscribeBackupRestoreRuntimeState } from '../backup/backupRestoreCoordinator';
import { appendMessagesToChatSession, loadChatStateFast, loadChatSessionMessage, loadChatSessionMessagePage } from '../chat/chatStorage';
import { emitChatMessagesAppended } from '../chat/chatMessageEvents';
import { selectNearStatusConversation } from '../ai/assistantNearStatus';
import { loadContactWaitingMessages, selectContactWaiting, ORDINARY_CONTACT_ID_PREFIX } from './contactWaiting';
import { fingerprintPromptText } from '../ai/promptCacheMetrics';
import { isSiliconQwenChatConnection, freezeQwenChatSource, readQwenChatSource, qwenChatMessageRevision, canUseQwenImportantRawChat,
  QwenChatSourceInvalid, isQwenChatSourceDeferred } from '../ai/qwenChatLayout';
import type { AiConnection, AiProfile } from '../ai/types';
import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import { createSubjectiveMessage } from '../ai/subjectiveMessages';
import { createCameraReplyContinuation, recordCameraObservationReply } from '../camera/cameraModelObservationReply';
import { CAMERA_LOOK_ONCE_TOOL_ID } from '../camera/cameraModelObservationMaterials';
import { loadRecentCameraObservationMaterial } from '../camera/cameraEvidenceFusion';
import { cameraObservationIdsFromResults, saveCameraResponseDraft, completeCameraResponseDelivery,
  cameraObservationResponsesCurrent } from '../camera/cameraObservationResponseDelivery';
import { getCameraObservationResponse } from '../camera/cameraObservationStore';
import { runOrdinaryProactiveToolTurn } from './proactiveToolTurn';
import { parseOrdinaryProactiveLiteResponseWithDiagnostics } from './proactiveLitePrompt';
import { recordActiveMessageDelivery, loadActiveMessageCoordinatorSnapshot } from './activeMessageCoordinator';
import { contactIsPaused, contactOpportunityDecision, contactWaitMs, finishContactOpportunity, selectContactMotives, UNIFIED_CONTACT_TASK,
  SLEEPING_BODY_CONTACT_TASK, CONTACT_DAY_LIMIT, CONTACT_MODEL_REQUEST_TIMEOUT_MS, contactLocalDay, contactMessageId, isContactPastMemorySource, type ContactOpportunity } from './unifiedContact';
import { changeUnifiedContactState, readUnifiedContactState, readContactPause, recoverStoredUnifiedContactMessages, type ContactToolReceipt } from './unifiedContactStore';
import { buildUnifiedContactFacts, buildContactHandoffMaterial, buildContactMotivePaper, selectContactMaterialEntries, contactCareSelection, shouldOfferOrdinaryContactLifeItem,
  type ContactMaterialEntry } from './unifiedContactMaterials';
import { prepareContactOwnLife, loadContactOwnLife, isContactOwnLifeId } from './unifiedContactOwnLife';
import { prepareContactCurrentStates, loadContactCurrentState } from './unifiedContactCurrentState';
import { prepareContactWeeklyReviews, loadContactWeeklyReview, recordContactWeeklyReviewProvided } from './unifiedContactWeeklyReview';
import { prepareContactPastMemory, loadContactPastMemory, recordContactPastMemoryProvided, CONTACT_PAST_MEMORY_MIN_CHARS,
  type ContactPastMemoryPreparation } from './unifiedContactMemory';
import { recordContactScheduleRecoveryProvided } from './unifiedContactScheduleRecovery';
import { contactBudgetDeferredUntil, normalizeContactBodyDiagnostics, processUnifiedContact } from './unifiedContactRuntime';
import { contactQwenChatSource, contactQwenChatMode, contactSourcesCurrent } from './unifiedContactHandoff';
import { loadPriorityHeartContact, markHeartContactHandled } from '../bodySignal/bodySignalProactiveCareRuntime';
import { loadPriorityPeriodContact, markPeriodContactHandled, PERIOD_PRIORITY_WINDOW_MS } from '../period/periodCareEvents';
import { prepareUnifiedContactShares, commitUnifiedContactShares,
  type UnifiedContactShareRef } from './unifiedContactShares';
import { isWishProactiveSource, loadWishProactiveMaterial } from '../wishPool/wishProactiveMaterials';
import { runChatAuxiliaryOperation } from '../chat/chatAuxiliaryDiagnostics';
import { readPhoneLimitActionQuery } from '../backend/phoneLimitActionNative';
import { readPhoneRestrictionUsage } from '../backend/phoneRestrictionNative';
import { getInstalledPhoneApps } from '../backend/phoneActivityNative';
import { buildPhoneEmergencySnapshot, decidePhoneEmergencyContact, formatPhoneEmergencyToBudget,
  PHONE_EMERGENCY_CONTACT_TASK, PHONE_EMERGENCY_CONTACT_INTERVAL_MS, type PhoneEmergencyReceipt } from './phoneEmergencyContact';

export type PriorityBodyContact = { id: string; version: string; expiresAt: number; facts: string; kind: 'heart' | 'period' };
const version = (message: SubjectiveMessage) => fingerprintPromptText(JSON.stringify([message.role, message.content, message.createdAt]));
let running: Promise<number> | undefined;
let activeContactAbort: AbortController | undefined;
let contactHostPaused = false;
let contactHostGeneration = 0;

/** Resume eligibility only. The host's next normal check decides whether a new round is due. */
export function resumeUnifiedContactForHost() {
  if (contactHostPaused) { contactHostPaused = false; contactHostGeneration++; }
}

/** Host shutdown/suspend cancels this run, never schedules another contact. */
export async function stopUnifiedContactForHost() {
  contactHostPaused = true;
  const generation = ++contactHostGeneration;
  activeContactAbort?.abort();
  const op = await changeUnifiedContactState(state => {
    if (generation !== contactHostGeneration) return null;
    const current = state.current;
    if (!current || current.status === 'finished') return null;
    if (!current.requests) { current.status = 'finished'; current.reason = 'host_stopped'; current.endedAt = Date.now(); }
    else finishContactOpportunity(state, Date.now(), 'host_stopped');
    return current;
  });
  if (op) await getProactiveDeviceControl()?.complete(op).catch(() => undefined);
}

async function readEmergencyContact(receipt: PhoneEmergencyReceipt = {}) {
  // Usage first: the following query rejects a snapshot from a superseded round/cutoff.
  const usage = await readPhoneRestrictionUsage().catch(() => null);
  const query = await readPhoneLimitActionQuery().catch(() => null);
  const names = (query?.state as { emergency?: unknown } | null)?.emergency ? await getInstalledPhoneApps().catch(() => []) : [];
  return buildPhoneEmergencySnapshot(query, usage?.usage ?? null,
    Object.fromEntries(names.map(app => [app.source, app.title])), receipt);
}

async function priorityContact(state: Awaited<ReturnType<typeof readUnifiedContactState>>, now: number) {
  const [heartRead, periodRead] = await Promise.all([
    runChatAuxiliaryOperation({ phase: 'read', stage: 'continuity_ledger', step: 'body_heart_read' }, () => loadPriorityHeartContact(now)),
    runChatAuxiliaryOperation({ phase: 'read', stage: 'continuity_ledger', step: 'body_period_read' }, () => loadPriorityPeriodContact(now)),
  ]);
  const heart = heartRead.ok ? heartRead.value : null;
  const period = periodRead.ok ? periodRead.value : null;
  const candidates: PriorityBodyContact[] = [
    ...(heart ? [{ ...heart, kind: 'heart' as const }] : []),
    ...(period ? [{ ...period, kind: 'period' as const }] : []),
  ];
  return candidates.filter(source => source.expiresAt > now
    && source.expiresAt - (source.kind === 'heart' ? 10 * 60_000 : PERIOD_PRIORITY_WINDOW_MS) >= state.initializedAt
    && (state.current && state.current.status !== 'finished'
      ? state.current.sources.some(ref => ref.kind === source.kind && ref.id === source.id && ref.version === source.version)
      : state.claimedPriority?.[source.kind] !== `${source.id}:${source.version}`))
    .sort((a, b) => a.expiresAt - b.expiresAt)[0];
}

async function contactCareEntries(messages: readonly SubjectiveMessage[], now: number, ordinary: boolean) {
  const page = await listBaiyunContinuityEvents({ kinds: ['care_process'], statuses: ['open', 'waiting'], limit: 200, readOnly: true });
  const events = [...new Map([...page.filter(event => !isHeartCareMatter(event)),
    ...await listChatCareMatters()].map(event => [event.id, event])).values()];
  const ids = new Set(messages.map(message => message.id));
  const linked = new Set<string>();
  for (const event of events) {
    if (ids.has(event.source.sourceId)
      || [event.careEvidence?.origin.messageId, event.careEvidence?.latest?.messageId].some(id => id && ids.has(id))
      || (await listBaiyunContinuityLinks(event.id, true)).some(link => ids.has(link.targetId))) linked.add(event.id);
  }
  return events.filter(event => event.schemaVersion === 3 ? Boolean(event.careEvidence)
    : event.schemaVersion === 2 && (event.itemName || event.focusExcerpt))
    .sort((a, b) => Number(linked.has(b.id)) - Number(linked.has(a.id)) || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
    .slice(0, ordinary ? events.length : 3).map((event, index) => {
      const context = event.schemaVersion === 3 && event.careEvidence || isHeartCareMatter(event)
        ? buildChatCareContext([toChatCareItem(event)])
          .replace(/^事项序号：1$/mu, `事项序号：${index + 1}`)
        : [
          `事项 ${index + 1}：${event.itemName ?? event.focusExcerpt}`,
          event.progress ? `目前的进展：${event.progress}` : '',
          event.durationMs !== undefined ? `这次做事的时长：${event.durationMs / 60_000}分钟` : '',
          event.careTimeSources?.contact && event.nextActionAt !== undefined
            ? `约好联系的时间：${formatCareLocalTime(event.nextActionAt)}` : '',
        ].filter(Boolean).join('\n');
      return { id: event.id, version: String(event.revision), care: true,
        ...(ordinary ? contactCareSelection(event, messages, now, isHeartCareMatter(event) ? event.occurredAt : undefined) : {}),
        text: `【I 还惦记着的事】\n\n${context}\n记录时间：${formatChatAfterglowMessageTime(event.updatedAt)}` };
    });
}

async function conversation(sessionId: string, count: number): Promise<SubjectiveMessage[]> {
  let beforeIndex = count; let messages: SubjectiveMessage[] = [];
  while (beforeIndex > 0) {
    const page = await loadChatSessionMessagePage(sessionId, { beforeIndex, limit: 60 });
    if (!page.messages.length || page.startIndex >= beforeIndex) break;
    messages = [...page.messages, ...messages];
    const selected = selectNearStatusConversation(messages);
    if (selected.length < messages.length) return selected;
    beforeIndex = page.startIndex;
  }
  return selectNearStatusConversation(messages);
}

async function actualContactState() {
  const [settings, allowed, awake, focus, pause] = await Promise.all([
    import('./proactiveMessages').then(module => module.loadProactiveMessageSettings()),
    loadAutomaticRemoteAiPolicy().then(isAutomaticRemoteAiAllowed),
    isJunluoWantsAwake(), loadActiveFocusSession(true), readContactPause(),
  ]);
  return { enabled: settings.enabled && allowed, settings, asleep: !awake, pause,
    occupied: Boolean(focus?.mode === 'cowork' && !focus.paused && focus.baiyunActivity.trim()) };
}

async function dispatch(input: {
  apiKey: string; connection: AiConnection; profile: AiProfile; backupRestoreLeaseHeld?: boolean;
  schedulerHeld?: boolean;
  priority?: PriorityBodyContact;
}) {
  if (Platform.OS !== 'android' && Platform.OS !== 'windows') return 0;
  if (contactHostPaused) return 0;
  const hostGeneration = contactHostGeneration;
  const hostCurrent = () => !contactHostPaused && hostGeneration === contactHostGeneration;
  const epoch = captureBackupRestoreDataEpoch();
  if (epoch === null) return 0;
  // Establish the start even when automatic calls are currently disabled.
  await changeUnifiedContactState(() => undefined, epoch);
  await recoverStoredUnifiedContactMessages(epoch);
  const control = getProactiveDeviceControl();
  if (!control) return 0;
  const sharedReadAt = Date.now();
  const shared = await control.read().catch(() => undefined);
  if (!shared?.migrationComplete || !hostCurrent()) return 0;
  const localState = await readUnifiedContactState();
  const state = withSharedContactLedger(localState, shared);
  const current = state.current?.status !== 'finished' ? state.current : null;
  if (current) {
    const round = shared.current;
    if (!round || round.opportunityId !== current.id || round.ownerDeviceId !== control.deviceId
      || round.runtimeEpoch !== control.runtimeEpoch || !['reserved', 'started'].includes(round.state)) {
      // An unstarted reservation has no cooldown; an old runtime cannot replay a paid round.
      await changeUnifiedContactState(next => {
        if (next.current?.id !== current.id) return;
        if (!current.requests) { next.current.status = 'finished'; next.current.reason = 'control_reservation_ended'; next.current.endedAt = Date.now(); }
        else finishContactOpportunity(next, Date.now(), 'control_round_ended');
      }, epoch);
      return 0;
    }
  } else if (shared.used >= CONTACT_DAY_LIMIT) return 0;
  const noteSourceWait = (reason: string) => console.info('[unified-contact-check]', {
    stage: 'prepare_source', reason, important: current?.important,
    status: current?.status, requests: current?.requests, createdAt: current?.createdAt,
  });
  const chat = await loadChatStateFast({ activeMessageLimit: 1 });
  const sessionId = current?.sessionId ?? chat.activeSessionId;
  const session = chat.sessions.find(entry => entry.id === sessionId);
  if (!session || !sessionId) {
    noteSourceWait('session_missing');
    if (current) await changeUnifiedContactState(next => {
      if (next.current?.id === current.id) finishContactOpportunity(next, Date.now(), 'session_deleted');
    }, epoch);
    return 0;
  }
  let currentMessages: SubjectiveMessage[];
  let messages: SubjectiveMessage[];
  try {
    currentMessages = await conversation(sessionId, session.messageCount ?? session.messages.length);
    // A paid but not-yet-journaled body is recovered by processUnifiedContact
    // before request validity runs. Connection changes only reject a new request.
    messages = current?.qwenChatSource ? await readQwenChatSource(contactQwenChatSource(current),
      loadChatSessionMessage, undefined, contactQwenChatMode(current)) : currentMessages;
  } catch (error) {
    noteSourceWait(error instanceof QwenChatSourceInvalid ? 'qwen_source_unknown_subreason' : 'source_read_wait');
    if (current && error instanceof QwenChatSourceInvalid) await changeUnifiedContactState(next => {
      if (next.current?.id === current.id) finishContactOpportunity(next, Date.now(), 'stale');
    }, epoch);
    if (isQwenChatSourceDeferred(error) || error instanceof QwenChatSourceInvalid
      || current?.qwenChatSource || isSiliconQwenChatConnection(input.connection)) return 0;
    throw error;
  }
  const latestYou = currentMessages.filter(message => message.role === 'you').at(-1);
  const now = Date.now();
  const [actual, desires, affect] = await Promise.all([
    actualContactState(), loadJunluoDesireSnapshot(now), loadJunluoAffectState(),
  ]);
  const values = Object.fromEntries(Object.values(desires.desires).map(dimension => [dimension.id, dimension.effectiveValue]));
  const supplied = Platform.OS === 'android' ? input.priority ?? await priorityContact(state, now) : undefined;
  const important = supplied && supplied.expiresAt > now && (current
    || state.claimedPriority?.[supplied.kind] !== `${supplied.id}:${supplied.version}`) ? supplied : undefined;
  const selected = selectContactMotives(values, affect.relationshipPhase.phase, important ? undefined : state.motiveLastSelectedAt);
  const emergency = Platform.OS === 'android' && !important ? await readEmergencyContact(state.phoneEmergencyCare) : null;
  const phoneDue = !!emergency && decidePhoneEmergencyContact(emergency, state.phoneEmergencyCare ?? {}, now).due;
  const phoneContact = !!current?.phoneEmergency || !current && !important && phoneDue;
  const motives = current?.motives ?? (phoneContact ? ['care_for_you'] as typeof selected
    : important ? (['care_for_you', ...selected.filter(id => id !== 'care_for_you')].slice(0, 2) as typeof selected) : selected);
  const decision = contactOpportunityDecision({ now, state, ...actual, chatBusy: isChatReplyInFlight(),
    motives, highest: selected.length ? values[selected[0]] : 0,
    importantExpiresAt: important?.expiresAt, phoneEmergencyDue: phoneDue });
  if (!current && !decision.allowed) {
    console.info('[unified-contact-check]', { stage: 'opportunity_not_created', reason: decision.reason,
      nextAt: decision.nextAt, enabled: actual.enabled, asleep: actual.asleep, occupied: actual.occupied, used: state.used });
    return 0;
  }
  if (!current && !important && !phoneContact && (shared.waitReason || shared.routeDeviceId !== control.deviceId)) return 0;
  if (!current) await changeUnifiedContactState(next => {
    if (next.current && next.current.status !== 'finished') throw Error('contact-already-claimed');
    const merged = withSharedContactLedger(next, shared);
    next.day = merged.day; next.used = merged.used;
    next.lastEndedAt = merged.lastEndedAt; next.lastOrdinaryReplyAt = merged.lastOrdinaryReplyAt;
    next.motiveLastSelectedAt = merged.motiveLastSelectedAt;
  }, epoch);
  let qwenChatSource = current?.qwenChatSource;
  if (!current && isSiliconQwenChatConnection(input.connection)
    && (!important || canUseQwenImportantRawChat(messages))) {
    const mode = important ? 'important_raw' : 'ordinary';
    let frozenSource;
    try { frozenSource = freezeQwenChatSource(input.connection, sessionId, messages, mode); }
    catch (error) { if (error instanceof QwenChatSourceInvalid) { noteSourceWait('qwen_freeze_unknown_subreason'); return 0; } throw error; }
    qwenChatSource = { version: 1, connectionFingerprint: frozenSource.connectionFingerprint,
      messageIds: frozenSource.refs.map(ref => ref.id) };
    messages = await readQwenChatSource(frozenSource, loadChatSessionMessage, input.connection, mode)
      .catch(error => {
        if (isQwenChatSourceDeferred(error) || error instanceof QwenChatSourceInvalid) {
          noteSourceWait(error instanceof QwenChatSourceInvalid ? 'qwen_source_unknown_subreason' : 'source_read_wait');
          return null;
        }
        throw error;
      })
      ?? [];
    if (!messages.length) { noteSourceWait('qwen_messages_empty'); return 0; }
  }
  const shareMaterials = await prepareUnifiedContactShares(now);
  const ordinaryMaterials = current ? current.materialVersion === 2 : !important;
  const life = await buildNearStatusLifeMaterialSnapshot(now, { includeAssistantSchedule: true,
    includeWearableSleep: true, includeWearableSteps: true, nearStatusFocusSummaries: ordinaryMaterials });
  const ownMaterials = ordinaryMaterials && !current ? await prepareContactOwnLife(now).catch(() => []) : [];
  const currentStateMaterials = ordinaryMaterials && !current ? await prepareContactCurrentStates(state) : [];
  const weeklyMaterials = ordinaryMaterials && !current ? await prepareContactWeeklyReviews() : [];
  const scheduleProgress = await import('../schedule/chatScheduleUnknownProgress')
    .then(async module => current
      ? (await Promise.all(current.sources.filter(ref => module.isChatScheduleProgressId(ref.id)).map(ref => module.loadChatScheduleProgress(ref, now))))
        .filter((entry): entry is ContactMaterialEntry => !!entry)
      : module.prepareChatScheduleProgress(sessionId, messages, now)).catch(() => [] as ContactMaterialEntry[]);
  const shareIds = new Set(shareMaterials.filter(item => item.kind === 'web').map(item => item.id));
  let availableEntries: ContactMaterialEntry[] = [...(await contactCareEntries(messages, now, ordinaryMaterials)),
    ...shareMaterials.map(item => ({ ...item, ...(ordinaryMaterials && item.kind === 'web'
      ? { own: 'experience' as const, sameSource: `web:${item.id}` } : {}) })), ...ownMaterials, ...currentStateMaterials, ...weeklyMaterials, ...scheduleProgress,
    ...life.items.filter(item => item.source !== 'active-message' && !item.id.startsWith('ambient:todos:')
    && !item.id.startsWith('ambient:schedule:')
    && ![...shareIds].some(id => item.id === `web-voyage:${id}` || item.id === `github-voyage:${id}`)
    && !(important?.kind === 'heart' && item.source === 'body-signal') && !(important?.kind === 'period' && item.source === 'period')
    && (!item.expiresAt || item.expiresAt > now))
    .filter(item => !ordinaryMaterials || !!current || shouldOfferOrdinaryContactLifeItem(item))
    .filter(item => !ordinaryMaterials || item.source !== 'co-reading' || !item.assistantParticipated)
    .sort((a, b) => Number(b.source === 'assistant-schedule') - Number(a.source === 'assistant-schedule') || b.occurredAt - a.occurredAt)
    .map(item => ({ id: item.id, version: item.fingerprint, text: item.promptLine,
      ...(item.sameSource ? { sameSource: item.sameSource } : {}),
      ...(ordinaryMaterials ? { occurredAt: item.occurredAt,
        background: item.id === 'ambient:phone' || item.toolId === 'system_status.get_battery',
        ...(['assistant-schedule', 'web-voyage', 'github-voyage'].includes(item.source)
          ? { own: 'experience' as const } : {}) } : {}) }))];
  // Re-entering an existing opportunity loads its exact own-life references, not the latest selection.
  if (current && ordinaryMaterials) {
    const referenced = await Promise.all(current.sources.filter(ref => ref.kind === 'life' && isContactOwnLifeId(ref.id))
      .map(ref => loadContactOwnLife(ref)));
    availableEntries = [...availableEntries.filter(entry => !isContactOwnLifeId(entry.id)),
      ...referenced.filter((entry): entry is ContactMaterialEntry => !!entry)];
    const states = await Promise.all(current.sources.filter(ref => ref.kind === 'current_state').map(ref => loadContactCurrentState(ref)));
    availableEntries.push(...states.filter((entry): entry is ContactMaterialEntry => !!entry));
    const weeks = await Promise.all(current.sources.filter(ref => ref.kind === 'weekly_review').map(loadContactWeeklyReview));
    availableEntries.push(...weeks.filter((entry): entry is ContactMaterialEntry => !!entry));
    const past = await Promise.all(current.sources.filter(isContactPastMemorySource).map(ref => loadContactPastMemory(ref)));
    availableEntries.push(...past.filter((entry): entry is ContactMaterialEntry => !!entry));
    const focusSummaries = await Promise.all(current.sources.filter(ref => ref.kind === 'life' && isFocusSummaryLifeMaterialId(ref.id))
      .map(ref => loadReferencedFocusSummaryLifeMaterial(ref.id, now)));
    availableEntries = [...availableEntries.filter(entry => !isFocusSummaryLifeMaterialId(entry.id)),
      ...focusSummaries.flatMap(item => item ? [{ id: item.id, version: item.fingerprint, text: item.promptLine,
        occurredAt: item.occurredAt, sameSource: item.sameSource }] : [])];
  }
  const entryPool = current && ordinaryMaterials ? current.sources.flatMap(ref => {
    const entry = availableEntries.find(item => item.id === ref.id && item.version === ref.version
      && (item.kind ?? (item.care ? 'care' : 'life')) === ref.kind);
    return entry ? [entry] : [];
  }) : availableEntries;
  const selection = { ordinary: ordinaryMaterials,
    preamble: ordinaryMaterials ? buildContactMotivePaper(motives) : undefined,
    preferNewMaterials: ordinaryMaterials && !current && !phoneContact };
  let entries = selectContactMaterialEntries(entryPool, selection);
  let pastPreparation: ContactPastMemoryPreparation | null = null;
  let pastFrozen = !!current;
  const own = entries.filter(entry => entry.own);
  const higherPriority = entries.some(entry => entry.priority || entry.newRevision || entry.kind === 'weekly_review');
  const occupied = [selection.preamble, ...own.map(entry => entry.text)].filter(Boolean).join('\n\n');
  const remaining = 1000 - occupied.length - (occupied ? 2 : 0);
  if (!current && ordinaryMaterials && !important && !phoneContact && !higherPriority && own.length < 2
    && remaining >= CONTACT_PAST_MEMORY_MIN_CHARS) {
    const [latestActual, latestChat, latestState] = await Promise.all([
      actualContactState(), loadChatStateFast({ activeMessageLimit: 1 }), readUnifiedContactState(),
    ]);
    if (!canCommitBackupRestoreDataEpoch(epoch) || !latestActual.enabled || latestActual.asleep || latestActual.occupied
      || contactIsPaused(latestActual.pause, Date.now()) || isChatReplyInFlight() || latestChat.activeSessionId !== sessionId
      || latestState.current && latestState.current.status !== 'finished') return 0;
    const controller = new AbortController();
    const unsubscribe = subscribeBackupRestoreRuntimeState(status => {
      if (status.status !== 'ready' || !canCommitBackupRestoreDataEpoch(epoch)) controller.abort();
    });
    try {
      pastPreparation = await prepareContactPastMemory({ messages, own, state, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted || !canCommitBackupRestoreDataEpoch(epoch)) return 0;
      console.warn('[unified-contact] past-memory preparation failed');
    } finally { unsubscribe(); }
    if (!canCommitBackupRestoreDataEpoch(epoch)) return 0;
    if (pastPreparation) entries = selectContactMaterialEntries([...entryPool, pastPreparation.entry], {
      ...selection, preferPastMemory: true,
    });
  }
  const candidate: ContactOpportunity = current ?? {
    ...(!important ? { materialVersion: 2 as const } : {}),
    ...(phoneContact && emergency ? { phoneEmergency: { latest: emergency.latest, references: [],
      pendingIds: emergency.pendingIds, attemptedAt: now } } : {}),
    id: `${!important && !phoneContact ? ORDINARY_CONTACT_ID_PREFIX : 'unified-contact:'}${sessionId}:${now}`,
    sessionId, createdAt: now, expiresAt: important?.expiresAt ?? Number.MAX_SAFE_INTEGER,
    motives, sources: [...(important ? [{ id: important.id, kind: important.kind, version: important.version }] : []),
      ...entries.map(entry => ({ id: entry.id, version: entry.version, kind: entry.kind ?? (entry.care ? 'care' as const : 'life' as const) }))],
    important: !!important, epoch, latestYouId: latestYou?.id ?? null,
    sourceMessages: messages.map(message => ({ id: message.id,
      version: qwenChatSource ? qwenChatMessageRevision(message, important ? 'important_raw' : 'ordinary') : version(message) })),
    ...(qwenChatSource ? { qwenChatSource } : {}),
    requests: 0, requestStartedAt: 0, retryStarted: false, failedAt: null, retryAt: null,
    status: 'ready', messages: [], savedMessageIds: [], endedAt: null,
  };
  // No model/slot/motive consumption occurs on a lost reservation.
  if (!hostCurrent()) return 0;
  if (!current) {
    try { await control.reserve(candidate, shared, important || phoneContact ? 0 : contactWaitMs(values[motives[0]]) ?? 0); }
    catch { return 0; }
  }
  if (!hostCurrent()) {
    if (!current) await control.complete(candidate).catch(() => undefined);
    return 0;
  }
  if (!candidate.important && !candidate.phoneEmergency && candidate.requests === 0 && !candidate.messages.length
    && candidate.scheduleRecovery === undefined) {
    try {
      const { loadScheduleRecoveryBatch } = await import('../schedule/scheduleReminderRecovery');
      const batch = await loadScheduleRecoveryBatch(sessionId, messages, Date.now());
      if (current) await changeUnifiedContactState(state => {
        if (state.current?.id !== candidate.id || state.current.requests !== 0) throw Error('contact-opportunity-replaced');
        state.current.scheduleRecovery = batch;
      }, epoch);
      candidate.scheduleRecovery = batch;
    } catch { return 0; } // A temporary read failure waits locally, before spending a request.
  }
  const refreshPast = async (op: ContactOpportunity) => {
    if (pastFrozen || !pastPreparation || !op.sources.some(isContactPastMemorySource)) return;
    const fresh = await pastPreparation.refresh();
    const next = selectContactMaterialEntries(entries.flatMap(entry => entry.pastMemory ? fresh ? [fresh] : [] : [entry]), selection);
    const previous = op.sources.find(isContactPastMemorySource);
    const offered = next.find(entry => entry.pastMemory);
    entries = next;
    if (offered?.id === previous?.id && offered?.version === previous?.version) return;
    op.sources = [...op.sources.filter(ref => !isContactPastMemorySource(ref)),
      ...(offered ? [{ kind: 'life' as const, id: offered.id, version: offered.version }] : [])];
    const saved = (await readUnifiedContactState()).current;
    if (saved?.id === op.id) await changeUnifiedContactState(state => {
      if (state.current?.id !== op.id || state.current.requests || state.current.messages.length) throw Error('contact-memory-already-requested');
      state.current.sources = op.sources;
    }, epoch);
  };
  const valid = async (op: ContactOpportunity, writingMessages?: readonly SubjectiveMessage[]) => {
    const stale = (reason: string) => {
      console.info('[unified-contact-check]', { stage: 'dispatch', reason,
        important: op.important, status: op.status, requests: op.requests, createdAt: op.createdAt });
      return 'stale' as const;
    };
    if (!hostCurrent()) return stale('host_stopped');
    if (!canCommitBackupRestoreDataEpoch(epoch)) return stale('epoch');
    if (op.epoch !== epoch) return stale('opportunity_epoch');
    await refreshPast(op);
    const currentState = await actualContactState();
    const persisted = (await readUnifiedContactState()).current;
    const handled = new Set(persisted?.id === op.id ? persisted.handledSources : []);
    if (!currentState.enabled) return 'disabled' as const;
    if (contactIsPaused(currentState.pause, Date.now())) return 'paused' as const;
    // Runtime journals an already paid answer first. Only an old batch that
    // still needs a request is interrupted when its fixed source is absent.
    if (!op.important && !op.qwenChatSource && !op.messages.length
      && isSiliconQwenChatConnection(input.connection)) return stale('ordinary_qwen_missing_source');
    if (op.qwenChatSource && !op.messages.length) {
      try { await readQwenChatSource(contactQwenChatSource(op), loadChatSessionMessage, input.connection, contactQwenChatMode(op)); }
      catch (error) { if (error instanceof QwenChatSourceInvalid) return stale('qwen_source_unknown_subreason'); throw error; }
    }
    let tail = writingMessages;
    if (!tail) {
      const latest = await loadChatStateFast({ activeMessageLimit: 1 });
      const target = latest.sessions.find(entry => entry.id === op.sessionId);
      if (!target) return stale('session_missing');
      if (latest.activeSessionId !== op.sessionId) return stale('session_changed');
      tail = await conversation(op.sessionId, target.messageCount ?? target.messages.length);
    }
    if (!await contactSourcesCurrent({ ...op, handledSources: [...handled] }, writingMessages)) return stale('source_check_failed');
    if (isChatReplyInFlight()
      || (tail.filter(message => message.role === 'you').at(-1)?.id ?? null) !== op.latestYouId) return 'chat' as const;
    if (!op.important && currentState.asleep) return 'sleep' as const;
    if (!op.important && currentState.occupied) return 'activity' as const;
    return hostCurrent() ? 'valid' as const : stale('host_stopped');
  };
  let cameraBodyCommitted: (() => Promise<void>) | undefined;
  const lateCameraCallIds = new Set<string>();
  const roundController = new AbortController();
  activeContactAbort = roundController;
  let roundTimer: ReturnType<typeof setTimeout> | undefined;
  let admittedDeadline: number | undefined = current && shared.current?.state === 'started' && shared.current.deadlineAt !== null
    ? sharedReadAt + Math.max(0, shared.current.deadlineAt - shared.serverTimeMs) : undefined;
  const stopForEpoch = subscribeBackupRestoreRuntimeState(() => {
    if (!canCommitBackupRestoreDataEpoch(epoch)) roundController.abort();
  });
  const beginCoordinatedTransport = async (op: ContactOpportunity) => {
    if (!hostCurrent() || roundController.signal.aborted || !canCommitBackupRestoreDataEpoch(epoch)) throw Error('contact-control-owner-changed');
    if (admittedDeadline === undefined) {
      const startRequestedAt = Date.now();
      const round = await control.start(op);
      if (!hostCurrent() || roundController.signal.aborted || !canCommitBackupRestoreDataEpoch(epoch)) throw Error('contact-control-owner-changed');
      const serverNow = control.snapshot()?.serverTimeMs;
      if (round.deadlineAt === null || serverNow === undefined) throw Error('contact-control-deadline-missing');
      admittedDeadline = startRequestedAt + Math.max(0, round.deadlineAt - serverNow);
    }
    const deadline = Math.min(op.expiresAt, admittedDeadline);
    if (deadline <= Date.now()) { roundController.abort(); throw Error('contact-control-expired'); }
    op.expiresAt = deadline;
    await changeUnifiedContactState(next => {
      if (next.current?.id !== op.id || next.current.epoch !== epoch || next.current.status === 'finished') throw Error('contact-round-stale');
      next.current.expiresAt = Math.min(next.current.expiresAt, deadline);
    }, epoch);
    if (roundTimer) clearTimeout(roundTimer);
    roundTimer = setTimeout(() => roundController.abort(), Math.max(0, deadline - Date.now()));
  };
  try { return await processUnifiedContact({
    now: Date.now, read: readUnifiedContactState, change: work => changeUnifiedContactState(work, epoch), valid,
    readSaved: loadChatSessionMessage,
    recordSavedMaterials: async (op, message) => {
      await recordContactWeeklyReviewProvided(op, message);
      await recordContactScheduleRecoveryProvided(op, message);
      await recordContactPastMemoryProvided(op, message);
    },
    isRequestDeferred: error => isProactiveControlWait(error) || isAiCostDeferred(error) || isQwenChatSourceDeferred(error) || contactBudgetDeferredUntil(error) !== undefined,
    isEpochCurrent: operationEpoch => operationEpoch === epoch && canCommitBackupRestoreDataEpoch(epoch),
    releaseRequestBudget: requestToken => releaseUnstartedProactiveBudgetRequest({ connection: input.connection, dataEpoch: epoch, requestToken }),
    generate: async ({ opportunity, retry, beforeRequest, beforeTransport, onTransportStarted, onTransportFinished, onTools }) => {
      const currentActual = await actualContactState();
      const handoff = buildContactHandoffMaterial(await readUnifiedContactState());
      const waiting = opportunity.materialVersion === 2 && !opportunity.important && !opportunity.phoneEmergency
        ? await loadContactWaitingMessages(sessionId).then(rows => selectContactWaiting(sessionId, rows, Date.now()))
          .catch(() => undefined) : undefined;
      const baseFacts = () => buildUnifiedContactFacts({ now: Date.now(), lastYouAt: latestYou?.createdAt,
        messages, affect, desires, motives: opportunity.motives,
        entries: entries.filter(entry => opportunity.sources.some(source => source.id === entry.id && source.version === entry.version
          && source.kind === (entry.kind ?? (entry.care ? 'care' : 'life')))),
        bodyFacts: important?.facts, handoff, ordinary: opportunity.materialVersion === 2,
        contactWaiting: waiting,
        separateChat: !!opportunity.qwenChatSource });
      const cameraObservationContext = await loadRecentCameraObservationMaterial({
        sessionId,
        recentMessages: messages.filter((message) => message.id !== latestYou?.id).slice(-4),
      }).catch(() => '');
      const wishMaterial = !opportunity.important ? await loadWishProactiveMaterial({ messages }) : undefined;
      if (wishMaterial) {
        opportunity.sources = [...opportunity.sources.filter(ref => !isWishProactiveSource(ref)), ...wishMaterial.sources];
        opportunity.sourceMessages = [...new Map([...opportunity.sourceMessages, ...wishMaterial.sourceMessages
          .filter(ref => !opportunity.qwenChatSource?.messageIds.includes(ref.id))]
          .map(ref => [ref.id, ref])).values()];
      }
      const ordinaryFacts = () => [baseFacts(), cameraObservationContext, wishMaterial?.text].filter(Boolean).join('\n\n');
      let facts = ordinaryFacts();
      if (opportunity.phoneEmergency) {
        const fresh = await readEmergencyContact((await readUnifiedContactState()).phoneEmergencyCare);
        const material = formatPhoneEmergencyToBudget(fresh, Math.max(0, 12_000 - facts.length));
        facts += `\n\n${material.text}`;
        opportunity.phoneEmergency = { latest: fresh.latest ?? opportunity.phoneEmergency.latest, references: material.references,
          observedReferences: fresh.latest ? fresh.references : opportunity.phoneEmergency.observedReferences,
          pendingIds: fresh.pendingIds, attemptedAt: Date.now() };
      }
      let receipt: ContactToolReceipt = retry ?? { continuationMessages: [], completedResults: [] };
      const settlement: NonNullable<Parameters<typeof runOrdinaryProactiveToolTurn>[0]['onSettlement']> = async event => {
        if (!event.dataEpochStillCurrent || !canCommitBackupRestoreDataEpoch(epoch)) return;
        if (receipt.completedResults.some(result => result.callId === event.result.callId)) return;
        receipt = { completedResults: [...receipt.completedResults, event.result],
          continuationMessages: [...receipt.continuationMessages, ...event.continuationMessages.map(message => {
            if (message.kind === 'tool_result') return message;
            const { reasoningContent: _reasoning, ...formal } = message;
            return formal;
          })] };
        await onTools(receipt);
      };
      const currentCameraReply = async () => {
        const actual = (await readUnifiedContactState()).current;
        return !!actual && actual.id === opportunity.id && canCommitBackupRestoreDataEpoch(epoch)
          && (actual.status !== 'finished' || actual.reason === 'delivered')
          && await valid(actual) === 'valid' && Date.now() < actual.expiresAt;
      };
      const cameraContinuation = createCameraReplyContinuation({
        current: currentCameraReply,
        delivered: async () => {
          const actual = (await readUnifiedContactState()).current;
          if (actual?.id !== opportunity.id) return [];
          return (await Promise.all(actual.savedMessageIds.map(id => loadChatSessionMessage(sessionId, id))))
            .filter((message): message is SubjectiveMessage => !!message);
        },
        continue: async (event, instruction) => {
          const observationIds = cameraObservationIdsFromResults([event.result]);
          const continuationCurrent = async () => await currentCameraReply()
            && await cameraObservationResponsesCurrent(observationIds);
          const token = `${opportunity.id}:camera-continuation`;
          let transported = false;
          try {
            const continued = await runOrdinaryProactiveToolTurn({ ...input, dataEpoch: epoch, signal: roundController.signal,
              ...(opportunity.qwenChatSource
                ? { qwenChatLayout: contactQwenChatMode(opportunity), messages } : {}),
              sourceSessionId: sessionId, sourceMessageId: opportunity.id, triggerSystemMessage: facts,
              recoveryContext: !opportunity.important && !opportunity.phoneEmergency ? opportunity.scheduleRecovery?.context : undefined,
              responseInstruction: `${currentActual.asleep && opportunity.important ? SLEEPING_BODY_CONTACT_TASK : UNIFIED_CONTACT_TASK}\n\n${instruction}`,
              bodyOnlyRetry: { continuationMessages: event.continuationMessages, completedResults: [event.result] },
              beforeModelRequest: async () => {
                if (opportunity.qwenChatSource) await readQwenChatSource(contactQwenChatSource(opportunity), loadChatSessionMessage, input.connection, contactQwenChatMode(opportunity));
                return beginProactiveBudgetRequest({ connection: input.connection, dataEpoch: epoch, preflightCount: 1,
                purpose: opportunity.important ? 'other' : 'proactive-contact',
                beforeStart: async () => {
                  if (!await continuationCurrent()) throw new Error('camera_reply_stale');
                  await changeUnifiedContactState(state => {
                    if (state.current?.id !== opportunity.id || state.current.requests >= 3) throw new Error('contact-tool-request-limit');
                    state.current.requests += 1;
                  }, epoch);
                  return token;
                }, beforeTransport: async () => {
                  if (!await continuationCurrent()) throw new Error('camera_reply_stale');
                }, afterAdmission: () => beginCoordinatedTransport(opportunity) });
              },
              onTransportAttempt: event => { if (event.phase === 'started') transported = true; },
            });
            if (continued.diagnostics.wasTruncated || !await continuationCurrent()) return;
            const contents = parseOrdinaryProactiveLiteResponseWithDiagnostics(continued.assistantText,
              { allowExternalActionClaims: event.result.ok }).messages;
            const additions = contents.map((content, index) => ({ ...createSubjectiveMessage('I', content, { source: 'proactive-message' }),
              id: `${opportunity.id}:camera-response:${index}` }));
            await saveCameraResponseDraft({ observationIds, replyId: `${opportunity.id}:camera-continuation`,
              messages: additions, dataEpoch: epoch, canCommit: () => canCommitBackupRestoreDataEpoch(epoch) });
            const saved = await appendMessagesToChatSession(sessionId, additions, {
              requireActiveSession: true, dataEpoch: epoch, beforeAppend: continuationCurrent });
            const delivered = saved.messages.filter(message => additions.some(item => item.id === message.id));
            await completeCameraResponseDelivery({ observationIds, sessionId, dataEpoch: epoch,
              messageIds: delivered.map(message => message.id) });
            emitChatMessagesAppended({ sessionId, messages: delivered, source: 'camera-same-contact' });
            await recordCameraObservationReply({ turnId: opportunity.id, sessionId, dataEpoch: epoch,
              results: [event.result], messageIds: delivered.map(message => message.id) });
          } finally {
            if (!transported) await releaseUnstartedProactiveBudgetRequest({ connection: input.connection, dataEpoch: epoch,
              requestToken: token }).catch(() => undefined);
          }
        },
      });
      cameraBodyCommitted = cameraContinuation.bodyCommitted;
      let requestIndex = 0;
      let lastRequestToken: string | undefined;
      const turn = await runOrdinaryProactiveToolTurn({ ...input, dataEpoch: epoch, signal: roundController.signal,
        ...(opportunity.qwenChatSource
          ? { qwenChatLayout: contactQwenChatMode(opportunity), messages } : {}),
        sourceSessionId: sessionId, sourceMessageId: opportunity.id,
        wishValidity: !opportunity.important ? async (op, storedMessages) => await valid(op, storedMessages) === 'valid' : undefined,
        phoneLimitValidity: Platform.OS === 'android' && !currentActual.asleep && !currentActual.occupied ? async () => {
          const active = (await readUnifiedContactState()).current;
          const actual = await actualContactState();
          return !!active && active.id === opportunity.id && active.status === 'requesting'
            && Date.now() < active.expiresAt && !actual.asleep && !actual.occupied
            && await valid(active) === 'valid';
        } : undefined,
        triggerSystemMessage: facts,
        ...(pastPreparation && opportunity.sources.some(isContactPastMemorySource) ? {
          refreshTriggerSystemMessage: async () => {
            await refreshPast(opportunity);
            // From this serialization boundary onward, a changed source stops
            // the result; it cannot certify an answer with a different version.
            pastFrozen = true;
            facts = ordinaryFacts();
            return facts;
          },
        } : {}),
        recoveryContext: !opportunity.important && !opportunity.phoneEmergency ? opportunity.scheduleRecovery?.context : undefined,
        responseInstruction: opportunity.phoneEmergency ? PHONE_EMERGENCY_CONTACT_TASK
          : currentActual.asleep && opportunity.important ? SLEEPING_BODY_CONTACT_TASK : UNIFIED_CONTACT_TASK,
        allowPhoneEmergencySilence: !!opportunity.phoneEmergency,
        bodyOnlyRetry: retry,
        beforeModelRequest: async () => {
          if (opportunity.qwenChatSource) await readQwenChatSource(contactQwenChatSource(opportunity), loadChatSessionMessage, input.connection, contactQwenChatMode(opportunity));
          return beginProactiveBudgetRequest({ connection: input.connection, dataEpoch: epoch,
          purpose: opportunity.important ? 'other' : 'proactive-contact',
          preflightCount: !retry && requestIndex === 0 ? 2 : 1,
          beforeStart: async () => {
            const token = await beforeRequest();
            lastRequestToken = token;
            if (opportunity.phoneEmergency && requestIndex === 0) await changeUnifiedContactState(state => {
              if (state.current?.id !== opportunity.id) throw Error('contact-opportunity-replaced');
              state.current.phoneEmergency = opportunity.phoneEmergency;
            }, epoch);
            if (wishMaterial && requestIndex === 0) await changeUnifiedContactState(state => {
              if (state.current?.id !== opportunity.id) throw Error('contact-opportunity-replaced');
              state.current.sources = opportunity.sources;
              state.current.sourceMessages = opportunity.sourceMessages;
            }, epoch);
            requestIndex += 1; return token;
          }, beforeTransport, afterAdmission: () => beginCoordinatedTransport(opportunity) });
        },
        onTransportAttempt: event => {
          if (event.phase === 'started') onTransportStarted();
          else if (event.outcome) onTransportFinished(event.outcome);
        },
        onSettlement: settlement,
        onLateSettlement: async event => {
          if (event.result.toolId === CAMERA_LOOK_ONCE_TOOL_ID) lateCameraCallIds.add(event.result.callId);
          if ((await readUnifiedContactState()).current?.status !== 'finished') await settlement(event);
          await cameraContinuation.settled(event);
        },
      });
      const emptyBody = async (contactFailureReason: string, contactProtocolFailureCode?: string,
        parsed?: { rawMessageCount: number; keptMessageCount: number }) => {
        const error = Object.assign(new Error('contact-empty'), { contactFailureReason, contactProtocolFailureCode });
        try {
          const observe = (read: () => unknown): unknown => { try { return read(); } catch { return undefined; } };
          const shape = (value: unknown): string => {
            if (typeof value !== 'string') return 'unknown';
            const raw = value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
            if (!raw) return 'empty';
            try {
              const root: unknown = JSON.parse(raw);
              if (typeof root === 'string') return 'root_string';
              if (Array.isArray(root)) return !root.length ? 'root_empty_array'
                : root.every(item => typeof item === 'string') ? 'root_strings' : 'root_mixed_array';
              if (root && typeof root === 'object') {
                const object = root as { message?: unknown; messages?: unknown };
                if (typeof object.message === 'string') return 'message_string';
                if (Array.isArray(object.messages)) return !object.messages.length ? 'messages_empty'
                  : object.messages.every(item => typeof item === 'string') ? 'messages_strings' : 'messages_mixed';
                return 'object_other';
              }
              return 'scalar_other';
            } catch { return /^<(?:state|internal|message|messages)\b/iu.test(raw) ? 'tagged' : 'non_json'; }
          };
          const raw = observe(() => turn.diagnostics.rawContent), text = observe(() => turn.assistantText);
          // This is the last returned/projected turn, not raw HTTP or a history of earlier requests.
          const snapshot = normalizeContactBodyDiagnostics({
            visible: observe(() => 'visibleReplyStatus' in turn.diagnostics ? turn.diagnostics.visibleReplyStatus : undefined),
            format: observe(() => turn.diagnostics.rawContentFormat),
            direct: observe(() => 'directContentChars' in turn.diagnostics ? turn.diagnostics.directContentChars : undefined),
            reasoning: observe(() => 'reasoningContentChars' in turn.diagnostics ? turn.diagnostics.reasoningContentChars : undefined),
            projected: observe(() => Array.isArray(turn.contents) ? turn.contents.length : undefined),
            rawChars: observe(() => turn.diagnostics.rawContentChars), rawShape: shape(raw),
            loopChars: typeof text === 'string' ? text.length : undefined, loopShape: shape(text),
            parsed: observe(() => parsed?.rawMessageCount), kept: observe(() => parsed?.keptMessageCount),
            state: observe(() => turn.state.status), failure: observe(() => turn.state.failureCode),
            cancel: observe(() => turn.state.cancellation?.reason), requests: observe(() => turn.requestCount),
            rounds: observe(() => turn.toolRounds), card: observe(() => turn.completedWithVisibleCard),
          });
          Object.assign(error, { contactBodyDiagnostics: snapshot });
        } catch { /* Observation cannot replace the original failure or alter its retry. */ }
        try {
          const direct = Object.getOwnPropertyDescriptor(turn.diagnostics, 'fixedEnvelopeRawDirect')?.value;
          if (typeof direct === 'string' && 'responseObserved' in turn.diagnostics && turn.diagnostics.responseObserved === true
            && turn.state.status !== 'cancelled' && !turn.state.cancellation && lastRequestToken) {
            await runBackupRestoreDataEpochCommit(epoch, async () => {
              const active = (await readUnifiedContactState()).current;
              if (!canCommitBackupRestoreDataEpoch(epoch) || !active || active.id !== opportunity.id
                || active.epoch !== epoch || active.sessionId !== sessionId || active.status !== 'requesting'
                || active.requestToken !== lastRequestToken || Date.now() >= active.expiresAt) return;
              await saveBaiyunLatestBadEnvelopeSnapshot(buildProactiveBadEnvelopeSnapshot({
                connectionName: input.connection.name, model: input.connection.model,
                rawDirectContent: direct, finishReason: 'finishReason' in turn.diagnostics ? turn.diagnostics.finishReason : undefined,
                failureReason: contactFailureReason,
                source: { opportunityId: active.id, sessionId: active.sessionId, requestToken: lastRequestToken!,
                  requestNumber: active.requests, phase: active.failedAt !== null ? 'failure_retry'
                    : active.requests > 1 ? 'body_continuation' : 'initial' },
              }));
            });
          }
        } catch { /* Evidence is optional: cache/read failures must preserve the original body failure. */ }
        return error;
      };
      if (turn.diagnostics.wasTruncated) throw await emptyBody('body_truncated');
      if (opportunity.phoneEmergency && turn.silent) return { kind: 'silent' };
      const parsed = parseOrdinaryProactiveLiteResponseWithDiagnostics(turn.assistantText, {
        allowExternalActionClaims: turn.results.some(result => result.ok) || opportunity.sources.some(source => source.kind === 'web'
          || (source.kind === 'social' && shareMaterials.some(entry => entry.id === source.id && entry.version === source.version
            && entry.externalActionRecorded))),
      });
      if (!parsed.messages.length) {
        // Preserve the Runtime's existing empty-result failure path, with host-only detail.
        throw await emptyBody(turn.protocolFailure ? 'body_protocol_failed'
          : parsed.reasons.includes('外部动作完成声称') ? 'body_action_filtered'
            : parsed.reasons.includes('清洗为空') ? 'body_cleaned_empty' : 'body_parse_empty', turn.protocolFailure?.code, parsed);
      }
      return parsed.messages;
    },
    save: async (message, op) => {
      const receipt = (await readUnifiedContactState()).toolReceipt;
      const observationIds = cameraObservationIdsFromResults((receipt?.completedResults ?? []).filter(result => !lateCameraCallIds.has(result.callId)));
      if (!await cameraObservationResponsesCurrent(observationIds)) return false;
      if (observationIds.length) {
        const existing = await getCameraObservationResponse(observationIds[0]);
        const additions = existing?.draft?.messages ?? op.messages.map((content, index) => ({ id: contactMessageId(op, index),
          role: 'I' as const, content, createdAt: message.createdAt, source: 'proactive-message' as const }));
        await saveCameraResponseDraft({ observationIds, replyId: op.id, messages: additions, dataEpoch: epoch,
          canCommit: () => canCommitBackupRestoreDataEpoch(epoch) });
      }
      const already = await loadChatSessionMessage(op.sessionId, message.id);
      if (already) return already.content === message.content;
      if (await valid(op) !== 'valid') return false;
      const result = await appendMessagesToChatSession(op.sessionId, [message], {
        requireActiveSession: true,
          ...(observationIds.length ? { dataEpoch: epoch } : {}),
          beforeAppend: async storedMessages => Date.now() < op.expiresAt && await valid(op, storedMessages) === 'valid'
            && await cameraObservationResponsesCurrent(observationIds),
      });
      return result.messages.some(saved => saved.id === message.id && saved.content === message.content);
    },
    delivered: async (message, op) => {
      emitChatMessagesAppended({ sessionId: op.sessionId, messages: [message], source: 'proactive-message' });
      const refs = op.sources.filter((source): source is UnifiedContactShareRef => source.kind === 'web' || source.kind === 'nearby');
      for (let attempt = 0; attempt < 4; attempt += 1) {
        try {
          const consumed = await commitUnifiedContactShares(refs, [message], op.sessionId, message.createdAt, () => canCommitBackupRestoreDataEpoch(epoch));
          if (consumed.length) await changeUnifiedContactState(state => {
            if (state.current?.id === op.id) state.current.handledSources = [...new Set([
              ...(state.current.handledSources ?? []), ...refs.filter(ref => consumed.includes(ref.id)).map(ref => `${ref.kind}:${ref.id}`),
            ])];
          }, epoch);
          break;
        } catch { if (attempt === 3) break; }
      }
      const { notifyProactiveMessage } = await import('./proactiveMessages');
      await notifyProactiveMessage((await actualContactState()).settings, [message.content]);
    },
    completed: async op => {
      const receipt = (await readUnifiedContactState()).toolReceipt;
      await completeCameraResponseDelivery({ observationIds: cameraObservationIdsFromResults(
        (receipt?.completedResults ?? []).filter(result => !lateCameraCallIds.has(result.callId))),
        sessionId: op.sessionId, dataEpoch: epoch, messageIds: op.savedMessageIds });
      await recordCameraObservationReply({ turnId: op.id, sessionId: op.sessionId, dataEpoch: epoch,
        results: (receipt?.completedResults ?? []).filter(result => !lateCameraCallIds.has(result.callId)),
        messageIds: op.savedMessageIds });
      if (op.phoneEmergency && op.reason === 'silent_ready') return;
      void cameraBodyCommitted?.().catch(() => undefined);
      if (!(await loadActiveMessageCoordinatorSnapshot()).records.some(record => record.topicKey === op.id)) {
        await recordActiveMessageDelivery({ source: 'proactive-message', priority: op.important ? 'contextual' : 'soft',
          messageCount: op.savedMessageIds.length, topicKey: op.id });
      }
      for (const source of op.sources) if (source.kind === 'heart') await markHeartContactHandled(source.id, Date.now());
      for (const source of op.sources) if (source.kind === 'period') await markPeriodContactHandled(source.id, Date.now());
      const saved = await Promise.all(op.savedMessageIds.map(id => loadChatSessionMessage(op.sessionId, id)));
      await commitUnifiedContactShares(op.sources.filter((source): source is UnifiedContactShareRef => source.kind === 'web' || source.kind === 'nearby' || source.kind === 'social'),
        saved.filter((message): message is SubjectiveMessage => message !== null), op.sessionId, Date.now(), () => canCommitBackupRestoreDataEpoch(epoch));
      if (state.failure) await changeUnifiedContactState(next => { next.failureAcknowledgedId = state.failure!.opportunityId; }, epoch);
    },
    waitBetweenBubbles: () => new Promise(resolve => setTimeout(resolve, 320)),
  }, candidate); }
  finally {
    if (activeContactAbort === roundController) activeContactAbort = undefined;
    stopForEpoch(); if (roundTimer) clearTimeout(roundTimer);
    const finished = (await readUnifiedContactState()).current;
    if (finished?.id === candidate.id && finished.status === 'finished') await control.complete(finished).catch(() => undefined);
  }
}

/** This preflight runs before either the contact scheduler or the life tick's urgent scheduler. */
export async function prepareUnifiedContactWaitingAffect(supplied?: Parameters<typeof dispatch>[0]): Promise<void> {
  if (Platform.OS !== 'android' || isChatReplyInFlight()) return;
  const epoch = captureBackupRestoreDataEpoch();
  if (epoch === null) return;
  const config = supplied ? undefined : await loadAiConfigPreferencesSnapshot();
  const resolved = config ? resolveLifeCreativeConfig(config) : undefined;
  const input = supplied ?? (resolved?.connection && resolved.apiKey.trim() && config
    ? { apiKey: resolved.apiKey, connection: resolved.connection, profile: config.profile } : undefined);
  if (!input || input.priority) return;
  const chat = await loadChatStateFast({ activeMessageLimit: 1 });
  const sessionId = chat.activeSessionId;
  if (!sessionId) return;
  const eligible = async () => {
    if (!canCommitBackupRestoreDataEpoch(epoch) || isChatReplyInFlight()
      || (await loadChatStateFast({ activeMessageLimit: 1 })).activeSessionId !== sessionId) return false;
    const now = Date.now();
    const [state, actual, desires, affect] = await Promise.all([
      readUnifiedContactState(), actualContactState(), loadJunluoDesireSnapshot(now), loadJunluoAffectState(),
    ]);
    if (state.current && state.current.status !== 'finished' || await priorityContact(state, now)) return false;
    const emergency = await readEmergencyContact(state.phoneEmergencyCare);
    if (emergency && decidePhoneEmergencyContact(emergency, state.phoneEmergencyCare ?? {}, now).due) return false;
    const values = Object.fromEntries(Object.values(desires.desires).map(dimension => [dimension.id, dimension.effectiveValue]));
    const motives = selectContactMotives(values, affect.relationshipPhase.phase, state.motiveLastSelectedAt);
    return contactOpportunityDecision({ now, state, ...actual, chatBusy: false, motives,
      highest: motives.length ? values[motives[0]] : 0 }).allowed;
  };
  if (!await eligible()) return;
  const waiting = selectContactWaiting(sessionId, await loadContactWaitingMessages(sessionId), Date.now());
  if (!waiting) return;
  const { runAssistantAffectUpdate } = await import('../ai/assistantAffectRuntime');
  const { loadAssistantState } = await import('../ai/assistantState');
  await runAssistantAffectUpdate({ ...input, dataEpoch: epoch, currentState: await loadAssistantState(),
    contactWaiting: waiting, canRefreshContactWaiting: eligible });
}

export function runUnifiedContact(input: Parameters<typeof dispatch>[0]): Promise<number> {
  if (contactHostPaused) return Promise.resolve(0);
  const hostGeneration = contactHostGeneration;
  const epoch = captureBackupRestoreDataEpoch();
  if (!running) running = (async () => {
    if (Platform.OS === 'android') await import('./proactiveDeviceControlAndroid')
      .then(module => module.ensureAndroidProactiveDeviceControl()).catch(() => undefined);
    if (!input.schedulerHeld) await prepareUnifiedContactWaitingAffect(input).catch(() => undefined);
    const begin = () => contactHostPaused || hostGeneration !== contactHostGeneration ? Promise.resolve(0) : dispatch(input);
    return input.schedulerHeld ? begin()
      : runScheduledAiCall('unified-contact', 'background', begin).then(result => result.ok ? result.value : 0);
  })()
    .then(async delivered => {
      const finished = (await readUnifiedContactState()).current;
      if (finished?.status === 'finished') await getProactiveDeviceControl()?.complete(finished).catch(() => undefined);
      // Reuse the existing native check for a deferred preflight, never re-arm a past alarm in a loop.
      if (canCommitBackupRestoreDataEpoch(epoch)) await changeUnifiedContactState(state => {
        state.checkAfterAt = delivered ? undefined : (state.checkAfterAt ?? 0) > Date.now() ? state.checkAfterAt
          : state.current?.status === 'finished' && state.current.reason === 'silent' ? undefined : Date.now() + 60_000;
      }, epoch).catch(() => undefined);
      return delivered;
    })
    .finally(async () => {
    running = undefined;
    await import('../life/sleepPlanRuntime').then(module => module.reconcileSleepPlanLocally()).catch(() => undefined);
  });
  return running;
}

export async function checkUnifiedContact(): Promise<number> {
  if (Platform.OS !== 'android' && Platform.OS !== 'windows') return 0;
  if (contactHostPaused) return 0;
  const hostGeneration = contactHostGeneration;
  await changeUnifiedContactState(() => undefined);
  const snapshot = await loadAiConfigPreferencesSnapshot();
  const config = resolveLifeCreativeConfig(snapshot);
  if (!config.connection || !config.apiKey.trim()) return 0;
  if (contactHostPaused || hostGeneration !== contactHostGeneration) return 0;
  return runUnifiedContact({ apiKey: config.apiKey, connection: config.connection, profile: snapshot.profile });
}

/** Read by the existing single native sleep/contact task registration. No timer here. */
export async function getNextUnifiedContactAt(now = Date.now()): Promise<number | null> {
  if (Platform.OS !== 'android' && Platform.OS !== 'windows') return null;
  if (contactHostPaused) return null;
  const shared = getProactiveDeviceControl()?.snapshot();
  const local = await readUnifiedContactState(now);
  const state = shared ? withSharedContactLedger(local, shared) : local;
  const checkAfterAt = state.checkAfterAt ?? 0;
  const config = resolveLifeCreativeConfig(await loadAiConfigPreferencesSnapshot());
  if (!config.connection || !config.apiKey.trim()) return null;
  const op = state.current;
  const budgetAt = await getProactiveBudgetRetryAt(config.connection, now,
    op?.status === 'waiting_retry' || op?.reason === 'proactive-budget-deferred' && op.requests > 0 ? 1 : 2);
  if (op && op.status !== 'finished') {
    if (op.status === 'handoff') return null;
    if (now >= op.expiresAt) return op.expiresAt;
    if (op.status === 'ready' && op.reason === 'proactive-budget-deferred') {
      // Keep the registered timestamp at/after its deadline: native delivery compares it exactly.
      return Math.min(op.expiresAt, Math.max(checkAfterAt, budgetAt ?? 0));
    }
    if (op.status === 'waiting_retry') return op.retryAt === null ? null : Math.min(op.expiresAt, Math.max(op.retryAt, budgetAt || 0, checkAfterAt));
    if (op.status === 'requesting') return op.transportState === 'not_started'
      ? Math.max(op.requestStartedAt + CONTACT_MODEL_REQUEST_TIMEOUT_MS, checkAfterAt) : op.requestStartedAt + CONTACT_MODEL_REQUEST_TIMEOUT_MS;
    return Math.min(op.expiresAt, Math.max(op.saveRetryAt ?? op.requestStartedAt + CONTACT_MODEL_REQUEST_TIMEOUT_MS, checkAfterAt));
  }
  const [actual, desires, affect] = await Promise.all([
    actualContactState(), loadJunluoDesireState(), loadJunluoAffectState(),
  ]);
  if (!actual.enabled) return null;
  const values = Object.fromEntries(Object.entries(desires.desires).map(([id, dimension]) => [id, dimension.currentValue]));
  const motives = selectContactMotives(values, affect.relationshipPhase.phase, state.motiveLastSelectedAt);
  const important = Platform.OS === 'android' ? await priorityContact(state, now) : undefined;
  const emergency = Platform.OS === 'android' && !important ? await readEmergencyContact(state.phoneEmergencyCare) : null;
  const phoneDecision = emergency ? decidePhoneEmergencyContact(emergency, state.phoneEmergencyCare ?? {}, now) : null;
  const decision = contactOpportunityDecision({ now, state, ...actual, chatBusy: isChatReplyInFlight(),
    motives, highest: motives.length ? values[motives[0]] : 0, importantExpiresAt: important?.expiresAt });
  if (decision.allowed && important) return Math.min(important.expiresAt, Math.max(budgetAt || 0, checkAfterAt,
    important.expiresAt - (important.kind === 'heart' ? 10 * 60_000 : PERIOD_PRIORITY_WINDOW_MS)));
  let phoneAt: number | null = null;
  if (emergency?.latest && actual.enabled && !actual.asleep && !actual.occupied
    && !contactIsPaused(actual.pause, now) && !isChatReplyInFlight()
    && (state.day !== contactLocalDay(now) || state.used < CONTACT_DAY_LIMIT)) {
    // Continue the existing local native probe while this round is active, even
    // when no new records justified a model request at the previous probe.
    const last = state.phoneEmergencyCare?.lastOpportunity;
    const probeAt = phoneDecision?.nextAt ?? (emergency.latest.phase === 'active' && last?.id === emergency.latest.id
      ? last.at + PHONE_EMERGENCY_CONTACT_INTERVAL_MS : null);
    if (probeAt !== null && probeAt !== undefined) {
      const until = JSON.parse(emergency.latest.version).until as number;
      phoneAt = emergency.latest.phase === 'active' ? Math.min(probeAt, until) : probeAt;
    }
  }
  const dueAt = decision.allowed ? Math.max(state.initializedAt, state.lastEndedAt, state.lastOrdinaryReplyAt)
    + contactWaitMs(values[motives[0]])! : decision.nextAt;
  const targets = [dueAt, phoneAt].filter((at): at is number => at !== undefined && at !== null);
  return targets.length ? Math.max(Math.min(...targets), budgetAt || 0, checkAfterAt) : null;
}
