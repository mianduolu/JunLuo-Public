import type { InnerMaterialRef, InnerUpdateState } from '../chat/chatAfterglowState';
import { innerMaterialKey } from '../chat/chatAfterglowState';
import { compareChatAfterglowPositions, formatChatAfterglowMessageTime, formatChatAfterglowConversation, type ChatAfterglowMessage } from '../chat/chatAfterglowProbe';
import type { PokeInteraction } from '../chat/chatPokeExperience';
import { loadHeartFeedbackCandidates, loadHeartFeedbackRound } from '../chat/heartCorpusStore';
import { loadMemory, loadMemorySourcePage, type MemoryEntry } from '../memory/memoryStore';
import { getBaiyunContinuityEvent, listBaiyunContinuityEvents, listBaiyunContinuityLinks, listChatCareMatters,
  type BaiyunContinuityEventLink } from './behavior/continuityLedger';
import { isOrdinaryReminderCareEvent, type BaiyunContinuityEvent } from './behavior/continuityEvent';
import { buildChatCareContext, formatCareLocalTime, toChatCareItem } from './behavior/chatCareUpdates';
import { isHeartCareMatter, type CareContextEvent } from './behavior/heartCareMatter';
import { buildNearStatusLifeMaterialSnapshot, hasConsumedLifeMaterial, lifeMaterialSourceRevision, nearStatusLifeSourcesMatch, type LifeMaterialItem } from './lifeMaterialHub';
import { formatNearStatusLifeEntries, selectNearStatusLifeEntries } from './nearStatusLifeMaterialFormat';
import { loadCameraModelObservationInnerMaterials, cameraModelObservationInnerSourcesMatch,
  isCameraModelObservationMaterialId } from '../camera/cameraModelObservationInnerMaterial';

const time = formatChatAfterglowMessageTime;
const careRevision = (event: BaiyunContinuityEvent) => event.schemaVersion === 3
  ? innerMaterialKey([event.careEvidence, event.status]) : innerMaterialKey([
  event.itemName, event.focusExcerpt, event.progress, event.status, event.durationMs,
  event.nextActionAt, event.careTimeSources,
  ...(isHeartCareMatter(event) ? [event.careEvidence] : []),
]);
const lifeRevision = lifeMaterialSourceRevision;
const isVoyage = (item: { id: string }) => item.id.startsWith('web-voyage:') || item.id.startsWith('github-voyage:');
const voyageTime = (item: LifeMaterialItem) => item.affectResultAt ?? item.occurredAt;
const dreamRevision = (dream: MemoryEntry) => innerMaterialKey([dream.createdAt, dream.content]);
type HeartRound = NonNullable<Awaited<ReturnType<typeof loadHeartFeedbackRound>>>;
const heartMessages = (round: HeartRound) => [...round.youMessages, ...round.iMessages]
  .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
const heartRevision = (round: HeartRound) => innerMaterialKey([round.entry.firstHeartedAt,
  heartMessages(round).map(message => [message.id, message.createdAt, message.role, message.content])]);

export function selectWantsCareMaterials(input: {
  events: readonly BaiyunContinuityEvent[]; links: readonly BaiyunContinuityEventLink[];
  messages: readonly ChatAfterglowMessage[]; state: InnerUpdateState;
}) {
  const ids = new Set(input.messages.map(message => message.id));
  const through = input.messages.length ? Math.max(...input.messages.map(message => message.createdAt)) : Infinity;
  const associated = (event: BaiyunContinuityEvent) => ids.has(event.source.sourceId)
    || [event.careEvidence?.origin.messageId, event.careEvidence?.latest?.messageId].some(id => id && ids.has(id))
    || input.links.some(link => link.eventId === event.id && (link.relation === 'source' || link.relation === 'message')
      && link.createdAt <= through && ids.has(link.targetId));
  return input.events.filter(event => (event.schemaVersion === 3
    ? event.careEvidence && ['open', 'waiting'].includes(event.status)
    : event.schemaVersion === 2 && (event.itemName || event.focusExcerpt)
      && (!isHeartCareMatter(event) || ['open', 'waiting'].includes(event.status)))
    && event.updatedAt <= through && (associated(event)
      || event.updatedAt > input.state.materials.activatedAt && input.state.materials.care[event.id] !== careRevision(event)))
    .sort((a, b) => Number(associated(b)) - Number(associated(a))
      || a.occurredAt - b.occurredAt || a.id.localeCompare(b.id)).slice(0, 3);
}

