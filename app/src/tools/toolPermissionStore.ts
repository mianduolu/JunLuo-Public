import { toolsWorkspaceStorageBridge as AsyncStorage } from '../sync/syncToolsWorkspaceStorageBridge';

import type { JunLuoToolPermissionLevel } from './toolTypes';

const TOOL_PERMISSION_SETTINGS_KEY = 'junluo.tools.permissions.v1';

export type JunLuoToolPermissionGrantScope = 'package' | 'tool';

export type JunLuoToolPermissionGrantDuration = 'session' | 'today';

export type JunLuoToolPermissionInputRuleValue = string | number | boolean | null;

export type JunLuoToolPermissionInputRule = {
  equals?: JunLuoToolPermissionInputRuleValue;
  oneOf?: JunLuoToolPermissionInputRuleValue[];
  min?: number;
  max?: number;
  pattern?: string;
  allowMissing?: boolean;
};

export type JunLuoToolPermissionInputRules = Record<string, JunLuoToolPermissionInputRule>;

export type JunLuoToolTemporaryPermissionGrant = {
  id: string;
  scope: JunLuoToolPermissionGrantScope;
  targetId: string;
  permission: JunLuoToolPermissionLevel;
  duration: JunLuoToolPermissionGrantDuration;
  createdAt: number;
  expiresAt?: number;
  reason?: string;
  inputRules?: JunLuoToolPermissionInputRules;
};

export type JunLuoToolParameterPermissionGrant = {
  id: string;
  toolId: string;
  permission: JunLuoToolPermissionLevel;
  inputRules: JunLuoToolPermissionInputRules;
  createdAt: number;
  description?: string;
  expiresAt?: number;
};

export type JunLuoToolPermissionSettings = {
  version: 2;
  globalDefault: JunLuoToolPermissionLevel;
  packageOverrides: Record<string, JunLuoToolPermissionLevel>;
  toolOverrides: Record<string, JunLuoToolPermissionLevel>;
  temporaryGrants: JunLuoToolTemporaryPermissionGrant[];
  parameterGrants: JunLuoToolParameterPermissionGrant[];
};

const DEFAULT_PERMISSION_SETTINGS: JunLuoToolPermissionSettings = {
  version: 2,
  globalDefault: 'ask',
  packageOverrides: {},
  toolOverrides: {},
  temporaryGrants: [],
  parameterGrants: [],
};

let sessionPermissionGrants: JunLuoToolTemporaryPermissionGrant[] = [];

function isPermissionLevel(value: unknown): value is JunLuoToolPermissionLevel {
  return value === 'allow' || value === 'ask' || value === 'deny';
}

