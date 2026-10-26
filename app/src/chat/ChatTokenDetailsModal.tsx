import { memo } from 'react';
import { Modal, Pressable, ScrollView, View } from 'react-native';

import type { PromptCacheMetricsSummary } from '../ai/promptCacheMetrics';
import { AppText as Text } from '../components/AppText';
import { styles } from '../screens/ChatScreen.styles';
import type { ChatContextCompressionState } from './chatStorage';
import {
  formatPromptCacheGroupMeta,
  formatPromptCacheChannel,
  formatPromptCacheHitRate,
  formatPromptCacheSourceName,
  formatPromptCacheTokens,
  getPromptCacheGroupWarning,
  TokenUsageRing,
} from './ChatTokenUsageRing';

export type ChatTokenDetailsModalProps = {
  compressing: boolean;
  compressionEnabled: boolean;
  compressionMessageThreshold: number;
  compressionMessageThresholdEnabled: boolean;
  compressionState: ChatContextCompressionState;
  compressionThresholdPercentage: number;
  contextUsagePercentage: number;
  contextWindowTokens: number;
  onClose: () => void;
  onCompress: () => void;
  promptCacheSummary: PromptCacheMetricsSummary | null;
  replyBusy: boolean;
  tokenRingColor: string;
  visible: boolean;
};

