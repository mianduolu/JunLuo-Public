import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Image, Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AppText as Text } from '../components/AppText';
import { colors } from '../theme/colors';
import type { PhoneLaunchableAppEntry } from '../backend/phoneActivityNative';
import type { AppLaunchPicker } from '../tools/appLaunchChatHost';
import { appLaunchEntryKey } from '../tools/chatAppLaunch';

type Pending = { entries: PhoneLaunchableAppEntry[]; ask: boolean };
export function useChatAppLaunchController(active: boolean) {
  const activeRef = useRef(active);
  activeRef.current = active;
  const [pending, setPending] = useState<Pending | null>(null);
  const finishRef = useRef<((entry: PhoneLaunchableAppEntry | null) => void) | null>(null);
  const close = useCallback((entry: PhoneLaunchableAppEntry | null = null) => finishRef.current?.(entry), []);
  const pick: AppLaunchPicker = useCallback((request, signal) => new Promise(resolve => {
    close();
    if (signal.aborted || !activeRef.current || AppState.currentState !== 'active') { resolve(null); return; }
    const finish = (entry: PhoneLaunchableAppEntry | null) => {
      if (finishRef.current !== finish) return;
      finishRef.current = null;
      signal.removeEventListener('abort', abort);
      setPending(null);
      resolve(entry);
    };
    const abort = () => finish(null);
    finishRef.current = finish;
    signal.addEventListener('abort', abort, { once: true });
    setPending(request);
  }), [close]);
  useEffect(() => { if (!active) close(); }, [active, close]);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => { if (state !== 'active') close(); });
    return () => { subscription.remove(); close(); };
  }, [close]);
  return { pending, pick, isActive: () => activeRef.current, choose: (entry: PhoneLaunchableAppEntry) => close(entry), cancel: () => close() };
}

export function ChatAppLaunchPicker({ controller }: { controller: ReturnType<typeof useChatAppLaunchController> }) {
  const pending = controller.pending;
  return <Modal transparent visible={!!pending} animationType="fade" onRequestClose={controller.cancel}>
    <SafeAreaView style={styles.shade}>
      <View style={styles.panel}>
        <Text style={styles.title}>{pending?.ask ? '选择并允许本次打开' : '选择应用'}</Text>
        <ScrollView>
          {pending?.entries.map(entry => <Pressable key={appLaunchEntryKey(entry)} accessibilityRole="button"
            style={styles.row} onPress={() => controller.choose(entry)}>
            {entry.iconUri ? <Image source={{ uri: entry.iconUri }} style={styles.icon} /> : null}
            <View style={styles.label}><Text style={styles.name}>{entry.title}</Text>
              {entry.badgeLabel ? <Text>{entry.badgeLabel}</Text> : null}</View>
          </Pressable>)}
        </ScrollView>
        <Pressable accessibilityRole="button" onPress={controller.cancel} style={styles.cancel}><Text>取消</Text></Pressable>
      </View>
    </SafeAreaView>
  </Modal>;
}
const styles = StyleSheet.create({
  shade: { flex: 1, backgroundColor: '#0007', justifyContent: 'center', padding: 24 },
  panel: { maxHeight: '75%', borderRadius: 20, backgroundColor: colors.cream, padding: 18 },
  title: { fontSize: 18, marginBottom: 14, color: colors.ink },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, gap: 12 },
  icon: { width: 44, height: 44 }, label: { flex: 1 }, name: { fontSize: 16, color: colors.ink },
  cancel: { alignItems: 'center', padding: 14 },
});
