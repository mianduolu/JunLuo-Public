import { buildGlobalCognitionContext } from '../ai/globalCognition';
import { sendChatCompletion, sendChatCompletionResult } from '../ai/openAiCompatibleProvider';
import type { AiConnection, AiProfile } from '../ai/types';
import { loadAssistantState } from '../ai/assistantState';
import { isAutomaticRemoteAiAllowed, loadAutomaticRemoteAiPolicy } from '../runtime/automaticRemoteAiPolicy';
import { isTimelineEligibleMemory, loadMemories, type MemoryEntry } from '../memory/memoryStore';
import { createMemoryMaterialPreparation } from '../memory/memoryCurrentMaterials';
import { createMemoryUsageReceipt, settleSavedMemoryUsage, type MemoryUsageReceipt, type MemoryUsageReference } from '../memory/memoryReplyUsage';
import { getPromptContextProfileConfig, getPromptContextProfileForSource } from '../ai/promptContextProfile';
import { recordActiveMessageDelivery } from '../proactive/activeMessageCoordinator';
import { buildJunluoDesirePromptPaper } from '../life/junluoDesireMetabolism';
import { loadJunluoDesireSnapshot } from '../life/junluoDesireRuntime';
import {
  canCommitBackupRestoreDataEpoch,
  captureBackupRestoreDataEpoch,
  runBackupRestoreDataEpochCommit,
} from '../backup/backupRestoreCoordinator';
import { persistDeliveredLetterContext, recoverLetterContexts } from './letterContext';
import { createDueLetterDeliveryCoordinator } from './letterDeliveryCoordinator';
import { loadLetterWritingMaterials } from './letterWritingMaterials';
import {
  createAiIncomingLetter,
  createFutureLetter,
  getMailboxLock,
  loadLetterSettings,
  loadLetters,
  markProactiveLetterRequestStarted,
  markProactiveLetterSourcesSaved,
  markDueFutureLettersReady,
  updateLetter,
  type LetterEntry,
  type LetterSource,
} from './letterStore';
import { notifyIncomingLetter, scheduleLetterDueNotification } from './letterNotifications';
import {
  loadLetterDateTicketCandidatesBetween,
  prepareRelationshipDateAnnualMaterials,
  type LetterDateTicketCandidate,
} from './letterDateTickets';
import {
  buildAnnualLetterMaterials,
  buildFreshLetterMaterials,
  buildLetterDateTicketMaterial,
  canStartProactiveLetter,
  JUNLUO_LETTER_REPLY_PROMPT,
  JUNLUO_PROACTIVE_LETTER_PROMPT,
  makeLetterGenerationKey,
  parseGeneratedLetters,
  resolveLetterDateTicketWindow,
  resolveLetterMaterialOccurredAt,
  resolveLetterOpenAt,
  resolveRelationshipDateCurrentLetterSealAt,
  selectFreshLetterMaterials,
} from './letterGenerationContract';

type DeliveryOptions = {
  apiKey?: string;
  backupRestoreLeaseHeld?: boolean;
  connection?: AiConnection;
  dataEpoch?: number | null;
  memoryOrganizerConnection?: AiConnection;
  memoryOrganizerKey?: string;
  now?: number;
  profile?: AiProfile;
};

function localDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

const dueLetterDeliveryCoordinator = createDueLetterDeliveryCoordinator({
  canCommitDataEpoch: canCommitBackupRestoreDataEpoch,
  loadLetters,
  runDataEpochCommit: runBackupRestoreDataEpochCommit,
  updateLetter,
});

