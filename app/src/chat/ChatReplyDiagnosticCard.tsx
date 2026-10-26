import { useState, type ReactNode } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';
import { colors } from '../theme/colors';
import { buildChatReplyDiagnosticPresentation, copyChatReplyDiagnosticText, type ChatReplyDiagnosticEntry } from './chatReplyDiagnosticPresentation';

export function ChatReplyDiagnosticCard({ entry, children }: { entry: ChatReplyDiagnosticEntry; children?: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const [copyNotice, setCopyNotice] = useState('');
  const presentation = buildChatReplyDiagnosticPresentation(entry);
  const copy = async () => {
    try {
      const copied = await Clipboard.setStringAsync(copyChatReplyDiagnosticText(entry));
      setCopyNotice(copied ? '诊断已复制' : '复制失败，请再试一次');
    } catch { setCopyNotice('复制失败，请再试一次'); }
  };
  return <View style={styles.card}>
    <Text style={styles.title}>{presentation.title}</Text>
    <Text style={styles.meta}>{new Date(entry.attemptedAt).toLocaleString('zh-CN', { hour12: false })}</Text>
    {presentation.summary.map((line, index) => <Text key={index} style={[styles.body, presentation.focusedFailure && index === 0 && styles.focusBody]}>{line}</Text>)}
    <View style={styles.actions}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded }} onPress={() => setExpanded(!expanded)} style={styles.button}>
        <Text style={styles.action}>{expanded ? '收起经过' : '展开经过'}</Text>
      </Pressable>
      <Pressable accessibilityRole="button" onPress={() => void copy()} style={styles.button}><Text style={styles.action}>复制诊断</Text></Pressable>
    </View>
    {copyNotice ? <Text accessibilityLiveRegion="polite" style={styles.meta}>{copyNotice}</Text> : null}
    {expanded ? <View style={styles.details}>
      {presentation.details.map((line, index) => <Text key={index} selectable style={styles.meta}>{line}</Text>)}
      {children}
    </View> : null}
  </View>;
}

export function ChatReplyDiagnosticModal({ entry, onClose }: { entry: ChatReplyDiagnosticEntry | null; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  return <Modal transparent visible={entry !== null} animationType="fade" onRequestClose={onClose}>
    <View style={[styles.overlay, { paddingTop: insets.top + 20, paddingBottom: insets.bottom + 20 }]}>
      <View style={styles.panel}>
        <View style={styles.heading}><Text style={styles.title}>本次回复诊断</Text><Pressable accessibilityRole="button" onPress={onClose} style={styles.button}><Text style={styles.action}>关闭</Text></Pressable></View>
        <ScrollView>{entry ? <ChatReplyDiagnosticCard key={entry.id} entry={entry} /> : null}</ScrollView>
      </View>
    </View>
  </Modal>;
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.cardStrong, borderRadius: 16, padding: 14, gap: 7 },
  title: { color: colors.ink, fontSize: 16, fontWeight: '700', lineHeight: 23 },
  body: { color: colors.ink, fontSize: 13, lineHeight: 21 },
  focusBody: { fontWeight: '600' },
  meta: { color: colors.muted, fontSize: 12, lineHeight: 20 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  button: { paddingHorizontal: 10, paddingVertical: 11, minHeight: 44, justifyContent: 'center' },
  action: { color: '#47797C', fontSize: 13, fontWeight: '700' },
  details: { gap: 13, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#D8E5E5', paddingTop: 12 },
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'center', paddingHorizontal: 18 },
  panel: { maxHeight: '100%', borderRadius: 20, backgroundColor: colors.cream, padding: 10 },
  heading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingLeft: 10 },
});
