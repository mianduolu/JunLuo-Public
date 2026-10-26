import {
  aiLogicalConfigStorageBridge as AsyncStorage,
} from '../sync/syncAiLogicalConfigStorageBridge';
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from 'react';
import { notifyMemoryProcessingWorkAvailable } from '../memory/memoryProcessingSignals';

import {
  aiConnectionIdKeyByPurpose,
  defaultAiProfile,
  normalizeAiConnection,
  type AiConnection,
  type AiConnectionPurpose,
  type AiConnectionSettings,
  type AiProfile,
} from './types';
import { normalizeChatModelParameters } from './modelParameters';
import { getSecretItem, setSecretItem } from '../storage/secretStore';
import {
  deleteVaultSharedSecret,
  setVaultSharedSecret,
} from '../sync/syncVaultSharedSecretsStorageBridge';

const PROFILE_KEY = 'junluo.aiProfile';
const LEGACY_API_KEY_KEY = 'junluo.aiApiKey';
const CONNECTION_SETTINGS_KEY = 'junluo.aiConnections';
const connectionKey = (id: string) => `junluo.aiApiKey.${id}`;
const LEGACY_MIGRATED_CONNECTION_ID = 'legacy-current';

type LegacyProfile = Partial<AiProfile> & {
  baseUrl?: string;
  model?: string;
};

type AiConfigContextValue = {
  baiyunBehaviorConnection?: AiConnection;
  baiyunBehaviorKey: string;
  chatConnection?: AiConnection;
  chatKey: string;
  connections: AiConnection[];
  getConnectionKey: (id: string) => string;
  loaded: boolean;
  memoryOrganizerConnection?: AiConnection;
  memoryOrganizerKey: string;
  memoryRerankerConnection?: AiConnection;
  memoryRerankerKey: string;
  profile: AiProfile;
  removeConnection: (id: string) => Promise<void>;
  saveConnection: (connection: AiConnection, apiKey: string) => Promise<void>;
  saveProfile: (profile: AiProfile) => Promise<void>;
  selectConnection: (purpose: AiConnectionPurpose, id: string | undefined) => Promise<void>;
  financeReasoningConnection?: AiConnection;
  financeReasoningKey: string;
  imageGenerationConnection?: AiConnection;
  imageGenerationKey: string;
  lifeCreativeConnection?: AiConnection;
  lifeCreativeKey: string;
  utilityJsonConnection?: AiConnection;
  utilityJsonKey: string;
  visionConnection?: AiConnection;
  visionKey: string;
  audioUnderstandingConnection?: AiConnection;
  audioUnderstandingKey: string;
};

const AiConfigContext = createContext<AiConfigContextValue | undefined>(undefined);
const SNAPSHOT_CACHE_MS = 5 * 60 * 1000;

export type AiConfigSnapshot = {
  apiKeys: Record<string, string>;
  baiyunBehaviorConnection?: AiConnection;
  baiyunBehaviorKey: string;
  chatConnection?: AiConnection;
  chatKey: string;
  connections: AiConnection[];
  memoryOrganizerConnection?: AiConnection;
  memoryOrganizerKey: string;
  memoryRerankerConnection?: AiConnection;
  memoryRerankerKey: string;
  profile: AiProfile;
  settings: AiConnectionSettings;
  financeReasoningConnection?: AiConnection;
  financeReasoningKey: string;
  imageGenerationConnection?: AiConnection;
  imageGenerationKey: string;
  lifeCreativeConnection?: AiConnection;
  lifeCreativeKey: string;
  utilityJsonConnection?: AiConnection;
  utilityJsonKey: string;
  visionConnection?: AiConnection;
  visionKey: string;
  audioUnderstandingConnection?: AiConnection;
  audioUnderstandingKey: string;
};

let cachedSnapshot: { loadedAt: number; value: AiConfigSnapshot } | undefined;
let snapshotGeneration = 0;
let pendingSnapshot: Promise<AiConfigSnapshot> | undefined;

