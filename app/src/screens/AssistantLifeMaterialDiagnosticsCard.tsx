import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import type { AiConnection, AiProfile } from '../ai/types';
import type { AssistantLifeDay } from '../ai/assistantLifeTimeline';
import type { AssistantLifeGenerationDiagnostic } from '../ai/assistantLifeGenerationDiagnostics';
import {
  assistantLifeFailureReasonLabel,
  assistantLifeFlowLabel,
  assistantLifeRequestCount,
  lifeMaterialFreshnessLabel,
  lifeMaterialImportanceLabel,
  lifeMaterialSourceLabel,
  summarizeAssistantLifeDiagnostics,
  type ClassifiedAssistantLifeDiagnostic,
} from '../ai/assistantLifeDiagnosticsPresentation';
import type { AssistantStatePersistenceDiagnostic } from '../ai/assistantStatePersistenceDiagnostics';
import type { LifeMaterialItem, LifeMaterialSnapshot } from '../ai/lifeMaterialHub';
import { AppText as Text } from '../components/AppText';
import { colors } from '../theme/colors';

type Props = {
  connection?: AiConnection;
  day: AssistantLifeDay | null;
  diagnostics: AssistantLifeGenerationDiagnostic[];
  isRefreshing: boolean;
  onRefresh: () => void;
  persistenceDiagnostic: AssistantStatePersistenceDiagnostic | null;
  profile: AiProfile;
  snapshot: LifeMaterialSnapshot | null;
};

type DiagnosticContext = AssistantLifeGenerationDiagnostic['contextSource'];

function formatTime(timestamp?: number) {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return '时间未知';
  const date = new Date(timestamp);
  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
}

function materialMeta(item: LifeMaterialItem) {
  return `${lifeMaterialSourceLabel(item.source)} · ${lifeMaterialFreshnessLabel(item.freshness)} · ${lifeMaterialImportanceLabel(item.importance)}`;
}

function diagnosticStatusText(record: ClassifiedAssistantLifeDiagnostic) {
  const { diagnostic } = record;
  if (diagnostic.status === 'budget-skipped') {
    const count = diagnostic.occurrenceCount ?? 1;
    return count > 1 ? `预算拦截，未调用（合并 ${count} 次）` : '预算拦截，未调用';
  }
  const count = assistantLifeRequestCount(diagnostic);
  const base = count === null ? '请求次数：旧记录未记录'
    : `实际请求 ${count} 次${diagnostic.failureReason ? ` · ${assistantLifeFailureReasonLabel(diagnostic.failureReason)}` : ''}`;
  if (record.classification === 'allowed-retry') return `${base} · 按规则重试`;
  if (record.classification === 'duplicate') return `${base} · 异常重复`;
  return base;
}

function MaterialRow({ item, technical }: { item: LifeMaterialItem; technical: boolean }) {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailTitle}>{materialMeta(item)}</Text>
      <Text style={styles.detailBody}>{item.promptLine}</Text>
      {technical ? (
        <View style={styles.technicalBlock}>
          <Text style={styles.technicalText}>指纹：{item.fingerprint}</Text>
          <Text style={styles.technicalText}>发生：{formatTime(item.occurredAt)}</Text>
          <Text style={styles.technicalText}>到期：{item.expiresAt ? formatTime(item.expiresAt) : '未设置'}</Text>
        </View>
      ) : null}
    </View>
  );
}

