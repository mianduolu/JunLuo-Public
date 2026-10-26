import type { ChatCoreMutationEnvelope } from './syncChatCore';
import {
  buildCameraPreferenceMutation,
  CAMERA_PREFERENCE_FIELDS,
  type CameraPreferenceField,
  type CameraPreferenceFieldValue,
} from './syncCameraPreferences';
import type { PlainMutationV1 } from './syncProtocol';

export const CAMERA_PERCEPTION_SETTINGS_KEY =
  'junluo.cameraPerception.settings.v1' as const;
export const CAMERA_PREFERENCES_GLOBAL_KEYS = Object.freeze([
  CAMERA_PERCEPTION_SETTINGS_KEY,
] as const);

export const CAMERA_SESSION_AUTHORIZATION_POLICY =
  'per-device-explicit-session' as const;
export const CAMERA_RAW_FRAME_RETENTION_POLICY = Object.freeze({
  autonomous: 'delete-after-analysis' as const,
  manual: 'explicit-save-only' as const,
});

const CAMERA_SETTINGS_SCHEMA_VERSION = 4 as const;
const INTERVAL_STEP_MINUTES = 5;
const INTERVAL_MIN_MINUTES = 5;
const INTERVAL_MAX_MINUTES = 1440;
const QUIET_STEP_MINUTES = 30;

export type CameraPerceptionSettingsSnapshot = {
  schemaVersion: typeof CAMERA_SETTINGS_SCHEMA_VERSION;
  minimumIntervalMinutes: number;
  chatMinimumIntervalEnabled: boolean;
  maximumIntervalMinutes: number;
  quietHours: {
    enabled: boolean;
    startMinuteOfDay: number;
    endMinuteOfDay: number;
  };
  preferredAndroidFacing: 'front' | 'back';
};

export type CameraPreferencesStorageChange =
  | { kind: 'set'; key: string; value: string }
  | { kind: 'remove'; key: string };

export type CameraPreferencesStorageReadPort = {
  getItem(key: string): Promise<string | null>;
};

export type CameraPreferencesEnvelopeFactory = (
  entity: {
    domain: 'camera';
    type: 'perception-policy';
    id: string;
  },
) => Promise<ChatCoreMutationEnvelope>;

const DEFAULT_CAMERA_SETTINGS: CameraPerceptionSettingsSnapshot = {
  schemaVersion: CAMERA_SETTINGS_SCHEMA_VERSION,
  minimumIntervalMinutes: 30,
  chatMinimumIntervalEnabled: true,
  maximumIntervalMinutes: 120,
  quietHours: {
    enabled: false,
    startMinuteOfDay: 0,
    endMinuteOfDay: 9 * 60,
  },
  preferredAndroidFacing: 'front',
};

