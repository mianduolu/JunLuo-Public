import { innerMaterialKey, type InnerMaterialRef } from '../chat/chatAfterglowState';
import { loadChatSessionMessage } from '../chat/chatStorage';
import { formatNearStatusLifeEntries, formatNearStatusRecordedAt } from '../ai/nearStatusLifeMaterialFormat';
import { loadNearbyOutingSegments } from './nearbyWorldActiveEvents';
import type { NearbyOutingSegment } from './nearbyOuting';

const prefix = 'nearby-outing:';
export const isNearbyOutingMaterialId = (id: string) => id.startsWith(prefix);
export const nearbyOutingRef = (segment: NearbyOutingSegment): InnerMaterialRef => ({
  kind: 'life', id: prefix + segment.id, createdAt: segment.occurredAt, revision: innerMaterialKey(segment),
});

async function chatSourceMatches(segment: NearbyOutingSegment) {
  const source = segment.chatSource;
  if (!source) return segment.kind !== 'home-report';
  const message = await loadChatSessionMessage(source.sessionId, source.messageId);
  return !!message && message.role === 'you' && message.createdAt === source.createdAt
    && message.deliveryStatus !== 'failed' && message.content.includes(source.quote)
    && innerMaterialKey([message.id, message.role, message.createdAt, message.content]) === source.revision;
}

export async function nearbyOutingSourcesMatch(refs: readonly InnerMaterialRef[]) {
  const selected = refs.filter(ref => isNearbyOutingMaterialId(ref.id));
  if (!selected.length) return true;
  const segments = await loadNearbyOutingSegments();
  for (const ref of selected) {
    const segment = segments.find(item => prefix + item.id === ref.id);
    if (!segment || innerMaterialKey(nearbyOutingRef(segment)) !== innerMaterialKey(ref)
      || !await chatSourceMatches(segment)) return false;
  }
  return true;
}

/** Called only after the original opportunity exists. An old batch never gains new sources. */
export async function prepareNearbyOutingMaterial(input: {
  through: number; activatedAt: number; read: Record<string, string>; refs?: readonly InnerMaterialRef[];
}) {
  const fixed = input.refs?.filter(ref => isNearbyOutingMaterialId(ref.id));
  if (fixed && !fixed.length) return [];
  try {
    const segments = await loadNearbyOutingSegments();
    const eligible: NearbyOutingSegment[] = [];
    for (const segment of segments) {
      const ref = nearbyOutingRef(segment);
      if (fixed ? !fixed.some(item => innerMaterialKey(item) === innerMaterialKey(ref))
        : segment.occurredAt <= input.activatedAt || segment.occurredAt > input.through
          || input.read[ref.id] === ref.revision) continue;
      if (await chatSourceMatches(segment)) eligible.push(segment);
    }
    if (fixed && eligible.length !== fixed.length) throw new Error('outing-source-changed');
    eligible.sort((a, b) => a.occurredAt - b.occurredAt || a.id.localeCompare(b.id));
    return eligible.filter(item => item.outingId === eligible[0]?.outingId);
  } catch (error) {
    if (fixed) throw error; // A referenced source is unavailable, not deleted or empty.
    return [];
  }
}

type LifeEntry = { promptLine: string };
type ProvidedChat = { sessionId: string; messageIds: ReadonlySet<string> };
export function selectNearbyOutingMaterial(input: {
  segments: readonly NearbyOutingSegment[]; through: number; limit: number;
  lifeEntries?: readonly LifeEntry[]; providedChat?: readonly ProvidedChat[];
}) {
  const base = [...input.lifeEntries ?? []];
  const lines: LifeEntry[] = [];
  const selected: NearbyOutingSegment[] = [];
  for (const segment of input.segments) {
    if (selected.length >= Math.min(6, input.limit)) break;
    if (segment.occurredAt > input.through) continue;
    const source = segment.chatSource;
    if (source && input.providedChat?.some(chat => chat.sessionId === source.sessionId
      && chat.messageIds.has(source.messageId))) {
      selected.push(segment); // The original chat is already in this exact request.
      continue;
    }
    if (base.length + lines.length >= 8) break;
    const fact = source ? `you 的原话：${source.quote}` : segment.kind === 'home-location'
      ? '定位记录显示 you 已到家附近。' : '定位记录显示 you 的位置发生了移动。';
    const promptLine = [
      ...(!lines.length ? ['和 you 一起出门', `这趟出门的首条记录：${formatNearStatusRecordedAt(segment.firstRecordedAt)}`, '这次的新记录：'] : []),
      `${formatNearStatusRecordedAt(segment.occurredAt)}｜${fact}`,
      ...(segment.nearbyReference ? [`附近参照：${segment.nearbyReference}`] : []),
    ].join('\n');
    if (Array.from(formatNearStatusLifeEntries([...base, ...lines, { promptLine }])).length > 1000) continue;
    lines.push({ promptLine }); selected.push(segment);
  }
  return { refs: selected.map(nearbyOutingRef), entries: [...base, ...lines] };
}

export function appendNearbyOutingMaterial(text: string, base: readonly LifeEntry[], entries: LifeEntry[]) {
  const original = formatNearStatusLifeEntries([...base]);
  const updated = formatNearStatusLifeEntries(entries);
  return original ? text.replace(original, updated) : [text, updated].filter(Boolean).join('\n\n');
}
