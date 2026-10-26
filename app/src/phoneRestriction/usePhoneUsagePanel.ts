import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { useAiConfigPreferences } from '../ai/AiConfigPreferences';
import { beginPromptCacheMetric } from '../ai/promptCacheMetrics';
import type { AiConnection } from '../ai/types';
import { readOwnAppPhoneUsage } from '../backend/phoneActivityNative';
import {
  canCommitBackupRestoreDataEpoch,
  captureBackupRestoreDataEpoch,
  runBackupRestoreDataEpochCommit,
  subscribeBackupRestoreRuntimeState,
} from '../backup/backupRestoreCoordinator';
import { loadPhoneUsageSummary, type PhoneUsageSummary } from '../phoneActivity/phoneActivityStore';
import {
  buildPhoneUsageCommentPrompt,
  formatPhoneUsageCommentFallback,
  PHONE_USAGE_COMMENT_USER_PROMPT,
} from '../phoneActivity/phoneUsagePrompt';
import { SETTINGS_READ_TIMEOUT_MS, withSettingsTimeout } from '../screens/useSettingsRead';
import { formatUsageDuration, includeOwnAppPhoneUsage, normalizePhoneUsageComment, todayCommentKey } from './phoneUsageFormatting';

const PHONE_USAGE_COMMENT_CACHE_KEY = 'junluo.phoneUsage.dailyComment';
// Reuse the last display while this App process is alive; records remain the source of truth.
let usageSnapshot: { epoch: number; summary: PhoneUsageSummary; ownUsageNote: string } | null = null;
function cachedUsage() {
  if (usageSnapshot && (!canCommitBackupRestoreDataEpoch(usageSnapshot.epoch)
    || todayCommentKey(usageSnapshot.summary.updatedAt) !== todayCommentKey(Date.now()))) usageSnapshot = null;
  return usageSnapshot;
}

// Extracted without changing the reviewed prompt, request fields or configuration fallback.
async function generatePhoneUsageComment({ apiKey, connection, summary }: {
  apiKey: string;
  connection: AiConnection;
  summary: PhoneUsageSummary;
}) {
  if (!apiKey.trim() || !summary.todayTopApps.length) return '';
  const todayText = summary.todayTopApps.slice(0, 5)
    .map((app, index) => `${index + 1}. ${app.title} ${formatUsageDuration(app.durationMs)}`).join('\n');
  const weekText = summary.weekTopApps.slice(0, 5)
    .map((app, index) => `${index + 1}. ${app.title} ${formatUsageDuration(app.durationMs)}`).join('\n');
  const prompt = buildPhoneUsageCommentPrompt({ todayText, weekText });
  const body = JSON.stringify({
      model: connection.model.trim(),
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: PHONE_USAGE_COMMENT_USER_PROMPT },
      ],
      max_tokens: 120,
      temperature: 0.78,
  });
  const cacheMetric = beginPromptCacheMetric({ contextProfile: 'assistant-life', contextSource: 'phone.usage-comment', connection });
  try {
    const response = await fetch(`${connection.baseUrl.trim().replace(/\/+$/, '')}/chat/completions`, {
      body,
      headers: { Authorization: `Bearer ${apiKey.trim()}`, 'Content-Type': 'application/json' },
      method: 'POST',
    });
    if (!response.ok) return '';
    const payload = await response.json() as { usage?: unknown; choices?: Array<{ message?: { content?: string } }> };
    cacheMetric.recordUsage(payload?.usage);
    return normalizePhoneUsageComment(payload.choices?.[0]?.message?.content ?? '');
  } finally { cacheMetric.finish(); }
}

export type PhoneUsagePanelState = {
  summary: PhoneUsageSummary | null;
  loading: boolean;
  error: string;
  ownUsageNote: string;
  comment: string;
  commentLoading: boolean;
  commentError: string;
  refresh: () => Promise<void>;
};

