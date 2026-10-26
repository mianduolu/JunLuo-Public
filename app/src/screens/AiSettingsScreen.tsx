import * as FileSystem from 'expo-file-system/legacy';
import * as ImagePicker from 'expo-image-picker';
import { useEffect, useRef, useState } from 'react';
import { SETTINGS_READ_TIMEOUT_MS, useSettingsRead, withSettingsTimeout, type SettingsReadState } from './useSettingsRead';
import { Alert, AppState, BackHandler, Image, Linking, Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native';

import { useAiConfigPreferences } from '../ai/AiConfigPreferences';
import { ModelAccountBalanceCard } from './ModelAccountBalanceCard';
import {
  canCommitBackupRestoreDataEpoch,
  captureBackupRestoreDataEpoch,
  runBackupRestoreDataEpochCommit,
} from '../backup/backupRestoreCoordinator';
import {
  loadBaiyunChatReplyFailureDiagnostics,
  loadBaiyunChatSemanticDiagnostics,
  saveBaiyunChatReplyFailureFixture,
  type BaiyunChatReplyFailureFixtureCode,
} from '../ai/behavior/actionChatSemanticStore';
import {
  deleteBaiyunLatestBadEnvelopeSnapshot,
  loadBaiyunLatestBadEnvelopeSnapshot,
} from '../ai/behavior/actionChatBadEnvelopeCache';
import {
  CHAT_REPLY_FAILURE_CODE,
  CHAT_REPLY_FAILURE_LABELS,
} from '../chat/chatReplyFailure';
import {
  describeChatAuxiliaryFailure,
  CHAT_AUXILIARY_PHASE_LABELS,
  CHAT_AUXILIARY_STAGE_LABELS,
  getChatAuxiliaryOutcomeLabel,
  getChatAuxiliaryStepLabel,
  loadChatAuxiliaryDiagnostics,
} from '../chat/chatAuxiliaryDiagnostics';
import {
  chatModelParameterDefaults,
  chatModelParameterDefinitions,
  chatModelParameterOrder,
  companionRecommendedModelParameters,
  normalizeChatModelParameters,
  normalizeParameterValue,
} from '../ai/modelParameters';
import {
  testOpenAiCompatibleConnection,
} from '../ai/openAiCompatibleProvider';
import { CameraVisionStructuredResultView } from '../camera/CameraVisionStructuredResultView';
import {
  analyzeCameraFrameStructured,
  describeCameraVisionErrorCode,
  type CameraVisionAnalysisSuccessV1,
} from '../camera/cameraVisionStructured';
import {
  defaultContextCompressionSettings,
  defaultConnectionValues,
  type AiConnection,
  type AiModelParameterKey,
  type AiProfile,
  type AiProviderPreset,
} from '../ai/types';
import {
  EXPRESSION_MOOD_LABELS,
  EXPRESSION_MOOD_ORDER,
  countCustomExpressionItems,
  createEmptyCustomExpressionLibrary,
  getCustomExpressionCategory,
  loadCustomExpressionLibrary,
  parseExpressionItems,
  saveCustomExpressionLibrary,
  type CustomExpressionLibrary,
  type ExpressionMoodId,
  updateCustomExpressionCategory,
} from '../ai/persona/expressionLibrary';
import {
  addStickerToLibrary,
  copyStickerImage,
  countStickers,
  createEmptyStickerLibrary,
  deleteStickerFile,
  getStickersForMood,
  loadStickerLibrary,
  removeStickerFromLibrary,
  saveStickerLibrary,
  type BaiyunStickerLibrary,
} from '../ai/persona/stickerLibrary';
import {
  getPhoneActivityPermissionStatusResult,
  getPhoneActivityFocusDebugStatus,
  openPhoneOverlaySettings,
  openPhoneAccessibilitySettings,
  openPhoneNotificationListenerSettings,
  openPhoneUsageAccessSettings,
  pausePhoneActivityCollector,
  showPhoneActivityOverlay,
  startPhoneActivityCollector,
  stopPhoneActivityCollector,
  type PhoneActivityPermissionStatus,
} from '../backend/phoneActivityNative';
import { AppText as Text, AppTextInput as TextInput } from '../components/AppText';
import { youPortraitAssets } from '../assets/youPortraitAssets';
import {
  loadProactiveMessageSettings,
  maybeSendProactiveMessage,
  saveProactiveMessageSettings,
  type ProactiveMessageSettings,
} from '../proactive/proactiveMessages';
import {
  createPhoneActivityRule,
  defaultPhoneActivityProactiveSettings,
  loadPhoneActivityProactiveSettings,
  savePhoneActivityProactiveSettings,
  type PhoneActivityProactiveSettings,
  type PhoneActivityRuleKind,
} from '../proactive/phoneActivityRules';
import {
  backfillMemoryEmbeddings,
  defaultEmbeddingSettings,
  getMissingEmbeddingCount,
  loadEmbeddingSettings,
  saveEmbeddingSettings,
  testMemoryEmbeddingConnection,
  type EmbeddingSettings,
} from '../memory/memoryEmbedding';
import {
  defaultMemoryRerankerSettings,
  getLastMemoryRerankerStatus,
  loadMemoryRerankerSettings,
  saveMemoryRerankerSettings,
  testMemoryRerankerConnection,
  type MemoryRerankerSettings,
  type MemoryRerankerStatus,
} from '../memory/memoryReranker';
import { getMemoryRetrievalDiagnostics } from '../memory/memoryStore';
import {
  loadRecentPhoneActivityLogs,
  type PhoneActivityLog,
} from '../phoneActivity/phoneActivityStore';
import { isVisiblePhoneActivityLog } from '../phoneActivity/phoneActivityVisibility';
import {
  hasNotificationPermission,
  requestNotificationPermission,
} from '../schedule/scheduleNotifications';
import { colors } from '../theme/colors';
import { ChatReplyDiagnosticCard } from '../chat/ChatReplyDiagnosticCard';
import { AutomaticCostSavingSettingsCard } from '../components/AutomaticCostSavingSettingsCard';
import type { Navigate } from '../types/navigation';
import { saveWithYouFeaturePreference } from '../period/withYouFeaturePreference';
import { aiSettingsSections, type AiSettingsSection } from './aiSettingsSections';
import {
  defaultAutomaticRemoteAiPolicy,
  loadAutomaticRemoteAiPolicy,
  saveAutomaticRemoteAiPolicy,
  type AutomaticRemoteAiPolicy,
} from '../runtime/automaticRemoteAiPolicy';
import {
  resetJunluoInnerState,
  retractLatestJunluoRelationshipChoiceEvidence,
} from '../life/junluoInnerStateMaintenance';
import {
  defaultAutonomySettings,
  loadAutonomySettings,
  saveAutonomySettings,
  setDailyPlanningEnabled,
  setPublicExplorationEnabled,
  type AutonomySettings,
} from '../life/autonomySettings';
import {
  loadSocialAgentSettings,
  saveSocialAgentSettings,
} from '../life/socialAgent';
import { getWebSearchProviderStatus } from '../life/webSearchProvider';

type Props = { navigate: Navigate; section: AiSettingsSection };
type Notice = { kind: 'error' | 'success'; text: string } | null;

const presetOptions: Array<{ id: AiProviderPreset; label: string }> = [
  { id: 'deepseek', label: 'DeepSeek' },
  { id: 'qwen', label: 'Qwen' },
  { id: 'gemini', label: 'Gemini' },
  { id: 'ollama', label: 'Ollama 本地' },
  { id: 'gateway', label: 'Gateway' },
  { id: 'custom', label: '自定义' },
];


const modelParameterCopy: Array<{ id: AiModelParameterKey; hint: string; label: string }> = [
  { id: 'maxTokens', label: '回复长度上限', hint: 'max_tokens' },
  { id: 'temperature', label: '温度', hint: 'temperature' },
  { id: 'topP', label: '采样范围', hint: 'top_p' },
  { id: 'presencePenalty', label: '减少绕圈', hint: 'presence_penalty' },
  { id: 'frequencyPenalty', label: '减少复读', hint: 'frequency_penalty' },
];

const defaultPhoneActivityStatus: PhoneActivityPermissionStatus = {
  usageAccess: false,
  notificationListener: false,
  accessibility: false,
  overlay: false,
  collectorRunning: false,
  windowSummaryEnabled: true,
  pausedUntil: 0,
};

function makeConnection(preset: AiProviderPreset): AiConnection {
  return {
    id: `${preset}-${Date.now()}`,
    provider: 'openai-compatible',
    preset,
    ...defaultConnectionValues[preset],
    chatJsonOutputEnabled: false,
    modelParameters: chatModelParameterDefaults,
    ...defaultContextCompressionSettings,
  };
}

function formatExpressionUpdatedAt(value: number) {
  if (!value) return '还没有保存过';
  return new Date(value).toLocaleString('zh-CN', {
    day: 'numeric',
    hour: '2-digit',
    hour12: false,
    minute: '2-digit',
    month: 'long',
  });
}

function formatPhoneActivityKind(kind: string) {
  switch (kind) {
    case 'foreground_app':
      return '前台';
    case 'foreground_app_duration':
      return '时长';
    case 'usage':
      return '前台';
    case 'notification':
      return '通知';
    case 'accessibility':
      return '窗口';
    case 'screen':
      return '屏幕';
    default:
      return '日志';
  }
}

function formatPhoneActivityTime(value: number) {
  if (!value) return '--:--';
  return new Date(value).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    hour12: false,
    minute: '2-digit',
    second: '2-digit',
  });
}

function getPhoneActivityTitle(log: PhoneActivityLog) {
  if (log.title?.trim()) return log.title.trim();
  if (log.source?.trim()) return log.source.trim();
  return '手机活动';
}

function getPhoneActivitySource(log: PhoneActivityLog) {
  const source = log.source?.trim();
  if (!source || source === log.title?.trim()) return '';
  return source;
}

function isVisiblePhoneLog(log: PhoneActivityLog) {
  return isVisiblePhoneActivityLog(log);
}

function phoneRuleKindLabel(kind: PhoneActivityRuleKind) {
  if (kind === 'blacklist') return '黑名单';
  if (kind === 'whitelist') return '白名单';
  return '会吃醋';
}

const PHONE_SETTINGS_READ_TIMEOUT_MS = SETTINGS_READ_TIMEOUT_MS;

