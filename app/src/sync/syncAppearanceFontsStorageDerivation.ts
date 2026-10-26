import {
  APPEARANCE_FONT_IDS,
  XIAOLAI_FONT_ASSET,
  appearanceFontEntityId,
  assertAppearanceFontMutationV1,
  buildAppearanceFontDeleteMutation,
  buildAppearanceFontUpsertMutation,
  type AppearanceFontId,
  type AppearanceFontMutationEnvelope,
  type AppearanceFontObject,
  type AppearanceFontRecordKind,
  type AppearanceFontRecordValue,
} from './syncAppearanceFonts';
import type { PlainMutationV1 } from './syncProtocol';

export const APPEARANCE_FONT_CHOICE_KEY =
  'junluo.fontChoice' as const;
export const APPEARANCE_FONT_INDEX_KEY =
  'junluo.sync.appearance.fonts.v1' as const;
export const APPEARANCE_FONT_INDEX_VERSION = 1 as const;

export type AppearanceFontLocalObject = AppearanceFontObject & {
  localUri?: string;
  updatedAt: number;
};

export type AppearanceFontLocalIndex = {
  version: typeof APPEARANCE_FONT_INDEX_VERSION;
  records: AppearanceFontLocalObject[];
};

export type AppearanceFontStorageChange =
  | { kind: 'set'; key: string; value: string }
  | { kind: 'remove'; key: string };

export type AppearanceFontProjection = {
  kind: AppearanceFontRecordKind;
  localId: string;
  entityId: string;
  value: AppearanceFontRecordValue;
};

export type AppearanceFontEnvelopeFactory = (
  entity: {
    domain: 'appearance';
    type: AppearanceFontRecordKind;
    id: string;
  },
) => Promise<AppearanceFontMutationEnvelope & {
  parentOperations?: Array<'upsert' | 'restore' | 'delete'>;
}>;

function isObjectId(value: unknown): value is string {
  return typeof value === 'string'
    && /^[A-Za-z0-9_-]{43}$/.test(value);
}

export function parseAppearanceFontChoice(
  raw: string | null,
): AppearanceFontId | null {
  return (APPEARANCE_FONT_IDS as readonly unknown[]).includes(raw)
    ? raw as AppearanceFontId
    : null;
}

export function parseAppearanceFontLocalIndex(
  raw: string | null,
): AppearanceFontLocalIndex {
  if (!raw) {
    return {
      version: APPEARANCE_FONT_INDEX_VERSION,
      records: [],
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return {
      version: APPEARANCE_FONT_INDEX_VERSION,
      records: [],
    };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      version: APPEARANCE_FONT_INDEX_VERSION,
      records: [],
    };
  }
  const root = parsed as {
    version?: unknown;
    records?: unknown;
  };
  if (
    root.version !== APPEARANCE_FONT_INDEX_VERSION
    || !Array.isArray(root.records)
  ) {
    return {
      version: APPEARANCE_FONT_INDEX_VERSION,
      records: [],
    };
  }
  const records: AppearanceFontLocalObject[] = [];
  for (const value of root.records.slice(0, 8)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      continue;
    }
    const record = value as Record<string, unknown>;
    if (
      record.fontId !== XIAOLAI_FONT_ASSET.fontId
      || record.familyName !== XIAOLAI_FONT_ASSET.familyName
      || record.assetVersion !== XIAOLAI_FONT_ASSET.assetVersion
      || record.extension !== XIAOLAI_FONT_ASSET.extension
      || record.licenseId !== XIAOLAI_FONT_ASSET.licenseId
      || !isObjectId(record.objectId)
      || !Number.isSafeInteger(record.plaintextBytes)
      || Number(record.plaintextBytes) < 1
      || !Number.isSafeInteger(record.chunkCount)
      || Number(record.chunkCount) < 1
      || !Number.isSafeInteger(record.updatedAt)
      || Number(record.updatedAt) < 0
      || (
        record.localUri !== undefined
        && (
          typeof record.localUri !== 'string'
          || !/^file:\/\//.test(record.localUri)
        )
      )
    ) {
      continue;
    }
    records.push({
      fontId: XIAOLAI_FONT_ASSET.fontId,
      familyName: XIAOLAI_FONT_ASSET.familyName,
      assetVersion: XIAOLAI_FONT_ASSET.assetVersion,
      extension: XIAOLAI_FONT_ASSET.extension,
      licenseId: XIAOLAI_FONT_ASSET.licenseId,
      objectId: record.objectId,
      plaintextBytes: Number(record.plaintextBytes),
      chunkCount: Number(record.chunkCount),
      updatedAt: Number(record.updatedAt),
      ...(typeof record.localUri === 'string'
        ? { localUri: record.localUri }
        : {}),
    });
  }
  return {
    version: APPEARANCE_FONT_INDEX_VERSION,
    records: records.slice(0, 1),
  };
}