function defaultSettings(): CameraPerceptionSettingsSnapshot {
  return {
    ...DEFAULT_CAMERA_SETTINGS,
    quietHours: { ...DEFAULT_CAMERA_SETTINGS.quietHours },
  };
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizeInterval(value: unknown, fallback: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  const stepped = Math.round(value / INTERVAL_STEP_MINUTES)
    * INTERVAL_STEP_MINUTES;
  return Math.max(
    INTERVAL_MIN_MINUTES,
    Math.min(INTERVAL_MAX_MINUTES, stepped),
  );
}

function normalizeMinuteOfDay(value: unknown, fallback: number) {
  if (
    typeof value !== 'number'
    || !Number.isFinite(value)
    || value < 0
    || value >= 24 * 60
  ) {
    return fallback;
  }
  const stepped = Math.round(value / QUIET_STEP_MINUTES)
    * QUIET_STEP_MINUTES;
  return stepped === 24 * 60 ? 0 : stepped;
}

export function normalizeCameraPerceptionSettingsValue(
  value: unknown,
): CameraPerceptionSettingsSnapshot {
  const defaults = defaultSettings();
  const input = recordOf(value);
  if (
    !input
    || ![1, 2, 3, CAMERA_SETTINGS_SCHEMA_VERSION].includes(
      typeof input.schemaVersion === 'number' ? input.schemaVersion : 0,
    )
  ) {
    return defaults;
  }
  const quietInput = recordOf(input.quietHours);
  const minimumIntervalMinutes = normalizeInterval(
    input.minimumIntervalMinutes,
    defaults.minimumIntervalMinutes,
  );
  const maximumIntervalMinutes = normalizeInterval(
    input.maximumIntervalMinutes,
    defaults.maximumIntervalMinutes,
  );
  const quietEnabled = quietInput?.enabled === true;
  const startMinuteOfDay = normalizeMinuteOfDay(
    quietInput?.startMinuteOfDay,
    defaults.quietHours.startMinuteOfDay,
  );
  const endMinuteOfDay = normalizeMinuteOfDay(
    quietInput?.endMinuteOfDay,
    defaults.quietHours.endMinuteOfDay,
  );
  if (quietEnabled && startMinuteOfDay === endMinuteOfDay) {
    return defaults;
  }
  return {
    schemaVersion: CAMERA_SETTINGS_SCHEMA_VERSION,
    minimumIntervalMinutes,
    chatMinimumIntervalEnabled: input.schemaVersion === CAMERA_SETTINGS_SCHEMA_VERSION
      ? input.chatMinimumIntervalEnabled !== false : true,
    maximumIntervalMinutes,
    quietHours: {
      enabled: quietEnabled,
      startMinuteOfDay,
      endMinuteOfDay,
    },
    preferredAndroidFacing:
      input.preferredAndroidFacing === 'back'
        ? 'back'
        : 'front',
  };
}

export function parseCameraPerceptionSettingsRaw(
  raw: string | null,
) {
  if (!raw) return defaultSettings();
  try {
    return normalizeCameraPerceptionSettingsValue(
      JSON.parse(raw) as unknown,
    );
  } catch {
    return defaultSettings();
  }
}

export function cameraPreferenceValuesFromSettings(
  settings: CameraPerceptionSettingsSnapshot,
): Readonly<Record<CameraPreferenceField, CameraPreferenceFieldValue>> {
  return {
    intervalWindow: {
      minimumIntervalMinutes: settings.minimumIntervalMinutes,
      // The old wire contract still requires max >= min. This compatibility
      // value never controls a capture or changes the device-only chat choice.
      maximumIntervalMinutes: Math.max(settings.minimumIntervalMinutes, settings.maximumIntervalMinutes),
    },
    quietHours: { ...settings.quietHours },
    preferredFacing: settings.preferredAndroidFacing,
    sessionAuthorization: CAMERA_SESSION_AUTHORIZATION_POLICY,
    rawFrameRetention: { ...CAMERA_RAW_FRAME_RETENTION_POLICY },
  };
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
    .map(([key, entry]) => (
      `${JSON.stringify(key)}:${canonicalJson(entry)}`
    ))
    .join(',')}}`;
}

async function mutationsForFields(input: {
  fields: readonly CameraPreferenceField[];
  values: Readonly<
    Record<CameraPreferenceField, CameraPreferenceFieldValue>
  >;
  envelopeFactory: CameraPreferencesEnvelopeFactory;
}) {
  const mutations: PlainMutationV1[] = [];
  for (const field of input.fields) {
    const envelope = await input.envelopeFactory({
      domain: 'camera',
      type: 'perception-policy',
      id: field,
    });
    mutations.push(buildCameraPreferenceMutation({
      envelope,
      field,
      value: input.values[field],
    }));
  }
  return mutations;
}

export function isCameraPreferencesGlobalStorageKey(key: string) {
  return key === CAMERA_PERCEPTION_SETTINGS_KEY;
}

export async function deriveCameraPreferenceMutationsForStorageChanges(
  input: {
    changes: readonly CameraPreferencesStorageChange[];
    reader: CameraPreferencesStorageReadPort;
    envelopeFactory: CameraPreferencesEnvelopeFactory;
  },
) {
  const applicable = input.changes.filter(
    (change) => isCameraPreferencesGlobalStorageKey(change.key),
  );
  if (!applicable.length) return [] as PlainMutationV1[];
  const previous = cameraPreferenceValuesFromSettings(
    parseCameraPerceptionSettingsRaw(
      await input.reader.getItem(CAMERA_PERCEPTION_SETTINGS_KEY),
    ),
  );
  const last = applicable[applicable.length - 1]!;
  const nextSettings = last.kind === 'set'
    ? parseCameraPerceptionSettingsRaw(last.value)
    : defaultSettings();
  const next = cameraPreferenceValuesFromSettings(nextSettings);
  const changedFields = CAMERA_PREFERENCE_FIELDS.filter(
    (field) => (
      canonicalJson(previous[field])
      !== canonicalJson(next[field])
    ),
  );
  return mutationsForFields({
    fields: changedFields,
    values: next,
    envelopeFactory: input.envelopeFactory,
  });
}

export async function deriveCameraPreferenceBootstrapMutations(input: {
  raw: string | null;
  envelopeFactory: CameraPreferencesEnvelopeFactory;
}) {
  const values = cameraPreferenceValuesFromSettings(
    parseCameraPerceptionSettingsRaw(input.raw),
  );
  return mutationsForFields({
    fields: CAMERA_PREFERENCE_FIELDS,
    values,
    envelopeFactory: input.envelopeFactory,
  });
}