function DiagnosticRow({ record, technical }: { record: ClassifiedAssistantLifeDiagnostic; technical: boolean }) {
  const { diagnostic } = record;
  const meta = [
    formatTime(diagnostic.lastOccurredAt ?? diagnostic.attemptedAt),
    assistantLifeFlowLabel(diagnostic.flow),
    diagnostic.model || '模型未知',
    diagnostic.scheduleSlot ? `时段 ${diagnostic.scheduleSlot}` : '',
  ].filter(Boolean).join(' · ');
  const tokenText = diagnostic.status === 'budget-skipped'
    ? '未产生 token'
    : `Prompt ${diagnostic.promptTokens ?? '未知'} · 输出 ${diagnostic.completionTokens ?? '未知'}`;
  return (
    <View style={styles.detailRow}>
      <Text style={[
        styles.detailTitle,
        record.classification === 'duplicate' && styles.dangerText,
      ]}>
        {diagnosticStatusText(record)}
      </Text>
      <Text style={styles.detailMeta}>{meta}</Text>
      <Text style={styles.detailMeta}>{tokenText} · JSON {diagnostic.responseFormatRequested ? '已请求' : '未请求'}</Text>
      {(diagnostic.requests ?? []).map((request, index) => (
        <Text key={index} style={styles.detailMeta}>
          请求 {index + 1}：{request.transport?.outcome ?? (request.status === 'not-started' ? '未联网' : '旧记录未记录网络结果')}
          {' · '}解析：{request.outputChars > 0 ? request.status === 'success' ? '有合法结果' : '未通过' : '未记录'}
          {' · '}用量：{request.promptTokens ?? '未知'} / {request.completionTokens ?? '未知'}
          {'\n'}请求提供工具：{request.transport?.offeredToolCount ?? '未记录'}（不代表模型选择或实际执行）
          {' · '}工具能力来源：{request.transport?.toolCapabilitySource
            ? ({ official_profile: '官方能力资料', verified_probe: '本连接探针验证', disabled_default: '旧版默认禁用', protocol_default: '通用协议默认（未实测）' })[request.transport.toolCapabilitySource]
            : '未记录'}
        </Text>
      ))}
      <Text style={styles.detailMeta}>本地保存：{diagnostic.persistenceStatus ?? '旧记录未记录'} · 首页正文：{diagnostic.visibleTextSaved ? '已保存' : '未确认保存'}</Text>
      {diagnostic.savedParts?.length ? <Text style={styles.detailMeta}>已保存部分：{diagnostic.savedParts.join('、')}</Text> : null}
      {diagnostic.extraFields?.length ? <Text style={styles.detailMeta}>未采用的项目：{diagnostic.extraFields.join('、')}</Text> : null}
      {diagnostic.interruptionReason ? <Text style={styles.detailMeta}>本地阶段原因：{diagnostic.interruptionReason}</Text> : null}
      {technical ? (
        <View style={styles.technicalBlock}>
          <Text style={styles.technicalText}>generation key：{diagnostic.generationKey}</Text>
          <Text style={styles.technicalText}>材料指纹：{diagnostic.materialFingerprint ?? '旧记录未拆分'}</Text>
          <Text style={styles.technicalText}>finish reason：{diagnostic.finishReason ?? '未记录'}</Text>
          <Text style={styles.technicalText}>输出长度：{diagnostic.outputChars ?? '未记录'}</Text>
        </View>
      ) : null}
    </View>
  );
}

