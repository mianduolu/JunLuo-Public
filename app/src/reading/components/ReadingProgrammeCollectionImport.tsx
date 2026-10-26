import { useRef, useState } from 'react';
import { Alert, Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import type { EdgeInsets } from 'react-native-safe-area-context';
import { AppText as Text } from '../../components/AppText';
import { importProgrammeCollection, parseProgrammeCollection } from '../readingProgrammeCollection';
import { readingStyles as shared } from './readingStyles';

export function ReadingProgrammeCollectionImport({ visible, busy, setBusy, insets, onClose, refreshLibrary }: {
  visible: boolean; busy: boolean; setBusy: (value: boolean) => void; insets: EdgeInsets;
  onClose: () => void; refreshLibrary: () => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<Awaited<ReturnType<typeof parseProgrammeCollection>> | null>(null);
  const working = useRef(false);
  const close = () => { if (!busy && !working.current) { setDraft(null); onClose(); } };
  const choose = async () => {
    if (busy || working.current) return;
    working.current = true; setBusy(true);
    try {
      const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: false,
        type: ['application/zip', 'application/x-zip-compressed', 'application/octet-stream'] });
      if (result.canceled || !result.assets[0]) return;
      const file = result.assets[0];
      if (file.size !== undefined && file.size > 20_000_000) throw new Error('合集包超过 20 MB。');
      setDraft(await parseProgrammeCollection(await FileSystem.readAsStringAsync(file.uri, { encoding: FileSystem.EncodingType.Base64 })));
    } catch (error) {
      setDraft(null);
      Alert.alert('合集未读取', error instanceof Error ? error.message : '文件读取失败。');
    } finally { working.current = false; setBusy(false); }
  };
  const save = async () => {
    if (!draft || busy || working.current) return;
    working.current = true; setBusy(true);
    try {
      await importProgrammeCollection(draft);
      await refreshLibrary();
      setDraft(null); onClose();
    } catch (error) { Alert.alert('合集未保存', error instanceof Error ? error.message : '保存失败，可用原文件重试。'); }
    finally { working.current = false; setBusy(false); }
  };
  return <Modal animationType="slide" transparent visible={visible} onRequestClose={close}>
    <View style={[shared.pasteModalOverlay, { paddingTop: Math.max(insets.top + 16, 40), paddingBottom: Math.max(insets.bottom + 24, 40) }]}>
      <View style={shared.pasteModalCard}>
        <Text style={shared.sheetTitle}>导入节目合集</Text>
        <Text style={styles.caption}>一次导入目录与各集文字稿，按下方顺序接读。导入不会下载视频或启动阅读。</Text>
        <Pressable accessibilityRole="button" disabled={busy} onPress={() => void choose()} style={shared.sheetButton}>
          <Text style={shared.sheetButtonText}>{draft ? '更换合集包' : '选择合集 ZIP 文件'}</Text>
        </Pressable>
        <ScrollView style={styles.list}>
          {draft ? <>
            <Text style={shared.sheetText}>{draft.book.title}</Text>
            {draft.book.programme!.episodes!.map((e, index) => <View key={e.sourceUrl} style={styles.episode}>
              <Text style={styles.title}>{index + 1}. {e.title}</Text>
              <Text style={styles.caption}>{e.sourceName} · {Math.floor(e.durationMs / 60_000)} 分 {Math.floor(e.durationMs / 1000 % 60)} 秒 · {e.language}</Text>
            </View>)}
          </> : <Text style={styles.caption}>合集包包含 manifest.json 目录和各集 TXT / SRT / VTT。字幕未备齐时不会保存为空合集。</Text>}
        </ScrollView>
        <View style={shared.sheetActions}>
          <Pressable accessibilityRole="button" disabled={busy} onPress={close} style={shared.sheetButton}><Text style={shared.sheetButtonText}>取消</Text></Pressable>
          <Pressable accessibilityRole="button" disabled={busy || !draft} onPress={() => void save()}
            style={[shared.sheetButtonPrimary, (busy || !draft) && shared.disabled]}>
            <Text style={shared.sheetButtonPrimaryText}>{busy ? '处理中' : '按此顺序保存'}</Text>
          </Pressable>
        </View>
      </View>
    </View>
  </Modal>;
}

const styles = StyleSheet.create({
  list: { maxHeight: 380 },
  episode: { borderBottomColor: '#E2EBEF', borderBottomWidth: 1, paddingVertical: 12, gap: 4 },
  title: { fontSize: 16, lineHeight: 25, color: '#344451' },
  caption: { fontSize: 13, lineHeight: 21, color: '#728598' },
});
