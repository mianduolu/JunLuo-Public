import { NativeModules, Platform } from 'react-native';
import {
  parsePhoneRestrictionPlanAllowance, parsePhoneRestrictionPlanInput,
  parsePhoneRestrictionAppTimeRule, parsePhoneRestrictionOccurrence,
  type PhoneRestrictionPlanAllowance, type PhoneRestrictionPlanInput,
  type PhoneRestrictionSavedPlan, type PhoneRestrictionAppTimeRule, type PhoneRestrictionOccurrence,
} from '../proactive/phoneRestrictionSchedule';
import {
  canCommitBackupRestoreDataEpoch,
  captureBackupRestoreDataEpoch,
  runBackupRestoreDataEpochCommit,
} from '../backup/backupRestoreCoordinator';

export type PhoneRestrictionDurations = {
  warningMs: number;
  temporaryMs: number;
  maximumTemporaryMs: number;
  appReleaseMs: number;
  emergencyMs: number;
};

export type PhoneRestrictionActor = 'I' | 'you';
export type PhoneRestrictionScope = 'phone' | 'apps';
export type PhoneRestrictionMode = 'warning' | 'direct';

export type PhoneRestrictionAuthorization = {
  id: string;
  scope: PhoneRestrictionScope;
  packages: string[];
  phoneAllowlist: string[];
  actors: PhoneRestrictionActor[];
  modes: PhoneRestrictionMode[];
  validFrom: number;
  validUntil: number;
  maximumTemporaryMs: number;
  planAllowance?: PhoneRestrictionPlanAllowance | null;
  allowTemporary?: boolean;
};

export type PhoneRestrictionConfiguration = {
  durations: PhoneRestrictionDurations;
  authorizations: PhoneRestrictionAuthorization[];
  defaultMode?: PhoneRestrictionMode;
};

export type PhoneRestrictionInstance = {
  id: string;
  authorizationId: string;
  actor: PhoneRestrictionActor;
  scope: PhoneRestrictionScope;
  packages: string[];
  mode: PhoneRestrictionMode;
  createdAt: number;
  warningUntil: number;
  endsAt: number;
  originalEndsAt: number;
  enteredAt: number | null;
  endedAt: number | null;
  endedBy: PhoneRestrictionActor | null;
  phase: 'warning' | 'restriction_due' | 'ended';
  lastChangedAt?: number;
  lastChangedBy?: PhoneRestrictionActor | null;
  originalRequest?: { scope: PhoneRestrictionScope; packages: string[]; mode: PhoneRestrictionMode; durationMs?: number | null };
  originalDurationMs?: number;
  phoneAllowlist?: string[];
  occurrence?: PhoneRestrictionOccurrence | null;
};

export type PhoneRestrictionAppRelease = {
  id: string;
  instanceId: string;
  packageName: string;
  actor: PhoneRestrictionActor;
  startedAt: number;
  until: number;
  durationMs?: number | null;
  originalDurationMs?: number;
};

export type PhoneRestrictionStartInput = {
  id: string;
  authorizationId: string;
  actor: PhoneRestrictionActor;
  scope: PhoneRestrictionScope;
  packages: string[];
  mode?: PhoneRestrictionMode;
  durationMs?: number | null;
};

export type PhoneRestrictionShortenInput = {
  id: string;
  actor: PhoneRestrictionActor;
  expectedEndsAt: number;
  until: number;
};

export type PhoneRestrictionEndInput = { id: string; actor: PhoneRestrictionActor };
export type PhoneRestrictionReleaseInput = {
  id: string;
  instanceId: string;
  packageName: string;
  actor: PhoneRestrictionActor;
  durationMs?: number | null;
};

export type PhoneRestrictionEmergency = {
  id: string;
  startedAt: number;
  until: number;
  extensions: { id: string; occurredAt: number; until: number }[];
  acceptedStartOperations: string[];
  endObserved: boolean;
};