export function resolveLifeCreativeConfig(config: Pick<
  AiConfigSnapshot,
  'chatConnection' | 'chatKey' | 'lifeCreativeConnection' | 'lifeCreativeKey'
>) {
  if (config.lifeCreativeConnection) {
    return {
      apiKey: config.lifeCreativeKey,
      connection: config.lifeCreativeConnection,
    };
  }
  return {
    apiKey: config.chatKey,
    connection: config.chatConnection,
  };
}

function cacheSnapshot(snapshot: AiConfigSnapshot, generation: number) {
  if (generation === snapshotGeneration) cachedSnapshot = { loadedAt: Date.now(), value: snapshot };
}

function clearSnapshotCache() {
  snapshotGeneration++;
  cachedSnapshot = undefined;
  pendingSnapshot = undefined;
}

export function invalidateAiConfigPreferencesSnapshot() {
  clearSnapshotCache();
}

function normalizeStoredProfile(savedProfile: string | null) {
  if (!savedProfile) {
    return { legacyProfile: {} as LegacyProfile, profile: defaultAiProfile };
  }
  try {
    const legacyProfile = JSON.parse(savedProfile) as LegacyProfile;
    return {
      legacyProfile,
      profile: {
        ...defaultAiProfile,
        ...(typeof legacyProfile.corePersona === 'string' && legacyProfile.corePersona.length <= 1_000_000
          ? { corePersona: legacyProfile.corePersona } : {}),
        systemPrompt: legacyProfile.systemPrompt ?? '',
        userNote: legacyProfile.userNote ?? '',
        proactiveMemorySuggestions: legacyProfile.proactiveMemorySuggestions === true,
        automaticExplicitFactMemories: legacyProfile.automaticExplicitFactMemories === true,
      },
    };
  } catch {
    return { legacyProfile: {} as LegacyProfile, profile: defaultAiProfile };
  }
}

function normalizeStoredSettings(savedSettings: string | null) {
  if (!savedSettings) return { connections: [] } as AiConnectionSettings;
  try {
    const parsed = JSON.parse(savedSettings) as AiConnectionSettings;
    const connections = Array.isArray(parsed.connections) ? parsed.connections.map(normalizeAiConnection) : [];
    return {
      ...parsed,
      connections,
      memoryRerankerConnectionId:
        parsed.memoryRerankerConnectionId ?? parsed.memoryOrganizerConnectionId ?? parsed.chatConnectionId,
    };
  } catch {
    return { connections: [] } as AiConnectionSettings;
  }
}

function getConnectionById(settings: AiConnectionSettings, id?: string) {
  return settings.connections.find((connection) => connection.id === id);
}

function getConnectionKeyFromMap(keys: Record<string, string>, connection?: AiConnection) {
  return connection ? keys[connection.id] ?? '' : '';
}

async function retireLegacyApiKeyAfterCanonicalCommit(
  settings: AiConnectionSettings,
  legacyApiKey: string | null,
) {
  const legacyValue = legacyApiKey?.trim() ?? '';
  if (!legacyValue) return;
  if (!settings.connections.some(({ id }) => id === LEGACY_MIGRATED_CONNECTION_ID)) return;
  const migratedValue = (
    await getSecretItem(connectionKey(LEGACY_MIGRATED_CONNECTION_ID))
  )?.trim() ?? '';
  if (migratedValue !== legacyValue) return;
  try {
    await deleteVaultSharedSecret(LEGACY_API_KEY_KEY);
  } catch {
    // A lower storage layer may fail after deleting one copy. Restore the local
    // fallback without emitting a new sync mutation; the prepared tombstone can retry.
    await setSecretItem(LEGACY_API_KEY_KEY, legacyValue).catch(() => undefined);
  }
}

