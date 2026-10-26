import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { canCommitBackupRestoreDataEpoch, captureBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';

import { CameraVisionStructuredResultView } from '../camera/CameraVisionStructuredResultView';
import { seedSyntheticCameraObservationsForDebug } from '../camera/cameraObservationDebug';
import { describeCameraObservationResponseStatus } from '../camera/cameraManualReplyPreference';
import {
  cancelCameraObservationResponse,
  countCameraObservationsInRange,
  deleteAllCameraObservations,
  deleteCameraObservation,
  deleteCameraObservationsInRange,
  getCameraObservationHistorySummary,
  getCameraObservationRecord,
  getCameraObservationResponse,
  listCameraObservations,
  subscribeSavedCameraObservations,
} from '../camera/cameraObservationStore';
import type {
  CameraObservationCursor,
  CameraObservationHistorySummary,
  CameraObservationRecordV1,
  CameraObservationResponse,
  CameraObservationTimelineItem,
} from '../camera/cameraObservationTypes';
import { AppText as Text } from '../components/AppText';
import type { Navigate } from '../types/navigation';

type Props = { navigate: Navigate };
type Notice = { kind: 'ok' | 'warning'; text: string };

function formatDateTime(timestamp?: number) {
  if (!timestamp) return '暂无';
  return new Date(timestamp).toLocaleString('zh-CN', { hour12: false });
}

function describeTrigger(trigger: CameraObservationRecordV1['triggerKind']) {
  if (trigger === 'manual_look') return '手动现在看一眼';
  if (trigger === 'action_opportunity') return '行动机会';
  if (trigger === 'max_interval_deadline') return '最迟观察时间';
  return '失败后重试';
}

function describePeople(item: CameraObservationTimelineItem) {
  return item.visibleCount === null ? '人数未知' : `${item.visibleCount} 人`;
}

function parseLocalDate(value: string, endExclusive: boolean) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day + (endExclusive ? 1 : 0));
  const original = new Date(year, month - 1, day);
  if (original.getFullYear() !== year || original.getMonth() !== month - 1 || original.getDate() !== day) return undefined;
  return date.getTime();
}

function confirm(title: string, message: string, confirmText: string) {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    Alert.alert(title, message, [
      { text: '取消', style: 'cancel', onPress: () => finish(false) },
      { text: confirmText, style: 'destructive', onPress: () => finish(true) },
    ], { cancelable: true, onDismiss: () => finish(false) });
  });
}

