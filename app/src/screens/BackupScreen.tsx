import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native';

import { PostBackupMissingImagesError } from '../backup/postBackupContract';
import {
  ShiyingMissingImagesError,
  type CreateBackupArchiveOptions,
  type RestoreBackupOptions,
} from '../backup/backupTypes';
import {
  BackupRestoreRolledBackError,
  CameraObservationRestoreChoiceRequiredError,
  LegacyBackupSecretsIgnoredNoticeRequiredError,
  cleanupBackupTemporaryFiles,
  createBackupArchive,
  deletePreImportBackupSnapshot,
  listPreImportBackupSnapshots,
  restoreBackupArchive,
  type BackupProgressStage,
  type PreImportBackupSnapshot,
} from '../backup/backupService';
import { getCameraObservationHistorySummary } from '../camera/cameraObservationStore';
import {
  readCameraSensitiveBackupPolicy,
  setCameraSensitiveBackupPolicy,
} from '../backup/cameraBackupPrivacy';
import { AppText as Text } from '../components/AppText';
import { colors } from '../theme/colors';
import type { Navigate } from '../types/navigation';

type Props = { navigate: Navigate };
type Notice = { kind: 'success' | 'error'; text: string } | null;
type OperationStage = BackupProgressStage | 'clearing';

const STAGE_LABELS: Record<OperationStage, string> = {
  'export-preparing': '正在清点行李...',
  'exporting-databases': '正在搬运数据库...',
  'exporting-files': '正在搬运图片与文件...',
  'creating-archive': '正在封装备份包...',
  'validating-archive': '正在验货...',
  'validating-databases': '正在检查数据库...',
  'creating-snapshot': '正在留下导入前快照...',
  restoring: '正在还原...',
  'rolling-back': '还原失败，正在恢复原状...',
  reloading: '搬家完成，正在重新打开君落...',
  clearing: '正在清理快照...',
};
function formatSnapshotTime(value?: string) {
  if (!value) return '暂无';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '暂无';
  return date.toLocaleString();
}
function shiyingMissingImagesDisclosure(error: ShiyingMissingImagesError) {
  return error.message + '\n' + error.missingImages.map((image) =>
    `${image.recordDate} · ${new Date(image.createdAt).toLocaleString()} · 记录 ${image.recordId} · 第 ${image.imageOrdinal + 1} 张`,
  ).join('\n');
}

