import * as Clipboard from 'expo-clipboard';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  TextInput,
  View,
} from 'react-native';
import QRCode from 'react-native-qrcode-svg';

import { loadBackendSettings } from '../backend/backendClient';
import {
  clearBackupRestoreSyncGate,
  loadBackupRestoreSyncGateSnapshot,
  subscribeBackupRestoreSyncGate,
} from '../backup/backupRestoreSyncGate';
import type {
  BackupRestoreSyncGateSnapshot,
} from '../backup/backupRestoreSyncGateCore';
import { AppText as Text } from '../components/AppText';
import { SyncObjectManagementCard } from '../components/SyncObjectManagementCard';
import {
  createAndroidDeviceManagementController,
} from '../sync/syncAndroidDeviceManagementExpo';
import type {
  AndroidDeviceDirectorySnapshotV1,
} from '../sync/syncAndroidDeviceManagement';
import {
  createAndroidNewWorldPairingInvitationController,
  createAndroidNewWorldRelayProvisioningController,
  loadAndroidNewWorldRelaySnapshot,
} from '../sync/syncNewWorldRelayExpo';
import type {
  NewWorldRelayProvisioningSnapshot,
} from '../sync/syncNewWorldRelayProvisioning';
import {
  continueEmergencySyncWorldRebuild,
  startEmergencySyncWorldRebuild,
} from '../sync/syncEmergencyWorldRebuildExpo';
import {
  loadEmergencySyncWorldRebuildSnapshot,
  subscribeEmergencySyncWorldRebuild,
} from '../sync/syncEmergencyWorldRebuildStore';
import {
  emergencySyncWorldRebuildSnapshot,
  type EmergencySyncWorldRebuildSnapshot,
} from '../sync/syncEmergencyWorldRebuild';
import {
  loadAndroidNewWorldLocalSnapshot,
} from '../sync/syncAndroidNewWorldController';
import {
  inspectAndroidNewWorldBaselinePublishState,
  publishNextAndroidNewWorldBaselineBatch,
} from '../sync/syncAndroidNewWorldBaselinePublisher';
import { loadCurrentSyncDevice } from '../sync/syncCurrentDevice';
import {
  normalizeSyncDeviceDisplayName,
  syncDevicePlatformPresentation,
  type SyncDevicePublicIdentityV1,
} from '../sync/syncDeviceContract';
import {
  listPendingAndroidCurrentStateRefreshRequests,
  prepareAndroidCurrentStateRefresh,
} from '../sync/syncCurrentStateRefreshAndroid';
import type { CurrentStateRefreshStatusV1 } from '../sync/syncFiniteHistory';
import { normalizeSyncRelayBaseUrl } from '../sync/syncRelayClient';
import type { AndroidManualSyncResult } from '../sync/syncAndroidManualSync';
import { colors } from '../theme/colors';
import type { Navigate } from '../types/navigation';
import {
  loadAutomaticDataSyncSnapshot,
  saveAutomaticDataSyncPolicy,
  subscribeAutomaticDataSyncSnapshot,
  type AutomaticDataSyncPolicyV1,
  type AutomaticDataSyncRuntimeStatusV1,
} from '../sync/automaticDataSyncPolicy';
import {
  registerAutomaticDataSyncBackgroundTask,
  unregisterAutomaticDataSyncBackgroundTask,
} from '../sync/automaticDataSyncBackgroundTask';
import { notifyAutomaticDataSyncWorkAvailable } from '../sync/automaticDataSyncEvents';
import {
  loadAutomaticDataSyncProgress,
  subscribeAutomaticDataSyncProgress,
} from '../sync/automaticDataSyncProgress';
import type { AutomaticDataSyncProgressV1 } from '../sync/automaticDataSyncProgressCore';
import { recordAndroidManualSyncProgress } from '../sync/automaticDataSyncRuntime';
import {
  activateAndroidNewWorldLiveCapture,
} from '../sync/syncAndroidNewWorldLiveCapture';

type Props = {
  navigate: Navigate;
  onAutomaticSyncExclusiveBusyChange?: (busy: boolean) => void;
};

type InvitationSnapshot = NonNullable<Awaited<ReturnType<
  ReturnType<typeof createAndroidNewWorldPairingInvitationController>['snapshot']
>>>;

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function shortId(value: string | null | undefined) {
  if (!value) return '—';
  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}

function formatTime(value: number | null | undefined) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(value);
}

function automaticSyncStatusLabel(status: AutomaticDataSyncRuntimeStatusV1) {
  switch (status.state) {
    case 'disabled': return '已关闭';
    case 'idle': return status.workRemaining ? '等待下一轮' : '等待变化';
    case 'checking': return '正在检查更新';
    case 'syncing': return '正在分批同步';
    case 'waiting-relay': return '等待电脑后端';
    case 'waiting-large-file-conditions': return '大文件等待 Wi‑Fi 和充电';
    case 'attention-required': return '需要整理不同版本或检查隔离项';
  }
}

function emergencyRebuildProgressLabel(
  snapshot: EmergencySyncWorldRebuildSnapshot,
) {
  switch (snapshot.phase) {
    case 'freezing-old-world':
    case 'revoking-old-devices':
      return '正在停下旧同步';
    case 'preparing-current-state':
      return `正在准备当前状态 · ${snapshot.completedAdapters}/${snapshot.totalAdapters}`;
    case 'preparing-current-files':
      return `正在整理当前文件 · ${snapshot.completedFiles}/${snapshot.totalFiles}`;
    case 'verifying-current-state':
      return '正在核对当前状态';
    case 'cutting-over':
      return '正在换到新世界';
    case 'complete':
      return '手机已进入新的同步世界';
    case 'blocked':
      return snapshot.missingFiles > 0
        ? `有 ${snapshot.missingFiles} 个当前文件在手机上找不到原文件。相关记录仍在，请补回文件后继续。`
        : '重新建立还没有完成。手机里的当前数据仍在，再次打开本页可以继续。';
    case 'idle':
      return '';
  }
}

function ActionButton({
  disabled = false,
  label,
  onPress,
  secondary = false,
}: {
  disabled?: boolean;
  label: string;
  onPress: () => void;
  secondary?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.actionButton,
        secondary && styles.actionButtonSecondary,
        disabled && styles.actionButtonDisabled,
        pressed && !disabled && styles.actionButtonPressed,
      ]}
    >
      <Text style={[
        styles.actionButtonText,
        secondary && styles.actionButtonTextSecondary,
      ]}>
        {label}
      </Text>
    </Pressable>
  );
}

function StatusPill({ children, tone = 'quiet' }: {
  children: string;
  tone?: 'quiet' | 'ready' | 'waiting';
}) {
  return (
    <View style={[
      styles.statusPill,
      tone === 'ready' && styles.statusPillReady,
      tone === 'waiting' && styles.statusPillWaiting,
    ]}>
      <View style={[
        styles.statusDot,
        tone === 'ready' && styles.statusDotReady,
        tone === 'waiting' && styles.statusDotWaiting,
      ]} />
      <Text style={styles.statusPillText}>{children}</Text>
    </View>
  );
}

