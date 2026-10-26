import type { ChatCoreMutationEnvelope } from './syncChatCore';
import {
  buildRelationshipAuthorizationMutation,
  assertRelationshipAuthorizationFieldValue,
  RELATIONSHIP_AUTONOMY_FIELDS,
  RELATIONSHIP_PROACTIVE_FIELDS,
  RELATIONSHIP_SAFETY_FIELDS,
  relationshipAuthorizationEntityTypeForField,
  type RelationshipAuthorizationEntityType,
  type RelationshipAuthorizationField,
  type RelationshipAuthorizationFieldValue,
} from './syncRelationshipAuthorization';
import type { PlainMutationV1 } from './syncProtocol';

export const RELATIONSHIP_AUTONOMY_SETTINGS_KEY =
  'junluo.autonomy.settings.v1' as const;
export const RELATIONSHIP_PROACTIVE_SETTINGS_KEY =
  'junluo.proactiveMessage.settings' as const;
export const RELATIONSHIP_SOCIAL_SETTINGS_KEY =
  'junluo.life.socialAgent.settings.v1' as const;
export const RELATIONSHIP_INTIMACY_SAFETY_SETTINGS_KEY =
  'junluo.baiyunBehavior.intimacySafety' as const;

export const RELATIONSHIP_AUTHORIZATION_GLOBAL_KEYS = Object.freeze([
  RELATIONSHIP_AUTONOMY_SETTINGS_KEY,
  RELATIONSHIP_PROACTIVE_SETTINGS_KEY,
  RELATIONSHIP_SOCIAL_SETTINGS_KEY,
  RELATIONSHIP_INTIMACY_SAFETY_SETTINGS_KEY,
] as const);

export type RelationshipAuthorizationStorageChange =
  | { kind: 'set'; key: string; value: string }
  | { kind: 'remove'; key: string };

export type RelationshipAuthorizationStorageReadPort = {
  getItem(key: string): Promise<string | null>;
};

export type RelationshipAuthorizationEnvelopeFactory = (
  entity: {
    domain: 'relationship';
    type: RelationshipAuthorizationEntityType;
    id: RelationshipAuthorizationField;
  },
) => Promise<ChatCoreMutationEnvelope>;

type Projection = ReadonlyMap<
  RelationshipAuthorizationField,
  RelationshipAuthorizationFieldValue
>;