export type PhoneRestrictionState = {
  schemaVersion: 1;
  durations: PhoneRestrictionDurations;
  durationsKnown?: boolean;
  defaultMode?: PhoneRestrictionMode;
  configurationKnown: boolean;
  authorizations: PhoneRestrictionAuthorization[];
  instances: PhoneRestrictionInstance[];
  appReleases: PhoneRestrictionAppRelease[];
  plans?: PhoneRestrictionSavedPlan[];
  appTimeRules?: PhoneRestrictionAppTimeRule[];
  paused?: boolean;
  resumedAt?: number;
  scheduleWake?: { mode: 'none' | 'exact' | 'inexact' | 'failed'; at: number | null; reason: string | null };
  emergency: PhoneRestrictionEmergency | null;
  pendingEvents: {
    id: string;
    kind: 'emergency_started' | 'emergency_extended' | 'emergency_ended';
    emergencyId: string;
    actor: 'you' | null;
    occurredAt: number;
    observedAt: number;
    until: number;
    operationIds: string[];
  }[];
  observedAt?: number;
  emergencyActive?: boolean;
  stateSaved?: boolean;
};

export type PhoneRestrictionUsage = {
  schemaVersion: 1;
  subject: 'you';
  observedAt: number;
  collectorRunning: boolean;
  restorePaused: boolean;
  usageObservation: {
    observedAt: number;
    rules: {
      ruleId: string;
      packageName: string;
      ordinaryUsedMs: number;
      dailyUsedMs: number;
      ordinaryLimitMs: number;
      dailyLimitMs: number;
      returnPending: boolean;
    }[];
    ongoing: { packageName: string; from: number; until: number } | null;
  } | null;
  emergencyUsage: {
    emergencyId: string;
    from: number;
    until: number;
    observedUntil: number;
    byApp: { packageName: string; usedMs: number }[];
    logsAvailable: boolean;
    logsTruncated: boolean;
  } | null;
};

type RestrictionNative = {
  getPhoneRestrictionState: () => Promise<string>;
  setPhoneRestrictionDurations: (json: string) => Promise<string>;
  startPhoneRestrictionEmergency: (operationId: string) => Promise<string>;
  extendPhoneRestrictionEmergency: (emergencyId: string, operationId: string) => Promise<string>;
  setPhoneRestrictionConfiguration?: (json: string) => Promise<string>;
  startPhoneRestrictionInstance?: (json: string) => Promise<string>;
  shortenPhoneRestrictionInstance?: (json: string) => Promise<string>;
  endPhoneRestrictionInstance?: (json: string) => Promise<string>;
  releasePhoneRestrictionApp?: (json: string) => Promise<string>;
  getPhoneRestrictionUsage?: () => Promise<string>;
  putPhoneRestrictionPlan?: (json: string) => Promise<string>;
  deletePhoneRestrictionPlan?: (json: string) => Promise<string>;
  setPhoneRestrictionPlanEnabled?: (id: string, enabled: boolean) => Promise<string>;
  setPhoneRestrictionPaused?: (paused: boolean) => Promise<string>;
  setPhoneRestrictionAppTimeRules?: (json: string) => Promise<string>;
};

export type PhoneRestrictionResult = {
  available: boolean;
  state: PhoneRestrictionState | null;
  stateSaved: boolean;
  overlayReleased?: boolean;
  reason?: 'NATIVE_UNAVAILABLE' | 'NATIVE_FAILURE' | 'INVALID_STATE' | 'INVALID_ARGUMENT'
    | 'RESTORE_NOT_READY' | 'STALE_DATA_EPOCH';
};

export type PhoneRestrictionUsageResult = {
  available: boolean;
  usage: PhoneRestrictionUsage | null;
  reason?: PhoneRestrictionResult['reason'];
};

function native(): RestrictionNative | null {
  const value = NativeModules.JunLuoPhoneActivity as Partial<RestrictionNative> | undefined;
  return Platform.OS === 'android' && value &&
    ['getPhoneRestrictionState', 'setPhoneRestrictionDurations', 'startPhoneRestrictionEmergency',
      'extendPhoneRestrictionEmergency'].every((key) => typeof value[key as keyof RestrictionNative] === 'function')
    ? value as RestrictionNative : null;
}

function validTime(value: unknown, zero = false): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= (zero ? 0 : 1);
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && !!value.trim();
}

function validActor(value: unknown): value is PhoneRestrictionActor {
  return value === 'I' || value === 'you';
}

function validMode(value: unknown): value is PhoneRestrictionMode {
  return value === 'warning' || value === 'direct';
}

function validStrings(value: unknown, nonempty = false): value is string[] {
  return Array.isArray(value) && (!nonempty || value.length > 0) && value.every(validId)
    && new Set(value).size === value.length;
}