export function AssistantLifeMaterialDiagnosticsCard({
  day,
  diagnostics,
  isRefreshing,
  onRefresh,
  persistenceDiagnostic,
  snapshot,
}: Props) {
  const [diagnosticsExpanded, setDiagnosticsExpanded] = useState(false);
  const [diagnosticContext, setDiagnosticContext] = useState<DiagnosticContext>('state');
  const [materialsExpanded, setMaterialsExpanded] = useState(false);
  const [showAllDiagnostics, setShowAllDiagnostics] = useState(false);
  const [technicalExpanded, setTechnicalExpanded] = useState(false);

  const stateSummary = useMemo(
    () => summarizeAssistantLifeDiagnostics(diagnostics, 'state'),
    [diagnostics],
  );
  const activeSummary = useMemo(
    () => summarizeAssistantLifeDiagnostics(diagnostics, diagnosticContext),
    [diagnosticContext, diagnostics],
  );
  const currentGeneration = useMemo(() => {
    const journal = day?.nearStatus;
    if (!journal) return null;
    const generationKey = journal.generationKey;
    const latest = diagnostics
      .filter((diagnostic) => diagnostic.contextSource === 'state' && diagnostic.generationKey === generationKey)
      .sort((left, right) => (right.lastOccurredAt ?? right.attemptedAt) - (left.lastOccurredAt ?? left.attemptedAt))[0];
    if (journal.pending) {
      return { generationKey, label: '已解析，等待记录保存' };
    }
    if (journal.outcome === 'saved') {
      return { generationKey, label: '本次处理已保存' };
    }
    if (journal.outcome === 'interrupted') {
      return { generationKey, label: '本次处理已中断' };
    }
    if (journal.outcome === 'failed') {
      return { generationKey, label: latest?.failureReason
        ? `生成失败：${assistantLifeFailureReasonLabel(latest.failureReason)}` : '生成失败' };
    }
    return { generationKey, label: '请求已开始，尚未完成保存' };
  }, [day, diagnostics]);

  const promptItemIds = new Set(snapshot?.promptItems.map((item) => item.id) ?? []);
  const notSelectedItems = snapshot?.items.filter((item) => !promptItemIds.has(item.id)) ?? [];
  const activeRecords = activeSummary.records.slice().reverse();
  const visibleRecords = showAllDiagnostics ? activeRecords : activeRecords.slice(0, 10);
  const currentStatus = currentGeneration?.label ?? '尚未生成';

  return (
    <View style={styles.card}>
      <View style={styles.titleRow}>
        <Text style={styles.sectionTitle}>生活材料托盘</Text>
        <Pressable
          disabled={isRefreshing}
          onPress={onRefresh}
          style={({ pressed }) => [styles.refreshButton, pressed && styles.pressed]}
        >
          <Text style={styles.refreshText}>{isRefreshing ? '刷新中' : '本地刷新'}</Text>
        </Pressable>
      </View>

      <Text style={styles.statusText}>当前状态：{currentStatus}</Text>
      <Text style={styles.detailMeta}>以下仅统计保留的近期记录，不是账户当天完整账单；缺失用量不作费用估算。请求证据不足的旧记录：{stateSummary.unknownRecordCount} 条。</Text>
      <View style={styles.statsRow}>
        <View style={styles.statCell}>
          <Text style={styles.statValue}>{snapshot?.promptItems.length ?? 0}</Text>
          <Text style={styles.statLabel}>托盘预选</Text>
        </View>
        <View style={styles.statCell}>
          <Text style={styles.statValue}>{snapshot?.items.length ?? 0}</Text>
          <Text style={styles.statLabel}>候选材料</Text>
        </View>
        <View style={styles.statCell}>
          <Text style={styles.statValue}>{stateSummary.realRequestCount}</Text>
          <Text style={styles.statLabel}>真实请求</Text>
        </View>
        <View style={styles.statCell}>
          <Text style={styles.statValue}>{stateSummary.budgetSkippedCount}</Text>
          <Text style={styles.statLabel}>预算拦截</Text>
        </View>
        <View style={styles.statCell}>
          <Text style={[styles.statValue, stateSummary.duplicateRequestCount > 0 && styles.dangerText]}>
            {stateSummary.duplicateRequestCount}
          </Text>
          <Text style={styles.statLabel}>异常重复</Text>
        </View>
      </View>

      {persistenceDiagnostic ? (
        <Text style={styles.syncNotice}>
          最近一次状态保存：本地已保存，同步待恢复（{formatTime(persistenceDiagnostic.occurredAt)}）
        </Text>
      ) : null}

      <View style={styles.sectionDivider}>
        <Pressable onPress={() => setMaterialsExpanded((value) => !value)} style={styles.expandButton}>
          <Text style={styles.expandText}>{materialsExpanded ? '收起托盘内容' : '查看托盘内容'}</Text>
        </Pressable>
        {materialsExpanded ? (
          <>
            <Text style={styles.subsectionTitle}>当前托盘预览（{snapshot?.promptItems.length ?? 0}）</Text>
            {snapshot?.promptItems.length
              ? snapshot.promptItems.map((item) => <MaterialRow item={item} key={item.id} technical={technicalExpanded} />)
              : <Text style={styles.emptyText}>托盘里暂时没有可展示材料。</Text>}
            {notSelectedItems.length ? (
              <>
                <Text style={styles.subsectionTitle}>未预选材料（{notSelectedItems.length}）</Text>
                {notSelectedItems.map((item) => <MaterialRow item={item} key={item.id} technical={technicalExpanded} />)}
              </>
            ) : null}
            {snapshot?.debug.dropped.length ? (
              <>
                <Text style={styles.subsectionTitle}>收集失败（{snapshot.debug.dropped.length}）</Text>
                {snapshot.debug.dropped.map((reason) => (
                  <Text key={reason} style={styles.droppedText}>{reason}</Text>
                ))}
              </>
            ) : null}
            {technicalExpanded && snapshot ? (
              <View style={styles.technicalBlock}>
                <Text style={styles.technicalText}>托盘指纹：{snapshot.fingerprint}</Text>
                <Text style={styles.technicalText}>生成时间：{formatTime(snapshot.generatedAt)}</Text>
                <Text style={styles.technicalText}>
                  来源数量：{Object.entries(snapshot.debug.sourceCounts).map(([source, count]) => `${source} ${count}`).join(' · ') || '暂无'}
                </Text>
              </View>
            ) : null}
          </>
        ) : null}
      </View>

      <View style={styles.sectionDivider}>
        <Pressable onPress={() => setDiagnosticsExpanded((value) => !value)} style={styles.expandButton}>
          <Text style={styles.expandText}>{diagnosticsExpanded ? '收起生成记录' : '查看生成记录'}</Text>
        </Pressable>
        {diagnosticsExpanded ? (
          <>
            <View style={styles.segmentedControl}>
              {(['state', 'afterglow'] as const).map((context) => {
                const selected = diagnosticContext === context;
                return (
                  <Pressable
                    key={context}
                    onPress={() => {
                      setDiagnosticContext(context);
                      setShowAllDiagnostics(false);
                    }}
                    style={[styles.segmentButton, selected && styles.segmentButtonSelected]}
                  >
                    <Text style={[styles.segmentText, selected && styles.segmentTextSelected]}>
                      {context === 'state' ? '首页状态' : '对话余韵'}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            <Text style={styles.recentLabel}>最近记录：真实请求 {activeSummary.realRequestCount} · 预算拦截 {activeSummary.budgetSkippedCount} · 合法重试 {activeSummary.allowedRetryCount} · 异常重复 {activeSummary.duplicateRequestCount}</Text>
            <Text style={styles.recentLabel}>已记录用量合计：Prompt tokens {activeSummary.promptTokens} · 输出 tokens {activeSummary.completionTokens}；未知部分不计入。</Text>
            {visibleRecords.length
              ? visibleRecords.map((record, index) => (
                <DiagnosticRow
                  key={`${record.diagnostic.contextSource}:${record.diagnostic.generationKey}:${record.diagnostic.attemptedAt}:${index}`}
                  record={record}
                  technical={technicalExpanded}
                />
              ))
              : <Text style={styles.emptyText}>最近还没有这类生成记录。</Text>}
            {activeRecords.length > 10 ? (
              <Pressable onPress={() => setShowAllDiagnostics((value) => !value)} style={styles.moreButton}>
                <Text style={styles.moreText}>{showAllDiagnostics ? '只看最近 10 条' : `显示全部 ${activeRecords.length} 条`}</Text>
              </Pressable>
            ) : null}
          </>
        ) : null}
      </View>

      {(materialsExpanded || diagnosticsExpanded) ? (
        <Pressable onPress={() => setTechnicalExpanded((value) => !value)} style={styles.technicalToggle}>
          <Text style={styles.technicalToggleText}>{technicalExpanded ? '收起技术字段' : '显示技术字段'}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: 'rgba(255, 255, 255, 0.78)',
    borderColor: '#E0D4F4',
    borderRadius: 24,
    borderWidth: 1,
    marginTop: 14,
    padding: 18,
  },
  dangerText: { color: '#B44E48' },
  detailBody: { color: colors.ink, fontSize: 12, lineHeight: 18, marginTop: 3 },
  detailMeta: { color: colors.muted, fontSize: 10, lineHeight: 15, marginTop: 2 },
  detailRow: {
    borderTopColor: 'rgba(56,64,82,0.08)',
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingVertical: 9,
  },
  detailTitle: { color: '#6F55A8', fontSize: 11, fontWeight: '700', lineHeight: 16 },
  droppedText: { color: '#B76658', fontSize: 11, lineHeight: 16, marginTop: 4 },
  emptyText: { color: colors.muted, fontSize: 12, lineHeight: 18, marginTop: 8 },
  expandButton: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', minHeight: 36 },
  expandText: { color: '#6F55A8', fontSize: 12, fontWeight: '700' },
  moreButton: { alignSelf: 'flex-start', paddingVertical: 8 },
  moreText: { color: '#6F55A8', fontSize: 11, fontWeight: '600' },
  pressed: { opacity: 0.65 },
  recentLabel: { color: colors.muted, fontSize: 10, lineHeight: 15, marginTop: 5 },
  refreshButton: { backgroundColor: 'rgba(138, 109, 210, 0.12)', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  refreshText: { color: '#6F55A8', fontSize: 12, fontWeight: '600' },
  sectionDivider: { borderTopColor: 'rgba(56,64,82,0.08)', borderTopWidth: StyleSheet.hairlineWidth, marginTop: 12, paddingTop: 6 },
  sectionTitle: { color: colors.ink, fontSize: 17, fontWeight: '700' },
  segmentedControl: { borderColor: '#D8CDEF', borderRadius: 8, borderWidth: 1, flexDirection: 'row', marginTop: 8, overflow: 'hidden' },
  segmentButton: { alignItems: 'center', flex: 1, minHeight: 34, justifyContent: 'center' },
  segmentButtonSelected: { backgroundColor: 'rgba(138, 109, 210, 0.13)' },
  segmentText: { color: colors.muted, fontSize: 11, fontWeight: '600' },
  segmentTextSelected: { color: '#6F55A8' },
  statCell: { alignItems: 'center', flex: 1, minWidth: 48 },
  statLabel: { color: colors.muted, fontSize: 9, marginTop: 2, textAlign: 'center' },
  statsRow: { flexDirection: 'row', gap: 4, justifyContent: 'space-between', marginTop: 12 },
  statValue: { color: colors.ink, fontSize: 16, fontWeight: '700' },
  statusText: { color: '#5E4A82', fontSize: 12, fontWeight: '600', lineHeight: 18, marginTop: 8 },
  subsectionTitle: { color: colors.ink, fontSize: 12, fontWeight: '700', marginTop: 10 },
  syncNotice: { color: '#9A6A31', fontSize: 10, lineHeight: 15, marginTop: 10 },
  technicalBlock: { backgroundColor: 'rgba(68, 58, 86, 0.05)', borderRadius: 6, marginTop: 6, padding: 7 },
  technicalText: { color: '#6C6577', fontSize: 9, lineHeight: 14 },
  technicalToggle: { alignSelf: 'flex-start', marginTop: 10, paddingVertical: 4 },
  technicalToggleText: { color: '#76658F', fontSize: 10, fontWeight: '600' },
  titleRow: { alignItems: 'center', flexDirection: 'row', gap: 10, justifyContent: 'space-between' },
});
