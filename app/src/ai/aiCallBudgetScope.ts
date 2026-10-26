import type { AiConnection } from './types';

export type AiCallBudgetConnection = Pick<
  AiConnection,
  'baseUrl' | 'id' | 'preset'
>;

export type AiCallBudgetScope =
  | { kind: 'device' }
  | { kind: 'remote-account'; remoteAccountId: string };

function isPrivateIpv4(hostname: string) {
  const parts = hostname.split('.').map(Number);
  if (
    parts.length !== 4
    || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  return parts[0] === 10
    || parts[0] === 127
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168);
}

function isDeviceLocalHostname(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  return normalized === 'localhost'
    || normalized.endsWith('.localhost')
    || normalized.endsWith('.local')
    || normalized === '::1'
    || normalized.startsWith('fe80:')
    || (
      normalized.includes(':')
      && (normalized.startsWith('fc') || normalized.startsWith('fd'))
    )
    || isPrivateIpv4(normalized);
}

export function isDeviceLocalAiConnection(
  connection: AiCallBudgetConnection,
) {
  if (connection.preset === 'ollama' || connection.preset === 'gateway') {
    return true;
  }
  try {
    return isDeviceLocalHostname(new URL(connection.baseUrl).hostname);
  } catch {
    return connection.preset === 'custom';
  }
}

export function resolveAiCallBudgetScope(
  connection: AiCallBudgetConnection | null | undefined,
): AiCallBudgetScope {
  if (
    !connection
    || !connection.id.trim()
    || isDeviceLocalAiConnection(connection)
  ) {
    return { kind: 'device' };
  }
  return {
    kind: 'remote-account',
    remoteAccountId: connection.id.trim(),
  };
}

export function getAiCallBudgetScopeKey(
  connection: AiCallBudgetConnection | null | undefined,
) {
  const scope = resolveAiCallBudgetScope(connection);
  return scope.kind === 'device'
    ? 'device'
    : `remote-account:${scope.remoteAccountId}`;
}