export function AiSettingsScreen({ navigate, section }: Props) {
  const {
    chatConnection,
    connections,
    getConnectionKey,
    loaded,
    memoryOrganizerConnection,
    memoryRerankerConnection,
    memoryRerankerKey,
    profile,
    visionConnection,
    visionKey,
    audioUnderstandingConnection,
    utilityJsonConnection,
    imageGenerationConnection,
    financeReasoningConnection,
    lifeCreativeConnection,
    removeConnection,
    saveConnection,
    saveProfile,
    selectConnection,
  } = useAiConfigPreferences();
  const [draft, setDraft] = useState<AiConnection | null>(null);
  const [draftKey, setDraftKey] = useState('');
  const [parameterTextValues, setParameterTextValues] = useState<Partial<Record<AiModelParameterKey, string>>>({});
  const [persona, setPersona] = useState<AiProfile>(profile);
  const [showApiKey, setShowApiKey] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  const [visionTestBusy, setVisionTestBusy] = useState(false);
  const [visionTestResult, setVisionTestResult] = useState<CameraVisionAnalysisSuccessV1>();
  const [proactiveSettings, setProactiveSettings] = useState<ProactiveMessageSettings | null>(null);
  const [autonomySettings, setAutonomySettings] = useState<AutonomySettings>(defaultAutonomySettings);
  const [automaticRemoteAiPolicy, setAutomaticRemoteAiPolicy] = useState<AutomaticRemoteAiPolicy>(
    defaultAutomaticRemoteAiPolicy,
  );
  const [automaticPolicySaving, setAutomaticPolicySaving] = useState(false);
  const [phoneActivityStatus, setPhoneActivityStatus] = useState<PhoneActivityPermissionStatus>(defaultPhoneActivityStatus);
  const [phoneActivityStatusAvailable, setPhoneActivityStatusAvailable] = useState(false);
  const [phoneActivityStatusLoading, setPhoneActivityStatusLoading] = useState(false);
  const [phoneActivityStatusError, setPhoneActivityStatusError] = useState('');
  const [notificationPostingAllowed, setNotificationPostingAllowed] = useState(false);
  const [phoneActivityLogs, setPhoneActivityLogs] = useState<PhoneActivityLog[]>([]);
  const [phoneActivityLogsVisible, setPhoneActivityLogsVisible] = useState(false);
  const phoneReadsRef = useRef({ active: false, status: 0 });
  const [phoneActivityRules, setPhoneActivityRules] = useState<PhoneActivityProactiveSettings>(defaultPhoneActivityProactiveSettings);
  const webSearchProviderStatus = getWebSearchProviderStatus();
  const [phoneFocusDebugStatus, setPhoneFocusDebugStatus] = useState('');
  const [embeddingSettings, setEmbeddingSettings] = useState<EmbeddingSettings>(defaultEmbeddingSettings);
  const [embeddingKey, setEmbeddingKey] = useState('');
  const [showEmbeddingKey, setShowEmbeddingKey] = useState(false);
  const [rerankerSettings, setRerankerSettings] = useState<MemoryRerankerSettings>(defaultMemoryRerankerSettings);
  const [rerankerStatus, setRerankerStatus] = useState<MemoryRerankerStatus>(getLastMemoryRerankerStatus());
  const [missingEmbeddings, setMissingEmbeddings] = useState(0);
  const [memoryDiagnostics, setMemoryDiagnostics] = useState<Awaited<ReturnType<typeof getMemoryRetrievalDiagnostics>> | null>(null);
  const [expressionLibrary, setExpressionLibrary] = useState<CustomExpressionLibrary>(createEmptyCustomExpressionLibrary());
  const [selectedExpressionMood, setSelectedExpressionMood] = useState<ExpressionMoodId>('happy');
  const [stickerLibrary, setStickerLibrary] = useState<BaiyunStickerLibrary>(createEmptyStickerLibrary());
  const [selectedStickerMood, setSelectedStickerMood] = useState<ExpressionMoodId>('happy');
  const [stickerAdding, setStickerAdding] = useState(false);
  const [chatSemanticDiagnostics, setChatSemanticDiagnostics] = useState<
    Awaited<ReturnType<typeof loadBaiyunChatSemanticDiagnostics>>
  >({ entries: [] });
  const [chatReplyFailureDiagnostics, setChatReplyFailureDiagnostics] = useState<
    Awaited<ReturnType<typeof loadBaiyunChatReplyFailureDiagnostics>>
  >({ entries: [] });
  const [chatAuxiliaryDiagnostics, setChatAuxiliaryDiagnostics] = useState<
    Awaited<ReturnType<typeof loadChatAuxiliaryDiagnostics>>
  >({ entries: [] });
  const [latestBadEnvelope, setLatestBadEnvelope] = useState<
    Awaited<ReturnType<typeof loadBaiyunLatestBadEnvelopeSnapshot>>
  >(null);
  const [badEnvelopeExpanded, setBadEnvelopeExpanded] = useState(false);
  const [sectionReady, setSectionReady] = useState(false);
  const [loadRevision, setLoadRevision] = useState(0);
  const sectionInfo = aiSettingsSections.find(item => item.route === section)!;
  const missingRead = useSettingsRead(section === 'memory-settings', getMissingEmbeddingCount, setMissingEmbeddings);
  const retrievalRead = useSettingsRead(section === 'memory-settings', getMemoryRetrievalDiagnostics, setMemoryDiagnostics);
  const semanticRead = useSettingsRead(section === 'ai-diagnostics', () => loadBaiyunChatSemanticDiagnostics({ strict: true }), setChatSemanticDiagnostics);
  const failureRead = useSettingsRead(section === 'ai-diagnostics', () => loadBaiyunChatReplyFailureDiagnostics({ strict: true }), setChatReplyFailureDiagnostics);
  const auxiliaryRead = useSettingsRead(section === 'ai-diagnostics', () => loadChatAuxiliaryDiagnostics({ strict: true }), setChatAuxiliaryDiagnostics);
  const badEnvelopeRead = useSettingsRead(section === 'ai-diagnostics', () => loadBaiyunLatestBadEnvelopeSnapshot({ strict: true }), setLatestBadEnvelope);
  const renderReadState = (read: { state: SettingsReadState; refresh: () => Promise<void> }, label: string) => (
    <View>
      {read.state.loading ? <Text style={styles.behaviorReviewMeta}>正在读取{label}…</Text> : null}
      {read.state.failed ? <>
        <Text style={styles.behaviorReviewMeta}>
          {label}暂未读取成功。{read.state.loaded ? '下方保留上次读取的资料。' : '暂时无法确认内容。'}
        </Text>
        <Pressable accessibilityRole="button" disabled={busy} onPress={() => void read.refresh()} style={styles.smallButton}>
          <Text style={styles.smallButtonText}>重新读取{label}</Text>
        </Pressable>
      </> : null}
    </View>
  );

  useEffect(() => {
    if (loaded && !draft && connections.length) {
      setDraft(connections[0]);
      setDraftKey(getConnectionKey(connections[0].id));
    } else if (loaded && !draft) {
      setDraftKey('');
    }
  }, [connections, draft, getConnectionKey, loaded]);

  useEffect(() => {
    setPersona(profile);
  }, [profile]);

  useEffect(() => {
    let active = true;
    phoneReadsRef.current.active = true;
    setSectionReady(false);
    setNotice(null);
    const readSection = async () => {
      if (section === 'proactive-settings') {
        const [proactive, automatic, autonomy] = await withSettingsTimeout(Promise.all([
          loadProactiveMessageSettings({ strict: true }), loadAutomaticRemoteAiPolicy({ strict: true }), loadAutonomySettings({ strict: true }),
        ]), SETTINGS_READ_TIMEOUT_MS, '主动联系设置读取超时');
        if (!active) return;
        setProactiveSettings(proactive);
        setAutomaticRemoteAiPolicy(automatic);
        setAutonomySettings(autonomy);
      } else if (section === 'phone-manager') {
        const rules = await withSettingsTimeout(loadPhoneActivityProactiveSettings(), PHONE_SETTINGS_READ_TIMEOUT_MS, '小管家设置读取超时');
        if (!active) return;
        setPhoneActivityRules(rules);
        void refreshPhoneActivityStatus();
      } else if (section === 'memory-settings') {
        const [embedding, reranker] = await withSettingsTimeout(Promise.all([
          loadEmbeddingSettings({ strict: true }), loadMemoryRerankerSettings({ strict: true }),
        ]), SETTINGS_READ_TIMEOUT_MS, '记忆设置读取超时');
        if (!active) return;
        setEmbeddingSettings(embedding.settings);
        setEmbeddingKey(embedding.apiKey);
        setRerankerSettings(reranker);
        setRerankerStatus(getLastMemoryRerankerStatus());
      } else if (section === 'relationship-settings') {
        const [expressions, stickers] = await withSettingsTimeout(Promise.all([
          loadCustomExpressionLibrary({ strict: true }), loadStickerLibrary({ strict: true }),
        ]), SETTINGS_READ_TIMEOUT_MS, '相处与表情设置读取超时');
        if (!active) return;
        setExpressionLibrary(expressions);
        setStickerLibrary(stickers);
      }
      if (active) setSectionReady(true);
    };
    void readSection().catch(() => {
      if (active) setNotice({ kind: 'error', text: '本页资料暂未读取成功，请重试。已保存的设置没有改动。' });
    });
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active' && section === 'ai-diagnostics') {
        void semanticRead.refresh();
        void failureRead.refresh();
        void auxiliaryRead.refresh();
        void badEnvelopeRead.refresh();
      } else if (state === 'active' && section === 'phone-manager') {
        void readSection().catch(() => {
          if (active) setNotice({ kind: 'error', text: '刷新失败，当前显示的是上次读取的资料。' });
        });
      }
    });
    return () => {
      active = false;
      phoneReadsRef.current.active = false;
      phoneReadsRef.current.status += 1;
      subscription.remove();
    };
  }, [section, loadRevision]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      navigate('settings');
      return true;
    });
    return () => subscription.remove();
  }, [navigate]);

  const updateProactiveSettings = (next: ProactiveMessageSettings) => {
    setProactiveSettings(next);
    void saveProactiveMessageSettings(next);
  };

  const updateAutonomySettings = (patch: Partial<AutonomySettings>) => {
    const next = { ...autonomySettings, ...patch };
    setAutonomySettings(next);
    void saveAutonomySettings(next).then(setAutonomySettings);
    if (patch.publicPostingEnabled !== undefined || patch.masterEnabled !== undefined) {
      void loadSocialAgentSettings().then((settings) =>
        saveSocialAgentSettings({
          ...settings,
          autonomousInteractionEnabled: next.masterEnabled && next.publicPostingEnabled,
          preferredPlatforms: ['xiaohongshu'],
        }),
      );
    }
  };


  const updatePublicExploration = async (enabled: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      setAutonomySettings(await setPublicExplorationEnabled(enabled));
    } catch {
      setNotice({ kind: 'error', text: '公开探索设置未保存成功，请重试。当前仍显示上次读取的设置。' });
    } finally {
      setBusy(false);
    }
  };
  const updatePhoneActivityRules = (next: PhoneActivityProactiveSettings) => {
    setPhoneActivityRules(next);
    void savePhoneActivityProactiveSettings(next);
  };

  const addPhoneActivityRule = (kind: PhoneActivityRuleKind, log: PhoneActivityLog) => {
    if (!isVisiblePhoneLog(log)) {
      setNotice({ kind: 'error', text: '君落自己不需要加入手机监督名单。' });
      return;
    }
    const rule = createPhoneActivityRule(kind, log);
    const rules = phoneActivityRules.rules.filter((item) => item.id !== rule.id);
    updatePhoneActivityRules({
      ...phoneActivityRules,
      enabled: true,
      jealousyEnabled: kind === 'jealousy' ? true : phoneActivityRules.jealousyEnabled,
      rules: [...rules, rule],
    });
    setNotice({ kind: 'success', text: `已经把 ${rule.title} 加入${phoneRuleKindLabel(kind)}。` });
  };

  const hasPhoneActivityRule = (kind: PhoneActivityRuleKind, log: PhoneActivityLog) => {
    const next = createPhoneActivityRule(kind, log);
    return phoneActivityRules.rules.some((rule) => rule.id === next.id);
  };

  const handleTestPhoneOverlay = async () => {
    const portrait = youPortraitAssets[Math.floor(Math.random() * youPortraitAssets.length)]?.androidResourceName ?? 'you_portrait_neutral';
    const ok = await showPhoneActivityOverlay(portrait, 1, '返回君落', 'manual-test');
    setNotice({ kind: ok ? 'success' : 'error', text: ok ? '测试遮挡已经丢出去了。' : '测试遮挡失败，请检查悬浮权限是否真的允许。' });
  };

  const handleLoadPhoneFocusDebugStatus = async () => {
    const status = await getPhoneActivityFocusDebugStatus();
    setPhoneFocusDebugStatus(status);
  };

  const editConnection = (connection: AiConnection) => {
    setDraft({ ...connection, modelParameters: normalizeChatModelParameters(connection.modelParameters) });
    setParameterTextValues({});
    setDraftKey(getConnectionKey(connection.id));
    setNotice(null);
  };

  const addConnection = (preset: AiProviderPreset) => {
    setDraft(makeConnection(preset));
    setParameterTextValues({});
    setDraftKey(preset === 'ollama' ? 'ollama' : '');
    setShowApiKey(false);
    setNotice(null);
  };

  const confirmRemoveConnection = (connection: AiConnection) => {
    Alert.alert('删除这条连接？', `“${connection.name}”及对应的密钥会从本机移除。正在使用它的用途会取消选择，请重新选择模型。聊天记录不会删除。`, [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: async () => {
          setBusy(true);
          setNotice(null);
          try {
            await removeConnection(connection.id);
            setDraft((current) => current?.id === connection.id ? null : current);
          } catch {
            setNotice({ kind: 'error', text: '删除连接未完成，请重试。' });
          } finally {
            setBusy(false);
          }
        },
      },
    ]);
  };

  const validateConnection = () => {
    if (!draft?.name.trim()) return '请给这条连接起一个名字。';
    if (!draft.baseUrl.trim()) return '请填写 Base URL。';
    if (!draftKey.trim()) return '请填写 API Key。';
    if (!draft.model.trim()) return '请填写模型名称。';
    return null;
  };

  const updateDraftModelParameter = (
    key: AiModelParameterKey,
    update: { enabled?: boolean; value?: number },
  ) => {
    setDraft((current) => {
      if (!current) return current;
      const currentParameters = normalizeChatModelParameters(current.modelParameters);
      const currentParameter = currentParameters[key] ?? {
        enabled: false,
        value: chatModelParameterDefinitions[key].defaultValue,
      };
      return {
        ...current,
        modelParameters: {
          ...currentParameters,
          [key]: {
            enabled: update.enabled ?? currentParameter.enabled,
            value:
              update.value === undefined
                ? currentParameter.value
                : normalizeParameterValue(key, update.value),
          },
        },
      };
    });
  };

  const updateDraftModelParameterText = (key: AiModelParameterKey, value: string) => {
    const normalizedText = value.replace(',', '.');
    if (!/^-?\d*(?:\.\d*)?$/.test(normalizedText)) return;
    setParameterTextValues((current) => ({ ...current, [key]: normalizedText }));
    if (!normalizedText || normalizedText === '-' || normalizedText === '.' || normalizedText === '-.' || normalizedText.endsWith('.')) {
      return;
    }
    const parsed = Number(normalizedText);
    if (!Number.isFinite(parsed)) return;
    updateDraftModelParameter(key, { value: parsed });
  };

  const commitDraftModelParameterText = (key: AiModelParameterKey) => {
    setParameterTextValues((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
  };

  const applyCompanionRecommendedParameters = () => {
    setDraft((current) =>
      current ? { ...current, modelParameters: normalizeChatModelParameters(companionRecommendedModelParameters) } : current,
    );
    setParameterTextValues({});
  };

  const resetModelParameters = () => {
    setDraft((current) =>
      current ? { ...current, modelParameters: normalizeChatModelParameters(chatModelParameterDefaults) } : current,
    );
    setParameterTextValues({});
  };

  const handleSaveConnection = async () => {
    const validationError = validateConnection();
    if (validationError || !draft) {
      setNotice({ kind: 'error', text: validationError ?? '请先新建一条连接。' });
      return;
    }
    setBusy(true);
    try {
      await saveConnection(draft, draftKey);
      setNotice({ kind: 'success', text: '这条连接已经收进抽屉。' });
    } catch {
      setNotice({ kind: 'error', text: '保存失败，请稍后重试。' });
    } finally {
      setBusy(false);
    }
  };

  const handleTest = async () => {
    const validationError = validateConnection();
    if (validationError || !draft) {
      setNotice({ kind: 'error', text: validationError ?? '请先新建一条连接。' });
      return;
    }
    setBusy(true);
    const result = await testOpenAiCompatibleConnection({ connection: draft, apiKey: draftKey });
    setNotice({ kind: result.ok ? 'success' : 'error', text: result.detail });
    setBusy(false);
  };

  const handleTestVisionModel = async () => {
    if (!visionConnection) {
      setNotice({ kind: 'error', text: '请先把某条连接设为看图模型。' });
      return;
    }
    if (!visionKey.trim()) {
      setNotice({ kind: 'error', text: '当前看图模型还没有 API Key。' });
      return;
    }
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setNotice({ kind: 'error', text: '需要相册权限才能测试看图模型。' });
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      allowsMultipleSelection: false,
      mediaTypes: ['images'],
      quality: 0.85,
    });
    const asset = result.canceled ? undefined : result.assets[0];
    if (!asset?.uri) return;
    setVisionTestBusy(true);
    setVisionTestResult(undefined);
    setNotice(null);
    try {
      const mimeType = asset.mimeType || 'image/jpeg';
      const base64 = await FileSystem.readAsStringAsync(asset.uri, { encoding: 'base64' });
      const analysis = await analyzeCameraFrameStructured({
        apiKey: visionKey,
        connection: visionConnection,
        imageDataUrl: `data:${mimeType};base64,${base64}`,
        mimeType,
        frame: {
          sourceKind: 'selected_test_image',
          width: asset.width,
          height: asset.height,
          rotation: 0,
          mirrored: false,
        },
        subjectIdentityContext: { status: 'unknown' },
        deviceContextFacts: [],
      });
      setVisionTestResult(analysis);
      setNotice({ kind: 'success', text: '看图模型已经完成结构化测试。' });
    } catch (error) {
      setNotice({
        kind: 'error',
        text: error instanceof Error && error.message.trim()
          ? describeCameraVisionErrorCode(error.message)
          : '看图测试失败，未取得可读取的图片或模型回执。',
      });
    } finally {
      setVisionTestBusy(false);
    }
  };

  const refreshPhoneActivityStatus = async () => {
    if (!phoneReadsRef.current.active) return;
    const version = ++phoneReadsRef.current.status;
    const current = () => phoneReadsRef.current.active && phoneReadsRef.current.status === version;
    setPhoneActivityStatusLoading(true);
    setPhoneActivityStatusError('');
    try {
      const [phoneActivityResult, canPostNotifications] = await withSettingsTimeout(Promise.all([
        getPhoneActivityPermissionStatusResult(), hasNotificationPermission(),
      ]), PHONE_SETTINGS_READ_TIMEOUT_MS, '权限读取超时');
      if (!current()) return;
      setPhoneActivityStatus(phoneActivityResult.status);
      setPhoneActivityStatusAvailable(phoneActivityResult.available);
      setNotificationPostingAllowed(canPostNotifications);
      if (!phoneActivityResult.available) setPhoneActivityStatusError('手机权限状态未能读取，请重试。');
    } catch (error) {
      if (current()) setPhoneActivityStatusError(error instanceof Error && error.message === '权限读取超时'
        ? '手机权限读取超时，请重试。' : '手机权限读取失败，请重试。');
    } finally {
      if (current()) setPhoneActivityStatusLoading(false);
    }
  };

  const handleRequestNotificationPosting = async () => {
    setBusy(true);
    try {
      const granted = await requestNotificationPermission();
      await refreshPhoneActivityStatus();
      if (granted) {
        setNotice({ kind: 'success', text: '君落发送系统提醒的权限已经开启。' });
        return;
      }
      setNotice({ kind: 'error', text: '系统仍未允许君落发送提醒，请在应用通知设置里开启。' });
      await Linking.openSettings().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };

  const handleOpenPhoneFeature = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const saved = await saveWithYouFeaturePreference('phone');
      if (!saved) {
        setNotice({ kind: 'error', text: '打开「交出手机」失败，请重试。' });
        return;
      }
      navigate('period');
    } catch {
      setNotice({ kind: 'error', text: '打开「交出手机」失败，请重试。' });
    } finally {
      setBusy(false);
    }
  };

  const handleStartPhoneActivity = async () => {
    setBusy(true);
    const ok = await startPhoneActivityCollector();
    await refreshPhoneActivityStatus();
    setNotice({ kind: ok ? 'success' : 'error', text: ok ? '本机小管家已经开始留意啦。' : '本机小管家启动失败，请确认使用情况权限已经开启。' });
    setBusy(false);
  };

  const handleStopPhoneActivity = async () => {
    setBusy(true);
    const ok = await stopPhoneActivityCollector();
    await refreshPhoneActivityStatus();
    setNotice({ kind: ok ? 'success' : 'error', text: ok ? '手机小管家已经停下来休息。' : '手机小管家暂时停不下来，请稍后再试。' });
    setBusy(false);
  };

  const handlePausePhoneActivity = async (minutes: number) => {
    setBusy(true);
    const ok = await pausePhoneActivityCollector(minutes);
    await refreshPhoneActivityStatus();
    setNotice({ kind: ok ? 'success' : 'error', text: ok ? `已经进入 ${minutes} 分钟隐私暂停。` : '暂停失败，请稍后再试。' });
    setBusy(false);
  };

  const handleLoadPhoneActivityLogs = async () => {
    setBusy(true);
    const logs = await loadRecentPhoneActivityLogs(20);
    setPhoneActivityLogs(logs);
    setPhoneActivityLogsVisible(true);
    setNotice({
      kind: logs.length ? 'success' : 'error',
      text: logs.length ? `看到了 ${logs.length} 条本机手机日志。` : '本机还没有最近手机日志，可以先点启动小管家再切几个 App 试试。',
    });
    setBusy(false);
  };

  const handleSavePersona = async () => {
    setBusy(true);
    try {
      await saveProfile(persona);
      setNotice({ kind: 'success', text: '相处设定已经保存。' });
    } finally {
      setBusy(false);
    }
  };

  const handleRetractLatestInnerState = () => {
    Alert.alert(
      '撤销最近一次状态整理？',
      '这会精确撤销最近一条仍有效的关系选择证据，并重新核对关系阶段；不会改写其它心情、愿望、念头或聊天记录。',
      [
        { text: '返回', style: 'cancel' },
        {
          text: '撤销',
          onPress: () => {
            setBusy(true);
            void retractLatestJunluoRelationshipChoiceEvidence()
              .then((result) => {
                setNotice(result.status === 'retracted'
                  ? { kind: 'success', text: '最近一条关系选择证据已经精确撤销。' }
                  : result.status === 'no-evidence'
                    ? { kind: 'error', text: '现在没有可以撤销的关系选择证据。' }
                    : { kind: 'error', text: '备份恢复正在占用数据，当前没有写入。' });
              })
              .catch(() => setNotice({ kind: 'error', text: '撤销失败，当前状态没有改动。' }))
              .finally(() => setBusy(false));
          },
        },
      ],
    );
  };

  const handleResetInnerState = () => {
    Alert.alert(
      '重置内在状态？',
      '这会清空当前十维愿望、情绪与关系状态、闪念和执念，让运行时回到默认状态。聊天、记忆、梦、日记、提醒和信件不会删除。',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '继续确认',
          style: 'destructive',
          onPress: () => Alert.alert(
            '再次确认重置',
            '这是开发验收操作。重置后不能从这个按钮撤回。',
            [
              { text: '返回', style: 'cancel' },
              {
                text: '确认重置',
                style: 'destructive',
                onPress: () => {
                  setBusy(true);
                  void resetJunluoInnerState()
                    .then((result) => setNotice(result === 'reset'
                      ? { kind: 'success', text: '内在状态已经重置；其它生活数据没有删除。' }
                      : { kind: 'error', text: '备份恢复正在占用数据，当前没有重置。' }))
                    .catch(() => setNotice({ kind: 'error', text: '重置失败，当前状态没有改动。' }))
                    .finally(() => setBusy(false));
                },
              },
            ],
          ),
        },
      ],
    );
  };

  const handleSaveExpressionLibrary = async () => {
    setBusy(true);
    try {
      const saved = await saveCustomExpressionLibrary(expressionLibrary);
      setExpressionLibrary(saved);
      const total = countCustomExpressionItems(saved);
      setNotice({ kind: 'success', text: total ? `我的表情抽屉已经更新了：${total} 个自定义表情。` : '自定义表情抽屉已经清空。' });
    } catch {
      setNotice({ kind: 'error', text: '保存表情抽屉失败，请稍后再试。' });
    } finally {
      setBusy(false);
    }
  };

  const handleAddSticker = async () => {
    if (stickerAdding) return;
    const dataEpoch = captureBackupRestoreDataEpoch();
    if (dataEpoch === null) return;
    const stickerMood = selectedStickerMood;
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setNotice({ kind: 'error', text: '需要相册权限才能把图片收进表情包抽屉。' });
      return;
    }
    setStickerAdding(true);
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        allowsMultipleSelection: false,
        mediaTypes: ['images'],
        quality: 0.92,
      });
      const asset = result.canceled ? undefined : result.assets[0];
      if (!asset?.uri) return;
      const committed = await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
        const sticker = await copyStickerImage({
          height: asset.height,
          mimeType: asset.mimeType ?? undefined,
          moodId: stickerMood,
          name: asset.fileName || (EXPRESSION_MOOD_LABELS[stickerMood] + '表情包'),
          size: asset.fileSize,
          sourceUri: asset.uri,
          width: asset.width,
        });
        try {
          const currentLibrary = await loadStickerLibrary();
          return await saveStickerLibrary(addStickerToLibrary(currentLibrary, sticker));
        } catch (error) {
          await deleteStickerFile(sticker);
          throw error;
        }
      });
      if (!committed.committed || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      setStickerLibrary(committed.value);
      setNotice({ kind: 'success', text: '已经收进' + EXPRESSION_MOOD_LABELS[stickerMood] + '抽屉。' });
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : '添加表情包失败，请稍后再试。' });
    } finally {
      setStickerAdding(false);
    }
  };

  const handleDeleteSticker = (stickerId: string) => {
    const sticker = stickerLibrary.stickers.find((item) => item.id === stickerId);
    if (!sticker) return;
    Alert.alert('删除这张表情包？', sticker.name, [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: () => {
          void (async () => {
            const dataEpoch = captureBackupRestoreDataEpoch();
            if (dataEpoch === null) return;
            const committed = await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
              const currentLibrary = await loadStickerLibrary();
              const currentSticker = currentLibrary.stickers.find((item) => item.id === stickerId);
              if (!currentSticker) return null;
              const saved = await saveStickerLibrary(removeStickerFromLibrary(currentLibrary, stickerId));
              await deleteStickerFile(currentSticker);
              return saved;
            });
            if (
              !committed.committed
              || !committed.value
              || !canCommitBackupRestoreDataEpoch(dataEpoch)
            ) return;
            setStickerLibrary(committed.value);
            setNotice({ kind: 'success', text: '这张表情包已经从抽屉拿掉。' });
          })().catch(() => setNotice({ kind: 'error', text: '删除表情包失败，请稍后再试。' }));
        },
      },
    ]);
  };
  const handleSaveEmbeddingSettings = async () => {
    if (!embeddingSettings.baseUrl.trim() || !embeddingSettings.model.trim()) {
      setNotice({ kind: 'error', text: '请填写语义记忆的 Base URL 和模型名称。' });
      return;
    }
    setBusy(true);
    missingRead.invalidate();
    retrievalRead.invalidate();
    try {
      const saved = await saveEmbeddingSettings(embeddingSettings, embeddingKey);
      setEmbeddingSettings(saved);
      setNotice({ kind: 'success', text: '语义记忆设置已经保存。' });
    } catch {
      setNotice({ kind: 'error', text: '语义记忆设置保存失败。' });
    } finally {
      setBusy(false);
      void missingRead.refresh();
      void retrievalRead.refresh();
    }
  };

  const handleTestEmbedding = async () => {
    setBusy(true);
    const result = await testMemoryEmbeddingConnection(embeddingSettings, embeddingKey);
    setNotice({ kind: result.ok ? 'success' : 'error', text: result.detail });
    setBusy(false);
  };

  const handleSaveRerankerSettings = async () => {
    setBusy(true);
    try {
      const saved = await saveMemoryRerankerSettings(rerankerSettings);
      setRerankerSettings(saved);
      setRerankerStatus(getLastMemoryRerankerStatus());
      setNotice({
        kind: 'success',
        text: saved.enabled ? '记忆重排设置已保存；满足条件时才会调用模型。' : '记忆重排已关闭，不会产生额外调用。',
      });
    } catch {
      setNotice({ kind: 'error', text: '记忆重排设置保存失败。' });
    } finally {
      setBusy(false);
    }
  };

  const handleTestReranker = async () => {
    setBusy(true);
    const result = await testMemoryRerankerConnection(memoryRerankerConnection, memoryRerankerKey);
    setRerankerStatus(getLastMemoryRerankerStatus());
    setNotice({ kind: result.ok ? 'success' : 'error', text: result.detail });
    setBusy(false);
  };

  const handleBackfillEmbeddings = async () => {
    setBusy(true);
    missingRead.invalidate();
    retrievalRead.invalidate();
    try {
      await saveEmbeddingSettings(embeddingSettings, embeddingKey);
      const result = await backfillMemoryEmbeddings(20);
      missingRead.accept(result.missing);
      void retrievalRead.refresh();
      setNotice({ kind: 'success', text: `补齐了 ${result.succeeded}/${result.attempted} 条语义索引，还缺 ${result.missing} 条。` });
    } catch {
      void missingRead.refresh();
      void retrievalRead.refresh();
      setNotice({ kind: 'error', text: '补齐语义索引失败，请先测试向量连接。' });
    } finally {
      setBusy(false);
    }
  };

  const selectedExpressionCategory = getCustomExpressionCategory(expressionLibrary, selectedExpressionMood);
  const selectedKaomojiCount = parseExpressionItems(selectedExpressionCategory.kaomojiText).length;
  const selectedEmojiCount = parseExpressionItems(selectedExpressionCategory.emojiText).length;
  const totalExpressionCount = countCustomExpressionItems(expressionLibrary);
  const selectedStickers = getStickersForMood(stickerLibrary, selectedStickerMood);
  const totalStickerCount = countStickers(stickerLibrary);
  const now = new Date();
  const todayKey = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
  const todayChatSemanticEntries = chatSemanticDiagnostics.entries.filter((entry) => entry.localDate === todayKey);
  const visibleChatSemanticEntries = chatSemanticDiagnostics.entries.slice().reverse().slice(0, 8);
  const visibleChatReplyFailureEntries = chatReplyFailureDiagnostics.entries.slice().reverse().slice(0, 8);
  const visibleChatAuxiliaryEntries = chatAuxiliaryDiagnostics.entries.slice().reverse().slice(0, 8);
  const chatSemanticCounts = {
    valid: todayChatSemanticEntries.filter((entry) => entry.status === 'valid').length,
    partial: todayChatSemanticEntries.filter((entry) => entry.status === 'partial').length,
    unresolved: todayChatSemanticEntries.filter((entry) => entry.status === 'semantic_unresolved').length,
    invalid: todayChatSemanticEntries.filter((entry) => entry.status === 'messages_invalid').length,
  };
  const hiddenSemanticTokens = todayChatSemanticEntries.reduce(
    (total, entry) => total + entry.semanticOutputEstimatedTokens,
    0,
  );
  const describeSemanticReason = (reason?: string) => {
    const labels: Record<string, string> = {
      invalid_json: '返回内容不是合法 JSON',
      invalid_root_shape: '最外层结构不符合双输出格式',
      invalid_semantic_shape: '语义区字段不完整或格式不对',
      too_many_signals: '语义信号超过四条',
      invalid_signal_shape: '语义信号字段不符合结构',
      invalid_semantic_evidence: '语义证据没有通过原文校验',
      required_signal_missing: '没有填写任何行动答题卡',
      ordinary_chat_invalid: '普通聊天票没有通过校验',
      messages_missing_or_empty: '没有可显示的聊天正文',
    };
    return reason ? labels[reason] ?? reason : '';
  };
  const describeRawContentFormat = (
    format: typeof visibleChatSemanticEntries[number]['rawContentFormat'],
  ) => {
    if (format === 'json_object') return 'JSON 对象';
    if (format === 'json_value') return '其他 JSON 值';
    if (format === 'fenced_content') return '代码围栏内容';
    if (format === 'tagged_content') return '双标签内容';
    if (format === 'non_json') return '普通文字';
    if (format === 'empty') return '空正文';
    return '旧记录未知';
  };
  const describeBadEnvelopeFieldStatus = (status: string) => ({
    valid: '合法',
    missing: '缺失',
    malformed: '错型',
    unavailable: '不可判定',
  }[status] ?? status);

  const handleDeleteLatestBadEnvelope = () => {
    Alert.alert(
      '删除最近坏卷？',
      '只会删除这份缓存证物，不会删除聊天、行动或其它诊断。',
      [
        { text: '先留着', style: 'cancel' },
        {
          text: '删除坏卷',
          style: 'destructive',
          onPress: () => {
            badEnvelopeRead.invalidate();
            void deleteBaiyunLatestBadEnvelopeSnapshot()
              .then(() => {
                badEnvelopeRead.accept(null);
                setBadEnvelopeExpanded(false);
              })
              .catch(() => {
                void badEnvelopeRead.refresh();
                setNotice({ kind: 'error', text: '坏卷缓存删除失败。' });
              });
          },
        },
      ],
    );
  };

  const queueChatReplyFailureFixture = async (
    code: BaiyunChatReplyFailureFixtureCode | null,
  ) => {
    try {
      await saveBaiyunChatReplyFailureFixture(code);
      setNotice({
        kind: 'success',
        text: code
          ? `已排队一次“${CHAT_REPLY_FAILURE_LABELS[code]}”。回聊天发送任意消息即可触发。`
          : '已取消待触发的回复故障夹具。',
      });
    } catch {
      setNotice({ kind: 'error', text: '回复故障夹具没有保存，请重试。' });
    }
  };

  const updateAutomaticRemoteAiPolicy = (enabled: boolean) => {
    void persistAutomaticRemoteAiPolicy({ ...automaticRemoteAiPolicy, enabled })
      .catch(() => {
        setNotice({ kind: 'error', text: '后台自动调用设置没有保存，请稍后再试。' });
      });
  };
  const persistAutomaticRemoteAiPolicy = async (next: AutomaticRemoteAiPolicy) => {
    setAutomaticPolicySaving(true);
    try { setAutomaticRemoteAiPolicy(await saveAutomaticRemoteAiPolicy(next)); }
    finally { setAutomaticPolicySaving(false); }
  };
  const describeShareResponseRejections = (
    codes: NonNullable<typeof visibleChatSemanticEntries[number]['shareResponseDiagnostic']>['rejectionCodes'],
  ) => {
    const labels: Record<typeof codes[number], string> = {
      model_omitted: '模型没有返回标签',
      invalid_shape: '返回结构不完整',
      unknown_share: '返回了不存在的分享',
      duplicate_share: '同一分享重复返回',
      direct_target_conflict: '返回目标与引用消息不一致',
      low_confidence: '置信度不足',
      invalid_evidence: '回应证据没有通过本轮原文校验',
    };
    return codes.map((code) => labels[code]).join('、');
  };
  const describeLocalShareMatch = (
    kind: NonNullable<
      NonNullable<typeof visibleChatSemanticEntries[number]['shareResponseDiagnostic']>['localMatchKind']
    >,
  ) => {
    if (kind === 'direct_concrete') return '直接引用的具体内容';
    if (kind === 'direct_generic') return '直接引用的泛指回应';
    if (kind === 'concrete_content') return '具体内容';
    if (kind === 'generic_all') return '泛指全部等待分享';
    return '泛指最新一条';
  };
  const describeLocalShareSkip = (
    reason: NonNullable<
      NonNullable<typeof visibleChatSemanticEntries[number]['shareResponseDiagnostic']>['localSkippedReason']
    >,
  ) => reason === 'not_seen_or_deferred'
    ? '仓鼠表示还没看或稍后再看'
    : '没有找到可确认的具体内容';

  return (
    <View style={styles.page}>
      <View style={styles.header}>
        <Pressable accessibilityLabel="返回设置" onPress={() => navigate('settings')} style={styles.backButton}>
          <Text style={styles.backText}>‹</Text>
        </Pressable>
        <Text accessibilityRole="header" style={styles.title}>{sectionInfo.title}</Text>
        <View style={styles.backButton} />
      </View>

      {notice ? (
        <View style={[styles.notice, styles.topNotice, notice.kind === 'success' ? styles.successNotice : styles.errorNotice]}>
          <Text style={styles.noticeText}>{notice.text}</Text>
        </View>
      ) : null}

      {!sectionReady || !loaded ? (
        <View style={styles.loadingCard}>
          <Text style={styles.sectionHint}>{notice?.kind === 'error' ? '读取失败后可重新尝试。' : '正在读取本页设置…'}</Text>
          {notice?.kind === 'error' ? (
            <Pressable accessibilityRole="button" onPress={() => setLoadRevision(value => value + 1)} style={styles.secondaryButton}>
              <Text style={styles.secondaryButtonText}>重新读取</Text>
            </Pressable>
          ) : null}
        </View>
      ) : (
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Text style={styles.pageDescription}>{sectionInfo.description}</Text>
        {section === 'ai-settings' ? (<>
        <ModelAccountBalanceCard connections={connections} getConnectionKey={getConnectionKey} />
        <Text style={styles.sectionTitle}>连接抽屉</Text>
        <Text style={styles.sectionHint}>聊天和整理回忆可以使用不同模型，密钥会单独安全保存。</Text>
        <View style={styles.presetRow}>
          {presetOptions.map((preset) => (
            <Pressable key={preset.id} onPress={() => addConnection(preset.id)} style={styles.presetButton}>
              <Text style={styles.presetText}>+ {preset.label}</Text>
            </Pressable>
          ))}
        </View>

        {connections.map((connection) => (
          <Pressable
            key={connection.id}
            onPress={() => editConnection(connection)}
            style={[styles.connectionCard, draft?.id === connection.id && styles.connectionCardSelected]}
          >
            <View style={styles.connectionHeading}>
              <View>
                <Text style={styles.connectionName}>{connection.name}</Text>
                <Text style={styles.connectionModel}>{connection.model}</Text>
              </View>
              <View style={styles.usageBadges}>
                {chatConnection?.id === connection.id ? <Text style={styles.usageBadge}>聊天</Text> : null}
                {memoryOrganizerConnection?.id === connection.id ? <Text style={styles.usageBadgeBlue}>整理</Text> : null}
                {memoryRerankerConnection?.id === connection.id ? <Text style={styles.usageBadgeGreen}>重排</Text> : null}
                {visionConnection?.id === connection.id ? <Text style={styles.usageBadgePurple}>看图</Text> : null}
                {audioUnderstandingConnection?.id === connection.id ? <Text style={styles.usageBadgePurple}>声音／音乐理解</Text> : null}
                {utilityJsonConnection?.id === connection.id ? <Text style={styles.usageBadgeTeal}>小任务</Text> : null}
                {imageGenerationConnection?.id === connection.id ? <Text style={styles.usageBadgePink}>生图</Text> : null}
                {financeReasoningConnection?.id === connection.id ? <Text style={styles.usageBadgeRed}>财务</Text> : null}
                {lifeCreativeConnection?.id === connection.id ? <Text style={styles.usageBadgeLavender}>生活创作</Text> : null}
              </View>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`删除连接：${connection.name}`}
              disabled={busy}
              onPress={(event) => {
                event.stopPropagation();
                confirmRemoveConnection(connection);
              }}
              style={styles.connectionDeleteButton}
            >
              <Text style={styles.connectionDeleteText}>×</Text>
            </Pressable>
            <View style={styles.connectionActions}>
              <Pressable onPress={() => void selectConnection('chat', connection.id)} style={styles.smallButton}>
                <Text style={styles.smallButtonText}>用于聊天</Text>
              </Pressable>
              <Pressable onPress={() => void selectConnection('memoryOrganizer', connection.id)} style={styles.smallButton}>
                <Text style={styles.smallButtonText}>用于整理</Text>
              </Pressable>
              <Pressable onPress={() => void selectConnection('memoryReranker', connection.id)} style={styles.smallButton}>
                <Text style={styles.smallButtonText}>用于重排</Text>
              </Pressable>
              <Pressable onPress={() => void selectConnection('vision', connection.id)} style={styles.smallButton}>
                <Text style={styles.smallButtonText}>用于看图</Text>
              </Pressable>
              <Pressable onPress={() => void selectConnection('audioUnderstanding', connection.id)} style={styles.smallButton}>
                <Text style={styles.smallButtonText}>用于声音／音乐理解</Text>
              </Pressable>
              <Pressable onPress={() => void selectConnection('utilityJson', connection.id)} style={styles.smallButton}>
                <Text style={styles.smallButtonText}>用于小任务</Text>
              </Pressable>
              <Pressable onPress={() => void selectConnection('imageGeneration', connection.id)} style={styles.smallButton}>
                <Text style={styles.smallButtonText}>用于生图</Text>
              </Pressable>
              <Pressable onPress={() => void selectConnection('financeReasoning', connection.id)} style={styles.smallButton}>
                <Text style={styles.smallButtonText}>用于财务</Text>
              </Pressable>
              <Pressable onPress={() => void selectConnection('lifeCreative', connection.id)} style={styles.smallButton}>
                <Text style={styles.smallButtonText}>用于生活创作</Text>
              </Pressable>
            </View>
          </Pressable>
        ))}

        {draft ? (
          <View style={styles.editor}>
            <Text style={styles.editorTitle}>{connections.some((item) => item.id === draft.id) ? '编辑连接' : '新连接'}</Text>
            <Field label="连接名称">
              <TextInput
                onChangeText={(value) => setDraft((current) => (current ? { ...current, name: value } : current))}
                placeholder="例如：白云的 Gemini"
                placeholderTextColor={colors.muted}
                style={styles.input}
                value={draft.name}
              />
            </Field>
            <Field label="Base URL">
              <TextInput
                autoCapitalize="none"
                autoCorrect={false}
                onChangeText={(value) => setDraft((current) => (current ? { ...current, baseUrl: value } : current))}
                placeholder="https://example.com/v1"
                placeholderTextColor={colors.muted}
                style={styles.input}
                value={draft.baseUrl}
              />
            </Field>
            <Field label="API Key">
              <View style={styles.keyRow}>
                <TextInput
                  autoCapitalize="none"
                  autoCorrect={false}
                  onChangeText={setDraftKey}
                  placeholder="sk-..."
                  placeholderTextColor={colors.muted}
                  secureTextEntry={!showApiKey}
                  style={[styles.input, styles.keyInput]}
                  value={draftKey}
                />
                <Pressable onPress={() => setShowApiKey((current) => !current)} style={styles.revealButton}>
                  <Text style={styles.revealText}>{showApiKey ? '隐藏' : '显示'}</Text>
                </Pressable>
              </View>
            </Field>
            <Field label="模型名称">
              <TextInput
                autoCapitalize="none"
                autoCorrect={false}
                onChangeText={(value) => setDraft((current) => (current ? { ...current, model: value } : current))}
                placeholder="模型 ID"
                placeholderTextColor={colors.muted}
                style={styles.input}
                value={draft.model}
              />
            </Field>
            <SettingsDisclosure title="高级参数与上下文">
            <View style={styles.parameterPanel}>
              <View style={styles.parameterRow}>
                <View style={styles.parameterCopy}>
                  <Text style={styles.parameterName}>JSON 对象输出</Text>
                  <Text style={styles.parameterApiName}>向支持的模型请求 response_format: json_object</Text>
                </View>
                <Switch
                  onValueChange={(value) => setDraft((current) => current
                    ? { ...current, chatJsonOutputEnabled: value }
                    : current)}
                  thumbColor={draft.chatJsonOutputEnabled === true ? '#FFFFFF' : '#F8F5F2'}
                  trackColor={{ false: '#DFE5EA', true: '#F0B7AA' }}
                  value={draft.chatJsonOutputEnabled === true}
                />
              </View>
            </View>
            <View style={styles.parameterPanel}>
              <View style={styles.parameterHeading}>
                <View>
                  <Text style={styles.parameterTitle}>模型参数</Text>
                  <Text style={styles.parameterHint}>只会影响普通聊天；关闭时交给模型默认值。</Text>
                </View>
                <View style={styles.parameterPresetRow}>
                  <Pressable onPress={applyCompanionRecommendedParameters} style={styles.parameterPresetButton}>
                    <Text style={styles.parameterPresetText}>陪伴推荐</Text>
                  </Pressable>
                  <Pressable onPress={resetModelParameters} style={styles.parameterResetButton}>
                    <Text style={styles.parameterResetText}>全关</Text>
                  </Pressable>
                </View>
              </View>
              {modelParameterCopy.map((parameter) => {
                const currentParameter =
                  normalizeChatModelParameters(draft.modelParameters)[parameter.id] ??
                  chatModelParameterDefaults[parameter.id];
                return (
                  <View key={parameter.id} style={styles.parameterRow}>
                    <View style={styles.parameterCopy}>
                      <Text style={styles.parameterName}>{parameter.label}</Text>
                      <Text style={styles.parameterApiName}>{parameter.hint}</Text>
                    </View>
                    <TextInput
                      inputMode="decimal"
                      keyboardType="decimal-pad"
                      onBlur={() => commitDraftModelParameterText(parameter.id)}
                      onChangeText={(value) => updateDraftModelParameterText(parameter.id, value)}
                      style={[styles.input, styles.parameterInput]}
                      value={
                        parameterTextValues[parameter.id] ??
                        `${currentParameter?.value ?? chatModelParameterDefinitions[parameter.id].defaultValue}`
                      }
                    />
                    <Switch
                      onValueChange={(enabled) => updateDraftModelParameter(parameter.id, { enabled })}
                      thumbColor={currentParameter?.enabled ? '#FFFFFF' : '#F8F5F2'}
                      trackColor={{ false: '#DFE5EA', true: '#F0B7AA' }}
                      value={currentParameter?.enabled === true}
                    />
                  </View>
                );
              })}
            </View>
            <View style={styles.parameterPanel}>
              <View style={styles.parameterHeading}>
                <Text style={styles.parameterTitle}>上下文与压缩</Text>
                <Text style={styles.parameterHint}>完整聊天仍会保留；达到任一阈值后，只向模型发送累计摘要和最近六轮。</Text>
              </View>
              <View style={styles.parameterRow}>
                <View style={styles.parameterCopy}>
                  <Text style={styles.parameterName}>上下文窗口</Text>
                  <Text style={styles.parameterApiName}>单位 K，默认 64K</Text>
                </View>
                <TextInput
                  keyboardType="numeric"
                  onChangeText={(value) => {
                    const parsed = Number(value.replace(/[^\d.]/g, ''));
                    if (!Number.isFinite(parsed)) return;
                    setDraft((current) => current ? { ...current, contextWindowTokens: Math.round(parsed * 1024) } : current);
                  }}
                  style={[styles.input, styles.parameterInput]}
                  value={`${Math.round((draft.contextWindowTokens ?? 65536) / 1024)}`}
                />
              </View>
              <View style={styles.parameterRow}>
                <View style={styles.parameterCopy}>
                  <Text style={styles.parameterName}>自动压缩</Text>
                  <Text style={styles.parameterApiName}>回复完成后在后台整理</Text>
                </View>
                <Switch
                  onValueChange={(value) => setDraft((current) => current ? { ...current, contextCompressionEnabled: value } : current)}
                  thumbColor={draft.contextCompressionEnabled !== false ? '#FFFFFF' : '#F8F5F2'}
                  trackColor={{ false: '#DFE5EA', true: '#F0B7AA' }}
                  value={draft.contextCompressionEnabled !== false}
                />
              </View>
              <View style={styles.parameterRow}>
                <View style={styles.parameterCopy}>
                  <Text style={styles.parameterName}>Token 触发阈值</Text>
                  <Text style={styles.parameterApiName}>可设置 30%–95%</Text>
                </View>
                <TextInput
                  keyboardType="numeric"
                  onChangeText={(value) => {
                    const parsed = Number(value.replace(/[^\d.]/g, ''));
                    if (!Number.isFinite(parsed)) return;
                    setDraft((current) => current ? { ...current, contextCompressionThreshold: parsed / 100 } : current);
                  }}
                  style={[styles.input, styles.parameterInput]}
                  value={`${Math.round((draft.contextCompressionThreshold ?? 0.7) * 100)}`}
                />
              </View>
              <View style={styles.parameterRow}>
                <View style={styles.parameterCopy}>
                  <Text style={styles.parameterName}>按消息数触发</Text>
                  <Text style={styles.parameterApiName}>与 Token 阈值满足任一项即可</Text>
                </View>
                <Switch
                  onValueChange={(value) => setDraft((current) => current ? { ...current, contextCompressionByMessageCount: value } : current)}
                  thumbColor={draft.contextCompressionByMessageCount !== false ? '#FFFFFF' : '#F8F5F2'}
                  trackColor={{ false: '#DFE5EA', true: '#F0B7AA' }}
                  value={draft.contextCompressionByMessageCount !== false}
                />
              </View>
              <View style={styles.parameterRow}>
                <View style={styles.parameterCopy}>
                  <Text style={styles.parameterName}>小仓鼠消息阈值</Text>
                  <Text style={styles.parameterApiName}>可设置 4–100 条</Text>
                </View>
                <TextInput
                  editable={draft.contextCompressionByMessageCount !== false}
                  keyboardType="numeric"
                  onChangeText={(value) => {
                    const parsed = Number(value.replace(/\D/g, ''));
                    if (!Number.isFinite(parsed)) return;
                    setDraft((current) => current ? { ...current, contextCompressionMessageThreshold: parsed } : current);
                  }}
                  style={[styles.input, styles.parameterInput]}
                  value={`${draft.contextCompressionMessageThreshold ?? 16}`}
                />
              </View>
            </View>
            </SettingsDisclosure>
            <View style={styles.editorActions}>
              {connections.some((item) => item.id === draft.id) ? (
                <Pressable
                  disabled={busy}
                  onPress={() => confirmRemoveConnection(draft)}
                  style={styles.deleteButton}
                >
                  <Text style={styles.deleteText}>删除</Text>
                </Pressable>
              ) : null}
              <Pressable disabled={busy} onPress={handleTest} style={styles.secondaryButton}>
                <Text style={styles.secondaryButtonText}>测试</Text>
              </Pressable>
              <Pressable disabled={busy} onPress={handleSaveConnection} style={styles.primaryButton}>
                <Text style={styles.primaryButtonText}>{busy ? '处理中...' : '保存'}</Text>
              </Pressable>
            </View>
          </View>
        ) : null}
        <SettingsDisclosure title="看图模型测试">
        <Text style={[styles.sectionTitle, styles.memoryTitle]}>看图模型测试</Text>
        <Text style={styles.sectionHint}>只测试图片理解模型，不把图片发进聊天气泡。</Text>
        <View style={styles.visionTestCard}>
          <Text style={styles.embeddingStatus}>
            当前看图模型：{visionConnection ? `${visionConnection.name} · ${visionConnection.model}` : '未选择'}
          </Text>
          <Pressable disabled={visionTestBusy} onPress={handleTestVisionModel} style={styles.primaryButton}>
            <Text style={styles.primaryButtonText}>{visionTestBusy ? '看图中...' : '选图测试'}</Text>
          </Pressable>
          {visionTestResult ? <CameraVisionStructuredResultView analysis={visionTestResult} /> : null}
        </View>

        </SettingsDisclosure>
        </>) : null}
        {section === 'ai-diagnostics' ? (<>
        <Pressable onPress={() => navigate('prompt-diagnostics')} style={styles.promptDiagnosticsEntry}>
          <View style={styles.memorySwitchCopy}>
            <Text style={styles.promptDiagnosticsTitle}>Prompt 与缓存</Text>
            <Text style={styles.promptDiagnosticsText}>查看各区块、输入 token、缓存命中和最近一次真实 System 请求。</Text>
          </View>
          <Text style={styles.promptDiagnosticsArrow}>›</Text>
        </Pressable>
        <View style={styles.behaviorRoutingCard}>
          <View style={styles.behaviorRoutingHeader}>
            <View style={styles.behaviorRoutingCopy}>
              <Text style={styles.behaviorRoutingTitle}>聊天答卷诊断</Text>
              <Text style={styles.behaviorRoutingText}>
                附属字段随聊天答卷返回；实际模型请求次数见每条记录。
              </Text>
            </View>
            <Text style={styles.behaviorRoutingBadge}>随聊天返回</Text>
          </View>

          {renderReadState(semanticRead, '答卷记录')}
          {semanticRead.state.loaded ? (<>
          <View style={styles.behaviorBudgetRow}>
            <View style={styles.behaviorBudgetMetric}>
              <Text style={styles.behaviorBudgetNumber}>{todayChatSemanticEntries.length}</Text>
              <Text style={styles.behaviorBudgetLabel}>今日轮数</Text>
            </View>
            <View style={styles.behaviorBudgetMetric}>
              <Text style={styles.behaviorBudgetNumber}>{hiddenSemanticTokens}</Text>
              <Text style={styles.behaviorBudgetLabel}>附加字段估算 token</Text>
            </View>
          </View>
          <Text style={styles.behaviorRoutingMeta}>
            合法 {chatSemanticCounts.valid} · 部分采用 {chatSemanticCounts.partial} · 未决 {chatSemanticCounts.unresolved} · 正文无效 {chatSemanticCounts.invalid}
          </Text>
          </>) : null}

          <Text style={styles.behaviorRoutingLabel}>历史坏卷（最近一次留存）</Text>
          <Text style={styles.behaviorReviewMeta}>
            下方是留存的历史记录，不代表本次聊天又失败了；后续回复成功也不会自动清除它。
          </Text>
          {renderReadState(badEnvelopeRead, '坏卷缓存')}
          {latestBadEnvelope ? (
            <View style={styles.behaviorReviewEntry}>
              <Pressable
                accessibilityRole="button"
                onPress={() => setBadEnvelopeExpanded((value) => !value)}
              >
                <View style={styles.behaviorReviewHeader}>
                  <Text style={styles.behaviorReviewTime}>
                    {new Date(latestBadEnvelope.capturedAt).toLocaleString('zh-CN', {
                      year: 'numeric',
                      month: '2-digit',
                      day: '2-digit',
                      hour: '2-digit',
                      minute: '2-digit',
                      hour12: false,
                    })}
                  </Text>
                  <Text style={styles.behaviorReviewOutcome}>
                    {badEnvelopeExpanded ? '收起' : '展开'}
                  </Text>
                </View>
                <Text style={styles.behaviorReviewReason}>
                  {latestBadEnvelope.failureSummary}
                </Text>
                <Text style={styles.behaviorReviewMeta}>
                  {latestBadEnvelope.proactiveSource
                    ? `主动联系 · ${latestBadEnvelope.proactiveSource.phase === 'failure_retry' ? '失败后补试'
                      : latestBadEnvelope.proactiveSource.phase === 'body_continuation' ? '正文接续' : '首次请求'}`
                    : latestBadEnvelope.retryOutcome === 'recovered'
                    ? '已被重试救回'
                    : latestBadEnvelope.retryOutcome === 'failed'
                      ? '重试后仍是坏卷'
                      : '本轮没有触发重试'}
                  {' · '}{latestBadEnvelope.connectionName} · {latestBadEnvelope.model}
                </Text>
              </Pressable>
              {badEnvelopeExpanded ? (
                <View style={styles.behaviorBadEnvelopeDetails}>
                  {latestBadEnvelope.proactiveSource ? (
                    <Text style={styles.behaviorReviewMeta}>
                      机会：{latestBadEnvelope.proactiveSource.opportunityId}
                      {'\n'}会话：{latestBadEnvelope.proactiveSource.sessionId}
                      {'\n'}本阵第 {latestBadEnvelope.proactiveSource.requestNumber} 次请求
                    </Text>
                  ) : <Text style={styles.behaviorReviewReason}>
                    四格：正文 {describeBadEnvelopeFieldStatus(latestBadEnvelope.basketStatuses.messages)}
                    {' · '}事项变化 {describeBadEnvelopeFieldStatus(latestBadEnvelope.basketStatuses.careUpdates)}
                    {' · '}分享 {describeBadEnvelopeFieldStatus(latestBadEnvelope.basketStatuses.shareResponses)}
                    {' · '}心声 {describeBadEnvelopeFieldStatus(latestBadEnvelope.basketStatuses.innerReaction)}
                  </Text>}
                  <Text style={styles.behaviorReviewMeta}>
                    {latestBadEnvelope.failureReasons.join('；')}
                  </Text>
                  <Text style={styles.behaviorReviewMeta}>
                    结束：{latestBadEnvelope.finishReason ?? '未提供'}
                    {' · '}已留存 direct {latestBadEnvelope.rawDirectContentChars} 字
                  </Text>
                  {latestBadEnvelope.semanticPrefixCompletionRequested ? (
                    <Text style={styles.behaviorReviewMeta}>
                      本轮使用前缀补全；下方原文不含君落预填的开头 {'{"messages":["'}。
                    </Text>
                  ) : null}
                  <Text selectable style={styles.behaviorBadEnvelopeRaw}>
                    {latestBadEnvelope.rawDirectContent || '（没有留存原始 direct，不能仅凭这条记录判断供应商是否返回了正文；未保存 reasoning。）'}
                  </Text>
                  <Pressable onPress={handleDeleteLatestBadEnvelope} style={styles.smallButton}>
                    <Text style={styles.smallButtonText}>删除坏卷</Text>
                  </Pressable>
                </View>
              ) : null}
            </View>
          ) : badEnvelopeRead.state.loaded ? (
            <Text style={styles.behaviorReviewEmpty}>目前没有坏卷证物。</Text>
          ) : null}

          <Text style={styles.behaviorRoutingLabel}>最近处理明细</Text>
          {visibleChatSemanticEntries.length ? (
            <View style={styles.behaviorReviewList}>
              {visibleChatSemanticEntries.map((entry) => (
                <ChatReplyDiagnosticCard key={entry.id} entry={entry}>
                  <View style={styles.behaviorReviewHeader}>
                    <Text style={styles.behaviorReviewTime}>
                      {new Date(entry.attemptedAt).toLocaleTimeString('zh-CN', {
                        hour: '2-digit',
                        minute: '2-digit',
                        hour12: false,
                      })}
                    </Text>
                    <Text style={styles.behaviorReviewOutcome}>
                      {!entry.basketStatuses
                        ? '旧记录'
                        : entry.status === 'valid'
                          ? '合法'
                          : entry.status === 'messages_invalid'
                            ? '正文无效'
                            : '部分字段不可用'}
                    </Text>
                  </View>
                  <Text style={styles.behaviorReviewMeta}>
                    {[entry.connectionName, entry.model].filter(Boolean).join(' · ')}
                  </Text>
                  {entry.reason ? (
                    <Text style={styles.behaviorReviewReason}>
                      原因：{describeSemanticReason(entry.reason)}
                    </Text>
                  ) : null}
                  {entry.basketStatuses ? (
                    <Text style={styles.behaviorReviewReason}>
                      messages：{describeBadEnvelopeFieldStatus(entry.basketStatuses.messages ?? 'unavailable')}
                      {entry.basketStatuses.wishDiscussion !== undefined ? <>
                        {' · '}wishDiscussion：{describeBadEnvelopeFieldStatus(entry.basketStatuses.wishDiscussion)}
                        {' · '}memoryMentions：{describeBadEnvelopeFieldStatus(entry.basketStatuses.memoryMentions ?? 'unavailable')}
                      </> : <>
                        {' · '}careUpdates：{describeBadEnvelopeFieldStatus(entry.basketStatuses.careUpdates ?? 'unavailable')}
                        {' · '}shareResponses：{describeBadEnvelopeFieldStatus(entry.basketStatuses.shareResponses ?? 'unavailable')}
                      </>}
                      {' · '}innerReaction：{describeBadEnvelopeFieldStatus(entry.basketStatuses.innerReaction ?? 'unavailable')}
                    </Text>
                  ) : (
                    <Text style={styles.behaviorReviewReason}>旧记录未保存四格诊断。</Text>
                  )}
                  {entry.shareResponseDiagnostic?.pendingCount ? (
                    <>
                      <Text style={styles.behaviorReviewReason}>
                        {[
                          `等待 ${entry.shareResponseDiagnostic.pendingCount}`,
                          `模型返回 ${entry.shareResponseDiagnostic.returnedCount}`,
                          `模型采用 ${entry.shareResponseDiagnostic.acceptedCount}`,
                          entry.shareResponseDiagnostic.localAcceptedCount !== undefined
                            ? `本地补上 ${entry.shareResponseDiagnostic.localAcceptedCount}`
                            : '',
                          entry.shareResponseDiagnostic.directReplyTargeted ? '已绑定引用目标' : '',
                        ].filter(Boolean).join(' · ')}
                      </Text>
                      {entry.shareResponseDiagnostic.rejectionCodes.length ? (
                        <Text style={styles.behaviorReviewReason}>
                          分享回应：{describeShareResponseRejections(
                            entry.shareResponseDiagnostic.rejectionCodes,
                          )}
                        </Text>
                      ) : null}
                      {entry.shareResponseDiagnostic.localMatchKind ? (
                        <Text style={styles.behaviorReviewReason}>
                          本地匹配：{describeLocalShareMatch(
                            entry.shareResponseDiagnostic.localMatchKind,
                          )}
                        </Text>
                      ) : entry.shareResponseDiagnostic.localSkippedReason ? (
                        <Text style={styles.behaviorReviewReason}>
                          本地未采用：{describeLocalShareSkip(
                            entry.shareResponseDiagnostic.localSkippedReason,
                          )}
                        </Text>
                      ) : null}
                    </>
                  ) : null}
                  <Text style={styles.behaviorReviewReason}>
                    {[
                      entry.jsonOutputRequested === undefined
                        ? '硬 JSON：旧记录未知'
                        : entry.jsonOutputRequested
                          ? '硬 JSON：旧记录曾发送'
                          : '硬 JSON：已退役',
                      `原始返回：${describeRawContentFormat(entry.rawContentFormat)}`,
                      entry.recoveredFromReasoning ? '同次响应抢救：成功' : '',
                      entry.finishReason ? `结束：${entry.finishReason}` : '',
                    ].filter(Boolean).join(' · ')}
                  </Text>
                  <Text style={styles.behaviorReviewReason}>
                    附加字段估算约 {entry.semanticOutputEstimatedTokens} token（不是账单）
                  </Text>
                  {entry.replyPersisted !== undefined ? (
                    <Text style={styles.behaviorReviewReason}>
                      {entry.deliveryKind === 'tool_card' ? '工具卡' : '正文'}：{entry.replyPersisted ? '已保存' : '未保存'}
                      {' · '}插入气泡数：{entry.insertedMessageCount ?? '未记录'}
                    </Text>
                  ) : null}
                </ChatReplyDiagnosticCard>
              ))}
            </View>
          ) : semanticRead.state.loaded ? (
            <Text style={styles.behaviorReviewEmpty}>还没有聊天答卷记录。</Text>
          ) : null}

          <Text style={styles.behaviorRoutingLabel}>最近回复失败</Text>
          {renderReadState(failureRead, '回复失败记录')}
          {visibleChatReplyFailureEntries.length ? (
            <View style={styles.behaviorReviewList}>
              {visibleChatReplyFailureEntries.map((entry) => (
                <ChatReplyDiagnosticCard key={entry.id} entry={entry} />
              ))}
            </View>
          ) : failureRead.state.loaded ? (
            <Text style={styles.behaviorReviewEmpty}>还没有回复失败记录。</Text>
          ) : null}
          {__DEV__ ? (
            <SettingsDisclosure title="开发测试">
              <Text style={styles.behaviorRoutingLabel}>5F.1 真机故障夹具</Text>
              <Text style={styles.behaviorRoutingText}>
                点击一种后回聊天发送任意消息。夹具只生效一轮，并在模型请求前触发，不消耗 API；下一轮自动恢复正常。
              </Text>
              <View style={styles.connectionActions}>
                <Pressable
                  onPress={() => void queueChatReplyFailureFixture(
                    CHAT_REPLY_FAILURE_CODE.modelVisibleTextMissing,
                  )}
                  style={styles.smallButton}
                >
                  <Text style={styles.smallButtonText}>模拟真空回</Text>
                </Pressable>
                <Pressable
                  onPress={() => void queueChatReplyFailureFixture(
                    CHAT_REPLY_FAILURE_CODE.visibleEnvelopeInvalid,
                  )}
                  style={styles.smallButton}
                >
                  <Text style={styles.smallButtonText}>模拟结构损坏</Text>
                </Pressable>
                <Pressable
                  onPress={() => void queueChatReplyFailureFixture(
                    CHAT_REPLY_FAILURE_CODE.sessionPersistFailed,
                  )}
                  style={styles.smallButton}
                >
                  <Text style={styles.smallButtonText}>模拟保存失败</Text>
                </Pressable>
                <Pressable
                  onPress={() => void queueChatReplyFailureFixture(null)}
                  style={styles.smallButton}
                >
                  <Text style={styles.smallButtonText}>取消待触发夹具</Text>
                </Pressable>
              </View>
            </SettingsDisclosure>
          ) : null}
        </View>

        {renderReadState(auxiliaryRead, '附属记录')}
        <SettingsDisclosure title="附属记录明细">
        <View style={styles.behaviorRoutingCard}>
          <View style={styles.behaviorRoutingHeader}>
            <View style={styles.behaviorRoutingCopy}>
              <Text style={styles.behaviorRoutingTitle}>聊天附属记录状态</Text>
              <Text style={styles.behaviorRoutingText}>
                这里只记录当次技术失败及当次重试结果，不代表目前仍有故障；不保存聊天正文或册子内容。
              </Text>
            </View>
            <Text style={styles.behaviorRoutingBadge}>历史记录</Text>
          </View>
          <Text style={styles.behaviorRoutingLabel}>最近处理明细</Text>
          {visibleChatAuxiliaryEntries.length ? (
            <View style={styles.behaviorReviewList}>
              {visibleChatAuxiliaryEntries.map((entry) => (
                <View key={entry.id} style={styles.behaviorReviewEntry}>
                  <View style={styles.behaviorReviewHeader}>
                    <Text style={styles.behaviorReviewTime}>
                      {new Date(entry.attemptedAt).toLocaleString('zh-CN', {
                        year: 'numeric',
                        month: '2-digit',
                        day: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                        hour12: false,
                      })}
                    </Text>
                    <Text style={styles.behaviorReviewOutcome}>
                      {getChatAuxiliaryOutcomeLabel(entry)}
                    </Text>
                  </View>
                  <Text style={styles.behaviorReviewMeta}>
                    {CHAT_AUXILIARY_STAGE_LABELS[entry.stage]} · {CHAT_AUXILIARY_PHASE_LABELS[entry.phase]}
                  </Text>
                  <Text style={styles.behaviorReviewMeta}>
                    {getChatAuxiliaryStepLabel(entry.step)}
                  </Text>
                  <Text style={styles.behaviorReviewReason}>
                    {describeChatAuxiliaryFailure(entry)}
                    {entry.retryAttempted ? ' · 已尝试本地重试（不增加模型请求）' : ''}
                    {` · ${entry.durationMs} ms`}
                  </Text>
                </View>
              ))}
            </View>
          ) : auxiliaryRead.state.loaded ? (
            <Text style={styles.behaviorReviewEmpty}>最近没有附属记录故障。</Text>
          ) : null}
        </View>

        </SettingsDisclosure>
        <SettingsDisclosure title="维护操作">
        <Text style={[styles.sectionTitle, styles.memoryTitle]}>内在状态维护</Text>
        <View style={styles.innerStateMaintenanceCard}>
          <Text style={styles.innerStateMaintenanceText}>
            这里没有可以拖动的愿望或关系滑块。撤销只针对最近一条精确关系选择证据，不会替云云改写其它感受。
          </Text>
          <Pressable
            disabled={busy}
            onPress={handleRetractLatestInnerState}
            style={[styles.innerStateMaintenanceButton, busy && styles.autonomyTestButtonDisabled]}
          >
            <Text style={styles.innerStateMaintenanceButtonText}>撤销最近一次状态整理</Text>
          </Pressable>
          {__DEV__ ? (
            <Pressable
              disabled={busy}
              onPress={handleResetInnerState}
              style={[styles.innerStateResetButton, busy && styles.autonomyTestButtonDisabled]}
            >
              <Text style={styles.innerStateResetText}>重置内在状态</Text>
            </Pressable>
          ) : null}
        </View>

          <Text style={styles.autonomyTestHint}>
            当前搜索来源：{webSearchProviderStatus.label}。{webSearchProviderStatus.detail}
          </Text>
          <Text style={styles.autonomyTestHint}>
            浏览器公开远游只在电脑后端显式开启 `JUNLUO_ENABLE_PLAYWRIGHT_RESEARCH=1` 时作为读取兜底使用；不会登录账号、点击页面或打开外部社交 App。
          </Text>
          <Text style={styles.autonomyTestHint}>
            固定频率：公开探索（网页／GitHub）每天合计最多 3 次、至少间隔 2 小时、连续失败 3 次当天停止；君落草稿箱表达成功后冷却 6 小时、失败后冷却 1 小时。
          </Text>
        </SettingsDisclosure>
        </>) : null}
        {section === 'phone-manager' ? (<>
        <Text style={[styles.sectionTitle, styles.memoryTitle]}>本机小管家</Text>
        <View style={styles.phoneActivityCard}>
            <Text style={styles.backendStatusTitle}>手机读取权限</Text>
            <Text style={styles.backendStatusText}>默认只把最近活动整理成摘要给白云小姐，不直接塞原始通知全文。</Text>
            {phoneActivityStatusLoading ? <Text style={styles.backendStatusText}>正在读取手机权限…</Text> : null}
            {phoneActivityStatusError ? (
              <View>
                <Text style={styles.backendStatusText}>{phoneActivityStatusError}</Text>
                <Pressable accessibilityRole="button" onPress={() => void refreshPhoneActivityStatus()} style={styles.phoneActionButton}>
                  <Text style={styles.phoneActionText}>重新读取权限</Text>
                </Pressable>
              </View>
            ) : null}
            {!phoneActivityStatusLoading && !phoneActivityStatusError ? (<View style={styles.permissionGrid}>
              <PermissionPill available={phoneActivityStatusAvailable} enabled={phoneActivityStatus.usageAccess} label="前台 App" />
              <PermissionPill enabled={notificationPostingAllowed} label="君落提醒" />
              <PermissionPill available={phoneActivityStatusAvailable} enabled={phoneActivityStatus.notificationListener} label="通知读取" />
              <PermissionPill available={phoneActivityStatusAvailable} enabled={phoneActivityStatus.accessibility} label="窗口摘要" />
              <PermissionPill available={phoneActivityStatusAvailable} enabled={phoneActivityStatus.overlay} label="悬浮遮挡" />
              <PermissionPill available={phoneActivityStatusAvailable} enabled={phoneActivityStatus.collectorRunning} label="小管家运行" />
            </View>) : null}
            {!phoneActivityStatusLoading && !phoneActivityStatusError && phoneActivityStatusAvailable && !phoneActivityStatus.accessibility ? (
              <Text style={styles.backendStatusText}>要使用窗口摘要，需要先点“窗口权限”，在系统无障碍里开启“君落窗口小管家”。</Text>
            ) : null}
            {!phoneActivityStatusLoading && !phoneActivityStatusError && phoneActivityStatus.pausedUntil > Date.now() ? (
              <Text style={styles.backendStatusText}>
                隐私暂停到 {new Date(phoneActivityStatus.pausedUntil).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}
              </Text>
            ) : null}
            <View style={styles.phoneActionRow}>
              <Pressable disabled={busy} onPress={openPhoneUsageAccessSettings} style={styles.phoneActionButton}>
                <Text style={styles.phoneActionText}>前台权限</Text>
              </Pressable>
              <Pressable disabled={busy} onPress={() => void handleRequestNotificationPosting()} style={styles.phoneActionButton}>
                <Text style={styles.phoneActionText}>提醒权限</Text>
              </Pressable>
              <Pressable disabled={busy} onPress={openPhoneNotificationListenerSettings} style={styles.phoneActionButton}>
                <Text style={styles.phoneActionText}>通知读取</Text>
              </Pressable>
              <Pressable disabled={busy} onPress={openPhoneAccessibilitySettings} style={styles.phoneActionButton}>
                <Text style={styles.phoneActionText}>窗口权限</Text>
              </Pressable>
              <Pressable disabled={busy} onPress={openPhoneOverlaySettings} style={styles.phoneActionButton}>
                <Text style={styles.phoneActionText}>悬浮权限</Text>
              </Pressable>
            </View>
            <View style={styles.phoneActionRow}>
              <Pressable disabled={busy} onPress={handleStartPhoneActivity} style={styles.phoneStartButton}>
                <Text style={styles.phoneStartText}>启动小管家</Text>
              </Pressable>
              <Pressable disabled={busy} onPress={handleStopPhoneActivity} style={styles.phoneActionButton}>
                <Text style={styles.phoneActionText}>停止</Text>
              </Pressable>
              <Pressable disabled={busy || phoneActivityStatusLoading} onPress={() => void refreshPhoneActivityStatus()} style={styles.phoneActionButton}>
                <Text style={styles.phoneActionText}>刷新</Text>
              </Pressable>
            </View>
            <View style={styles.phoneActionRow}>
              <Pressable disabled={busy} onPress={() => void handlePausePhoneActivity(15)} style={styles.privacyButton}>
                <Text style={styles.privacyText}>暂停15分钟</Text>
              </Pressable>
              <Pressable disabled={busy} onPress={() => void handlePausePhoneActivity(60)} style={styles.privacyButton}>
                <Text style={styles.privacyText}>暂停1小时</Text>
              </Pressable>
            </View>
            <View style={styles.phoneActionRow}>
              <Pressable disabled={busy} onPress={handleLoadPhoneActivityLogs} style={styles.phoneLogButton}>
                <Text style={styles.phoneLogButtonText}>查看最近日志</Text>
              </Pressable>
              <Pressable disabled={busy} onPress={() => void handleOpenPhoneFeature()} style={styles.phoneActionButton}>
                <Text style={styles.phoneActionText}>交出手机</Text>
              </Pressable>
              {phoneActivityLogsVisible ? (
                <Pressable disabled={busy} onPress={() => setPhoneActivityLogsVisible(false)} style={styles.phoneActionButton}>
                  <Text style={styles.phoneActionText}>收起日志</Text>
                </Pressable>
              ) : null}
            </View>
            <View style={styles.phoneActionRow}>
              <Pressable disabled={busy} onPress={() => void handleTestPhoneOverlay()} style={styles.phoneActionButton}>
                <Text style={styles.phoneActionText}>测试遮挡</Text>
              </Pressable>
              <Pressable disabled={busy} onPress={() => void handleLoadPhoneFocusDebugStatus()} style={styles.phoneActionButton}>
                <Text style={styles.phoneActionText}>识别状态</Text>
              </Pressable>
            </View>
            {phoneFocusDebugStatus ? <Text style={styles.phoneFocusDebugText}>{phoneFocusDebugStatus}</Text> : null}
            {phoneActivityLogsVisible ? (
              <View style={styles.phoneLogList}>
                {phoneActivityLogs.filter(isVisiblePhoneLog).length ? (
                  phoneActivityLogs.filter(isVisiblePhoneLog).map((log) => (
                    <View key={log.id} style={styles.phoneLogItem}>
                      <Text style={styles.phoneLogMeta}>
                        {formatPhoneActivityTime(log.created_at)} · {formatPhoneActivityKind(log.kind)} · {log.sensitive_level === 'filtered' ? '已过滤' : '摘要'}
                      </Text>
                      <Text style={styles.phoneLogTitle} numberOfLines={1}>
                        {getPhoneActivityTitle(log)}
                      </Text>
                      {getPhoneActivitySource(log) ? (
                        <Text style={styles.phoneLogSource} numberOfLines={1}>
                          {getPhoneActivitySource(log)}
                        </Text>
                      ) : null}
                      <Text style={styles.phoneLogSummary} numberOfLines={3}>
                        {log.summary?.trim() || '这条日志没有可展示的摘要。'}
                      </Text>
                      {log.kind === 'foreground_app' || log.kind === 'foreground_app_duration' ? (
                        <View style={styles.phoneLogRuleRow}>
                          <Pressable
                            disabled={hasPhoneActivityRule('blacklist', log)}
                            onPress={() => addPhoneActivityRule('blacklist', log)}
                            style={[styles.phoneBlacklistButton, hasPhoneActivityRule('blacklist', log) && styles.phoneRuleButtonDisabled]}
                          >
                            <Text style={styles.phoneBlacklistText}>{hasPhoneActivityRule('blacklist', log) ? '已黑名单' : '黑名单'}</Text>
                          </Pressable>
                          <Pressable
                            disabled={hasPhoneActivityRule('whitelist', log)}
                            onPress={() => addPhoneActivityRule('whitelist', log)}
                            style={[styles.phoneWhitelistButton, hasPhoneActivityRule('whitelist', log) && styles.phoneRuleButtonDisabled]}
                          >
                            <Text style={styles.phoneWhitelistText}>{hasPhoneActivityRule('whitelist', log) ? '已白名单' : '白名单'}</Text>
                          </Pressable>
                          <Pressable
                            disabled={hasPhoneActivityRule('jealousy', log)}
                            onPress={() => addPhoneActivityRule('jealousy', log)}
                            style={[styles.phoneJealousyButton, hasPhoneActivityRule('jealousy', log) && styles.phoneRuleButtonDisabled]}
                          >
                            <Text style={styles.phoneJealousyText}>{hasPhoneActivityRule('jealousy', log) ? '已会吃醋' : '会吃醋'}</Text>
                          </Pressable>
                        </View>
                      ) : null}
                    </View>
                  ))
                ) : (
                  <Text style={styles.phoneLogEmpty}>还没有最近日志。小管家启动后，切换 App 或收到通知再刷新看看。</Text>
                )}
              </View>
            ) : null}
          </View>

        </>) : null}
        {section === 'memory-settings' ? (<>
        <Text style={[styles.sectionTitle, styles.memoryTitle]}>语义记忆</Text>
        <View style={styles.semanticCard}>
          <View style={styles.semanticSwitch}>
            <View style={styles.memorySwitchCopy}>
              <Text style={styles.memorySwitchTitle}>启用向量检索</Text>
              <Text style={styles.memorySwitchText}>聊天和记忆页会同时使用语义相似度与文字匹配；连接失败时会自动回落。</Text>
            </View>
            <Switch
              onValueChange={(enabled) => setEmbeddingSettings((current) => ({ ...current, enabled }))}
              thumbColor={embeddingSettings.enabled ? '#FFFFFF' : '#F8F5F2'}
              trackColor={{ false: '#DFE5EA', true: '#A9D3FA' }}
              value={embeddingSettings.enabled}
            />
          </View>
          <Field label="Embedding Base URL">
            <TextInput
              autoCapitalize="none"
              autoCorrect={false}
              onChangeText={(baseUrl) => setEmbeddingSettings((current) => ({ ...current, baseUrl }))}
              placeholder="https://generativelanguage.googleapis.com/v1beta/openai"
              placeholderTextColor={colors.muted}
              style={styles.input}
              value={embeddingSettings.baseUrl}
            />
          </Field>
          <Field label="Embedding API Key">
            <View style={styles.keyRow}>
              <TextInput
                autoCapitalize="none"
                autoCorrect={false}
                onChangeText={setEmbeddingKey}
                placeholder="sk-..."
                placeholderTextColor={colors.muted}
                secureTextEntry={!showEmbeddingKey}
                style={[styles.input, styles.keyInput]}
                value={embeddingKey}
              />
              <Pressable onPress={() => setShowEmbeddingKey((current) => !current)} style={styles.revealButton}>
                <Text style={styles.revealText}>{showEmbeddingKey ? '隐藏' : '显示'}</Text>
              </Pressable>
            </View>
          </Field>
          <Field label="Embedding 模型名称">
            <TextInput
              autoCapitalize="none"
              autoCorrect={false}
              onChangeText={(model) => setEmbeddingSettings((current) => ({ ...current, model }))}
              placeholder="gemini-embedding-001"
              placeholderTextColor={colors.muted}
              style={styles.input}
              value={embeddingSettings.model}
            />
          </Field>
          {renderReadState(missingRead, '索引统计')}
          {missingRead.state.loaded ? <Text style={styles.embeddingStatus}>当前还有 {missingEmbeddings} 条记忆缺少语义索引。</Text> : null}
          {renderReadState(retrievalRead, '检索诊断')}
          {retrievalRead.state.loaded && memoryDiagnostics ? <Text style={styles.embeddingStatus}>
            全文检索 {memoryDiagnostics.ftsAvailable ? '可用' : '已降级'}
            {' · '}向量覆盖 {memoryDiagnostics.vectorIndexedCount}/{memoryDiagnostics.memoryCount}
            {' · '}候选池 {memoryDiagnostics.candidatePoolSize} 条
          </Text> : null}
          <View style={styles.editorActions}>
            <Pressable disabled={busy} onPress={handleTestEmbedding} style={styles.secondaryButton}>
              <Text style={styles.secondaryButtonText}>测试向量连接</Text>
            </Pressable>
            <Pressable disabled={busy} onPress={handleBackfillEmbeddings} style={styles.secondaryButton}>
              <Text style={styles.secondaryButtonText}>补齐语义索引</Text>
            </Pressable>
            <Pressable disabled={busy} onPress={handleSaveEmbeddingSettings} style={styles.primaryButton}>
              <Text style={styles.primaryButtonText}>保存语义设置</Text>
            </Pressable>
          </View>
        </View>

        <Text style={[styles.sectionTitle, styles.memoryTitle]}>记忆重排</Text>
        <View style={styles.rerankerCard}>
          <View style={styles.semanticSwitch}>
            <View style={styles.memorySwitchCopy}>
              <Text style={styles.memorySwitchTitle}>启用 LLM 记忆重排</Text>
              <Text style={styles.memorySwitchText}>本地召回先筛候选，再让重排连接挑出更贴近本轮语境的 4-8 条；默认条件触发。</Text>
            </View>
            <Switch
              onValueChange={(enabled) => setRerankerSettings((current) => ({ ...current, enabled }))}
              thumbColor={rerankerSettings.enabled ? '#FFFFFF' : '#F8F5F2'}
              trackColor={{ false: '#D8E3EC', true: '#8FC8A8' }}
              value={rerankerSettings.enabled}
            />
          </View>
          <Text style={styles.embeddingStatus}>
            当前连接：{memoryRerankerConnection ? `${memoryRerankerConnection.name} · ${memoryRerankerConnection.model}` : '未选择'}
            {' · '}状态：{rerankerStatus.detail}
          </Text>
          <View style={styles.previewRow}>
            {([
              ['conditional', '条件触发'],
              ['always', '总是触发'],
              ['manual', '手动实验'],
            ] as const).map(([mode, label]) => (
              <Pressable
                key={mode}
                onPress={() => setRerankerSettings((current) => ({ ...current, mode }))}
                style={[styles.previewChip, rerankerSettings.mode === mode && styles.previewChipSelected]}
              >
                <Text style={rerankerSettings.mode === mode ? styles.previewChipSelectedText : styles.previewChipText}>
                  {label}
                </Text>
              </Pressable>
            ))}
          </View>
          <Text style={styles.embeddingStatus}>
            候选超过 8 条时才会条件触发；每次最多提交 {rerankerSettings.candidateLimit} 条候选，超时 {rerankerSettings.timeoutMs}ms 自动回退。
          </Text>
          <View style={styles.editorActions}>
            <Pressable disabled={busy} onPress={handleTestReranker} style={styles.secondaryButton}>
              <Text style={styles.secondaryButtonText}>测试重排连接</Text>
            </Pressable>
            <Pressable disabled={busy} onPress={handleSaveRerankerSettings} style={styles.primaryButton}>
              <Text style={styles.primaryButtonText}>保存重排设置</Text>
            </Pressable>
          </View>
        </View>

        <Text style={[styles.sectionTitle, styles.memoryTitle]}>主动记忆</Text>
        <View style={styles.memorySwitchCard}>
          <View style={styles.memorySwitchCopy}>
            <Text style={styles.memorySwitchTitle}>允许白云小姐提议记忆</Text>
            <Text style={styles.memorySwitchText}>积累一小段新对话后，会调用整理模型审视这段故事；有值得留下的事时，她才提出待确认卡片。</Text>
          </View>
          <Switch
            onValueChange={(value) => {
              const next = { ...persona, proactiveMemorySuggestions: value };
              setPersona(next);
              void saveProfile(next);
            }}
            thumbColor={persona.proactiveMemorySuggestions ? '#FFFFFF' : '#F8F5F2'}
            trackColor={{ false: '#DFE5EA', true: '#A9D3FA' }}
            value={persona.proactiveMemorySuggestions}
          />
        </View>
        <View style={styles.memorySwitchCard}>
          <View style={styles.memorySwitchCopy}>
            <Text style={styles.memorySwitchTitle}>自动记下明确事实</Text>
            <Text style={styles.memorySwitchText}>例如身体情况、明确偏好或相处边界。会调用整理模型判断，并直接保存进本机记忆本。</Text>
          </View>
          <Switch
            onValueChange={(value) => {
              const next = { ...persona, automaticExplicitFactMemories: value };
              setPersona(next);
              void saveProfile(next);
            }}
            thumbColor={persona.automaticExplicitFactMemories ? '#FFFFFF' : '#F8F5F2'}
            trackColor={{ false: '#DFE5EA', true: '#A9D3FA' }}
            value={persona.automaticExplicitFactMemories}
          />
        </View>

        </>) : null}
        {section === 'proactive-settings' ? (<>
        <Text style={[styles.sectionTitle, styles.memoryTitle]}>后台模型花费</Text>
        <View style={styles.memorySwitchCard}>
          <View style={styles.memorySwitchCopy}>
            <Text style={styles.memorySwitchTitle}>后台自动调用模型</Text>
            <Text style={styles.memorySwitchText}>
              开启后，君落会在没有正在进行的聊天或手动操作时，使用已配置的模型生成生活状态、日记、梦、爱意总结、信件、主动消息与远游内容。聊天后的余韵和记忆整理仍属于聊天链路。每台设备分别控制。
            </Text>
          </View>
          <Switch
            disabled={automaticPolicySaving}
            onValueChange={updateAutomaticRemoteAiPolicy}
            thumbColor={automaticRemoteAiPolicy.enabled ? '#FFFFFF' : '#F8F5F2'}
            trackColor={{ false: '#DFE5EA', true: '#A9D3FA' }}
            value={automaticRemoteAiPolicy.enabled}
          />
        </View>

        <AutomaticCostSavingSettingsCard value={automaticRemoteAiPolicy.costSaving} saving={automaticPolicySaving}
          onSave={costSaving => persistAutomaticRemoteAiPolicy({ ...automaticRemoteAiPolicy, costSaving })} />

        <Text style={[styles.sectionTitle, styles.memoryTitle]}>主动探头</Text>
        <View style={styles.memorySwitchCard}>
          <View style={styles.memorySwitchCopy}>
            <Text style={styles.memorySwitchTitle}>允许白云小姐主动说话</Text>
            <Text style={styles.memorySwitchText}>白天安静一会儿后，我会偶尔前来看看小仓鼠。不会在深夜打扰。</Text>
          </View>
          <Switch
            onValueChange={(value) => {
              if (value) void requestNotificationPermission();
              updateProactiveSettings({
                ...(proactiveSettings ?? { enabled: false, firstPromptAnswered: true, notificationPreview: 'private' }),
                enabled: value,
                firstPromptAnswered: true,
              });
            }}
            thumbColor={proactiveSettings?.enabled ? '#FFFFFF' : '#F8F5F2'}
            trackColor={{ false: '#DFE5EA', true: '#A9D3FA' }}
            value={proactiveSettings?.enabled === true}
          />
        </View>
        <View style={styles.previewRow}>
          {(['private', 'full'] as const).map((mode) => (
            <Pressable
              key={mode}
              onPress={() =>
                updateProactiveSettings({
                  ...(proactiveSettings ?? { enabled: false, firstPromptAnswered: true, notificationPreview: 'private' }),
                  notificationPreview: mode,
                })
              }
              style={[styles.previewChip, proactiveSettings?.notificationPreview === mode && styles.previewChipSelected]}
            >
              <Text style={proactiveSettings?.notificationPreview === mode ? styles.previewChipSelectedText : styles.previewChipText}>
                {mode === 'private' ? '通知藏起来' : '通知显示内容'}
              </Text>
            </Pressable>
          ))}
        </View>

        <Text style={[styles.sectionTitle, styles.memoryTitle]}>白云自主行动</Text>
        <Text style={styles.sectionHint}>这里保留仍在使用的自主行动开关；账号浏览类能力不再显示，也不会从这里触发。</Text>
        <View style={styles.autonomyPanel}>
          {([
            ['masterEnabled', '总开关', '控制白云小姐自主行动的总入口。'],
            ['dailyPlanningEnabled', '白云自己的日程', '睡前安排起床后的生活；错过时在正式起床后补排。关闭只停止新增排程，已保存的安排继续执行。'],
            ['webVoyageEnabled', '公开探索（网页／GitHub）', '允许她自己选择公开网页或 GitHub 项目，搜索并读取一份内容；每天合计最多三次，不评论、不改文件、不运行代码。'],
            ['publicPostingEnabled', '君落草稿箱表达', '只允许她在君落内部写本地草稿；不发布、不评论、不碰外部账号。'],
            ['realtimeRhythmEnabled', '实时连续作息', '允许她根据困意、醒意和睡眠债连续调整状态。'],
            ['dreamSleepLoopEnabled', '梦境睡眠联动', '允许梦从真实睡眠、当前状态、记忆和愿望中长出来。'],
            ['desireDrivenBehaviorEnabled', '愿望推动生活', '允许云云此刻较明显的愿望进入主动消息和生活行动。'],
          ] as Array<[keyof AutonomySettings, string, string]>).map(([key, title, text]) => (
            <View key={key} style={styles.autonomySwitchRow}>
              <View style={styles.memorySwitchCopy}>
                <Text style={styles.memorySwitchTitle}>{title}</Text>
                <Text style={styles.memorySwitchText}>{text}</Text>
              </View>
              <Switch
                disabled={busy}
                onValueChange={(value) => key === 'webVoyageEnabled' ? void updatePublicExploration(value) : key === 'dailyPlanningEnabled'
                  ? void setDailyPlanningEnabled(value).then(async settings => {
                    setAutonomySettings(settings);
                    await (await import('../life/sleepPlanRuntime')).reconcileSleepPlanLocally().catch(() => undefined);
                  })
                  : updateAutonomySettings({ [key]: value } as Partial<AutonomySettings>)}
                thumbColor={(key === 'webVoyageEnabled' ? autonomySettings.webVoyageEnabled && autonomySettings.githubVoyageEnabled : autonomySettings[key]) ? '#FFFFFF' : '#F8F5F2'}
                trackColor={{ false: '#DFE5EA', true: '#B8DDBE' }}
                value={key === 'webVoyageEnabled' ? autonomySettings.webVoyageEnabled && autonomySettings.githubVoyageEnabled : autonomySettings[key] === true}
              />
            </View>
          ))}
        </View>
        </>) : null}
        {section === 'relationship-settings' ? (<>
        <Text style={[styles.sectionTitle, styles.memoryTitle]}>相处设定</Text>
        <View style={styles.builtInNotice}>
          <Text style={styles.builtInTitle}>角色设定</Text>
          <Text style={styles.builtInText}>填写角色核心设定后，将使用这份核心设定；留空时沿用内置设定。下方可继续补充相处方式和个人偏好。</Text>
        </View>
        <Field label="角色核心设定">
          <TextInput
            multiline
            onChangeText={(value) => setPersona((current) => ({ ...current, corePersona: value }))}
            placeholder="写下角色的身份、性格和背景"
            placeholderTextColor={colors.muted}
            style={[styles.input, styles.multilineInput]}
            textAlignVertical="top"
            value={persona.corePersona ?? ''}
          />
        </Field>
        <Field label="相处补充设定">
          <TextInput
            multiline
            onChangeText={(value) => setPersona((current) => ({ ...current, systemPrompt: value }))}
            placeholder="补充相处方式和细节"
            placeholderTextColor={colors.muted}
            style={[styles.input, styles.multilineInput]}
            textAlignVertical="top"
            value={persona.systemPrompt}
          />
        </Field>
        <Field label="关于我">
          <TextInput
            multiline
            onChangeText={(value) => setPersona((current) => ({ ...current, userNote: value }))}
            placeholder="写下希望对方了解的偏好"
            placeholderTextColor={colors.muted}
            style={[styles.input, styles.multilineInput]}
            textAlignVertical="top"
            value={persona.userNote}
          />
        </Field>
        <Pressable disabled={busy} onPress={handleSavePersona} style={styles.personaSave}>
          <Text style={styles.primaryButtonText}>保存相处设定</Text>
        </Pressable>

        <Text style={styles.sectionTitle}>白云图片表情包抽屉</Text>
        <View style={styles.expressionCard}>
          <Text style={styles.expressionHint}>
            按情绪收纳图片表情包。聊天时白云小姐可以输出本地表情包指令，应用会从对应抽屉随机挑一张发送，不会把图片交给看图模型。
          </Text>
          <View style={styles.expressionMoodGrid}>
            {EXPRESSION_MOOD_ORDER.map((id) => {
              const count = getStickersForMood(stickerLibrary, id).length;
              const selected = selectedStickerMood === id;
              return (
                <Pressable
                  key={id}
                  onPress={() => setSelectedStickerMood(id)}
                  style={[styles.expressionMoodChip, selected && styles.expressionMoodChipSelected]}
                >
                  <Text style={selected ? styles.expressionMoodChipSelectedText : styles.expressionMoodChipText}>
                    {EXPRESSION_MOOD_LABELS[id]}{count ? ` ${count}` : ''}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <View style={styles.stickerToolbar}>
            <View>
              <Text style={styles.stickerToolbarTitle}>{EXPRESSION_MOOD_LABELS[selectedStickerMood]}抽屉</Text>
              <Text style={styles.expressionUpdated}>
                共 {totalStickerCount} 张 · 最近更新：{formatExpressionUpdatedAt(stickerLibrary.updatedAt)}
              </Text>
            </View>
            <Pressable disabled={stickerAdding} onPress={handleAddSticker} style={styles.expressionSaveButton}>
              <Text style={styles.primaryButtonText}>{stickerAdding ? '添加中...' : '从相册添加'}</Text>
            </Pressable>
          </View>
          {selectedStickers.length ? (
            <View style={styles.stickerGrid}>
              {selectedStickers.map((sticker) => (
                <View key={sticker.id} style={styles.stickerTile}>
                  <Image resizeMode="cover" source={{ uri: sticker.uri }} style={styles.stickerThumb} />
                  <View style={styles.stickerTileFooter}>
                    <Text numberOfLines={1} style={styles.stickerName}>{sticker.name}</Text>
                    <Pressable accessibilityLabel="删除表情包" onPress={() => handleDeleteSticker(sticker.id)} style={styles.stickerDeleteButton}>
                      <Text style={styles.stickerDeleteText}>删</Text>
                    </Pressable>
                  </View>
                </View>
              ))}
            </View>
          ) : (
            <Text style={styles.stickerEmpty}>这个抽屉还空着。先放几张图，白云小姐才有得挑。</Text>
          )}
        </View>
        </>) : null}
      </ScrollView>
      )}
    </View>
  );
}

function SettingsDisclosure({ children, title }: { children: React.ReactNode; title: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <View style={styles.disclosure}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded }}
        onPress={() => setExpanded(value => !value)} style={styles.disclosureHeading}>
        <Text style={styles.disclosureTitle}>{title}</Text>
        <Text style={styles.disclosureAction}>{expanded ? '收起 −' : '展开 ＋'}</Text>
      </Pressable>
      {expanded ? <View style={styles.disclosureBody}>{children}</View> : null}
    </View>
  );
}