function validDurations(value: unknown): value is PhoneRestrictionDurations {
  if (!value || typeof value !== 'object') return false;
  const durations = value as PhoneRestrictionDurations;
  return validTime(durations.warningMs, true)
    && [durations.temporaryMs, durations.maximumTemporaryMs, durations.appReleaseMs, durations.emergencyMs].every((v) => validTime(v))
    && durations.temporaryMs <= durations.maximumTemporaryMs;
}

export function parsePhoneRestrictionConfiguration(value: unknown): PhoneRestrictionConfiguration | null {
  if (!value || typeof value !== 'object') return null;
  const configuration = value as PhoneRestrictionConfiguration;
  if (!validDurations(configuration.durations) || !Array.isArray(configuration.authorizations)
    || (configuration.defaultMode !== undefined && !validMode(configuration.defaultMode))
    || !configuration.authorizations.every((authorization) => authorization && validId(authorization.id)
      && (authorization.scope === 'phone' || authorization.scope === 'apps')
      && validStrings(authorization.packages, authorization.scope === 'apps')
      && (authorization.scope !== 'phone' || authorization.packages.length === 0)
      && validStrings(authorization.phoneAllowlist)
      && (authorization.scope !== 'apps' || authorization.phoneAllowlist.length === 0)
      && validStrings(authorization.actors, true) && authorization.actors.every(validActor)
      && validStrings(authorization.modes, true) && authorization.modes.every(validMode)
      && validTime(authorization.validFrom, true) && validTime(authorization.validUntil)
      && authorization.validUntil > authorization.validFrom && validTime(authorization.maximumTemporaryMs)
      && (authorization.allowTemporary === undefined || typeof authorization.allowTemporary === 'boolean')
      && (authorization.planAllowance == null || !!parsePhoneRestrictionPlanAllowance(authorization.planAllowance)))
    || new Set(configuration.authorizations.map((authorization) => authorization.id)).size !== configuration.authorizations.length) return null;
  return configuration;
}

function validInstance(instance: PhoneRestrictionInstance, observedAt?: number) {
  return instance && validId(instance.id) && validId(instance.authorizationId) && validActor(instance.actor)
    && (instance.scope === 'phone' || instance.scope === 'apps')
    && validStrings(instance.packages, instance.scope === 'apps')
    && (instance.scope !== 'phone' || instance.packages.length === 0)
    && validMode(instance.mode)
    && (instance.phoneAllowlist === undefined || validStrings(instance.phoneAllowlist))
    && (instance.occurrence == null || (!!parsePhoneRestrictionOccurrence(instance.occurrence)
      && instance.occurrence.id === instance.id && instance.occurrence.startsAt === instance.createdAt
      && instance.occurrence.endsAt === instance.originalEndsAt && instance.endsAt <= instance.occurrence.endsAt))
    && (instance.originalRequest === undefined || (instance.originalRequest
      && (instance.originalRequest.scope === 'phone' || instance.originalRequest.scope === 'apps')
      && validStrings(instance.originalRequest.packages, instance.originalRequest.scope === 'apps')
      && (instance.originalRequest.scope !== 'phone' || instance.originalRequest.packages.length === 0)
      && validMode(instance.originalRequest.mode)
      && (instance.originalRequest.durationMs == null || (validTime(instance.originalRequest.durationMs)
        && instance.originalRequest.durationMs === instance.originalDurationMs))))
    && (instance.originalDurationMs === undefined || (validTime(instance.originalDurationMs)
      && instance.occurrence == null && instance.originalDurationMs === instance.originalEndsAt - instance.warningUntil))
    && validTime(instance.createdAt) && validTime(instance.warningUntil)
    && instance.warningUntil >= instance.createdAt && validTime(instance.endsAt)
    && instance.endsAt >= instance.createdAt && validTime(instance.originalEndsAt)
    && instance.originalEndsAt > instance.createdAt && instance.originalEndsAt >= instance.endsAt
    && (instance.enteredAt === null || (validTime(instance.enteredAt)
      && instance.enteredAt >= instance.warningUntil && instance.enteredAt < instance.originalEndsAt))
    && (instance.endedAt === null || (validTime(instance.endedAt) && instance.endedAt >= instance.createdAt))
    && (instance.endedBy === null || validActor(instance.endedBy))
    && ['warning', 'restriction_due', 'ended'].includes(instance.phase)
    && (instance.phase === 'ended'
      ? instance.endedAt !== null || (observedAt !== undefined && observedAt >= instance.endsAt && instance.endedBy === null)
      : instance.endedAt === null && instance.endedBy === null)
    && (observedAt === undefined || instance.phase === 'ended'
      || (observedAt < instance.endsAt && (instance.phase === 'warning'
        ? observedAt < instance.warningUntil : observedAt >= instance.warningUntil)))
    && (instance.lastChangedAt === undefined || validTime(instance.lastChangedAt))
    && (instance.lastChangedBy === undefined || instance.lastChangedBy === null || validActor(instance.lastChangedBy));
}

