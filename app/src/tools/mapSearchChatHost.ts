import { canCommitBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { loadChatSessionMessage } from '../chat/chatStorage';
import { PRIMARY_CHAT_SESSION_ID } from '../chat/primaryChat';
import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import { numberCareMessages, type CareSourceMessage } from '../ai/behavior/chatCareUpdates';
import { loadNearbyWorldStatus } from '../nearby/nearbyWorldStore';
import { getEffectiveAmapPause } from '../nearby/amapQueryPolicy';
import { getMapSearchSessionReference, type MapSearchHostContext, type MapSearchSpec } from './mapSearchSession';

const normalize = (value?: string) => (value ?? '').normalize('NFKC').toLocaleLowerCase().replace(/\s+/gu, '');
function sameObject(left: MapSearchSpec, right: MapSearchSpec) {
  return left.kind === right.kind && normalize(left.query) === normalize(right.query)
    && normalize(left.city) === normalize(right.city) && normalize(left.destination) === normalize(right.destination);
}
function namesObject(text: string, search: MapSearchSpec) {
  const value = normalize(text);
  return value.includes(normalize(search.query)) && (search.kind === 'nearby'
    || (!!search.city && !!search.destination && value.includes(normalize(search.city)) && value.includes(normalize(search.destination))));
}
function namesRadius(text: string, radius: number) {
  const number = radius === 10 ? '(?:10|十)' : '(?:5|五)';
  return new RegExp(`(?:^|[^0-9零〇一二三四五六七八九十百千万两])${number}(?:公里|千米|km)`, 'u').test(normalize(text));
}

export function createMapSearchChatHost(input: {
  sourceSessionId: string; sourceMessageId: string; dataEpoch: number;
  signal?: AbortSignal;
  sources?: { messages: readonly CareSourceMessage[]; newMessageIds: readonly string[] };
  sourceMessage?: Pick<SubjectiveMessage, 'id' | 'role' | 'content' | 'createdAt'>;
}): MapSearchHostContext {
  const source = input.sourceMessage;
  const previous = getMapSearchSessionReference(input.sourceSessionId);
  const numbered = numberCareMessages(input.sources?.messages ?? []);
  const sourceMessageIds = source ? [source.id] : [];
  let bound: CareSourceMessage[] = [];
  let approvedRange: MapSearchSpec | undefined;
  let previousSourceCurrent: (() => Promise<boolean>) | undefined;
  const unchanged = async (message: CareSourceMessage) => {
    const current = await loadChatSessionMessage(input.sourceSessionId, message.id);
    return !!current && current.role === message.role && current.createdAt === message.sentAt && current.content === message.text;
  };
  const isSourceCurrent = async () => {
    if (!source || source.id !== input.sourceMessageId || source.role !== 'you'
      || input.sourceSessionId !== PRIMARY_CHAT_SESSION_ID || !canCommitBackupRestoreDataEpoch(input.dataEpoch)) return false;
    const current = await loadChatSessionMessage(input.sourceSessionId, source.id);
    if (!current || current.role !== 'you' || current.createdAt !== source.createdAt || current.content !== source.content) return false;
    for (const message of bound) if (!await unchanged(message)) return false;
    return !previousSourceCurrent || await previousSourceCurrent();
  };
  return {
    conversationId: input.sourceSessionId, requestId: input.sourceMessageId,
    dataEpoch: input.dataEpoch, sourceMessageIds, isSourceCurrent,
    authorize: async (search, continuation = false) => {
      if (input.signal?.aborted || !await isSourceCurrent() || ![3, 5, 10].includes(search.radiusKm)) return { allowed: false };
      const pause = getEffectiveAmapPause(await loadNearbyWorldStatus(), input.dataEpoch);
      const destinationMatches = previous?.dataEpoch === input.dataEpoch && search.kind === 'destination'
        && previous.spec.kind === 'destination'
        && normalize(previous.spec.query) === normalize(search.query) && normalize(previous.spec.city) === normalize(search.city)
        && previous.destinationChoices?.filter(names => names.includes(search.destination)).length === 1
        && await previous.isSourceCurrent();
      const selectedDestination = destinationMatches && previous!.spec.radiusKm === search.radiusKm;
      if (selectedDestination) {
        previousSourceCurrent = previous!.isSourceCurrent;
        sourceMessageIds.splice(0, sourceMessageIds.length, ...new Set([source!.id, ...previous!.sourceMessageIds]));
      }
      const needsRange = search.radiusKm !== 3 && !continuation && !selectedDestination
        && !(approvedRange && sameObject(approvedRange, search) && approvedRange.radiusKm === search.radiusKm
          && approvedRange.evidence?.from === search.evidence?.from && approvedRange.evidence?.quote === search.evidence?.quote);
      if (!needsRange && !pause) return { allowed: true };
      // Without a retry citation the ordinary query policy returns the existing
      // persisted/unsaved-pause receipt; this does not authorize an HTTP retry.
      if (!needsRange && !search.evidence) return { allowed: true, explicitRetry: false };
      const evidence = search.evidence;
      const message = evidence && Number.isInteger(evidence.from) && typeof evidence.quote === 'string' && evidence.quote.trim()
        ? numbered.find(item => item.messageIndex === evidence.from) : undefined;
      if (!message || message.role !== 'you' || !input.sources?.newMessageIds.includes(message.id)
        || !message.text.includes(evidence!.quote) || !Number.isFinite(message.sentAt)
        || message.sentAt > Date.now() || !await unchanged(message)) return { allowed: false };
      const priorSource = previous && await loadChatSessionMessage(input.sourceSessionId, previous.requestId);
      const priorMatches = previous?.dataEpoch === input.dataEpoch && (sameObject(previous.spec, search) || destinationMatches)
        && !!priorSource && priorSource.createdAt < message.sentAt
        && await previous.isSourceCurrent();
      const directObject = namesObject(evidence!.quote, search);
      if (!directObject && !priorMatches) return { allowed: false };
      const inheritsRange = !!pause && priorMatches && previous!.spec.radiusKm === search.radiusKm;
      // Meaning is selected by the current model; the host verifies only the real
      // quotation, exact search scope and chronological link, never a yes-word list.
      let proposal: CareSourceMessage | undefined;
      if (needsRange && !inheritsRange && !namesRadius(evidence!.quote, search.radiusKm)) {
        proposal = numbered.filter(item => item.role === 'I' && item.sentAt < message.sentAt
          && (namesRadius(item.text, 5) || namesRadius(item.text, 10))).at(-1);
        if (!priorMatches || !proposal || !namesRadius(proposal.text, search.radiusKm) || !await unchanged(proposal)) return { allowed: false };
        if (!priorSource || proposal.sentAt < priorSource.createdAt) return { allowed: false };
      }
      if (pause && (!Number.isFinite(pause.at) || message.sentAt <= pause.at)) return { allowed: false };
      bound = [message, ...(proposal ? [proposal] : [])];
      previousSourceCurrent = directObject && !inheritsRange ? undefined : previous!.isSourceCurrent;
      sourceMessageIds.splice(0, sourceMessageIds.length, ...new Set([source!.id, ...bound.map(item => item.id),
        ...(previousSourceCurrent ? previous!.sourceMessageIds : [])]));
      approvedRange = { ...search };
      return { allowed: true, explicitRetry: !!pause };
    },
  };
}