export async function prepareWantsMaterial(input: { state: InnerUpdateState; sessionId?: string;
  rounds?: readonly (readonly ChatAfterglowMessage[])[]; now: number; batchMaterials?: readonly InnerMaterialRef[];
  sleepCatchup?: boolean;
  pokeFacts?: readonly PokeInteraction[] }) {
  const included = (kind: InnerMaterialRef['kind'], id: string) => !input.batchMaterials
    || input.batchMaterials.some(ref => ref.kind === kind && ref.id === id);
  const events: CareContextEvent[] = [];
  for (let offset = 0; ; offset += 200) {
    const page = await listBaiyunContinuityEvents({ limit: 200, offset, readOnly: true });
    events.push(...page.filter(event => !isOrdinaryReminderCareEvent(event)
      && included('care', event.id) && !isHeartCareMatter(event)));
    if (page.length < 200) break;
  }
  for (const event of await listChatCareMatters()) {
    if (!included('care', event.id)) continue;
    const index = events.findIndex(existing => existing.id === event.id);
    if (index === -1) events.push(event);
    else events[index] = event;
  }
  const links = (await Promise.all(events.map(event => listBaiyunContinuityLinks(event.id, true)))).flat();
  const life = await buildNearStatusLifeMaterialSnapshot(input.now, {
    wantsFactsOnly: true,
    firstPaperVoyages: { refs: input.batchMaterials?.filter(ref => ref.kind === 'life' && isVoyage(ref)) },
    excludeSharedExperience: !!input.state.experience && !input.batchMaterials,
    includeAssistantSchedule: true,
    sleepFrom: input.rounds?.flat()[0]?.createdAt,
    sleepThrough: input.rounds?.flat().at(-1)?.createdAt ?? input.now,
    sleepRefs: input.batchMaterials,
  });
  if (life.debug?.dropped.length && input.batchMaterials) await nearStatusLifeSourcesMatch(
    input.batchMaterials.filter(ref => ref.kind === 'life' && !isCameraModelObservationMaterialId(ref.id)),
    life.items, life.debug.dropped);
  const newResult = (item: LifeMaterialItem) => ['co-reading', 'web-voyage', 'github-voyage'].includes(item.source)
    && item.affectResultAt !== undefined
    && item.affectResultAt > input.state.materials.activatedAt && item.affectResultAt <= input.now
    && input.state.materials.life[item.id] === undefined;
  const camera = await loadCameraModelObservationInnerMaterials({ now: input.now,
    activatedAt: input.state.materials.activatedAt, read: input.state.materials.life,
    refs: input.batchMaterials?.filter(ref => ref.kind === 'life') });
  const unread = [...life.items.filter(item =>
    included('life', item.id) && !hasConsumedLifeMaterial(input.state.materials.life[item.id], item)), ...camera];
  const voyages = unread.filter(isVoyage).sort((a, b) => voyageTime(a) - voyageTime(b) || a.id.localeCompare(b.id));
  let voyageIndex = 0;
  // Replace only voyage slots, then retain the existing real-result priority.
  const lifeCandidates = unread.map(item => isVoyage(item) ? voyages[voyageIndex++] : item)
    .sort((a, b) => Number(newResult(b)) - Number(newResult(a)));
  const dreamRef = input.batchMaterials?.find(ref => ref.kind === 'dream');
  const [selectedDream] = input.sleepCatchup ? [null] : input.batchMaterials
    ? [dreamRef ? await loadMemory(dreamRef.id) : null]
    : await loadMemorySourcePage('night-dream', input.state.materials.activatedAt, input.state.materials.dream, 1);
  const dream = selectedDream?.source === 'night-dream' ? selectedDream : null;
  let heart: HeartRound | null = null;
  for (const candidate of await loadHeartFeedbackCandidates(input.sessionId ? { sessionId: input.sessionId } : {})) {
    if (!included('heart', candidate.replyRoundId)) continue;
    if (input.state.materials.hearts.includes(candidate.replyRoundId)) continue;
    const resolved = await loadHeartFeedbackRound(candidate.replyRoundId);
    if (!resolved) continue;
    if (input.rounds && !heartMessages(resolved).every(message => input.rounds!.some(round => round.some(item => item.id === message.id)))) continue;
    heart = resolved; break;
  }
  return (roundCount: number, omittedChat?: { sessionId: string; messageIds: ReadonlySet<string> }) => {
    const messages = input.rounds?.slice(0, roundCount).flat() ?? [];
    const through = messages.at(-1)?.createdAt ?? input.now;
    const lifeItems = selectNearStatusLifeEntries(lifeCandidates.filter(item =>
      (item.source !== 'assistant-schedule' || item.occurredAt <= through)
      && (!isVoyage(item) || voyageTime(item) <= through)));
    const selectedCare = selectWantsCareMaterials({ events, links, messages, state: input.state });
    const materials: InnerMaterialRef[] = [];
    const parts: string[] = [];
    if (selectedCare.length) {
      parts.push(`【I 还惦记着的事】\n\n${selectedCare.map((event, index) => {
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
        materials.push({ kind: 'care', id: event.id, createdAt: event.updatedAt, revision: careRevision(event) });
        return `${context}\n记录时间：${time(event.updatedAt)}`;
      }).join('\n\n')}`);
    }
    if (lifeItems.length) {
      parts.push(formatNearStatusLifeEntries(lifeItems));
      materials.push(...lifeItems.map(item => ({ kind: 'life' as const, id: item.id,
        createdAt: item.occurredAt, revision: lifeRevision(item) })));
    }
    let conversation: string | undefined;
    let renderConversation: ((messages: readonly ChatAfterglowMessage[]) => string) | undefined;
    if (heart && (!input.rounds || heartMessages(heart).every(message => messages.some(item => item.id === message.id)))) {
      const heading = `【you 喜欢 I 说的这些话】\n\n点爱心的时间：${time(heart.entry.firstHeartedAt!)}`;
      if (input.rounds) {
        const heartIds = new Set(heartMessages(heart).map(message => message.id));
        const rounds = input.rounds.slice(0, roundCount);
        renderConversation = provided => rounds.map((round, index) => {
          const previous = rounds[index - 1]?.at(-1);
          const end = round.at(-1)!;
          const selected = provided.filter(message => (!previous || compareChatAfterglowPositions(message, previous) > 0)
            && compareChatAfterglowPositions(message, end) <= 0);
          const excerpt = formatChatAfterglowConversation(selected, input.pokeFacts?.filter(fact =>
            fact.pokedAt <= end.createdAt && fact.pokedAt > (previous?.createdAt ?? -Infinity)));
          return selected.some(message => heartIds.has(message.id)) ? `${heading}\n\n${excerpt}` : excerpt;
        }).join('\n\n');
        conversation = renderConversation(messages);
      } else {
        const remaining = heartMessages(heart).filter(message => omittedChat?.sessionId !== heart.sessionId
          || !omittedChat.messageIds.has(message.id));
        parts.push(remaining.length ? `${heading}\n\n${formatChatAfterglowConversation(remaining)}` : heading);
      }
      materials.push({ kind: 'heart', id: heart.entry.replyRoundId, createdAt: heart.entry.firstHeartedAt!, revision: heartRevision(heart) });
    }
    if (dream) {
      parts.push(`【I 做过的梦】\n\n记录时间：${time(dream.createdAt)}\n${dream.content}\n\n这是 I 梦见的事，不是现实里发生的事。醒来想起这个梦，I 心里有没有留下什么感觉呢？`);
      materials.push({ kind: 'dream', id: dream.id, createdAt: dream.createdAt, revision: dreamRevision(dream) });
    }
    // Background observations remain usable, but do not independently buy a request.
    const hasOpportunity = materials.some(ref => input.sleepCatchup ? ref.kind === 'heart' : ref.kind !== 'life')
      || lifeItems.some(newResult);
    return { text: parts.join('\n\n'), refs: materials, conversation, renderConversation, hasOpportunity, lifeEntries: lifeItems };
  };
}