async function generateReplyToLetter({
  apiKey,
  backupRestoreLeaseHeld,
  connection,
  letter,
  profile,
  onMemoryPrepared,
}: {
  apiKey: string;
  backupRestoreLeaseHeld?: boolean;
  connection: AiConnection;
  letter: LetterEntry;
  profile: AiProfile;
  onMemoryPrepared?: (receipt: MemoryUsageReceipt) => void;
}) {
  const cognition = await buildGlobalCognitionContext(
    letter.content,
    'letter',
    { backupRestoreLeaseHeld, touchMemory: false },
  );
  const messages = [
    {
      id: `${letter.id}:you`,
      role: 'you' as const,
      content: `${letter.title}\n\n${letter.content}`,
      createdAt: letter.createdAt,
      source: 'letter' as const,
    },
  ];
  const desirePaper = await loadJunluoDesireSnapshot()
    .then(buildJunluoDesirePromptPaper)
    .catch(() => '');
  const writingMaterials = await loadLetterWritingMaterials(Date.now(), letter.id);
  const captureUsage = () => onMemoryPrepared?.(createMemoryUsageReceipt(`letter-reply:${letter.id}`,
    getPromptContextProfileConfig(getPromptContextProfileForSource('letter.reply')).allowMemory
      && cognition.memoryContext.trim() ? cognition.memoryUsageReferences ?? [] : []));
  captureUsage();
  const reply = await sendChatCompletion({
    ambientContext: cognition.runtimeContext,
    apiKey,
    connection,
    memoryContext: cognition.memoryContext,
    refreshMemoryMaterials: async () => {
      await cognition.refreshMemoryMaterials?.();
      const latestWritingMaterials = await loadLetterWritingMaterials(Date.now(), letter.id);
      captureUsage();
      return { memoryContext: cognition.memoryContext,
        responseInstruction: [latestWritingMaterials, desirePaper, JUNLUO_LETTER_REPLY_PROMPT].filter(Boolean).join('\n\n') };
    },
    messages,
    profile,
    contextSource: 'letter.reply',
    metricContextSource: 'letter.reply',
    responseInstruction: [writingMaterials, desirePaper, JUNLUO_LETTER_REPLY_PROMPT].filter(Boolean).join('\n\n'),
  });
  return reply.join('\n\n');
}

async function deliverUserLetter(
  letter: LetterEntry,
  options: Required<Pick<DeliveryOptions, 'apiKey' | 'connection' | 'profile'>> & DeliveryOptions,
  dueAt: number,
) {
  let receipt: MemoryUsageReceipt | undefined;
  return dueLetterDeliveryCoordinator.deliver(letter.id, {
    dataEpoch: options.dataEpoch ?? null,
    dueAt,
    failureReason: (error) => error instanceof Error ? error.message : '回信生成失败',
    generateReply: (current) => generateReplyToLetter({
      apiKey: options.apiKey,
      backupRestoreLeaseHeld: false,
      connection: options.connection,
      letter: current,
      profile: options.profile,
      onMemoryPrepared: (prepared) => { receipt = prepared; },
    }),
    onSaved: delivered => settleSavedMemoryUsage({
      receipt, savedAt: delivered.deliveredAt ?? Date.now(), dataEpoch: options.dataEpoch ?? null,
    }),
    notify: (delivered, dataEpoch) => notifyIncomingLetter(delivered, { dataEpoch }),
    persistContext: (delivered, dataEpoch) => persistDeliveredLetterContext(delivered, {
      continuationAi: options.memoryOrganizerConnection && options.memoryOrganizerKey?.trim()
        ? { apiKey: options.memoryOrganizerKey, connection: options.memoryOrganizerConnection }
        : undefined,
      dataEpoch,
    }),
    recordDelivery: (delivered) => recordActiveMessageDelivery({
      messageCount: 1,
      priority: 'critical',
      source: 'letter',
      topicKey: delivered.id,
    }),
  });
}

