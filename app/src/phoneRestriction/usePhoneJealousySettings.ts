import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useRef, useState } from 'react';

import { useAiConfigPreferences } from '../ai/AiConfigPreferences';
import type { InstalledPhoneApp } from '../backend/phoneActivityNative';
import {
  canCommitBackupRestoreDataEpoch,
  captureBackupRestoreDataEpoch,
  runBackupRestoreDataEpochCommit,
} from '../backup/backupRestoreCoordinator';
import {
  createPhoneActivityRuleFromApp,
  isJunLuoPhoneApp,
  type PhoneActivityJealousyCandidate,
  type PhoneActivityProactiveSettings,
  type PhoneActivityRule,
} from '../proactive/phoneActivityRules';
import { formatPhoneJealousyDismissalFallback, PHONE_JEALOUSY_DEFAULT_REASON } from '../proactive/phoneJealousyPrompt';
import {
  generateJealousyCandidateDismissedReaction,
  sendJealousyCandidateDismissedMessage,
  suggestJealousyCandidateApps,
} from '../proactive/proactiveMessages';
import { withSettingsTimeout } from '../screens/useSettingsRead';

type Notice = { kind: 'success' | 'error'; text: string };
type Options = {
  settings: PhoneActivityProactiveSettings;
  apps: InstalledPhoneApp[];
  loadApps: () => Promise<InstalledPhoneApp[]>;
  onSave: (settings: PhoneActivityProactiveSettings) => Promise<void>;
  onNotice: (notice: Notice) => void;
  active?: boolean;
};

const JEALOUSY_DISMISSAL_COUNT_KEY = 'junluo.phoneActivityJealousy.dismissalCount';