export function usePhoneUsagePanel({ active, allowComment }: { active: boolean; allowComment: boolean }): PhoneUsagePanelState {
  const { loaded, lifeCreativeConnection, chatConnection, getConnectionKey } = useAiConfigPreferences();
  const connection = lifeCreativeConnection ?? chatConnection;
  const apiKey = connection ? getConnectionKey(connection.id) : '';
  const cached = cachedUsage();
  const [summary, setSummary] = useState<PhoneUsageSummary | null>(cached?.summary ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [ownUsageNote, setOwnUsageNote] = useState(cached?.ownUsageNote ?? '');
  const [comment, setComment] = useState('');
  const [commentLoading, setCommentLoading] = useState(false);
  const [commentError, setCommentError] = useState('');
  const reads = useRef({ active: false, request: 0, allowComment, loaded, connection, apiKey });
  Object.assign(reads.current, { allowComment, loaded, connection, apiKey });

  const refresh = useCallback(async () => {
    if (!reads.current.active) return;
    const version = ++reads.current.request;
    const epoch = captureBackupRestoreDataEpoch();
    const current = () => reads.current.active && reads.current.request === version && canCommitBackupRestoreDataEpoch(epoch);
    setLoading(true);
    setError('');
    setCommentLoading(false);
    if (!cachedUsage()) {
      setSummary(null);
      setOwnUsageNote('');
    }
    if (epoch === null) {
      setLoading(false);
      setError('数据恢复期间暂不读取手机使用记录。');
      return;
    }
    const refreshComment = async (value: PhoneUsageSummary) => {
      if (!reads.current.allowComment || !current()) return;
      setCommentLoading(true);
      setCommentError('');
      try {
        const dateKey = todayCommentKey(value.updatedAt);
        const cached = await withSettingsTimeout(AsyncStorage.getItem(PHONE_USAGE_COMMENT_CACHE_KEY), SETTINGS_READ_TIMEOUT_MS, '手机点评缓存读取超时');
        if (!current()) return;
        if (cached) {
          try {
            const parsed = JSON.parse(cached) as { comment?: string; dateKey?: string };
            if (parsed.dateKey === dateKey && parsed.comment?.trim()) {
              setComment(parsed.comment.trim());
              return;
            }
          } catch { /* Ignore the same stale cache shape as the original page. */ }
        }
        setComment(formatPhoneUsageCommentFallback(value.todayTopApps[0]?.title));
        const config = reads.current;
        if (!config.loaded || !config.connection || !config.apiKey.trim() || !value.todayTopApps.length) return;
        const next = await withSettingsTimeout(generatePhoneUsageComment({
          apiKey: config.apiKey, connection: config.connection, summary: value,
        }), SETTINGS_READ_TIMEOUT_MS, '手机使用点评超时');
        if (!current()) return;
        if (!next) {
          setCommentError('手机使用点评暂未生成，已保留原有内容。');
          return;
        }
        setComment(next);
        const result = await runBackupRestoreDataEpochCommit(epoch, async () => {
          if (!current()) return;
          await AsyncStorage.setItem(PHONE_USAGE_COMMENT_CACHE_KEY, JSON.stringify({ comment: next, dateKey }));
        });
        if (!result.committed) return;
      } catch (failure) {
        if (current()) setCommentError(failure instanceof Error && failure.message.endsWith('超时')
          ? '手机使用点评读取超时，已保留原有内容。' : '手机使用点评读取或保存失败，已保留原有内容。');
      } finally {
        if (current()) setCommentLoading(false);
      }
    };
    try {
      const [records, own] = await Promise.allSettled([
        withSettingsTimeout(loadPhoneUsageSummary(7, Infinity), SETTINGS_READ_TIMEOUT_MS, '使用记录统计超时'),
        withSettingsTimeout(readOwnAppPhoneUsage(7), SETTINGS_READ_TIMEOUT_MS, '君落用量读取超时'),
      ]);
      if (!current()) return;
      if (records.status === 'rejected') throw records.reason;
      const value = records.value;
      const included = own.status === 'fulfilled' && own.value.available;
      const display = included ? includeOwnAppPhoneUsage(value, own.value) : value;
      const note = included ? `含系统可读取的君落用量${own.value.reason === 'SYSTEM_HISTORY_PARTIAL' ? '（部分日期）' : ''}` : '君落用量未读到，暂未计入';
      usageSnapshot = { epoch, summary: display, ownUsageNote: note };
      setSummary(display);
      setOwnUsageNote(note);
      // Statistics can finish while the existing daily comment is still reading or generating.
      // Keep the original six-App summary shape for the existing reviewed comment.
      void refreshComment(value.todayTopApps.length <= 6 && value.weekTopApps.length <= 6 ? value : {
        ...value, todayTopApps: value.todayTopApps.slice(0, 6), weekTopApps: value.weekTopApps.slice(0, 6),
      });
    } catch (failure) {
      if (current()) setError(failure instanceof Error && failure.message === '使用记录统计超时'
        ? '手机使用记录统计超时，请重试。' : '手机使用记录读取失败，请重试。');
    } finally {
      if (current()) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const invalidate = () => {
      reads.current.request += 1;
      setLoading(false);
      setCommentLoading(false);
    };
    reads.current.active = active && (!AppState.currentState || AppState.currentState === 'active');
    if (reads.current.active) void refresh();
    else {
      setLoading(false);
      setCommentLoading(false);
    }
    const appSubscription = AppState.addEventListener('change', state => {
      reads.current.active = active && state === 'active';
      invalidate();
      if (reads.current.active) void refresh();
    });
    const unsubscribeRestore = subscribeBackupRestoreRuntimeState(state => {
      invalidate();
      if (state.status !== 'ready') {
        usageSnapshot = null;
        setSummary(null);
        setOwnUsageNote('');
        setComment('');
        setCommentError('');
        setError('数据恢复期间暂不读取手机使用记录。');
      } else if (reads.current.active) void refresh();
    });
    return () => {
      reads.current.active = false;
      reads.current.request += 1;
      appSubscription.remove();
      unsubscribeRestore();
    };
  }, [active, allowComment, loaded, refresh]);

  return { summary, loading, error, ownUsageNote, comment, commentLoading, commentError, refresh };
}