function parseState(value: unknown): PhoneRestrictionState | null {
  if (!value || typeof value !== 'object') return null;
  const state = value as PhoneRestrictionState;
  if (state.schemaVersion !== 1 || !state.durations || !Array.isArray(state.pendingEvents)) return null;
  if ((state.durationsKnown !== undefined && typeof state.durationsKnown !== 'boolean') ||
    (state.defaultMode !== undefined && !validMode(state.defaultMode)) ||
    (state.stateSaved !== undefined && typeof state.stateSaved !== 'boolean') ||
    (state.emergencyActive !== undefined && typeof state.emergencyActive !== 'boolean') ||
    (state.observedAt !== undefined && !validTime(state.observedAt))) return null;
  if (!validDurations(state.durations)) return null;
  if ((state.paused !== undefined && typeof state.paused !== 'boolean')
    || (state.resumedAt !== undefined && !validTime(state.resumedAt, true))
    || (state.plans !== undefined && (!Array.isArray(state.plans) || !state.plans.every((plan) =>
      !!parsePhoneRestrictionPlanInput(plan) && validTime(plan.createdAt) && validTime(plan.futureFrom, true))
      || new Set(state.plans.map((plan) => plan.schedule.id)).size !== state.plans.length))
    || (state.appTimeRules !== undefined && (!Array.isArray(state.appTimeRules)
      || !state.appTimeRules.every((rule) => !!parsePhoneRestrictionAppTimeRule(rule))
      || new Set(state.appTimeRules.map((rule) => rule.id)).size !== state.appTimeRules.length))
    || (state.scheduleWake !== undefined && (!state.scheduleWake
      || !['none', 'exact', 'inexact', 'failed'].includes(state.scheduleWake.mode)
      || (state.scheduleWake.at !== null && !validTime(state.scheduleWake.at))
      || (state.scheduleWake.reason !== null && !validId(state.scheduleWake.reason))))) return null;
  const legacy = state.configurationKnown === undefined && state.authorizations === undefined
    && state.instances === undefined && state.appReleases === undefined;
  if (!legacy && (typeof state.configurationKnown !== 'boolean'
    || !parsePhoneRestrictionConfiguration({ durations: state.durations, authorizations: state.authorizations, defaultMode: state.defaultMode })
    || !Array.isArray(state.instances) || !state.instances.every((instance) => validInstance(instance, state.observedAt))
    || new Set(state.instances.map((instance) => instance.id)).size !== state.instances.length
    || !Array.isArray(state.appReleases) || !state.appReleases.every((release) => release && validId(release.id)
      && validId(release.instanceId) && validId(release.packageName) && validActor(release.actor)
      && validTime(release.startedAt) && validTime(release.until) && release.until > release.startedAt
      && (release.originalDurationMs === undefined || (validTime(release.originalDurationMs)
        && release.originalDurationMs === release.until - release.startedAt))
      && (release.durationMs == null || (validTime(release.durationMs)
        && release.durationMs === release.originalDurationMs)))
    || new Set(state.appReleases.map((release) => release.id)).size !== state.appReleases.length)) return null;
  const emergency = state.emergency;
  if (emergency !== null && (!emergency || typeof emergency.id !== 'string' || !emergency.id.trim() ||
    !validTime(emergency.startedAt) || !validTime(emergency.until) || emergency.until <= emergency.startedAt ||
    typeof emergency.endObserved !== 'boolean' || !Array.isArray(emergency.extensions) ||
    !Array.isArray(emergency.acceptedStartOperations) ||
    !emergency.acceptedStartOperations.every((v) => typeof v === 'string' && !!v.trim()) ||
    !emergency.extensions.every((v) => v && typeof v.id === 'string' && !!v.id.trim() &&
      validTime(v.occurredAt) && validTime(v.until)))) return null;
  if (!state.pendingEvents.every((v) => v && typeof v.id === 'string' && !!v.id.trim() &&
    typeof v.emergencyId === 'string' && !!v.emergencyId.trim() &&
    ['emergency_started', 'emergency_extended', 'emergency_ended'].includes(v.kind) &&
    (v.actor === 'you' || (v.kind === 'emergency_ended' && v.actor === null)) &&
    Array.isArray(v.operationIds) && v.operationIds.every((id) => typeof id === 'string' && !!id.trim()) &&
    validTime(v.occurredAt) && validTime(v.observedAt) && validTime(v.until))) return null;
  return legacy ? { ...state, configurationKnown: false, authorizations: [], instances: [], appReleases: [] } : state;
}