function DeviceIdentityCard({ busy, identity, onRename }: {
  busy: boolean;
  identity: SyncDevicePublicIdentityV1;
  onRename: (displayName: string) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(identity.displayName);
  const presentation = syncDevicePlatformPresentation(identity.platform);
  const closeEditor = () => {
    setDraftName(identity.displayName);
    setEditing(false);
  };
  const saveName = async () => {
    const saved = await onRename(draftName);
    if (saved) setEditing(false);
  };
  return (
    <View style={styles.deviceCard}>
      <View style={styles.deviceGlyph}>
        <Text style={styles.deviceGlyphText}>▯</Text>
      </View>
      <View style={styles.deviceCopy}>
        <View style={styles.deviceTitleRow}>
          <Text numberOfLines={1} style={styles.deviceTitle}>
            {identity.displayName}
          </Text>
          <View style={styles.currentTag}>
            <Text style={styles.currentTagText}>这台手机</Text>
          </View>
        </View>
        <Text style={styles.deviceMeta}>
          {presentation.deviceType} · {presentation.platformName}
        </Text>
        <Text selectable style={styles.deviceId}>
          {shortId(identity.deviceId)}
        </Text>
        {editing ? (
          <View style={styles.renameEditor}>
            <Text style={styles.renameLabel}>设备昵称</Text>
            <TextInput
              accessibilityLabel="设备昵称"
              editable={!busy}
              maxLength={40}
              onChangeText={setDraftName}
              selectTextOnFocus
              style={styles.renameInput}
              value={draftName}
            />
            <View style={styles.renameActions}>
              <Pressable
                accessibilityRole="button"
                disabled={busy}
                onPress={closeEditor}
                style={({ pressed }) => [
                  styles.renameButton,
                  styles.renameButtonSecondary,
                  pressed && !busy && styles.renameButtonPressed,
                ]}
              >
                <Text style={styles.renameButtonSecondaryText}>取消</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                disabled={busy}
                onPress={() => void saveName()}
                style={({ pressed }) => [
                  styles.renameButton,
                  busy && styles.actionButtonDisabled,
                  pressed && !busy && styles.renameButtonPressed,
                ]}
              >
                <Text style={styles.renameButtonText}>
                  {busy ? '正在保存…' : '保存昵称'}
                </Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={() => {
              setDraftName(identity.displayName);
              setEditing(true);
            }}
            style={({ pressed }) => [
              styles.renameOpenButton,
              pressed && !busy && styles.renameButtonPressed,
            ]}
          >
            <Text style={styles.renameOpenButtonText}>修改昵称</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const deviceStateLabels = {
  pending: '等待登记',
  active: '已授权',
  revoked: '已撤销',
} as const;

function DeviceDirectoryCard({
  busy,
  relayReady,
  snapshot,
  onRefresh,
}: {
  busy: boolean;
  relayReady: boolean;
  snapshot: AndroidDeviceDirectorySnapshotV1 | null;
  onRefresh: () => void;
}) {
  return (
    <View style={styles.paperCard}>
      <View style={styles.cardHeader}>
        <View>
          <Text style={styles.cardTitle}>同一片云上的设备</Text>
        </View>
        <StatusPill tone={snapshot ? 'ready' : 'quiet'}>
          {snapshot ? '已刷新' : '尚未刷新'}
        </StatusPill>
      </View>
      <Text style={styles.cardDescription}>
        这里显示已经加入的手机和电脑。只有按下“刷新设备”才会联网读取目录。
      </Text>
      {snapshot?.devices.map((device) => (
        <View
          key={device.deviceId}
          style={[
            styles.managedDevice,
            device.isCurrent && styles.managedDeviceCurrent,
          ]}
        >
          <View style={styles.managedDeviceCopy}>
            <View style={styles.deviceTitleRow}>
              <Text numberOfLines={1} style={styles.deviceTitle}>
                {device.displayName}
              </Text>
              {device.isCurrent && (
                <View style={styles.currentTag}>
                  <Text style={styles.currentTagText}>这台手机</Text>
                </View>
              )}
            </View>
            <Text style={styles.deviceMeta}>
              {syncDevicePlatformPresentation(device.platform).deviceType}
              {' · '}
              {syncDevicePlatformPresentation(device.platform).platformName}
              {' · '}{deviceStateLabels[device.state]}
            </Text>
            <Text selectable style={styles.deviceId}>
              {shortId(device.deviceId)}
            </Text>
          </View>
        </View>
      ))}
      <ActionButton
        disabled={!relayReady || busy}
        label={busy ? '处理中…' : '刷新设备'}
        onPress={onRefresh}
        secondary
      />
      <Text style={styles.footnote}>
        打开本页不会自动联网或更改设备状态。
      </Text>
    </View>
  );
}

const invitationLabels: Record<InvitationSnapshot['state'], string> = {
  prepared: '待发布',
  published: '等待电脑',
  'request-received': '等待核对',
  'approval-prepared': '批准待提交',
  approved: '电脑领取中',
  consumed: '配对完成',
};

function InvitationCard({
  busy,
  invitation,
  relayReady,
  onApprove,
  onClearExpired,
  onCreate,
  onPublish,
  onRefresh,
  onResumeApproval,
}: {
  busy: boolean;
  invitation: InvitationSnapshot | null;
  relayReady: boolean;
  onApprove: () => void;
  onClearExpired: () => void;
  onCreate: () => void;
  onPublish: () => void;
  onRefresh: () => void;
  onResumeApproval: () => void;
}) {
  const expired = !!invitation && Date.now() > invitation.expiresAt;
  if (!invitation) {
    return (
      <View style={styles.paperCard}>
        <View style={styles.cardHeader}>
          <View>
            <Text style={styles.cardTitle}>添加电脑</Text>
          </View>
          <StatusPill>尚无邀请</StatusPill>
        </View>
        <Text style={styles.cardDescription}>
          用电脑扫描邀请二维码，并核对两边显示的六码确认码。邀请有效十五分钟。
        </Text>
        <ActionButton
          disabled={!relayReady || busy}
          label={busy ? '准备中…' : '生成电脑邀请'}
          onPress={onCreate}
        />
      </View>
    );
  }

  const waitingForRequest = ['prepared', 'published'].includes(invitation.state);
  const awaitingApproval = invitation.state === 'request-received';
  const resumableApproval = invitation.state === 'approval-prepared';
  return (
    <View style={styles.paperCard}>
      <View style={styles.cardHeader}>
        <View>
          <Text style={styles.cardTitle}>添加电脑</Text>
        </View>
        <StatusPill tone={invitation.state === 'consumed' ? 'ready' : 'waiting'}>
          {expired
            ? '已过期'
            : waitingForRequest
              ? '等待电脑申请加入'
              : invitationLabels[invitation.state]}
        </StatusPill>
      </View>

      {!expired && (
        <View style={styles.qrFrame}>
          <QRCode
            backgroundColor="#FFFFFF"
            color="#32465A"
            ecl="M"
            quietZone={12}
            size={210}
            value={invitation.qrPayload}
          />
        </View>
      )}
      <View style={styles.invitationMeta}>
        <View>
          <Text style={styles.metaLabel}>邀请 ID</Text>
          <Text selectable style={styles.metaValue}>{shortId(invitation.pairingId)}</Text>
        </View>
        <View>
          <Text style={styles.metaLabel}>有效至</Text>
          <Text style={styles.metaValue}>{formatTime(invitation.expiresAt)}</Text>
        </View>
      </View>
      {!expired && (
        <ActionButton
          label="复制邀请正文"
          onPress={() => void Clipboard.setStringAsync(invitation.qrPayload)}
          secondary
        />
      )}

      {invitation.newDevice && (
        <View style={styles.requestCard}>
          <Text style={styles.requestLabel}>请求加入的设备</Text>
          <Text style={styles.requestDevice}>{invitation.newDevice.displayName}</Text>
          <Text style={styles.requestMeta}>
            {invitation.newDevice.platform === 'windows' ? 'Windows 电脑' : invitation.newDevice.platform}
            {' · '}{shortId(invitation.newDevice.deviceId)}
          </Text>
        </View>
      )}

      {invitation.verificationCode && (
        <View style={styles.codePanel}>
          <Text style={styles.codeLabel}>两端都应该显示</Text>
          <Text selectable style={styles.codeValue}>
            {invitation.verificationCode.slice(0, 3)} {invitation.verificationCode.slice(3)}
          </Text>
          <Text style={styles.codeHelp}>电脑上不同就不要批准。</Text>
        </View>
      )}

      {awaitingApproval && !expired && (
        <ActionButton
          disabled={!invitation.verificationCode || busy}
          label={busy ? '批准中…' : '确认一致并批准'}
          onPress={onApprove}
        />
      )}
      {resumableApproval && !expired && (
        <ActionButton
          disabled={busy}
          label={busy ? '提交中…' : '继续提交已确认的批准'}
          onPress={onResumeApproval}
        />
      )}
      {expired ? (
        <ActionButton
          disabled={busy}
          label="清理过期邀请"
          onPress={onClearExpired}
        />
      ) : invitation.state === 'prepared' ? (
        <ActionButton
          disabled={busy}
          label={busy ? '发布中…' : '发布邀请'}
          onPress={onPublish}
        />
      ) : waitingForRequest || ['approved', 'consumed'].includes(invitation.state) ? (
        <ActionButton
          disabled={busy}
          label={busy ? '刷新中…' : '刷新邀请状态'}
          onPress={onRefresh}
          secondary
        />
      ) : null}
    </View>
  );
}

export function DeviceSyncSettingsScreen({
  navigate,
  onAutomaticSyncExclusiveBusyChange,
}: Props) {
  const [relayBaseUrl, setRelayBaseUrl] = useState('');
  const [currentIdentity, setCurrentIdentity] =
    useState<SyncDevicePublicIdentityV1 | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [deviceDirectory, setDeviceDirectory] =
    useState<AndroidDeviceDirectorySnapshotV1 | null>(null);
  const [manualSyncResult, setManualSyncResult] =
    useState<AndroidManualSyncResult | null>(null);
  const [automaticSyncPolicy, setAutomaticSyncPolicy] =
    useState<AutomaticDataSyncPolicyV1>({ enabled: false, version: 1 });
  const [automaticSyncStatus, setAutomaticSyncStatus] =
    useState<AutomaticDataSyncRuntimeStatusV1>({
      state: 'disabled',
      lastAttemptAt: null,
      lastSuccessAt: null,
      nextAttemptAt: null,
      consecutiveFailures: 0,
      workRemaining: false,
    });
  const [automaticSyncProgress, setAutomaticSyncProgress] =
    useState<AutomaticDataSyncProgressV1 | null>(null);
  const [objectRefreshToken, setObjectRefreshToken] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newWorldBaselineComplete, setNewWorldBaselineComplete] =
    useState(false);
  const [setupProgress, setSetupProgress] = useState(0);
  const [newWorldRelay, setNewWorldRelay] =
    useState<NewWorldRelayProvisioningSnapshot>({
      state: 'not-ready',
      registeredDevice: null,
    });
  const [newWorldInvitation, setNewWorldInvitation] =
    useState<InvitationSnapshot | null>(null);
  const [newWorldBaselinePublish, setNewWorldBaselinePublish] = useState<
    Awaited<ReturnType<typeof inspectAndroidNewWorldBaselinePublishState>>
    | null
  >(null);
  const [currentRefreshRequests, setCurrentRefreshRequests] =
    useState<CurrentStateRefreshStatusV1[]>([]);
  const [currentRefreshProgress, setCurrentRefreshProgress] = useState(0);
  const [emergencyRebuild, setEmergencyRebuild] =
    useState<EmergencySyncWorldRebuildSnapshot>(() => (
      emergencySyncWorldRebuildSnapshot(null)
    ));
  const [backupRestoreSyncGate, setBackupRestoreSyncGate] =
    useState<BackupRestoreSyncGateSnapshot>({
      state: 'idle',
      rebuildRequired: false,
    });
  const [dismissedCurrentRefreshSessionId, setDismissedCurrentRefreshSessionId] =
    useState<string | null>(null);
  const [syncDetailsExpanded, setSyncDetailsExpanded] = useState(false);
  const [developmentExpanded, setDevelopmentExpanded] = useState(false);
  const [emergencyExpanded, setEmergencyExpanded] = useState(false);
  const manualSyncInFlightRef = useRef(false);
  const manualSyncStopRequestedRef = useRef(false);
  const newWorldBaselineStopRequestedRef = useRef(false);

  useEffect(() => () => {
    manualSyncStopRequestedRef.current = true;
  }, []);

  useEffect(() => {
    onAutomaticSyncExclusiveBusyChange?.(busy !== null);
    return () => onAutomaticSyncExclusiveBusyChange?.(false);
  }, [busy, onAutomaticSyncExclusiveBusyChange]);

  useEffect(() => {
    void loadAutomaticDataSyncSnapshot().then(({ policy, status }) => {
      setAutomaticSyncPolicy(policy);
      setAutomaticSyncStatus(status);
    });
    return subscribeAutomaticDataSyncSnapshot((policy, status) => {
      setAutomaticSyncPolicy(policy);
      setAutomaticSyncStatus(status);
    });
  }, []);

  useEffect(() => {
    void loadAutomaticDataSyncProgress().then(setAutomaticSyncProgress);
    return subscribeAutomaticDataSyncProgress(setAutomaticSyncProgress);
  }, []);

  useEffect(() => {
    void loadEmergencySyncWorldRebuildSnapshot().then(setEmergencyRebuild);
    return subscribeEmergencySyncWorldRebuild(setEmergencyRebuild);
  }, []);

  useEffect(() => {
    void loadBackupRestoreSyncGateSnapshot().then(setBackupRestoreSyncGate);
    return subscribeBackupRestoreSyncGate(setBackupRestoreSyncGate);
  }, []);

  const loadState = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true);
    const [backend, current, localNewWorld, relayNewWorld] = await Promise.all([
      loadBackendSettings(),
      loadCurrentSyncDevice({ allowDuringBackupRestore: true }),
      loadAndroidNewWorldLocalSnapshot(),
      loadAndroidNewWorldRelaySnapshot(),
    ]);
    const baseUrl = backend.baseUrl.trim();
    setRelayBaseUrl(baseUrl);
    setNewWorldBaselineComplete(localNewWorld.baselineComplete);
    setNewWorldRelay(relayNewWorld);
    setNewWorldInvitation(null);
    const baselinePublish = localNewWorld.baselineComplete
      && relayNewWorld.state === 'provisioned'
      ? await inspectAndroidNewWorldBaselinePublishState()
      : null;
    setNewWorldBaselinePublish(baselinePublish);
    if (
      current
      && localNewWorld.baselineComplete
      && baselinePublish?.pending === 0
    ) {
      await activateAndroidNewWorldLiveCapture({
        identity: current.identity,
      });
    }
    setCurrentIdentity(current?.identity ?? null);
    setCurrentRefreshRequests(
      current && baseUrl
        ? await listPendingAndroidCurrentStateRefreshRequests({ baseUrl })
          .catch(() => [])
        : [],
    );
    try {
      if (!baseUrl || relayNewWorld.state !== 'provisioned') return;
      const newWorldPairing =
        createAndroidNewWorldPairingInvitationController({ baseUrl });
      setNewWorldInvitation(await newWorldPairing.snapshot());
    } finally {
      if (showLoading) setLoading(false);
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    void loadState().catch((caught) => {
      if (mounted) {
        setError(errorMessage(caught));
        setLoading(false);
      }
    });
    return () => {
      mounted = false;
      newWorldBaselineStopRequestedRef.current = true;
    };
  }, [loadState]);

  const requireRelay = () => {
    if (!relayBaseUrl) {
      throw new Error('请先在“工具包与权限”里填写君落后端地址。');
    }
    return normalizeSyncRelayBaseUrl(relayBaseUrl);
  };

  const run = async (
    key: string,
    operation: () => Promise<void>,
    success: string | null,
  ) => {
    setBusy(key);
    setNotice(null);
    setError(null);
    try {
      await operation();
      await loadState(false);
      setNotice(success);
    } catch (caught) {
      setError(errorMessage(caught));
      await loadState(false).catch(() => undefined);
    } finally {
      setBusy(null);
    }
  };

  const newWorldPairingController = () => (
    createAndroidNewWorldPairingInvitationController({
      baseUrl: requireRelay(),
    })
  );

  const establishNewWorldRelay = () => run(
    'new-world-relay-provisioning',
    async () => {
      await createAndroidNewWorldRelayProvisioningController({
        baseUrl: requireRelay(),
      }).provision();
    },
    null,
  );

  const confirmEstablishNewWorldRelay = () => {
    Alert.alert(
      '建立新的云端空间？',
      '君落会登记这台手机的新设备身份。建立完成后，就可以邀请电脑加入。',
      [
        { text: '稍后再说', style: 'cancel' },
        {
          text: '开始建立',
          onPress: () => void establishNewWorldRelay(),
        },
      ],
    );
  };

  const enableDualDeviceSync = async () => {
    setBusy('enable-dual-device-sync');
    setNotice(null);
    setError(null);
    newWorldBaselineStopRequestedRef.current = false;
    let localReady = false;
    let releaseBaselineSources: (() => void) | undefined;
    try {
      const controller = await import('../sync/syncAndroidNewWorldController');
      releaseBaselineSources = controller.releaseAndroidNewWorldBaselineSources;
      let local = await controller.loadAndroidNewWorldLocalSnapshot();
      if (!local.stagingReady) {
        await controller.generateAndroidNewWorldStagingSecrets({
          displayName: '手机',
        });
        local = await controller.loadAndroidNewWorldLocalSnapshot();
      }
      if (!local.databaseInitialized) {
        await controller.initializeAndroidNewWorldV2Database();
      }
      while (!newWorldBaselineStopRequestedRef.current) {
        const checkpoint = await controller.runNextAndroidNewWorldBaselineBatch();
        setSetupProgress(Math.min(42, checkpoint.adapterIndex));
        if (checkpoint.state === 'complete') {
          localReady = true;
          setNewWorldBaselineComplete(true);
          break;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 200));
      }
      if (!localReady) {
        const snapshot = await controller.loadAndroidNewWorldLocalSnapshot();
        localReady = snapshot.baselineComplete;
      }
      if (!localReady) {
        setNotice('手机资料已经保存进度，下次会从这里继续。');
        return;
      }
      if (!relayBaseUrl) {
        setNotice('手机资料已经准备好，正在等待电脑端连接');
        return;
      }
      await createAndroidNewWorldRelayProvisioningController({
        baseUrl: normalizeSyncRelayBaseUrl(relayBaseUrl),
      }).provision();
      setNotice('手机已经准备好，可以添加电脑');
    } catch (caught) {
      const local = await loadAndroidNewWorldLocalSnapshot().catch(() => null);
      if (local?.baselineComplete) {
        setNotice('手机资料已经准备好，正在等待电脑端连接');
      } else {
        setError(errorMessage(caught));
      }
    } finally {
      releaseBaselineSources?.();
      await loadState(false).catch(() => undefined);
      setBusy(null);
    }
  };

  const createNewWorldInvitation = () => run(
    'new-world-pairing-create',
    async () => {
      const controller = newWorldPairingController();
      await controller.prepareInvitation();
      await controller.publishInvitation();
    },
    null,
  );

  const refreshNewWorldInvitation = () => run(
    'new-world-pairing-refresh',
    async () => {
      await newWorldPairingController().refreshInvitation();
    },
    null,
  );

  const publishNewWorldInvitation = () => run(
    'new-world-pairing-publish',
    async () => {
      await newWorldPairingController().publishInvitation();
    },
    null,
  );

  const approveNewWorldInvitation = () => run(
    'new-world-pairing-approve',
    async () => {
      const code = newWorldInvitation?.verificationCode;
      if (!code) throw new Error('电脑申请尚未带回六位确认码。');
      const controller = newWorldPairingController();
      await controller.prepareApproval(code);
      await controller.submitApproval();
    },
    null,
  );

  const resumeNewWorldApproval = () => run(
    'new-world-pairing-resume',
    async () => {
      await newWorldPairingController().submitApproval();
    },
    null,
  );

  const clearExpiredNewWorldInvitation = () => run(
    'new-world-pairing-clear',
    async () => {
      await newWorldPairingController().clearExpiredInvitation();
    },
    null,
  );

  const publishNewWorldBaseline = () => run(
    'new-world-baseline-publish',
    async () => {
      await publishNextAndroidNewWorldBaselineBatch({
        baseUrl: requireRelay(),
      });
    },
    null,
  );

  const refreshDeviceDirectory = async () => {
    setBusy('refresh-device-directory');
    setNotice(null);
    setError(null);
    try {
      const snapshot = await createAndroidDeviceManagementController({
        baseUrl: requireRelay(),
      }).refreshDirectory();
      setDeviceDirectory(snapshot);
      setNotice('设备目录已经刷新。');
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  };

  const runManualSync = async () => {
    if (manualSyncInFlightRef.current) return;
    manualSyncInFlightRef.current = true;
    manualSyncStopRequestedRef.current = false;
    setManualSyncResult(null);
    setBusy('manual-sync');
    setNotice(null);
    setError(null);
    try {
      const { createAndroidManualSyncController } = await import(
        '../sync/syncAndroidManualSync'
      );
      const result = await createAndroidManualSyncController({
        baseUrl: requireRelay(),
      }).runUntilSettled({
        shouldContinue: () => !manualSyncStopRequestedRef.current,
        onProgress: setManualSyncResult,
      });
      await recordAndroidManualSyncProgress(result);
      setManualSyncResult(result);
      setObjectRefreshToken((value) => value + 1);
      await loadState(false);
      setNotice(result.state === 'complete'
        ? '全部数据已同步。'
        : manualSyncStopRequestedRef.current
          ? '已停止后续批次，剩余内容会留到下次同步。'
          : '同步已暂停，剩余项目需要检查连接、不同版本或文件状态。');
    } catch (caught) {
      setError(errorMessage(caught));
      await loadState(false).catch(() => undefined);
    } finally {
      manualSyncInFlightRef.current = false;
      setBusy(null);
    }
  };

  const renameCurrentDevice = async (displayName: string) => {
    let normalized: string;
    try {
      normalized = normalizeSyncDeviceDisplayName(displayName);
    } catch (caught) {
      setError(errorMessage(caught));
      return false;
    }
    setBusy('rename-current-device');
    setNotice(null);
    setError(null);
    try {
      const snapshot = await createAndroidDeviceManagementController({
        baseUrl: requireRelay(),
      }).renameCurrentDevice(normalized);
      setDeviceDirectory(snapshot);
      await loadState(false);
      setNotice('昵称已保存');
      return true;
    } catch (caught) {
      const message = errorMessage(caught);
      if (message.includes('昵称已经由中继保存')) {
        await loadState(false).catch(() => undefined);
      }
      setError(message.includes('昵称已经由中继保存')
        ? message
        : '暂时无法连接同步中继，昵称没有改动。');
      return false;
    } finally {
      setBusy(null);
    }
  };

  const prepareCurrentStateRefresh = async (
    request: CurrentStateRefreshStatusV1,
  ) => {
    setCurrentRefreshProgress(0);
    await run(
      'current-state-refresh',
      async () => {
        await prepareAndroidCurrentStateRefresh({
          baseUrl: requireRelay(),
          sessionId: request.sessionId,
          onProgress: setCurrentRefreshProgress,
        });
      },
      '等待电脑完成',
    );
  };

  const applyAutomaticSyncEnabled = async (enabled: boolean) => {
    const policy = await saveAutomaticDataSyncPolicy({ enabled, version: 1 });
    setAutomaticSyncPolicy(policy);
    if (enabled) {
      await registerAutomaticDataSyncBackgroundTask().catch(() => false);
      notifyAutomaticDataSyncWorkAvailable();
    } else {
      await unregisterAutomaticDataSyncBackgroundTask().catch(() => undefined);
    }
  };

  const toggleAutomaticSync = (enabled: boolean) => {
    if (!enabled) {
      void applyAutomaticSyncEnabled(false);
      return;
    }
    Alert.alert(
      '开启自动同步数据？',
      '开启后，君落会在本机有新数据、回到前台或发现另一台设备有更新时，分批完成同步。普通数据可以随时同步；大文件会等待适合的网络和供电条件。',
      [
        { text: '取消', style: 'cancel' },
        { text: '开启', onPress: () => void applyAutomaticSyncEnabled(true) },
      ],
    );
  };

  const runEmergencyRebuild = async (resume: boolean) => {
    setBusy('emergency-world-rebuild');
    setNotice(null);
    setError(null);
    try {
      let state = resume
        ? await continueEmergencySyncWorldRebuild()
        : await startEmergencySyncWorldRebuild({ baseUrl: relayBaseUrl });
      while (state.phase !== 'complete' && state.phase !== 'blocked') {
        await new Promise<void>((resolve) => setTimeout(resolve, 120));
        state = await continueEmergencySyncWorldRebuild();
      }
      const snapshot = await loadEmergencySyncWorldRebuildSnapshot();
      setEmergencyRebuild(snapshot);
      if (state.phase === 'complete') {
        setNotice([
          '现在可以继续使用君落。新电脑准备好后，在这里添加电脑。',
          state.oldDeviceRevocation === 'relay-unreachable'
            ? '旧中继暂时联系不上；手机仍会继续建立新世界，旧空间不会再收到新的内容。'
            : null,
        ].filter(Boolean).join('\n'));
        await loadState(false);
      }
    } catch (caught) {
      console.warn('[emergency-world-rebuild] paused', caught);
      const snapshot = await loadEmergencySyncWorldRebuildSnapshot()
        .catch(() => emergencySyncWorldRebuildSnapshot(null));
      setEmergencyRebuild(snapshot);
      setError(snapshot.missingFiles > 0
        ? `有 ${snapshot.missingFiles} 个当前文件在手机上找不到原文件。相关记录仍在，请补回文件后继续。`
        : '重新建立还没有完成。手机里的当前数据仍在，再次打开本页可以继续。');
    } finally {
      setBusy(null);
    }
  };

  const confirmEmergencyRebuild = () => {
    Alert.alert(
      '从手机重新建立同步？',
      '君落会停止旧世界同步，用手机里的当前数据建立新世界。整理期间请留在本页；完成后所有电脑都需要重新添加。旧世界会保留，稍后再单独处理。',
      [
        { text: '先不处理', style: 'cancel' },
        {
          text: '开始重新建立',
          onPress: () => void runEmergencyRebuild(false),
        },
      ],
    );
  };

  const rebuildAfterOrdinaryRestore = async () => {
    if (currentIdentity) {
      await runEmergencyRebuild(false);
      return;
    }
    setBusy('backup-restore-new-world');
    setNotice(null);
    setError(null);
    let releaseBaselineSources: (() => void) | undefined;
    try {
      const {
        generateAndroidNewWorldStagingSecrets,
        initializeAndroidNewWorldV2Database,
        releaseAndroidNewWorldBaselineSources,
        runNextAndroidNewWorldBaselineBatch,
      } = await import('../sync/syncAndroidNewWorldController');
      releaseBaselineSources = releaseAndroidNewWorldBaselineSources;
      let local = await loadAndroidNewWorldLocalSnapshot();
      if (!local.stagingReady) {
        await generateAndroidNewWorldStagingSecrets({ displayName: '手机' });
        local = await loadAndroidNewWorldLocalSnapshot();
      }
      if (!local.databaseInitialized) {
        await initializeAndroidNewWorldV2Database();
      }
      let checkpoint = await runNextAndroidNewWorldBaselineBatch();
      while (checkpoint.state !== 'complete') {
        await new Promise<void>((resolve) => setTimeout(resolve, 120));
        checkpoint = await runNextAndroidNewWorldBaselineBatch();
      }
      await clearBackupRestoreSyncGate();
      setNotice('现在可以继续使用君落。新电脑准备好后，在这里添加电脑。');
      await loadState(false);
    } catch (caught) {
      console.warn('[backup-restore-new-world] paused', caught);
      setError('重新建立还没有完成。手机里的当前数据仍在，再次打开本页可以继续。');
    } finally {
      releaseBaselineSources?.();
      setBusy(null);
    }
  };

  let relayReady = false;
  if (relayBaseUrl) {
    try {
      normalizeSyncRelayBaseUrl(relayBaseUrl);
      relayReady = true;
    } catch {
      relayReady = false;
    }
  }
  const isWorking = busy !== null || emergencyRebuild.active;
  const pendingOutgoing = automaticSyncProgress?.queues.pendingOutgoing
    ?? manualSyncResult?.sync.pendingOutbox
    ?? 0;
  const waitingAtRelay = automaticSyncProgress?.queues.waitingAtRelay ?? 0;
  const waitingToApply = automaticSyncProgress?.queues.receivedAwaitingApply
    ?? manualSyncResult?.sync.receivedInbox
    ?? 0;
  const conflictCount = automaticSyncProgress?.queues.conflicts
    ?? manualSyncResult?.sync.pendingConflicts
    ?? 0;
  const quarantineCount = automaticSyncProgress?.queues.quarantined
    ?? manualSyncResult?.sync.quarantined
    ?? 0;
  const blockedObjectJobs = automaticSyncProgress?.queues.blockedObjectJobs ?? 0;
  const hasAttention = conflictCount > 0
    || quarantineCount > 0
    || blockedObjectJobs > 0;

  return (
    <View style={styles.page}>
      <View style={styles.header}>
        <Pressable
          accessibilityLabel="返回设置"
          onPress={() => navigate('settings')}
          style={styles.backButton}
        >
          <Text style={styles.backText}>‹</Text>
        </Pressable>
        <Text style={styles.title}>设备与同步</Text>
        <View style={styles.headerSpacer} />
      </View>
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.hero}>
          <View style={styles.heroOrbit} />
          <Text style={styles.heroTitle}>让手机和电脑保持一致</Text>
          <Text style={styles.heroText}>
            把聊天、记忆、日程等资料在两台设备间保持一致。
          </Text>
          <StatusPill tone={currentIdentity ? 'ready' : 'quiet'}>
            {currentIdentity ? '同步身份已准备好' : '尚未启用双端同步'}
          </StatusPill>
        </View>

        {!relayBaseUrl && !loading && backupRestoreSyncGate.state === 'idle' && (
          <View style={styles.warningCard}>
            <Text style={styles.warningTitle}>还缺君落后端地址</Text>
            <Text style={styles.warningText}>
              设备身份仍只从本机读取。填写地址前不会创建邀请，也不会尝试联网。
            </Text>
            <ActionButton
              label="去填写后端地址"
              onPress={() => navigate('tool-settings')}
              secondary
            />
          </View>
        )}

        {backupRestoreSyncGate.state !== 'idle' ? (
          <View style={styles.paperCard}>
            <View style={styles.cardHeader}>
              <View>
                <Text style={styles.cardTitle}>
                  {backupRestoreSyncGate.rebuildRequired
                    ? '恢复后的资料需要重新建立同步'
                    : '正在完成资料恢复'}
                </Text>
              </View>
              <StatusPill tone="waiting">同步暂停</StatusPill>
            </View>
            <Text style={styles.cardDescription}>
              {backupRestoreSyncGate.rebuildRequired
                ? '手机里的资料已经恢复。为了避免旧电脑状态重新混入，普通同步暂时停止。确认后，君落会从手机当前资料建立新的同步世界。'
                : '资料恢复仍在收尾，普通同步暂时停止。'}
            </Text>
            {backupRestoreSyncGate.rebuildRequired ? (
              <ActionButton
                disabled={isWorking}
                label="重新建立同步"
                onPress={() => void rebuildAfterOrdinaryRestore()}
              />
            ) : (
              <ActivityIndicator color="#6D9C98" />
            )}
          </View>
        ) : loading ? (
          <View style={styles.loadingCard}>
            <ActivityIndicator color="#6D9C98" />
            <Text style={styles.loadingText}>正在读取本机设备状态…</Text>
          </View>
        ) : !currentIdentity ? (
          <View style={styles.paperCard}>
            <View style={styles.cardHeader}>
              <View>
                <Text style={styles.cardTitle}>启用双端同步</Text>
              </View>
              <StatusPill>{newWorldBaselineComplete ? '等待连接' : '未启用'}</StatusPill>
            </View>
            <Text style={styles.cardDescription}>
              君落会在本机生成并保存同步钥匙，然后准备当前资料。完成后就可以添加电脑。
            </Text>
            {busy === 'enable-dual-device-sync' ? (
              <Text style={styles.footnote}>
                正在准备手机资料 · {setupProgress}/42
              </Text>
            ) : newWorldBaselineComplete ? (
              <Text style={styles.footnote}>
                {newWorldRelay.state === 'provisioned'
                  ? '手机已经准备好，可以添加电脑'
                  : '手机资料已经准备好，正在等待电脑端连接'}
              </Text>
            ) : null}
            <ActionButton
              disabled={isWorking}
              label={busy === 'enable-dual-device-sync'
                ? `正在准备手机资料 · ${setupProgress}/42`
                : newWorldBaselineComplete && newWorldRelay.state !== 'provisioned'
                  ? '继续连接电脑端'
                  : '启用双端同步'}
              onPress={() => void enableDualDeviceSync()}
            />
          </View>
        ) : (
          <>
            <View style={styles.paperCard}>
              <View style={styles.cardHeader}>
                <View>
                  <Text style={styles.cardTitle}>这台手机同步正常</Text>
                </View>
                <StatusPill tone="ready">同步正常</StatusPill>
              </View>
              <DeviceIdentityCard
                busy={busy === 'rename-current-device'}
                identity={currentIdentity}
                onRename={renameCurrentDevice}
              />
              <View style={styles.localOnlyRow}>
                <View style={styles.localOnlyDot} />
                <Text style={styles.localOnlyText}>普通同步由本机开关控制</Text>
              </View>
            </View>
            {newWorldBaselineComplete
              && newWorldRelay.state !== 'provisioned'
              && (
                <View style={styles.paperCard}>
                  <Text style={styles.cardTitle}>手机资料已经准备好</Text>
                  <Text style={styles.cardDescription}>
                    电脑端后端恢复后，可以继续建立连接并添加电脑。
                  </Text>
                  <ActionButton
                    disabled={!relayReady || isWorking}
                    label={busy === 'new-world-relay-provisioning'
                      ? '正在连接…'
                      : '继续连接电脑端'}
                    onPress={confirmEstablishNewWorldRelay}
                  />
                </View>
              )}
            {newWorldBaselineComplete
              && newWorldRelay.state === 'provisioned'
              && (
                <InvitationCard
                  busy={isWorking}
                  invitation={newWorldInvitation}
                  onApprove={() => void approveNewWorldInvitation()}
                  onClearExpired={() => void clearExpiredNewWorldInvitation()}
                  onCreate={() => void createNewWorldInvitation()}
                  onPublish={() => void publishNewWorldInvitation()}
                  onRefresh={() => void refreshNewWorldInvitation()}
                  onResumeApproval={() => void resumeNewWorldApproval()}
                  relayReady={relayReady}
                />
              )}
            {newWorldBaselineComplete
              && newWorldRelay.state === 'provisioned'
              && (
                <View style={styles.paperCard}>
                  <Text style={styles.cardTitle}>把手机里的生活带到电脑</Text>
                  <Text style={styles.cardDescription}>
                    君落会把新世界的第一份内容分成小批送上云端。每次最多运行半分钟，中途停下后可以继续。
                  </Text>
                  {newWorldBaselinePublish?.pending === 0 ? (
                    <Text style={styles.footnote}>
                      第一份数据已经送达，可以回到电脑接收了
                    </Text>
                  ) : (
                    <ActionButton
                      disabled={!relayReady || isWorking}
                      label={(newWorldBaselinePublish?.acknowledged ?? 0) > 0
                        ? '继续发送'
                        : '发送第一份数据'}
                      onPress={() => void publishNewWorldBaseline()}
                    />
                  )}
                </View>
              )}
            {currentRefreshRequests
              .filter((request) => (
                request.sessionId !== dismissedCurrentRefreshSessionId
                && ['waiting-android', 'uploading', 'ready']
                  .includes(request.state)
              ))
              .slice(0, 1)
              .map((request) => (
                <View key={request.sessionId} style={styles.paperCard}>
                  <View style={styles.cardHeader}>
                    <View>
                      <Text style={styles.eyebrow}>
                        需要重新取得当前状态
                      </Text>
                      <Text style={styles.cardTitle}>
                        电脑想重新取得当前状态
                      </Text>
                    </View>
                  </View>
                  <Text style={styles.cardDescription}>
                    这台电脑离线太久，旧的共享数据已经不能直接合并。准备后，电脑会以手机里现在的数据重新建立同步。
                  </Text>
                  {busy === 'current-state-refresh' ? (
                    <Text style={styles.footnote}>
                      正在准备当前状态 · {currentRefreshProgress}/42
                    </Text>
                  ) : request.state === 'ready' ? (
                    <Text style={styles.footnote}>等待电脑完成</Text>
                  ) : null}
                  <ActionButton
                    disabled={
                      isWorking
                      || !['waiting-android', 'uploading'].includes(request.state)
                    }
                    label={busy === 'current-state-refresh'
                      ? `正在准备当前状态 · ${currentRefreshProgress}/42`
                      : '准备当前状态'}
                    onPress={() => void prepareCurrentStateRefresh(request)}
                  />
                  <ActionButton
                    disabled={isWorking}
                    label="暂不处理"
                    onPress={() => {
                      setDismissedCurrentRefreshSessionId(request.sessionId);
                    }}
                    secondary
                  />
                </View>
              ))}
            <View style={styles.paperCard}>
              <View style={styles.toggleRow}>
                <View style={styles.toggleCopy}>
                  <Text style={styles.cardTitle}>自动同步数据</Text>
                  <Text style={styles.cardDescriptionCompact}>
                    开启后，君落会在本机有新数据、回到前台或发现另一台设备有更新时，分批完成同步。普通数据可以随时同步；大文件会等待适合的网络和供电条件。
                  </Text>
                  <Text style={styles.footnote}>
                    {automaticSyncStatusLabel(automaticSyncStatus)}
                    {automaticSyncStatus.lastSuccessAt
                      ? ` · 上次完成 ${formatTime(automaticSyncStatus.lastSuccessAt)}`
                      : ''}
                  </Text>
                </View>
                <Switch
                  accessibilityLabel="自动同步数据"
                  disabled={isWorking}
                  value={automaticSyncPolicy.enabled}
                  onValueChange={toggleAutomaticSync}
                  trackColor={{ false: '#D5DEDD', true: '#86CFC2' }}
                  thumbColor="#FFFFFF"
                />
              </View>
            </View>
            <View style={styles.paperCard}>
              <View style={styles.cardHeader}>
                <View>
                  <Text style={styles.cardTitle}>立即同步</Text>
                </View>
                <StatusPill tone={manualSyncResult?.state === 'complete'
                  ? 'ready'
                  : manualSyncResult
                    ? 'waiting'
                    : 'quiet'}>
                  {busy === 'manual-sync'
                    ? '正在同步并整理剩余内容…'
                    : manualSyncResult?.state === 'complete'
                    ? manualSyncResult.sync.objectJobs > 0
                      ? `普通数据已同步 · 还有 ${manualSyncResult.sync.objectJobs} 个文件`
                      : '全部数据已同步'
                    : manualSyncResult
                      ? '同步已暂停 · 还有事项未完成'
                      : '只在点按后运行'}
                </StatusPill>
              </View>
              <Text style={styles.cardDescription}>
                点一次会连续完成后续批次，包括整理旧记录后产生的删除通知。遇到错误或无法继续的项目时会暂停，保留尚未完成的内容。
              </Text>
              {manualSyncResult && (
                <View style={styles.syncSummary}>
                  <Text style={styles.syncSummaryText}>
                    本次累计发出 {manualSyncResult.sentMutations} 条 · 收到 {manualSyncResult.receivedEntries} 条
                  </Text>
                  <Text style={styles.syncSummaryText}>
                    对象上传 {manualSyncResult.uploadedObjects} 个 · 下载 {manualSyncResult.downloadedObjects} 个 · 冲突 {manualSyncResult.sync.pendingConflicts} 个
                  </Text>
                </View>
              )}
              <ActionButton
                disabled={!relayReady || isWorking}
                label={busy === 'manual-sync' ? '同步中…' : '立即同步'}
                onPress={() => void runManualSync()}
              />
              {busy === 'manual-sync' && (
                <ActionButton
                  secondary
                  label="停止后续批次"
                  onPress={() => {
                    manualSyncStopRequestedRef.current = true;
                    setNotice('正在完成当前批次，随后停止。');
                  }}
                />
              )}
              <Text style={styles.footnote}>
                不受自动同步开关影响。处理期间会更新累计数量，可以中途停止。
              </Text>
            </View>
            <DeviceDirectoryCard
              busy={isWorking}
              onRefresh={() => void refreshDeviceDirectory()}
              relayReady={relayReady}
              snapshot={deviceDirectory}
            />

            {hasAttention ? (
              <View style={styles.attentionCard}>
                <Text style={styles.cardTitle}>有几项需要处理</Text>
                {conflictCount > 0 ? (
                  <Text style={styles.attentionText}>
                    需要整理 · {conflictCount} 个不同版本
                  </Text>
                ) : null}
                {quarantineCount > 0 ? (
                  <Text style={styles.attentionText}>
                    同步受阻 · {quarantineCount} 条需要检查
                  </Text>
                ) : null}
                {blockedObjectJobs > 0 ? (
                  <Text style={styles.attentionText}>
                    需要检查 · {blockedObjectJobs} 个文件缺少原文件
                  </Text>
                ) : null}
              </View>
            ) : null}

            <View style={styles.paperCard}>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded: syncDetailsExpanded }}
                onPress={() => setSyncDetailsExpanded((value) => !value)}
                style={({ pressed }) => [
                  styles.foldButton,
                  pressed && styles.foldButtonPressed,
                ]}
              >
                <Text style={styles.foldTitle}>查看同步详情</Text>
                <Text style={styles.foldChevron}>
                  {syncDetailsExpanded ? '收起' : '展开'}
                </Text>
              </Pressable>
              {syncDetailsExpanded ? (
                <View style={styles.foldContent}>
                  <View style={styles.detailGrid}>
                    <View style={styles.detailCell}>
                      <Text style={styles.detailLabel}>待发送</Text>
                      <Text style={styles.detailValue}>{pendingOutgoing}</Text>
                    </View>
                    <View style={styles.detailCell}>
                      <Text style={styles.detailLabel}>待取回</Text>
                      <Text style={styles.detailValue}>{waitingAtRelay}</Text>
                    </View>
                    <View style={styles.detailCell}>
                      <Text style={styles.detailLabel}>待整理</Text>
                      <Text style={styles.detailValue}>{waitingToApply}</Text>
                    </View>
                    <View style={styles.detailCell}>
                      <Text style={styles.detailLabel}>不同版本</Text>
                      <Text style={styles.detailValue}>{conflictCount}</Text>
                    </View>
                    <View style={styles.detailCell}>
                      <Text style={styles.detailLabel}>需要检查</Text>
                      <Text style={styles.detailValue}>
                        {quarantineCount + blockedObjectJobs}
                      </Text>
                    </View>
                    <View style={styles.detailCell}>
                      <Text style={styles.detailLabel}>文件进度</Text>
                      <Text style={styles.detailValue}>
                        {automaticSyncProgress
                          ? `${automaticSyncProgress.queues.completedObjectChunks}/${automaticSyncProgress.queues.totalObjectChunks}`
                          : '—'}
                      </Text>
                    </View>
                  </View>
                  <Text style={styles.detailHint}>
                    最近删除中仍可恢复的资料，可以在“整理不同版本”页面查看。
                  </Text>
                  <SyncObjectManagementCard
                    baseUrl={relayBaseUrl}
                    disabled={!relayReady || isWorking}
                    liveRefresh={busy === 'manual-sync'}
                    refreshToken={objectRefreshToken}
                  />
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ expanded: developmentExpanded }}
                    onPress={() => setDevelopmentExpanded((value) => !value)}
                    style={({ pressed }) => [
                      styles.developmentButton,
                      pressed && styles.foldButtonPressed,
                    ]}
                  >
                    <Text style={styles.developmentTitle}>开发信息</Text>
                    <Text style={styles.foldChevron}>
                      {developmentExpanded ? '收起' : '查看'}
                    </Text>
                  </Pressable>
                  {developmentExpanded ? (
                    <View style={styles.developmentPanel}>
                      <Text selectable style={styles.technicalText}>
                        设备 ID · {shortId(currentIdentity.deviceId)}
                      </Text>
                      <Text selectable style={styles.technicalText}>
                        vault 公开编号 · {shortId(currentIdentity.vaultId)}
                      </Text>
                      <Text style={styles.technicalText}>
                        数据库版本 · v7
                      </Text>
                      <Text style={styles.technicalText}>
                        最近停止原因 · {automaticSyncProgress?.lastRound?.stoppedBy ?? '—'}
                      </Text>
                    </View>
                  ) : null}
                </View>
              ) : null}
            </View>

            <View style={styles.paperCard}>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded: emergencyExpanded }}
                onPress={() => setEmergencyExpanded((value) => !value)}
                style={({ pressed }) => [
                  styles.foldButton,
                  pressed && styles.foldButtonPressed,
                ]}
              >
                <Text style={styles.foldTitle}>设备遗失处理</Text>
                <Text style={styles.foldChevron}>
                  {emergencyExpanded ? '收起' : '展开'}
                </Text>
              </Pressable>
              {emergencyExpanded ? (
                <View style={styles.foldContent}>
                  <Text style={styles.cardTitle}>电脑丢失了</Text>
                  <Text style={styles.cardDescription}>
                    如果电脑遗失或不再可信，可以由这台手机保存当前生活，换一把新的同步钥匙，再添加新电脑。
                  </Text>
                  <Text style={styles.detailHint}>
                    {emergencyRebuildProgressLabel(emergencyRebuild)}
                  </Text>
                  <ActionButton
                    disabled={isWorking || emergencyRebuild.phase === 'complete'}
                    label={emergencyRebuild.canContinue
                      ? '继续重新建立同步'
                      : '重新建立同步'}
                    onPress={emergencyRebuild.canContinue
                      ? () => void runEmergencyRebuild(true)
                      : confirmEmergencyRebuild}
                  />
                </View>
              ) : null}
            </View>
          </>
        )}

        {(notice || error) && (
          <View
            accessibilityLiveRegion="polite"
            style={[styles.feedback, error && styles.feedbackError]}
          >
            <Text style={[styles.feedbackText, error && styles.feedbackErrorText]}>
              {error ?? notice}
            </Text>
          </View>
        )}
        <Text style={styles.pageFootnote}>
          自动同步和手动同步都只处理当前同步世界。
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
    paddingTop: 18,
    paddingHorizontal: 18,
    backgroundColor: '#F7FBFA',
  },
  header: {
    height: 58,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  backButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#DCEBE8',
  },
  backText: {
    color: colors.ink,
    fontSize: 32,
    lineHeight: 34,
  },
  title: {
    color: colors.ink,
    fontSize: 30,
    fontWeight: '800',
  },
  headerSpacer: {
    width: 48,
  },
  content: {
    paddingBottom: 42,
    gap: 14,
  },
  hero: {
    minHeight: 214,
    overflow: 'hidden',
    borderRadius: 28,
    padding: 24,
    backgroundColor: '#DFF2F0',
    borderWidth: 1,
    borderColor: '#C9E6E2',
  },
  heroOrbit: {
    position: 'absolute',
    width: 210,
    height: 210,
    borderRadius: 105,
    right: -62,
    top: -72,
    backgroundColor: 'rgba(255,255,255,0.58)',
    borderWidth: 24,
    borderColor: 'rgba(255,255,255,0.28)',
  },
  eyebrow: {
    color: '#688A88',
    fontSize: 15,
    fontWeight: '800',
    letterSpacing: 1.5,
    marginBottom: 8,
  },
  heroTitle: {
    maxWidth: 300,
    color: '#304A50',
    fontSize: 28,
    lineHeight: 36,
    fontWeight: '900',
    marginBottom: 11,
  },
  heroText: {
    maxWidth: 300,
    color: '#557276',
    fontSize: 15,
    lineHeight: 22,
    marginBottom: 18,
  },
  paperCard: {
    borderRadius: 24,
    padding: 20,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#DDECE9',
    shadowColor: '#486B68',
    shadowOpacity: 0.08,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 2,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 12,
  },
  cardTitle: {
    color: colors.ink,
    fontSize: 20,
    lineHeight: 27,
    fontWeight: '800',
  },
  cardDescription: {
    color: '#667579',
    fontSize: 15,
    lineHeight: 22,
    marginBottom: 17,
  },
  cardDescriptionCompact: {
    color: '#667579',
    fontSize: 15,
    lineHeight: 22,
    marginTop: 7,
    marginBottom: 8,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
  },
  toggleCopy: {
    flex: 1,
  },
  statusPill: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 7,
    backgroundColor: '#EEF2F2',
  },
  statusPillReady: {
    backgroundColor: '#E4F5EA',
  },
  statusPillWaiting: {
    backgroundColor: '#FFF1CD',
  },
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: '#9CA9A9',
  },
  statusDotReady: {
    backgroundColor: '#51B983',
  },
  statusDotWaiting: {
    backgroundColor: '#E1A936',
  },
  statusPillText: {
    color: '#5C6A6C',
    fontSize: 15,
    fontWeight: '800',
  },
  actionButton: {
    minHeight: 52,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
    backgroundColor: '#547F7C',
    marginTop: 9,
  },
  actionButtonSecondary: {
    backgroundColor: '#EEF6F4',
    borderWidth: 1,
    borderColor: '#D2E7E3',
  },
  actionButtonDisabled: {
    opacity: 0.42,
  },
  actionButtonPressed: {
    transform: [{ scale: 0.985 }],
  },
  actionButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '800',
  },
  actionButtonTextSecondary: {
    color: '#507774',
  },
  warningCard: {
    borderRadius: 21,
    padding: 18,
    backgroundColor: '#FFF7E4',
    borderWidth: 1,
    borderColor: '#F2DFAE',
  },
  warningTitle: {
    color: '#7C6539',
    fontSize: 17,
    fontWeight: '800',
    marginBottom: 5,
  },
  warningText: {
    color: '#887657',
    fontSize: 15,
    lineHeight: 20,
  },
  loadingCard: {
    minHeight: 150,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    borderRadius: 24,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#DDECE9',
  },
  loadingText: {
    color: '#71807F',
    fontSize: 15,
  },
  mnemonicGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 7,
    marginBottom: 8,
  },
  recoveryQrHint: {
    color: '#7B6B58',
    fontSize: 15,
    lineHeight: 19,
    textAlign: 'center',
    marginBottom: 3,
  },
  registrationExpiryNotice: {
    borderRadius: 14,
    padding: 12,
    backgroundColor: '#FFF7E4',
    borderWidth: 1,
    borderColor: '#F2DFAE',
    marginBottom: 12,
  },
  registrationExpiryText: {
    color: '#7C6539',
    fontSize: 15,
    lineHeight: 19,
  },
  recoveryVisibilityNotice: {
    borderRadius: 14,
    padding: 12,
    backgroundColor: '#FFF7E4',
    borderWidth: 1,
    borderColor: '#F2DFAE',
    marginBottom: 5,
  },
  recoveryVisibilityText: {
    color: '#7C6539',
    fontSize: 15,
    lineHeight: 19,
  },
  mnemonicWord: {
    width: '31%',
    minHeight: 42,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 12,
    paddingHorizontal: 9,
    backgroundColor: '#F6F9F8',
    borderWidth: 1,
    borderColor: '#E2ECEA',
  },
  mnemonicIndex: {
    minWidth: 15,
    color: '#A0ADAB',
    fontSize: 15,
    fontWeight: '800',
  },
  mnemonicText: {
    flexShrink: 1,
    color: '#354D50',
    fontSize: 15,
    fontWeight: '700',
  },
  confirmRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    paddingVertical: 15,
  },
  checkbox: {
    width: 23,
    height: 23,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#BFD1CE',
    backgroundColor: '#FFFFFF',
  },
  checkboxChecked: {
    borderColor: '#5F8D88',
    backgroundColor: '#5F8D88',
  },
  checkboxMark: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '900',
  },
  confirmText: {
    flex: 1,
    color: '#586B6D',
    fontSize: 15,
    lineHeight: 19,
  },
  footnote: {
    color: '#879391',
    fontSize: 15,
    lineHeight: 17,
    marginTop: 11,
  },
  deviceCard: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 18,
    padding: 14,
    backgroundColor: '#F1FAF7',
    borderWidth: 1,
    borderColor: '#D8EDE7',
  },
  deviceGlyph: {
    width: 48,
    height: 48,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#DDEFEA',
    marginRight: 12,
  },
  deviceGlyphText: {
    color: '#557F79',
    fontSize: 27,
    lineHeight: 30,
  },
  deviceCopy: {
    flex: 1,
  },
  deviceTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  deviceTitle: {
    flexShrink: 1,
    color: colors.ink,
    fontSize: 16,
    fontWeight: '800',
  },
  currentTag: {
    borderRadius: 999,
    paddingHorizontal: 7,
    paddingVertical: 3,
    backgroundColor: '#D8EFE7',
  },
  currentTagText: {
    color: '#4D776D',
    fontSize: 15,
    fontWeight: '800',
  },
  deviceMeta: {
    color: '#6E7E7D',
    fontSize: 15,
    marginTop: 4,
  },
  deviceId: {
    color: '#8C9998',
    fontSize: 15,
    marginTop: 3,
  },
  renameOpenButton: {
    alignSelf: 'flex-start',
    minHeight: 48,
    marginTop: 9,
    paddingHorizontal: 16,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#E2F3EE',
    borderWidth: 1,
    borderColor: '#CBE6DE',
  },
  renameOpenButtonText: {
    color: '#4D776D',
    fontSize: 15,
    fontWeight: '800',
  },
  renameEditor: {
    marginTop: 12,
    gap: 8,
  },
  renameLabel: {
    color: '#637776',
    fontSize: 15,
    fontWeight: '700',
  },
  renameInput: {
    minHeight: 50,
    borderRadius: 15,
    borderWidth: 1,
    borderColor: '#CBE2DD',
    backgroundColor: '#FFFEFB',
    color: colors.ink,
    fontSize: 16,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  renameActions: {
    flexDirection: 'row',
    gap: 10,
  },
  renameButton: {
    minHeight: 48,
    flex: 1,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#5E8D86',
    borderWidth: 1,
    borderColor: '#5E8D86',
  },
  renameButtonSecondary: {
    backgroundColor: '#FFFEFB',
    borderColor: '#CBE2DD',
  },
  renameButtonPressed: {
    opacity: 0.78,
    transform: [{ scale: 0.985 }],
  },
  renameButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '800',
  },
  renameButtonSecondaryText: {
    color: '#5E7773',
    fontSize: 15,
    fontWeight: '800',
  },
  managedDevice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderRadius: 17,
    padding: 13,
    backgroundColor: '#F7F9F9',
    borderWidth: 1,
    borderColor: '#E2EAEA',
    marginBottom: 9,
  },
  managedDeviceCurrent: {
    backgroundColor: '#F1FAF7',
    borderColor: '#D8EDE7',
  },
  managedDeviceCopy: {
    flex: 1,
  },
  revokeButton: {
    minHeight: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 13,
    paddingHorizontal: 12,
    backgroundColor: '#FFF0ED',
    borderWidth: 1,
    borderColor: '#EECFC8',
  },
  revokeButtonText: {
    color: '#A45F55',
    fontSize: 15,
    fontWeight: '800',
  },
  localOnlyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    marginTop: 13,
  },
  localOnlyDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: '#E3B14F',
  },
  localOnlyText: {
    color: '#81745C',
    fontSize: 15,
  },
  syncSummary: {
    gap: 5,
    borderRadius: 15,
    padding: 12,
    backgroundColor: '#F1F7F6',
    borderWidth: 1,
    borderColor: '#D9E9E6',
    marginBottom: 3,
  },
  syncSummaryText: {
    color: '#607574',
    fontSize: 15,
    lineHeight: 18,
  },
  qrFrame: {
    alignSelf: 'center',
    borderRadius: 22,
    padding: 10,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#DCE9E7',
    marginVertical: 8,
  },
  invitationMeta: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 14,
    marginTop: 10,
    marginBottom: 4,
  },
  metaLabel: {
    color: '#96A2A1',
    fontSize: 15,
    fontWeight: '800',
    letterSpacing: 0.8,
    marginBottom: 3,
  },
  metaValue: {
    color: '#536568',
    fontSize: 15,
    fontWeight: '700',
  },
  requestCard: {
    borderRadius: 17,
    padding: 14,
    backgroundColor: '#F7F2FF',
    borderWidth: 1,
    borderColor: '#E6DDF5',
    marginTop: 15,
  },
  requestLabel: {
    color: '#8A789B',
    fontSize: 15,
    fontWeight: '800',
    letterSpacing: 0.8,
  },
  requestDevice: {
    color: '#554365',
    fontSize: 17,
    fontWeight: '800',
    marginTop: 5,
  },
  requestMeta: {
    color: '#8C7E96',
    fontSize: 15,
    marginTop: 4,
  },
  codePanel: {
    alignItems: 'center',
    borderRadius: 20,
    paddingVertical: 18,
    paddingHorizontal: 14,
    backgroundColor: '#FFF5D9',
    borderWidth: 1,
    borderColor: '#F1DDA2',
    marginTop: 14,
  },
  codeLabel: {
    color: '#8B774C',
    fontSize: 15,
    fontWeight: '800',
  },
  codeValue: {
    color: '#554627',
    fontSize: 35,
    lineHeight: 43,
    fontWeight: '900',
    letterSpacing: 4,
    marginVertical: 3,
  },
  codeHelp: {
    color: '#9A8760',
    fontSize: 15,
  },
  codeInput: {
    height: 54,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#D4E2E0',
    paddingHorizontal: 16,
    color: '#354B4E',
    backgroundColor: '#FAFCFC',
    fontSize: 18,
    fontWeight: '800',
    letterSpacing: 2,
    marginTop: 12,
  },
  attentionCard: {
    borderRadius: 24,
    padding: 20,
    gap: 8,
    backgroundColor: '#FFF1EE',
    borderWidth: 1,
    borderColor: '#F0CEC7',
  },
  attentionText: {
    color: '#965C54',
    fontSize: 16,
    lineHeight: 24,
    fontWeight: '700',
  },
  foldButton: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  foldButtonPressed: {
    opacity: 0.68,
  },
  foldTitle: {
    color: colors.ink,
    fontSize: 19,
    lineHeight: 26,
    fontWeight: '800',
  },
  foldChevron: {
    color: '#5E8984',
    fontSize: 15,
    fontWeight: '800',
  },
  foldContent: {
    gap: 14,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: '#E2ECEA',
  },
  detailGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  detailCell: {
    width: '47%',
    minHeight: 74,
    borderRadius: 16,
    padding: 13,
    backgroundColor: '#F2F9F7',
    borderWidth: 1,
    borderColor: '#DCEBE7',
  },
  detailLabel: {
    color: '#718481',
    fontSize: 15,
    lineHeight: 21,
  },
  detailValue: {
    color: '#365A57',
    fontSize: 21,
    lineHeight: 28,
    fontWeight: '900',
    marginTop: 2,
  },
  detailHint: {
    color: '#758481',
    fontSize: 15,
    lineHeight: 23,
  },
  developmentButton: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: 15,
    paddingHorizontal: 14,
    backgroundColor: '#F5F8F8',
    borderWidth: 1,
    borderColor: '#E0E8E7',
  },
  developmentTitle: {
    color: '#657573',
    fontSize: 16,
    fontWeight: '800',
  },
  developmentPanel: {
    gap: 8,
    borderRadius: 15,
    padding: 14,
    backgroundColor: '#F7F9F9',
  },
  technicalText: {
    color: '#667574',
    fontSize: 15,
    lineHeight: 22,
  },
  feedback: {
    borderRadius: 17,
    padding: 14,
    backgroundColor: '#E5F5EC',
    borderWidth: 1,
    borderColor: '#CBE8D8',
  },
  feedbackError: {
    backgroundColor: '#FFF0EE',
    borderColor: '#F1D0CB',
  },
  feedbackText: {
    color: '#4D7663',
    fontSize: 15,
    lineHeight: 20,
  },
  feedbackErrorText: {
    color: '#9A5E56',
  },
  pageFootnote: {
    color: '#8E9A99',
    fontSize: 15,
    lineHeight: 18,
    textAlign: 'center',
    paddingHorizontal: 18,
    marginTop: 2,
  },
});
