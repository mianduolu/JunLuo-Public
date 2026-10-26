import { memo, useMemo } from 'react';
import { Modal, Pressable, ScrollView, View } from 'react-native';
import type { EdgeInsets } from 'react-native-safe-area-context';

import { AppText as Text } from '../components/AppText';
import {
  buildMemoryDebugExplanation,
  buildMemoryRecallItemExplanation,
} from '../memory/memoryDebugExplanation';
import type { MemoryBundleDebug } from '../memory/memoryOrchestrator';
import type { MemoryRecallItem, MemoryRecallReason } from '../memory/memoryStore';
import { styles } from '../screens/ChatScreen.styles';

export type ChatMemoryRecallModalProps = {
  flaggedRecallIds: Set<string>;
  insets: EdgeInsets;
  latestMemoryDebug: MemoryBundleDebug | null;
  latestMemoryRecall: MemoryRecallItem[] | null;
  onClose: () => void;
  onFlagIrrelevant: (item: MemoryRecallItem) => void;
  onToggleTechnical: () => void;
  panelHeight: number;
  technicalOpen: boolean;
  visible: boolean;
};

function describeMemoryRecallReason(reason: MemoryRecallReason) {
  if (reason === 'pinned') return '钉住记忆';
  if (reason === 'anchor') return '长期坐标';
  if (reason === 'direct') return '直接相关';
  if (reason === 'context') return '场景联想';
  if (reason === 'semantic') return '语义想起';
  if (reason === 'related') return '关联记忆';
  if (reason === 'recent') return '最近记忆';
  if (reason === 'random') return '忽然想起';
  if (reason === 'quiet_context') return '背景记忆';
  if (reason === 'suggested_mention') return '主动递出';
  return '文字匹配';
}

function describeMemoryRecallSources(sources?: Array<'vector' | 'fts' | 'cjk' | 'bridge' | 'pinned' | 'related' | 'reranker'>) {
  if (!sources?.length) return '';
  const labels = {
    vector: '语义',
    fts: '全文',
    cjk: '中文词',
    bridge: '桥词',
    pinned: '固定',
    related: '关系',
    reranker: 'LLM重排',
  };
  return sources.map((source) => labels[source]).join('+');
}

function describeMemoryRecallDebugReason(reason: string) {
  const labels: Record<string, string> = {
    keyword_match: '关键词',
    vector_match: '向量相似',
    related_edge: '关系边',
    unresolved_high_arousal: '未解决高情绪',
    stale_but_important: '久未想起但重要',
    pinned: '钉住',
    quiet_context: '背景记忆',
    suggested_mention: '主动递出',
    bridge_match: '桥词',
    quality_confirmed: '近期确认',
    quality_corrected: '被纠正降权',
    quality_irrelevant: '不相关降权',
    quality_outdated: '已过期背景',
    surface_muted: '别主动提',
    anchor_coordinate: '长期坐标',
    background_high_arousal: '高情绪背景',
    background_recent: '近期背景',
    background_topic_match: '话题背景',
    background_unresolved: '未解决背景',
  };
  return labels[reason] ?? reason;
}

function describeMemoryDebugCount(key: string) {
  const labels: Record<string, string> = {
    anchors: '长期坐标',
    backgroundCandidates: '背景候选',
    backgroundLimit: '背景上限',
    backgroundYield: '背景让位',
    dropped: '被裁剪',
    preciseCandidates: '精准候选',
    preciseRecall: '精准想起',
    quiet_context: '背景记忆',
    quietContext: '背景记忆',
    recall: '相关记忆',
    reflections: '白云动态',
    carePool: '惦记池',
    heldCare: '暂时没说',
    spokenMention: '主动递出',
    suggestedMention: '主动递出',
    suggestedMentionCandidates: '递出候选',
    sourceMissingMessages: '原文缺失',
    sourceMissingRange: '无来源时间',
    sourceTraceCandidates: '原文候选',
    sourceTraceMatched: '原文命中',
    nearbyWorld: '附近世界',
    nearbyWorldBackgroundPrecision: '后台努力',
    nearbyWorldGpsExcellent: '定位很好',
    nearbyWorldGpsFair: '定位有些不稳',
    nearbyWorldGpsGood: '定位不错',
    nearbyWorldGpsPoor: '定位不太可靠',
    nearbyWorldNoKey: '缺高德Key',
    nearbyWorldPois: '附近地点',
    nearbyWorldStale: '附近缓存',
    nearbyWorldTransit: '交通工具上',
    nearbyWorldWalking: '一起走',
  };
  return labels[key] ?? key;
}

