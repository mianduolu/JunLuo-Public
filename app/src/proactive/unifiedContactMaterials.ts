import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import { selectNearStatusConversation } from '../ai/assistantNearStatus';
import { formatChatAfterglowMessageTime } from '../chat/chatAfterglowProbe';
import { formatPreviousAffect } from '../ai/assistantAffectPaper';
import type { JunluoAffectStateV1 } from '../life/junluoInnerState';
import { buildJunluoDesirePromptPaper, DESIRE_LINES, type JunluoDesireEffectiveSnapshot } from '../life/junluoDesireMetabolism';
import { formatNearStatusLifeEntries } from '../ai/nearStatusLifeMaterialFormat';
import { CONTACT_AFFECT_AFTER_CHAT, type ContactMotive, buildUnsentContactMessages, contactMessageId } from './unifiedContact';
import { formatContactWaiting, formatContactWaitingDuration, type ContactWaiting } from './contactWaiting';
import type { StoredUnifiedContactState } from './unifiedContactStore';
import type { BaiyunContinuityEvent } from '../ai/behavior/continuityEvent';
import { formatProactiveIdleDuration } from './proactiveLitePrompt';

const reasonText: Record<ContactMotive, string> = {
  miss_you: '想念 you', be_chosen: '想被 you 选择', care_for_you: '想照顾 you',
  speak_to_you: '有些话想说给 you 听', affection_with_you: '想和 you 贴贴', desire_you: '想要 you',
};

export function buildContactFailureMaterial(state: StoredUnifiedContactState): string {
  const failure = state.failure;
  if (!failure || state.failureAcknowledgedId === failure.opportunityId) return '';
  return `【上次没发出的联系】\n\n尝试时间：${formatChatAfterglowMessageTime(failure.attemptedAt)}\n当时想联系 you 的缘由：${failure.motives.map(id => reasonText[id]).join('、')}。\n\n那次消息没有发送成功。`;
}

export function buildContactHandoffMaterial(state: StoredUnifiedContactState): string {
  const op = state.current;
  const unsent = op?.status === 'handoff' ? op.messages.filter((_message, i) => !op.savedMessageIds.includes(contactMessageId(op, i))) : [];
  return [buildContactFailureMaterial(state), buildUnsentContactMessages(unsent)].filter(Boolean).join('\n\n');
}

export type ContactMaterialEntry = {
  id: string; version: string; text: string; care?: boolean; kind?: 'web' | 'nearby' | 'social' | 'current_state' | 'weekly_review';
  // Selection-only metadata: never a new persisted business record or model field.
  own?: 'progress' | 'experience' | 'state' | 'plan'; occurredAt?: number;
  sameSource?: string; focusSources?: string[]; priority?: boolean; background?: boolean;
  currentStateOrder?: number; newRevision?: boolean; pastMemory?: boolean;
  formatToBudget?: (maxChars: number) => string;
};
export function contactFocusSourceKeys(refs: readonly { sessionId?: string }[]) {
  return [...new Set(refs.flatMap(ref => ref.sessionId?.startsWith('focus-source:')
    ? [`focus:${ref.sessionId.slice('focus-source:'.length)}`] : []))];
}
export function shouldOfferOrdinaryContactLifeItem(item: { id: string; toolId?: string }): boolean {
  if (item.id === 'ambient:phone' || item.id === 'ambient:weather') return false;
  if (['body-signal:steps:', 'body-signal:sleep:', 'body-signal:battery:', 'body-signal:heart:']
    .some(prefix => item.id.startsWith(prefix))) return false;
  return !['system_status.get_battery', 'body_signal.get_steps_history', 'body_signal.get_sleep_history',
    'phone_context.get_recent_activity', 'phone_context.get_app_usage'].includes(item.toolId ?? '');
}
function materialRank(entry: ContactMaterialEntry) {
  if (entry.priority) return 0;
  if (entry.background) return 7;
  if (entry.own) return { progress: 1, experience: 2, state: 3, plan: 4 }[entry.own];
  return entry.care ? 6 : 5;
}
export function selectContactMaterialEntries(entries: readonly ContactMaterialEntry[], options: {
  ordinary?: boolean; preamble?: string; preferNewMaterials?: boolean; preferPastMemory?: boolean;
} = {}): ContactMaterialEntry[] {
  // Unannotated callers keep their original order and contract (including priority body contact).
  let ranked = options.ordinary || entries.some(entry => entry.own || entry.priority || entry.background)
    ? [...entries].sort((a, b) => materialRank(a) - materialRank(b)
      || (options.preferNewMaterials ? Number(b.newRevision || b.kind === 'weekly_review') - Number(a.newRevision || a.kind === 'weekly_review') : 0)
      || (options.preferPastMemory ? Number(!!b.pastMemory) - Number(!!a.pastMemory) : 0)
      || (b.occurredAt ?? 0) - (a.occurredAt ?? 0)) : entries;
  if (options.ordinary) {
    const states = ranked.filter(entry => entry.kind === 'current_state')
      .sort((a, b) => (a.currentStateOrder ?? 0) - (b.currentStateOrder ?? 0));
    let index = 0;
    ranked = ranked.map(entry => entry.kind === 'current_state' ? states[index++] : entry);
  }
  const preambleSize = options.preamble?.length ?? 0;
  const available = 1000 - preambleSize - (preambleSize ? 2 : 0);
  const reserved = ranked.filter(entry => entry.own && entry.text.trim() && entry.text.length <= available)
    .sort((a, b) => ({ progress: 0, experience: 1, state: 2, plan: 3 }[a.own!])
      - ({ progress: 0, experience: 1, state: 2, plan: 3 }[b.own!]) || (b.occurredAt ?? 0) - (a.occurredAt ?? 0))[0];
  const selected: ContactMaterialEntry[] = [];
  const seen = new Set<string>();
  const sources = new Set<string>();
  const focusSources = new Set<string>();
  let characters = preambleSize; let care = 0;
  for (const entry of reserved ? [reserved, ...ranked] : ranked) {
    if (options.ordinary ? selected.length >= (reserved ? 2 : 1)
      : selected.length + Number(!!preambleSize) >= 8) break;
    if (options.ordinary && reserved && selected.length && entry.own && entry.kind !== 'web') continue;
    const key = entry.kind === 'current_state' || entry.kind === 'weekly_review' ? `${entry.kind}:${entry.id}` : entry.id;
    const focusKeys = [...(entry.focusSources ?? []), ...(entry.sameSource?.startsWith('focus:') ? [entry.sameSource] : [])];
    if (focusKeys.some(source => focusSources.has(source))) continue;
    if (seen.has(key) || sources.has(entry.sameSource ?? key) || !entry.text.trim() || (entry.care && care >= 3)) continue;
    const separator = characters ? 2 : 0;
    const text = options.ordinary && (entry.kind === 'current_state' || entry.kind === 'weekly_review' || entry.pastMemory) && entry.formatToBudget
      ? entry.formatToBudget(1000 - characters - separator) : entry.text;
    if (!text.trim() || characters + text.length + separator > 1000) continue;
    selected.push(text === entry.text ? entry : { ...entry, text }); seen.add(key); characters += text.length + separator;
    sources.add(entry.sameSource ?? key);
    for (const source of focusKeys) focusSources.add(source);
    if (entry.care) care += 1;
  }
  const indexOf = (entry: ContactMaterialEntry) => ranked.findIndex(item => item.id === entry.id && item.kind === entry.kind);
  return selected.sort((a, b) => indexOf(a) - indexOf(b));
}

