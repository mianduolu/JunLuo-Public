import { View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import type { PromptCacheChannel, PromptCacheMetricsGroup } from '../ai/promptCacheMetrics';
import { formatPromptCacheHitRate } from '../ai/promptCacheMetrics';
import { AppText as Text } from '../components/AppText';
import { styles } from '../screens/ChatScreen.styles';

export { formatPromptCacheHitRate };

export function formatPromptCacheGroupMeta(group: PromptCacheMetricsGroup) {
  return `请求 ${group.requestCount.toLocaleString()} 次 · 输入 ${formatPromptCacheTokens(group.promptTokens, group.knownPromptRequestCount)} / 输出 ${formatPromptCacheTokens(group.completionTokens, group.knownOutputRequestCount)} token\n`
    + `输入资料 ${group.knownPromptRequestCount}/${group.requestCount} · 输出资料 ${group.knownOutputRequestCount}/${group.requestCount} · 缓存明细 ${group.knownCacheRequestCount}/${group.requestCount}\n`
    + `已知缓存命中率 ${formatPromptCacheHitRate(group.averageHitRate)} · 前缀资料 ${group.knownPrefixRequestCount}/${group.requestCount} · 前缀变化 ${group.knownPrefixRequestCount ? group.stablePrefixChangedCount.toLocaleString() + ' 次' : '未知'}`;
}

export function formatPromptCacheTokens(value: number | undefined, knownCount: number | undefined) {
  return knownCount && value !== undefined ? value.toLocaleString() : '未知';
}

export function formatPromptCacheChannel(channel: PromptCacheChannel) {
  return { deepseek: 'DeepSeek 直连', siliconflow: '硅基流动', other: '其它渠道', unknown: '渠道未知' }[channel];
}

export function formatPromptCacheSourceName(source: string) {
  const names: Record<string, string> = {
    'chat.main': '普通聊天', 'chat.quality-retry': '聊天补试',
    'inner.wants': '十维欲望卷', 'inner.affect': '感受卷',
    'inner.near-status': '近况、念头与模样卷',
    'assistant-life.state': '内在状态与近况（旧合并标签）',
    'assistant-life.afterglow': '对话余韵（旧合并标签）',
    'assistant-life.post': '动态发布', 'assistant-life.post-reply': '动态回复',
    'assistant-life.diary': '生活日记', 'assistant-life.dream': '夜梦',
    'assistant-life.daily-summary': '今日小日记',
    'proactive.ordinary': '主动联系', 'proactive.phone-activity': '手机活动联系',
    'proactive.nearby-world': '附近世界联系', 'proactive.web-voyage-share': '网页见闻分享',
    'proactive.github-voyage-share': '代码见闻分享', 'proactive.social-share': '社交分享',
    'proactive.jealousy-dismissal': '吃醋联系',
    'memory.organizer': '记忆整理', 'memory.recall': '记忆召回',
    'memory.organize-chat': '聊天记忆整理', 'memory.history': '旧聊天导入整理',
    'memory.post': '动态记忆整理', 'memory.focus': '专注记忆整理',
    'memory.suggestions': '记忆候选整理', 'memory.explicit': '明确事实整理',
    'memory.continuation': '记忆接续整理', 'memory.duplicate': '记忆重复核对',
    'memory.dehydration': '记忆瘦身', 'memory.episode': '阶段记忆整理',
    'memory.weekly': '记忆周归纳', 'memory.recall-route': '记忆查找选择', 'memory.rerank': '记忆候选重排',
    'voice.call': '通话回复', 'voice.summary': '通话总结',
    'letter.delivery': '信件', 'letter.reply': '信件回复',
    'image.chat': '聊天图片理解', 'image.describe': '图片理解', 'image.post': '动态图片理解',
    'image.shiying': '拾荧图片理解', 'connection.test': '手动模型连接测试',
    'theater.reply': '小剧场写作', 'theater.summary': '小剧场整理',
    'voyage.topic': '公开探索选题', 'voyage.selection': '公开探索选页',
    'reading.completion': '共读请求',
    'chat.compression': '聊天压缩', 'reminder.preparation': '提醒准备',
    'goal.time-credit': '目标时间估算', 'wallet.decision': '小金库决定',
    'phone.usage-comment': '手机使用点评',
    'focus.companion': '共同专注', 'period.care': '经期关心', 'period.memory': '经期记忆',
    'focus.short-text': '专注短话', 'shiying.extraction': '拾荧整理',
    'shiying.weeklyReview': '拾荧周回顾', 'shiying.monthlyReview': '拾荧月回顾', 'shiying.yearlyReview': '拾荧年回顾',
    'schedule.plan': '日程页排程', 'schedule.week-review': '日程周回顾',
    'schedule.utility-json': '日程资料整理（兼容入口）', 'goal.extract': '目标整理（兼容入口）',
    'schedule.nudge-classification': '提醒回应整理（兼容入口）',
    'phone.jealousy-candidate': '吃醋应用选择', 'phone.jealousy-dismissed-reaction': '吃醋应用移除反应',
    'jealousy-dismissal': '吃醋应用移除后的联系',
    'schedule.planner': '日程规划', 'schedule.reminder': '日程提醒',
    'schedule.companion': '日程陪伴', 'reading.companion': '共读', 'expense.parser': '记账解析',
  };
  if (names[source]) return names[source];
  if (source.startsWith('memory.')) return '记忆处理';
  if (source.startsWith('camera.')) return '相机理解';
  if (source.startsWith('voice.')) return '通话处理';
  if (source.startsWith('assistant-life.')) return '生活后台';
  if (source.startsWith('voyage.')) return '网页远游';
  if (source.startsWith('schedule.')) return '日程处理';
  if (source.startsWith('phone.')) return '手机使用点评';
  return '其它模型请求';
}

export function getPromptCacheGroupWarning(group: PromptCacheMetricsGroup) {
  return group.knownPrefixRequestCount > 0 && group.stablePrefixChangedCount > 0
    ? '已知样本的固定前缀发生变化；设置或布局改变也会影响此项' : null;
}

export function TokenUsageRing({ color, percentage }: { color: string; percentage: number }) {
  const size = 34;
  const strokeWidth = 3;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const progress = Math.max(0, Math.min(1, percentage / 100));
  const ringPath = `M ${size / 2} ${strokeWidth / 2} a ${radius} ${radius} 0 1 1 0 ${radius * 2} a ${radius} ${radius} 0 1 1 0 ${-radius * 2}`;
  return (
    <View style={styles.tokenRing}>
      <Svg height={size} width={size}>
        <Path
          d={ringPath}
          fill="transparent"
          stroke="rgba(120, 132, 148, 0.2)"
          strokeWidth={strokeWidth}
        />
        <Path
          d={ringPath}
          fill="transparent"
          rotation="-90"
          origin={`${size / 2}, ${size / 2}`}
          stroke={color}
          strokeDasharray={`${circumference} ${circumference}`}
          strokeDashoffset={circumference * (1 - progress)}
          strokeLinecap="round"
          strokeWidth={strokeWidth}
        />
      </Svg>
      <Text style={[styles.tokenRingText, { color }]}>{Math.round(percentage)}</Text>
    </View>
  );
}