export async function deliverDueLetters(options: DeliveryOptions = {}) {
  const now = options.now ?? Date.now();
  const dataEpoch = options.dataEpoch === undefined
    ? captureBackupRestoreDataEpoch()
    : options.dataEpoch;
  if (dataEpoch === null) {
    dueLetterDeliveryCoordinator.pendingLetterIds([], dataEpoch);
    return { delivered: 0, readyFutureLetters: 0 };
  }
  let changed = 0;
  const prepared = await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
    await recoverLetterContexts(dataEpoch);
    const readyFutureLetters = await markDueFutureLettersReady(now);
    const letters = await loadLetters();
    const invalidatedIds = new Set<string>();
    const retainedIds = new Set(dueLetterDeliveryCoordinator.pendingLetterIds(letters, dataEpoch,
      id => invalidatedIds.add(id)));
    if (!options.apiKey?.trim() || !options.connection || !options.profile) {
      return { due: [] as LetterEntry[], readyFutureLetters };
    }
    const assistantState = await loadAssistantState().catch(() => null);
    if (assistantState?.lifeMode === 'sleeping') {
      return { due: [] as LetterEntry[], readyFutureLetters };
    }
    const due = letters
      .filter((letter) => letter.kind === 'exchange' && letter.direction === 'you-to-ai')
      .filter((letter) => !invalidatedIds.has(letter.id) && (retainedIds.has(letter.id)
        || (letter.status === 'waiting_ai' || letter.status === 'failed') && (letter.dueAt ?? Infinity) <= now))
      .sort((left, right) => (left.dueAt ?? left.createdAt) - (right.dueAt ?? right.createdAt));
    return { due, readyFutureLetters };
  });
  if (!prepared.committed) return { delivered: 0, readyFutureLetters: 0 };
  const { due, readyFutureLetters } = prepared.value;
  for (const letter of readyFutureLetters) {
    if (!letter.notificationId) {
      await notifyIncomingLetter(letter, { dataEpoch }).catch(() => undefined);
    }
  }

  if (!options.apiKey?.trim() || !options.connection || !options.profile || !due.length) {
    return { delivered: changed, readyFutureLetters: readyFutureLetters.length };
  }

  for (const letter of due) {
    changed += await deliverUserLetter(letter, {
      ...options,
      apiKey: options.apiKey,
      connection: options.connection,
      dataEpoch,
      profile: options.profile,
    }, now);
  }
  return { delivered: changed, readyFutureLetters: readyFutureLetters.length };
}

type LetterMaterial = {
  id: string;
  occurredAt: number;
  importance: number;
  anchored: boolean;
  text: string;
};

type ContextualLetterMaterials = {
  annual: string[];
  dateKey: string;
  desirePaper: string;
  fresh: LetterMaterial[];
  generationKey: string;
  sourceIds: string[];
  ticket: LetterDateTicketCandidate | null;
  refresh: () => Promise<void>;
  usageReferences: () => MemoryUsageReference[];
};

function memoryMaterial(memory: MemoryEntry): LetterMaterial {
  const occurredAt = resolveLetterMaterialOccurredAt(memory);
  return {
    id: `memory:${memory.id}`,
    occurredAt,
    importance: memory.importance,
    anchored: memory.pinned || memory.anchor || memory.importance >= 8,
    text: `${new Date(occurredAt).toLocaleDateString('zh-CN')}｜${memory.title}\n${memory.content}`,
  };
}