export async function wantsMaterialSourcesMatch(refs: readonly InnerMaterialRef[]) {
  let life: Awaited<ReturnType<typeof buildNearStatusLifeMaterialSnapshot>> | undefined;
  for (const ref of refs) {
    if (ref.kind === 'care') {
      const event = await getBaiyunContinuityEvent(ref.id, true);
      if (!event || careRevision(event) !== ref.revision) return false;
    } else if (ref.kind === 'dream') {
      const dream = await loadMemory(ref.id);
      if (!dream || dream.source !== 'night-dream' || dreamRevision(dream) !== ref.revision) return false;
    } else if (ref.kind === 'heart') {
      const heart = await loadHeartFeedbackRound(ref.id);
      if (!heart || heartRevision(heart) !== ref.revision) return false;
    } else if (isCameraModelObservationMaterialId(ref.id)) {
      if (!await cameraModelObservationInnerSourcesMatch([ref])) return false;
    } else {
      life ??= await buildNearStatusLifeMaterialSnapshot(undefined, {
        wantsFactsOnly: true,
        firstPaperVoyages: { refs: refs.filter(item => item.kind === 'life' && isVoyage(item)) },
      });
      if (!await nearStatusLifeSourcesMatch([ref], life.items, life.debug?.dropped)) return false;
    }
  }
  return true;
}
