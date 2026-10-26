import { useEffect, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { AppText as Text, AppTextInput } from '../components/AppText';
import type { getShiyingVisualPalette } from './ShiyingFeature';
import type { ShiyingEntryV1 } from './shiyingContract';

const MAX_BODY_LENGTH = 2_000;

export function getShiyingEntryBodyValidationError(body: string) {
  const trimmed = body.trim();
  if (!trimmed) return '正文不能为空。';
  if (trimmed.length > MAX_BODY_LENGTH) return '正文超出 2000 长度限制，请缩短后保存。';
  return '';
}

export function getShiyingEntrySaveError(error: unknown) {
  const code = error instanceof Error ? error.message.split(':', 1)[0] : '';
  if (code === 'shiying_store_entry_content_conflict') {
    return '这条荧迹已更新，本次修改未保存。请取消后重新打开。';
  }
  if (code === 'shiying_store_entry_rejected') {
    return '这条荧迹已撤回，本次修改未保存。';
  }
  if (code === 'shiying_store_entry_not_found') {
    return '这条荧迹已不存在，本次修改未保存。';
  }
  if (code === 'shiying_entry_restore_changed') {
    return '备份恢复后数据已变化，本次修改未保存。请取消后重新打开。';
  }
  return '保存失败，输入仍保留，可以重试。';
}

export function ShiyingEntryEditor({ entry, visual, onCancel, onSaved, save }: {
  entry: ShiyingEntryV1;
  visual: ReturnType<typeof getShiyingVisualPalette>;
  onCancel: () => void;
  onSaved: (updated: ShiyingEntryV1) => void;
  save: (body: string) => Promise<ShiyingEntryV1>;
}) {
  const [body, setBody] = useState(entry.body);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const mountedRef = useRef(true);
  const closedRef = useRef(false);
  const busyRef = useRef(false);
  const validationError = getShiyingEntryBodyValidationError(body);

  useEffect(() => {
    mountedRef.current = true;
    closedRef.current = false;
    return () => {
      mountedRef.current = false;
      closedRef.current = true;
    };
  }, []);

  const close = () => {
    if (!mountedRef.current || closedRef.current || busyRef.current) return;
    closedRef.current = true;
    onCancel();
  };
  const submit = async () => {
    if (!mountedRef.current || closedRef.current || busyRef.current || validationError) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      const updated = await save(body.trim());
      if (!mountedRef.current || closedRef.current) return;
      closedRef.current = true;
      onSaved(updated);
    } catch (failure) {
      if (mountedRef.current && !closedRef.current) {
        setError(getShiyingEntrySaveError(failure));
      }
    } finally {
      if (mountedRef.current && !closedRef.current) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  };

  return (
    <Modal visible animationType="slide" onRequestClose={close} statusBarTranslucent navigationBarTranslucent>
      <SafeAreaProvider>
        <SafeAreaView style={[styles.root, { backgroundColor: visual.sheetSurface }]}>
          <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
            <View style={styles.content}>
              <View style={styles.header}>
                <Text style={[styles.title, { color: visual.primaryText }]}>修改荧迹</Text>
                <Text style={[styles.date, { color: visual.secondaryText }]}>{entry.lifeDate}</Text>
              </View>
              <ScrollView style={styles.root} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.inputHost}>
                <AppTextInput
                  accessibilityLabel="荧迹正文"
                  value={body}
                  multiline
                  editable={!busy}
                  textAlignVertical="top"
                  onChangeText={(next) => {
                    if (!mountedRef.current || closedRef.current || busyRef.current) return;
                    setBody(next);
                    setError('');
                  }}
                  style={[styles.input, {
                    color: visual.primaryText,
                    backgroundColor: visual.sourceCardSurface,
                    borderColor: visual.cardBorder,
                  }]}
                />
              </ScrollView>
              <Text style={[styles.hint, { color: visual.secondaryText }]}>长度 {body.trim().length} / {MAX_BODY_LENGTH}</Text>
              {error || validationError ? (
                <Text accessibilityLiveRegion="polite" style={[styles.hint, { color: visual.primaryText }]}>
                  {error || validationError}
                </Text>
              ) : null}
              <View style={styles.actions}>
                <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy }} disabled={busy}
                  onPress={close} style={[styles.button, { backgroundColor: visual.actionSurface }, busy && styles.disabled]}>
                  <Text style={[styles.buttonText, { color: visual.primaryText }]}>取消</Text>
                </Pressable>
                <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy || !!validationError, busy }}
                  disabled={busy || !!validationError} onPress={() => void submit()}
                  style={[styles.button, { backgroundColor: visual.buttonSurface }, (busy || !!validationError) && styles.disabled]}>
                  <Text style={[styles.buttonText, { color: visual.buttonText }]}>{busy ? '正在保存…' : '保存'}</Text>
                </Pressable>
              </View>
            </View>
          </KeyboardAvoidingView>
        </SafeAreaView>
      </SafeAreaProvider>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { flex: 1, width: '100%', maxWidth: 760, alignSelf: 'center', padding: 20, gap: 10 },
  header: { paddingBottom: 4, gap: 4 },
  title: { fontSize: 20, lineHeight: 30, fontWeight: '600' },
  date: { fontSize: 12, lineHeight: 20 },
  inputHost: { flexGrow: 1 },
  input: { flex: 1, minHeight: 180, padding: 16, borderWidth: 1, borderRadius: 14, fontSize: 17, lineHeight: 30 },
  hint: { fontSize: 12, lineHeight: 20 },
  actions: { flexDirection: 'row', gap: 12, paddingTop: 4 },
  button: { flex: 1, minHeight: 48, paddingVertical: 12, paddingHorizontal: 12, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  buttonText: { fontSize: 15, lineHeight: 24, fontWeight: '600' },
  disabled: { opacity: 0.45 },
});
