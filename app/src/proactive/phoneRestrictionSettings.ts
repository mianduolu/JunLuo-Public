import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  parsePhoneRestrictionConfiguration,
  savePhoneRestrictionConfigurationInDataEpoch,
  type PhoneRestrictionAuthorization,
  type PhoneRestrictionConfiguration,
  type PhoneRestrictionResult,
  type PhoneRestrictionState,
} from '../backend/phoneRestrictionNative';
import { readPhoneRestrictionState } from '../backend/phoneRestrictionNative';
import {
  parsePhoneRestrictionManagement,
  phoneRestrictionManagementFromNative,
  synchronizePhoneRestrictionManagement,
  type PhoneRestrictionManagement,
} from '../phoneRestriction/phoneRestrictionManagement';
import { parsePhoneRestrictionPlanInput, parsePhoneRestrictionAppTimeRule,
  type PhoneRestrictionPlanInput, type PhoneRestrictionAppTimeRule } from './phoneRestrictionSchedule';
import {
  canCommitBackupRestoreDataEpoch,
  captureBackupRestoreDataEpoch,
  runBackupRestoreDataEpochCommit,
} from '../backup/backupRestoreCoordinator';
import type { PhoneActivityProactiveSettings } from './phoneActivityRules';
import { executePhoneLimitPlan, type PhoneLimitPlanNativePorts, type PhoneLimitPreparedPlan,
  type PhoneLimitPlanExecutionResult } from '../tools/phoneLimitPlanExecution';
import type { PhoneLimitSetPlanInput } from '../tools/phoneLimitContract';

export const PHONE_ACTIVITY_PROACTIVE_SETTINGS_KEY = 'junluo.phoneActivityProactive.settings';

export type PhoneRestrictionSettingsFailure = NonNullable<PhoneRestrictionResult['reason']> | 'STORAGE_FAILURE'
  | 'INVALID_SETTINGS' | 'INVALID_CONFIGURATION'
  | 'CONFIGURATION_MISSING' | 'NATIVE_NOT_SAVED' | 'INVALID_MANAGEMENT' | 'MANAGEMENT_MISSING';
type SettingsFailure = PhoneRestrictionSettingsFailure;

export type PhoneRestrictionSettingsResult = {
  storageSaved: boolean;
  nativeSaved: boolean;
  configuration: PhoneRestrictionConfiguration | null;
  state: PhoneRestrictionState | null;
  reason?: SettingsFailure;
};

let settingsWrite: Promise<unknown> = Promise.resolve();

function serializeSettingsWrite<T>(work: () => Promise<T>) {
  const pending = settingsWrite.then(work);
  settingsWrite = pending.catch(() => undefined);
  return pending;
}

function failure(reason: SettingsFailure, storageSaved = false): PhoneRestrictionSettingsResult {
  return { storageSaved, nativeSaved: false, configuration: null, state: null, reason };
}

function epochReason(dataEpoch: number | null): SettingsFailure | undefined {
  return dataEpoch === null ? 'RESTORE_NOT_READY'
    : !canCommitBackupRestoreDataEpoch(dataEpoch) ? 'STALE_DATA_EPOCH' : undefined;
}

