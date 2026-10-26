import {
  APPEARANCE_BACKGROUND_IMAGE_FITS,
  APPEARANCE_BACKGROUND_MODES,
  APPEARANCE_BACKGROUND_SKY_PERIODS,
  APPEARANCE_BACKGROUND_TEXT_TONES,
  appearanceBackgroundEntityId,
  buildAppearanceBackgroundDeleteMutation,
  buildAppearanceBackgroundUpsertMutation,
  type AppearanceBackgroundImageFit,
  type AppearanceBackgroundMode,
  type AppearanceBackgroundMutationEnvelope,
  type AppearanceBackgroundObject,
  type AppearanceBackgroundRecordKind,
  type AppearanceBackgroundRecordValue,
  type AppearanceBackgroundSettings,
  type AppearanceBackgroundSkyPeriod,
  type AppearanceBackgroundTextTone,
} from './syncAppearanceBackground';
import type { PlainMutationV1 } from './syncProtocol';

export const APPEARANCE_BACKGROUND_SETTINGS_KEY =
  'junluo.backgroundSettings' as const;
export const APPEARANCE_BACKGROUND_INDEX_KEY =
  'junluo.sync.appearance.background.v1' as const;
export const APPEARANCE_BACKGROUND_INDEX_VERSION = 1 as const;

export type AppearanceBackgroundStoredSettings = {
  mode: AppearanceBackgroundMode;
  fixedPeriod: AppearanceBackgroundSkyPeriod;
  imageUri?: string;
  imageFit: AppearanceBackgroundImageFit;
  headerTextTone: AppearanceBackgroundTextTone;
  exposedLabelTextTone: AppearanceBackgroundTextTone;
};

export const DEFAULT_APPEARANCE_BACKGROUND_SETTINGS:
AppearanceBackgroundStoredSettings = Object.freeze({
  mode: 'sky',
  fixedPeriod: 'morning',
  imageFit: 'cover',
  headerTextTone: 'auto',
  exposedLabelTextTone: 'auto',
});

export type AppearanceBackgroundLocalObject =
  AppearanceBackgroundObject & {
    localUri?: string;
    updatedAt: number;
  };

export type AppearanceBackgroundLocalIndex = {
  version: typeof APPEARANCE_BACKGROUND_INDEX_VERSION;
  selectedObjectId?: string;
  objects: AppearanceBackgroundLocalObject[];
};

export type AppearanceBackgroundStorageChange =
  | { kind: 'set'; key: string; value: string }
  | { kind: 'remove'; key: string };

export type AppearanceBackgroundProjection = {
  kind: AppearanceBackgroundRecordKind;
  localId: 'global' | 'custom';
  entityId: string;
  value: AppearanceBackgroundRecordValue;
};

export type AppearanceBackgroundEnvelopeFactory = (
  entity: {
    domain: 'appearance';
    type: AppearanceBackgroundRecordKind;
    id: string;
  },
) => Promise<AppearanceBackgroundMutationEnvelope>;

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
) {
  return (allowed as readonly unknown[]).includes(value)
    ? value as T
    : fallback;
}

function isObjectId(value: unknown): value is string {
  return typeof value === 'string'
    && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function fileUri(value: unknown) {
  return typeof value === 'string' && /^file:\/\//.test(value)
    ? value
    : undefined;
}

export function parseAppearanceBackgroundSettings(
  raw: string | null,
): AppearanceBackgroundStoredSettings {
  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) as unknown : {};
  } catch {
    parsed = {};
  }
  const record = parsed
    && typeof parsed === 'object'
    && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
  const imageUri = fileUri(record.imageUri);
  return {
    mode: oneOf(
      record.mode,
      APPEARANCE_BACKGROUND_MODES,
      DEFAULT_APPEARANCE_BACKGROUND_SETTINGS.mode,
    ),
    fixedPeriod: oneOf(
      record.fixedPeriod,
      APPEARANCE_BACKGROUND_SKY_PERIODS,
      DEFAULT_APPEARANCE_BACKGROUND_SETTINGS.fixedPeriod,
    ),
    imageFit: oneOf(
      record.imageFit,
      APPEARANCE_BACKGROUND_IMAGE_FITS,
      DEFAULT_APPEARANCE_BACKGROUND_SETTINGS.imageFit,
    ),
    headerTextTone: oneOf(
      record.headerTextTone,
      APPEARANCE_BACKGROUND_TEXT_TONES,
      DEFAULT_APPEARANCE_BACKGROUND_SETTINGS.headerTextTone,
    ),
    exposedLabelTextTone: oneOf(
      record.exposedLabelTextTone,
      APPEARANCE_BACKGROUND_TEXT_TONES,
      DEFAULT_APPEARANCE_BACKGROUND_SETTINGS.exposedLabelTextTone,
    ),
    ...(imageUri ? { imageUri } : {}),
  };
}

export function serializeAppearanceBackgroundSettings(
  settings: AppearanceBackgroundStoredSettings,
) {
  return JSON.stringify(settings);
}

