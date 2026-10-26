import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import type { ContinuitySourceMessages } from '../ai/behavior/continuitySourceMessages';
import { AppText as Text } from '../components/AppText';
import { colors } from '../theme/colors';

export function AssistantDiaryContinuitySource({ source }: { source?: ContinuitySourceMessages }) {
  const [expanded, setExpanded] = useState(false);
  if (source?.deviceRecord || source?.excerpts?.length) {
    return (
      <View style={styles.box}>
        {source.deviceRecord ? <View style={styles.message}>
          <Text style={styles.meta}>最初的设备记录</Text>
          <Text selectable style={styles.body}>{source.deviceRecord}</Text>
        </View> : null}
        {source.excerpts?.map(excerpt => (
          <View key={excerpt.kind} style={styles.message}>
            <Text style={styles.meta}>{excerpt.kind === 'origin' ? '最初的原话摘录' : '最新的原话摘录'}</Text>
            <Text style={styles.meta}>小仓鼠 · {new Date(excerpt.evidence.sentAt).toLocaleString('zh-CN', { hour12: false })}</Text>
            <Text selectable style={styles.body} numberOfLines={expanded ? undefined : 3}>{excerpt.evidence.quote}</Text>
            {excerpt.status === 'missing' ? <Text style={styles.meta}>对应原消息已不存在；这里保留的是当时的摘录。</Text> : null}
            {excerpt.status === 'error' ? <Text style={styles.meta}>对应原文读取失败，可点页面“刷新”重试。</Text> : null}
            {excerpt.status === 'changed' ? <Text style={styles.meta}>原消息已修改；摘录为当时记录，展开后查看当前原文。</Text> : null}
            {expanded && excerpt.message ? (
              <View style={styles.message}>
                <Text style={styles.meta}>对应消息全文</Text>
                <Text selectable style={styles.body}>{excerpt.message.content || '这条原消息没有文字正文。'}</Text>
              </View>
            ) : null}
          </View>
        ))}
        {source.excerpts?.length ? <Pressable accessibilityRole="button" onPress={() => setExpanded(value => !value)} style={styles.toggle}>
          <Text style={styles.toggleText}>{expanded ? '收起原文' : '展开完整原文'}</Text>
        </Pressable> : null}
      </View>
    );
  }
  if (!source || !source.messages.length) {
    return <Text style={styles.meta}>{!source ? '正在读取来源原文…'
      : source.kind === 'error' ? '来源原文读取失败，可点页面“刷新”重试。'
        : '未找到对应聊天原文；可能是系统触发的记录，或原消息已不存在。'}</Text>;
  }
  return (
    <View style={styles.box}>
      <Text style={styles.meta}>{source.kind === 'origin' ? '产生这件牵挂的原文' : '关联聊天原文（未找到起始原文）'}</Text>
      {(expanded ? source.messages : source.messages.slice(0, 1)).map((message) => (
        <View key={message.id} style={styles.message}>
          <Text style={styles.meta}>
            {message.role === 'you' ? '小仓鼠' : '白云小姐'} · {new Date(message.createdAt).toLocaleString('zh-CN', { hour12: false })}
          </Text>
          <Text selectable style={styles.body} numberOfLines={expanded ? undefined : 3}>
            {message.content || '这条原消息没有文字正文。'}
          </Text>
        </View>
      ))}
      <Pressable accessibilityRole="button" onPress={() => setExpanded((value) => !value)} style={styles.toggle}>
        <Text style={styles.toggleText}>{expanded ? '收起原文' : '展开完整原文'}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: 6, padding: 10, borderRadius: 12, backgroundColor: 'rgba(157, 134, 185, 0.06)' },
  message: { gap: 4 },
  meta: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  body: { color: colors.ink, fontSize: 14, lineHeight: 21 },
  toggle: { alignSelf: 'flex-start', paddingVertical: 6 },
  toggleText: { color: colors.primary, fontSize: 12, fontWeight: '600' },
});
