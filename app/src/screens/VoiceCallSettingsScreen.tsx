import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Alert, AppState, Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppText as Text, AppTextInput as TextInput } from '../components/AppText';
import { colors } from '../theme/colors';
import type { Navigate } from '../types/navigation';
import {
  clearVoiceCallSecrets,
  defaultVoiceCallSettings,
  getVoiceCallReadiness,
  loadVoiceCallSettings,
  saveVoiceCallSettings,
  type VoiceCallSecrets,
  type VoiceCallSettings,
  type VoiceCallSttProvider,
} from '../voiceCall/voiceCallSettings';
import {
  fetchVoiceCallBudget,
  fetchVoiceCallReadiness,
  testVoiceCallLine,
  type VoiceCallBackendReadiness,
  type VoiceCallBudgetSnapshot,
  type VoiceCallLineTestResult,
} from '../voiceCall/voiceCallRoomClient';
import {
  cancelNativeIncomingCall,
  getIncomingCallCapabilityStatus,
  loadNativeIncomingCallRecords,
  openIncomingCallExactAlarmSettings,
  openIncomingCallFullScreenSettings,
  openIncomingCallXiaomiSettings,
  scheduleNativeIncomingCall,
  type IncomingCallCapabilityStatus,
} from '../backend/incomingCallNative';
import { formatVoiceCallPromptTime } from '../voiceCall/voiceCallInvitationPrompt';
import { VoiceCallDiagnosticsPanel } from '../voiceCall/VoiceCallDiagnosticsPanel';
import { VoiceCallVocabularyPanel } from '../voiceCall/VoiceCallVocabularyPanel';
import {
  formatVoiceCallScheduledDateInput,
  formatVoiceCallScheduledTimeInput,
  parseVoiceCallScheduledTime,
} from '../voiceCall/voiceCallScheduledTime';
import {
  clearRecentMissedVoiceCalls,
  createVoiceCallInvitation,
  loadRecentMissedVoiceCalls,
  loadVoiceCallInvitations,
  updateVoiceCallInvitationNativeTaskId,
  updateVoiceCallInvitationStatus,
  type VoiceCallInvitation,
  type VoiceCallMissedEvent,
} from '../voiceCall/voiceCallInvitationStore';

type Props = {
  navigate: Navigate;
  onStartRealVoiceCallTest: () => void;
  onStartVoiceCallTest: () => void;
};

type Notice = { kind: 'success' | 'error'; text: string } | null;

const sttProviderOptions: Array<{ available: boolean; label: string; note: string; value: VoiceCallSttProvider }> = [
  { available: true, label: '本地 FunASR', note: '后端本地识别', value: 'funasr' },
  { available: false, label: '云端 ASR', note: '尚未接入', value: 'cloud' },
];

function numberText(value: number) {
  return Number.isFinite(value) ? String(value) : '';
}

