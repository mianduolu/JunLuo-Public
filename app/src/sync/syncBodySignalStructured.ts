import type {
  BodySignalActivitySample,
  BodySignalCareEvent,
  BodySignalSleepSession,
  BodySignalWorkoutSession,
} from '../bodySignal/bodySignalStructuredTypes';
import type { BodySignalDeviceFamily } from '../bodySignal/device/bodySignalDeviceTypes';

export const BODY_SIGNAL_STRUCTURED_SYNC_SCHEMA_VERSION = 1 as const;

export type BodySignalDeviceSummaryRecord = {
  displayName: string;
  family: BodySignalDeviceFamily;
  id: string;
  isPrimary: boolean;
  lastConnectedAt?: number;
  updatedAt: number;
};

export type BodySignalStructuredSyncRecord =
  | {
    kind: 'body-signal-activity-sample';
    payload: BodySignalActivitySample;
    schemaVersion: 1;
  }
  | {
    kind: 'body-signal-care-event';
    payload: BodySignalCareEvent;
    schemaVersion: 1;
  }
  | {
    kind: 'body-signal-device-summary';
    payload: BodySignalDeviceSummaryRecord;
    schemaVersion: 1;
  }
  | {
    kind: 'body-signal-sleep-session';
    payload: BodySignalSleepSession;
    schemaVersion: 1;
  }
  | {
    kind: 'body-signal-workout-session';
    payload: BodySignalWorkoutSession;
    schemaVersion: 1;
  };

const PRIVATE_KEYS = new Set([
  'authorizedAssociationId',
  'lastAdvertisingId',
  'protocolIdentity',
  'serviceFingerprint',
  'transportIdentity',
  'cursor',
]);
const MAC_ADDRESS = /(?:^|[^0-9a-f])(?:[0-9a-f]{2}:){5}[0-9a-f]{2}(?:$|[^0-9a-f])/i;

function assertPlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function assertNoPrivateDeviceIdentity(value: unknown, path = 'payload'): void {
  if (typeof value === 'string' && MAC_ADDRESS.test(value)) {
    throw new RangeError(`${path} contains a private BLE address`);
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoPrivateDeviceIdentity(entry, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  Object.entries(value as Record<string, unknown>).forEach(([key, entry]) => {
    if (PRIVATE_KEYS.has(key)) throw new RangeError(`${path}.${key} is private`);
    assertNoPrivateDeviceIdentity(entry, `${path}.${key}`);
  });
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedKeys = new Set(allowed);
  const extra = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (extra.length > 0) throw new RangeError(`${label} has unknown keys: ${extra.join(', ')}`);
}

export function validateBodySignalStructuredSyncRecord(
  value: unknown,
): BodySignalStructuredSyncRecord {
  assertPlainObject(value, 'record');
  assertExactKeys(value, ['kind', 'payload', 'schemaVersion'], 'record');
  if (value.schemaVersion !== BODY_SIGNAL_STRUCTURED_SYNC_SCHEMA_VERSION) {
    throw new RangeError('unsupported body signal structured sync schema');
  }
  if (typeof value.kind !== 'string') throw new TypeError('record.kind must be a string');
  assertPlainObject(value.payload, 'record.payload');
  assertNoPrivateDeviceIdentity(value.payload);

  switch (value.kind) {
    case 'body-signal-device-summary':
      assertExactKeys(
        value.payload,
        ['displayName', 'family', 'id', 'isPrimary', 'lastConnectedAt', 'updatedAt'],
        'device summary',
      );
      if (typeof value.payload.id !== 'string' || typeof value.payload.displayName !== 'string') {
        throw new TypeError('device summary requires id and displayName');
      }
      break;
    case 'body-signal-sleep-session': {
      const stages = value.payload.stages;
      if (!Array.isArray(stages) || stages.length > 256) {
        throw new RangeError('sleep sync requires at most 256 normalized stages');
      }
      break;
    }
    case 'body-signal-activity-sample':
    case 'body-signal-care-event':
    case 'body-signal-workout-session':
      break;
    default:
      throw new RangeError(`unsupported body signal structured kind: ${value.kind}`);
  }
  return value as BodySignalStructuredSyncRecord;
}

export function createBodySignalDeviceSummaryRecord(
  profile: BodySignalDeviceSummaryRecord,
): BodySignalStructuredSyncRecord {
  return validateBodySignalStructuredSyncRecord({
    kind: 'body-signal-device-summary',
    payload: profile,
    schemaVersion: BODY_SIGNAL_STRUCTURED_SYNC_SCHEMA_VERSION,
  });
}
