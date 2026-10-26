import type { ContactOpportunity, UnifiedContactState } from './unifiedContact';

export type ProactiveControlRound = {
  opportunityId: string; reservationId: string; ownerDeviceId: string; runtimeEpoch: string;
  kind: 'ordinary' | 'important'; state: 'reserved' | 'started' | 'completed' | 'expired' | 'unknown';
  reservedAt: number; reservationExpiresAt: number; startedAt: number | null; deadlineAt: number | null;
  chargedDay: string | null; ordinal: number | null; outcome: 'completed' | 'failed' | 'cancelled' | 'unknown' | null;
};
export type ProactiveControlState = {
  controlVersion: 1; revision: number; serverTimeMs: number; day: string; used: number;
  routeDeviceId: string | null; waitReason: string | null;
  migrationComplete: boolean;
  participants: Array<{ deviceId: string; platform: 'android' | 'windows'; runtimeEpoch: string | null;
    enabled: boolean; standby: boolean; sampleStatus: 'ready' | 'unknown'; reportedAt: number | null;
    fresh: boolean; compatible: boolean;
    input: { runtimeEpoch: string; eventSequence: number; earliestAt: number; latestAt: number } | null }>;
  current: ProactiveControlRound | null;
  ledger: { lastEndedAt: number; lastOrdinaryReplyAt: number; motiveLastSelectedAt: Record<string, number>;
    lastCameraAttemptAt: number; lastSuccessfulObservationAt: number };
  calibration?: { id: string; serverTimeMs: number; sentMonotonicMs: number };
  opportunity?: ProactiveControlRound;
  cameraAllowed?: boolean;
};

export class ProactiveControlWait extends Error {
  readonly retryAfter = Date.now() + 10_000;
  constructor(readonly reason: string) { super(`proactive-control:${reason}`); this.name = 'ProactiveControlWait'; }
}
export const isProactiveControlWait = (error: unknown): error is ProactiveControlWait => error instanceof ProactiveControlWait;

export function proactiveMigrationUsed(day: string, records: readonly unknown[]): number {
  return Math.max(0, ...records.flatMap(value => {
    const record = value as { day?: unknown; used?: unknown } | null;
    return record?.day === day && Number.isSafeInteger(record.used) && Number(record.used) >= 0 ? [Number(record.used)] : [];
  }));
}

// Only control metadata crosses this port. It cannot send chat, observations, or images.
export type ProactiveControlPorts = {
  deviceId: string; runtimeEpoch: string;
  post(action: string, body: Record<string, unknown>): Promise<unknown>;
};

export function parseProactiveControlState(value: unknown): ProactiveControlState {
  const state = value as ProactiveControlState | null;
  if (!state || state.controlVersion !== 1 || !Number.isSafeInteger(state.revision)
    || !Number.isSafeInteger(state.used) || state.used < 0 || !Number.isFinite(state.serverTimeMs)
    || !/^\d{4}-\d{2}-\d{2}$/.test(state.day) || !Array.isArray(state.participants)
    || !state.ledger || !Number.isFinite(state.ledger.lastEndedAt)
    || !Number.isFinite(state.ledger.lastOrdinaryReplyAt) || !state.ledger.motiveLastSelectedAt
    || !(state.routeDeviceId === null || typeof state.routeDeviceId === 'string')
    || !(state.waitReason === null || typeof state.waitReason === 'string')) throw new ProactiveControlWait('invalid_response');
  return state;
}

/** The server is authoritative; this projection only feeds the existing pure opportunity decision. */
export function withSharedContactLedger<T extends UnifiedContactState>(local: T, shared: ProactiveControlState): T {
  return { ...local, day: shared.day, used: shared.used,
    lastEndedAt: Math.max(local.lastEndedAt, shared.ledger.lastEndedAt),
    lastOrdinaryReplyAt: Math.max(local.lastOrdinaryReplyAt, shared.ledger.lastOrdinaryReplyAt),
    motiveLastSelectedAt: Object.fromEntries([...new Set([
      ...Object.keys(local.motiveLastSelectedAt ?? {}), ...Object.keys(shared.ledger.motiveLastSelectedAt),
    ])].map(key => [key, Math.max(local.motiveLastSelectedAt?.[key as keyof NonNullable<UnifiedContactState['motiveLastSelectedAt']>] ?? 0,
      shared.ledger.motiveLastSelectedAt[key] ?? 0)])),
  };
}

