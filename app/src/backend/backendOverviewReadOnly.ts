import AsyncStorage from '@react-native-async-storage/async-storage';
import { getSecretItem } from '../storage/secretStore';
import { voiceCallSecretKeys } from '../voiceCall/voiceCallSecretKeys';
import { getLastMemoryRerankerStatus } from '../memory/memoryReranker';
import { AUTOMATIC_DATA_SYNC_RUNTIME_STATUS_KEY } from '../sync/automaticDataSyncPolicyCore';
import { parseBackendOverviewConnection, type BackendOverviewLocalInfo } from './backendOverview';

const settingsKey = 'junluo.backend.settings';

/** Raw reads deliberately bypass defaulting, normalization and legacy secret migration. */
export async function readBackendOverviewConnection() {
  const [raw, token] = await Promise.all([
    AsyncStorage.getItem(settingsKey),
    getSecretItem(voiceCallSecretKeys.voiceCallApiToken, true, true),
  ]);
  return parseBackendOverviewConnection(raw, token);
}

function parseObject(raw: string | null): Record<string, unknown> | null {
  if (raw === null) return null;
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid saved state');
  return value as Record<string, unknown>;
}

const syncStates: Record<string, string> = {
  disabled: '自动同步已关闭', idle: '等待下一次同步', checking: '正在检查同步', syncing: '正在同步',
  'waiting-relay': '等待同步中继', 'waiting-large-file-conditions': '等待文件同步条件',
  'attention-required': '已有同步问题需要处理',
};
const rerankStates: Record<string, string> = {
  reranked: '最近一次重排已完成', fallback: '最近一次重排未完成，采用原结果',
  skipped: '最近一次未执行重排', missingConnection: '最近一次缺少重排连接',
};

export async function readBackendOverviewLocalInfo(): Promise<BackendOverviewLocalInfo[]> {
  const info: BackendOverviewLocalInfo[] = [];
  // Each source fails independently, never converted to a default-disabled/zero record.
  try {
    const embedding = parseObject(await AsyncStorage.getItem('junluo.memoryEmbedding.settings'));
    if (embedding && (typeof embedding.enabled !== 'boolean' || typeof embedding.baseUrl !== 'string'
      || typeof embedding.model !== 'string' || typeof embedding.updatedAt !== 'number'
      || !Number.isFinite(embedding.updatedAt))) throw new Error('invalid embedding settings');
    info.push({ kind: 'embedding', configured: !!embedding
      && !!(embedding.baseUrl as string).trim() && !!(embedding.model as string).trim() });
  } catch { info.push({ kind: 'embedding' }); }
  try {
    const settings = parseObject(await AsyncStorage.getItem('junluo.memoryReranker.settings'));
    if (settings && (typeof settings.enabled !== 'boolean'
      || !['manual', 'conditional', 'always'].includes(String(settings.mode))
      || typeof settings.candidateLimit !== 'number' || !Number.isFinite(settings.candidateLimit)
      || typeof settings.timeoutMs !== 'number' || !Number.isFinite(settings.timeoutMs))) throw new Error('invalid reranker settings');
    const connections = parseObject(await AsyncStorage.getItem('junluo.aiConnections'));
    if (connections && !Array.isArray(connections.connections)) throw new Error('invalid connections');
    const configured = !!connections && typeof connections.memoryRerankerConnectionId === 'string'
      && (connections.connections as unknown[]).some(connection => {
        if (!connection || typeof connection !== 'object' || Array.isArray(connection)) return false;
        const entry = connection as Record<string, unknown>;
        return entry.id === connections.memoryRerankerConnectionId && typeof entry.baseUrl === 'string'
          && !!entry.baseUrl.trim() && typeof entry.model === 'string' && !!entry.model.trim();
      });
    const last = getLastMemoryRerankerStatus();
    info.push({ kind: 'reranker', configured, ...(settings && last.at > 0 && Object.prototype.hasOwnProperty.call(rerankStates, last.kind)
      ? { state: last.kind as BackendOverviewLocalInfo['state'], at: last.at } : {}) });
  } catch { info.push({ kind: 'reranker' }); }
  try {
    const sync = parseObject(await AsyncStorage.getItem(AUTOMATIC_DATA_SYNC_RUNTIME_STATUS_KEY));
    const validTime = (value: unknown) => value === null || typeof value === 'number'
      && Number.isSafeInteger(value) && value >= 0;
    if (sync && (typeof sync.state !== 'string' || !Object.prototype.hasOwnProperty.call(syncStates, sync.state) || !validTime(sync.lastAttemptAt)
      || !validTime(sync.lastSuccessAt) || !validTime(sync.nextAttemptAt)
      || typeof sync.consecutiveFailures !== 'number' || !Number.isInteger(sync.consecutiveFailures)
      || sync.consecutiveFailures < 0 || typeof sync.workRemaining !== 'boolean')) throw new Error('invalid sync state');
    const at = sync ? Math.max(Number(sync.lastAttemptAt ?? 0), Number(sync.lastSuccessAt ?? 0)) : 0;
    info.push({ kind: 'sync', ...(sync && at > 0 ? { state: sync.state as BackendOverviewLocalInfo['state'], at } : {}) });
  } catch { info.push({ kind: 'sync' }); }
  return info;
}