function parseIntegerText(value: string, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

function formatTokenExpiresAt(expiresAtSeconds: number) {
  if (!Number.isFinite(expiresAtSeconds)) return '未知';
  const date = new Date(expiresAtSeconds * 1000);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  return `${month}-${day} ${hour}:${minute}`;
}

function formatTtsProvider(provider: string | null | undefined) {
  if (provider === 'siliconflow_clone') return '硅基流动克隆音色';
  if (provider === 'preset_backend_audio') return '电脑本地测试音频';
  return '尚未读取';
}

function initialScheduleFields() {
  const date = new Date(Date.now() + 10 * 60 * 1000);
  return {
    date: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`,
    time: `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`,
  };
}

export function VoiceCallSettingsScreen({ navigate, onStartRealVoiceCallTest, onStartVoiceCallTest }: Props) {
  const insets = useSafeAreaInsets();
  const [settings, setSettings] = useState<VoiceCallSettings>(defaultVoiceCallSettings);
  const [secrets, setSecrets] = useState<VoiceCallSecrets>({
    minimaxApiKey: '',
    minimaxGroupId: '',
    minimaxVoiceId: '',
    voiceCallApiToken: '',
  });
  const [dailyCharacterLimitText, setDailyCharacterLimitText] = useState(numberText(defaultVoiceCallSettings.dailyCharacterLimit));
  const [maxCallMinutesText, setMaxCallMinutesText] = useState(numberText(defaultVoiceCallSettings.maxCallMinutes));
  const [maxNewSynthesesText, setMaxNewSynthesesText] = useState(numberText(defaultVoiceCallSettings.maxNewSynthesesPerCall));
  const [showSecrets, setShowSecrets] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [lineTestResult, setLineTestResult] = useState<VoiceCallLineTestResult | null>(null);
  const [lineTesting, setLineTesting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [launchingRealCall, setLaunchingRealCall] = useState(false);
  const [incomingCapability, setIncomingCapability] = useState<IncomingCallCapabilityStatus | null>(null);
  const [invitations, setInvitations] = useState<VoiceCallInvitation[]>([]);
  const [missedCalls, setMissedCalls] = useState<VoiceCallMissedEvent[]>([]);
  const initialSchedule = useMemo(initialScheduleFields, []);
  const [scheduledDate, setScheduledDate] = useState(initialSchedule.date);
  const [scheduledTime, setScheduledTime] = useState(initialSchedule.time);
  const [scheduledNote, setScheduledNote] = useState('');
  const [editingInvitationId, setEditingInvitationId] = useState<string | null>(null);
  const [incomingBusy, setIncomingBusy] = useState(false);
  const [clearingMissedCalls, setClearingMissedCalls] = useState(false);
  const [backendReadiness, setBackendReadiness] = useState<VoiceCallBackendReadiness | null>(null);
  const [budgetSnapshot, setBudgetSnapshot] = useState<VoiceCallBudgetSnapshot | null>(null);
  const [diagnosticsVisible, setDiagnosticsVisible] = useState(false);
  const [vocabularyVisible, setVocabularyVisible] = useState(false);

  const refreshVoiceBudget = async () => {
    const [readinessResult, budgetResult] = await Promise.all([
      fetchVoiceCallReadiness(),
      fetchVoiceCallBudget(),
    ]);
    setBackendReadiness(readinessResult.data);
    setBudgetSnapshot(budgetResult.data);
  };

  const refreshIncomingData = async () => {
    const [capability, nativeRecords] = await Promise.all([
      getIncomingCallCapabilityStatus(),
      loadNativeIncomingCallRecords(),
    ]);
    await Promise.all(nativeRecords.map((record) => (
      updateVoiceCallInvitationStatus(record.invitationId, record.status, record.updatedAt).catch(() => null)
    )));
    const [storedInvitations, storedMissed] = await Promise.all([
      loadVoiceCallInvitations(),
      loadRecentMissedVoiceCalls(),
    ]);
    setIncomingCapability(capability);
    setInvitations(storedInvitations);
    setMissedCalls(storedMissed);
  };

  useEffect(() => {
    let mounted = true;
    void loadVoiceCallSettings()
      .then((snapshot) => {
        if (!mounted) return;
        setSettings(snapshot.settings);
        setSecrets(snapshot.secrets);
        setDailyCharacterLimitText(numberText(snapshot.settings.dailyCharacterLimit));
        setMaxCallMinutesText(numberText(snapshot.settings.maxCallMinutes));
        setMaxNewSynthesesText(numberText(snapshot.settings.maxNewSynthesesPerCall));
      })
      .catch(() => {
        if (mounted) setNotice({ kind: 'error', text: '语音通话配置暂时读取失败。' });
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!launchingRealCall) return;
    const timer = setTimeout(() => setLaunchingRealCall(false), 1500);
    return () => clearTimeout(timer);
  }, [launchingRealCall]);

  useEffect(() => {
    void refreshIncomingData().catch(() => undefined);
    void refreshVoiceBudget().catch(() => undefined);
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refreshIncomingData().catch(() => undefined);
    });
    return () => subscription.remove();
  }, []);

  const readiness = useMemo(() => getVoiceCallReadiness(settings, secrets), [secrets, settings]);

  const persistSettings = async (): Promise<boolean> => {
    setSaving(true);
    setNotice(null);
    const nextSettings: VoiceCallSettings = {
      ...settings,
      dailyCharacterLimit: parseIntegerText(dailyCharacterLimitText, settings.dailyCharacterLimit, 100, 200000),
      maxCallMinutes: parseIntegerText(maxCallMinutesText, settings.maxCallMinutes, 1, 180),
      maxNewSynthesesPerCall: parseIntegerText(maxNewSynthesesText, settings.maxNewSynthesesPerCall, 1, 20),
      minimaxBaseUrl: settings.minimaxBaseUrl.trim().replace(/\/+$/, '') || defaultVoiceCallSettings.minimaxBaseUrl,
      minimaxModel: settings.minimaxModel.trim() || defaultVoiceCallSettings.minimaxModel,
      saveRawAudio: false,
    };
    try {
      const normalized = await saveVoiceCallSettings(nextSettings, secrets);
      setSettings(normalized);
      setDailyCharacterLimitText(numberText(normalized.dailyCharacterLimit));
      setMaxCallMinutesText(numberText(normalized.maxCallMinutes));
      setMaxNewSynthesesText(numberText(normalized.maxNewSynthesesPerCall));
      setSecrets((current) => ({
        minimaxApiKey: current.minimaxApiKey.trim(),
        minimaxGroupId: current.minimaxGroupId.trim(),
        minimaxVoiceId: current.minimaxVoiceId.trim(),
        voiceCallApiToken: current.voiceCallApiToken.trim(),
      }));
      setNotice({ kind: 'success', text: '语音通话配置已经保存。' });
      void refreshVoiceBudget().catch(() => undefined);
      return true;
    } catch {
      setNotice({ kind: 'error', text: '保存失败，请稍后再试。' });
      return false;
    } finally {
      setSaving(false);
    }
  };

  const confirmClearSecrets = () => {
    Alert.alert('清空语音密钥？', '会清空本地语音后端访问令牌、MiniMax API Key、Group ID 和 voice ID；非敏感配置会保留。', [
      { text: '取消', style: 'cancel' },
      {
        text: '清空',
        style: 'destructive',
        onPress: () => {
          void clearVoiceCallSecrets()
            .then((empty) => {
              setSecrets(empty);
              setNotice({ kind: 'success', text: '语音密钥已经清空。' });
            })
            .catch(() => setNotice({ kind: 'error', text: '清空失败，请稍后再试。' }));
        },
      },
    ]);
  };

  const runTestCall = () => {
    setNotice({ kind: 'success', text: '正在打开测试来电壳；这还不代表真实语音链路已接通。' });
    onStartVoiceCallTest();
  };

  const runRealCallTest = () => {
    if (saving || launchingRealCall) return;
    setLaunchingRealCall(true);
    setNotice({ kind: 'success', text: '正在打开真实接线测试；接听后会请求麦克风并加入 LiveKit 房间。' });
    requestAnimationFrame(onStartRealVoiceCallTest);
  };

  const runLineTest = () => {
    if (lineTesting) return;
    setLineTesting(true);
    setNotice(null);
    void testVoiceCallLine()
      .then((result) => {
        setLineTestResult(result);
        setNotice({ kind: result.ok ? 'success' : 'error', text: result.message });
      })
      .catch(() => {
        setLineTestResult({ ok: false, message: '电话线测试失败，请稍后再试。', testedAt: Date.now() });
        setNotice({ kind: 'error', text: '电话线测试失败，请稍后再试。' });
      })
      .finally(() => setLineTesting(false));
  };

  const saveScheduledIncomingCall = () => {
    if (incomingBusy) return;
    const scheduledAt = parseVoiceCallScheduledTime(scheduledDate.trim(), scheduledTime.trim());
    if (!scheduledNote.trim()) {
      setNotice({ kind: 'error', text: '约定内容不能为空。' });
      return;
    }
    if (!scheduledAt) {
      setNotice({ kind: 'error', text: '请填写未来的日期与时间，例如 2026-08-21 和 20:30。' });
      return;
    }
    setIncomingBusy(true);
    void createVoiceCallInvitation({
      invitationId: editingInvitationId ?? undefined,
      kind: 'scheduled',
      note: scheduledNote,
      scheduledAt,
    }).then(async (invitation) => {
      try {
        const scheduled = await scheduleNativeIncomingCall(invitation);
        await updateVoiceCallInvitationNativeTaskId(invitation.invitationId, scheduled.nativeTaskId);
      } catch (error) {
        await updateVoiceCallInvitationStatus(invitation.invitationId, 'failed');
        throw error;
      }
      setEditingInvitationId(null);
      setScheduledNote('');
      setNotice({ kind: 'success', text: '约定来电已经交给手机系统。' });
      await refreshIncomingData();
    }).catch(() => {
      setNotice({ kind: 'error', text: '约定来电没有安排成功，请检查精确闹钟和通知权限。' });
    }).finally(() => setIncomingBusy(false));
  };

  const editScheduledIncomingCall = (invitation: VoiceCallInvitation) => {
    const date = new Date(invitation.scheduledAt);
    setScheduledDate(`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`);
    setScheduledTime(`${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`);
    setScheduledNote(invitation.note ?? '');
    setEditingInvitationId(invitation.invitationId);
  };

  const cancelScheduledIncomingCall = (invitationId: string) => {
    if (incomingBusy) return;
    setIncomingBusy(true);
    void cancelNativeIncomingCall(invitationId)
      .then(() => updateVoiceCallInvitationStatus(invitationId, 'cancelled'))
      .then(refreshIncomingData)
      .catch(() => setNotice({ kind: 'error', text: '这次约定来电没有取消成功。' }))
      .finally(() => setIncomingBusy(false));
  };

  const runIncomingCallTest = () => {
    if (incomingBusy) return;
    setIncomingBusy(true);
    const scheduledAt = Date.now() + 10_000;
    void createVoiceCallInvitation({ isTest: true, kind: 'autonomous', scheduledAt })
      .then(async (invitation) => {
        const scheduled = await scheduleNativeIncomingCall(invitation);
        await updateVoiceCallInvitationNativeTaskId(invitation.invitationId, scheduled.nativeTaskId);
        setNotice({ kind: 'success', text: '测试主动来电会在 10 秒后响铃，不计入正式记录。' });
        await refreshIncomingData();
      })
      .catch(() => setNotice({ kind: 'error', text: '测试主动来电没有安排成功。' }))
      .finally(() => setIncomingBusy(false));
  };

  const clearMissedCallHistory = () => {
    if (clearingMissedCalls) return;
    setClearingMissedCalls(true);
    setNotice({ kind: 'success', text: '正在清空未接记录...' });
    void clearRecentMissedVoiceCalls()
      .then(refreshIncomingData)
      .then(() => setNotice({ kind: 'success', text: '未接记录已经清空。' }))
      .catch(() => setNotice({ kind: 'error', text: '未接记录暂时没有清空，请稍后再试。' }))
      .finally(() => setClearingMissedCalls(false));
  };

  return (
    <View style={styles.page}>
      <View style={styles.header}>
        <Pressable accessibilityLabel="返回设置" onPress={() => navigate('settings')} style={styles.backButton}>
          <Text style={styles.backText}>‹</Text>
        </Pressable>
        <Text style={styles.title}>语音通话</Text>
        <View style={styles.headerSpacer} />
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="打开通话诊断"
        onPress={() => setDiagnosticsVisible(true)}
        style={({ pressed }) => [styles.secondaryButton, styles.diagnosticsButton, pressed && { opacity: 0.7 }]}
      >
        <Text style={styles.secondaryButtonText}>通话诊断</Text>
      </Pressable>

      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: Math.max(insets.bottom + 96, 132) }]}
        showsVerticalScrollIndicator={false}
      >
        <View style={[styles.statusCard, readiness.kind === 'ready' && styles.statusCardReady]}>
          <Text style={styles.statusLabel}>{readiness.label}</Text>
          <Text style={styles.statusDetail}>{readiness.detail}</Text>
          <Text style={styles.statusFootnote}>
            LiveKit、手机原生收音和 VAD 已接入；通话文字由电脑后端的本地 FunASR 识别。
          </Text>
        </View>

        {notice ? (
          <View style={[styles.notice, notice.kind === 'success' ? styles.noticeSuccess : styles.noticeError]}>
            <Text style={styles.noticeText}>{notice.text}</Text>
          </View>
        ) : null}

        {loading ? (
          <Text style={styles.loadingText}>正在读取语音通话配置...</Text>
        ) : (
          <>
            <Section title="总开关">
              <ToggleRow
                enabled={settings.enabled}
                label="启用语音通话"
                note="关闭时不会自动进入真实语音链路；测试来电壳仍可手动打开。"
                onValueChange={(enabled) => setSettings((current) => ({ ...current, enabled }))}
              />
              <ToggleRow
                enabled={settings.autonomousIncomingCallsEnabled}
                label="允许云云自主来电"
                note="默认关闭；开启后仍受每天 2 次、3 小时间隔和作息边界保护。"
                onValueChange={(autonomousIncomingCallsEnabled) => setSettings((current) => ({ ...current, autonomousIncomingCallsEnabled }))}
              />
            </Section>

            <Section title="来电能力">
              <FixedRow label="原生来电" value={incomingCapability?.available ? '可用' : '不可用'} note="负责后台、锁屏、铃声、接听、拒接和 60 秒超时。" />
              <FixedRow label="精确时间" value={incomingCapability?.exactAlarmAllowed ? '已允许' : '未允许'} note="约定来电和延时自主来电需要这项系统能力。" />
              {!incomingCapability?.exactAlarmAllowed ? (
                <Pressable onPress={() => void openIncomingCallExactAlarmSettings().catch(() => undefined)} style={styles.revealButton}>
                  <Text style={styles.revealText}>打开精确时间权限</Text>
                </Pressable>
              ) : null}
              <FixedRow label="来电通知" value={incomingCapability?.notificationsAllowed ? '已允许' : '未允许'} note="未允许时系统无法展示后台来电。" />
              <FixedRow label="锁屏全屏" value={incomingCapability?.fullScreenIntentAllowed ? '已允许' : '通知降级'} note="未允许时仍会显示高优先级来电通知。" />
              {!incomingCapability?.fullScreenIntentAllowed ? (
                <Pressable onPress={() => void openIncomingCallFullScreenSettings().catch(() => undefined)} style={styles.revealButton}>
                  <Text style={styles.revealText}>打开系统全屏来电权限</Text>
                </Pressable>
              ) : null}
              {incomingCapability?.xiaomiPermissionRequired ? (
                <>
                  <FixedRow
                    label="小米锁屏显示"
                    value={incomingCapability.showOnLockScreenAllowed ? '已允许' : '未允许'}
                    note="允许君落在锁屏上直接显示白云小姐的来电页。"
                  />
                  <FixedRow
                    label="小米后台打开页面"
                    value={incomingCapability.backgroundStartAllowed ? '已允许' : '未允许'}
                    note="允许响铃时从桌面或其他页面直接进入来电页。"
                  />
                  {!incomingCapability.showOnLockScreenAllowed || !incomingCapability.backgroundStartAllowed ? (
                    <Pressable onPress={() => void openIncomingCallXiaomiSettings().catch(() => undefined)} style={styles.revealButton}>
                      <Text style={styles.revealText}>打开小米来电权限</Text>
                    </Pressable>
                  ) : null}
                </>
              ) : null}
            </Section>

            <Section title="约定来电">
              <Field label="日期">
                <TextInput
                  keyboardType="number-pad"
                  maxLength={10}
                  onChangeText={(value) => setScheduledDate(formatVoiceCallScheduledDateInput(value))}
                  placeholder="YYYY-MM-DD"
                  placeholderTextColor="#9EA7B3"
                  selectTextOnFocus
                  style={styles.input}
                  value={scheduledDate}
                />
              </Field>
              <Field label="时间">
                <TextInput
                  keyboardType="number-pad"
                  maxLength={5}
                  onChangeText={(value) => setScheduledTime(formatVoiceCallScheduledTimeInput(value))}
                  placeholder="HH:mm"
                  placeholderTextColor="#9EA7B3"
                  selectTextOnFocus
                  style={styles.input}
                  value={scheduledTime}
                />
              </Field>
              <Field label="约定内容">
                <TextInput multiline onChangeText={setScheduledNote} placeholder="这通电话约好了什么" placeholderTextColor="#9EA7B3" style={[styles.input, styles.noteInput]} value={scheduledNote} />
              </Field>
              <Pressable disabled={incomingBusy} onPress={saveScheduledIncomingCall} style={[styles.secondaryButton, incomingBusy && styles.disabledButton]}>
                <Text style={styles.secondaryButtonText}>{editingInvitationId ? '保存这次约定' : '新增一次约定来电'}</Text>
              </Pressable>
              {invitations.filter((item) => item.kind === 'scheduled' && item.status === 'scheduled').map((item) => (
                <View key={item.invitationId} style={styles.incomingRecord}>
                  <Text style={styles.toggleLabel}>{formatVoiceCallPromptTime(item.scheduledAt)}</Text>
                  <Text style={styles.toggleNote}>{item.note}</Text>
                  <View style={styles.inlineActions}>
                    <Pressable onPress={() => editScheduledIncomingCall(item)} style={styles.smallButton}><Text style={styles.revealText}>编辑</Text></Pressable>
                    <Pressable onPress={() => cancelScheduledIncomingCall(item.invitationId)} style={styles.smallButton}><Text style={styles.dangerButtonText}>取消</Text></Pressable>
                  </View>
                </View>
              ))}
              <Pressable disabled={incomingBusy} onPress={runIncomingCallTest} style={[styles.secondaryButton, incomingBusy && styles.disabledButton]}>
                <Text style={styles.secondaryButtonText}>测试主动来电（10 秒）</Text>
              </Pressable>
            </Section>

            <Section title="最近未接">
              {missedCalls.length ? missedCalls.map((item) => (
                <View key={item.invitationId} style={styles.incomingRecord}>
                  <Text style={styles.toggleLabel}>{formatVoiceCallPromptTime(item.calledAt)}</Text>
                  <Text style={styles.toggleNote}>{item.outcome === 'declined' ? '主动拒接' : '响铃超时'}{item.note ? ` · ${item.note}` : ''}</Text>
                </View>
              )) : <Text style={styles.sectionHint}>最近 7 天没有未接来电。</Text>}
              {missedCalls.length ? (
                <Pressable
                  disabled={clearingMissedCalls}
                  onPress={clearMissedCallHistory}
                  style={[styles.dangerButton, clearingMissedCalls && styles.disabledButton]}
                >
                  <Text style={styles.dangerButtonText}>{clearingMissedCalls ? '正在清空...' : '清空未接记录'}</Text>
                </Pressable>
              ) : null}
            </Section>

            <Section title="电脑语音后端">
              <SecretField
                label="本地语音后端访问令牌"
                onChangeText={(voiceCallApiToken) => setSecrets((current) => ({ ...current, voiceCallApiToken }))}
                placeholder="在电脑小管家点“复制电话线令牌”"
                secure={!showSecrets}
                value={secrets.voiceCallApiToken}
              />
              <FixedRow
                label="实际 TTS provider"
                value={formatTtsProvider(backendReadiness?.ttsProvider)}
                note="由电脑后端返回；旧 MiniMax 配置仍保留在本地，但不再参与语音通话就绪判断。"
              />
              <Pressable onPress={() => setShowSecrets((current) => !current)} style={styles.revealButton}>
                <Text style={styles.revealText}>{showSecrets ? '隐藏密钥' : '显示密钥'}</Text>
              </Pressable>
            </Section>

            <Section title="预算与记录">
              <Field label="每日语音额度（约合汉字）">
                <TextInput
                  keyboardType="number-pad"
                  onChangeText={setDailyCharacterLimitText}
                  placeholder="3000"
                  placeholderTextColor="#9EA7B3"
                  style={styles.input}
                  value={dailyCharacterLimitText}
                />
              </Field>
              <Field label="单通最多新合成次数">
                <TextInput
                  keyboardType="number-pad"
                  onChangeText={setMaxNewSynthesesText}
                  placeholder="4"
                  placeholderTextColor="#9EA7B3"
                  style={styles.input}
                  value={maxNewSynthesesText}
                />
              </Field>
              <Field label="单次通话最长分钟">
                <TextInput
                  keyboardType="number-pad"
                  onChangeText={setMaxCallMinutesText}
                  placeholder="10"
                  placeholderTextColor="#9EA7B3"
                  style={styles.input}
                  value={maxCallMinutesText}
                />
              </Field>
              <FixedRow
                label="今日语音额度"
                value={budgetSnapshot
                  ? `${Math.ceil(budgetSnapshot.used_utf8_bytes / 3)} / ${Math.floor(budgetSnapshot.daily_limit_utf8_bytes / 3)} 字`
                  : '尚未读取'}
                note={budgetSnapshot
                  ? `精确已用 ${budgetSnapshot.used_utf8_bytes} 字节，剩余 ${budgetSnapshot.remaining_utf8_bytes} 字节。`
                  : '保存配置并连接电脑后端后显示。'}
              />
              <FixedRow
                label="今日合成结果"
                value={budgetSnapshot
                  ? `成功 ${budgetSnapshot.completed_count} · 失败 ${budgetSnapshot.failed_count} · 缓存 ${budgetSnapshot.cache_hit_count}`
                  : '尚未读取'}
                note="君落本地统计不等同于硅基流动账户余额或最终账单。"
              />
              <ToggleRow
                enabled={settings.saveCallSummary}
                label="保存通话摘要"
                note="只保存文字摘要和必要诊断；不默认保存原始录音。"
                onValueChange={(saveCallSummary) => setSettings((current) => ({ ...current, saveCallSummary }))}
              />
              <FixedRow label="保存原始录音" value="关闭" note="第三章固定关闭；以后也需要单独确认才会打开。" />
            </Section>

            <Section title="听见我">
              <Pressable onPress={() => setVocabularyVisible(true)} style={styles.secondaryButton}>
                <Text style={styles.secondaryButtonText}>私人词表</Text>
              </Pressable>
              <Text style={styles.sectionHint}>语音通话默认使用电脑后端的本地 FunASR，不调用付费云端识别。</Text>
              <View style={styles.providerRow}>
                {sttProviderOptions.map((option) => (
                  <Pressable
                    disabled={!option.available}
                    key={option.value}
                    onPress={() => setSettings((current) => ({ ...current, sttProvider: option.value }))}
                    style={[styles.providerChip, settings.sttProvider === option.value && styles.providerChipSelected, !option.available && styles.providerChipDisabled]}
                  >
                    <Text style={settings.sttProvider === option.value ? styles.providerChipTextSelected : styles.providerChipText}>
                      {option.label}
                    </Text>
                    <Text style={styles.providerChipNote}>{option.note}</Text>
                  </Pressable>
                ))}
              </View>
              <FixedRow
                label="手机内置识别"
                value="语音消息专用"
                note="通话中由原生 AudioRecord 占用麦克风，手机 SpeechRecognizer 不会同时启动。"
              />
              <ToggleRow
                enabled={settings.emotion2vecEnabled}
                label="emotion2vec 声音情绪识别"
                note="每轮语音结束后在电脑本地整理可能的情绪倾向；不会保存原始录音。"
                onValueChange={(emotion2vecEnabled) => setSettings((current) => ({ ...current, emotion2vecEnabled }))}
              />
            </Section>

            <LineTestPanel result={lineTestResult} />

            <View style={styles.actions}>
              <Pressable disabled={saving} onPress={persistSettings} style={[styles.primaryButton, saving && styles.disabledButton]}>
                <Text style={styles.primaryButtonText}>{saving ? '保存中...' : '保存语音配置'}</Text>
              </Pressable>
              <Pressable disabled={lineTesting} onPress={runLineTest} style={[styles.secondaryButton, lineTesting && styles.disabledButton]}>
                <Text style={styles.secondaryButtonText}>{lineTesting ? '测试中...' : '测试电话线'}</Text>
              </Pressable>
              <Pressable
                disabled={saving || launchingRealCall}
                onPress={runRealCallTest}
                style={[styles.secondaryButton, (saving || launchingRealCall) && styles.disabledButton]}
              >
                <Text style={styles.secondaryButtonText}>{launchingRealCall ? '正在打开...' : '测试真实接线'}</Text>
              </Pressable>
              <Pressable onPress={runTestCall} style={styles.secondaryButton}>
                <Text style={styles.secondaryButtonText}>测试来电壳</Text>
              </Pressable>
              <Pressable onPress={confirmClearSecrets} style={styles.dangerButton}>
                <Text style={styles.dangerButtonText}>清空语音密钥</Text>
              </Pressable>
            </View>
          </>
        )}
      </ScrollView>
      <VoiceCallDiagnosticsPanel onClose={() => setDiagnosticsVisible(false)} visible={diagnosticsVisible} />
      <VoiceCallVocabularyPanel onClose={() => setVocabularyVisible(false)} visible={vocabularyVisible} />
    </View>
  );
}

function LineTestPanel({ result }: { result: VoiceCallLineTestResult | null }) {
  if (!result) return null;
  return (
    <View style={[styles.linePanel, result.ok ? styles.linePanelOk : styles.linePanelError]}>
      <Text style={styles.lineTitle}>{result.ok ? '电话线可用' : '电话线未接通'}</Text>
      <Text style={styles.lineText}>{result.message}</Text>
      {result.ok ? (
        <>
          <Text style={styles.lineMeta}>房间：{result.data.roomName}</Text>
          <Text style={styles.lineMeta}>身份：{result.data.participantIdentity}</Text>
          <Text style={styles.lineMeta}>LiveKit：{result.data.livekitUrl}</Text>
          <Text style={styles.lineMeta}>Token 到期：{formatTokenExpiresAt(result.data.expiresAt)}</Text>
        </>
      ) : result.baseUrl ? (
        <Text style={styles.lineMeta}>后端：{result.baseUrl}</Text>
      ) : null}
    </View>
  );
}

function Section({ children, title }: { children: ReactNode; title: string }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function Field({ children, label }: { children: ReactNode; label: string }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {children}
    </View>
  );
}

function SecretField({
  label,
  onChangeText,
  placeholder,
  secure,
  value,
}: {
  label: string;
  onChangeText: (value: string) => void;
  placeholder: string;
  secure: boolean;
  value: string;
}) {
  return (
    <Field label={label}>
      <TextInput
        autoCapitalize="none"
        autoCorrect={false}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor="#9EA7B3"
        secureTextEntry={secure}
        style={styles.input}
        value={value}
      />
    </Field>
  );
}

function ToggleRow({
  enabled,
  label,
  note,
  onValueChange,
}: {
  enabled: boolean;
  label: string;
  note: string;
  onValueChange: (enabled: boolean) => void;
}) {
  return (
    <View style={styles.toggleRow}>
      <View style={styles.toggleCopy}>
        <Text style={styles.toggleLabel}>{label}</Text>
        <Text style={styles.toggleNote}>{note}</Text>
      </View>
      <Switch
        onValueChange={onValueChange}
        thumbColor={enabled ? '#FFFFFF' : '#F8F5F2'}
        trackColor={{ false: '#D8DEE5', true: '#88BFA1' }}
        value={enabled}
      />
    </View>
  );
}

function FixedRow({ label, note, value }: { label: string; note: string; value: string }) {
  return (
    <View style={styles.fixedRow}>
      <View style={styles.toggleCopy}>
        <Text style={styles.toggleLabel}>{label}</Text>
        <Text style={styles.toggleNote}>{note}</Text>
      </View>
      <Text style={styles.fixedValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  page: {
    backgroundColor: '#F7F5F1',
    flex: 1,
    paddingHorizontal: 18,
    paddingTop: 24,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    height: 58,
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  backButton: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderColor: '#E4DDD3',
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
  title: {
    color: colors.ink,
    fontSize: 24,
    fontWeight: '700',
  },
  headerSpacer: {
    height: 44,
    width: 44,
  },
  content: {},
  diagnosticsButton: {
    marginBottom: 14,
  },
  statusCard: {
    backgroundColor: '#243244',
    borderRadius: 18,
    marginBottom: 14,
    paddingHorizontal: 16,
    paddingVertical: 15,
  },
  statusCardReady: {
    backgroundColor: '#244033',
  },
  statusLabel: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 6,
  },
  statusDetail: {
    color: 'rgba(255,255,255,0.86)',
    fontSize: 13,
    lineHeight: 20,
  },
  statusFootnote: {
    color: 'rgba(255,255,255,0.62)',
    fontSize: 11,
    lineHeight: 17,
    marginTop: 9,
  },
  notice: {
    borderRadius: 14,
    marginBottom: 13,
    paddingHorizontal: 13,
    paddingVertical: 10,
  },
  noticeSuccess: {
    backgroundColor: '#E4F2E5',
  },
  noticeError: {
    backgroundColor: '#FFE5E0',
  },
  noticeText: {
    color: colors.ink,
    fontSize: 12,
    lineHeight: 18,
  },
  loadingText: {
    color: colors.muted,
    fontSize: 13,
    lineHeight: 20,
    paddingVertical: 20,
    textAlign: 'center',
  },
  section: {
    backgroundColor: '#FFFFFF',
    borderColor: '#E7DED4',
    borderRadius: 18,
    borderWidth: 1,
    marginBottom: 14,
    padding: 14,
  },
  sectionTitle: {
    color: colors.ink,
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 10,
  },
  sectionHint: {
    color: colors.muted,
    fontSize: 12,
    lineHeight: 18,
    marginBottom: 10,
  },
  field: {
    marginBottom: 11,
  },
  fieldLabel: {
    color: colors.ink,
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 6,
  },
  input: {
    backgroundColor: '#F9FBFC',
    borderColor: '#DDE6EC',
    borderRadius: 13,
    borderWidth: 1,
    color: colors.ink,
    fontSize: 14,
    minHeight: 46,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  noteInput: {
    minHeight: 88,
    paddingTop: 14,
    textAlignVertical: 'top',
  },
  incomingRecord: {
    borderTopColor: '#E8E2DA',
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 6,
    paddingVertical: 12,
  },
  inlineActions: {
    flexDirection: 'row',
    gap: 10,
  },
  smallButton: {
    borderColor: '#D6DEE5',
    borderRadius: 7,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  revealButton: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: '#EDF2F5',
    borderRadius: 12,
    minHeight: 38,
    justifyContent: 'center',
    paddingHorizontal: 13,
  },
  revealText: {
    color: '#526D82',
    fontSize: 12,
    fontWeight: '700',
  },
  toggleRow: {
    alignItems: 'center',
    borderTopColor: '#F0E8E1',
    borderTopWidth: 1,
    flexDirection: 'row',
    gap: 12,
    minHeight: 64,
    paddingTop: 10,
  },
  toggleCopy: {
    flex: 1,
  },
  toggleLabel: {
    color: colors.ink,
    fontSize: 14,
    fontWeight: '700',
    marginBottom: 4,
  },
  toggleNote: {
    color: colors.muted,
    fontSize: 12,
    lineHeight: 18,
  },
  fixedRow: {
    alignItems: 'center',
    borderTopColor: '#F0E8E1',
    borderTopWidth: 1,
    flexDirection: 'row',
    gap: 12,
    minHeight: 64,
    paddingTop: 10,
  },
  fixedValue: {
    backgroundColor: '#F2F4F5',
    borderRadius: 11,
    color: '#77838D',
    fontSize: 12,
    fontWeight: '700',
    overflow: 'hidden',
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  providerRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 12,
  },
  providerChip: {
    backgroundColor: '#F1F4F6',
    borderColor: '#DCE5EA',
    borderRadius: 14,
    borderWidth: 1,
    minWidth: 96,
    paddingHorizontal: 11,
    paddingVertical: 9,
  },
  providerChipSelected: {
    backgroundColor: '#E1F2E8',
    borderColor: '#94C6A8',
  },
  providerChipDisabled: {
    opacity: 0.48,
  },
  providerChipText: {
    color: '#66727B',
    fontSize: 12,
    fontWeight: '700',
    marginBottom: 3,
  },
  providerChipTextSelected: {
    color: '#3C7B57',
    fontSize: 12,
    fontWeight: '700',
    marginBottom: 3,
  },
  providerChipNote: {
    color: '#8C98A3',
    fontSize: 10,
    lineHeight: 14,
  },
  linePanel: {
    borderRadius: 16,
    marginBottom: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  linePanelOk: {
    backgroundColor: '#E4F2E5',
    borderColor: '#B7DEC4',
    borderWidth: 1,
  },
  linePanelError: {
    backgroundColor: '#FFE5E0',
    borderColor: '#F1C0B8',
    borderWidth: 1,
  },
  lineTitle: {
    color: colors.ink,
    fontSize: 14,
    fontWeight: '700',
    marginBottom: 5,
  },
  lineText: {
    color: colors.ink,
    fontSize: 12,
    lineHeight: 18,
    marginBottom: 6,
  },
  lineMeta: {
    color: colors.muted,
    fontSize: 11,
    lineHeight: 17,
  },
  actions: {
    gap: 10,
    marginTop: 2,
  },
  primaryButton: {
    alignItems: 'center',
    backgroundColor: '#4B7E64',
    borderRadius: 15,
    justifyContent: 'center',
    minHeight: 48,
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
  secondaryButton: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderColor: '#D7E0E6',
    borderRadius: 15,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 46,
  },
  secondaryButtonText: {
    color: '#526D82',
    fontSize: 14,
    fontWeight: '700',
  },
  dangerButton: {
    alignItems: 'center',
    backgroundColor: '#FFE5E0',
    borderRadius: 15,
    justifyContent: 'center',
    minHeight: 46,
  },
  dangerButtonText: {
    color: '#BF5D52',
    fontSize: 14,
    fontWeight: '700',
  },
  disabledButton: {
    opacity: 0.58,
  },
});
