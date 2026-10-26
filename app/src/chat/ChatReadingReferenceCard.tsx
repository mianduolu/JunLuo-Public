import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { AppText as Text } from '../components/AppText';
import type { ReadingReference } from '../reading/readingReference';

/** A reference is only an attachment: opening its title never starts reading. */
export function ChatReadingReferenceCard({ reference, onRemove, onLongPress, onSelect }: {
  reference: ReadingReference;
  onRemove?: () => void;
  onLongPress?: () => void;
  onSelect?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return <View style={styles.card}>
    <Pressable accessibilityRole="button" accessibilityLabel={`查看完整标题：${reference.title}`}
      accessibilityState={{ expanded }} onLongPress={onLongPress}
      onPress={(event) => { event.stopPropagation(); if (onSelect) onSelect(); else setExpanded(value => !value); }} style={styles.copy}>
      <Text style={styles.kind}>{reference.contentType === 'programme' ? '节目' : '书籍'} · 带进聊天</Text>
      <Text numberOfLines={expanded ? undefined : 2} style={styles.title}>{reference.title}</Text>
    </Pressable>
    {onRemove ? <Pressable accessibilityRole="button" accessibilityLabel="移除待发作品" hitSlop={8}
      onPress={(event) => { event.stopPropagation(); onRemove(); }} style={styles.remove}>
      <Text style={styles.removeText}>×</Text>
    </Pressable> : null}
  </View>;
}

const styles = StyleSheet.create({
  card: { flexDirection: 'row', alignItems: 'flex-start', backgroundColor: '#EDF6FA', borderColor: '#D5E8F1', borderWidth: 1, borderRadius: 16, marginVertical: 6, padding: 12 },
  copy: { flex: 1, minHeight: 42, gap: 5 },
  kind: { color: '#758F9B', fontSize: 12, lineHeight: 18 },
  title: { color: '#466B80', fontSize: 15, lineHeight: 22 },
  remove: { minWidth: 36, minHeight: 36, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFF1E6', borderRadius: 18, marginLeft: 8 },
  removeText: { color: '#BC9073', fontSize: 23 },
});