export function usePhoneJealousySettings(options: Options) {
  const { chatConnection, lifeCreativeConnection, getConnectionKey, profile } = useAiConfigPreferences();
  const connection = lifeCreativeConnection ?? chatConnection;
  const apiKey = connection ? getConnectionKey(connection.id) : '';
  const [busy, setBusy] = useState(false);
  const latest = useRef({ ...options, connection, apiKey, profile });
  const lifetime = useRef({ active: true, version: 0, busy: false });
  Object.assign(latest.current, { ...options, connection, apiKey, profile });
  useEffect(() => {
    lifetime.current.active = options.active !== false;
    return () => { lifetime.current.active = false; lifetime.current.version += 1; };
  }, [options.active]);

  const begin = () => {
    const version = ++lifetime.current.version;
    const epoch = captureBackupRestoreDataEpoch();
    return {
      epoch,
      current: () => lifetime.current.active && lifetime.current.version === version && canCommitBackupRestoreDataEpoch(epoch),
    };
  };
  const persist = async (next: PhoneActivityProactiveSettings, action: ReturnType<typeof begin>) => {
    if (!action.current()) return false;
    const result = await runBackupRestoreDataEpochCommit(action.epoch, async () => {
      if (!action.current()) return false;
      await latest.current.onSave(next);
      if (action.current()) latest.current.settings = next;
      return true;
    });
    return result.committed && result.value && action.current();
  };
  const findCandidateForRule = (rule: PhoneActivityRule) => (latest.current.settings.jealousyCandidateApps ?? [])
    .find(candidate => candidate.status === 'accepted' && (candidate.source || candidate.title) === (rule.source || rule.title));
  const sendDismissalIfPossible = (candidate: PhoneActivityJealousyCandidate) => {
    const config = latest.current;
    if (!config.connection || !config.apiKey.trim()) return;
    void sendJealousyCandidateDismissedMessage({ apiKey: config.apiKey, candidate, connection: config.connection, profile: config.profile })
      .catch(() => undefined);
  };

  const pickApps = async () => {
    if (lifetime.current.busy) return;
    const action = begin();
    if (!action.current()) return;
    const config = latest.current;
    if (!config.connection) {
      config.onNotice({ kind: 'error', text: '还没有可用的生活创作模型，白云小姐暂时不能自己挑。' });
      return;
    }
    if (!config.apiKey.trim()) {
      config.onNotice({ kind: 'error', text: '当前生活创作模型还没有 API Key。' });
      return;
    }
    lifetime.current.busy = true;
    setBusy(true);
    try {
      config.onNotice({ kind: 'success', text: '我正在读取可启动 App 列表……' });
      const apps = config.apps.length ? config.apps : await withSettingsTimeout(config.loadApps(), 8_000, '读取 App 列表超时');
      if (!action.current()) return;
      if (!apps.length) {
        config.onNotice({ kind: 'error', text: '暂时没有读到 App 列表。' });
        return;
      }
      config.onNotice({ kind: 'success', text: `读到 ${apps.length} 个 App，我正在挑会吃醋的对象……` });
      const candidates = await withSettingsTimeout(suggestJealousyCandidateApps({
        apiKey: config.apiKey, apps, connection: config.connection,
        existingRules: latest.current.settings.rules, profile: config.profile,
      }), 30_000, '白云挑会吃醋 App 超时');
      if (!action.current()) return;
      const valid = candidates.filter(candidate => !isJunLuoPhoneApp(candidate.source, candidate.title));
      const settings = latest.current.settings;
      const rulesById = new Map(settings.rules.map(rule => [rule.id, rule]));
      valid.forEach(candidate => {
        const rule = createPhoneActivityRuleFromApp('jealousy', { source: candidate.source, title: candidate.title });
        rulesById.set(rule.id, rule);
      });
      const candidatesBySource = new Map((settings.jealousyCandidateApps ?? []).map(candidate => [candidate.source || candidate.title, candidate]));
      valid.forEach(candidate => candidatesBySource.set(candidate.source || candidate.title, { ...candidate, status: 'accepted' }));
      if (!await persist({ ...settings, enabled: valid.length ? true : settings.enabled,
        jealousyEnabled: valid.length ? true : settings.jealousyEnabled,
        jealousyCandidateApps: Array.from(candidatesBySource.values()).slice(-24), rules: Array.from(rulesById.values()),
      }, action)) return;
      latest.current.onNotice({ kind: 'success', text: valid.length
        ? `白云小姐挑了 ${valid.length} 个会吃醋 App，已经放进会吃醋名单。` : '白云小姐看了一圈，这次没有硬挑。' });
    } catch (failure) {
      if (!action.current()) return;
      const errorMessage = failure instanceof Error ? failure.message : '';
      const text = errorMessage.includes('读取 App 列表超时')
        ? '读取手机 App 列表超时了；按钮已经放开，可以稍后再点一次。'
        : errorMessage.includes('超时') ? '我挑会吃醋 App 超时了；按钮已经放开，可以稍后再点一次。'
          : errorMessage ? `我这次没有挑出来：${errorMessage.slice(0, 90)}`
            : '我这次没有挑出来，可能是模型请求失败，稍后再让我看一眼。';
      latest.current.onNotice({ kind: 'error', text });
    } finally {
      lifetime.current.busy = false;
      if (lifetime.current.active) setBusy(false);
    }
  };

  const acceptCandidate = async (candidate: PhoneActivityJealousyCandidate) => {
    const action = begin();
    const settings = latest.current.settings;
    try {
      if (isJunLuoPhoneApp(candidate.source, candidate.title)) {
        if (await persist({ ...settings, jealousyCandidateApps: (settings.jealousyCandidateApps ?? []).filter(item => item.id !== candidate.id) }, action)) {
          latest.current.onNotice({ kind: 'error', text: '君落自己不需要加入会吃醋名单。' });
        }
        return;
      }
      const rule = createPhoneActivityRuleFromApp('jealousy', { source: candidate.source, title: candidate.title });
      if (!await persist({ ...settings,
        jealousyCandidateApps: (settings.jealousyCandidateApps ?? []).map(item => item.id === candidate.id ? { ...item, status: 'accepted' } : item),
        enabled: true, jealousyEnabled: true, rules: [...settings.rules.filter(item => item.id !== rule.id), rule],
      }, action)) return;
      latest.current.onNotice({ kind: 'success', text: `已经把 ${candidate.title} 加入会吃醋名单。` });
    } catch {
      if (action.current()) latest.current.onNotice({ kind: 'error', text: '会吃醋名单未保存成功，请重试。' });
    }
  };

  const dismissCandidate = async (candidate: PhoneActivityJealousyCandidate) => {
    const action = begin();
    const settings = latest.current.settings;
    try {
      if (!await persist({ ...settings,
        jealousyCandidateApps: (settings.jealousyCandidateApps ?? []).map(item => item.id === candidate.id ? { ...item, status: 'dismissed' } : item),
      }, action)) return;
      sendDismissalIfPossible(candidate);
      latest.current.onNotice({ kind: 'success', text: '白云小姐知道啦，但她可能会有点酸。' });
    } catch {
      if (action.current()) latest.current.onNotice({ kind: 'error', text: '候选移除未保存成功，请重试。' });
    }
  };

  const removeRule = async (ruleId: string) => {
    const action = begin();
    const settings = latest.current.settings;
    const removed = settings.rules.find(rule => rule.id === ruleId);
    if (!removed) {
      if (action.current()) latest.current.onNotice({ kind: 'error', text: '这条规则已经不在名单里了。' });
      return;
    }
    try {
      const original = findCandidateForRule(removed);
      if (!await persist({ ...settings, rules: settings.rules.filter(rule => rule.id !== ruleId) }, action)) return;
      if (removed.kind !== 'jealousy') {
        latest.current.onNotice({ kind: 'success', text: `已经把 ${removed.title} 从${removed.kind === 'blacklist' ? '黑名单' : '白名单'}删除。` });
        return;
      }
      const candidate: PhoneActivityJealousyCandidate = { createdAt: Date.now(), id: `jealousy-dismissed:${removed.source || removed.title}`,
        reason: original?.reason || PHONE_JEALOUSY_DEFAULT_REASON, source: removed.source, status: 'dismissed', title: removed.title };
      const counted = await runBackupRestoreDataEpochCommit(action.epoch, async () => {
        if (!action.current()) return null;
        const raw = await AsyncStorage.getItem(JEALOUSY_DISMISSAL_COUNT_KEY);
        if (!action.current()) return null;
        const previous = raw ? Number(raw) : 0;
        const count = Number.isFinite(previous) ? previous + 1 : 1;
        await AsyncStorage.setItem(JEALOUSY_DISMISSAL_COUNT_KEY, String(count));
        return count;
      }).catch(() => ({ committed: true as const, value: 1 }));
      if (!counted.committed || !counted.value || !action.current()) return;
      const dismissalCount = counted.value;
      latest.current.onNotice({ kind: 'success', text: formatPhoneJealousyDismissalFallback(dismissalCount) });
      const config = latest.current;
      if (config.connection && config.apiKey.trim()) {
        void generateJealousyCandidateDismissedReaction({ apiKey: config.apiKey, candidate,
          connection: config.connection, dismissalCount, profile: config.profile,
        }).then(reaction => {
          if (reaction && action.current()) latest.current.onNotice({ kind: 'success', text: reaction });
        }).catch(() => undefined);
      }
      if (dismissalCount % 3 === 0) sendDismissalIfPossible(candidate);
    } catch {
      if (action.current()) latest.current.onNotice({ kind: 'error', text: '名单删除未保存成功，请重试。' });
    }
  };

  const pause = async (minutes: number) => {
    const action = begin();
    try {
      if (await persist({ ...latest.current.settings, jealousyPausedUntil: Date.now() + minutes * 60000 }, action)) {
        latest.current.onNotice({ kind: 'success', text: `白云小姐允许鼠玩闹 ${minutes} 分钟。` });
      }
    } catch {
      if (action.current()) latest.current.onNotice({ kind: 'error', text: '暂停设置未保存成功，请重试。' });
    }
  };
  const indulgeToday = async () => {
    const action = begin();
    const midnight = new Date();
    midnight.setDate(midnight.getDate() + 1);
    midnight.setHours(0, 0, 0, 0);
    try {
      if (await persist({ ...latest.current.settings, jealousyPausedUntil: midnight.getTime() }, action)) {
        latest.current.onNotice({ kind: 'success', text: '白云小姐允许鼠今天放纵；到 00:00 会自己恢复。' });
      }
    } catch {
      if (action.current()) latest.current.onNotice({ kind: 'error', text: '暂停设置未保存成功，请重试。' });
    }
  };

  return { busy, pickApps, acceptCandidate, dismissCandidate, removeRule, pause, indulgeToday, findCandidateForRule };
}
