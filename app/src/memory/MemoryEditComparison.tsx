import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { AppText as Text } from '../components/AppText';
import { formatMemoryEventTimeLabel } from './memoryAtomicity';
import { getAnchorKindLabel } from './memoryAnchorContext';
import type { MemoryEntry } from './memoryStore';

export function MemoryEditComparison({ memory, onReviewed }: { memory: MemoryEntry; onReviewed: () => void }) {
  return <View style={styles.box}>
    <Text style={styles.heading}>最新原卡</Text>
    <ScrollView nestedScrollEnabled style={styles.material}>
      <Text selectable style={styles.heading}>{memory.title}</Text>
      <Text selectable style={styles.text}>{memory.content}</Text>
      <Text selectable style={styles.text}>领域：{memory.domain} · 重要度：{memory.importance} · {memory.pinned ? '已钉住' : '未钉住'}</Text>
      <Text selectable style={styles.text}>长期锚点：{memory.anchor ? getAnchorKindLabel(memory.anchorKind) : '无'}</Text>
      <Text selectable style={styles.text}>时间：{formatMemoryEventTimeLabel(memory.eventTime) || '未确定'}</Text>
      <Text selectable style={styles.text}>标签：{memory.tags.join('、') || '无'}</Text>
      <Text selectable style={styles.text}>回想线索：{memory.recallCues.join('、') || '无'}</Text>
      <Text selectable style={styles.text}>记住的理由：{memory.rememberedReason || '无'}</Text>
    </ScrollView>
    <Text style={styles.text}>下方保留了你的编辑稿。核对后可继续修改，再点保存；不会自动拼接两稿。</Text>
    <Pressable accessibilityRole="button" onPress={onReviewed} style={styles.button}>
      <Text style={styles.link}>已对照，以这版原卡继续</Text>
    </Pressable>
  </View>;
}

const styles = StyleSheet.create({
  box: { padding: 12, gap: 8, borderWidth: 1, borderColor: '#E4C5B3', borderRadius: 12, backgroundColor: '#FFF9EF' },
  material: { maxHeight: 230 },
  heading: { fontSize: 15, fontWeight: '700', color: '#494958' },
  text: { fontSize: 13, lineHeight: 21, color: '#626272', marginTop: 4 },
  button: { alignSelf: 'flex-start', paddingVertical: 8 },
  link: { color: '#5683A9', fontWeight: '700' },
});