export function serializeAppearanceFontLocalIndex(
  index: AppearanceFontLocalIndex,
) {
  return JSON.stringify({
    version: APPEARANCE_FONT_INDEX_VERSION,
    records: index.records,
  });
}

function projection(
  kind: AppearanceFontRecordKind,
  localId: string,
  value: AppearanceFontRecordValue,
): AppearanceFontProjection {
  return {
    kind,
    localId,
    entityId: appearanceFontEntityId(kind, localId),
    value,
  };
}

export function projectAppearanceFonts(input: {
  choiceRaw: string | null;
  index: AppearanceFontLocalIndex;
}) {
  const choice = parseAppearanceFontChoice(input.choiceRaw);
  if (!choice) return [] as AppearanceFontProjection[];
  if (choice === 'system') {
    return [
      projection('font-choice', 'global', {
        choiceId: 'global',
        fontId: 'system',
      }),
    ];
  }
  const object = input.index.records.find(
    (record) => record.fontId === choice,
  );
  if (!object) return [];
  const portableObject: AppearanceFontObject = {
    fontId: object.fontId,
    familyName: object.familyName,
    assetVersion: object.assetVersion,
    extension: object.extension,
    licenseId: object.licenseId,
    objectId: object.objectId,
    plaintextBytes: object.plaintextBytes,
    chunkCount: object.chunkCount,
  };
  return [
    projection('font-choice', 'global', {
      choiceId: 'global',
      fontId: choice,
      requiredObjectId: object.objectId,
    }),
    projection('font-object', choice, portableObject),
  ];
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) =>
      `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(',')}}`;
}

function projectionKey(value: AppearanceFontProjection) {
  return `${value.kind}\u0000${value.entityId}`;
}

export async function deriveAppearanceFontMutations(input: {
  previous: readonly AppearanceFontProjection[];
  next: readonly AppearanceFontProjection[];
  capturedAt: number;
  envelopeFactory: AppearanceFontEnvelopeFactory;
}) {
  const previous = new Map(
    input.previous.map((record) => [projectionKey(record), record]),
  );
  const next = new Map(
    input.next.map((record) => [projectionKey(record), record]),
  );
  const keys = [...new Set([...previous.keys(), ...next.keys()])].sort();
  const mutations: PlainMutationV1[] = [];
  for (const key of keys) {
    const before = previous.get(key);
    const after = next.get(key);
    if (
      before
      && after
      && canonicalJson(before.value) === canonicalJson(after.value)
    ) {
      continue;
    }
    const identity = after ?? before;
    if (!identity) continue;
    const envelope = await input.envelopeFactory({
      domain: 'appearance',
      type: identity.kind,
      id: identity.entityId,
    });
    if (after) {
      const mutation = buildAppearanceFontUpsertMutation({
        envelope: { ...envelope, createdAt: input.capturedAt },
        kind: after.kind,
        value: after.value,
      });
      if (envelope.parentOperations?.includes('delete')) {
        mutation.revision.operation = 'restore';
        assertAppearanceFontMutationV1(mutation);
      }
      mutations.push(mutation);
    } else {
      mutations.push(buildAppearanceFontDeleteMutation({
        envelope: { ...envelope, createdAt: input.capturedAt },
        kind: before!.kind,
        localId: before!.localId,
        deletedAt: input.capturedAt,
      }));
    }
  }
  return mutations;
}

export function appearanceFontStorageOverrides(
  changes: readonly AppearanceFontStorageChange[],
) {
  let choiceOverride: string | null | undefined;
  for (const change of changes) {
    if (change.key !== APPEARANCE_FONT_CHOICE_KEY) continue;
    choiceOverride = change.kind === 'set' ? change.value : null;
  }
  return choiceOverride;
}