async function fetchContextualMaterials(now: number): Promise<ContextualLetterMaterials> {
  const preparation = createMemoryMaterialPreparation();
  const dateKey = localDateKey(new Date(now));
  const ticketWindow = resolveLetterDateTicketWindow(now);
  const [letters, settings, memories, tickets, desire] = await Promise.all([
    loadLetters(),
    loadLetterSettings(),
    loadMemories({ includeArchived: false, currentOnly: true }).catch(() => []),
    loadLetterDateTicketCandidatesBetween(ticketWindow.startAt, ticketWindow.endAt).catch(() => []),
    loadJunluoDesireSnapshot(now).catch(() => null),
  ]);
  const settled = new Set([
    ...(settings.settledSourceIds ?? []),
    ...letters.flatMap((letter) => letter.sourceIds ?? []),
  ]);
  const offered = new Set(settings.offeredDateTicketIds ?? []);
  const ticket = tickets.find((candidate) => !offered.has(candidate.dateId)) ?? null;
  const annualRelationshipTicket = ticket?.source === 'relationship-date' && ticket.annual;
  let selectedMemories = annualRelationshipTicket ? [] : memories.filter(isTimelineEligibleMemory);
  const memoryMaterials = selectedMemories.map(memoryMaterial);
  const fresh = annualRelationshipTicket
    ? []
    : selectFreshLetterMaterials(memoryMaterials, settled);
  const selectedIds = desire?.selectedIds.filter((id) => id !== 'remind_you') ?? [];
  const desirePaper = desire && selectedIds.length
    ? buildJunluoDesirePromptPaper({ ...desire, selectedIds })
    : '';
  const freshIds = new Set(fresh.map(material => material.id));
  selectedMemories = selectedMemories.filter(memory => freshIds.has(`memory:${memory.id}`));
  const annualPreparation = annualRelationshipTicket
    ? await prepareRelationshipDateAnnualMaterials({ now, ticket, preparation })
    : null;
  const sourceIds = [
    ...fresh.map((material) => material.id),
    ...(ticket ? [`${ticket.source}:${ticket.dateId}`] : []),
  ];
  const materials: ContextualLetterMaterials = {
    annual: annualPreparation?.materials ?? [],
    dateKey,
    desirePaper,
    fresh,
    generationKey: makeLetterGenerationKey({
      dateKey,
      dateTicketId: ticket?.dateId,
      sourceIds,
    }),
    sourceIds,
    ticket,
    usageReferences: () => {
      const sentIds = new Set(materials.fresh.slice(0, 3).map(material => material.id));
      return [...preparation.usageReferences(selectedMemories.filter(memory => sentIds.has(`memory:${memory.id}`))),
        ...(annualPreparation?.usageReferences() ?? [])];
    },
    refresh: async () => {
      selectedMemories = await preparation.refresh(selectedMemories, isTimelineEligibleMemory);
      materials.fresh = selectFreshLetterMaterials(selectedMemories.map(memoryMaterial), settled);
      if (annualPreparation) materials.annual = await annualPreparation.refresh();
      materials.sourceIds = [
        ...materials.fresh.map(material => material.id),
        ...(ticket ? [`${ticket.source}:${ticket.dateId}`] : []),
      ];
      preparation.assertCurrent();
    },
  };
  await materials.refresh();
  return materials;
}

function formatContextualLetterMaterials(materials: ContextualLetterMaterials) {
  const sections: string[] = [];
  if (materials.ticket) {
    sections.push(buildLetterDateTicketMaterial({
      dateId: materials.ticket.dateId,
      dateTime: new Date(materials.ticket.scheduledAt).toLocaleString('zh-CN'),
      eventTitle: materials.ticket.eventTitle,
      eventNote: materials.ticket.eventNote,
    }));
  }
  if (materials.fresh.length) {
    sections.push(buildFreshLetterMaterials(
      materials.dateKey,
      materials.fresh.map((material) => material.text),
    ));
  }
  if (materials.annual.length) sections.push(buildAnnualLetterMaterials(materials.annual));
  if (materials.desirePaper) sections.push(materials.desirePaper);
  return sections.join('\n\n');
}

async function isAutomaticLetterRequestAllowed() {
  try { return isAutomaticRemoteAiAllowed(await loadAutomaticRemoteAiPolicy({ strict: true })); }
  catch { return false; }
}

