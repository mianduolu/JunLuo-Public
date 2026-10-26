import {
  buildMemoryExperienceDeleteMutation,
  buildMemoryExperienceRecordMutation,
  assertPostNoticeReadSyncValueV1,
  projectPostReadingSyncValueV1,
} from './syncMemoryExperience';
import type {
  ChatCoreMutationEnvelope,
} from './syncChatCore';
import type {
  SyncMutationEntityRef,
} from './syncMutationEnvelope';
import {
  assertJsonValue,
  type JsonValue,
  type PlainMutationV1,
} from './syncProtocol';

export const MEMORY_EXPERIENCE_KEYS = Object.freeze({
  dreamState: 'junluo.life.dreamEngine.state',
  pendingDreams: 'junluo.life.dreamEngine.pendingDreams',
  actionSuggestionCooldowns: 'junluo.memory.actionSuggestionCooldowns.v1',
  baiyunHeartViewed: 'junluo.memory.baiyunHeartViewedThroughId',
  postRuntime: 'junluo.baiyunPosts.runtime.v1',
  postNoticeRead: 'junluo.posts.heartRead.v1',
});

export const MEMORY_EXPERIENCE_GLOBAL_KEYS = Object.freeze(
  Object.values(MEMORY_EXPERIENCE_KEYS),
);
const MEMORY_EXPERIENCE_GLOBAL_KEY_SET = new Set<string>(
  MEMORY_EXPERIENCE_GLOBAL_KEYS,
);

export type MemoryExperienceStorageChange =
  | { kind: 'set'; key: string; value: string }
  | { kind: 'remove'; key: string };

export type MemoryExperienceStorageReadPort = {
  getItem(key: string): Promise<string | null>;
};

export type MemoryExperienceEnvelopeFactory = (
  entity: SyncMutationEntityRef,
) => Promise<ChatCoreMutationEnvelope>;

type JsonRecord = { [key: string]: JsonValue };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseJson(raw: string | null, label: string): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${label} 不是有效 JSON，不能捕获同步变更。`);
  }
}

function jsonValue(value: unknown, label: string): JsonValue {
  try {
    assertJsonValue(value);
  } catch {
    throw new Error(`${label} 不是可同步 JSON。`);
  }
  return value;
}

function jsonEqual(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function nullableDateKey(value: unknown, label: string) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${label} 必须是 YYYY-MM-DD。`);
  }
  return value;
}

function parseDreamState(raw: string | null) {
  if (raw === null) return null;
  const parsed = parseJson(raw, 'dream state');
  if (!isRecord(parsed)) throw new Error('dream state 必须是对象。');
  return {
    lastAttemptDateKey: nullableDateKey(
      parsed.lastAttemptDateKey,
      'dream state.lastAttemptDateKey',
    ),
    lastBackfillDateKey: nullableDateKey(
      parsed.lastBackfillDateKey,
      'dream state.lastBackfillDateKey',
    ),
  } satisfies JsonRecord;
}

function finiteUnit(value: unknown, label: string) {
  if (
    typeof value !== 'number'
    || !Number.isFinite(value)
    || value < 0
    || value > 1
  ) {
    throw new Error(`${label} 必须是 0–1 的有限数字。`);
  }
  return value;
}

