import { useState } from 'react';
import { FlatList, Pressable, View } from 'react-native';
import type { EdgeInsets } from 'react-native-safe-area-context';
import { AppText as Text } from '../../components/AppText';
import type { EpubRecoveryChoice, EpubRecoveryPreview } from '../readingEpubUpgradeRuntime';
import { ReadingCenteredModal } from './ReadingModals';
import { readingStyles as styles } from './readingStyles';

export function ReadingEpubRecoveryModal({ preview, busy, insets, onClose, onConfirm }: {
  preview: EpubRecoveryPreview; busy: boolean; insets: EdgeInsets;
  onClose: () => void; onConfirm: (choice: EpubRecoveryChoice) => void;
}) {
  const [chapterIndex, setChapterIndex] = useState<number | null>(null);
  const [blockIndex, setBlockIndex] = useState<number | null>(null);
  const chapter = preview.chapters.find(item => item.index === chapterIndex);
  return <ReadingCenteredModal visible insets={insets} onRequestClose={() => { if (!busy) onClose(); }}>
    <View style={{ padding: 20, flex: 1, gap: 12 }}>
      <Text style={styles.sheetTitle}>从原文选择接读起点</Text>
      <Text style={styles.resultMeta}>旧笔记与日期保留。不能对应新版原文的记录仍在笔记页查看；确认不会请求模型，也不会把前文标为已读。</Text>
      {chapter ? <>
        <Pressable disabled={busy} onPress={() => { setChapterIndex(null); setBlockIndex(null); }}>
          <Text style={styles.sheetText}>‹ 返回章节　{chapter.title}</Text>
        </Pressable>
        <FlatList data={chapter.blocks} keyExtractor={item => String(item.index)} extraData={blockIndex}
          renderItem={({ item }) => <Pressable disabled={busy} accessibilityRole="radio"
            accessibilityState={{ checked: blockIndex === item.index }} onPress={() => setBlockIndex(item.index)}
            style={{ padding: 14, marginBottom: 10, borderRadius: 12, borderWidth: 1,
              borderColor: blockIndex === item.index ? '#6F98BB' : '#E0E8E9',
              backgroundColor: blockIndex === item.index ? '#EFF6FA' : '#FFFDFC' }}>
            <Text style={styles.resultMeta}>原文位置 {item.index + 1}{blockIndex === item.index ? ' · 已选' : ''}</Text>
            <Text style={styles.sheetText}>{item.label}</Text>
          </Pressable>} />
      </> : <FlatList data={preview.chapters} keyExtractor={item => String(item.index)}
        renderItem={({ item }) => <Pressable disabled={busy} onPress={() => setChapterIndex(item.index)}
          style={{ paddingVertical: 16, borderBottomWidth: 1, borderColor: '#E0E8E9' }}>
          <Text style={styles.sheetText}>{item.index + 1}　{item.title}</Text>
        </Pressable>} />}
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingTop: 8 }}>
        <Pressable disabled={busy} onPress={onClose}><Text style={styles.sheetText}>取消</Text></Pressable>
        <Pressable disabled={busy || !chapter || blockIndex === null} onPress={() => {
          if (chapter && blockIndex !== null) onConfirm({ chapterIndex: chapter.index, blockIndex,
            revision: chapter.revision, dataEpoch: preview.dataEpoch });
        }}><Text style={[styles.sheetText, { color: !busy && chapter && blockIndex !== null ? '#527B99' : '#9BA5AA' }]}>
          {busy ? '保存中…' : '确认从这里接读'}
        </Text></Pressable>
      </View>
    </View>
  </ReadingCenteredModal>;
}