function recordOf(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function parseJson(raw: string, label: string) {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${label} 不是有效 JSON。`);
  }
}

function bool(value: unknown, fallback: boolean) {
  return typeof value === 'boolean' ? value : fallback;
}

function autonomyProjection(value: unknown): Projection {
  const candidate = recordOf(value);
  const versioned = candidate.schemaVersion === 2;
  const projection = new Map<RelationshipAuthorizationField, RelationshipAuthorizationFieldValue>([
    [
      'desireDrivenBehaviorEnabled',
      bool(candidate.desireDrivenBehaviorEnabled, true),
    ],
    ['dreamSleepLoopEnabled', bool(candidate.dreamSleepLoopEnabled, true)],
    ['githubVoyageEnabled', bool(candidate.githubVoyageEnabled, true)],
    ['masterEnabled', bool(candidate.masterEnabled, true)],
    [
      'publicPostingEnabled',
      versioned ? bool(candidate.publicPostingEnabled, true) : true,
    ],
    ['realtimeRhythmEnabled', bool(candidate.realtimeRhythmEnabled, true)],
    ['webVoyageEnabled', bool(candidate.webVoyageEnabled, true)],
    ['xiaohongshuEnabled', bool(candidate.xiaohongshuEnabled, false)],
  ]);
  // Older records have no opinion on fields introduced after their version.
  if ('dailyPlanningEnabled' in candidate) projection.set('dailyPlanningEnabled', bool(candidate.dailyPlanningEnabled, false));
  if ('dailyPlanningActivatedAt' in candidate) {
    assertRelationshipAuthorizationFieldValue('dailyPlanningActivatedAt', candidate.dailyPlanningActivatedAt);
    projection.set('dailyPlanningActivatedAt', candidate.dailyPlanningActivatedAt);
  }
  return projection;
}

function proactiveProjection(value: unknown): Projection {
  const candidate = recordOf(value);
  const firstPromptAnswered = candidate.firstPromptAnswered !== false;
  const pause = {
    pause: candidate.contactPause ?? null,
    sourceMessageId: candidate.contactPauseSourceMessageId ?? '',
    sourceAt: candidate.contactPauseSourceAt ?? 0,
    sourceKind: candidate.contactPauseSourceKind ?? null,
  };
  assertRelationshipAuthorizationFieldValue('contactPause', pause);
  return new Map<RelationshipAuthorizationField, RelationshipAuthorizationFieldValue>([
    [
      'enabled',
      candidate.enabled !== false || candidate.firstPromptAnswered !== true,
    ],
    ['firstPromptAnswered', firstPromptAnswered],
    ['contactPause', pause],
  ]);
}

function socialProjection(value: unknown): Projection {
  const candidate = recordOf(value);
  const platforms = Array.isArray(candidate.preferredPlatforms)
    ? candidate.preferredPlatforms.filter(
        (entry): entry is string => (
          entry === 'weibo'
          || entry === 'xiaohongshu'
          || entry === 'junluo'
        ),
      )
    : ['xiaohongshu'];
  return new Map<RelationshipAuthorizationField, RelationshipAuthorizationFieldValue>([
    [
      'autonomousInteractionEnabled',
      candidate.autonomousInteractionEnabled !== false,
    ],
    [
      'preferredPlatforms',
      platforms.includes('xiaohongshu') ? ['xiaohongshu'] : ['xiaohongshu'],
    ],
  ]);
}

function safetyProjection(value: unknown): Projection {
  const candidate = recordOf(value);
  const safeWord = typeof candidate.safeWord === 'string'
    ? Array.from(candidate.safeWord.trim()).slice(0, 24).join('')
    : '';
  return new Map<RelationshipAuthorizationField, RelationshipAuthorizationFieldValue>([
    ['safeWord', safeWord],
  ]);
}

export function projectRelationshipAuthorizationStorageValue(
  key: string,
  value: unknown,
): Projection {
  if (key === RELATIONSHIP_AUTONOMY_SETTINGS_KEY) {
    return autonomyProjection(value);
  }
  if (key === RELATIONSHIP_PROACTIVE_SETTINGS_KEY) {
    return proactiveProjection(value);
  }
  if (key === RELATIONSHIP_SOCIAL_SETTINGS_KEY) {
    return socialProjection(value);
  }
  if (key === RELATIONSHIP_INTIMACY_SAFETY_SETTINGS_KEY) {
    return safetyProjection(value);
  }
  throw new Error(`relationship.authorization 未登记 storage key：${key}。`);
}

export function parseRelationshipAuthorizationStorageProjection(
  key: string,
  raw: string,
) {
  return projectRelationshipAuthorizationStorageValue(
    key,
    parseJson(raw, `relationship.authorization ${key}`),
  );
}

export function isRelationshipAuthorizationGlobalStorageKey(key: string) {
  return (
    RELATIONSHIP_AUTHORIZATION_GLOBAL_KEYS as readonly string[]
  ).includes(key);
}

function sameValue(
  left: RelationshipAuthorizationFieldValue,
  right: RelationshipAuthorizationFieldValue,
) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function deriveRelationshipAuthorizationMutationsForStorageChanges(
  input: {
    changes: readonly RelationshipAuthorizationStorageChange[];
    reader: RelationshipAuthorizationStorageReadPort;
    capturedAt: number;
    envelopeFactory: RelationshipAuthorizationEnvelopeFactory;
  },
): Promise<PlainMutationV1[]> {
  const mutations: PlainMutationV1[] = [];
  for (const change of input.changes) {
    if (!isRelationshipAuthorizationGlobalStorageKey(change.key)) continue;
    if (change.kind === 'remove') {
      // 物理清键可能来自恢复/重置，不能被解释成重新授权或删除安全边界。
      continue;
    }
    const next = parseRelationshipAuthorizationStorageProjection(
      change.key,
      change.value,
    );
    const previousRaw = await input.reader.getItem(change.key);
    let previous: Projection | null = null;
    if (previousRaw !== null) {
      try {
        previous = parseRelationshipAuthorizationStorageProjection(
          change.key,
          previousRaw,
        );
      } catch {
        previous = null;
      }
    }
    for (const [field, value] of next) {
      const previousValue = previous?.get(field);
      if (
        previousValue !== undefined
        && sameValue(previousValue, value)
      ) {
        continue;
      }
      const entityType =
        relationshipAuthorizationEntityTypeForField(field);
      const envelope = await input.envelopeFactory({
        domain: 'relationship',
        type: entityType,
        id: field,
      });
      mutations.push(buildRelationshipAuthorizationMutation({
        envelope,
        entityType,
        field,
        value,
      }));
    }
  }
  return mutations;
}

export const RELATIONSHIP_AUTHORIZATION_EXPECTED_FIELDS = Object.freeze([
  ...RELATIONSHIP_AUTONOMY_FIELDS,
  ...RELATIONSHIP_PROACTIVE_FIELDS,
  ...RELATIONSHIP_SAFETY_FIELDS,
] as const);