function timestamp(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} 必须是非负 Unix 毫秒整数。`);
  }
  return value as number;
}

function normalizeDream(value: unknown): JsonRecord {
  if (!isRecord(value)) throw new Error('pending dream 必须是对象。');
  if (typeof value.id !== 'string' || !value.id || value.id.length > 160) {
    throw new Error('pending dream.id 无效。');
  }
  if (
    typeof value.content !== 'string'
    || !value.content
    || value.content.length > 240
  ) {
    throw new Error('pending dream.content 无效。');
  }
  if (
    !Array.isArray(value.recallCues)
    || value.recallCues.length > 5
    || value.recallCues.some(
      (cue) => typeof cue !== 'string' || !cue || cue.length > 18,
    )
  ) {
    throw new Error('pending dream.recallCues 无效。');
  }
  const memoryId = value.memoryId === undefined ? null : value.memoryId;
  if (
    memoryId !== null
    && (typeof memoryId !== 'string' || !memoryId || memoryId.length > 160)
  ) {
    throw new Error('pending dream.memoryId 无效。');
  }
  const surfacedAt = value.surfacedAt === undefined ? null : value.surfacedAt;
  if (surfacedAt !== null) timestamp(surfacedAt, 'pending dream.surfacedAt');
  return jsonValue({
    arousal: finiteUnit(value.arousal, 'pending dream.arousal'),
    content: value.content,
    createdAt: timestamp(value.createdAt, 'pending dream.createdAt'),
    id: value.id,
    memoryId,
    recallCues: value.recallCues,
    surfacedAt,
    valence: finiteUnit(value.valence, 'pending dream.valence'),
  }, 'pending dream') as JsonRecord;
}

function parseDreams(raw: string | null) {
  if (raw === null) return new Map<string, JsonRecord>();
  const parsed = parseJson(raw, 'pending dreams');
  if (!Array.isArray(parsed)) throw new Error('pending dreams 必须是数组。');
  const byId = new Map<string, JsonRecord>();
  for (const value of parsed) {
    const dream = normalizeDream(value);
    const id = dream.id as string;
    if (byId.has(id)) throw new Error(`pending dreams 重复 id：${id}。`);
    byId.set(id, dream);
  }
  return byId;
}

function parseCooldowns(raw: string | null) {
  if (raw === null) return new Map<string, number>();
  const parsed = parseJson(raw, 'action suggestion cooldowns');
  if (!isRecord(parsed)) {
    throw new Error('action suggestion cooldowns 必须是对象。');
  }
  const cooldowns = new Map<string, number>();
  for (const [memoryId, value] of Object.entries(parsed)) {
    if (!memoryId || memoryId.length > 220) {
      throw new Error('action suggestion cooldown memoryId 无效。');
    }
    cooldowns.set(memoryId, timestamp(value, `action cooldown ${memoryId}`));
  }
  return cooldowns;
}

async function mutationEnvelope(
  factory: MemoryExperienceEnvelopeFactory,
  type: 'dream' | 'interaction-fact',
  id: string,
) {
  return factory({
    domain: 'memory',
    type,
    id,
  });
}

async function deriveDreamState(input: {
  previousRaw: string | null;
  nextRaw: string | null;
  deletedAt: number;
  envelopeFactory: MemoryExperienceEnvelopeFactory;
}) {
  const previous = parseDreamState(input.previousRaw);
  const next = parseDreamState(input.nextRaw);
  if (jsonEqual(previous, next)) return [];
  const envelope = await mutationEnvelope(
    input.envelopeFactory,
    'dream',
    'engine-state',
  );
  if (next === null) {
    return [buildMemoryExperienceDeleteMutation({
      envelope,
      entityType: 'dream',
      entityId: 'engine-state',
      deletedAt: input.deletedAt,
    })];
  }
  return [buildMemoryExperienceRecordMutation({
    envelope,
    entityType: 'dream',
    entityId: 'engine-state',
    kind: 'dream-state',
    value: next,
  })];
}

async function derivePendingDreams(input: {
  previousRaw: string | null;
  nextRaw: string | null;
  deletedAt: number;
  envelopeFactory: MemoryExperienceEnvelopeFactory;
}) {
  const previous = parseDreams(input.previousRaw);
  const next = parseDreams(input.nextRaw);
  const ids = [...new Set([...previous.keys(), ...next.keys()])].sort();
  const mutations: PlainMutationV1[] = [];
  for (const id of ids) {
    const before = previous.get(id);
    const after = next.get(id);
    if (jsonEqual(before, after)) continue;
    const envelope = await mutationEnvelope(input.envelopeFactory, 'dream', id);
    mutations.push(after
      ? buildMemoryExperienceRecordMutation({
          envelope,
          entityType: 'dream',
          entityId: id,
          kind: 'pending-dream',
          value: after,
        })
      : buildMemoryExperienceDeleteMutation({
          envelope,
          entityType: 'dream',
          entityId: id,
          deletedAt: input.deletedAt,
        }));
  }
  return mutations;
}

async function deriveCooldowns(input: {
  previousRaw: string | null;
  nextRaw: string | null;
  deletedAt: number;
  envelopeFactory: MemoryExperienceEnvelopeFactory;
}) {
  const previous = parseCooldowns(input.previousRaw);
  const next = parseCooldowns(input.nextRaw);
  const ids = [...new Set([...previous.keys(), ...next.keys()])].sort();
  const mutations: PlainMutationV1[] = [];
  for (const memoryId of ids) {
    const before = previous.get(memoryId);
    const after = next.get(memoryId);
    if (before === after) continue;
    const entityId = `action-suggestion:${memoryId}`;
    if (entityId.length > 256) {
      throw new Error('action suggestion cooldown entityId 超过 256 字符。');
    }
    const envelope = await mutationEnvelope(
      input.envelopeFactory,
      'interaction-fact',
      entityId,
    );
    mutations.push(after === undefined
      ? buildMemoryExperienceDeleteMutation({
          envelope,
          entityType: 'interaction-fact',
          entityId,
          deletedAt: input.deletedAt,
        })
      : buildMemoryExperienceRecordMutation({
          envelope,
          entityType: 'interaction-fact',
          entityId,
          kind: 'action-suggestion-cooldown',
          value: {
            memoryId,
            at: after,
          },
        }));
  }
  return mutations;
}

async function deriveHeartViewed(input: {
  previousRaw: string | null;
  nextRaw: string | null;
  deletedAt: number;
  envelopeFactory: MemoryExperienceEnvelopeFactory;
}) {
  if (input.previousRaw === input.nextRaw) return [];
  const envelope = await mutationEnvelope(
    input.envelopeFactory,
    'interaction-fact',
    'baiyun-heart-viewed',
  );
  if (input.nextRaw === null) {
    return [buildMemoryExperienceDeleteMutation({
      envelope,
      entityType: 'interaction-fact',
      entityId: 'baiyun-heart-viewed',
      deletedAt: input.deletedAt,
    })];
  }
  if (!input.nextRaw || input.nextRaw.length > 160) {
    throw new Error('baiyun heart viewed memoryId 无效。');
  }
  return [buildMemoryExperienceRecordMutation({
    envelope,
    entityType: 'interaction-fact',
    entityId: 'baiyun-heart-viewed',
    kind: 'baiyun-heart-viewed',
    value: {
      memoryId: input.nextRaw,
      viewedAt: input.deletedAt,
    },
  })];
}

function parsePostReading(raw: string | null) {
  const parsed = parseJson(raw, 'post runtime');
  if (parsed === null) return null;
  if (!isRecord(parsed) || parsed.replies !== undefined && !isRecord(parsed.replies)) throw new Error('post runtime reading 无效。');
  return projectPostReadingSyncValueV1((parsed.replies as Record<string, unknown> | undefined)?.reading);
}
function parsePostNoticeRead(raw: string | null) {
  const parsed = parseJson(raw, 'post notice read');
  if (parsed === null) return null;
  if (!isRecord(parsed)) throw new Error('post notice read 无效。');
  const value = { since: parsed.since, seen: parsed.seen };
  assertPostNoticeReadSyncValueV1(value); return value;
}
async function derivePostFact(input: {
  previousRaw: string | null; nextRaw: string | null; deletedAt: number; envelopeFactory: MemoryExperienceEnvelopeFactory;
}, kind: 'post-reading' | 'post-notice-read') {
  const project = kind === 'post-reading' ? parsePostReading : parsePostNoticeRead;
  const previous = project(input.previousRaw), next = project(input.nextRaw);
  if (jsonEqual(previous, next)) return [];
  const envelope = await mutationEnvelope(input.envelopeFactory, 'interaction-fact', kind);
  return [next === null ? buildMemoryExperienceDeleteMutation({ envelope, entityType: 'interaction-fact', entityId: kind, deletedAt: input.deletedAt })
    : buildMemoryExperienceRecordMutation({ envelope, entityType: 'interaction-fact', entityId: kind, kind, value: next as unknown as JsonValue })];
}

export async function deriveMemoryExperienceMutationsForStorageChanges(input: {
  changes: readonly MemoryExperienceStorageChange[];
  reader: MemoryExperienceStorageReadPort;
  deletedAt: number;
  envelopeFactory: MemoryExperienceEnvelopeFactory;
}) {
  timestamp(input.deletedAt, 'memory.experience capture time');
  const seenKeys = new Set<string>();
  const mutations: PlainMutationV1[] = [];
  for (const change of input.changes) {
    if (seenKeys.has(change.key)) {
      throw new Error(`memory.experience 同批重复变更 key：${change.key}。`);
    }
    seenKeys.add(change.key);
    if (!MEMORY_EXPERIENCE_GLOBAL_KEY_SET.has(change.key)) continue;
    const previousRaw = await input.reader.getItem(change.key);
    const nextRaw = change.kind === 'set' ? change.value : null;
    const common = {
      previousRaw,
      nextRaw,
      deletedAt: input.deletedAt,
      envelopeFactory: input.envelopeFactory,
    };
    if (change.key === MEMORY_EXPERIENCE_KEYS.dreamState) {
      mutations.push(...await deriveDreamState(common));
    } else if (change.key === MEMORY_EXPERIENCE_KEYS.pendingDreams) {
      mutations.push(...await derivePendingDreams(common));
    } else if (change.key === MEMORY_EXPERIENCE_KEYS.actionSuggestionCooldowns) {
      mutations.push(...await deriveCooldowns(common));
    } else if (change.key === MEMORY_EXPERIENCE_KEYS.baiyunHeartViewed) {
      mutations.push(...await deriveHeartViewed(common));
    } else if (change.key === MEMORY_EXPERIENCE_KEYS.postRuntime) {
      mutations.push(...await derivePostFact(common, 'post-reading'));
    } else if (change.key === MEMORY_EXPERIENCE_KEYS.postNoticeRead) {
      mutations.push(...await derivePostFact(common, 'post-notice-read'));
    }
  }
  return mutations;
}