function describeMemoryRouteMode(mode: string) {
  const labels: Record<string, string> = {
    background_only: '只作背景',
    detail_recall: '需要原文细节',
    recall: '精准召回',
  };
  return labels[mode] ?? mode;
}

function describeMemoryRouteCareNeed(careNeed: string) {
  const labels: Record<string, string> = {
    low_energy: '低精力',
    needs_being_remembered: '想被记住',
    needs_companionship: '想被陪伴',
    ordinary: '普通',
    sensitive: '敏感旧事',
  };
  return labels[careNeed] ?? careNeed;
}

function describeMemoryRouteSource(routeSource: string) {
  const labels: Record<string, string> = {
    ai: 'AI',
    local: '本地兜底',
  };
  return labels[routeSource] ?? routeSource;
}

function buildMemoryDebugHamsterSummary(debug: MemoryBundleDebug) {
  const background = debug.counts.quietContext ?? 0;
  const related = debug.counts.recall ?? 0;
  const carePool = debug.counts.carePool ?? 0;
  const spoken = debug.counts.spokenMention ?? debug.counts.suggestedMention ?? 0;
  const held = debug.counts.heldCare ?? Math.max(0, carePool - spoken);
  const anchors = debug.counts.anchors ?? 0;
  const reflections = debug.counts.reflections ?? 0;
  const nearby = debug.counts.nearbyWorld ?? 0;
  const nearbyPois = debug.counts.nearbyWorldPois ?? 0;
  const nearbyMode = debug.counts.nearbyWorldWalking
    ? '一起走'
    : debug.counts.nearbyWorldTransit
      ? '交通工具上'
      : '';
  const nearbyQuality = debug.counts.nearbyWorldGpsPoor
    ? '定位不太可靠'
    : debug.counts.nearbyWorldGpsFair
      ? '定位有些不稳'
      : debug.counts.nearbyWorldGpsGood
        ? '定位不错'
        : debug.counts.nearbyWorldGpsExcellent
          ? '定位很好'
          : '';
  return `白云这轮把 ${background} 张背景小纸条放在心里，认真参考了 ${related} 条相关记忆${
    carePool ? `；惦记池里有 ${carePool} 件事，这轮主动递出 ${spoken} 件${held ? `，暂时没说 ${held} 件` : ''}` : ''
  }${anchors || reflections ? `；长期坐标 ${anchors} 条，白云动态 ${reflections} 条` : ''}${
    nearby ? `；附近世界带来 ${nearbyPois} 个附近地点${nearbyMode ? `，当前是${nearbyMode}` : ''}${nearbyQuality ? `，${nearbyQuality}` : ''}` : ''
  }。`;
}

function describeMemoryTraceStage(name: string) {
  const labels: Record<string, string> = {
    anchor_candidates: '坐标候选',
    anchor_selected: '坐标想起',
    background_candidates: '背景候选',
    background_selected: '背景想起',
    care_pool_candidates: '惦记候选',
    context_final: '最终想起',
    recall_candidates: '召回候选',
    recall_selected: '召回想起',
    reflection_candidates: '心声候选',
    reflection_selected: '心声想起',
    spoken_mentions: '主动递出',
    source_trace: '原文追溯',
  };
  return labels[name] ?? name;
}