export const ChatTokenDetailsModal = memo(function ChatTokenDetailsModal({
  compressing,
  compressionEnabled,
  compressionMessageThreshold,
  compressionMessageThresholdEnabled,
  compressionState,
  compressionThresholdPercentage,
  contextUsagePercentage,
  contextWindowTokens,
  onClose,
  onCompress,
  promptCacheSummary,
  replyBusy,
  tokenRingColor,
  visible,
}: ChatTokenDetailsModalProps) {
  const shortChatLogs = compressionState.shortLogs ?? [];

  return (
    <Modal animationType="fade" onRequestClose={onClose} transparent visible={visible}>
      <View style={styles.rangeLayer}>
        <Pressable onPress={onClose} style={styles.renameScrim} />
        <View style={[styles.tokenDetailsPanel, { maxHeight: '90%' }]}>
          <ScrollView contentContainerStyle={{ gap: 13 }} style={{ flexShrink: 1 }} showsVerticalScrollIndicator={false}>
          <Text style={styles.rangeHeading}>上下文窗口</Text>
          <View style={styles.tokenDetailsHero}>
            <TokenUsageRing color={tokenRingColor} percentage={contextUsagePercentage} />
            <View>
              <Text style={styles.tokenDetailsValue}>
                {compressionState.currentWindowTokens.toLocaleString()} / {contextWindowTokens.toLocaleString()}
              </Text>
              <Text style={styles.tokenDetailsHint}>
                {compressionState.tokenSource === 'api' ? 'API 返回的 prompt token' : '本机保守估算'}
              </Text>
            </View>
          </View>
          <Text style={styles.tokenDetailsLine}>
            自动压缩：{compressionEnabled ? `${Math.round(compressionThresholdPercentage)}%` : '关闭'}
            {compressionMessageThresholdEnabled ? ` 或 ${compressionMessageThreshold} 条小仓鼠消息` : ''}
          </Text>
          <Text style={styles.tokenDetailsLine}>
            上次压缩：{compressionState.lastCompressedAt
              ? new Date(compressionState.lastCompressedAt).toLocaleString('zh-CN')
              : '还没有压缩过'}
          </Text>
          {compressionState.lastCompressedAt ? (
            <Text style={styles.tokenDetailsLine}>
              {compressionState.lastBeforeTokens.toLocaleString()} → {compressionState.lastAfterTokens.toLocaleString()} token
            </Text>
          ) : null}
          <View style={styles.tokenBreakdown}>
            <Text style={styles.tokenBreakdownHeading}>短期聊天小便签</Text>
            {shortChatLogs.length ? (
              shortChatLogs.slice(-5).reverse().map((log) => (
                <View key={log.id} style={styles.promptCacheGroupItem}>
                  <View style={styles.tokenBreakdownRow}>
                    <Text style={styles.tokenBreakdownLabel}>{log.title}</Text>
                    <Text style={styles.tokenBreakdownTokens}>
                      {new Date(log.endAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
                    </Text>
                  </View>
                  <Text style={styles.promptCacheGroupMeta}>{log.summary}</Text>
                  <Text style={styles.tokenDetailsLine}>{log.source === 'manual' ? '手动整理' : '自动整理'}</Text>
                </View>
              ))
            ) : (
              <Text style={styles.tokenDetailsLine}>还没有短期小便签；长聊后会自动出现。</Text>
            )}
          </View>
          {compressionState.promptCache ? (
            <View style={styles.tokenBreakdown}>
              <Text style={styles.tokenBreakdownHeading}>最后一次聊天的服务端缓存</Text>
              <Text style={styles.tokenDetailsLine}>仅这一轮聊天，不是全部模型调用汇总。</Text>
              {compressionState.promptCache.hitTokens !== null
                && compressionState.promptCache.missTokens !== null ? (
                  <>
                    <Text style={styles.tokenDetailsLine}>
                      命中 {compressionState.promptCache.hitTokens.toLocaleString()} / 未命中{' '}
                      {compressionState.promptCache.missTokens.toLocaleString()} token
                    </Text>
                    <Text style={styles.tokenDetailsLine}>
                      命中率：{formatPromptCacheHitRate(compressionState.promptCache.hitRate)}
                    </Text>
                  </>
                ) : (
                  <Text style={styles.tokenDetailsLine}>接口本轮没有返回缓存明细</Text>
                )}
              <Text style={styles.tokenDetailsLine}>
                固定前缀约 {compressionState.promptCache.stablePrefixTokens.toLocaleString()} token ·{' '}
                {compressionState.promptCache.stablePrefixChanged ? '本轮发生变化' : '与上一轮一致'}
              </Text>
            </View>
          ) : null}
          {promptCacheSummary?.requestCount ? (
            <View style={styles.tokenBreakdown}>
              <Text style={styles.tokenBreakdownHeading}>最近 24 小时模型用量</Text>
              <Text style={styles.tokenDetailsLine}>
                已记录请求 {promptCacheSummary.requestCount.toLocaleString()} 次 · 已知输入 {formatPromptCacheTokens(promptCacheSummary.promptTokens, promptCacheSummary.knownPromptRequestCount)} / 已知输出 {formatPromptCacheTokens(promptCacheSummary.completionTokens, promptCacheSummary.knownOutputRequestCount)} token
              </Text>
              <Text style={styles.tokenDetailsLine}>
                输入资料 {promptCacheSummary.knownPromptRequestCount}/{promptCacheSummary.requestCount} · 输出资料 {promptCacheSummary.knownOutputRequestCount}/{promptCacheSummary.requestCount} · 缓存明细 {promptCacheSummary.knownCacheRequestCount}/{promptCacheSummary.requestCount}
              </Text>
              <Text style={styles.tokenDetailsLine}>
                已知命中 {formatPromptCacheTokens(promptCacheSummary.hitTokens, promptCacheSummary.knownCacheRequestCount)} / 未命中 {formatPromptCacheTokens(promptCacheSummary.missTokens, promptCacheSummary.knownCacheRequestCount)} token · 命中率 {formatPromptCacheHitRate(promptCacheSummary.averageHitRate)}
              </Text>
              <Text style={styles.tokenDetailsLine}>
                前缀资料 {promptCacheSummary.knownPrefixRequestCount}/{promptCacheSummary.requestCount} · 前缀变化 {promptCacheSummary.knownPrefixRequestCount ? `${promptCacheSummary.stablePrefixChangedCount} 次` : '未知'}；资料缺失不计为 0。
              </Text>
              <Text style={styles.tokenDetailsLine}>总览合计各渠道和模型的已知样本；台账最多保留 300 条、7 天，不是完整账单。</Text>
              {promptCacheSummary.groups.map((group) => {
                const warning = getPromptCacheGroupWarning(group);
                return (
                  <View key={JSON.stringify([group.channel, group.model, group.contextSource, group.contextProfile])} style={styles.promptCacheGroupItem}>
                    <View style={styles.tokenBreakdownRow}>
                      <Text style={styles.tokenBreakdownLabel}>{formatPromptCacheSourceName(group.contextSource)}</Text>
                      <Text style={styles.tokenBreakdownTokens}>{formatPromptCacheTokens(group.missTokens, group.knownCacheRequestCount)} 未命中</Text>
                    </View>
                    <Text style={styles.promptCacheGroupMeta}>{formatPromptCacheChannel(group.channel)} · {group.model || '模型未知'} · {group.contextSource}</Text>
                    <Text style={styles.promptCacheGroupMeta}>{formatPromptCacheGroupMeta(group)}</Text>
                    {warning ? <Text style={styles.promptCacheGroupWarning}>{warning}</Text> : null}
                  </View>
                );
              })}
            </View>
          ) : null}
          {compressionState.promptBreakdown ? (
            <View style={styles.tokenBreakdown}>
              <Text style={styles.tokenBreakdownHeading}>本轮分项估算</Text>
              {([
                ['人格与底线', compressionState.promptBreakdown.persona],
                ['个人资料', compressionState.promptBreakdown.userProfile],
                ['场景与输出规则', compressionState.promptBreakdown.scenario],
                ['表情素材', compressionState.promptBreakdown.expression],
                ['记忆', compressionState.promptBreakdown.memory],
                ['环境', compressionState.promptBreakdown.environment],
                ['累计摘要', compressionState.promptBreakdown.summary],
                ['近期原文', compressionState.promptBreakdown.history],
              ] as Array<[string, number]>).map(([label, tokens]) => (
                <View key={label} style={styles.tokenBreakdownRow}>
                  <Text style={styles.tokenBreakdownLabel}>{label}</Text>
                  <Text style={styles.tokenBreakdownTokens}>{tokens.toLocaleString()}</Text>
                </View>
              ))}
            </View>
          ) : null}
          {compressionState.lastError ? <Text style={styles.tokenDetailsError}>{compressionState.lastError}</Text> : null}
          <View style={styles.renameActions}>
            <Pressable onPress={onClose} style={styles.renameCancel}>
              <Text style={styles.renameCancelText}>关闭</Text>
            </Pressable>
            <Pressable
              disabled={compressing || replyBusy}
              onPress={onCompress}
              style={[styles.rangeConfirm, (compressing || replyBusy) && styles.disabledButton]}
            >
              <Text style={styles.rangeConfirmText}>{compressing ? '压缩中...' : '立即压缩'}</Text>
            </Pressable>
          </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}, (previous, next) => !previous.visible && !next.visible);
