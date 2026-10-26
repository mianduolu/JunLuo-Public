import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Switch, TextInput, View } from 'react-native';

import {
  canCommitBackupRestoreDataEpoch,
  captureBackupRestoreDataEpoch,
} from '../backup/backupRestoreCoordinator';
import { AppText as Text } from '../components/AppText';
import { runNearbyWorldDataEpochCommit } from '../nearby/nearbyWorldEpochCoordinator';
import {
  pauseNearbyWorldAutoTogetherForCurrentTrip,
  reconcileNearbyWorldPrecisionState,
  requestNearbyWorldPermissions,
  refreshNearbyWorldNow,
  setNearbyWorldHomeToCurrentLocation,
  startNearbyWorldPrecisionWatcher,
  stopNearbyWorldBackgroundTask,
  stopNearbyWorldPrecisionWatcher,
  resumeNearbyWorldPrecisionWatcherIfNeeded,
  syncNearbyWorldBackgroundTask,
} from '../nearby/nearbyWorldService';
import {
  loadNearbyWorldSnapshot,
  NEARBY_WORLD_POI_CATEGORIES,
  saveNearbyWorldSettings,
  type NearbyWorldPoiCategory,
  type NearbyWorldSettings,
  type NearbyWorldStatus,
} from '../nearby/nearbyWorldStore';
import { colors } from '../theme/colors';
import type { Navigate } from '../types/navigation';

type Props = {
  navigate: Navigate;
};

type Notice = {
  kind: 'ok' | 'warning';
  text: string;
};

