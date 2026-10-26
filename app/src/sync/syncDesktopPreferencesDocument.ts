import {
  assertDesktopPreferenceRecord,
  buildDesktopPreferenceMutation,
  type DesktopPreferenceRecord,
  type DesktopPreferenceRecordKind,
  type DesktopPreferencesMutationEnvelope,
} from './syncDesktopPreferences';
import type {
  DesktopPreferencesBusinessPort,
  DesktopPreferenceRevisionContext,
} from './syncDesktopPreferencesApply';
import type { PlainMutationV1 } from './syncProtocol';

export const DESKTOP_PREFERENCES_DOCUMENT_VERSION = 1 as const;

export type DesktopSharedPreferences = {
  schemaVersion: 1;
  window: {
    sizeClass: 'compact' | 'comfortable' | 'spacious';
    launchMode: 'restore' | 'normal' | 'maximized';
    rememberPlacement: boolean;
  };
  tray: {
    enabled: boolean;
    closeBehavior: 'hide-to-tray' | 'quit';
    launchHidden: boolean;
  };
  autostart: {
    enabled: boolean;
    launchMode: 'normal' | 'tray';
  };
  focusCompanion: {
    idleMinutes: number;
    defaultLeaveMinutes: number;
    growthDelaySeconds: number;
    growthFillSeconds: number;
  };
};

export const DEFAULT_DESKTOP_SHARED_PREFERENCES:
Readonly<DesktopSharedPreferences> = Object.freeze({
  schemaVersion: DESKTOP_PREFERENCES_DOCUMENT_VERSION,
  window: Object.freeze({
    sizeClass: 'comfortable',
    launchMode: 'restore',
    rememberPlacement: true,
  }),
  tray: Object.freeze({
    enabled: true,
    closeBehavior: 'hide-to-tray',
    launchHidden: false,
  }),
  autostart: Object.freeze({
    enabled: false,
    launchMode: 'tray',
  }),
  focusCompanion: Object.freeze({
    idleMinutes: 3,
    defaultLeaveMinutes: 15,
    growthDelaySeconds: 5,
    growthFillSeconds: 15,
  }),
});

export type DesktopPreferenceProjection = {
  kind: DesktopPreferenceRecordKind;
  field: DesktopPreferenceRecord['field'];
  record: DesktopPreferenceRecord;
};

export type DesktopPreferencesEnvelopeFactory = (
  entity: {
    domain: 'desktop';
    type: DesktopPreferenceRecordKind;
    id: string;
  },
) => Promise<DesktopPreferencesMutationEnvelope>;

type UnknownRecord = Record<string, unknown>;

function recordOf(value: unknown): UnknownRecord | null {
  return (
    !!value
    && typeof value === 'object'
    && !Array.isArray(value)
  )
    ? value as UnknownRecord
    : null;
}

function cloneDefaults(): DesktopSharedPreferences {
  return structuredClone(DEFAULT_DESKTOP_SHARED_PREFERENCES);
}

export function assertDesktopSharedPreferences(
  value: unknown,
): asserts value is DesktopSharedPreferences {
  const root = recordOf(value);
  if (
    !root
    || root.schemaVersion !== DESKTOP_PREFERENCES_DOCUMENT_VERSION
    || Object.keys(root).sort().join(',')
      !== 'autostart,focusCompanion,schemaVersion,tray,window'
  ) {
    throw new Error('desktop shared preferences 根结构无效。');
  }
  const sections = [
    ['window-policy', root.window],
    ['tray-policy', root.tray],
    ['autostart-policy', root.autostart],
    ['focus-companion-policy', root.focusCompanion],
  ] as const;
  for (const [kind, rawSection] of sections) {
    const section = recordOf(rawSection);
    if (!section) {
      throw new Error(`desktop ${kind} 必须是对象。`);
    }
    for (const [field, preference] of Object.entries(section)) {
      assertDesktopPreferenceRecord({
        kind,
        field,
        value: preference,
      });
    }
  }
  const expectedKeys = {
    'window-policy': 'launchMode,rememberPlacement,sizeClass',
    'tray-policy': 'closeBehavior,enabled,launchHidden',
    'autostart-policy': 'enabled,launchMode',
    'focus-companion-policy':
      'defaultLeaveMinutes,growthDelaySeconds,growthFillSeconds,idleMinutes',
  } as const;
  for (const [kind, rawSection] of sections) {
    if (
      Object.keys(rawSection as UnknownRecord).sort().join(',')
        !== expectedKeys[kind]
    ) {
      throw new Error(`desktop ${kind} 字段集合无效。`);
    }
  }
}