function parseUsage(value: unknown): PhoneRestrictionUsage | null {
  if (!value || typeof value !== 'object') return null;
  const usage = value as PhoneRestrictionUsage;
  if (usage.schemaVersion !== 1 || usage.subject !== 'you' || !validTime(usage.observedAt)
    || typeof usage.collectorRunning !== 'boolean' || typeof usage.restorePaused !== 'boolean') return null;
  const observation = usage.usageObservation;
  if ((usage.restorePaused || !usage.collectorRunning) && observation !== null) return null;
  if (observation !== null && (!observation || !validTime(observation.observedAt)
    || observation.observedAt > usage.observedAt || !Array.isArray(observation.rules)
    || !observation.rules.every((rule) => rule && validId(rule.ruleId) && validId(rule.packageName)
      && validTime(rule.ordinaryUsedMs, true) && validTime(rule.dailyUsedMs, true)
      && validTime(rule.ordinaryLimitMs) && validTime(rule.dailyLimitMs) && typeof rule.returnPending === 'boolean')
    || new Set(observation.rules.map((rule) => rule.ruleId)).size !== observation.rules.length
    || (observation.ongoing !== null && (!observation.ongoing || !validId(observation.ongoing.packageName)
      || !validTime(observation.ongoing.from) || !validTime(observation.ongoing.until)
      || observation.ongoing.until <= observation.ongoing.from || observation.ongoing.until > observation.observedAt)))) return null;
  const emergency = usage.emergencyUsage;
  if (emergency !== null && (!emergency || !validId(emergency.emergencyId) || !validTime(emergency.from)
    || !validTime(emergency.until) || emergency.until <= emergency.from || !validTime(emergency.observedUntil)
    || emergency.observedUntil < emergency.from || emergency.observedUntil > emergency.until
    || typeof emergency.logsAvailable !== 'boolean' || typeof emergency.logsTruncated !== 'boolean'
    || !Array.isArray(emergency.byApp) || !emergency.byApp.every((app) => app && validId(app.packageName)
      && validTime(app.usedMs, true) && app.usedMs <= emergency.observedUntil - emergency.from)
    || new Set(emergency.byApp.map((app) => app.packageName)).size !== emergency.byApp.length)) return null;
  return usage;
}

function epochFailure(dataEpoch: number | null): PhoneRestrictionResult | null {
  const reason = dataEpoch === null ? 'RESTORE_NOT_READY'
    : !canCommitBackupRestoreDataEpoch(dataEpoch) ? 'STALE_DATA_EPOCH' : undefined;
  return reason ? { available: false, state: null, stateSaved: false, reason } : null;
}