export async function loadAiConfigPreferencesSnapshot(options: { maxAgeMs?: number; readOnly?: boolean } = {}): Promise<AiConfigSnapshot> {
  const maxAgeMs = options.maxAgeMs ?? SNAPSHOT_CACHE_MS;
  if (cachedSnapshot && Date.now() - cachedSnapshot.loadedAt <= maxAgeMs) {
    return cachedSnapshot.value;
  }
  const sharePending = options.maxAgeMs === undefined && !options.readOnly;
  if (sharePending && pendingSnapshot) return pendingSnapshot;
  const load = loadSnapshotFromStorage(options, snapshotGeneration);
  if (!sharePending) return load;
  pendingSnapshot = load;
  try {
    return await load;
  } finally {
    if (pendingSnapshot === load) pendingSnapshot = undefined;
  }
}

async function loadSnapshotFromStorage(
  options: { readOnly?: boolean },
  generation: number,
): Promise<AiConfigSnapshot> {
  const [savedProfile, savedSettings, legacyApiKey] = await Promise.all([
    AsyncStorage.getItem(PROFILE_KEY),
    AsyncStorage.getItem(CONNECTION_SETTINGS_KEY),
    getSecretItem(LEGACY_API_KEY_KEY, options.readOnly),
  ]);

  const { legacyProfile, profile } = normalizeStoredProfile(savedProfile);
  let settings = normalizeStoredSettings(savedSettings);
  let projectedLegacyKey: string | undefined;

  if (!settings.connections.length && legacyProfile.baseUrl && legacyProfile.model) {
    const migrated: AiConnection = {
      id: LEGACY_MIGRATED_CONNECTION_ID,
      name: '原有连接',
      provider: 'openai-compatible',
      preset: 'custom',
      baseUrl: legacyProfile.baseUrl,
      model: legacyProfile.model,
    };
    settings = {
      connections: [migrated],
      chatConnectionId: migrated.id,
      memoryOrganizerConnectionId: migrated.id,
      memoryRerankerConnectionId: migrated.id,
    };
    const normalizedLegacyApiKey = legacyApiKey?.trim() ?? '';
    if (options.readOnly && normalizedLegacyApiKey) projectedLegacyKey = normalizedLegacyApiKey;
    if (!options.readOnly && normalizedLegacyApiKey) {
      const migratedKey = connectionKey(migrated.id);
      await setVaultSharedSecret(migratedKey, normalizedLegacyApiKey);
      const persistedApiKey = (await getSecretItem(migratedKey))?.trim() ?? '';
      if (persistedApiKey !== normalizedLegacyApiKey) {
        throw new Error('旧 AI Key 迁移后的 durable 回读不一致。');
      }
    }
    if (!options.readOnly) await AsyncStorage.setItem(CONNECTION_SETTINGS_KEY, JSON.stringify(settings));
  }

  if (!options.readOnly) await retireLegacyApiKeyAfterCanonicalCommit(settings, legacyApiKey);

  const loadedKeys = Object.fromEntries(
    await Promise.all(
      settings.connections.map(async (connection) => [
        connection.id,
        (connection.id === LEGACY_MIGRATED_CONNECTION_ID ? projectedLegacyKey : undefined)
          ?? (await getSecretItem(connectionKey(connection.id), options.readOnly)) ?? '',
      ]),
    ),
  );
  const chatConnection = getConnectionById(settings, settings.chatConnectionId);
  const baiyunBehaviorConnection = getConnectionById(settings, settings.baiyunBehaviorConnectionId);
  const memoryOrganizerConnection = getConnectionById(settings, settings.memoryOrganizerConnectionId);
  const memoryRerankerConnection = getConnectionById(settings, settings.memoryRerankerConnectionId);
  const utilityJsonConnection = getConnectionById(settings, settings.utilityJsonConnectionId);
  const imageGenerationConnection = getConnectionById(settings, settings.imageGenerationConnectionId);
  const financeReasoningConnection = getConnectionById(settings, settings.financeReasoningConnectionId);
  const lifeCreativeConnection = getConnectionById(settings, settings.lifeCreativeConnectionId);
  const visionConnection = getConnectionById(settings, settings.visionConnectionId);
  const audioUnderstandingConnection = getConnectionById(settings, settings.audioUnderstandingConnectionId);

  const snapshot = {
    apiKeys: loadedKeys,
    baiyunBehaviorConnection,
    baiyunBehaviorKey: getConnectionKeyFromMap(loadedKeys, baiyunBehaviorConnection),
    chatConnection,
    chatKey: getConnectionKeyFromMap(loadedKeys, chatConnection),
    connections: settings.connections,
    memoryOrganizerConnection,
    memoryOrganizerKey: getConnectionKeyFromMap(loadedKeys, memoryOrganizerConnection),
    memoryRerankerConnection,
    memoryRerankerKey: getConnectionKeyFromMap(loadedKeys, memoryRerankerConnection),
    profile,
    settings,
    financeReasoningConnection,
    financeReasoningKey: getConnectionKeyFromMap(loadedKeys, financeReasoningConnection),
    imageGenerationConnection,
    imageGenerationKey: getConnectionKeyFromMap(loadedKeys, imageGenerationConnection),
    lifeCreativeConnection,
    lifeCreativeKey: getConnectionKeyFromMap(loadedKeys, lifeCreativeConnection),
    utilityJsonConnection,
    utilityJsonKey: getConnectionKeyFromMap(loadedKeys, utilityJsonConnection),
    visionConnection,
    visionKey: getConnectionKeyFromMap(loadedKeys, visionConnection),
    audioUnderstandingConnection,
    audioUnderstandingKey: getConnectionKeyFromMap(loadedKeys, audioUnderstandingConnection),
  };
  if (!options.readOnly) cacheSnapshot(snapshot, generation);
  return snapshot;
}