export function parseAppearanceBackgroundLocalIndex(
  raw: string | null,
): AppearanceBackgroundLocalIndex {
  const empty = (): AppearanceBackgroundLocalIndex => ({
    version: APPEARANCE_BACKGROUND_INDEX_VERSION,
    objects: [],
  });
  if (!raw) return empty();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return empty();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return empty();
  }
  const root = parsed as {
    version?: unknown;
    selectedObjectId?: unknown;
    objects?: unknown;
  };
  if (
    root.version !== APPEARANCE_BACKGROUND_INDEX_VERSION
    || !Array.isArray(root.objects)
  ) {
    return empty();
  }
  const objects: AppearanceBackgroundLocalObject[] = [];
  for (const value of root.objects.slice(0, 4)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      continue;
    }
    const record = value as Record<string, unknown>;
    if (
      record.slotId !== 'custom'
      || !isObjectId(record.objectId)
      || typeof record.extension !== 'string'
      || !/^[a-z0-9]{1,8}$/.test(record.extension)
      || !Number.isSafeInteger(record.plaintextBytes)
      || Number(record.plaintextBytes) < 1
      || !Number.isSafeInteger(record.chunkCount)
      || Number(record.chunkCount) < 1
      || !Number.isSafeInteger(record.updatedAt)
      || Number(record.updatedAt) < 0
      || (
        record.localUri !== undefined
        && !fileUri(record.localUri)
      )
    ) {
      continue;
    }
    objects.push({
      slotId: 'custom',
      objectId: record.objectId,
      extension: record.extension,
      plaintextBytes: Number(record.plaintextBytes),
      chunkCount: Number(record.chunkCount),
      updatedAt: Number(record.updatedAt),
      ...(typeof record.localUri === 'string'
        ? { localUri: record.localUri }
        : {}),
    });
  }
  return {
    version: APPEARANCE_BACKGROUND_INDEX_VERSION,
    ...(isObjectId(root.selectedObjectId)
      ? { selectedObjectId: root.selectedObjectId }
      : {}),
    objects: objects.slice(0, 1),
  };
}

export function serializeAppearanceBackgroundLocalIndex(
  index: AppearanceBackgroundLocalIndex,
) {
  return JSON.stringify({
    version: APPEARANCE_BACKGROUND_INDEX_VERSION,
    ...(index.selectedObjectId
      ? { selectedObjectId: index.selectedObjectId }
      : {}),
    objects: index.objects,
  });
}

function projection(
  kind: AppearanceBackgroundRecordKind,
  value: AppearanceBackgroundRecordValue,
): AppearanceBackgroundProjection {
  const localId = kind === 'background-settings'
    ? 'global' as const
    : 'custom' as const;
  return {
    kind,
    localId,
    entityId: appearanceBackgroundEntityId(kind),
    value,
  };
}

export function projectAppearanceBackground(input: {
  settingsRaw: string | null;
  index: AppearanceBackgroundLocalIndex;
}) {
  const stored = parseAppearanceBackgroundSettings(
    input.settingsRaw,
  );
  if (stored.mode === 'image' && !input.index.selectedObjectId) {
    throw new Error(
      'appearance.background image 模式缺少可共享对象，不能静默降级。',
    );
  }
  const settings: AppearanceBackgroundSettings = {
    settingsId: 'global',
    mode: stored.mode,
    fixedPeriod: stored.fixedPeriod,
    imageFit: stored.imageFit,
    headerTextTone: stored.headerTextTone,
    exposedLabelTextTone: stored.exposedLabelTextTone,
    ...(input.index.selectedObjectId
      ? { imageObjectId: input.index.selectedObjectId }
      : {}),
  };
  const result: AppearanceBackgroundProjection[] = [
    projection('background-settings', settings),
  ];
  const object = input.index.objects[0];
  if (object) {
    const portable: AppearanceBackgroundObject = {
      slotId: object.slotId,
      objectId: object.objectId,
      extension: object.extension,
      plaintextBytes: object.plaintextBytes,
      chunkCount: object.chunkCount,
    };
    result.push(projection('background-object', portable));
  }
  return result;
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

function projectionKey(value: AppearanceBackgroundProjection) {
  return `${value.kind}\u0000${value.entityId}`;
}

export async function deriveAppearanceBackgroundMutations(input: {
  previous: readonly AppearanceBackgroundProjection[];
  next: readonly AppearanceBackgroundProjection[];
  capturedAt: number;
  envelopeFactory: AppearanceBackgroundEnvelopeFactory;
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
      mutations.push(buildAppearanceBackgroundUpsertMutation({
        envelope: { ...envelope, createdAt: input.capturedAt },
        kind: after.kind,
        value: after.value,
      }));
    } else {
      mutations.push(buildAppearanceBackgroundDeleteMutation({
        envelope: { ...envelope, createdAt: input.capturedAt },
        kind: before!.kind,
        deletedAt: input.capturedAt,
      }));
    }
  }
  return mutations;
}

export function appearanceBackgroundStorageOverride(
  changes: readonly AppearanceBackgroundStorageChange[],
) {
  let override: string | null | undefined;
  for (const change of changes) {
    if (change.key !== APPEARANCE_BACKGROUND_SETTINGS_KEY) {
      continue;
    }
    override = change.kind === 'set' ? change.value : null;
  }
  return override;
}