async function requestInDataEpoch(
  call: (module: RestrictionNative) => Promise<string>,
  dataEpoch: number | null,
  readOnly = false,
  requiredMethod?: keyof RestrictionNative,
): Promise<PhoneRestrictionResult> {
  const blocked = epochFailure(dataEpoch);
  if (blocked) return blocked;
  const module = native();
  if (!module || (requiredMethod && typeof module[requiredMethod] !== 'function')) {
    return { available: false, state: null, stateSaved: false, reason: 'NATIVE_UNAVAILABLE' };
  }
  try {
    const value = JSON.parse(await call(module)) as unknown;
    const stale = epochFailure(dataEpoch);
    if (stale) return { ...stale, available: true };
    const result = value as { state?: unknown; stateSaved?: unknown; overlayReleased?: unknown };
    const state = parseState(readOnly ? value : result.state);
    if (!state || typeof result.stateSaved !== 'boolean' ||
      (result.overlayReleased !== undefined && typeof result.overlayReleased !== 'boolean')) {
      return { available: true, state: null, stateSaved: false, reason: 'INVALID_STATE' };
    }
    return { available: true, state, stateSaved: result.stateSaved,
      ...(typeof result.overlayReleased === 'boolean' ? { overlayReleased: result.overlayReleased } : {}) };
  } catch {
    const stale = epochFailure(dataEpoch);
    if (stale) return { ...stale, available: true };
    return { available: true, state: null, stateSaved: false, reason: 'NATIVE_FAILURE' };
  }
}

async function request(
  call: (module: RestrictionNative) => Promise<string>,
  readOnly = false,
  requiredMethod?: keyof RestrictionNative,
): Promise<PhoneRestrictionResult> {
  const dataEpoch = captureBackupRestoreDataEpoch();
  const blocked = epochFailure(dataEpoch);
  if (blocked) return blocked;
  const committed = await runBackupRestoreDataEpochCommit(dataEpoch, () => requestInDataEpoch(call, dataEpoch, readOnly, requiredMethod));
  return epochFailure(dataEpoch) ?? (committed.committed ? committed.value
    : { available: false, state: null, stateSaved: false, reason: 'STALE_DATA_EPOCH' });
}

function invalidArgument(): PhoneRestrictionResult {
  return { available: false, state: null, stateSaved: false, reason: 'INVALID_ARGUMENT' };
}

export function readPhoneRestrictionState() {
  return request((module) => module.getPhoneRestrictionState(), true);
}

export async function readPhoneRestrictionUsage(): Promise<PhoneRestrictionUsageResult> {
  const dataEpoch = captureBackupRestoreDataEpoch();
  const blocked = epochFailure(dataEpoch);
  if (blocked) return { available: false, usage: null, reason: blocked.reason };
  const committed = await runBackupRestoreDataEpochCommit(dataEpoch, async (): Promise<PhoneRestrictionUsageResult> => {
    const stale = epochFailure(dataEpoch);
    if (stale) return { available: false, usage: null, reason: stale.reason };
    const module = native();
    if (!module || typeof module.getPhoneRestrictionUsage !== 'function') {
      return { available: false, usage: null, reason: 'NATIVE_UNAVAILABLE' };
    }
    try {
      const value = JSON.parse(await module.getPhoneRestrictionUsage()) as unknown;
      const expired = epochFailure(dataEpoch);
      if (expired) return { available: true, usage: null, reason: expired.reason };
      const usage = parseUsage(value);
      return usage ? { available: true, usage } : { available: true, usage: null, reason: 'INVALID_STATE' };
    } catch {
      const expired = epochFailure(dataEpoch);
      return { available: true, usage: null, reason: expired?.reason ?? 'NATIVE_FAILURE' };
    }
  });
  const expired = epochFailure(dataEpoch);
  return expired ? { available: false, usage: null, reason: expired.reason }
    : committed.committed ? committed.value : { available: false, usage: null, reason: 'STALE_DATA_EPOCH' };
}

export function savePhoneRestrictionDurations(durations: PhoneRestrictionDurations) {
  return request((module) => module.setPhoneRestrictionDurations(JSON.stringify(durations)));
}

export function startPhoneRestrictionEmergency(operationId: string) {
  return request((module) => module.startPhoneRestrictionEmergency(operationId));
}

export function extendPhoneRestrictionEmergency(emergencyId: string, operationId: string) {
  return request((module) => module.extendPhoneRestrictionEmergency(emergencyId, operationId));
}

export function savePhoneRestrictionConfiguration(configuration: PhoneRestrictionConfiguration) {
  if (!parsePhoneRestrictionConfiguration(configuration)) return Promise.resolve(invalidArgument());
  return request((module) => module.setPhoneRestrictionConfiguration!(JSON.stringify(configuration)), false, 'setPhoneRestrictionConfiguration');
}

