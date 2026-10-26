import { toolsWorkspaceStorageBridge as AsyncStorage } from '../sync/syncToolsWorkspaceStorageBridge';

import { getSecretItem } from '../storage/secretStore';
import {
  deleteVaultSharedSecret,
  setVaultSharedSecret,
} from '../sync/syncVaultSharedSecretsStorageBridge';

const GITHUB_TOKEN_SECRET_KEY = 'github.token';
const GITHUB_SETTINGS_KEY = 'junluo.tools.github.settings.v1';
const DEFAULT_GITHUB_API_BASE_URL = 'https://api.github.com';

export type JunLuoGithubSettings = {
  apiBaseUrl: string;
};

export type JunLuoGithubConfigStatus = {
  apiBaseUrl: string;
  baseUrlHost: string;
  hasToken: boolean;
  tokenLengthRange?: string;
  tokenSuffix?: string;
};

function normalizeGithubApiBaseUrl(value?: string) {
  const candidate = (value || DEFAULT_GITHUB_API_BASE_URL).trim().replace(/\/+$/, '');
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'https:') return DEFAULT_GITHUB_API_BASE_URL;
    const host = url.hostname.toLowerCase();
    if (!host || host === 'localhost' || host.endsWith('.local') || host === '::1' || host === '[::1]') {
      return DEFAULT_GITHUB_API_BASE_URL;
    }
    if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.)/.test(host)) return DEFAULT_GITHUB_API_BASE_URL;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return DEFAULT_GITHUB_API_BASE_URL;
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return DEFAULT_GITHUB_API_BASE_URL;
  }
}

function tokenLengthRange(token: string) {
  if (token.length < 20) return '<20';
  if (token.length < 40) return '20-39';
  if (token.length < 80) return '40-79';
  return '80+';
}

export async function loadGithubSettings(): Promise<JunLuoGithubSettings> {
  const raw = await AsyncStorage.getItem(GITHUB_SETTINGS_KEY);
  if (!raw) return { apiBaseUrl: DEFAULT_GITHUB_API_BASE_URL };
  try {
    const parsed = JSON.parse(raw) as Partial<JunLuoGithubSettings>;
    return { apiBaseUrl: normalizeGithubApiBaseUrl(parsed.apiBaseUrl) };
  } catch {
    return { apiBaseUrl: DEFAULT_GITHUB_API_BASE_URL };
  }
}

export async function saveGithubSettings(settings: Partial<JunLuoGithubSettings>) {
  const next = { apiBaseUrl: normalizeGithubApiBaseUrl(settings.apiBaseUrl) };
  await AsyncStorage.setItem(GITHUB_SETTINGS_KEY, JSON.stringify(next));
  return next;
}

export async function getGithubToken() {
  return getSecretItem(GITHUB_TOKEN_SECRET_KEY);
}

export async function saveGithubToken(token: string) {
  const trimmed = token.trim();
  if (!trimmed) throw new Error('GitHub Token 不能为空');
  await setVaultSharedSecret(GITHUB_TOKEN_SECRET_KEY, trimmed);
}

export async function deleteGithubToken() {
  await deleteVaultSharedSecret(GITHUB_TOKEN_SECRET_KEY);
}

export async function loadGithubConfigStatus(): Promise<JunLuoGithubConfigStatus> {
  const [settings, token] = await Promise.all([loadGithubSettings(), getGithubToken()]);
  let baseUrlHost = 'api.github.com';
  try {
    baseUrlHost = new URL(settings.apiBaseUrl).hostname;
  } catch {
    // Keep default host label.
  }
  return {
    apiBaseUrl: settings.apiBaseUrl,
    baseUrlHost,
    hasToken: Boolean(token),
    tokenLengthRange: token ? tokenLengthRange(token) : undefined,
    tokenSuffix: token ? token.slice(-4) : undefined,
  };
}

export async function clearGithubSettingsForTests() {
  await AsyncStorage.removeItem(GITHUB_SETTINGS_KEY);
  await deleteGithubToken();
}

export { DEFAULT_GITHUB_API_BASE_URL, normalizeGithubApiBaseUrl };