function describeMemoryDropReason(reason: string) {
  const labels: Record<string, string> = {
    anchor_limit: '长期坐标已满',
    diversity_long_memory: '相似长记忆让位',
    duplicate_anchor: '长期坐标重复',
    duplicate_reflection: '白云动态重复',
    duplicate_recall: '重复',
    quiet_context_limit: '背景记忆太多，先放几条在心里',
    recall_limit: '相关记忆位置已满',
    reflection_limit: '白云动态已满',
    spoken_mention_limit: '主动递出已满',
    suggested_mention_limit: '自然关心已满',
  };
  return labels[reason] ?? reason;
}

function formatMemoryRecallDate(timestamp?: number) {
  if (!timestamp) return '';
  return new Date(timestamp).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

function buildMemoryRecallStatus(item: MemoryRecallItem) {
  const { memory, latestComment } = item;
  const statuses = [
    memory.activationCount > 0 ? `参考 ${memory.activationCount} 次` : '尚未参考',
    memory.resolved ? '已沉底' : '',
    memory.digested ? '已消化' : '',
    memory.surfaceSuppressedUntil && memory.surfaceSuppressedUntil > Date.now()
      ? `浮现冷却到 ${formatMemoryRecallDate(memory.surfaceSuppressedUntil)}`
      : '',
    memory.surfaceMutedAt ? `别主动提 ${formatMemoryRecallDate(memory.surfaceMutedAt)}` : '',
    latestComment?.kind === 'dehydration' ? '使用压缩年轮' : '',
    item.recallReasons?.includes('quality_confirmed') ? '近期确认' : '',
    item.recallReasons?.includes('quality_corrected') ? '被纠正降权' : '',
    item.recallReasons?.includes('quality_outdated') ? '已过期背景' : '',
    memory.lastMentionedAt ? `上次提起 ${formatMemoryRecallDate(memory.lastMentionedAt)}` : '',
  ].filter(Boolean);
  return statuses.join(' · ');
}

export const ChatMemoryRecallModal = memo(function ChatMemoryRecallModal({
  flaggedRecallIds,
  insets,
  latestMemoryDebug,
  latestMemoryRecall,
  onClose,
  onFlagIrrelevant,
  onToggleTechnical,
  panelHeight,
  technicalOpen,
  visible,
}: ChatMemoryRecallModalProps) {
  const explanation = useMemo(
    () => buildMemoryDebugExplanation(latestMemoryDebug, latestMemoryRecall),
    [latestMemoryDebug, latestMemoryRecall],
  );

  return (
    <Modal animationType="fade" onRequestClose={onClose} transparent visible={visible}>
      <View
        style={[
          styles.memoryRecallLayer,
          {
            paddingBottom: Math.max(insets.bottom, 24),
            paddingTop: Math.max(insets.top, 24),
          },
        ]}
      >
        <Pressable onPress={onClose} style={styles.renameScrim} />
        <View style={[styles.memoryRecallPanel, { height: panelHeight }]}>
          <ScrollView
            contentContainerStyle={styles.memoryRecallList}
            showsVerticalScrollIndicator={false}
            style={styles.memoryRecallScroll}
          >
            <Text style={styles.rangeHeading}>这一轮想起的事</Text>
            <Text style={styles.rangeDescription}>
              {latestMemoryDebug?.providedPapers?.length || latestMemoryDebug?.providedPosts?.length ? '本轮已提供的相关材料。' : latestMemoryRecall?.length
                ? '这些已确认记忆在回复前被白云小姐想起。'
                : '这一轮没有找到可带入对话的相关记忆。'}
            </Text>
            <View style={styles.memoryRecallDebugPanel}>
              <Text style={styles.memoryRecallDebugTitle}>白云为什么这样想起</Text>
              <Text style={styles.memoryRecallDebug}>{explanation.headline}</Text>
              {explanation.tags.length ? (
                <View style={styles.memoryRecallReasonTags}>
                  {explanation.tags.map((tag) => (
                    <Text key={tag} style={styles.memoryRecallReasonTag}>{tag}</Text>
                  ))}
                </View>
              ) : null}
              {explanation.actions.slice(0, 5).map((hint) => (
                <Text key={hint} style={styles.memoryRecallHintText}>• {hint}</Text>
              ))}
              {explanation.dropNotes.length ? (
                <View style={styles.memoryRecallReasonTags}>
                  {explanation.dropNotes.slice(0, 4).map((note) => (
                    <Text key={note} style={styles.memoryRecallDropTag}>{note}</Text>
                  ))}
                </View>
              ) : null}
              {latestMemoryDebug ? (
                <Pressable onPress={onToggleTechnical} style={styles.memoryRecallTechnicalToggle}>
                  <Text style={styles.memoryRecallTechnicalToggleText}>
                    {technicalOpen ? '收起技术细节' : '展开技术细节'}
                  </Text>
                </Pressable>
              ) : null}
              {latestMemoryDebug && technicalOpen ? (
                <View style={styles.memoryRecallTechnicalDetails}>
                  <Text style={styles.memoryRecallDebugTitle}>技术细节</Text>
                  <Text style={styles.memoryRecallDebug}>{buildMemoryDebugHamsterSummary(latestMemoryDebug)}</Text>
                  {latestMemoryDebug.route ? (
                    <View>
                      <View style={styles.memoryRecallReasonTags}>
                        <Text style={styles.memoryRecallReasonTag}>
                          {describeMemoryRouteMode(latestMemoryDebug.route.mode)}
                        </Text>
                        {latestMemoryDebug.route.careNeed ? (
                          <Text style={styles.memoryRecallReasonTag}>
                            {describeMemoryRouteCareNeed(latestMemoryDebug.route.careNeed)}
                            {typeof latestMemoryDebug.route.careIntensity === 'number' && latestMemoryDebug.route.careIntensity > 0
                              ? ` ${Math.round(latestMemoryDebug.route.careIntensity * 100)}%`
                              : ''}
                          </Text>
                        ) : null}
                        <Text style={styles.memoryRecallReasonTag}>
                          {describeMemoryRouteSource(latestMemoryDebug.route.routeSource)}
                        </Text>
                        {latestMemoryDebug.route.allowGentleMention ? (
                          <Text style={styles.memoryRecallReasonTag}>可轻轻带一句</Text>
                        ) : null}
                        {latestMemoryDebug.route.topic ? (
                          <Text style={styles.memoryRecallReasonTag}>{latestMemoryDebug.route.topic}</Text>
                        ) : null}
                        {latestMemoryDebug.route.keywords.slice(0, 5).map((keyword) => (
                          <Text key={keyword} style={styles.memoryRecallReasonTag}>{keyword}</Text>
                        ))}
                      </View>
                      {latestMemoryDebug.route.reason ? (
                        <Text style={styles.memoryRecallDebug}>小门卫：{latestMemoryDebug.route.reason}</Text>
                      ) : null}
                    </View>
                  ) : null}
                  <View style={styles.memoryRecallReasonTags}>
                    {Object.entries(latestMemoryDebug.counts).map(([key, value]) => (
                      <Text key={key} style={styles.memoryRecallReasonTag}>
                        {describeMemoryDebugCount(key)} {value}
                      </Text>
                    ))}
                  </View>
                  {latestMemoryDebug.trace?.stages.length ? (
                    <View style={styles.memoryRecallReasonTags}>
                      {latestMemoryDebug.trace.stages.slice(0, 7).map((stage) => (
                        <Text key={stage.name} style={styles.memoryRecallReasonTag}>
                          {describeMemoryTraceStage(stage.name)} {stage.inputCount}→{stage.outputCount}
                        </Text>
                      ))}
                    </View>
                  ) : null}
                  {latestMemoryDebug.dropped.length ? (
                    <View style={styles.memoryRecallReasonTags}>
                      {latestMemoryDebug.dropped.slice(0, 8).map((item, index) => (
                        <Text key={`${item.id}-${item.reason}-${index}`} style={styles.memoryRecallDropTag}>
                          {describeMemoryDropReason(item.reason)}
                        </Text>
                      ))}
                    </View>
                  ) : (
                    <Text style={styles.memoryRecallDebug}>这一轮没有被总控裁掉的记忆。</Text>
                  )}
                </View>
              ) : null}
            </View>
            {latestMemoryDebug?.providedPapers?.map(paper => <View key={`shiying:${paper.id}`} style={styles.memoryRecallCard}>
              <View style={styles.memoryRecallCardHeader}><Text style={styles.memoryRecallTitle}>拾荧纸条 · {paper.recordDate}</Text></View>
            </View>)}
            {latestMemoryDebug?.providedPosts?.map(post => <View key={`post:${post.id}`} style={styles.memoryRecallCard}>
              <View style={styles.memoryRecallCardHeader}><Text style={styles.memoryRecallTitle}>白云苍狗 · {post.title}</Text></View>
            </View>)}
            {latestMemoryRecall?.length ? (
              <View style={styles.memoryRecallCards}>
                {latestMemoryRecall.map((item) => {
                  const { memory, reason, latestComment, recallReasons, sources } = item;
                  const flagged = flaggedRecallIds.has(memory.id);
                  const status = buildMemoryRecallStatus(item);
                  const itemExplanation = buildMemoryRecallItemExplanation(item);
                  return (
                    <View key={memory.id} style={styles.memoryRecallCard}>
                      <View style={styles.memoryRecallCardHeader}>
                        <Text numberOfLines={1} style={styles.memoryRecallTitle}>{memory.title}</Text>
                        <Text style={styles.memoryRecallReason}>
                          {describeMemoryRecallReason(reason)}
                          {sources?.length ? ` · ${describeMemoryRecallSources(sources)}` : ''}
                        </Text>
                      </View>
                      <Text numberOfLines={3} style={styles.memoryRecallContent}>{memory.content}</Text>
                      {recallReasons?.length ? (
                        <View style={styles.memoryRecallReasonTags}>
                          {recallReasons.map((debugReason) => (
                            <Text key={debugReason} style={styles.memoryRecallReasonTag}>
                              {describeMemoryRecallDebugReason(debugReason)}
                            </Text>
                          ))}
                        </View>
                      ) : null}
                      {itemExplanation ? (
                        <Text style={styles.memoryRecallExplanation}>{itemExplanation}</Text>
                      ) : null}
                      {latestComment ? (
                        <View style={styles.memoryRecallComment}>
                          <Text style={styles.memoryRecallCommentLabel}>
                            {latestComment.kind === 'dehydration' ? '压缩年轮' : '最新年轮'}
                          </Text>
                          <Text numberOfLines={2} style={styles.memoryRecallCommentText}>{latestComment.content}</Text>
                        </View>
                      ) : null}
                      {status ? <Text style={styles.memoryRecallDebug}>{status}</Text> : null}
                      <View style={styles.memoryRecallCardFooter}>
                        <Text style={styles.memoryRecallDomain}>{memory.domain}</Text>
                        <Pressable
                          disabled={flagged}
                          onPress={() => onFlagIrrelevant(item)}
                          style={[styles.memoryRecallFeedbackButton, flagged && styles.memoryRecallFeedbackButtonDone]}
                        >
                          <Text style={[styles.memoryRecallFeedbackText, flagged && styles.memoryRecallFeedbackTextDone]}>
                            {flagged ? '已标记' : '不相关'}
                          </Text>
                        </Pressable>
                      </View>
                    </View>
                  );
                })}
              </View>
            ) : null}
          </ScrollView>
          <View style={styles.renameActions}>
            <Pressable onPress={onClose} style={styles.rangeConfirm}>
              <Text style={styles.rangeConfirmText}>知道啦</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}, (previous, next) => !previous.visible && !next.visible);