function normalizePermissionMap(value: unknown): Record<string, JunLuoToolPermissionLevel> {
  if (!value || typeof value !== 'object') return {};
  return Object.entries(value as Record<string, unknown>).reduce<Record<string, JunLuoToolPermissionLevel>>(
    (permissions, [key, permission]) => {
      if (key.trim() && isPermissionLevel(permission)) {
        permissions[key] = permission;
      }
      return permissions;
    },
    {},
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeTargetId(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function isRuleValue(value: unknown): value is JunLuoToolPermissionInputRuleValue {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function normalizeInputRules(value: unknown): JunLuoToolPermissionInputRules | undefined {
  if (!isPlainObject(value)) return undefined;
  const rules = Object.entries(value).reduce<JunLuoToolPermissionInputRules>((result, [key, rawRule]) => {
    if (!key.trim() || !isPlainObject(rawRule)) return result;
    const rule: JunLuoToolPermissionInputRule = {};
    if ('equals' in rawRule && isRuleValue(rawRule.equals)) {
      rule.equals = rawRule.equals;
    }
    if (Array.isArray(rawRule.oneOf)) {
      const oneOf = rawRule.oneOf.filter(isRuleValue);
      if (oneOf.length) rule.oneOf = oneOf;
    }
    if (typeof rawRule.min === 'number' && Number.isFinite(rawRule.min)) {
      rule.min = rawRule.min;
    }
    if (typeof rawRule.max === 'number' && Number.isFinite(rawRule.max)) {
      rule.max = rawRule.max;
    }
    if (typeof rawRule.pattern === 'string' && rawRule.pattern.trim()) {
      rule.pattern = rawRule.pattern;
    }
    if (rawRule.allowMissing === true) {
      rule.allowMissing = true;
    }
    if (Object.keys(rule).length) {
      result[key] = rule;
    }
    return result;
  }, {});
  return Object.keys(rules).length ? rules : undefined;
}

function normalizeTemporaryGrants(value: unknown, now = Date.now()): JunLuoToolTemporaryPermissionGrant[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((rawGrant) => {
    if (!isPlainObject(rawGrant)) return [];
    const scope = rawGrant.scope === 'package' || rawGrant.scope === 'tool' ? rawGrant.scope : null;
    const duration = rawGrant.duration === 'session' || rawGrant.duration === 'today' ? rawGrant.duration : null;
    const targetId = normalizeTargetId(rawGrant.targetId);
    if (!scope || !duration || !targetId || !isPermissionLevel(rawGrant.permission)) return [];
    const expiresAt = typeof rawGrant.expiresAt === 'number' && Number.isFinite(rawGrant.expiresAt)
      ? rawGrant.expiresAt
      : undefined;
    if (expiresAt && expiresAt <= now) return [];
    return [{
      id: typeof rawGrant.id === 'string' && rawGrant.id.trim()
        ? rawGrant.id
        : createPermissionGrantId(duration, scope, targetId),
      scope,
      targetId,
      permission: rawGrant.permission,
      duration,
      createdAt: typeof rawGrant.createdAt === 'number' ? rawGrant.createdAt : now,
      expiresAt,
      reason: typeof rawGrant.reason === 'string' ? rawGrant.reason : undefined,
      inputRules: normalizeInputRules(rawGrant.inputRules),
    }];
  });
}

function normalizeParameterGrants(value: unknown, now = Date.now()): JunLuoToolParameterPermissionGrant[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((rawGrant) => {
    if (!isPlainObject(rawGrant)) return [];
    const toolId = normalizeTargetId(rawGrant.toolId);
    const inputRules = normalizeInputRules(rawGrant.inputRules);
    if (!toolId || !inputRules || !isPermissionLevel(rawGrant.permission)) return [];
    const expiresAt = typeof rawGrant.expiresAt === 'number' && Number.isFinite(rawGrant.expiresAt)
      ? rawGrant.expiresAt
      : undefined;
    if (expiresAt && expiresAt <= now) return [];
    return [{
      id: typeof rawGrant.id === 'string' && rawGrant.id.trim()
        ? rawGrant.id
        : createPermissionGrantId('parameter', 'tool', toolId),
      toolId,
      permission: rawGrant.permission,
      inputRules,
      createdAt: typeof rawGrant.createdAt === 'number' ? rawGrant.createdAt : now,
      description: typeof rawGrant.description === 'string' ? rawGrant.description : undefined,
      expiresAt,
    }];
  });
}

function normalizeSettings(value: unknown): JunLuoToolPermissionSettings {
  if (!value || typeof value !== 'object') return DEFAULT_PERMISSION_SETTINGS;
  const item = value as Partial<JunLuoToolPermissionSettings>;
  return {
    version: 2,
    globalDefault: isPermissionLevel(item.globalDefault) ? item.globalDefault : DEFAULT_PERMISSION_SETTINGS.globalDefault,
    packageOverrides: normalizePermissionMap(item.packageOverrides),
    toolOverrides: normalizePermissionMap(item.toolOverrides),
    temporaryGrants: normalizeTemporaryGrants(item.temporaryGrants),
    parameterGrants: normalizeParameterGrants(item.parameterGrants),
  };
}

function createPermissionGrantId(
  prefix: string,
  scope: JunLuoToolPermissionGrantScope,
  targetId: string,
) {
  const safeTargetId = targetId.replace(/[^a-zA-Z0-9_.-]+/g, '_').slice(0, 64) || 'target';
  return `${prefix}:${scope}:${safeTargetId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
}

function getEndOfToday(now = Date.now()) {
  const date = new Date(now);
  date.setHours(23, 59, 59, 999);
  return date.getTime();
}

function upsertGrant<T extends { id: string; scope?: JunLuoToolPermissionGrantScope; targetId?: string; toolId?: string }>(
  grants: T[],
  grant: T,
) {
  const index = grants.findIndex((item) => item.id === grant.id);
  if (index >= 0) {
    return grants.map((item, itemIndex) => (itemIndex === index ? grant : item));
  }
  return [...grants, grant];
}

export async function readToolPermissionSettingsRaw(): Promise<string | null> {
  return AsyncStorage.getItem(TOOL_PERMISSION_SETTINGS_KEY);
}

export async function loadToolPermissionSettings(options: { strict?: boolean } = {},
  read = readToolPermissionSettingsRaw): Promise<JunLuoToolPermissionSettings> {
  const raw = await read();
  if (raw === null || (!raw && !options.strict)) return DEFAULT_PERMISSION_SETTINGS;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (options.strict) {
      if (!isPlainObject(parsed) || (parsed.globalDefault !== undefined && !isPermissionLevel(parsed.globalDefault))) throw new Error('tool-permission-settings-damaged');
      for (const key of ['toolOverrides', 'packageOverrides']) {
        const value = parsed[key];
        if (value !== undefined && (!isPlainObject(value) || !Object.values(value).every(isPermissionLevel))) throw new Error('tool-permission-settings-damaged');
      }
      for (const key of ['temporaryGrants', 'parameterGrants']) {
        const value = parsed[key];
        if (value !== undefined && (!Array.isArray(value) || !value.every(grant => isPlainObject(grant) && isPermissionLevel(grant.permission)))) throw new Error('tool-permission-settings-damaged');
      }
    }
    return normalizeSettings(parsed);
  } catch {
    if (options.strict) throw new Error('tool-permission-settings-damaged');
    return DEFAULT_PERMISSION_SETTINGS;
  }
}

export async function hasStoredToolPermissionSettings(read = readToolPermissionSettingsRaw): Promise<boolean> {
  return (await read()) !== null;
}

export async function saveToolPermissionSettings(settings: JunLuoToolPermissionSettings) {
  await AsyncStorage.setItem(TOOL_PERMISSION_SETTINGS_KEY, JSON.stringify(normalizeSettings(settings)));
}

export async function setGlobalToolPermission(permission: JunLuoToolPermissionLevel) {
  const settings = await loadToolPermissionSettings();
  await saveToolPermissionSettings({ ...settings, globalDefault: permission });
}

export async function setPackageToolPermission(packageId: string, permission: JunLuoToolPermissionLevel) {
  const settings = await loadToolPermissionSettings();
  await saveToolPermissionSettings({
    ...settings,
    packageOverrides: { ...settings.packageOverrides, [packageId]: permission },
  });
}

export async function clearPackageToolPermissionOverride(packageId: string) {
  const settings = await loadToolPermissionSettings();
  const nextOverrides = { ...settings.packageOverrides };
  delete nextOverrides[packageId];
  await saveToolPermissionSettings({
    ...settings,
    packageOverrides: nextOverrides,
  });
}

export async function setToolPermissionOverride(toolId: string, permission: JunLuoToolPermissionLevel) {
  const settings = await loadToolPermissionSettings();
  await saveToolPermissionSettings({
    ...settings,
    toolOverrides: { ...settings.toolOverrides, [toolId]: permission },
  });
}

export async function clearToolPermissionOverride(toolId: string) {
  const settings = await loadToolPermissionSettings();
  const nextOverrides = { ...settings.toolOverrides };
  delete nextOverrides[toolId];
  await saveToolPermissionSettings({
    ...settings,
    toolOverrides: nextOverrides,
  });
}

export function listSessionToolPermissionGrants() {
  const now = Date.now();
  sessionPermissionGrants = sessionPermissionGrants.filter((grant) => !grant.expiresAt || grant.expiresAt > now);
  return [...sessionPermissionGrants];
}

export async function loadActiveToolPermissionGrants() {
  const settings = await loadToolPermissionSettings();
  return [...listSessionToolPermissionGrants(), ...settings.temporaryGrants];
}

export function grantPackageToolPermissionForSession(
  packageId: string,
  permission: JunLuoToolPermissionLevel = 'allow',
  reason?: string,
) {
  const targetId = packageId.trim();
  if (!targetId) throw new Error('packageId 不能为空');
  const grant: JunLuoToolTemporaryPermissionGrant = {
    id: createPermissionGrantId('session', 'package', targetId),
    scope: 'package',
    targetId,
    permission,
    duration: 'session',
    createdAt: Date.now(),
    reason,
  };
  sessionPermissionGrants = upsertGrant(sessionPermissionGrants, grant);
  return grant;
}

export function grantToolPermissionForSession(
  toolId: string,
  permission: JunLuoToolPermissionLevel = 'allow',
  reason?: string,
  inputRules?: JunLuoToolPermissionInputRules,
) {
  const targetId = toolId.trim();
  if (!targetId) throw new Error('toolId 不能为空');
  const grant: JunLuoToolTemporaryPermissionGrant = {
    id: createPermissionGrantId('session', 'tool', targetId),
    scope: 'tool',
    targetId,
    permission,
    duration: 'session',
    createdAt: Date.now(),
    reason,
    inputRules,
  };
  sessionPermissionGrants = upsertGrant(sessionPermissionGrants, grant);
  return grant;
}

export async function grantPackageToolPermissionUntilEndOfDay(
  packageId: string,
  permission: JunLuoToolPermissionLevel = 'allow',
  reason?: string,
) {
  const targetId = packageId.trim();
  if (!targetId) throw new Error('packageId 不能为空');
  const settings = await loadToolPermissionSettings();
  const grant: JunLuoToolTemporaryPermissionGrant = {
    id: createPermissionGrantId('today', 'package', targetId),
    scope: 'package',
    targetId,
    permission,
    duration: 'today',
    createdAt: Date.now(),
    expiresAt: getEndOfToday(),
    reason,
  };
  await saveToolPermissionSettings({
    ...settings,
    temporaryGrants: upsertGrant(settings.temporaryGrants, grant),
  });
  return grant;
}

export async function grantToolPermissionUntilEndOfDay(
  toolId: string,
  permission: JunLuoToolPermissionLevel = 'allow',
  reason?: string,
  inputRules?: JunLuoToolPermissionInputRules,
) {
  const targetId = toolId.trim();
  if (!targetId) throw new Error('toolId 不能为空');
  const settings = await loadToolPermissionSettings();
  const grant: JunLuoToolTemporaryPermissionGrant = {
    id: createPermissionGrantId('today', 'tool', targetId),
    scope: 'tool',
    targetId,
    permission,
    duration: 'today',
    createdAt: Date.now(),
    expiresAt: getEndOfToday(),
    reason,
    inputRules,
  };
  await saveToolPermissionSettings({
    ...settings,
    temporaryGrants: upsertGrant(settings.temporaryGrants, grant),
  });
  return grant;
}

export async function clearTemporaryToolPermissionGrantsForTarget(
  scope: JunLuoToolPermissionGrantScope,
  targetId: string,
) {
  const normalizedTargetId = targetId.trim();
  sessionPermissionGrants = sessionPermissionGrants.filter(
    (grant) => grant.scope !== scope || grant.targetId !== normalizedTargetId,
  );
  const settings = await loadToolPermissionSettings();
  await saveToolPermissionSettings({
    ...settings,
    temporaryGrants: settings.temporaryGrants.filter(
      (grant) => grant.scope !== scope || grant.targetId !== normalizedTargetId,
    ),
  });
}

export async function addToolParameterPermissionGrant(
  grant: Omit<JunLuoToolParameterPermissionGrant, 'id' | 'createdAt'> & { id?: string; createdAt?: number },
) {
  const toolId = grant.toolId.trim();
  const inputRules = normalizeInputRules(grant.inputRules);
  if (!toolId) throw new Error('toolId 不能为空');
  if (!inputRules) throw new Error('inputRules 不能为空');
  const settings = await loadToolPermissionSettings();
  const nextGrant: JunLuoToolParameterPermissionGrant = {
    id: grant.id?.trim() || createPermissionGrantId('parameter', 'tool', toolId),
    toolId,
    permission: grant.permission,
    inputRules,
    createdAt: grant.createdAt ?? Date.now(),
    description: grant.description,
    expiresAt: grant.expiresAt,
  };
  await saveToolPermissionSettings({
    ...settings,
    parameterGrants: upsertGrant(settings.parameterGrants, nextGrant),
  });
  return nextGrant;
}

export async function clearToolParameterPermissionGrant(grantId: string) {
  const settings = await loadToolPermissionSettings();
  await saveToolPermissionSettings({
    ...settings,
    parameterGrants: settings.parameterGrants.filter((grant) => grant.id !== grantId),
  });
}

export async function clearToolParameterPermissionGrantsForTool(toolId: string) {
  const normalizedToolId = toolId.trim();
  const settings = await loadToolPermissionSettings();
  await saveToolPermissionSettings({
    ...settings,
    parameterGrants: settings.parameterGrants.filter((grant) => grant.toolId !== normalizedToolId),
  });
}

export function matchesToolPermissionInputRules(
  input: Record<string, unknown>,
  inputRules?: JunLuoToolPermissionInputRules,
) {
  if (!inputRules) return true;
  return Object.entries(inputRules).every(([key, rule]) => {
    const value = input[key];
    if (value == null) return rule.allowMissing === true;
    if ('equals' in rule && value !== rule.equals) return false;
    if (rule.oneOf && !rule.oneOf.some((item) => item === value)) return false;
    if (typeof rule.min === 'number' && (typeof value !== 'number' || value < rule.min)) return false;
    if (typeof rule.max === 'number' && (typeof value !== 'number' || value > rule.max)) return false;
    if (rule.pattern) {
      if (typeof value !== 'string') return false;
      try {
        if (!new RegExp(rule.pattern).test(value)) return false;
      } catch {
        return false;
      }
    }
    return true;
  });
}

export async function clearToolPermissionSettingsForTests() {
  sessionPermissionGrants = [];
  await AsyncStorage.removeItem(TOOL_PERMISSION_SETTINGS_KEY);
}

export function clearSessionToolPermissionGrantsForTests() {
  sessionPermissionGrants = [];
}