function validLegacyInteger(value: unknown) {
  return Number.isInteger(value)
    && Number(value) >= 1
    && Number(value) <= 999
    ? Number(value)
    : undefined;
}

function withoutLegacyFocusPreferenceFields(root: UnknownRecord) {
  const current = { ...root };
  for (const field of [
    'IdleMinutes',
    'DefaultLeaveMinutes',
    'LeaveMinutes',
    'GrowthDelaySeconds',
    'GrowthFillSeconds',
  ]) {
    delete current[field];
  }
  return current;
}

export function parseDesktopPreferencesSettings(
  raw: string | null,
) {
  const defaults = cloneDefaults();
  if (!raw) return defaults;
  let root: UnknownRecord | null = null;
  try {
    root = recordOf(JSON.parse(raw) as unknown);
  } catch {
    return defaults;
  }
  if (!root) return defaults;
  try {
    assertDesktopSharedPreferences(root.SharedPreferences);
    return structuredClone(root.SharedPreferences);
  } catch {
    const legacy = { ...defaults.focusCompanion };
    legacy.idleMinutes =
      validLegacyInteger(root.IdleMinutes) ?? legacy.idleMinutes;
    legacy.defaultLeaveMinutes =
      validLegacyInteger(root.DefaultLeaveMinutes)
      ?? validLegacyInteger(root.LeaveMinutes)
      ?? legacy.defaultLeaveMinutes;
    legacy.growthDelaySeconds =
      validLegacyInteger(root.GrowthDelaySeconds)
      ?? legacy.growthDelaySeconds;
    legacy.growthFillSeconds =
      validLegacyInteger(root.GrowthFillSeconds)
      ?? legacy.growthFillSeconds;
    return { ...defaults, focusCompanion: legacy };
  }
}

export function serializeDesktopPreferencesSettings(input: {
  previousRaw: string | null;
  shared: DesktopSharedPreferences;
}) {
  assertDesktopSharedPreferences(input.shared);
  let root: UnknownRecord = {};
  if (input.previousRaw) {
    try {
      root = recordOf(JSON.parse(input.previousRaw) as unknown) ?? {};
    } catch {
      root = {};
    }
  }
  const shared = structuredClone(input.shared);
  return JSON.stringify({
    ...withoutLegacyFocusPreferenceFields(root),
    SchemaVersion: 2,
    SharedPreferences: shared,
  }, null, 2);
}

function projection(
  kind: DesktopPreferenceRecordKind,
  field: DesktopPreferenceRecord['field'],
  value: DesktopPreferenceRecord['value'],
): DesktopPreferenceProjection {
  const record = { kind, field, value } as DesktopPreferenceRecord;
  assertDesktopPreferenceRecord(record);
  return { kind, field, record };
}

export function projectDesktopPreferences(
  shared: DesktopSharedPreferences,
) {
  assertDesktopSharedPreferences(shared);
  return [
    projection(
      'window-policy',
      'sizeClass',
      shared.window.sizeClass,
    ),
    projection(
      'window-policy',
      'launchMode',
      shared.window.launchMode,
    ),
    projection(
      'window-policy',
      'rememberPlacement',
      shared.window.rememberPlacement,
    ),
    projection('tray-policy', 'enabled', shared.tray.enabled),
    projection(
      'tray-policy',
      'closeBehavior',
      shared.tray.closeBehavior,
    ),
    projection(
      'tray-policy',
      'launchHidden',
      shared.tray.launchHidden,
    ),
    projection(
      'autostart-policy',
      'enabled',
      shared.autostart.enabled,
    ),
    projection(
      'autostart-policy',
      'launchMode',
      shared.autostart.launchMode,
    ),
    projection(
      'focus-companion-policy',
      'idleMinutes',
      shared.focusCompanion.idleMinutes,
    ),
    projection(
      'focus-companion-policy',
      'defaultLeaveMinutes',
      shared.focusCompanion.defaultLeaveMinutes,
    ),
    projection(
      'focus-companion-policy',
      'growthDelaySeconds',
      shared.focusCompanion.growthDelaySeconds,
    ),
    projection(
      'focus-companion-policy',
      'growthFillSeconds',
      shared.focusCompanion.growthFillSeconds,
    ),
  ] satisfies DesktopPreferenceProjection[];
}

