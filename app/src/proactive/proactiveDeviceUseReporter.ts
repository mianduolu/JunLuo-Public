import { sampleRecentDeviceUse, RECENT_DEVICE_USE_POLL_MS, RECENT_DEVICE_USE_HEARTBEAT_MS,
  type RawRecentDeviceUseSample, type RecentDeviceUseSampleState } from './recentDeviceUse';
import { bindProactiveDeviceControl, unbindProactiveDeviceControl, createProactiveDeviceControl, type ProactiveDeviceControl } from './proactiveDeviceControl';

export type ProactiveDeviceUseReporterPorts = {
  identity(): Promise<{ deviceId: string; platform: 'android' | 'windows'; scope: string } | null>;
  dataEpoch(): number | null;
  newRuntimeEpoch(): string;
  sample(): Promise<RawRecentDeviceUseSample>;
  monotonicNow(): Promise<number | null>;
  post(action: string, body: Record<string, unknown>): Promise<unknown>;
  localState(serverDay: string): Promise<{ enabled: boolean; standby: boolean; migration: {
    day: string; used: number; legacyCurrentActive: boolean; lastEndedAt: number; lastOrdinaryReplyAt: number;
    motiveLastSelectedAt: Record<string, number>; lastCameraAttemptAt: number; lastSuccessfulObservationAt: number;
  } }>;
  onState?(): void;
};

/** One latest sample and one heartbeat. No input history or background model is started here. */
export function createProactiveDeviceUseReporter(p: ProactiveDeviceUseReporterPorts) {
  let sample: RecentDeviceUseSampleState | null = null;
  let control: ProactiveDeviceControl | undefined;
  let scope = '', sourceRuntime = '', epoch: number | null = null, reportSequence = 0;
  let reportAt = 0, lastStatus = '', lastSequence = -1;
  let previousWall: number | undefined, previousMono: number | undefined;
  let busy: Promise<void> | undefined;
  let stopped = false;
  let started = false, generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function reset() {
    unbindProactiveDeviceControl(control); control = undefined; sample = null;
    reportAt = 0; reportSequence = 0; lastStatus = ''; lastSequence = -1;
  }
  async function tick() {
    if (stopped) return;
    const identity = await p.identity(); const nextEpoch = p.dataEpoch();
    if (!identity || nextEpoch === null) { reset(); return; }
    let raw = await p.sample();
    const wall = Date.now();
    const clockJump = previousWall !== undefined && previousMono !== undefined
      && Math.abs((wall - previousWall) - (raw.sampledMonotonicMs - previousMono)) > 1000;
    previousWall = wall; previousMono = raw.sampledMonotonicMs;
    if (clockJump) raw = { ...raw, sampleStatus: 'unknown', inputToken: null, inputAgeMs: null };
    if (stopped || nextEpoch !== p.dataEpoch()) return;
    if (scope !== identity.scope || epoch !== nextEpoch || !control) {
      reset(); scope = identity.scope; epoch = nextEpoch;
      control = createProactiveDeviceControl({ deviceId: identity.deviceId,
        runtimeEpoch: p.newRuntimeEpoch(), post: async (action, body) => {
          const before = await p.identity();
          if (stopped || nextEpoch !== p.dataEpoch() || before?.scope !== identity.scope) {
            throw Error('proactive-control-scope-changed');
          }
          const response = await p.post(action, body);
          const after = await p.identity();
          if (stopped || nextEpoch !== p.dataEpoch() || after?.scope !== identity.scope) {
            throw Error('proactive-control-scope-changed');
          }
          return response;
        } });
    }
    // The reader is replaceable; only the owning app/data epoch ends a contact round.
    sourceRuntime = raw.runtimeEpoch;
    const owner = control;
    sample = sampleRecentDeviceUse(sample, { ...raw, runtimeEpoch: owner.runtimeEpoch }, identity);
    let snapshot = sample.snapshot;
    if (snapshot.sampleStatus === lastStatus && snapshot.eventSequence === lastSequence
      && snapshot.sampledMonotonicMs >= reportAt
      && snapshot.sampledMonotonicMs - reportAt < RECENT_DEVICE_USE_HEARTBEAT_MS) return;
    const m0 = await p.monotonicNow();
    if (m0 === null) { unbindProactiveDeviceControl(owner); p.onState?.(); return; }
    const calibrated = await owner.post('state:read', { monotonicMs: m0 });
    const m1 = await p.monotonicNow();
    if (m1 === null || !calibrated.calibration || m1 < m0) {
      unbindProactiveDeviceControl(owner); p.onState?.(); return;
    }
    // Report a sample taken after the calibration receipt, on that same OS clock.
    const reportingSample = await p.sample();
    if (reportingSample.runtimeEpoch !== sourceRuntime) { unbindProactiveDeviceControl(owner); return; }
    sample = sampleRecentDeviceUse(sample, { ...reportingSample, runtimeEpoch: owner.runtimeEpoch,
      ...(clockJump || m1 - m0 > 2000 ? { sampleStatus: 'unknown' as const, inputToken: null, inputAgeMs: null } : {}) }, identity);
    snapshot = sample.snapshot;
    const local = await p.localState(calibrated.day);
    const beforeReport = await p.identity();
    if (stopped || nextEpoch !== p.dataEpoch() || owner !== control || beforeReport?.scope !== identity.scope) return;
    await owner.post('devices/self:report', { reportSequence: ++reportSequence,
      enabled: local.enabled, standby: local.standby,
      sampleStatus: snapshot.sampleStatus === 'ready' ? 'ready' : 'unknown',
      sampleMonotonicMs: snapshot.sampledMonotonicMs, calibrationId: calibrated.calibration.id,
      calibrationReceivedMonotonicMs: m1,
      input: snapshot.sampleStatus === 'ready' && snapshot.inputAgeMs !== null
        ? { eventSequence: snapshot.eventSequence, inputAgeMs: snapshot.inputAgeMs } : null,
      migration: local.migration });
    const afterReport = await p.identity();
    if (stopped || nextEpoch !== p.dataEpoch() || owner !== control || afterReport?.scope !== identity.scope) return;
    bindProactiveDeviceControl(owner);
    reportAt = snapshot.sampledMonotonicMs; lastStatus = snapshot.sampleStatus; lastSequence = snapshot.eventSequence;
    p.onState?.();
  }
  function check(): Promise<void> {
    if (!busy) busy = tick().catch(() => {
      // The server expires missing evidence. Never turn an outage into a fresh local claim.
      unbindProactiveDeviceControl(control);
      p.onState?.();
    }).finally(() => { busy = undefined; });
    return busy;
  }
  function schedule(ownGeneration: number) {
    if (stopped || !started || ownGeneration !== generation) return;
    timer = setTimeout(() => {
      timer = undefined;
      void check().finally(() => schedule(ownGeneration));
    }, RECENT_DEVICE_USE_POLL_MS);
  }
  return {
    check,
    start() { if (started) return; started = true; stopped = false;
      const ownGeneration = ++generation; void check().finally(() => schedule(ownGeneration)); },
    stop() { stopped = true; started = false; generation++;
      if (timer) clearTimeout(timer); timer = undefined; reset(); },
  };
}