// Only settings work already inside runBackupRestoreDataEpochCommit uses this entry.
// It shares that lease instead of waiting for a second lease behind a queued restore.
export function savePhoneRestrictionConfigurationInDataEpoch(configuration: PhoneRestrictionConfiguration, dataEpoch: number | null) {
  if (!parsePhoneRestrictionConfiguration(configuration)) return Promise.resolve(invalidArgument());
  return requestInDataEpoch((module) => module.setPhoneRestrictionConfiguration!(JSON.stringify(configuration)), dataEpoch, false, 'setPhoneRestrictionConfiguration');
}

export function startPhoneRestrictionInstance(input: PhoneRestrictionStartInput) {
  if (!input || !validId(input.id) || !validId(input.authorizationId) || !validActor(input.actor)
    || (input.scope !== 'phone' && input.scope !== 'apps') || !validStrings(input.packages, input.scope === 'apps')
    || (input.scope === 'phone' && input.packages.length !== 0) || (input.mode !== undefined && !validMode(input.mode))
    || (input.durationMs != null && !validTime(input.durationMs))) {
    return Promise.resolve(invalidArgument());
  }
  return request((module) => module.startPhoneRestrictionInstance!(JSON.stringify(input)), false, 'startPhoneRestrictionInstance');
}

export function savePhoneRestrictionPlan(input: PhoneRestrictionPlanInput) {
  const parsed = parsePhoneRestrictionPlanInput(input);
  if (!parsed) return Promise.resolve(invalidArgument());
  return request((module) => module.putPhoneRestrictionPlan!(JSON.stringify(parsed)), false, 'putPhoneRestrictionPlan');
}

export function deletePhoneRestrictionPlan(id: string, actor: PhoneRestrictionActor) {
  if (!validId(id) || !validActor(actor)) return Promise.resolve(invalidArgument());
  return request((module) => module.deletePhoneRestrictionPlan!(JSON.stringify({ id, actor })), false, 'deletePhoneRestrictionPlan');
}

export function setPhoneRestrictionPlanEnabled(id: string, enabled: boolean) {
  if (!validId(id) || typeof enabled !== 'boolean') return Promise.resolve(invalidArgument());
  return request((module) => module.setPhoneRestrictionPlanEnabled!(id, enabled), false, 'setPhoneRestrictionPlanEnabled');
}

// Local settings actions. No model/tool consumer is connected in chapter 4.
export function setPhoneRestrictionPaused(paused: boolean) {
  if (typeof paused !== 'boolean') return Promise.resolve(invalidArgument());
  return request((module) => module.setPhoneRestrictionPaused!(paused), false, 'setPhoneRestrictionPaused');
}

export function savePhoneRestrictionAppTimeRules(rules: PhoneRestrictionAppTimeRule[]) {
  if (!Array.isArray(rules) || !rules.every((rule) => !!parsePhoneRestrictionAppTimeRule(rule))
    || new Set(rules.map((rule) => rule.id)).size !== rules.length) return Promise.resolve(invalidArgument());
  return request((module) => module.setPhoneRestrictionAppTimeRules!(JSON.stringify(rules)), false, 'setPhoneRestrictionAppTimeRules');
}

export function shortenPhoneRestrictionInstance(input: PhoneRestrictionShortenInput) {
  if (!input || !validId(input.id) || !validActor(input.actor) || !validTime(input.expectedEndsAt)
    || !validTime(input.until) || input.until > input.expectedEndsAt) return Promise.resolve(invalidArgument());
  return request((module) => module.shortenPhoneRestrictionInstance!(JSON.stringify(input)), false, 'shortenPhoneRestrictionInstance');
}

export function endPhoneRestrictionInstance(input: PhoneRestrictionEndInput) {
  if (!input || !validId(input.id) || !validActor(input.actor)) return Promise.resolve(invalidArgument());
  return request((module) => module.endPhoneRestrictionInstance!(JSON.stringify(input)), false, 'endPhoneRestrictionInstance');
}

export function releasePhoneRestrictionApp(input: PhoneRestrictionReleaseInput) {
  if (!input || !validId(input.id) || !validId(input.instanceId) || !validId(input.packageName) || !validActor(input.actor)
    || (input.durationMs != null && !validTime(input.durationMs))) {
    return Promise.resolve(invalidArgument());
  }
  return request((module) => module.releasePhoneRestrictionApp!(JSON.stringify(input)), false, 'releasePhoneRestrictionApp');
}
