import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AppText as Text } from '../components/AppText';
import { captureBackupRestoreDataEpoch, canCommitBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { getFileImportRecord, readImportedText } from '../tools/fileToolStore';
import { loadChatSessionMessage } from './chatStorage';
import { subscribeChatDataChanges } from './chatDataChanges';
import { PRIMARY_CHAT_SESSION_ID } from './primaryChat';
import { hasChatTextFileCard } from './chatTextFileReference';
import type { JunLuoToolCallCard } from './toolCallMessageTypes';

export function ChatTextFileReader({ messageId, card }: { messageId: string; card: JunLuoToolCallCard }) {
  const [visible, setVisible] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const reference = card.fileReference;

  useEffect(() => {
    if (!visible || !reference) return;
    const epoch = captureBackupRestoreDataEpoch();
    const sourceValid = async () => {
      if (!canCommitBackupRestoreDataEpoch(epoch)) return false;
      const message = await loadChatSessionMessage(PRIMARY_CHAT_SESSION_ID, messageId);
      return canCommitBackupRestoreDataEpoch(epoch) && hasChatTextFileCard(message?.toolCallCards, card);
    };
    const invalidate = () => {
      request.current += 1;
      setText(null);
      setError('这张文件卡片已失效。');
    };
    const read = async () => {
      const sequence = ++request.current;
      setText(null);
      setError(null);
      try {
        if (!await sourceValid()) throw new Error('source-invalid');
        const record = await getFileImportRecord(reference.cacheId);
        if (!record || record.name !== reference.name) throw new Error('file-missing');
        const contents = await readImportedText(reference.cacheId);
        if (!await sourceValid()) throw new Error('source-invalid');
        if (sequence === request.current) setText(contents.text);
      } catch (cause) {
        if (sequence !== request.current) return;
        setText(null);
        setError(cause instanceof Error && cause.message === 'source-invalid'
          ? '这张文件卡片已失效。'
          : '无法读取文件，请确认文件已在本机保存或同步完成。');
      }
    };
    void read();
    const unsubscribe = subscribeChatDataChanges(change => {
      if (change === 'restore') { invalidate(); return; }
      const sequence = request.current;
      void sourceValid().then(valid => {
        if (!valid && sequence === request.current) invalidate();
      }).catch(() => { if (sequence === request.current) invalidate(); });
    });
    return () => { request.current += 1; unsubscribe(); };
  }, [visible, messageId, card.callId, card.toolId, card.status, reference?.cacheId, reference?.name]);

  const close = () => { request.current += 1; setVisible(false); setText(null); setError(null); };
  if (!reference || !hasChatTextFileCard([card], card)) return null;
  return (
    <>
      <Pressable accessibilityRole="button" onPress={() => setVisible(true)} style={styles.open}>
        <Text style={styles.openText}>打开文件 · {reference.name}</Text>
      </Pressable>
      <Modal visible={visible} onRequestClose={close} animationType="slide">
        <SafeAreaView style={styles.page}>
          <View style={styles.header}>
            <Text numberOfLines={2} style={styles.title}>{reference.name}</Text>
            <Pressable accessibilityRole="button" onPress={close} hitSlop={12}><Text style={styles.openText}>关闭</Text></Pressable>
          </View>
          {error ? <Text style={styles.error}>{error}</Text> : text === null ? <ActivityIndicator /> : (
            <ScrollView contentContainerStyle={styles.content}>
              <Text selectable style={styles.body}>{text}</Text>
            </ScrollView>
          )}
        </SafeAreaView>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  open: { paddingVertical: 10 },
  openText: { color: '#5C78A5', fontSize: 14 },
  page: { flex: 1, backgroundColor: '#FCFAFF' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 16, padding: 20 },
  title: { flex: 1, fontSize: 18, color: '#50465E' },
  content: { paddingHorizontal: 20, paddingBottom: 32 },
  body: { fontSize: 16, lineHeight: 26, color: '#393442' },
  error: { padding: 20, color: '#945C6A' },
});