export function applyDesktopPreferenceRecord(
  shared: DesktopSharedPreferences,
  record: DesktopPreferenceRecord,
) {
  assertDesktopSharedPreferences(shared);
  assertDesktopPreferenceRecord(record);
  const next = structuredClone(shared);
  if (record.kind === 'window-policy') {
    Object.assign(next.window, { [record.field]: record.value });
  } else if (record.kind === 'tray-policy') {
    Object.assign(next.tray, { [record.field]: record.value });
  } else if (record.kind === 'autostart-policy') {
    Object.assign(next.autostart, { [record.field]: record.value });
  } else {
    Object.assign(next.focusCompanion, {
      [record.field]: record.value,
    });
  }
  assertDesktopSharedPreferences(next);
  return next;
}

function projectionKey(value: DesktopPreferenceProjection) {
  return `${value.kind}\u0000${value.field}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  return `{${Object.entries(value as UnknownRecord)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) =>
      `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(',')}}`;
}

export async function deriveDesktopPreferenceMutations(input: {
  previous: readonly DesktopPreferenceProjection[];
  next: readonly DesktopPreferenceProjection[];
  capturedAt: number;
  envelopeFactory: DesktopPreferencesEnvelopeFactory;
}) {
  const previous = new Map(
    input.previous.map((value) => [projectionKey(value), value]),
  );
  const mutations: PlainMutationV1[] = [];
  for (const next of input.next) {
    const before = previous.get(projectionKey(next));
    if (
      before
      && canonicalJson(before.record.value)
        === canonicalJson(next.record.value)
    ) {
      continue;
    }
    const envelope = await input.envelopeFactory({
      domain: 'desktop',
      type: next.kind,
      id: next.field,
    });
    mutations.push(buildDesktopPreferenceMutation({
      envelope: { ...envelope, createdAt: input.capturedAt },
      record: next.record,
    }));
  }
  return mutations;
}

export interface DesktopPreferencesDocumentPort {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
}

export class DesktopPreferencesDocumentBusinessPort
implements DesktopPreferencesBusinessPort {
  constructor(
    private readonly port: DesktopPreferencesDocumentPort,
  ) {}

  async setPreference(input: {
    record: DesktopPreferenceRecord;
    revision: DesktopPreferenceRevisionContext;
  }) {
    const raw = await this.port.read();
    const current = parseDesktopPreferencesSettings(raw);
    const next = applyDesktopPreferenceRecord(
      current,
      input.record,
    );
    await this.port.write(serializeDesktopPreferencesSettings({
      previousRaw: raw,
      shared: next,
    }));
  }
}

export async function writeDesktopSharedPreferences(input: {
  port: DesktopPreferencesDocumentPort;
  next: DesktopSharedPreferences;
  capturedAt: number;
  envelopeFactory?: DesktopPreferencesEnvelopeFactory;
  capture?: (input: {
    mutations: PlainMutationV1[];
    performBusinessWrite(): Promise<void>;
  }) => Promise<void>;
}) {
  const raw = await input.port.read();
  const previous = parseDesktopPreferencesSettings(raw);
  const performBusinessWrite = () => input.port.write(
    serializeDesktopPreferencesSettings({
      previousRaw: raw,
      shared: input.next,
    }),
  );
  if (!input.envelopeFactory || !input.capture) {
    await performBusinessWrite();
    return { mode: 'local-only', mutationCount: 0 } as const;
  }
  const mutations = await deriveDesktopPreferenceMutations({
    previous: projectDesktopPreferences(previous),
    next: projectDesktopPreferences(input.next),
    capturedAt: input.capturedAt,
    envelopeFactory: input.envelopeFactory,
  });
  await input.capture({ mutations, performBusinessWrite });
  return {
    mode: 'durable-capture',
    mutationCount: mutations.length,
  } as const;
}