export function buildContactMotivePaper(motives: readonly ContactMotive[]) {
  const ordinaryLines: Partial<Record<ContactMotive, string>> = {
    care_for_you: 'I 想知道 you 现在在做什么。',
    affection_with_you: 'I 想和 you 亲近，也想得到 you 的亲昵。',
    desire_you: 'I 想要 you，想和 you 有恋人式的身体亲密。',
  };
  return motives.length ? `【I 想来找 you 的缘由】\n\n${motives.map(id => ordinaryLines[id] ?? DESIRE_LINES[id]).join('\n')}` : '';
}

export function contactCareSelection(event: BaiyunContinuityEvent, messages: readonly SubjectiveMessage[], now: number,
  deviceEvidenceAt?: number) {
  const lastContact = messages.filter(message => message.role === 'I' && message.source === 'proactive-message'
    && message.deliveryStatus !== 'failed' && message.createdAt <= now).at(-1)?.createdAt;
  const evidenceAt = event.careEvidence?.latest?.sentAt ?? event.careEvidence?.origin.sentAt
    ?? deviceEvidenceAt;
  // Only an existing, explicit contact-time source; never infer appointments from words.
  const due = !!event.careTimeSources?.contact && event.nextActionAt !== undefined && event.nextActionAt <= now;
  return { occurredAt: evidenceAt,
    priority: due || lastContact !== undefined && evidenceAt !== undefined && evidenceAt <= now && evidenceAt > lastContact };
}

export function buildUnifiedContactFacts(input: {
  now: number; lastYouAt?: number; messages: readonly SubjectiveMessage[];
  affect: JunluoAffectStateV1; desires: JunluoDesireEffectiveSnapshot; motives: ContactMotive[];
  entries: ContactMaterialEntry[]; bodyFacts?: string; handoff?: string; ordinary?: boolean;
  separateChat?: boolean;
  contactWaiting?: ContactWaiting;
  expiredShareInstruction?: string;
}): string {
  const messages = selectNearStatusConversation(input.messages);
  const waiting = input.ordinary === true ? formatContactWaiting(input.contactWaiting, input.now) : '';
  const affect = input.ordinary === false || waiting ? formatPreviousAffect(input.affect) : '';
  const idleDuration = input.ordinary === true ? formatContactWaitingDuration(input.now, input.lastYouAt)
    : input.ordinary === false && input.lastYouAt !== undefined
      ? formatProactiveIdleDuration(input.now - input.lastYouAt) : '';
  return [
    `【这次 I 能看见的近况】\n\n现在是 ${formatChatAfterglowMessageTime(input.now)}。`,
    idleDuration ? `I 已经有 ${idleDuration} 没有在聊天里听见 you 说话了。` : '',
    waiting,
    input.ordinary === true ? input.expiredShareInstruction : '',
    !input.separateChat && messages.length ? JSON.stringify(messages.map(message => ({ role: message.role,
      time: formatChatAfterglowMessageTime(message.createdAt), content: message.content }))) : '',
    affect,
    affect && messages.some(message => message.createdAt > input.affect.updatedAt) ? CONTACT_AFFECT_AFTER_CHAT : '',
    input.ordinary === false ? buildJunluoDesirePromptPaper({ ...input.desires, selectedIds: input.motives })
      : buildContactMotivePaper(input.motives),
    formatNearStatusLifeEntries(input.entries.map(entry => ({ promptLine: entry.text }))),
    input.bodyFacts,
    input.handoff,
  ].filter(Boolean).join('\n\n');
}