function Field({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      {children}
    </View>
  );
}

function PermissionPill({ available = true, enabled, label }: { available?: boolean; enabled: boolean; label: string }) {
  return (
    <View style={[styles.permissionPill, available && enabled && styles.permissionPillEnabled]}>
      <Text style={available && enabled ? styles.permissionPillEnabledText : styles.permissionPillText}>
        {label} · {available ? (enabled ? '已开' : '未开') : '检测失败'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, paddingTop: 8, paddingHorizontal: 18, backgroundColor: '#FFF9F4' },
  header: { minHeight: 52, gap: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 },
  backButton: { width: 44, height: 44, flexShrink: 0, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.cardStrong },
  backText: { color: colors.ink, fontWeight: '700' },
  title: { flex: 1, textAlign: 'center', color: colors.ink, fontSize: 22, fontWeight: '700' },
  content: { paddingBottom: 40 },
  pageDescription: { color: '#88756D', fontSize: 14, lineHeight: 21, marginBottom: 20 },
  loadingCard: { padding: 20, borderRadius: 18, backgroundColor: '#FFFFFF' },
  disclosure: { borderWidth: 1, borderColor: '#E8DED5', borderRadius: 18, backgroundColor: '#FFFDFA', marginVertical: 10, overflow: 'hidden' },
  disclosureHeading: { minHeight: 52, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 10 },
  disclosureTitle: { flex: 1, color: colors.ink, fontSize: 16, fontWeight: '700' },
  disclosureAction: { color: '#88756D', fontSize: 13 },
  disclosureBody: { paddingHorizontal: 12, paddingBottom: 12 },
  sectionTitle: { color: colors.ink, fontSize: 18, fontWeight: '700', marginBottom: 5 },
  sectionHint: { color: colors.muted, fontSize: 12, lineHeight: 18, marginBottom: 12 },
  presetRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginBottom: 14 },
  presetButton: { paddingHorizontal: 11, height: 34, borderRadius: 17, justifyContent: 'center', backgroundColor: '#FFE5DD' },
  presetText: { color: '#BE6B5E', fontSize: 12, fontWeight: '700' },
  connectionCard: { borderRadius: 16, borderWidth: 1, borderColor: '#FFE2DA', backgroundColor: '#FFFFFF', padding: 12, marginBottom: 9 },
  connectionCardSelected: { borderColor: '#F5A796', backgroundColor: '#FFF7F4' },
  connectionHeading: { minHeight: 40, paddingRight: 40, gap: 7, marginBottom: 9 },
  connectionDeleteButton: { position: 'absolute', top: 4, right: 4, width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 22 },
  connectionDeleteText: { color: '#B77970', fontSize: 24, lineHeight: 28 },
  connectionName: { color: colors.ink, fontSize: 15, fontWeight: '700', marginBottom: 3 },
  connectionModel: { color: colors.muted, fontSize: 12 },
  usageBadges: { flexDirection: 'row', flexWrap: 'wrap', gap: 5 },
  usageBadge: { color: '#C25F50', backgroundColor: '#FFE5DD', paddingHorizontal: 7, paddingVertical: 4, borderRadius: 10, fontSize: 11 },
  usageBadgeBlue: { color: '#5486AF', backgroundColor: '#E7F2FF', paddingHorizontal: 7, paddingVertical: 4, borderRadius: 10, fontSize: 11 },
  usageBadgeGreen: { color: '#4C8765', backgroundColor: '#E3F6EA', paddingHorizontal: 7, paddingVertical: 4, borderRadius: 10, fontSize: 11 },
  usageBadgePurple: { color: '#7057A8', backgroundColor: '#EEE8FF', paddingHorizontal: 7, paddingVertical: 4, borderRadius: 10, fontSize: 11 },
  usageBadgeTeal: { color: '#347A7A', backgroundColor: '#DFF7F4', paddingHorizontal: 7, paddingVertical: 4, borderRadius: 10, fontSize: 11 },
  usageBadgePink: { color: '#B45C7A', backgroundColor: '#FFE4EE', paddingHorizontal: 7, paddingVertical: 4, borderRadius: 10, fontSize: 11 },
  usageBadgeRed: { color: '#A84A42', backgroundColor: '#FFE7E1', paddingHorizontal: 7, paddingVertical: 4, borderRadius: 10, fontSize: 11 },
  usageBadgeLavender: { color: '#67558F', backgroundColor: '#EEE9F8', paddingHorizontal: 7, paddingVertical: 4, borderRadius: 10, fontSize: 11 },
  usageBadgeAction: { color: '#486F78', backgroundColor: '#DFF4F2', paddingHorizontal: 7, paddingVertical: 4, borderRadius: 10, fontSize: 11 },
  promptDiagnosticsEntry: { alignItems: 'center', backgroundColor: '#F4F1FA', borderColor: '#DDD6EF', borderRadius: 8, borderWidth: 1, flexDirection: 'row', gap: 12, marginBottom: 18, minHeight: 66, paddingHorizontal: 13, paddingVertical: 11 },
  promptDiagnosticsTitle: { color: '#665A92', fontSize: 15, fontWeight: '800', marginBottom: 4 },
  promptDiagnosticsText: { color: '#7D768B', fontSize: 11, lineHeight: 17 },
  promptDiagnosticsArrow: { color: '#756BAE', fontSize: 28, lineHeight: 30 },
  connectionActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  smallButton: { backgroundColor: '#FFF1ED', borderRadius: 11, paddingHorizontal: 10, paddingVertical: 7 },
  smallButtonText: { color: '#B76558', fontSize: 11, fontWeight: '700' },
  behaviorRoutingCard: { borderRadius: 18, backgroundColor: '#F2FBFA', borderWidth: 1, borderColor: '#CFE8E4', padding: 13, marginTop: 7, marginBottom: 16 },
  behaviorRoutingHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginBottom: 13 },
  behaviorRoutingCopy: { flex: 1 },
  behaviorRoutingTitle: { color: '#3E6F73', fontSize: 16, fontWeight: '800', marginBottom: 4 },
  behaviorRoutingBadge: { color: '#3E7477', backgroundColor: '#D7EFEC', borderRadius: 11, overflow: 'hidden', fontSize: 11, fontWeight: '800', paddingHorizontal: 8, paddingVertical: 5 },
  behaviorRoutingLabel: { color: '#49777A', fontSize: 12, fontWeight: '800', marginBottom: 5, marginTop: 7 },
  behaviorRoutingText: { color: '#668487', fontSize: 11, lineHeight: 17 },
  behaviorRoutingMeta: { color: colors.ink, fontSize: 12, fontWeight: '700', lineHeight: 18, marginBottom: 8 },
  behaviorOptionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginBottom: 7 },
  behaviorOption: { minHeight: 32, justifyContent: 'center', borderRadius: 12, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#D6EAE7', paddingHorizontal: 10 },
  behaviorOptionSelected: { backgroundColor: '#CBE9E5', borderColor: '#8CC6C0' },
  behaviorOptionText: { color: '#6B8587', fontSize: 11, fontWeight: '700' },
  behaviorOptionSelectedText: { color: '#356E71', fontSize: 11, fontWeight: '800' },
  behaviorSwitchRow: { minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#D6EAE7', marginTop: 7, paddingTop: 10 },
  behaviorBudgetRow: { flexDirection: 'row', gap: 9, marginTop: 12, marginBottom: 6 },
  behaviorBudgetMetric: { flex: 1, alignItems: 'center', borderRadius: 14, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#D6EAE7', paddingVertical: 10 },
  behaviorBudgetNumber: { color: '#3E7477', fontSize: 20, fontWeight: '900' },
  behaviorBudgetLabel: { color: '#718B8D', fontSize: 10, fontWeight: '700', marginTop: 3 },
  behaviorReviewList: { gap: 8, marginTop: 3 },
  behaviorReviewEntry: { borderRadius: 13, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#D6EAE7', paddingHorizontal: 10, paddingVertical: 9 },
  behaviorReviewHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 4 },
  behaviorReviewTime: { color: '#6B8587', fontSize: 10, fontWeight: '700' },
  behaviorReviewOutcome: { color: '#3E7477', backgroundColor: '#E2F4F1', borderRadius: 9, overflow: 'hidden', fontSize: 10, fontWeight: '800', paddingHorizontal: 7, paddingVertical: 3 },
  behaviorReviewReason: { color: colors.ink, fontSize: 11, lineHeight: 17, fontWeight: '700' },
  behaviorReviewMeta: { color: '#7F9698', fontSize: 10, lineHeight: 15, marginTop: 3 },
  behaviorReviewSignals: { color: '#4F7C80', fontSize: 10, lineHeight: 15, marginTop: 3 },
  behaviorReviewSummary: { color: '#6B8587', fontSize: 11, lineHeight: 16, marginTop: 5 },
  behaviorReviewEmpty: { color: '#728D8F', backgroundColor: '#FFFFFF', borderRadius: 12, fontSize: 11, lineHeight: 17, paddingHorizontal: 10, paddingVertical: 9 },
  behaviorBadEnvelopeDetails: { gap: 7, marginTop: 9 },
  behaviorBadEnvelopeRaw: { color: '#344B50', backgroundColor: '#F3F8F7', borderRadius: 10, fontSize: 11, lineHeight: 17, paddingHorizontal: 9, paddingVertical: 8 },
  editor: { backgroundColor: '#FFF2EE', borderRadius: 18, padding: 13, borderWidth: 1, borderColor: '#FFD6CC', marginBottom: 16 },
  editorTitle: { color: colors.ink, fontSize: 15, fontWeight: '700', marginBottom: 12 },
  field: { marginBottom: 12 },
  label: { color: colors.ink, fontSize: 13, fontWeight: '600', marginBottom: 6 },
  input: { minHeight: 46, borderRadius: 13, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#FFE0D7', color: colors.ink, fontSize: 14, paddingHorizontal: 12, paddingVertical: 11 },
  keyRow: { flexDirection: 'row', gap: 7 },
  keyInput: { flex: 1 },
  revealButton: { height: 46, minWidth: 58, borderRadius: 13, backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center' },
  revealText: { color: '#B76558', fontSize: 12, fontWeight: '700' },
  parameterPanel: { borderRadius: 15, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#FFE0D7', padding: 11, marginBottom: 12 },
  parameterHeading: { gap: 8, marginBottom: 10 },
  parameterTitle: { color: colors.ink, fontSize: 13, fontWeight: '700', marginBottom: 3 },
  parameterHint: { color: colors.muted, fontSize: 10, lineHeight: 15 },
  parameterPresetRow: { alignSelf: 'flex-start', flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  parameterPresetButton: { height: 31, justifyContent: 'center', borderRadius: 11, backgroundColor: '#FFE5DD', paddingHorizontal: 9 },
  parameterPresetText: { color: '#B76558', fontSize: 11, fontWeight: '700' },
  parameterResetButton: { height: 31, justifyContent: 'center', borderRadius: 11, backgroundColor: '#F7F0EC', paddingHorizontal: 9 },
  parameterResetText: { color: colors.muted, fontSize: 11, fontWeight: '700' },
  parameterRow: { minHeight: 50, flexDirection: 'row', alignItems: 'center', gap: 8, borderTopWidth: 1, borderTopColor: '#FFF0EB', paddingTop: 8, marginTop: 8 },
  parameterCopy: { flex: 1 },
  parameterName: { color: colors.ink, fontSize: 12, fontWeight: '700', marginBottom: 2 },
  parameterApiName: { color: colors.muted, fontSize: 10 },
  parameterInput: { width: 76, minHeight: 40, borderRadius: 11, paddingHorizontal: 8, paddingVertical: 8, textAlign: 'center' },
  editorActions: { flexDirection: 'row', gap: 8, justifyContent: 'flex-end' },
  deleteButton: { minWidth: 76, height: 43, alignItems: 'center', justifyContent: 'center', borderRadius: 13, backgroundColor: '#FFE3DF', paddingHorizontal: 12 },
  deleteText: { color: '#CC665B', fontSize: 13, fontWeight: '700' },
  secondaryButton: { minWidth: 76, height: 43, alignItems: 'center', justifyContent: 'center', borderRadius: 13, backgroundColor: '#FFFFFF', paddingHorizontal: 12 },
  secondaryButtonText: { color: '#B76558', fontSize: 13, fontWeight: '700' },
  primaryButton: { minWidth: 76, height: 43, alignItems: 'center', justifyContent: 'center', borderRadius: 13, backgroundColor: '#EE8D7D', paddingHorizontal: 12 },
  primaryButtonText: { color: '#FFFFFF', fontSize: 13, fontWeight: '700' },
  visionTestCard: { padding: 12, borderRadius: 18, backgroundColor: '#F5F1FF', borderWidth: 1, borderColor: '#E2D8FA', marginBottom: 17 },
  visionResult: { color: '#51436F', backgroundColor: '#FFFFFF', borderRadius: 13, borderWidth: 1, borderColor: '#E2D8FA', fontSize: 13, lineHeight: 20, marginTop: 12, paddingHorizontal: 11, paddingVertical: 10 },
  memoryTitle: { marginTop: 6, marginBottom: 10 },
  semanticCard: { padding: 12, borderRadius: 18, backgroundColor: '#EAF4FF', borderWidth: 1, borderColor: '#D6EAFB', marginBottom: 17 },
  rerankerCard: { padding: 12, borderRadius: 18, backgroundColor: '#EFF8F2', borderWidth: 1, borderColor: '#D8ECDD', marginBottom: 17 },
  semanticSwitch: { marginBottom: 13, flexDirection: 'row', alignItems: 'center', gap: 12 },
  embeddingStatus: { color: '#67839D', fontSize: 12, lineHeight: 18, marginBottom: 10 },
  memorySwitchCard: { padding: 13, borderRadius: 16, backgroundColor: '#EDF6FF', marginBottom: 17, flexDirection: 'row', alignItems: 'center', gap: 12 },
  backendCard: { borderRadius: 18, backgroundColor: '#F4FAFF', borderWidth: 1, borderColor: '#DDEFFF', padding: 12, marginBottom: 17 },
  backendStatusCard: { borderRadius: 14, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#DDEFFF', paddingHorizontal: 12, paddingVertical: 10, marginTop: 10, marginBottom: 10 },
  backendStatusTitle: { color: '#557CA1', fontSize: 13, fontWeight: '700', marginBottom: 4 },
  backendStatusText: { color: '#67839D', fontSize: 12, lineHeight: 18 },
  lifeDebugCard: { borderRadius: 14, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#DDEFFF', paddingHorizontal: 12, paddingVertical: 10, marginBottom: 10 },
  lifeDebugText: { color: '#657F96', fontSize: 11, lineHeight: 17, marginTop: 5 },
  lifeActionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 9 },
  phoneActivityCard: { borderRadius: 16, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#DDEFFF', padding: 12, marginTop: 12 },
  permissionGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginTop: 9, marginBottom: 9 },
  permissionPill: { borderRadius: 13, backgroundColor: '#F4F6F8', borderWidth: 1, borderColor: '#E5ECF2', paddingHorizontal: 9, paddingVertical: 6 },
  permissionPillEnabled: { backgroundColor: '#E8F6EB', borderColor: '#D4EEDB' },
  permissionPillText: { color: '#8090A0', fontSize: 11, fontWeight: '700' },
  permissionPillEnabledText: { color: '#5F9A72', fontSize: 11, fontWeight: '700' },
  phoneActionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 },
  phoneActionButton: { minHeight: 36, justifyContent: 'center', borderRadius: 12, backgroundColor: '#F4FAFF', borderWidth: 1, borderColor: '#DDEFFF', paddingHorizontal: 11 },
  phoneActionText: { color: '#5D86AA', fontSize: 12, fontWeight: '700' },
  phoneStartButton: { minHeight: 36, justifyContent: 'center', borderRadius: 12, backgroundColor: '#BDE2FF', paddingHorizontal: 12 },
  phoneStartText: { color: '#46779E', fontSize: 12, fontWeight: '800' },
  privacyButton: { minHeight: 36, justifyContent: 'center', borderRadius: 12, backgroundColor: '#FFF3D8', paddingHorizontal: 11 },
  privacyText: { color: '#B4873B', fontSize: 12, fontWeight: '700' },
  phoneLogButton: { minHeight: 38, justifyContent: 'center', borderRadius: 13, backgroundColor: '#E7F4FF', borderWidth: 1, borderColor: '#CFE8FA', paddingHorizontal: 12 },
  phoneLogButtonText: { color: '#4F83AA', fontSize: 12, fontWeight: '800' },
  phoneFocusDebugText: { marginTop: 8, borderRadius: 10, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#DDEFFF', color: '#67839D', fontSize: 11, lineHeight: 17, paddingHorizontal: 9, paddingVertical: 7 },
  phoneLogList: { gap: 8, marginTop: 10 },
  phoneLogItem: { borderRadius: 13, backgroundColor: '#F8FCFF', borderWidth: 1, borderColor: '#E2F1FC', paddingHorizontal: 11, paddingVertical: 9 },
  phoneLogMeta: { color: '#7E9AB2', fontSize: 10, fontWeight: '700', marginBottom: 4 },
  phoneLogTitle: { color: colors.ink, fontSize: 12, fontWeight: '700', marginBottom: 4 },
  phoneLogSource: { color: '#93A7B8', fontSize: 10, marginBottom: 4 },
  phoneLogSummary: { color: '#657F96', fontSize: 11, lineHeight: 16 },
  phoneLogRuleRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginTop: 8 },
  phoneBlacklistButton: { minHeight: 31, justifyContent: 'center', borderRadius: 10, backgroundColor: '#FFE3DF', paddingHorizontal: 10 },
  phoneBlacklistText: { color: '#CC665B', fontSize: 11, fontWeight: '800' },
  phoneWhitelistButton: { minHeight: 31, justifyContent: 'center', borderRadius: 10, backgroundColor: '#E8F6EB', paddingHorizontal: 10 },
  phoneWhitelistText: { color: '#5F9A72', fontSize: 11, fontWeight: '800' },
  phoneJealousyButton: { minHeight: 31, justifyContent: 'center', borderRadius: 10, backgroundColor: '#FFE8EF', paddingHorizontal: 10 },
  phoneJealousyText: { color: '#B45D78', fontSize: 11, fontWeight: '800' },
  phoneRuleButtonDisabled: { opacity: 0.52 },
  phoneLogEmpty: { color: '#758CA3', fontSize: 12, lineHeight: 18, paddingVertical: 5 },
  memorySwitchCopy: { flex: 1 },
  memorySwitchTitle: { color: '#557CA1', fontSize: 13, fontWeight: '700', marginBottom: 4 },
  memorySwitchText: { color: '#67839D', fontSize: 12, lineHeight: 18 },
  previewRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 17 },
  previewChip: { borderRadius: 15, backgroundColor: '#F9FCFF', borderWidth: 1, borderColor: '#DDEFFF', paddingHorizontal: 12, paddingVertical: 8 },
  previewChipSelected: { backgroundColor: '#BDE2FF', borderColor: '#BDE2FF' },
  previewChipText: { color: '#67839D', fontSize: 12, fontWeight: '700' },
  previewChipSelectedText: { color: '#4B769C', fontSize: 12, fontWeight: '700' },
  autonomyPanel: { borderRadius: 18, backgroundColor: '#F0FAF2', borderWidth: 1, borderColor: '#D8EDD9', padding: 12, marginBottom: 17 },
  autonomySwitchRow: { minHeight: 58, flexDirection: 'row', alignItems: 'center', gap: 12, borderBottomWidth: 1, borderBottomColor: '#DCEEDF', paddingVertical: 9 },
  autonomyTestButton: { alignItems: 'center', justifyContent: 'center', minHeight: 40, borderRadius: 13, backgroundColor: '#B8DDBE', marginTop: 12, paddingHorizontal: 12 },
  autonomyTestButtonDisabled: { opacity: 0.52 },
  autonomyTestButtonText: { color: '#3F7650', fontSize: 13, fontWeight: '800' },
  autonomyTestHint: { color: '#67839D', fontSize: 11, lineHeight: 17, marginTop: 7 },
  innerStateMaintenanceCard: { borderRadius: 18, backgroundColor: '#F4FAFF', borderWidth: 1, borderColor: '#DDEFFF', padding: 12, marginBottom: 17 },
  innerStateMaintenanceText: { color: '#657F96', fontSize: 12, lineHeight: 18, marginBottom: 10 },
  innerStateMaintenanceButton: { alignItems: 'center', justifyContent: 'center', minHeight: 40, borderRadius: 13, backgroundColor: '#DCEEFF', paddingHorizontal: 12 },
  innerStateMaintenanceButtonText: { color: '#4B769C', fontSize: 12, fontWeight: '800' },
  innerStateResetButton: { alignItems: 'center', justifyContent: 'center', minHeight: 40, borderRadius: 13, backgroundColor: '#FFE3DF', marginTop: 9, paddingHorizontal: 12 },
  innerStateResetText: { color: '#C45F55', fontSize: 12, fontWeight: '800' },
  expressionCard: { borderRadius: 18, backgroundColor: '#FFF8F4', borderWidth: 1, borderColor: '#FFE0D7', padding: 12, marginBottom: 17 },
  expressionHint: { color: colors.muted, fontSize: 12, lineHeight: 18, marginBottom: 12 },
  expressionMoodGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginBottom: 12 },
  expressionMoodChip: { minHeight: 32, justifyContent: 'center', borderRadius: 12, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#FFE0D7', paddingHorizontal: 10 },
  expressionMoodChipSelected: { backgroundColor: '#FFE5DD', borderColor: '#F5A796' },
  expressionMoodChipText: { color: '#9A7B72', fontSize: 11, fontWeight: '700' },
  expressionMoodChipSelectedText: { color: '#B76558', fontSize: 11, fontWeight: '800' },
  expressionInput: { minHeight: 72 },
  expressionUpdated: { color: '#9A7B72', fontSize: 11, lineHeight: 16, marginBottom: 9 },
  stickerToolbar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 10 },
  stickerToolbarTitle: { color: colors.ink, fontSize: 14, fontWeight: '800', marginBottom: 3 },
  stickerGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 9 },
  stickerTile: { width: '31%', minWidth: 92, flexGrow: 1, borderRadius: 14, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#FFE0D7', overflow: 'hidden' },
  stickerThumb: { width: '100%', aspectRatio: 1 },
  stickerTileFooter: { minHeight: 34, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 6, paddingHorizontal: 7, paddingVertical: 6 },
  stickerName: { flex: 1, color: '#8B6D64', fontSize: 10.5, fontWeight: '700' },
  stickerDeleteButton: { width: 26, height: 24, alignItems: 'center', justifyContent: 'center', borderRadius: 9, backgroundColor: '#FFE3DF' },
  stickerDeleteText: { color: '#C45F55', fontSize: 11, fontWeight: '800' },
  stickerEmpty: { borderRadius: 13, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#FFE0D7', color: '#9A7B72', fontSize: 12, lineHeight: 18, paddingHorizontal: 11, paddingVertical: 12 },
  expressionSaveButton: { alignSelf: 'flex-end', height: 38, justifyContent: 'center', borderRadius: 12, backgroundColor: '#EE8D7D', paddingHorizontal: 13 },
  builtInNotice: { borderRadius: 14, backgroundColor: '#FFF2EE', borderWidth: 1, borderColor: '#FFD3C9', paddingHorizontal: 13, paddingVertical: 11, marginBottom: 13 },
  builtInTitle: { color: '#B76558', fontSize: 13, fontWeight: '700', marginBottom: 4 },
  builtInText: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  multilineInput: { minHeight: 82 },
  personaSave: { alignSelf: 'flex-end', height: 44, paddingHorizontal: 17, justifyContent: 'center', borderRadius: 14, backgroundColor: '#EE8D7D', marginBottom: 13 },
  notice: { borderRadius: 14, paddingHorizontal: 13, paddingVertical: 11 },
  topNotice: { marginBottom: 12 },
  successNotice: { backgroundColor: '#E8F6EB' },
  errorNotice: { backgroundColor: '#FFEAE5' },
  noticeText: { color: colors.ink, fontSize: 13, lineHeight: 19 },
});