function parseSettings(raw: string | null): Record<string, unknown> | null {
  if (raw === null) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function sameAuthorization(left: PhoneRestrictionAuthorization, right: PhoneRestrictionAuthorization) {
  return left.id === right.id && left.scope === right.scope && left.validFrom === right.validFrom
    && left.validUntil === right.validUntil && left.maximumTemporaryMs === right.maximumTemporaryMs
    && (left.allowTemporary ?? true) === (right.allowTemporary ?? true)
    && sameStrings(left.packages, right.packages)
    && sameStrings(left.phoneAllowlist, right.phoneAllowlist)
    && sameStrings(left.actors, right.actors)
    && sameStrings(left.modes, right.modes)
    && sameAllowance(left.planAllowance, right.planAllowance);
}

function sameAllowance(left: PhoneRestrictionAuthorization['planAllowance'], right: PhoneRestrictionAuthorization['planAllowance']) {
  if (!left || !right) return !left && !right;
  return left.dates.localDate === right.dates.localDate
    && sameStrings((left.dates.weekdays ?? []).map(String), (right.dates.weekdays ?? []).map(String))
    && left.windows.length === right.windows.length && left.windows.every((window) =>
      right.windows.some((other) => other.id === window.id && other.startTime === window.startTime && other.endTime === window.endTime));
}

function sameStrings(left: string[], right: string[]) {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function sameConfiguration(left: PhoneRestrictionConfiguration, right: PhoneRestrictionConfiguration) {
  return (left.defaultMode ?? 'warning') === (right.defaultMode ?? 'warning')
    && (Object.keys(left.durations) as (keyof PhoneRestrictionConfiguration['durations'])[])
    .every((key) => left.durations[key] === right.durations[key])
    && left.authorizations.length === right.authorizations.length
    && left.authorizations.every((authorization) => {
      const other = right.authorizations.find((entry) => entry.id === authorization.id);
      return !!other && sameAuthorization(authorization, other);
    });
}

async function synchronizeInDataEpoch(configuration: PhoneRestrictionConfiguration, dataEpoch: number | null) {
  const result = await savePhoneRestrictionConfigurationInDataEpoch(configuration, dataEpoch);
  const nativeSaved = result.stateSaved && !!result.state?.configurationKnown
    && sameConfiguration(configuration, { durations: result.state.durations, authorizations: result.state.authorizations,
      defaultMode: result.state.defaultMode });
  return { storageSaved: true, nativeSaved, configuration, state: result.state,
    ...(nativeSaved ? {} : { reason: result.reason ?? 'NATIVE_NOT_SAVED' as const }) };
}

async function inSettingsDataEpoch(
  dataEpoch: number | null,
  work: () => Promise<PhoneRestrictionSettingsResult>,
): Promise<PhoneRestrictionSettingsResult> {
  const blocked = epochReason(dataEpoch);
  if (blocked) return failure(blocked);
  const committed = await runBackupRestoreDataEpochCommit(dataEpoch, work);
  if (!committed.committed) return failure('STALE_DATA_EPOCH');
  const stale = epochReason(dataEpoch);
  return stale ? failure(stale, committed.value.storageSaved) : committed.value;
}

export async function loadPhoneRestrictionConfigurationSettings(): Promise<{
  configuration: PhoneRestrictionConfiguration | null;
  reason?: SettingsFailure;
}> {
  const dataEpoch = captureBackupRestoreDataEpoch();
  const result = await inSettingsDataEpoch(dataEpoch, async () => {
    let raw: string | null;
    try { raw = await AsyncStorage.getItem(PHONE_ACTIVITY_PROACTIVE_SETTINGS_KEY); }
    catch { return failure('STORAGE_FAILURE'); }
    const settings = parseSettings(raw);
    if (!settings) return failure('INVALID_SETTINGS');
    if (settings.restrictionConfiguration === undefined) return { ...failure('CONFIGURATION_MISSING'), reason: undefined };
    const configuration = parsePhoneRestrictionConfiguration(settings.restrictionConfiguration);
    return configuration ? { storageSaved: true, nativeSaved: false, configuration, state: null }
      : failure('INVALID_CONFIGURATION');
  });
  return { configuration: result.configuration, ...(result.reason ? { reason: result.reason } : {}) };
}

async function writeSettingsInDataEpoch(
  dataEpoch: number | null,
  incoming: Record<string, unknown>,
  replaceSettings: boolean,
  afterStorage?: (payload: string) => Promise<void>,
): Promise<PhoneRestrictionSettingsResult> {
  let raw: string | null;
  try { raw = await AsyncStorage.getItem(PHONE_ACTIVITY_PROACTIVE_SETTINGS_KEY); }
  catch { return failure('STORAGE_FAILURE'); }
  const stored = parseSettings(raw);
  if (!stored) return failure('INVALID_SETTINGS');
  const previous = stored.restrictionConfiguration === undefined ? null
    : parsePhoneRestrictionConfiguration(stored.restrictionConfiguration);
  const previousInvalid = stored.restrictionConfiguration !== undefined && !previous;
  if (previousInvalid && !replaceSettings) return failure('INVALID_CONFIGURATION');
  // An old rule edit preserves unreadable restriction data rather than replacing it.
  const nextValue = previousInvalid ? stored.restrictionConfiguration
    : incoming.restrictionConfiguration === undefined ? stored.restrictionConfiguration : incoming.restrictionConfiguration;
  const configuration = nextValue === undefined ? null : parsePhoneRestrictionConfiguration(nextValue);
  const configurationInvalid = nextValue !== undefined && !configuration;
  if (configurationInvalid && !replaceSettings) return failure('INVALID_CONFIGURATION');
  const settings = { ...stored, ...incoming,
    ...(nextValue !== undefined ? { restrictionConfiguration: nextValue } : {}) };
  const blocked = epochReason(dataEpoch);
  if (blocked) return failure(blocked);
  const payload = JSON.stringify(settings);
  try { await AsyncStorage.setItem(PHONE_ACTIVITY_PROACTIVE_SETTINGS_KEY, payload); }
  catch { return failure('STORAGE_FAILURE'); }
  const stale = epochReason(dataEpoch);
  if (stale) return failure(stale, true);
  if (afterStorage) await afterStorage(payload);
  if (configurationInvalid) return failure('INVALID_CONFIGURATION', true);
  const configurationResult: PhoneRestrictionSettingsResult = configuration ? await synchronizeInDataEpoch(configuration, dataEpoch)
    : { storageSaved: true, nativeSaved: false, configuration: null, state: null };
  if (configurationResult.reason || stored.restrictionManagement === undefined) return configurationResult;
  const management = parsePhoneRestrictionManagement(stored.restrictionManagement);
  if (!management) return { ...configurationResult, nativeSaved: false, reason: 'INVALID_MANAGEMENT' };
  const result = await synchronizePhoneRestrictionManagement(management);
  return { ...configurationResult, nativeSaved: result.stateSaved, state: result.state,
    ...(result.stateSaved ? {} : { reason: result.reason ?? 'NATIVE_NOT_SAVED' }) };
}

export function savePhoneRestrictionConfigurationSettings(configuration: PhoneRestrictionConfiguration) {
  if (!parsePhoneRestrictionConfiguration(configuration)) return Promise.resolve(failure('INVALID_CONFIGURATION'));
  const dataEpoch = captureBackupRestoreDataEpoch();
  return serializeSettingsWrite(() => inSettingsDataEpoch(dataEpoch,
    () => writeSettingsInDataEpoch(dataEpoch, { restrictionConfiguration: configuration }, false)));
}

export function syncPhoneRestrictionConfigurationSettings() {
  const dataEpoch = captureBackupRestoreDataEpoch();
  return serializeSettingsWrite(() => inSettingsDataEpoch(dataEpoch, async () => {
    let raw: string | null;
    try { raw = await AsyncStorage.getItem(PHONE_ACTIVITY_PROACTIVE_SETTINGS_KEY); }
    catch { return failure('STORAGE_FAILURE'); }
    const settings = parseSettings(raw);
    if (!settings) return failure('INVALID_SETTINGS');
    if (settings.restrictionConfiguration === undefined) return failure('CONFIGURATION_MISSING');
    const configuration = parsePhoneRestrictionConfiguration(settings.restrictionConfiguration);
    return configuration ? synchronizeInDataEpoch(configuration, dataEpoch) : failure('INVALID_CONFIGURATION');
  }));
}

// The old settings mirror keeps its focus rules and collector steps in this callback.
// Restriction-only saves never call those steps or capture a policy/model observation.
export function mirrorPhoneActivitySettingsWithRestrictionConfiguration(
  settings: PhoneActivityProactiveSettings,
  afterStorage: (payload: string) => Promise<void>,
) {
  const dataEpoch = captureBackupRestoreDataEpoch();
  return serializeSettingsWrite(() => inSettingsDataEpoch(dataEpoch,
    () => writeSettingsInDataEpoch(dataEpoch, settings, true, afterStorage)));
}

export type PhoneRestrictionManagementSettingsResult = PhoneRestrictionSettingsResult & {
  management: PhoneRestrictionManagement | null;
};

export type PhoneRestrictionManagementSettingsLoad = {
  management: PhoneRestrictionManagement | null;
  state: PhoneRestrictionState | null;
  sourceKnown: boolean;
  reason?: SettingsFailure;
};

export async function loadPhoneRestrictionManagementSettings(): Promise<PhoneRestrictionManagementSettingsLoad> {
  const dataEpoch = captureBackupRestoreDataEpoch();
  const blocked = epochReason(dataEpoch);
  if (blocked) return { management: null, state: null, sourceKnown: false, reason: blocked };
  const committed = await runBackupRestoreDataEpochCommit(dataEpoch, async (): Promise<PhoneRestrictionManagementSettingsLoad> => {
    let settings: Record<string, unknown> | null;
    try { settings = parseSettings(await AsyncStorage.getItem(PHONE_ACTIVITY_PROACTIVE_SETTINGS_KEY)); }
    catch { return { management: null, state: null, sourceKnown: false, reason: 'STORAGE_FAILURE' }; }
    if (!settings) return { management: null, state: null, sourceKnown: false, reason: 'INVALID_SETTINGS' };
    const sourceKnown = settings.restrictionManagement !== undefined;
    const management = sourceKnown ? parsePhoneRestrictionManagement(settings.restrictionManagement) : null;
    if (sourceKnown && !management) return { management: null, state: null, sourceKnown: true, reason: 'INVALID_MANAGEMENT' };
    const native = await readPhoneRestrictionState();
    return { management: sourceKnown ? management : phoneRestrictionManagementFromNative(native.state),
      state: native.state, sourceKnown, ...(native.reason ? { reason: native.reason } : {}) };
  });
  const stale = epochReason(dataEpoch);
  return stale || !committed.committed
    ? { management: null, state: null, sourceKnown: false, reason: stale ?? 'STALE_DATA_EPOCH' } : committed.value;
}

function managementFailure(reason: SettingsFailure, storageSaved = false): PhoneRestrictionManagementSettingsResult {
  return { ...failure(reason, storageSaved), management: null };
}

function managementWrite(
  edit: (management: PhoneRestrictionManagement) => PhoneRestrictionManagement | null,
  write: boolean,
): Promise<PhoneRestrictionManagementSettingsResult> {
  const dataEpoch = captureBackupRestoreDataEpoch();
  return serializeSettingsWrite(async () => {
    const blocked = epochReason(dataEpoch);
    if (blocked) return managementFailure(blocked);
    const committed = await runBackupRestoreDataEpochCommit(dataEpoch, async (): Promise<PhoneRestrictionManagementSettingsResult> => {
      let settings: Record<string, unknown> | null;
      try { settings = parseSettings(await AsyncStorage.getItem(PHONE_ACTIVITY_PROACTIVE_SETTINGS_KEY)); }
      catch { return managementFailure('STORAGE_FAILURE'); }
      if (!settings) return managementFailure('INVALID_SETTINGS');
      let previous: PhoneRestrictionManagement | null;
      if (settings.restrictionManagement === undefined) {
        // A normal mirror with no management source never reaches this branch.
        if (!write) return managementFailure('MANAGEMENT_MISSING');
        const native = await readPhoneRestrictionState();
        previous = phoneRestrictionManagementFromNative(native.state);
        if (!previous) return managementFailure(native.reason ?? 'MANAGEMENT_MISSING');
      } else {
        previous = parsePhoneRestrictionManagement(settings.restrictionManagement);
        if (!previous) return managementFailure('INVALID_MANAGEMENT');
      }
      const management = edit(previous);
      if (!management || !parsePhoneRestrictionManagement(management)) return managementFailure('INVALID_MANAGEMENT');
      const blockedWrite = epochReason(dataEpoch);
      if (blockedWrite) return managementFailure(blockedWrite);
      if (write) {
        const payload = { ...settings, restrictionManagement: preserveManagementFields(settings.restrictionManagement, management) };
        try { await AsyncStorage.setItem(PHONE_ACTIVITY_PROACTIVE_SETTINGS_KEY, JSON.stringify(payload)); }
        catch { return managementFailure('STORAGE_FAILURE'); }
      }
      const stale = epochReason(dataEpoch);
      if (stale) return managementFailure(stale, write);
      const result = await synchronizePhoneRestrictionManagement(management);
      return { storageSaved: true, nativeSaved: result.stateSaved, management, configuration: null, state: result.state,
        ...(result.stateSaved ? {} : { reason: result.reason ?? 'NATIVE_NOT_SAVED' }) };
    });
    const stale = epochReason(dataEpoch);
    return stale || !committed.committed
      ? managementFailure(stale ?? 'STALE_DATA_EPOCH', committed.committed && committed.value.storageSaved) : committed.value;
  });
}

// Keep future/unknown metadata alongside known fields, including untouched entries.
// Array membership comes from the explicit edit, so removals remain removals.
function preserveManagementFields(previous: unknown, next: unknown): unknown {
  if (Array.isArray(next)) {
    const old = Array.isArray(previous) ? previous : [];
    return next.map((entry) => {
      const id = entry?.id ?? entry?.input?.schedule?.id;
      return id === undefined ? entry : preserveManagementFields(
        old.find((candidate) => (candidate?.id ?? candidate?.input?.schedule?.id) === id), entry);
    });
  }
  if (!next || typeof next !== 'object') return next;
  const old = previous && typeof previous === 'object' && !Array.isArray(previous)
    ? previous as Record<string, unknown> : {};
  return { ...old, ...Object.fromEntries(Object.entries(next).map(([key, value]) =>
    [key, preserveManagementFields(old[key], value)])) };
}

export function savePhoneRestrictionManagedPlan(input: PhoneRestrictionPlanInput, title: string) {
  const parsed = parsePhoneRestrictionPlanInput(input);
  if (!parsed || typeof title !== 'string' || !title.trim()) return Promise.resolve(managementFailure('INVALID_MANAGEMENT'));
  return managementWrite((management) => ({ ...management,
    plans: [...management.plans.filter((plan) => plan.input.schedule.id !== parsed.schedule.id), { input: parsed, title }] }), true);
}

export function deletePhoneRestrictionManagedPlan(id: string) {
  if (typeof id !== 'string' || !id.trim()) return Promise.resolve(managementFailure('INVALID_ARGUMENT'));
  return managementWrite((management) => ({ ...management,
    plans: management.plans.filter((plan) => plan.input.schedule.id !== id) }), true);
}

export function setPhoneRestrictionManagedPlanEnabled(id: string, enabled: boolean) {
  if (typeof id !== 'string' || !id.trim() || typeof enabled !== 'boolean') return Promise.resolve(managementFailure('INVALID_ARGUMENT'));
  return managementWrite((management) => !management.plans.some((plan) => plan.input.schedule.id === id) ? null
    : { ...management, plans: management.plans.map((plan) => plan.input.schedule.id !== id ? plan
      : { ...plan, input: { ...plan.input, schedule: { ...plan.input.schedule, enabled } } }) }, true);
}

export function savePhoneRestrictionManagedAppTimeRules(rules: PhoneRestrictionAppTimeRule[]) {
  if (!Array.isArray(rules) || !rules.every((rule) => !!parsePhoneRestrictionAppTimeRule(rule))
    || new Set(rules.map((rule) => rule.id)).size !== rules.length) return Promise.resolve(managementFailure('INVALID_MANAGEMENT'));
  return managementWrite((management) => ({ ...management, appTimeRules: rules }), true);
}

export function syncPhoneRestrictionManagementSettings() {
  return managementWrite((management) => management, false);
}

// I's tool path changes one source entry and one native plan. Local UI saves retain their existing path.
export function savePhoneRestrictionManagedPlanForI(callId: string, input: PhoneLimitSetPlanInput,
  native: PhoneLimitPlanNativePorts,
  options: { beforeWrite?: (prepared: PhoneLimitPreparedPlan) => Promise<void>;
    beforeSourceSave?: () => Promise<void> } = {}): Promise<PhoneLimitPlanExecutionResult> {
  const dataEpoch = captureBackupRestoreDataEpoch();
  const rejected = (): PhoneLimitPlanExecutionResult => ({ outcome: 'rejected', data: { plans: null } });
  return serializeSettingsWrite(async () => {
    if (epochReason(dataEpoch)) return rejected();
    const committed = await runBackupRestoreDataEpochCommit(dataEpoch, () => executePhoneLimitPlan(callId, input, {
      native, beforeWrite: options.beforeWrite, isCurrent: () => canCommitBackupRestoreDataEpoch(dataEpoch),
      readSettings: async () => {
        const raw = await AsyncStorage.getItem(PHONE_ACTIVITY_PROACTIVE_SETTINGS_KEY);
        return raw === null ? null : parseSettings(raw);
      },
      writeSettings: async (settings, management) => {
        if (options.beforeSourceSave) await options.beforeSourceSave();
        if (!canCommitBackupRestoreDataEpoch(dataEpoch)) throw new Error('STALE_DATA_EPOCH');
        await AsyncStorage.setItem(PHONE_ACTIVITY_PROACTIVE_SETTINGS_KEY, JSON.stringify({ ...settings,
          restrictionManagement: preserveManagementFields(settings.restrictionManagement, management) }));
      },
    }));
    if (!committed.committed) return rejected();
    return epochReason(dataEpoch) ? { outcome: 'unknown', data: { plans: null } } : committed.value;
  });
}
