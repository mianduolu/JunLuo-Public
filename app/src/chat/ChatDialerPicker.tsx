import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AppText as Text } from '../components/AppText';
import { colors } from '../theme/colors';
import type { DialerContactEntry } from '../backend/dialerNative';
import type { DialerPicker } from '../tools/dialerChatHost';
import { dialerEntryKey } from '../tools/chatDialer';

type Pending = { entries: DialerContactEntry[]; ask: boolean };
export function useChatDialerController(active: boolean) {
  const activeRef = useRef(active); activeRef.current = active;
  const [pending, setPending] = useState<Pending | null>(null);
  const finishRef = useRef<((entry: DialerContactEntry | null) => void) | null>(null);
  const close = useCallback((entry: DialerContactEntry | null = null) => finishRef.current?.(entry), []);
  const pick: DialerPicker = useCallback((request, signal) => new Promise(resolve => {
    close();
    if (signal.aborted || !activeRef.current || AppState.currentState !== 'active') { resolve(null); return; }
    const finish = (entry: DialerContactEntry | null) => {
      if (finishRef.current !== finish) return;
      finishRef.current = null; signal.removeEventListener('abort', abort); setPending(null); resolve(entry);
    };
    const abort = () => finish(null);
    finishRef.current = finish; signal.addEventListener('abort', abort, { once: true }); setPending(request);
  }), [close]);
  useEffect(() => { if (!active) close(); }, [active, close]);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => { if (state !== 'active') close(); });
    return () => { subscription.remove(); close(); };
  }, [close]);
  return { pending, pick, isActive: () => activeRef.current, choose: (entry: DialerContactEntry) => close(entry), cancel: () => close() };
}
export function ChatDialerPicker({ controller }: { controller: ReturnType<typeof useChatDialerController> }) {
  const pending = controller.pending;
  return <Modal transparent visible={!!pending} animationType="fade" onRequestClose={controller.cancel}>
    <SafeAreaView style={styles.shade}><View style={styles.panel}>
      <Text style={styles.title}>选择并打开拨号页</Text>
      <ScrollView>{pending?.entries.map(entry => <Pressable key={dialerEntryKey(entry)} accessibilityRole="button"
        style={styles.row} onPress={() => controller.choose(entry)}>
        <Text style={styles.name}>{entry.displayName}</Text>
        {entry.contactId ? <Text>{entry.phoneNumber}</Text> : null}
      </Pressable>)}</ScrollView>
      <Pressable accessibilityRole="button" onPress={controller.cancel} style={styles.cancel}><Text>取消</Text></Pressable>
    </View></SafeAreaView>
  </Modal>;
}
const styles = StyleSheet.create({
  shade: { flex: 1, backgroundColor: '#0007', justifyContent: 'center', padding: 24 },
  panel: { maxHeight: '75%', borderRadius: 20, backgroundColor: colors.cream, padding: 18 },
  title: { fontSize: 18, marginBottom: 14, color: colors.ink },
  row: { paddingVertical: 14, minHeight: 48, gap: 4 }, name: { fontSize: 16, color: colors.ink },
  cancel: { alignItems: 'center', padding: 14 },
});