export function createProactiveDeviceControl(ports: ProactiveControlPorts) {
  let last: ProactiveControlState | undefined;
  let lastReadAt = 0;
  let serial = 0, appliedSerial = 0;
  let lastSettlement = '';
  async function post(action: string, body: Record<string, unknown> = {}) {
    const request = ++serial;
    try {
      const state = parseProactiveControlState(await ports.post(action, {
        ...body, controlVersion: 1, runtimeEpoch: ports.runtimeEpoch,
      }));
      if (!last && request >= appliedSerial || last && (state.revision > last.revision || state.revision === last.revision
        && (state.serverTimeMs > last.serverTimeMs || state.serverTimeMs === last.serverTimeMs && request > appliedSerial))) {
        last = state; lastReadAt = Date.now(); appliedSerial = request;
      }
      return state;
    } catch (error) {
      if (request >= appliedSerial) { last = undefined; appliedSerial = request; }
      throw isProactiveControlWait(error) ? error : new ProactiveControlWait('unavailable');
    }
  }
  const owned = (round: ProactiveControlRound | null | undefined, op: ContactOpportunity) => !!round
    && round.opportunityId === op.id && round.ownerDeviceId === ports.deviceId && round.runtimeEpoch === ports.runtimeEpoch;
  return {
    deviceId: ports.deviceId, runtimeEpoch: ports.runtimeEpoch,
    snapshot: () => last,
    post,
    read: () => post('state:read'),
    async reserve(op: ContactOpportunity, shared: ProactiveControlState, waitMs: number) {
      const state = await post('opportunities:reserve', { reservationId: op.id,
        kind: op.important || op.phoneEmergency ? 'important' : 'ordinary', expectedRevision: shared.revision,
        notBefore: Math.max(shared.ledger.lastEndedAt, shared.ledger.lastOrdinaryReplyAt) + waitMs,
        expiresAt: op.expiresAt, motives: op.motives });
      if (!owned(state.opportunity, op) || !['reserved', 'started'].includes(state.opportunity!.state)) {
        throw new ProactiveControlWait(state.waitReason ?? 'reservation_denied');
      }
      return state;
    },
    async start(op: ContactOpportunity) {
      const state = await post(`opportunities/${encodeURIComponent(op.id)}:start`, { reservationId: op.id });
      if (!owned(state.opportunity, op) || state.opportunity!.state !== 'started') throw new ProactiveControlWait('round_not_started');
      return state.opportunity!;
    },
    async current(op: ContactOpportunity) {
      const state = await post('state:read');
      const round = state.current;
      return owned(round, op) && round?.state === 'started' && round.deadlineAt !== null
        && state.serverTimeMs < round.deadlineAt ? round : null;
    },
    async camera(opportunityId: string, beforeCapture = false, minimumIntervalMs?: number) {
      // Candidate preparation precedes transport/start; capture always requires a started round.
      const state = await post(beforeCapture ? `opportunities/${encodeURIComponent(opportunityId)}:verify-camera` : 'state:read',
        beforeCapture ? { reservationId: opportunityId, minimumIntervalMs } : {});
      const round = state.current;
      const own = round?.opportunityId === opportunityId && round.ownerDeviceId === ports.deviceId
        && round.runtimeEpoch === ports.runtimeEpoch;
      return beforeCapture ? own && round.state === 'started' && state.cameraAllowed === true
        : own && ['reserved', 'started'].includes(round.state) && state.participants.some(p => p.deviceId === ports.deviceId
          && p.runtimeEpoch === ports.runtimeEpoch && p.standby && p.fresh && p.sampleStatus === 'ready');
    },
    async complete(op: ContactOpportunity) {
      const outcome = op.reason === 'delivered' || op.savedMessageIds.length ? 'completed' : 'cancelled';
      const key = `${op.id}:${outcome}`;
      if (lastSettlement === key) return last;
      const result = await post(`opportunities/${encodeURIComponent(op.id)}:complete`, { reservationId: op.id, outcome });
      lastSettlement = key;
      return result;
    },
    anchors() {
      return last && Date.now() - lastReadAt <= 30_000 ? {
        lastAttemptAt: last.ledger.lastCameraAttemptAt || undefined,
        lastSuccessfulObservationAt: last.ledger.lastSuccessfulObservationAt || undefined,
      } : undefined;
    },
  };
}
export type ProactiveDeviceControl = ReturnType<typeof createProactiveDeviceControl>;
let control: ProactiveDeviceControl | undefined;
export function bindProactiveDeviceControl(value: ProactiveDeviceControl | undefined) { control = value; }
export function unbindProactiveDeviceControl(owner: ProactiveDeviceControl | undefined) {
  if (owner && control === owner) control = undefined;
}
export function getProactiveDeviceControl() { return control; }
export function requireProactiveDeviceControl() {
  if (!control) throw new ProactiveControlWait('not_ready');
  return control;
}