async function generateContextualLetter(input: {
  apiKey: string;
  backupRestoreLeaseHeld?: boolean;
  connection: AiConnection;
  materials: ContextualLetterMaterials;
  canUseMaterials: () => boolean;
  onRequestStart: () => Promise<boolean>;
  profile: AiProfile;
  onMemoryPrepared?: (receipt: MemoryUsageReceipt) => void;
}) {
  const materialText = formatContextualLetterMaterials(input.materials);
  const cognition = await buildGlobalCognitionContext(
    materialText,
    'letter',
    {
      ambientCategories: ['time', 'weather'],
      ambientIncludeUnavailable: [],
      backupRestoreLeaseHeld: input.backupRestoreLeaseHeld,
      includeMemory: false,
      includeNearbyWorld: false,
    },
  );
  const contextSource = 'letter.delivery' as const;
  const writingMaterials = await loadLetterWritingMaterials(Date.now());
  const result = await sendChatCompletionResult({
    ambientContext: cognition.runtimeContext,
    apiKey: input.apiKey,
    beforeTransportRequest: async () => {
      if (!await isAutomaticLetterRequestAllowed()) throw new Error('letter-automatic-disabled');
      if (!(await input.onRequestStart())) throw new Error('letter-request-commit-aborted');
    },
    connection: input.connection,
    contextSource,
    refreshMemoryMaterials: async () => {
      await input.materials.refresh();
      await input.materials.refresh();
      const latestWritingMaterials = await loadLetterWritingMaterials(Date.now());
      if (!input.canUseMaterials()) throw new Error('letter-materials-no-longer-eligible');
      if (!await isAutomaticLetterRequestAllowed()) throw new Error('letter-automatic-disabled');
      input.onMemoryPrepared?.(createMemoryUsageReceipt(input.materials.generationKey, input.materials.usageReferences()));
      return { messages: [], responseInstruction: [latestWritingMaterials, formatContextualLetterMaterials(input.materials),
        JUNLUO_PROACTIVE_LETTER_PROMPT].filter(Boolean).join('\n\n') };
    },
    messages: [],
    profile: input.profile,
    responseInstruction: [writingMaterials, materialText, JUNLUO_PROACTIVE_LETTER_PROMPT].filter(Boolean).join('\n\n'),
  });
  return parseGeneratedLetters(
    result.assistantText,
    input.materials.ticket ? [input.materials.ticket.dateId] : [],
  );
}

async function retryLocalSave<T>(save: () => Promise<T>) {
  for (let attempt = 0; ; attempt++) {
    try { return await save(); }
    catch (error) { if (attempt === 3) throw error; }
  }
}