export function NearbyWorldSettingsScreen({ navigate }: Props) {
  const [settings, setSettings] = useState<NearbyWorldSettings | null>(null);
  const [status, setStatus] = useState<NearbyWorldStatus | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [now, setNow] = useState(Date.now());

  const reload = useCallback(async (dataEpoch = captureBackupRestoreDataEpoch()) => {
    if (dataEpoch === null) return null;
    const reconciled = await reconcileNearbyWorldPrecisionState({ dataEpoch, syncBackground: false });
    if (!reconciled) return null;
    const committed = await runNearbyWorldDataEpochCommit(dataEpoch, () => loadNearbyWorldSnapshot());
    if (!committed.committed || !canCommitBackupRestoreDataEpoch(dataEpoch)) return null;
    const snapshot = committed.value;
    setSettings(snapshot.settings);
    setStatus(snapshot.status);
    return snapshot;
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!status || status.precisionMode === 'off') return;
    setNow(Date.now());
    const timer = setInterval(() => {
      setNow(Date.now());
      void reload();
    }, 30 * 1000);
    return () => clearInterval(timer);
  }, [reload, status?.precisionMode, status?.precisionStartedAt]);

  const updateSettings = async (patch: Partial<NearbyWorldSettings>, noticeText?: string) => {
    if (!settings) return;
    const dataEpoch = captureBackupRestoreDataEpoch();
    if (dataEpoch === null) return;
    setSaving(true);
    try {
      const committed = await runNearbyWorldDataEpochCommit(
        dataEpoch,
        () => saveNearbyWorldSettings({ ...settings, ...patch }),
      );
      if (!committed.committed || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      const next = committed.value;
      setSettings(next);
      if (!next.enabled) {
        await stopNearbyWorldPrecisionWatcher('disabled', { dataEpoch });
      } else if (!next.backgroundEnabled) {
        await stopNearbyWorldBackgroundTask({ dataEpoch });
      } else {
        await syncNearbyWorldBackgroundTask({ dataEpoch });
      }
      if (next.enabled) await resumeNearbyWorldPrecisionWatcherIfNeeded();
      const snapshot = await reload(dataEpoch);
      if (!snapshot || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      if (noticeText) setNotice({ kind: 'ok', text: noticeText });
    } catch (error) {
      if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      setNotice({ kind: 'warning', text: error instanceof Error ? error.message : '附近世界保存失败。' });
    } finally {
      setSaving(false);
    }
  };

  const persistCurrentSettings = async (dataEpoch: number | null) => {
    if (!settings) return null;
    const committed = await runNearbyWorldDataEpochCommit(dataEpoch, () => saveNearbyWorldSettings(settings));
    if (!committed.committed || !canCommitBackupRestoreDataEpoch(dataEpoch)) return null;
    setSettings(committed.value);
    return committed.value;
  };

  const handlePermission = async () => {
    if (!settings) return;
    const dataEpoch = captureBackupRestoreDataEpoch();
    if (dataEpoch === null) return;
    setSaving(true);
    try {
      const currentSettings = await persistCurrentSettings(dataEpoch);
      if (!currentSettings) return;
      const permission = await requestNearbyWorldPermissions({
        background: currentSettings.backgroundEnabled,
        dataEpoch,
      });
      if (!permission || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      await syncNearbyWorldBackgroundTask({ dataEpoch });
      const snapshot = await reload(dataEpoch);
      if (!snapshot) return;
      if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      setNotice({
        kind: permission === 'denied' ? 'warning' : 'ok',
        text: permission === 'denied' ? '还没有位置权限，附近世界会先保持安静。' : '权限已更新，白云可以刷新附近世界了。',
      });
    } finally {
      setSaving(false);
    }
  };

  const handleRefresh = async () => {
    const dataEpoch = captureBackupRestoreDataEpoch();
    if (dataEpoch === null) return;
    setSaving(true);
    try {
      const currentSettings = await persistCurrentSettings(dataEpoch);
      if (!currentSettings) return;
      const next = await refreshNearbyWorldNow({ dataEpoch });
      if (!next || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      setStatus(next);
      setNotice({ kind: 'ok', text: '附近世界已经刷新了一次。' });
    } catch (error) {
      setNotice({ kind: 'warning', text: error instanceof Error ? error.message : '附近世界刷新失败。' });
    } finally {
      setSaving(false);
    }
  };

  const handleSetHome = async () => {
    const dataEpoch = captureBackupRestoreDataEpoch();
    if (dataEpoch === null) return;
    setSaving(true);
    try {
      const currentSettings = await persistCurrentSettings(dataEpoch);
      if (!currentSettings) return;
      const next = await setNearbyWorldHomeToCurrentLocation({ dataEpoch });
      if (!next || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      setSettings(next.settings);
      setStatus(next.status);
      setNotice({ kind: 'ok', text: '已经把当前位置设成家附近。' });
    } catch (error) {
      if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      setNotice({ kind: 'warning', text: error instanceof Error ? error.message : '设置家失败。' });
    } finally {
      setSaving(false);
    }
  };

  const handleStartTogether = async (mode: 'walking' | 'transit') => {
    if (!settings) return;
    const dataEpoch = captureBackupRestoreDataEpoch();
    if (dataEpoch === null) return;
    setSaving(true);
    try {
      const currentSettings = await persistCurrentSettings(dataEpoch);
      if (!currentSettings) return;
      const next = await startNearbyWorldPrecisionWatcher(mode, { dataEpoch });
      if (!next || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      setStatus(next);
      setNotice({ kind: 'ok', text: mode === 'walking' ? '已经进入一起走。' : '已经进入交通工具上。' });
    } catch (error) {
      if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      setNotice({ kind: 'warning', text: error instanceof Error ? error.message : '一起状态启动失败。' });
    } finally {
      setSaving(false);
    }
  };

  const handleStopTogether = async () => {
    const dataEpoch = captureBackupRestoreDataEpoch();
    if (dataEpoch === null) return;
    setSaving(true);
    try {
      const next = await stopNearbyWorldPrecisionWatcher('manual', { dataEpoch });
      if (!next || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      setStatus(next);
      setNotice({ kind: 'ok', text: '已经结束本次一起状态。' });
    } catch (error) {
      if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      setNotice({ kind: 'warning', text: error instanceof Error ? error.message : '一起状态结束失败。' });
    } finally {
      setSaving(false);
    }
  };

  const handlePauseAutoTogether = async () => {
    const dataEpoch = captureBackupRestoreDataEpoch();
    if (dataEpoch === null) return;
    setSaving(true);
    try {
      const next = await pauseNearbyWorldAutoTogetherForCurrentTrip(undefined, { dataEpoch });
      if (!next || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      setStatus(next);
      setNotice({ kind: 'ok', text: '这次出门先不会自动一起。' });
    } catch (error) {
      if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      setNotice({ kind: 'warning', text: error instanceof Error ? error.message : '暂停自动一起失败。' });
    } finally {
      setSaving(false);
    }
  };

  const toggleCategory = (category: NearbyWorldPoiCategory) => {
    if (!settings) return;
    const exists = settings.poiCategories.includes(category);
    const nextCategories = exists
      ? settings.poiCategories.filter((item) => item !== category)
      : [...settings.poiCategories, category];
    void updateSettings({ poiCategories: nextCategories.length ? nextCategories : [category] });
  };

  if (!settings || !status) {
    return (
      <View style={styles.page}>
        <Text style={styles.loadingText}>正在打开附近世界...</Text>
      </View>
    );
  }

  const precisionActive = status.precisionMode !== 'off';
  const togetherDisabled =
    saving ||
    !settings.enabled ||
    status.permissionStatus === 'denied' ||
    status.permissionStatus === 'unavailable';

  return (
    <View style={styles.page}>
      <View style={styles.header}>
        <Pressable accessibilityLabel="返回设置" onPress={() => navigate('settings')} style={styles.backButton}>
          <Text style={styles.backText}>‹</Text>
        </Pressable>
        <View style={styles.headerCopy}>
          <Text style={styles.title}>附近世界</Text>
          <Text style={styles.subtitle}>让白云知道一点外面的风</Text>
        </View>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="always"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.card}>
          <View style={styles.rowBetween}>
            <View style={styles.rowCopy}>
              <Text style={styles.cardTitle}>启用附近世界</Text>
              <Text style={styles.cardDetail}>默认关闭。开启后，白云才会读取附近状态。</Text>
            </View>
            <Switch
              value={settings.enabled}
              onValueChange={(enabled) => void updateSettings({ enabled }, enabled ? '附近世界已开启。' : '附近世界已关闭。')}
            />
          </View>
          <View style={styles.rowBetween}>
            <View style={styles.rowCopy}>
              <Text style={styles.cardTitle}>后台低频心跳</Text>
              <Text style={styles.cardDetail}>需要后台定位权限；不允许时会降级为前台刷新。</Text>
            </View>
            <Switch
              disabled={!settings.enabled}
              value={settings.backgroundEnabled}
              onValueChange={(backgroundEnabled) => void updateSettings({ backgroundEnabled })}
            />
          </View>
          <View style={styles.actions}>
            <Pressable
              disabled={saving || !settings.enabled}
              hitSlop={8}
              onPress={handlePermission}
              style={[styles.primaryButton, (saving || !settings.enabled) && styles.buttonDisabled]}
            >
              <Text style={styles.primaryButtonText}>{saving ? '处理中...' : '申请权限'}</Text>
            </Pressable>
            <Pressable
              disabled={saving || !settings.enabled}
              hitSlop={8}
              onPress={handleRefresh}
              style={[styles.secondaryButton, (saving || !settings.enabled) && styles.buttonDisabled]}
            >
              <Text style={styles.secondaryButtonText}>刷新一次</Text>
            </Pressable>
          </View>
        </View>

        <View style={styles.card}>
          <View style={styles.rowBetween}>
            <View style={styles.rowCopy}>
              <Text style={styles.cardTitle}>一起状态</Text>
              <Text style={styles.cardDetail}>
                {precisionActive
                  ? `${describePrecisionMode(status.precisionMode)}中，已经${formatTogetherDuration(status.precisionStartedAt, now)}。`
                  : '需要更认真看地图时，可以手动开启。'}
              </Text>
            </View>
            <View style={[styles.modeBadge, precisionActive && styles.modeBadgeActive]}>
              <Text style={[styles.modeBadgeText, precisionActive && styles.modeBadgeTextActive]}>
                {describePrecisionMode(status.precisionMode)}
              </Text>
            </View>
          </View>
          <View style={styles.rowBetween}>
            <View style={styles.rowCopy}>
              <Text style={styles.cardTitle}>自动一起</Text>
              <Text style={styles.cardDetail}>开启后，白云发现鼠在走或在交通工具上，会自动进入对应状态。</Text>
            </View>
            <Switch
              disabled={saving || !settings.enabled}
              value={settings.autoTogetherEnabled}
              onValueChange={(autoTogetherEnabled) => void updateSettings({ autoTogetherEnabled })}
            />
          </View>
          <View style={styles.statusGrid}>
            <View style={styles.statusPill}>
              <Text style={styles.statusPillLabel}>定位质量</Text>
              <Text style={styles.statusPillValue}>{describeGpsQuality(status.gpsQuality)}</Text>
            </View>
            <View style={styles.statusPill}>
              <Text style={styles.statusPillLabel}>运动判断</Text>
              <Text style={styles.statusPillValue}>{describeMotionState(status.motionState)}</Text>
            </View>
            <View style={styles.statusPill}>
              <Text style={styles.statusPillLabel}>后台档位</Text>
              <Text style={styles.statusPillValue}>{describeBackgroundProfile(status.backgroundProfile)}</Text>
            </View>
            <View style={styles.statusPill}>
              <Text style={styles.statusPillLabel}>自动来源</Text>
              <Text style={styles.statusPillValue}>{precisionActive ? describeAutoTogetherReason(status.autoTogetherReason) : '未自动进入'}</Text>
            </View>
            <View style={styles.statusPill}>
              <Text style={styles.statusPillLabel}>上次结束</Text>
              <Text style={styles.statusPillValue}>{describeStopReason(status.precisionStopReason)}</Text>
            </View>
            <View style={[styles.statusPill, status.batteryWarning && styles.statusPillWarning]}>
              <Text style={styles.statusPillLabel}>电量</Text>
              <Text style={styles.statusPillValue}>{describeBattery(status)}</Text>
            </View>
          </View>
          {status.batteryWarning ? (
            <Text style={styles.warningText}>电量有些低，后台努力可能更耗电。</Text>
          ) : null}
          {precisionActive ? (
            <View style={styles.actions}>
              <Pressable
                disabled={saving}
                hitSlop={8}
                onPress={handleStopTogether}
                style={[styles.stopButton, styles.flexButton, saving && styles.buttonDisabled]}
              >
                <Text style={styles.stopButtonText}>{saving ? '处理中...' : '结束'}</Text>
              </Pressable>
              <Pressable
                disabled={saving || !settings.autoTogetherEnabled}
                hitSlop={8}
                onPress={handlePauseAutoTogether}
                style={[styles.secondaryButton, (saving || !settings.autoTogetherEnabled) && styles.buttonDisabled]}
              >
                <Text style={styles.secondaryButtonText}>本次先别自动一起</Text>
              </Pressable>
            </View>
          ) : (
            <View style={styles.actions}>
              <Pressable
                disabled={togetherDisabled}
                hitSlop={8}
                onPress={() => void handleStartTogether('walking')}
                style={[styles.primaryButton, togetherDisabled && styles.buttonDisabled]}
              >
                <Text style={styles.primaryButtonText}>一起走</Text>
              </Pressable>
              <Pressable
                disabled={togetherDisabled}
                hitSlop={8}
                onPress={() => void handleStartTogether('transit')}
                style={[styles.secondaryButton, togetherDisabled && styles.buttonDisabled]}
              >
                <Text style={styles.secondaryButtonText}>交通工具上</Text>
              </Pressable>
            </View>
          )}
          {!precisionActive && settings.autoTogetherEnabled ? (
            <Pressable
              disabled={saving || !settings.enabled}
              hitSlop={8}
              onPress={handlePauseAutoTogether}
              style={[styles.secondaryButton, (saving || !settings.enabled) && styles.buttonDisabled]}
            >
              <Text style={styles.secondaryButtonText}>本次先别自动一起</Text>
            </Pressable>
          ) : null}
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>高德 Key</Text>
          <Text style={styles.cardDetail}>用于地址摘要和附近地点。会跟随完整备份包一起保存，请当作敏感信息。</Text>
          <TextInput
            autoCapitalize="none"
            autoCorrect={false}
            onChangeText={(amapKey) => setSettings((current) => current ? { ...current, amapKey } : current)}
            onBlur={() => void updateSettings({ amapKey: settings.amapKey }, '高德 Key 已保存。')}
            placeholder="粘贴高德 Web 服务 Key"
            placeholderTextColor="#A7B4BF"
            secureTextEntry
            style={styles.input}
            value={settings.amapKey}
          />
        </View>

        <View style={styles.card}>
          <View style={styles.rowBetween}>
            <View style={styles.rowCopy}>
              <Text style={styles.cardTitle}>家的坐标</Text>
              <Text style={styles.cardDetail}>{settings.home ? '已经有家附近坐标，用来判断在家/外出。' : '还没有设置家，暂时只能显示未知。'}</Text>
            </View>
            <Pressable
              disabled={saving || !settings.enabled}
              hitSlop={8}
              onPress={handleSetHome}
              style={[styles.smallButton, (saving || !settings.enabled) && styles.buttonDisabled]}
            >
              <Text style={styles.smallButtonText}>设为家</Text>
            </Pressable>
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>附近地点</Text>
          <Text style={styles.cardDetail}>白云只会把这些当作轻轻参考，不会连续播报位置。</Text>
          <View style={styles.chips}>
            {NEARBY_WORLD_POI_CATEGORIES.map((category) => {
              const selected = settings.poiCategories.includes(category.key);
              return (
                <Pressable
                  key={category.key}
                  onPress={() => toggleCategory(category.key)}
                  style={[styles.chip, selected && styles.chipSelected]}
                >
                  <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{category.label}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>当前状态</Text>
          <Text style={styles.statusLine}>状态：{describePresence(status.presence)}</Text>
          <Text style={styles.statusLine}>权限：{describePermission(status.permissionStatus)}</Text>
          <Text style={styles.statusLine}>一起状态：{describePrecisionMode(status.precisionMode)}</Text>
          <Text style={styles.statusLine}>自动一起：{settings.autoTogetherEnabled ? '已开启' : '已关闭'}</Text>
          <Text style={styles.statusLine}>运动判断：{describeMotionState(status.motionState)}</Text>
          {status.autoTogetherPausedUntil && status.autoTogetherPausedUntil > now ? (
            <Text style={styles.statusLine}>自动暂停：到 {new Date(status.autoTogetherPausedUntil).toLocaleString()}</Text>
          ) : null}
          {status.autoTogetherReason ? (
            <Text style={styles.statusLine}>自动来源：{describeAutoTogetherReason(status.autoTogetherReason)}</Text>
          ) : null}
          <Text style={styles.statusLine}>位置：{status.placeLabel || status.city || '还没有刷新'}</Text>
          {status.address ? <Text style={styles.statusLine}>地址：{status.address}</Text> : null}
          <Text style={styles.statusLine}>坐标：{formatCoordinateLine(status)}</Text>
          <Text style={styles.statusLine}>精度：{describeAccuracy(status.accuracy)}</Text>
          <Text style={styles.statusLine}>定位质量：{describeGpsQuality(status.gpsQuality)}</Text>
          <Text style={styles.statusLine}>后台档位：{describeBackgroundProfile(status.backgroundProfile)}</Text>
          <Text style={styles.statusLine}>电量：{describeBattery(status)}</Text>
          {status.batteryCheckedAt ? (
            <Text style={styles.statusLine}>电量检查：{new Date(status.batteryCheckedAt).toLocaleString()}</Text>
          ) : null}
          {formatNearbyReferenceLine(status) ? <Text style={styles.statusLine}>参照：{formatNearbyReferenceLine(status)}</Text> : null}
          <Text style={styles.statusLine}>附近地点：{status.poiCache.length} 个</Text>
          <Text style={styles.statusLine}>最近刷新：{status.updatedAt ? new Date(status.updatedAt).toLocaleString() : '还没有'}</Text>
          {status.precisionLastActiveAt ? (
            <Text style={styles.statusLine}>最近看见位置：{new Date(status.precisionLastActiveAt).toLocaleString()}</Text>
          ) : null}
          {status.precisionStopReason ? <Text style={styles.statusLine}>上次结束：{describeStopReason(status.precisionStopReason)}</Text> : null}
          {status.gpsQuality === 'poor' ? <Text style={styles.warningText}>提醒：现在定位不太可靠，白云会按上次可信位置谨慎参考。</Text> : null}
          {status.batteryWarning ? <Text style={styles.warningText}>提醒：电量有些低，后台努力可能更耗电。</Text> : null}
          {status.lastError ? <Text style={styles.warningText}>提醒：{status.lastError}</Text> : null}
          {notice ? <Text style={[styles.notice, notice.kind === 'warning' && styles.noticeWarning]}>{notice.text}</Text> : null}
        </View>

        <View style={styles.privacyCard}>
          <Text style={styles.privacyTitle}>白云会怎么使用它</Text>
          <Text style={styles.cardDetail}>
            聊天里会看到地点摘要、详细地址、精确坐标、精度和附近参照，用来回答“我在哪”这类问题；这些信息不会自动变成记忆。
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

function describePresence(value: string) {
  if (value === 'at_home') return '在家附近';
  if (value === 'outside') return '在外面';
  return '未知';
}

function describePermission(value: string) {
  if (value === 'background') return '前台+后台';
  if (value === 'foreground') return '仅前台';
  if (value === 'denied') return '未允许';
  return '未知';
}

function describePrecisionMode(value: string) {
  if (value === 'walking') return '一起走';
  if (value === 'transit') return '交通工具上';
  return '未开启';
}

function describeMotionState(value: string | null | undefined) {
  if (value === 'still') return '静止';
  if (value === 'walking') return '一起走倾向';
  if (value === 'transit') return '交通工具上倾向';
  return '未知';
}

function describeAutoTogetherReason(value: string | null | undefined) {
  if (value === 'walking_detected') return '自动进入：一起走';
  if (value === 'transit_detected') return '自动进入：交通工具上';
  return '手动开启';
}

function describeGpsQuality(value: string | null | undefined) {
  if (value === 'excellent') return '很好';
  if (value === 'good') return '不错';
  if (value === 'fair') return '有些不稳';
  if (value === 'poor') return '不太可靠';
  return '未知';
}

function describeBackgroundProfile(value: string | null | undefined) {
  if (value === 'daily') return '日常低频';
  if (value === 'precision') return '后台努力';
  return '未开启';
}

function describeStopReason(value: string | null | undefined) {
  if (value === 'manual') return '手动结束';
  if (value === 'arrived_home') return '回到家附近';
  if (value === 'idle_timeout') return '长时间静止';
  if (value === 'permission_lost') return '权限失效';
  if (value === 'system_interrupted') return '系统打断';
  if (value === 'disabled') return '总开关关闭';
  return '没有记录';
}

function describeBattery(status: NearbyWorldStatus) {
  const level = typeof status.batteryLevel === 'number' && Number.isFinite(status.batteryLevel)
    ? `${Math.round(status.batteryLevel * 100)}%`
    : '未知';
  if (status.batteryState === 'charging') return `${level} · 充电中`;
  if (status.batteryState === 'full') return `${level} · 已充满`;
  if (status.batteryState === 'unplugged') return status.batteryWarning ? `${level} · 偏低` : level;
  return level;
}

function describeAccuracy(value: number | null | undefined) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '未知';
  return `约 ${Math.round(value)} 米`;
}

function formatTogetherDuration(startedAt: number | null | undefined, now: number) {
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return '一小会儿';
  const totalMinutes = Math.max(0, Math.floor((now - startedAt) / 60000));
  if (totalMinutes < 1) return '刚刚开始';
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) return `${minutes} 分钟`;
  if (minutes <= 0) return `${hours} 小时`;
  return `${hours} 小时 ${minutes} 分钟`;
}

function formatCoordinateLine(status: NearbyWorldStatus) {
  if (typeof status.latitude !== 'number' || typeof status.longitude !== 'number') return '还没有';
  return `${status.latitude.toFixed(6)}, ${status.longitude.toFixed(6)}`;
}

function formatNearbyReferenceLine(status: NearbyWorldStatus) {
  return [
    status.nearbyAoi ? `区域 ${status.nearbyAoi}` : '',
    status.nearbyPoi ? `参照点 ${status.nearbyPoi}` : '',
    status.nearbyRoad ? `道路 ${status.nearbyRoad}` : '',
  ].filter(Boolean).join(' · ');
}

const styles = StyleSheet.create({
  actions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 14,
  },
  backButton: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderColor: '#DDEAF2',
    borderRadius: 22,
    borderWidth: 1,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  backText: {
    color: colors.ink,
    fontSize: 32,
    lineHeight: 34,
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderColor: '#DDEAF2',
    borderRadius: 18,
    borderWidth: 1,
    gap: 12,
    padding: 16,
  },
  cardDetail: {
    color: colors.muted,
    fontSize: 14,
    lineHeight: 21,
  },
  cardTitle: {
    color: colors.ink,
    fontSize: 17,
    fontWeight: '700',
  },
  buttonDisabled: {
    opacity: 0.52,
  },
  chip: {
    backgroundColor: '#F3F8FB',
    borderColor: '#DDEAF2',
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 13,
    paddingVertical: 8,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  chipSelected: {
    backgroundColor: '#EAF6F1',
    borderColor: '#8DD3B8',
  },
  chipText: {
    color: colors.muted,
    fontSize: 14,
    fontWeight: '600',
  },
  chipTextSelected: {
    color: '#377B63',
  },
  content: {
    gap: 14,
    paddingBottom: 168,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    marginBottom: 18,
    paddingHorizontal: 18,
    paddingTop: 24,
  },
  headerCopy: {
    flex: 1,
  },
  headerSpacer: {
    width: 44,
  },
  flexButton: {
    flex: 1,
  },
  input: {
    backgroundColor: '#F8FBFD',
    borderColor: '#DDEAF2',
    borderRadius: 14,
    borderWidth: 1,
    color: colors.ink,
    fontSize: 15,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  loadingText: {
    color: colors.muted,
    marginTop: 80,
    textAlign: 'center',
  },
  notice: {
    color: '#3D8B6C',
    fontSize: 14,
    lineHeight: 20,
  },
  noticeWarning: {
    color: '#BA6B46',
  },
  modeBadge: {
    backgroundColor: '#F3F8FB',
    borderColor: '#DDEAF2',
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  modeBadgeActive: {
    backgroundColor: '#EAF6F1',
    borderColor: '#8DD3B8',
  },
  modeBadgeText: {
    color: colors.muted,
    fontSize: 13,
    fontWeight: '700',
  },
  modeBadgeTextActive: {
    color: '#377B63',
  },
  page: {
    backgroundColor: '#F3FAFD',
    flex: 1,
  },
  primaryButton: {
    alignItems: 'center',
    backgroundColor: '#6BAFD6',
    borderRadius: 14,
    flex: 1,
    paddingVertical: 12,
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
  },
  privacyCard: {
    backgroundColor: '#FFF9EA',
    borderColor: '#F1D899',
    borderRadius: 18,
    borderWidth: 1,
    gap: 8,
    padding: 16,
  },
  privacyTitle: {
    color: colors.ink,
    fontSize: 16,
    fontWeight: '700',
  },
  rowBetween: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 14,
    justifyContent: 'space-between',
  },
  rowCopy: {
    flex: 1,
    gap: 5,
  },
  secondaryButton: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderColor: '#CFE3EF',
    borderRadius: 14,
    borderWidth: 1,
    flex: 1,
    paddingVertical: 12,
  },
  secondaryButtonText: {
    color: '#477A98',
    fontSize: 15,
    fontWeight: '700',
  },
  smallButton: {
    backgroundColor: '#EAF6F1',
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  smallButtonText: {
    color: '#377B63',
    fontSize: 14,
    fontWeight: '700',
  },
  statusGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  statusPill: {
    backgroundColor: '#F8FBFD',
    borderColor: '#DDEAF2',
    borderRadius: 14,
    borderWidth: 1,
    flexGrow: 1,
    minWidth: 96,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  statusPillWarning: {
    backgroundColor: '#FFF8EC',
    borderColor: '#E9C985',
  },
  statusPillLabel: {
    color: colors.muted,
    fontSize: 12,
    lineHeight: 17,
  },
  statusPillValue: {
    color: colors.ink,
    fontSize: 14,
    fontWeight: '700',
    lineHeight: 19,
    marginTop: 2,
  },
  statusLine: {
    color: colors.ink,
    fontSize: 14,
    lineHeight: 21,
  },
  stopButton: {
    alignItems: 'center',
    backgroundColor: '#FFF0EB',
    borderColor: '#F2C6B7',
    borderRadius: 14,
    borderWidth: 1,
    paddingVertical: 12,
  },
  stopButtonText: {
    color: '#B8664E',
    fontSize: 15,
    fontWeight: '700',
  },
  subtitle: {
    color: colors.muted,
    fontSize: 14,
    marginTop: 3,
  },
  title: {
    color: colors.ink,
    fontSize: 27,
    fontWeight: '800',
  },
  warningText: {
    color: '#BA6B46',
    fontSize: 14,
    lineHeight: 20,
  },
});
