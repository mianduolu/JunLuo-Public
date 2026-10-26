import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppText as Text, AppTextInput as TextInput } from '../components/AppText';
import { SkyBackground } from '../components/SkyBackground';
import { colors } from '../theme/colors';

function FullScreen({ title, back, onClose, children, keyboard = false }: {
  title: string; back: string; onClose: () => void; children: ReactNode; keyboard?: boolean;
}) {
  const insets = useSafeAreaInsets();
  return <Modal visible animationType="none" onRequestClose={onClose}>
    <SkyBackground><KeyboardAvoidingView enabled={keyboard} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={[styles.root, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 12,
        paddingLeft: insets.left + 18, paddingRight: insets.right + 18 }]}>
      <View style={styles.header}><Text accessibilityRole="header" style={styles.heading}>{title}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel={back} onPress={onClose} style={styles.back}>
          <Text style={styles.body}>{back}</Text></Pressable></View>
      {children}
    </KeyboardAvoidingView></SkyBackground>
  </Modal>;
}
export type TheaterFocusText = { content: string; speaker: string; preview?: boolean };
export function TheaterFocusReader({ text, onClose }: { text: TheaterFocusText; onClose: () => void }) {
  return <FullScreen title="专心阅读" back="返回" onClose={onClose}>
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={styles.label}>{text.speaker}</Text>
      {text.preview && <Text style={styles.label}>仅预览</Text>}
      <Text selectable style={styles.body}>{text.content}</Text>
    </ScrollView>
  </FullScreen>;
}
export function TheaterFullScreenEditor({ title, value, disabled, onChange, onClose }: {
  title: string; value: string; disabled: boolean; onChange: (value: string) => void; onClose: () => void;
}) {
  return <FullScreen title={title} back="返回设定" onClose={onClose} keyboard>
    <TextInput accessibilityLabel={title} value={value} onChangeText={onChange} editable={!disabled}
      multiline textAlignVertical="top" autoFocus style={[styles.body, styles.input]} />
  </FullScreen>;
}
const styles = StyleSheet.create({ root: { flex: 1, gap: 12 }, header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  heading: { color: colors.ink, fontSize: 20, fontWeight: '600' }, back: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 12 },
  content: { gap: 12, paddingBottom: 24 }, body: { color: colors.ink, fontSize: 15, lineHeight: 23 },
  label: { color: colors.muted, fontSize: 13 }, input: { flex: 1, padding: 12, borderRadius: 12, backgroundColor: colors.card },
});
