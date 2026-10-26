import { useCallback, useEffect, useMemo, useState } from 'react';
import { BackHandler, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { useAiConfigPreferences } from '../ai/AiConfigPreferences';
import { buildCompiledSystemPromptResult } from '../ai/builtInSystemPrompt';
import {
  armProactiveRequestCapture,
  clearProactiveRequestCapture,
  encodeProactiveCaptureExport,
  getLatestPromptRuntimeSnapshot,
  getProactiveRequestCapture,
  subscribeProactiveRequestCapture,
  subscribePromptRuntimeSnapshot,
  type CompiledPromptSection,
  type PromptRuntimeSnapshot,
  type PromptSectionPlacement,
} from '../ai/promptDiagnostics';
import {
  fingerprintPromptText,
  formatPromptCacheHitRate,
  loadPromptCacheMetricsSummary,
  type PromptCacheMetricsSummary,
  type ScheduleRequestDiagnostic,
} from '../ai/promptCacheMetrics';
import {
  PROMPT_CONTEXT_PROFILES,
  type PromptContextProfile,
} from '../ai/promptContextProfile';
import { AppText as Text } from '../components/AppText';
import {
  formatPromptCacheChannel,
  formatPromptCacheGroupMeta,
  formatPromptCacheSourceName,
  formatPromptCacheTokens,
} from '../chat/ChatTokenUsageRing';
import {
  loadJunluoInnerStateTechnicalDiagnostic,
  type JunluoInnerStateTechnicalDiagnostic,
} from '../life/junluoInnerStateMaintenance';
import { colors } from '../theme/colors';
import type { Navigate } from '../types/navigation';
import { readUnifiedContactState, type StoredUnifiedContactState } from '../proactive/unifiedContactStore';

type Props = {
  navigate: Navigate;
};

const PROFILE_IDS = Object.keys(PROMPT_CONTEXT_PROFILES) as PromptContextProfile[];

function placementLabel(placement: PromptSectionPlacement) {
  if (placement === 'stable') return '稳定';
  if (placement === 'task') return '任务';
  return '动态';
}

const SCHEDULE_REQUEST_OUTCOMES: Record<ScheduleRequestDiagnostic['outcome'], string> = {
  ready: '正文已生成', quiet: '模型返回空 messages', 'empty-content': '空正文',
  'invalid-json': 'JSON 解析失败', 'invalid-schema': '输出结构不合要求',
  'http-error': 'HTTP 失败', 'network-error': '网络请求失败', aborted: '请求已取消',
};

function scheduleRequestTime(value?: number) {
  return value === undefined ? '未知' : new Date(value).toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
}

const PERSONA_DETAIL_LABELS = {
  companion: '轻量陪伴',
  full: '完整关系',
  identity: '后台身份',
} as const;

function describeProfilePolicy(profileId: PromptContextProfile) {
  const config = PROMPT_CONTEXT_PROFILES[profileId];
  const policy = config.sectionPolicy;
  const optionalSections = [
    ['关系场域', policy.includeRelationshipContext],
    ['小仓鼠资料', policy.includeUserProfile],
    ['长期人格状态', policy.includePersonaState],
    ['自主性说明', policy.includeAutonomyLayer],
    ['表情素材', policy.includeExpression],
    ['记忆参考', config.allowMemory],
    ['欲望快照', config.allowDesire],
  ] as const;
  return {
    included: optionalSections.filter(([, included]) => included).map(([label]) => label),
    omitted: optionalSections.filter(([, included]) => !included).map(([label]) => label),
    personaDetail: PERSONA_DETAIL_LABELS[policy.personaDetail],
  };
}
function formatTime(value: number) {
  return new Date(value).toLocaleString('zh-CN', {
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    month: '2-digit',
  });
}

function SectionRows({
  expanded,
  idPrefix,
  onToggle,
  sections,
}: {
  expanded: Set<string>;
  idPrefix: string;
  onToggle: (id: string) => void;
  sections: CompiledPromptSection[];
}) {
  if (!sections.length) {
    return <Text style={styles.emptyText}>当前没有可展示的区块。</Text>;
  }
  return (
    <View style={styles.sectionList}>
      {sections.map((section, index) => {
        const rowId = `${idPrefix}:${section.id}`;
        const isExpanded = expanded.has(rowId);
        return (
          <View key={`${rowId}:${index}`} style={styles.sectionRow}>
            <Pressable
              accessibilityLabel={`${isExpanded ? '收起' : '展开'} ${section.label}`}
              onPress={() => onToggle(rowId)}
              style={styles.sectionRowHeader}
            >
              <View style={styles.sectionCopy}>
                <Text style={styles.sectionLabel}>{section.label}</Text>
                <Text numberOfLines={1} style={styles.sectionSource}>{section.source}</Text>
              </View>
              <View style={styles.sectionMeta}>
                <Text
                  style={[
                    styles.placementTag,
                    section.placement === 'stable'
                      ? styles.stableTag
                      : section.placement === 'task'
                        ? styles.taskTag
                        : styles.dynamicTag,
                  ]}
                >
                  {placementLabel(section.placement)}
                </Text>
                <Text style={styles.tokenValue}>{section.estimatedTokens.toLocaleString()}</Text>
                <Text style={styles.expandMark}>{isExpanded ? '−' : '+'}</Text>
              </View>
            </Pressable>
            {isExpanded ? (
              <Text selectable style={styles.promptText}>{section.text}</Text>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

export function PromptDiagnosticsScreen({ navigate }: Props) {
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      navigate('ai-diagnostics');
      return true;
    });
    return () => subscription.remove();
  }, [navigate]);
  const { loaded, profile } = useAiConfigPreferences();
  const [selectedProfile, setSelectedProfile] = useState<PromptContextProfile>('chat-full');
  const [summary, setSummary] = useState<PromptCacheMetricsSummary | null>(null);
  const [innerStateDiagnostic, setInnerStateDiagnostic] = useState<JunluoInnerStateTechnicalDiagnostic | null>(null);
  const [runtimeSnapshot, setRuntimeSnapshot] = useState<PromptRuntimeSnapshot | null>(
    getLatestPromptRuntimeSnapshot(),
  );
  const [previewSections, setPreviewSections] = useState<CompiledPromptSection[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [contact, setContact] = useState<StoredUnifiedContactState | null>(null);
  const [proactiveCapture, setProactiveCapture] = useState(getProactiveRequestCapture);
  useEffect(() => subscribeProactiveRequestCapture(setProactiveCapture), []);

  const refreshSummary = useCallback(() => {
    setLoading(true);
    return Promise.all([
      readUnifiedContactState().then(setContact).catch(() => setContact(null)),
      loadPromptCacheMetricsSummary({ sinceMs: Date.now() - 24 * 60 * 60 * 1000 })
        .then(setSummary)
        .catch(() => setSummary(null)),
      loadJunluoInnerStateTechnicalDiagnostic()
        .then(setInnerStateDiagnostic)
        .catch(() => setInnerStateDiagnostic(null)),
    ])
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    void refreshSummary();
    return subscribePromptRuntimeSnapshot(setRuntimeSnapshot);
  }, [refreshSummary]);

  useEffect(() => {
    if (!loaded) return undefined;
    let cancelled = false;
    void buildCompiledSystemPromptResult({
      contextProfile: selectedProfile,
      profile,
    })
      .then((result) => {
        if (!cancelled) setPreviewSections(result.sectionManifest);
      })
      .catch(() => {
        if (!cancelled) setPreviewSections([]);
      });
    return () => {
      cancelled = true;
    };
  }, [loaded, profile, refreshVersion, selectedProfile]);

  const toggleExpanded = useCallback((id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const previewPolicy = useMemo(() => describeProfilePolicy(selectedProfile), [selectedProfile]);
  const previewTokens = useMemo(
    () => previewSections.reduce((total, section) => total + section.estimatedTokens, 0),
    [previewSections],
  );

  const handleRefresh = useCallback(() => {
    setRefreshVersion((current) => current + 1);
    void refreshSummary();
  }, [refreshSummary]);

  return (
    <View style={styles.page}>
      <View style={styles.header}>
        <Pressable accessibilityLabel="返回答卷诊断与维护" onPress={() => navigate('ai-diagnostics')} style={styles.iconButton}>
          <Text style={styles.iconText}>‹</Text>
        </Pressable>
        <Text style={styles.title}>Prompt 与缓存</Text>
        <Pressable accessibilityLabel="刷新诊断" onPress={handleRefresh} style={styles.iconButton}>
          <Text style={styles.refreshText}>↻</Text>
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Text style={styles.sectionHeading}>统一主动联系</Text>
        <View style={styles.innerDiagnosticCard}>
          <Text style={styles.sectionLabel}>已消耗机会：{contact ? `${contact.day} · ${contact.used} / 12` : '未读取'}</Text>
          <Text style={styles.emptyText}>近期明确进入网络的请求：{contact ? new Set(contact.diagnostics?.filter(item => item.transportState === 'started' && item.requestToken).map(item => item.requestToken)).size : '未知'}</Text>
          <Text style={styles.emptyText}>近期记录不是账户全天账单；旧记录或中断时未确认发出的请求不猜算。</Text>
          {contact?.current ? <>
            <Text style={styles.sectionLabel}>本阵阶段：{contact.current.status} · 已保存气泡 {contact.current.savedMessageIds.length}</Text>
            <Text style={styles.emptyText}>请求登记 {contact.current.requests} · 当前网络状态：{contact.current.transportState ?? '旧记录未记录'}</Text>
            {contact.current.retryAt ? <Text style={styles.emptyText}>补试不早于：{formatTime(contact.current.retryAt)}</Text> : null}
            <Text style={styles.emptyText}>截止：{formatTime(contact.current.expiresAt)} · 原因：{contact.current.reason ?? '无'}</Text>
          </> : null}
          {(contact?.diagnostics ?? []).slice(-8).reverse().map((item, index) => <Text key={`${item.id}:${item.at}:${index}`} style={styles.emptyText}>
            {formatTime(item.at)} · {item.stage} · 请求登记 {item.requests} · 已存气泡 {item.savedMessageIds.length} · {item.reason ?? '无技术原因'}
          </Text>)}
        </View>
        <Text style={styles.sectionHeading}>临时取证：下一次千问请求</Text>
        <View style={styles.innerDiagnosticCard}>
          <Text style={styles.hintText}>手动准备后，只记录下一次硅基千问主动请求、已接入的本地千问请求，或官方千问27B普通聊天的工具续答请求。本入口不发起请求、不改变后台开关。</Text>
          <Text style={styles.privacyText}>包含本次发送的聊天、System、工具与参数，以及接口返回的 JSON；不含鉴权请求头。仅留在当前内存，取消／清除或重启即移除，不写入文件或聊天。</Text>
          <View style={styles.profileGrid}>
            <Pressable accessibilityLabel="准备单次千问取证" disabled={proactiveCapture.armed}
              style={styles.profileButton} onPress={armProactiveRequestCapture}>
              <Text style={styles.profileText}>{proactiveCapture.armed ? '等待下一次请求' : '准备单次取证'}</Text>
            </Pressable>
            <Pressable accessibilityLabel="取消并清除千问取证" style={styles.profileButton} onPress={clearProactiveRequestCapture}>
              <Text style={styles.profileText}>取消并清除</Text>
            </Pressable>
          </View>
          {proactiveCapture.capture ? <>
            <Text style={styles.hintText}>{formatTime(proactiveCapture.capture.startedAt)} · {proactiveCapture.capture.layout} · {proactiveCapture.capture.requestKind}</Text>
            <Text style={styles.hintText}>状态：{proactiveCapture.capture.outcome ?? '等待接口结果'} · HTTP {proactiveCapture.capture.httpStatus ?? '未知'}</Text>
            {proactiveCapture.capture.traceId ? <Text selectable style={styles.hintText}>Trace：{proactiveCapture.capture.traceId}</Text> : null}
            {proactiveCapture.capture.bodyParseFailure ? <Text style={styles.hintText}>响应读取：{proactiveCapture.capture.bodyParseFailure}；无法解析时不把本地替代值当作接口正文。</Text> : null}
            {([
              ['capture-request', '实际发送的请求体', proactiveCapture.capture.requestBody],
              ['capture-response', '接口 JSON（解析后、业务处理前）', proactiveCapture.capture.responseJson],
            ] as const).map(([id, label, content]) => content === undefined ? null : <View key={id}>
              <Pressable accessibilityLabel={label} onPress={() => toggleExpanded(id)} style={styles.sectionRowHeader}>
                <Text style={styles.sectionLabel}>{label}</Text>
                <Text style={styles.expandMark}>{expanded.has(id) ? '−' : '＋'}</Text>
              </Pressable>
              {expanded.has(id) ? <>
                <Text style={styles.hintText}>技术导出：先解析 XML，再解析一次 JSON 字符串，即为原文。原文 UTF-16 长度 {content.length} · FNV-1a {fingerprintPromptText(content)}（意外改字校验，非加密）。</Text>
                <Text selectable style={styles.promptText}>{encodeProactiveCaptureExport(content)}</Text>
              </> : null}
            </View>)}
          </> : <Text style={styles.hintText}>{proactiveCapture.armed ? '已准备，等待符合条件的原有流程实际发送。' : '未准备，没有捕获内容。'}</Text>}
        </View>
        <Text style={styles.sectionHeading}>内在状态技术诊断</Text>
        {innerStateDiagnostic ? (
          <View style={styles.innerDiagnosticCard}>
            {([
              ['情绪与关系', innerStateDiagnostic.affect],
              ['十维愿望', innerStateDiagnostic.desire],
              ['念头', innerStateDiagnostic.thought],
            ] as const).map(([label, item]) => (
              <View key={label} style={styles.innerDiagnosticRow}>
                <Text style={styles.innerDiagnosticLabel}>{label}</Text>
                <Text style={item.legal ? styles.innerDiagnosticGood : styles.innerDiagnosticBad}>
                  {item.exists ? `V${item.schemaVersion ?? '?'} · ${item.legal ? '合同合法' : '合同损坏'}` : '尚未写入 · 使用默认状态'}
                </Text>
              </View>
            ))}
            <Text style={styles.innerDiagnosticText}>
              数值限幅：关系感受 {innerStateDiagnostic.relationshipFeelingValueInBounds ? '合法' : '越界'} · 关系选择 {innerStateDiagnostic.relationshipChoiceValueInBounds ? '合法' : '越界'} · 堵住 {innerStateDiagnostic.strainValueInBounds ? '合法' : '越界'}
            </Text>
            <Text style={styles.innerDiagnosticText}>
              今日关系选择额度：靠近 {Math.round(innerStateDiagnostic.relationshipChoiceDailyLimit.positiveUsed * 100)}/12 · 疏远 {Math.round(innerStateDiagnostic.relationshipChoiceDailyLimit.negativeUsed * 100)}/8
            </Text>
            <Text style={styles.innerDiagnosticText}>
              同步：{innerStateDiagnostic.syncEnabled ? '已接入当前设备的 assistant.life-state 同步' : '当前没有同步设备，本机存储有效'}
            </Text>
            <Text selectable style={styles.innerDiagnosticMono}>
              最近状态操作：{innerStateDiagnostic.latestAffectOperationIds.join(' · ') || '无'}
            </Text>
            <Text selectable style={styles.innerDiagnosticMono}>
              最近愿望变化操作：{innerStateDiagnostic.latestDesireChangeIds.map((entry) => `${entry.desireId}=${entry.operationId}`).join(' · ') || '无'}
            </Text>
            <Text style={styles.innerDiagnosticText}>
              念头数量：{Object.entries(innerStateDiagnostic.thoughtStateCounts).map(([key, value]) => `${key} ${value}`).join(' · ') || '0'}
            </Text>
            <Text style={styles.privacyText}>这里只读取结构化状态与操作号；不保存 Prompt、仓鼠消息、聊天历史、reasoning 或密钥。</Text>
          </View>
        ) : (
          <Text style={styles.emptyText}>内在状态诊断读取失败；运行数据没有因此改变。</Text>
        )}

        <Text style={styles.sectionHeading}>最近 24 小时</Text>
        <View style={styles.metricBand}>
          <View style={styles.metricItem}>
            <Text style={styles.metricValue}>{summary?.requestCount.toLocaleString() ?? '未知'}</Text>
            <Text style={styles.metricLabel}>已记录请求</Text>
          </View>
          <View style={styles.metricItem}>
            <Text style={styles.metricValue}>{formatPromptCacheTokens(summary?.promptTokens, summary?.knownPromptRequestCount)}</Text>
            <Text style={styles.metricLabel}>已知输入 tokens</Text>
          </View>
          <View style={styles.metricItem}>
            <Text style={styles.metricValue}>{formatPromptCacheTokens(summary?.completionTokens, summary?.knownOutputRequestCount)}</Text>
            <Text style={styles.metricLabel}>已知输出 tokens</Text>
          </View>
          <View style={styles.metricItem}>
            <Text style={styles.metricValue}>{formatPromptCacheHitRate(summary?.averageHitRate)}</Text>
            <Text style={styles.metricLabel}>已知缓存命中</Text>
          </View>
        </View>
        <Text style={styles.hintText}>
          {loading
            ? '正在读取本地台账…'
            : summary
              ? `输入资料 ${summary.knownPromptRequestCount}/${summary.requestCount} · 输出资料 ${summary.knownOutputRequestCount}/${summary.requestCount} · 缓存明细 ${summary.knownCacheRequestCount}/${summary.requestCount}\n已知命中 ${formatPromptCacheTokens(summary.hitTokens, summary.knownCacheRequestCount)} · 未命中 ${formatPromptCacheTokens(summary.missTokens, summary.knownCacheRequestCount)} · 前缀资料 ${summary.knownPrefixRequestCount}/${summary.requestCount} · 前缀变化 ${summary.knownPrefixRequestCount ? summary.stablePrefixChangedCount + ' 次' : '未知'}`
              : '本地台账未读取；输入、输出和缓存资料未知。'}
        </Text>
        <Text style={styles.privacyText}>总览合计各渠道和模型的已知样本，只累加接口返回的已知 token；资料缺失不计为 0。旧记录的渠道、输出及新口径前缀资料不补猜；台账最多保留 300 条、7 天，统计不等于账户完整账单。</Text>
        {summary?.groups.map((group) => (
          <View key={JSON.stringify([group.channel, group.model, group.contextSource, group.contextProfile])} style={styles.costRow}>
            <View style={styles.costCopy}>
              <Text style={styles.costSource}>{formatPromptCacheSourceName(group.contextSource)}</Text>
              <Text style={styles.costMeta}>
                {formatPromptCacheChannel(group.channel)} · {group.model || '模型未知'}
              </Text>
              <Text style={styles.costMeta}>{group.contextSource} · {group.contextProfile}</Text>
              <Text style={styles.costMeta}>{formatPromptCacheGroupMeta(group)}</Text>
            </View>
            <Text style={styles.costTokens}>{formatPromptCacheTokens(group.missTokens, group.knownCacheRequestCount)} 未命中</Text>
          </View>
        ))}

        <Text style={styles.sectionHeading}>最近日程请求技术诊断</Text>
        <Text style={styles.privacyText}>近 24 小时最多显示 5 条已进入请求阶段并收尾的记录；在此之前停止的流程不入账。材料准备从生成器入口计时。生成结果不代表已送达，取消原因未区分截止与其他取消。首响应字符可能只是空白，不代表正文开始，也不区分排队和生成。</Text>
        {summary?.recentScheduleRequests?.length ? summary.recentScheduleRequests.map(record => {
          const diagnostic = record.scheduleRequest;
          return (
            <View key={record.id} style={styles.snapshotMeta}>
              <Text style={styles.snapshotTitle}>{scheduleRequestTime(record.requestStartedAt)} · {record.model || '模型未知'}</Text>
              {diagnostic ? (
                <>
                  <Text selectable style={styles.hintText}>事项 ID：{diagnostic.occurrenceId ?? '未知'} · {diagnostic.kind} · 提醒时刻 {scheduleRequestTime(diagnostic.referenceTime)}</Text>
                  <Text style={styles.hintText}>结果：{SCHEDULE_REQUEST_OUTCOMES[diagnostic.outcome]} · HTTP {diagnostic.httpStatus ?? '未知'}</Text>
                  <Text style={styles.hintText}>传输：{diagnostic.transport === 'xhr' ? '原生进度观测' : diagnostic.transport === 'fetch' ? 'fetch（无分段观测）' : '旧记录未记'} · 已观测响应 {diagnostic.responseChars === undefined ? '未知' : diagnostic.responseChars + ' 字符'}</Text>
                  <Text style={styles.hintText}>响应头 {scheduleRequestTime(diagnostic.headersReceivedAt)} → 首响应字符 {scheduleRequestTime(diagnostic.firstContentAt)} → 收完 {scheduleRequestTime(diagnostic.responseCompletedAt)}</Text>
                  <Text style={styles.hintText}>材料准备 {scheduleRequestTime(diagnostic.preparationStartedAt)} → 发请求 {scheduleRequestTime(record.requestStartedAt)} → 收到响应 {scheduleRequestTime(diagnostic.responseReceivedAt)} → 收尾 {scheduleRequestTime(diagnostic.finishedAt)}</Text>
                  <Text style={styles.hintText}>请求前准备 {record.requestStartedAt === undefined ? '未知' : Math.max(0, record.requestStartedAt - diagnostic.preparationStartedAt) + ' ms'} · 等待响应 {diagnostic.responseReceivedAt === undefined || record.requestStartedAt === undefined ? '未知' : Math.max(0, diagnostic.responseReceivedAt - record.requestStartedAt) + ' ms'} · 请求至收尾 {record.requestStartedAt === undefined ? '未知' : Math.max(0, diagnostic.finishedAt - record.requestStartedAt) + ' ms'}</Text>
                </>
              ) : <Text style={styles.hintText}>旧记录未保存请求结果与阶段时间。</Text>}
            </View>
          );
        }) : <Text style={styles.emptyText}>{loading ? '正在读取日程请求…' : summary ? '近 24 小时暂无日程请求记录。' : '台账未读取，日程请求诊断未知。'}</Text>}

        <Text style={styles.sectionHeading}>最近一次可查看 Prompt 的请求</Text>
        {runtimeSnapshot ? (
          <>
            <View style={styles.snapshotMeta}>
              <Text style={styles.snapshotTitle}>{formatPromptCacheSourceName(runtimeSnapshot.contextSource)}</Text>
              <Text style={styles.hintText}>
                {runtimeSnapshot.contextSource} · {runtimeSnapshot.contextProfile} · {runtimeSnapshot.model ?? '未知模型'} · {formatTime(runtimeSnapshot.createdAt)}
              </Text>
              <Text style={styles.hintText}>
                System 约 {runtimeSnapshot.systemTokens.toLocaleString()} tokens · 其余 {runtimeSnapshot.nonSystemMessageCount} 条约 {runtimeSnapshot.nonSystemTokens.toLocaleString()} tokens
              </Text>
            </View>
            <SectionRows
              expanded={expanded}
              idPrefix="runtime"
              onToggle={toggleExpanded}
              sections={runtimeSnapshot.sections}
            />
            <Text style={styles.privacyText}>完整 System 正文只留在当前内存；聊天原文不复制到诊断快照。</Text>
          </>
        ) : (
          <Text style={styles.emptyText}>本次启动后还没有完成过可记录的模型请求。</Text>
        )}

        <Text style={styles.sectionHeading}>当前档位编译预览</Text>
        <View style={styles.profileGrid}>
          {PROFILE_IDS.map((id) => (
            <Pressable
              key={id}
              onPress={() => setSelectedProfile(id)}
              style={[styles.profileButton, selectedProfile === id && styles.profileButtonSelected]}
            >
              <Text style={selectedProfile === id ? styles.profileTextSelected : styles.profileText}>{id}</Text>
            </Pressable>
          ))}
        </View>
        <Text style={styles.hintText}>{PROMPT_CONTEXT_PROFILES[selectedProfile].description}</Text>
        <View style={styles.policyBand}>
          <Text style={styles.policyTitle}>人格档：{previewPolicy.personaDetail} · 输出 {PROMPT_CONTEXT_PROFILES[selectedProfile].outputShape}</Text>
          <Text style={styles.policyText}>保留：{previewPolicy.included.join('、') || '仅核心身份与模块任务'}</Text>
          <Text style={styles.policyText}>省略：{previewPolicy.omitted.join('、') || '无'}</Text>
        </View>
        <Text style={styles.previewTotal}>共享编译内容约 {previewTokens.toLocaleString()} tokens</Text>
        <Text style={styles.privacyText}>这是本地编译预览，不调用 API；具体模块任务和聊天历史只会出现在真实请求区。</Text>
        <SectionRows
          expanded={expanded}
          idPrefix="preview"
          onToggle={toggleExpanded}
          sections={previewSections}
        />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { backgroundColor: '#FFF9F4', flex: 1, paddingHorizontal: 18, paddingTop: 10 },
  header: { alignItems: 'center', flexDirection: 'row', height: 52, justifyContent: 'space-between' },
  iconButton: { alignItems: 'center', backgroundColor: '#FFFFFF', borderColor: '#E9E2DE', borderRadius: 6, borderWidth: 1, height: 38, justifyContent: 'center', width: 38 },
  iconText: { color: colors.ink, fontSize: 30, lineHeight: 32 },
  refreshText: { color: colors.ink, fontSize: 22, lineHeight: 24 },
  title: { color: colors.ink, fontSize: 20, fontWeight: '800' },
  content: { paddingBottom: 42 },
  sectionHeading: { color: colors.ink, fontSize: 17, fontWeight: '800', marginBottom: 10, marginTop: 22 },
  metricBand: { borderBottomColor: '#E9E2DE', borderBottomWidth: 1, borderTopColor: '#E9E2DE', borderTopWidth: 1, flexDirection: 'row', paddingVertical: 14 },
  metricItem: { alignItems: 'center', flex: 1 },
  metricValue: { color: '#6E5BA7', fontSize: 19, fontWeight: '800' },
  metricLabel: { color: colors.muted, fontSize: 11, marginTop: 4 },
  hintText: { color: colors.muted, fontSize: 12, lineHeight: 18, marginTop: 8 },
  costRow: { alignItems: 'center', borderBottomColor: '#EEE8E4', borderBottomWidth: 1, flexDirection: 'row', gap: 10, minHeight: 58, paddingVertical: 9 },
  costCopy: { flex: 1 },
  costSource: { color: colors.ink, fontSize: 13, fontWeight: '700' },
  costMeta: { color: colors.muted, fontSize: 11, marginTop: 4 },
  costTokens: { color: '#B65E52', fontSize: 12, fontWeight: '700' },
  snapshotMeta: { borderLeftColor: '#8A80C7', borderLeftWidth: 3, marginBottom: 8, paddingLeft: 10 },
  snapshotTitle: { color: colors.ink, fontSize: 14, fontWeight: '800' },
  sectionList: { borderTopColor: '#E9E2DE', borderTopWidth: 1 },
  sectionRow: { borderBottomColor: '#E9E2DE', borderBottomWidth: 1 },
  sectionRowHeader: { alignItems: 'center', flexDirection: 'row', minHeight: 58, paddingVertical: 9 },
  sectionCopy: { flex: 1, paddingRight: 8 },
  sectionLabel: { color: colors.ink, fontSize: 13, fontWeight: '700' },
  sectionSource: { color: colors.muted, fontSize: 10, marginTop: 4 },
  sectionMeta: { alignItems: 'center', flexDirection: 'row', gap: 7 },
  placementTag: { borderRadius: 4, fontSize: 10, fontWeight: '700', overflow: 'hidden', paddingHorizontal: 6, paddingVertical: 3 },
  stableTag: { backgroundColor: '#E5F3EA', color: '#4D795D' },
  taskTag: { backgroundColor: '#FFF0D9', color: '#97652F' },
  dynamicTag: { backgroundColor: '#E8EFFA', color: '#526F99' },
  tokenValue: { color: colors.muted, fontSize: 11, minWidth: 32, textAlign: 'right' },
  expandMark: { color: '#8078A7', fontSize: 18, width: 14 },
  promptText: { backgroundColor: '#F7F5F3', color: '#4A4650', fontFamily: 'monospace', fontSize: 11, lineHeight: 17, padding: 11 },
  privacyText: { color: '#8B6E67', fontSize: 11, lineHeight: 17, marginBottom: 8, marginTop: 8 },
  emptyText: { color: colors.muted, fontSize: 12, lineHeight: 19, paddingVertical: 12 },
  profileGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  profileButton: { backgroundColor: '#FFFFFF', borderColor: '#DED8E8', borderRadius: 6, borderWidth: 1, minHeight: 32, paddingHorizontal: 9, paddingVertical: 7 },
  profileButtonSelected: { backgroundColor: '#756BAE', borderColor: '#756BAE' },
  profileText: { color: '#6D6780', fontSize: 10, fontWeight: '700' },
  profileTextSelected: { color: '#FFFFFF', fontSize: 10, fontWeight: '800' },
  previewTotal: { color: '#6E5BA7', fontSize: 14, fontWeight: '800', marginTop: 12 },
  policyBand: { borderLeftColor: '#79A88B', borderLeftWidth: 3, marginTop: 10, paddingLeft: 10, paddingVertical: 3 },
  policyTitle: { color: colors.ink, fontSize: 12, fontWeight: '800', lineHeight: 18 },
  policyText: { color: colors.muted, fontSize: 11, lineHeight: 17 },
  innerDiagnosticCard: { backgroundColor: '#FFFFFF', borderColor: '#E7DFEE', borderRadius: 10, borderWidth: 1, padding: 12 },
  innerDiagnosticRow: { alignItems: 'center', borderBottomColor: '#EEE8F2', borderBottomWidth: 1, flexDirection: 'row', justifyContent: 'space-between', minHeight: 38 },
  innerDiagnosticLabel: { color: colors.ink, fontSize: 12, fontWeight: '800' },
  innerDiagnosticGood: { color: '#4D795D', fontSize: 11, fontWeight: '800' },
  innerDiagnosticBad: { color: '#B65E52', fontSize: 11, fontWeight: '800' },
  innerDiagnosticText: { color: colors.muted, fontSize: 11, lineHeight: 17, marginTop: 8 },
  innerDiagnosticMono: { backgroundColor: '#F7F5F8', color: '#5F586A', fontFamily: 'monospace', fontSize: 10, lineHeight: 16, marginTop: 8, padding: 8 },
});