export function BackupScreen({ navigate }: Props) {
  const [stage, setStage] = useState<OperationStage | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const busy = stage !== null;
  const [snapshots, setSnapshots] = useState<PreImportBackupSnapshot[]>([]);
  const [cameraBackupConsent, setCameraBackupConsent] = useState(false);
  const [cameraPolicyPending, setCameraPolicyPending] = useState(false);
  const [cameraObservationCount, setCameraObservationCount] = useState(0);

  const refreshSnapshots = async () => {
    setSnapshots(await listPreImportBackupSnapshots());
  };

  const refreshCameraObservationCount = async () => {
    const summary = await getCameraObservationHistorySummary();
    setCameraObservationCount(summary.recordCount);
  };

  useEffect(() => {
    void cleanupBackupTemporaryFiles()
      .then((deletedCount) => {
        if (__DEV__) console.info(`[backup] cleaned ${deletedCount} temporary entries`);
      })
      .catch((error) => {
        if (__DEV__) console.warn('[backup] temporary cleanup failed', error);
      });
    void refreshSnapshots();
    void readCameraSensitiveBackupPolicy()
      .then((policy) => setCameraBackupConsent(policy.consentGranted))
      .catch(() => setCameraBackupConsent(false));
    void refreshCameraObservationCount().catch(() => setCameraObservationCount(0));
  }, []);

  const applyCameraBackupConsent = async (consentGranted: boolean) => {
    setCameraPolicyPending(true);
    try {
      const policy = await setCameraSensitiveBackupPolicy(consentGranted);
      setCameraBackupConsent(policy.consentGranted);
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'camera_sensitive_backup_policy_persist_failed' });
    } finally {
      setCameraPolicyPending(false);
    }
  };

  const toggleCameraBackupConsent = (consentGranted: boolean) => {
    if (!consentGranted) {
      void applyCameraBackupConsent(false);
      return;
    }
    Alert.alert(
      '结构化摄像头观察（敏感）',
      `开启后，当前及未来产生的结构化摄像头观察记录可以作为敏感类别进入君落备份。临时原图和你明确保存到外部文件夹的照片始终不会进入备份。当前共有 ${cameraObservationCount} 条结构化观察记录。`,
      [
        { text: '取消', style: 'cancel' },
        { text: '开启', onPress: () => void applyCameraBackupConsent(true) },
      ],
    );
  };

  const latestSnapshot = snapshots[0];

  const exportBackup = async (options: CreateBackupArchiveOptions = {}) => {
    setStage('export-preparing');
    setNotice(null);
    try {
      const archive = await createBackupArchive(setStage, options);
      if (!(await Sharing.isAvailableAsync())) {
        throw new Error('这台设备暂时无法打开系统分享菜单。');
      }
      await Sharing.shareAsync(archive.uri, {
        dialogTitle: '保存君落备份',
        mimeType: 'application/zip',
      });
      setNotice({ kind: 'success', text: '备份包已经准备好。包内没有 API Key 或同步钥匙，但仍包含聊天、记忆等私人资料，请保存到可信位置。'
        + (archive.missingPostImageIds.length ? ` 此包缺少 ${archive.missingPostImageIds.length} 张动态图片，已在包内注明。` : '')
        + (archive.missingShiyingImageIds.length ? ` 此包缺少 ${archive.missingShiyingImageIds.length} 张拾荧记录图片，已在包内注明。` : '') });
    } catch (error) {
      if (error instanceof PostBackupMissingImagesError) {
        Alert.alert('动态图片缺失', error.message + ' 是否备份其余内容，并在包内注明缺图？', [
          { text: '取消', style: 'cancel' },
          { text: '备份其余内容', onPress: () => void exportBackup({ ...options, acceptedMissingPostImageIds: error.imageIds }) },
        ]);
      } else if (error instanceof ShiyingMissingImagesError) {
        Alert.alert('拾荧记录图片缺失', shiyingMissingImagesDisclosure(error) + '\n是否备份其余资料，并在包内注明这些缺图？', [
          { text: '取消', style: 'cancel' },
          { text: '备份其余资料', onPress: () => void exportBackup({ ...options, acceptedMissingShiyingImageIds: error.imageIds }) },
        ]);
      } else setNotice({ kind: 'error', text: error instanceof Error ? error.message : '导出失败了，请稍后重试。' });
    } finally {
      await cleanupBackupTemporaryFiles().catch(() => undefined);
      setStage(null);
    }
  };
  const chooseBackup = async () => {
    if (busy) return;
    const result = await DocumentPicker.getDocumentAsync({
      copyToCacheDirectory: true,
      type: ['application/zip', 'application/x-zip-compressed', 'application/octet-stream'],
    });
    if (result.canceled) return;

    const selected = result.assets[0];
    Alert.alert('还原这份备份？', '选择君落备份后，会用其中的生活资料替换这台手机当前的资料。新版备份也会替换拾荧资料和记录图片；旧版未包含拾荧时，本机拾荧保持原样。本机安全存储里的 Key 保持原样。恢复完成后，旧同步会暂停，等你明确重新建立同步。', [
      { text: '取消', style: 'cancel' },
      {
        text: '还原',
        style: 'destructive',
        onPress: () => {
          void importBackup(selected.uri);
        },
      },
    ]);
  };

  const importBackup = async (
    uri: string,
    options: RestoreBackupOptions = {},
  ) => {
    setStage('validating-archive');
    setNotice(null);
    try {
      const result = await restoreBackupArchive(uri, {
        ...options,
        onStage: setStage,
      });
      await refreshSnapshots();
      await refreshCameraObservationCount();
      const missingText = result.missingDatabases.length
        ? ' 这份旧备份缺少 ' + result.missingDatabases.length + ' 个新版数据库，缺失部分已按旧包规则处理。'
        : '';
      setNotice({
        kind: 'success',
        text: '资料已经恢复。旧同步已暂停；重新打开君落后，可以在“设备与同步”重新建立同步。'
          + (result.cameraObservations === 'replaced'
            ? ' 结构化摄像头观察已由备份内容替换。'
            : result.cameraObservations === 'preserved_local'
              ? ' 结构化摄像头观察未导入，本机历史保持不变。'
              : '')
          + missingText + (result.missingPostImageIds?.length ? ` 仍有 ${result.missingPostImageIds.length} 张动态图片缺失，原位置已保留。` : '')
          + (result.missingShiyingImageIds?.length ? ` 仍有 ${result.missingShiyingImageIds.length} 张拾荧记录图片缺失，原位置已保留。` : ''),
      });
      await cleanupBackupTemporaryFiles().catch(() => undefined);
    } catch (error) {
      if (error instanceof PostBackupMissingImagesError) {
        Alert.alert('动态图片缺失', error.message + ' 是否继续还原其余资料？', [
          { text: '取消还原', style: 'cancel' },
          { text: '继续还原', onPress: () => void importBackup(uri, { ...options, acceptedMissingPostImageIds: error.imageIds }) },
        ]);
      } else if (error instanceof ShiyingMissingImagesError) {
        Alert.alert('拾荧记录图片缺失', shiyingMissingImagesDisclosure(error) + '\n是否继续还原其余资料，并保留这些缺图的位置？', [
          { text: '取消还原', style: 'cancel' },
          { text: '继续还原', onPress: () => void importBackup(uri, { ...options, acceptedMissingShiyingImageIds: error.imageIds }) },
        ]);
      } else if (error instanceof LegacyBackupSecretsIgnoredNoticeRequiredError) {
        Alert.alert(
          '旧备份里的秘密不会导入',
          '这份旧备份包含旧式秘密记录。君落只恢复生活资料，不导入或覆盖本机 Key。',
          [
            { text: '取消还原', style: 'cancel' },
            {
              text: '继续还原生活资料',
              onPress: () => void importBackup(uri, { ...options, acceptIgnoredLegacySecrets: true }),
            },
          ],
        );
      } else if (error instanceof CameraObservationRestoreChoiceRequiredError) {
        Alert.alert(
          '这份备份包含敏感观察记录',
          `备份中有 ${error.recordCount} 条结构化摄像头观察。你可以用它们替换本机观察历史，或只恢复其他数据并保留本机历史。临时原图和外部保存照片不在备份中。`,
          [
            { text: '取消还原', style: 'cancel' },
            {
              text: '只恢复其他数据',
              onPress: () => void importBackup(uri, { ...options, cameraObservations: 'preserve_local' }),
            },
            {
              text: '包含并替换观察历史',
              style: 'destructive',
              onPress: () => void importBackup(uri, { ...options, cameraObservations: 'replace' }),
            },
          ],
        );
      } else if (error instanceof BackupRestoreRolledBackError) {
        setNotice({ kind: 'error', text: error.message + ' 正在重新打开君落。' });
        await cleanupBackupTemporaryFiles().catch(() => undefined);
      } else {
        setNotice({ kind: 'error', text: error instanceof Error ? error.message : '还原失败了，请确认选择的是君落备份包。' });
      }
    } finally {
      await cleanupBackupTemporaryFiles().catch(() => undefined);
      setStage(null);
    }
  };
  const clearSnapshots = async () => {
    if (busy || !snapshots.length) return;
    Alert.alert('清理导入前快照？', '每次导入前会在本机保留一份回退快照；下一次导入会替换上一份。快照不包含 API Key、同步钥匙或同步历史。', [
      { text: '取消', style: 'cancel' },
      {
        text: '清理',
        style: 'destructive',
        onPress: () => {
          void (async () => {
            setStage('clearing');
            setNotice(null);
            try {
              await Promise.all(snapshots.map((snapshot) => deletePreImportBackupSnapshot(snapshot.id)));
              await refreshSnapshots();
              setNotice({ kind: 'success', text: '导入前快照已经清理。手动导出的备份包不会受影响。' });
            } catch (error) {
              setNotice({ kind: 'error', text: error instanceof Error ? error.message : '清理失败了，请稍后再试。' });
            } finally {
              await cleanupBackupTemporaryFiles().catch(() => undefined);
              setStage(null);
            }
          })();
        },
      },
    ]);
  };

  return (
    <View style={styles.page}>
      <View style={styles.header}>
        <Pressable onPress={() => navigate('settings')} style={styles.backButton}>
          <Text style={styles.backText}>回</Text>
        </Pressable>
        <Text style={styles.title}>备份与迁移</Text>
        <View style={styles.backButton} />
      </View>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.intro}>
          <Text style={styles.introTitle}>带着白云小姐搬家</Text>
          <Text style={styles.introText}>普通备份会保存聊天、记忆、日程、账本、设置和本机媒体资料。API Key、token、同步钥匙与同步历史不进入普通备份。</Text>
        </View>

        {stage ? (
          <View style={styles.progressNotice}>
            <Text style={styles.noticeText}>{STAGE_LABELS[stage]}</Text>
          </View>
        ) : null}
        {notice ? (
          <View style={[styles.notice, notice.kind === 'success' ? styles.successNotice : styles.errorNotice]}>
            <Text style={styles.noticeText}>{notice.text}</Text>
          </View>
        ) : null}
        <View style={styles.coverageCard}>
          <Text style={styles.coverageTitle}>备份包体检</Text>
          <Text style={styles.coverageText}>普通备份会保存聊天、记忆、日程、账本、设置和本机媒体资料。API Key、token、同步钥匙与同步历史不进入普通备份。</Text>
          <Text style={styles.coverageText}>新版备份包含拾荧荧迹、自我记录草稿与定稿、记录图片、事件和回顾资料；恢复时一并替换。本机自动开关、通知偏好和已用额度不随备份倒退。</Text>
          <Text style={styles.coverageText}>临时摄像头帧和明确保存到外部文件夹的照片始终不进入备份；结构化摄像头观察仅在敏感开关开启时加入独立负载。当前记录为 {cameraObservationCount} 条。</Text>
          <Text style={styles.coverageText}>旧版备份包仍可导入；但旧包当时没有保存的新功能数据，不会凭空恢复。</Text>
          <Text style={styles.coverageText}>旧版备份未包含拾荧时，本机拾荧资料保持原样。缺图会在继续导出或还原前列出；未列明的缺图或损坏图会停止操作。</Text>
        </View>

        <View style={styles.cameraPrivacyCard}>
          <View style={styles.cameraPolicyRow}>
            <View style={styles.cameraPolicyCopy}>
              <Text style={styles.cardTitle}>结构化摄像头观察（敏感）</Text>
              <Text style={styles.cardText}>默认关闭。开启后，当前及未来的结构化记录可作为敏感类别进入备份；临时原图和外部保存照片始终排除。</Text>
            </View>
            <Switch
              disabled={busy || cameraPolicyPending}
              onValueChange={toggleCameraBackupConsent}
              trackColor={{ false: '#EADDE4', true: '#E7A4BA' }}
              thumbColor={cameraBackupConsent ? '#C95F82' : '#FFFFFF'}
              value={cameraBackupConsent}
            />
          </View>
          <Text style={styles.cameraPolicyState}>{cameraBackupConsent ? `已授权 · 当前可包含 ${cameraObservationCount} 条` : `未授权 · 当前 ${cameraObservationCount} 条不会进入备份`}</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>导出备份</Text>
          <Text style={styles.cardText}>生成一个未加密的 ZIP 文件，通过手机分享菜单保存。包内没有 API Key 或同步钥匙，但仍包含聊天、记忆等私人资料，请保存到可信位置。</Text>
          <Pressable disabled={busy} onPress={() => void exportBackup()} style={styles.primaryButton}>
            <Text style={styles.primaryButtonText}>{stage && ['export-preparing', 'exporting-databases', 'exporting-files', 'creating-archive'].includes(stage) ? STAGE_LABELS[stage] : '生成备份包'}</Text>
          </Pressable>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>导入还原</Text>
          <Text style={styles.cardText}>选择君落备份后，会用其中的生活资料替换这台手机当前的资料。新版备份也会替换拾荧资料和记录图片；旧版未包含拾荧时，本机拾荧保持原样。本机安全存储里的 Key 保持原样。恢复完成后，旧同步会暂停，等你明确重新建立同步。</Text>
          <Pressable disabled={busy} onPress={() => void chooseBackup()} style={styles.secondaryButton}>
            <Text style={styles.secondaryButtonText}>{stage && !['export-preparing', 'exporting-databases', 'exporting-files', 'creating-archive', 'clearing'].includes(stage) ? STAGE_LABELS[stage] : '选择备份文件'}</Text>
          </Pressable>
        </View>

        <View style={styles.snapshotCard}>
          <Text style={styles.cardTitle}>导入前快照</Text>
          <Text style={styles.cardText}>每次导入前会在本机保留一份回退快照；下一次导入会替换上一份。快照不包含 API Key、同步钥匙或同步历史。</Text>
          <View style={styles.snapshotRow}>
            <Text style={styles.snapshotLabel}>已保留</Text>
            <Text style={styles.snapshotValue}>{snapshots.length} / 1 份</Text>
          </View>
          <View style={styles.snapshotRow}>
            <Text style={styles.snapshotLabel}>最新</Text>
            <Text style={styles.snapshotValue}>{formatSnapshotTime(latestSnapshot?.createdAt)}</Text>
          </View>
          <Pressable disabled={busy || !snapshots.length} onPress={() => void clearSnapshots()} style={[styles.lightDangerButton, !snapshots.length ? styles.disabledButton : null]}>
            <Text style={styles.lightDangerButtonText}>清理导入前快照</Text>
          </Pressable>
        </View>

      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, paddingTop: 42, paddingHorizontal: 18, backgroundColor: '#FFF9F4' },
  header: { height: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 },
  content: { paddingBottom: 42 },
  backButton: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.cardStrong },
  backText: { color: colors.ink, fontWeight: '700' },
  title: { color: colors.ink, fontSize: 24, fontWeight: '700' },
  intro: { borderRadius: 20, backgroundColor: '#EAF4FF', padding: 16, marginBottom: 14 },
  introTitle: { color: '#557CA1', fontSize: 18, fontWeight: '700', marginBottom: 7 },
  introText: { color: '#67839D', fontSize: 13, lineHeight: 20 },
  coverageCard: { borderRadius: 17, backgroundColor: '#F7FBFF', borderWidth: 1, borderColor: '#D8EAF8', padding: 14, marginBottom: 12 },
  coverageTitle: { color: '#557CA1', fontSize: 15, fontWeight: '700', marginBottom: 7 },
  coverageText: { color: colors.muted, fontSize: 12, lineHeight: 19, marginBottom: 5 },
  cameraPrivacyCard: { borderRadius: 18, borderWidth: 1, borderColor: '#F0C7D5', backgroundColor: '#FFF7FA', padding: 15, marginBottom: 12 },
  cameraPolicyRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  cameraPolicyCopy: { flex: 1 },
  cameraPolicyState: { color: '#A95070', fontSize: 12, fontWeight: '700', marginTop: 8 },
  card: { borderRadius: 18, borderWidth: 1, borderColor: '#FFE0D7', backgroundColor: '#FFFFFF', padding: 15, marginBottom: 12 },
  snapshotCard: { borderRadius: 18, borderWidth: 1, borderColor: '#D8EAF8', backgroundColor: '#F7FBFF', padding: 15, marginBottom: 12 },
  cardTitle: { color: colors.ink, fontSize: 16, fontWeight: '700', marginBottom: 7 },
  cardText: { color: colors.muted, fontSize: 13, lineHeight: 20, marginBottom: 14 },
  snapshotRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 8 },
  snapshotLabel: { color: '#557CA1', fontSize: 13, fontWeight: '700' },
  snapshotValue: { flex: 1, color: colors.muted, fontSize: 12, textAlign: 'right' },
  primaryButton: { height: 47, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: '#EE8D7D' },
  primaryButtonText: { color: '#FFFFFF', fontSize: 14, fontWeight: '700' },
  secondaryButton: { height: 47, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: '#EAF4FF' },
  secondaryButtonText: { color: '#557CA1', fontSize: 14, fontWeight: '700' },
  lightDangerButton: { height: 43, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFF2EE', borderWidth: 1, borderColor: '#FFD3C9', marginTop: 4 },
  lightDangerButtonText: { color: '#B76558', fontSize: 13, fontWeight: '700' },
  disabledButton: { opacity: 0.45 },
  progressNotice: { borderRadius: 14, paddingHorizontal: 13, paddingVertical: 11, marginBottom: 12, backgroundColor: '#EAF4FF' },
  notice: { borderRadius: 14, paddingHorizontal: 13, paddingVertical: 11, marginBottom: 12 },
  successNotice: { backgroundColor: '#E8F6EB' },
  errorNotice: { backgroundColor: '#FFEAE5' },
  noticeText: { color: colors.ink, fontSize: 13, lineHeight: 19 },
});