export function AiConfigPreferencesProvider({ children }: { children: ReactNode }) {
  const [profile, setProfile] = useState(defaultAiProfile);
  const [settings, setSettings] = useState<AiConnectionSettings>({ connections: [] });
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let active = true;

    async function load() {
      const snapshot = await loadAiConfigPreferencesSnapshot();

      if (!active) return;
      setProfile(snapshot.profile);
      setSettings(snapshot.settings);
      setApiKeys(snapshot.apiKeys);
      setLoaded(true);
    }

    void load();
    return () => {
      active = false;
    };
  }, []);

  const value = useMemo<AiConfigContextValue>(() => {
    const chatConnection = getConnectionById(settings, settings.chatConnectionId);
    const baiyunBehaviorConnection = getConnectionById(settings, settings.baiyunBehaviorConnectionId);
    const memoryOrganizerConnection = getConnectionById(settings, settings.memoryOrganizerConnectionId);
    const memoryRerankerConnection = getConnectionById(settings, settings.memoryRerankerConnectionId);
    const utilityJsonConnection = getConnectionById(settings, settings.utilityJsonConnectionId);
    const imageGenerationConnection = getConnectionById(settings, settings.imageGenerationConnectionId);
    const financeReasoningConnection = getConnectionById(settings, settings.financeReasoningConnectionId);
    const lifeCreativeConnection = getConnectionById(settings, settings.lifeCreativeConnectionId);
    const visionConnection = getConnectionById(settings, settings.visionConnectionId);
    const audioUnderstandingConnection = getConnectionById(settings, settings.audioUnderstandingConnectionId);

    const persistSettings = async (next: AiConnectionSettings) => {
      await AsyncStorage.setItem(CONNECTION_SETTINGS_KEY, JSON.stringify(next)).finally(clearSnapshotCache);
      setSettings(next);
    };

    return {
      baiyunBehaviorConnection,
      baiyunBehaviorKey: getConnectionKeyFromMap(apiKeys, baiyunBehaviorConnection),
      chatConnection,
      chatKey: getConnectionKeyFromMap(apiKeys, chatConnection),
      connections: settings.connections,
      getConnectionKey: (id) => apiKeys[id] ?? '',
      loaded,
      memoryOrganizerConnection,
      memoryOrganizerKey: getConnectionKeyFromMap(apiKeys, memoryOrganizerConnection),
      memoryRerankerConnection,
      memoryRerankerKey: getConnectionKeyFromMap(apiKeys, memoryRerankerConnection),
      profile,
      removeConnection: async (id) => {
        clearSnapshotCache();
        const nextConnections = settings.connections.filter((connection) => connection.id !== id);
        const next = Object.fromEntries(
          Object.entries({ ...settings, connections: nextConnections }).map(([key, entryValue]) => [
            key,
            key.endsWith('ConnectionId') && entryValue === id ? undefined : entryValue,
          ]),
        ) as AiConnectionSettings;
        await Promise.all([
          persistSettings(next),
          deleteVaultSharedSecret(connectionKey(id)).finally(clearSnapshotCache),
        ]);
        setApiKeys((current) => {
          const nextKeys = { ...current };
          delete nextKeys[id];
          return nextKeys;
        });
        notifyMemoryProcessingWorkAvailable('configuration_changed');
      },
      saveConnection: async (connection, apiKey) => {
        clearSnapshotCache();
        const normalized = normalizeAiConnection({
          ...connection,
          name: connection.name.trim(),
          baseUrl: connection.baseUrl.trim().replace(/\/+$/, ''),
          model: connection.model.trim(),
          modelParameters: normalizeChatModelParameters(connection.modelParameters),
        });
        const nextConnections = settings.connections.some((current) => current.id === normalized.id)
          ? settings.connections.map((current) => (current.id === normalized.id ? normalized : current))
          : [...settings.connections, normalized];
        const next: AiConnectionSettings = {
          ...settings,
          connections: nextConnections,
          chatConnectionId: settings.chatConnectionId ?? normalized.id,
          memoryOrganizerConnectionId: settings.memoryOrganizerConnectionId ?? normalized.id,
          memoryRerankerConnectionId: settings.memoryRerankerConnectionId ?? normalized.id,
        };
        await Promise.all([
          persistSettings(next),
          setVaultSharedSecret(connectionKey(normalized.id), apiKey).finally(clearSnapshotCache),
        ]);
        setApiKeys((current) => ({ ...current, [normalized.id]: apiKey.trim() }));
        notifyMemoryProcessingWorkAvailable('configuration_changed');
      },
      saveProfile: async (nextProfile) => {
        if (nextProfile.corePersona !== undefined && (typeof nextProfile.corePersona !== 'string'
          || nextProfile.corePersona.length > 1_000_000)) throw new Error('AI_PROFILE_CORE_PERSONA_INVALID');
        clearSnapshotCache();
        await AsyncStorage.setItem(PROFILE_KEY, JSON.stringify(nextProfile)).finally(clearSnapshotCache);
        setProfile(nextProfile);
      },
      selectConnection: async (purpose, id) => {
        clearSnapshotCache();
        const next = {
          ...settings,
          [aiConnectionIdKeyByPurpose[purpose]]: id,
        };
        await persistSettings(next);
        notifyMemoryProcessingWorkAvailable('configuration_changed');
      },
      financeReasoningConnection,
      financeReasoningKey: getConnectionKeyFromMap(apiKeys, financeReasoningConnection),
      imageGenerationConnection,
      imageGenerationKey: getConnectionKeyFromMap(apiKeys, imageGenerationConnection),
      lifeCreativeConnection,
      lifeCreativeKey: getConnectionKeyFromMap(apiKeys, lifeCreativeConnection),
      utilityJsonConnection,
      utilityJsonKey: getConnectionKeyFromMap(apiKeys, utilityJsonConnection),
      visionConnection,
      visionKey: getConnectionKeyFromMap(apiKeys, visionConnection),
      audioUnderstandingConnection,
      audioUnderstandingKey: getConnectionKeyFromMap(apiKeys, audioUnderstandingConnection),
    };
  }, [apiKeys, loaded, profile, settings]);

  return <AiConfigContext.Provider value={value}>{children}</AiConfigContext.Provider>;
}

export function useAiConfigPreferences() {
  const context = useContext(AiConfigContext);

  if (!context) {
    throw new Error('useAiConfigPreferences must be used within AiConfigPreferencesProvider');
  }

  return context;
}