export function CameraObservationHistoryScreen({ navigate }: Props) {
  const [summary, setSummary] = useState<CameraObservationHistorySummary>({ recordCount: 0 });
  const [items, setItems] = useState<CameraObservationTimelineItem[]>([]);
  const [nextCursor, setNextCursor] = useState<CameraObservationCursor>();
  const [selected, setSelected] = useState<CameraObservationRecordV1>();
  const [selectedResponse, setSelectedResponse] = useState<CameraObservationResponse>();
  const [responseUnavailable, setResponseUnavailable] = useState(false);
  const [cancellingResponse, setCancellingResponse] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [seedingCount, setSeedingCount] = useState<number>();
  const [seedProgress, setSeedProgress] = useState(0);
  const [notice, setNotice] = useState<Notice>();
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  const loadFirstPage = useCallback(async () => {
    setLoading(true);
    setNotice(undefined);
    try {
      const [nextSummary, page] = await Promise.all([
        getCameraObservationHistorySummary(),
        listCameraObservations(),
      ]);
      setSummary(nextSummary);
      setItems(page.records);
      setNextCursor(page.nextCursor);
    } catch (error) {
      setNotice({ kind: 'warning', text: error instanceof Error ? error.message : 'camera_observation_store_unavailable' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadFirstPage(); }, [loadFirstPage]);

  useEffect(() => {
    if (!selected) return;
    let mounted = true;
    const refresh = () => {
      void getCameraObservationResponse(selected.observationId).then((response) => {
        if (mounted) { setSelectedResponse(response); setResponseUnavailable(false); }
      }).catch(() => { if (mounted) setResponseUnavailable(true); });
    };
    const unsubscribe = subscribeSavedCameraObservations(refresh);
    return () => { mounted = false; unsubscribe(); };
  }, [selected?.observationId]);

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await listCameraObservations({
        cursor: { capturedAt: nextCursor.capturedAt, observationId: nextCursor.observationId },
      });
      setItems((current) => [...current, ...page.records]);
      setNextCursor(page.nextCursor);
    } catch (error) {
      setNotice({ kind: 'warning', text: error instanceof Error ? error.message : 'camera_observation_store_unavailable' });
    } finally {
      setLoadingMore(false);
    }
  };

  const openRecord = async (observationId: string) => {
    setLoading(true);
    setNotice(undefined);
    try {
      const [record, response] = await Promise.all([
        getCameraObservationRecord(observationId),
        getCameraObservationResponse(observationId),
      ]);
      setSelected(record);
      setSelectedResponse(response);
      setResponseUnavailable(false);
    }
    catch (error) { setNotice({ kind: 'warning', text: error instanceof Error ? error.message : 'camera_observation_not_found' }); }
    finally { setLoading(false); }
  };

  const cancelSelectedResponse = async () => {
    if (!selected || cancellingResponse || deleting) return;
    const observationId = selected.observationId;
    const dataEpoch = captureBackupRestoreDataEpoch();
    setCancellingResponse(true);
    try {
      const cancelled = await runBackupRestoreDataEpochCommit(dataEpoch, () => cancelCameraObservationResponse(observationId));
      if (!cancelled.committed || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      const response = await getCameraObservationResponse(observationId);
      if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      setSelectedResponse(response);
      setResponseUnavailable(false);
      const page = await listCameraObservations();
      setItems(page.records);
      setNextCursor(page.nextCursor);
      setNotice({ kind: 'ok', text: response?.status === 'cancelled' ? '已取消待回应，观察记录仍保留。' : `回应状态：${describeCameraObservationResponseStatus(response?.status ?? 'not_scheduled')}。` });
    } catch (error) {
      setNotice({ kind: 'warning', text: error instanceof Error ? error.message : 'camera_observation_response_cancel_failed' });
    } finally { setCancellingResponse(false); }
  };

  const deleteSelected = async () => {
    if (!selected || deleting) return;
    if (!(await confirm('删除这条观察', '删除后无法撤销；已有旧备份不会同步删除。', '确认删除'))) return;
    setDeleting(true);
    try {
      await deleteCameraObservation(selected.observationId);
      setSelected(undefined);
      await loadFirstPage();
      setNotice({ kind: 'ok', text: '已删除 1 条观察记录。' });
    } catch (error) {
      setNotice({ kind: 'warning', text: error instanceof Error ? error.message : 'camera_observation_delete_failed' });
    } finally { setDeleting(false); }
  };

  const deleteRange = async () => {
    if (deleting) return;
    const start = parseLocalDate(startDate, false);
    const end = parseLocalDate(endDate, true);
    if (start === undefined || end === undefined || end <= start) {
      setNotice({ kind: 'warning', text: '请输入有效的开始日和结束日（YYYY-MM-DD）。' });
      return;
    }
    setDeleting(true);
    try {
      const count = await countCameraObservationsInRange(start, end);
      if (count === 0) {
        setNotice({ kind: 'ok', text: '这个日期范围内没有观察记录。' });
        return;
      }
      if (!(await confirm('删除日期范围', `将删除 ${count} 条观察记录，删除后无法撤销；已有旧备份不会同步删除。`, `删除 ${count} 条`))) return;
      const deleted = await deleteCameraObservationsInRange(start, end);
      await loadFirstPage();
      setNotice({ kind: 'ok', text: `已删除 ${deleted} 条观察记录。` });
    } catch (error) {
      setNotice({ kind: 'warning', text: error instanceof Error ? error.message : 'camera_observation_delete_failed' });
    } finally { setDeleting(false); }
  };

  const deleteAll = async () => {
    if (deleting || summary.recordCount === 0) return;
    if (!(await confirm('删除全部观察', `将删除全部 ${summary.recordCount} 条观察记录，删除后无法撤销；已有旧备份不会同步删除。`, `删除全部 ${summary.recordCount} 条`))) return;
    setDeleting(true);
    try {
      const deleted = await deleteAllCameraObservations();
      await loadFirstPage();
      setNotice({ kind: 'ok', text: `已删除 ${deleted} 条观察记录。` });
    } catch (error) {
      setNotice({ kind: 'warning', text: error instanceof Error ? error.message : 'camera_observation_delete_failed' });
    } finally { setDeleting(false); }
  };

  const seedDebugRecords = async (count: 1 | 1000) => {
    if (seedingCount !== undefined) return;
    setSeedingCount(count);
    setSeedProgress(0);
    setNotice(undefined);
    try {
      const seeded = await seedSyntheticCameraObservationsForDebug(count, setSeedProgress);
      await loadFirstPage();
      setNotice({ kind: 'ok', text: `已生成 ${seeded} 条 Debug 合成观察记录。` });
    } catch (error) {
      setNotice({ kind: 'warning', text: error instanceof Error ? error.message : 'camera_observation_persist_failed' });
    } finally {
      setSeedingCount(undefined);
    }
  };

  const goBack = () => selected ? setSelected(undefined) : navigate('camera-perception');

  if (selected) {
    const analysis = {
      result: selected.result,
      attemptCount: selected.analysis.attemptCount,
      repairUsed: selected.analysis.repairUsed,
      responseFormatRequested: selected.analysis.responseFormatRequested,
      provider: selected.analysis.provider,
      model: selected.analysis.model,
      latencyMs: selected.analysis.latencyMs,
    } as const;
    return (
      <SafeAreaView edges={['top', 'bottom']} style={styles.page}>
        <View style={styles.header}>
          <Pressable accessibilityLabel="返回观察历史" onPress={goBack} style={styles.backButton}><Text style={styles.backText}>‹</Text></Pressable>
          <View><Text style={styles.eyebrow}>OBSERVATION DETAIL</Text><Text style={styles.title}>观察详情</Text></View>
          <View style={styles.headerSpacer} />
        </View>
        {notice ? <View style={[styles.notice, notice.kind === 'warning' && styles.noticeWarning]}><Text style={styles.noticeText}>{notice.text}</Text></View> : null}
        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          <View style={styles.metaCard}>
            <Text style={styles.metaTitle}>{formatDateTime(selected.capturedAt)}</Text>
            <Text style={styles.metaText}>{selected.sourceKind === 'android_front' ? '前置镜头' : '后置镜头'} · {describeTrigger(selected.triggerKind)}</Text>
            <Text style={styles.metaText}>{selected.capture.width}×{selected.capture.height} · 旋转 {selected.capture.rotation}° · {selected.capture.mirrored ? '已镜像' : '未镜像'}</Text>
            <Text style={styles.metaText}>临时帧：已验证删除 · 清理证明{selected.cleanup.auditPersisted ? '已记录' : '不可用'}</Text>
            <Text style={styles.metaText}>回应状态：{responseUnavailable ? '暂不可用' : describeCameraObservationResponseStatus(selectedResponse?.status ?? 'not_scheduled')}</Text>
          </View>
          <CameraVisionStructuredResultView
            analysis={analysis}
            deletionLabel="已验证删除"
            persistenceLabel={`回应状态：${responseUnavailable ? '暂不可用' : describeCameraObservationResponseStatus(selectedResponse?.status ?? 'not_scheduled')}。`}
          />
          {!responseUnavailable && (selectedResponse?.status === 'pending' || selectedResponse?.status === 'draft_ready') ? <Pressable disabled={cancellingResponse || deleting} onPress={() => void cancelSelectedResponse()} style={[styles.rangeButton, (cancellingResponse || deleting) && styles.disabled]}>
            <Text style={styles.rangeButtonText}>{cancellingResponse ? '正在取消' : '取消待回应'}</Text>
          </Pressable> : null}
          <Pressable disabled={deleting || cancellingResponse} onPress={() => void deleteSelected()} style={[styles.deleteButton, (deleting || cancellingResponse) && styles.disabled]}>
            <Text style={styles.deleteButtonText}>{deleting ? '正在删除' : '删除这条观察'}</Text>
          </Pressable>
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView edges={['top', 'bottom']} style={styles.page}>
      <View style={styles.header}>
        <Pressable accessibilityLabel="返回白云的视线" onPress={goBack} style={styles.backButton}><Text style={styles.backText}>‹</Text></Pressable>
        <View><Text style={styles.eyebrow}>CAMERA OBSERVATIONS</Text><Text style={styles.title}>观察历史</Text></View>
        <View style={styles.headerSpacer} />
      </View>
      {notice ? <View style={[styles.notice, notice.kind === 'warning' && styles.noticeWarning]}><Text style={styles.noticeText}>{notice.text}</Text></View> : null}
      {loading ? <View style={styles.loading}><ActivityIndicator color="#C95F82" /><Text style={styles.emptyText}>正在读取观察历史…</Text></View> : (
        <FlatList
          contentContainerStyle={styles.content}
          data={items}
          keyExtractor={(item) => item.observationId}
          ListHeaderComponent={<>
            <View style={styles.summaryCard}>
              <Text style={styles.cardTitle}>已保存 {summary.recordCount} 条观察</Text>
              <Text style={styles.cardDetail}>最近观察：{formatDateTime(summary.latestCapturedAt)}</Text>
              <Text style={styles.cardDetail}>记录长期保留，直到你亲手删除；待回应可在记录详情中取消。</Text>
            </View>
            {__DEV__ ? <View style={styles.debugCard}>
              <Text style={styles.cardTitle}>第十一章 Debug 合成记录</Text>
              <Text style={styles.cardDetail}>只写入结构化测试文字；不打开摄像头、不调用模型，也不生成图片。验收结束后请删除这些测试记录。</Text>
              <Pressable disabled={seedingCount !== undefined} onPress={() => void seedDebugRecords(1)} style={[styles.rangeButton, seedingCount !== undefined && styles.disabled]}>
                <Text style={styles.rangeButtonText}>{seedingCount === 1 ? '正在生成 1/1' : '生成 1 条合成记录'}</Text>
              </Pressable>
              <Pressable disabled={seedingCount !== undefined} onPress={() => void seedDebugRecords(1000)} style={[styles.rangeButton, seedingCount !== undefined && styles.disabled]}>
                <Text style={styles.rangeButtonText}>{seedingCount === 1000 ? `正在生成 ${seedProgress}/1000` : '生成 1000 条合成记录'}</Text>
              </Pressable>
            </View> : null}
            {items.length === 0 ? <View style={styles.emptyCard}><Text style={styles.emptyTitle}>还没有观察记录</Text><Text style={styles.emptyText}>完成一次正式“现在看一眼”后，合格结果会在临时帧验证删除后自动保存。</Text></View> : null}
          </>}
          ListFooterComponent={<View style={styles.footer}>
            {nextCursor ? <Pressable disabled={loadingMore} onPress={() => void loadMore()} style={[styles.moreButton, loadingMore && styles.disabled]}><Text style={styles.moreButtonText}>{loadingMore ? '正在加载' : '再加载 30 条'}</Text></Pressable> : null}
            <View style={styles.deleteCard}>
              <Text style={styles.cardTitle}>删除管理</Text>
              <Text style={styles.cardDetail}>日期按手机本地时间计算。删除没有撤销按钮，已有旧备份不会同步删除。</Text>
              <View style={styles.dateRow}>
                <TextInput onChangeText={setStartDate} placeholder="开始日 YYYY-MM-DD" placeholderTextColor="#AE9AA3" style={styles.dateInput} value={startDate} />
                <TextInput onChangeText={setEndDate} placeholder="结束日 YYYY-MM-DD" placeholderTextColor="#AE9AA3" style={styles.dateInput} value={endDate} />
              </View>
              <Pressable disabled={deleting} onPress={() => void deleteRange()} style={[styles.rangeButton, deleting && styles.disabled]}><Text style={styles.rangeButtonText}>统计并删除日期范围</Text></Pressable>
              <Pressable disabled={deleting || summary.recordCount === 0} onPress={() => void deleteAll()} style={[styles.deleteButton, (deleting || summary.recordCount === 0) && styles.disabled]}><Text style={styles.deleteButtonText}>删除全部观察</Text></Pressable>
            </View>
          </View>}
          renderItem={({ item }) => <Pressable onPress={() => void openRecord(item.observationId)} style={styles.timelineCard}>
            <View style={styles.timelineHeader}><Text style={styles.timelineTime}>{formatDateTime(item.capturedAt)}</Text><Text style={styles.timelineFacing}>{item.sourceKind === 'android_front' ? '前置' : '后置'}</Text></View>
            <Text style={styles.timelineTrigger}>{describeTrigger(item.triggerKind)}</Text>
            <Text style={styles.timelineSummary}>{item.sceneSummary}</Text>
            <View style={styles.chips}><Text style={styles.chip}>{item.frameUsability}</Text><Text style={styles.chip}>{item.overallConfidence}</Text><Text style={styles.chip}>{describePeople(item)}</Text></View>
            <Text style={styles.responseStatus}>{describeCameraObservationResponseStatus(item.responseStatus)}</Text>
          </Pressable>}
          showsVerticalScrollIndicator={false}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#FFF8FB' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 18, paddingVertical: 12 },
  backButton: { width: 46, height: 46, borderRadius: 23, borderWidth: 1, borderColor: '#F0CEDA', backgroundColor: '#FFFCFD', alignItems: 'center', justifyContent: 'center' },
  backText: { color: '#3D4657', fontSize: 38, lineHeight: 40 },
  headerSpacer: { width: 46 },
  eyebrow: { color: '#B35D7A', fontSize: 11, fontWeight: '800', letterSpacing: 2, textAlign: 'center' },
  title: { color: '#343B4D', fontSize: 28, fontWeight: '800', textAlign: 'center' },
  content: { paddingHorizontal: 18, paddingBottom: 36, gap: 14 },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10 },
  notice: { marginHorizontal: 18, marginBottom: 12, borderRadius: 18, padding: 13, backgroundColor: '#EAF5E7' },
  noticeWarning: { backgroundColor: '#FFF0E8' },
  noticeText: { color: '#5C5260', fontSize: 13, lineHeight: 19 },
  summaryCard: { borderRadius: 24, borderWidth: 1, borderColor: '#F0CFDA', backgroundColor: '#FFFDFE', padding: 18, gap: 7 },
  debugCard: { borderRadius: 24, borderWidth: 1, borderColor: '#E5D8F4', backgroundColor: '#F9F4FF', padding: 18, gap: 10 },
  cardTitle: { color: '#3E4352', fontSize: 20, fontWeight: '800' },
  cardDetail: { color: '#766E7D', fontSize: 14, lineHeight: 21 },
  emptyCard: { borderRadius: 22, backgroundColor: '#FFF0F5', padding: 18, gap: 7 },
  emptyTitle: { color: '#9C5570', fontSize: 17, fontWeight: '800' },
  emptyText: { color: '#817782', fontSize: 14, lineHeight: 21 },
  timelineCard: { borderRadius: 22, borderWidth: 1, borderColor: '#E5D8F4', backgroundColor: '#F9F4FF', padding: 16, gap: 8 },
  timelineHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  timelineTime: { color: '#51435D', fontSize: 15, fontWeight: '700' },
  timelineFacing: { color: '#A34F70', backgroundColor: '#FFE4ED', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4, fontSize: 12, fontWeight: '800' },
  timelineTrigger: { color: '#8C7180', fontSize: 12 },
  timelineSummary: { color: '#3E4351', fontSize: 15, lineHeight: 22 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  chip: { color: '#6A526B', backgroundColor: '#F0E2F4', borderRadius: 999, paddingHorizontal: 9, paddingVertical: 4, fontSize: 12, fontWeight: '700' },
  responseStatus: { color: '#A65B77', fontSize: 13, fontWeight: '700' },
  footer: { gap: 14, paddingTop: 4 },
  moreButton: { minHeight: 46, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFE5EE' },
  moreButtonText: { color: '#A95070', fontSize: 14, fontWeight: '800' },
  deleteCard: { borderRadius: 24, borderWidth: 1, borderColor: '#F0CFDA', backgroundColor: '#FFFCFD', padding: 18, gap: 10 },
  dateRow: { gap: 9 },
  dateInput: { minHeight: 46, borderRadius: 14, borderWidth: 1, borderColor: '#EFC8D5', backgroundColor: '#FFF6F9', color: '#454A58', paddingHorizontal: 13, fontSize: 14 },
  rangeButton: { minHeight: 46, borderRadius: 15, borderWidth: 1, borderColor: '#E8BFD0', alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFE8F0' },
  rangeButtonText: { color: '#A34F70', fontSize: 14, fontWeight: '800' },
  deleteButton: { minHeight: 48, borderRadius: 16, borderWidth: 1, borderColor: '#E4AFC0', alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFF4F6' },
  deleteButtonText: { color: '#A33E60', fontSize: 14, fontWeight: '800' },
  disabled: { opacity: 0.45 },
  metaCard: { borderRadius: 22, borderWidth: 1, borderColor: '#F0CFDA', backgroundColor: '#FFFDFE', padding: 16, gap: 6 },
  metaTitle: { color: '#4A4350', fontSize: 17, fontWeight: '800' },
  metaText: { color: '#756D7B', fontSize: 13, lineHeight: 20 },
});