export async function maybeCreateContextualAiLetter(options: DeliveryOptions = {}) {
  const now = options.now ?? Date.now();
  if (!options.apiKey?.trim() || !options.connection || !options.profile) return 0;
  if (!await isAutomaticLetterRequestAllowed()) return 0;
  if (await getMailboxLock()) return 0;
  const assistantState = await loadAssistantState().catch(() => null);
  if (assistantState?.lifeMode === 'sleeping' || assistantState?.lifeMode === 'self-time') return 0;
  const dataEpoch = options.dataEpoch === undefined
    ? captureBackupRestoreDataEpoch()
    : options.dataEpoch;
  if (dataEpoch === null) return 0;

  const [letters, settings, materials] = await Promise.all([
    loadLetters(),
    loadLetterSettings(),
    fetchContextualMaterials(now),
  ]);
  const today = localDateKey(new Date(now));
  const alreadyRequestedToday = (
    settings.lastProactiveRequestAt !== undefined
    && localDateKey(new Date(settings.lastProactiveRequestAt)) === today
  ) || letters.some((letter) => (
    letter.direction !== 'you-to-ai'
    && localDateKey(new Date(letter.createdAt)) === today
    && !!letter.generationKey
  ));
  const lastSavedAt = Math.max(
    settings.lastProactiveSavedAt ?? 0,
    ...letters
      .filter((letter) => !!letter.generationKey)
      .map((letter) => letter.createdAt),
  ) || undefined;
  const canUseMaterials = () => canStartProactiveLetter({
    alreadyRequestedToday,
    hasDateTicket: !!materials.ticket,
    hasFreshMaterial: materials.fresh.length > 0,
    hasRelatedDesire: !!materials.desirePaper,
    lastSavedAt,
    now,
  });
  if (!canUseMaterials()) return 0;

  let receipt: MemoryUsageReceipt | undefined;
  const generated = await generateContextualLetter({
    apiKey: options.apiKey,
    backupRestoreLeaseHeld: options.backupRestoreLeaseHeld,
    connection: options.connection,
    materials,
    canUseMaterials,
    onRequestStart: async () => {
      const marked = await runBackupRestoreDataEpochCommit(dataEpoch, () => (
        markProactiveLetterRequestStarted({
          generationKey: materials.generationKey,
          now,
        })
      ));
      return marked.committed;
    },
    profile: options.profile,
    onMemoryPrepared: prepared => { receipt = prepared; },
  }).catch(() => null);
  if (!generated?.rootValid) return 0;

  const source: LetterSource = materials.ticket?.source ?? 'memory';
  let saved = 0;
  let usageSavedAt: number | undefined;
  const settleNewLetter = async (letter: LetterEntry) => {
    if (usageSavedAt !== undefined) return;
    usageSavedAt ??= letter.createdAt;
    await settleSavedMemoryUsage({ receipt, savedAt: usageSavedAt, dataEpoch });
  };
  if (generated.currentLetter) {
    const sealAt = resolveRelationshipDateCurrentLetterSealAt(now, materials.ticket);
    let created = false;
    const committed = await runBackupRestoreDataEpochCommit(dataEpoch, () => retryLocalSave(() => (
      sealAt === null
        ? createAiIncomingLetter({
            content: generated.currentLetter!.content,
            generationKey: materials.generationKey,
            onCreated: () => { created = true; },
            source,
            sourceIds: materials.sourceIds,
            title: generated.currentLetter!.title,
          })
        : createFutureLetter({
            content: generated.currentLetter!.content,
            dateTicketId: materials.ticket!.dateId,
            dueAt: sealAt,
            generationKey: `${materials.generationKey}:current`,
            onCreated: () => { created = true; },
            openWhen: { kind: 'date_ticket', dateId: materials.ticket!.dateId },
            source,
            sourceIds: materials.sourceIds,
            title: generated.currentLetter!.title,
          })
    )));
    if (committed.committed && committed.value && created) {
      saved += 1;
      await settleNewLetter(committed.value);
      if (sealAt === null) {
        await runBackupRestoreDataEpochCommit(dataEpoch, () => persistDeliveredLetterContext(committed.value!, { dataEpoch }))
          .catch(() => undefined);
        await notifyIncomingLetter(committed.value, { dataEpoch }).catch(() => undefined);
      } else {
        await scheduleLetterDueNotification(committed.value, { dataEpoch }).catch(() => undefined);
      }
    }
  }

  if (generated.futureLetter) {
    const dueAt = resolveLetterOpenAt(
      generated.futureLetter.openWhen,
      now,
      materials.ticket ? [{ dateId: materials.ticket.dateId, at: materials.ticket.scheduledAt }] : [],
    );
    if (dueAt !== null) {
      let created = false;
      const committed = await runBackupRestoreDataEpochCommit(dataEpoch, () => retryLocalSave(() => (
        createFutureLetter({
          content: generated.futureLetter!.content,
          dateTicketId: generated.futureLetter!.openWhen.kind === 'date_ticket'
            ? generated.futureLetter!.openWhen.dateId
            : undefined,
          dueAt,
          generationKey: materials.generationKey,
          onCreated: () => { created = true; },
          openWhen: generated.futureLetter!.openWhen,
          source,
          sourceIds: materials.sourceIds,
          title: generated.futureLetter!.title,
        })
      )));
      if (committed.committed && committed.value && created) {
        saved += 1;
        await settleNewLetter(committed.value);
        await scheduleLetterDueNotification(committed.value, { dataEpoch }).catch(() => undefined);
      }
    }
  }

  if (saved > 0) {
    await retryLocalSave(() => runBackupRestoreDataEpochCommit(dataEpoch, () => (
      markProactiveLetterSourcesSaved({
        dateTicketId: materials.ticket?.dateId,
        now,
        sourceIds: materials.sourceIds,
      })
    ))).catch(() => undefined);
  }
  return saved;
}
