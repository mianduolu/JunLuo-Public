import { useEffect, useRef, useState } from 'react';
import { Alert, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppText as Text, AppTextInput as TextInput } from '../components/AppText';
import {
  fetchVocabulary, loadVocabularyDraft, normalizeVocabulary, saveVocabulary,
  vocabularyBackendUrl, vocabularyStatus,
} from './voiceCallVocabulary';

type Props = { visible: boolean; onClose: () => void };

export function VoiceCallVocabularyPanel({ visible, onClose }: Props) {
  const insets = useSafeAreaInsets();
  const [text, setText] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const saving = useRef(false);
  const epoch = useRef(0);

  useEffect(() => {
    if (!visible) return;
    const current = ++epoch.current;
    setBusy(true);
    setDirty(false);
    setText('');
    setBaseUrl('');
    setStatus('正在读取词表…');
    void (async () => {
      try {
        const url = await vocabularyBackendUrl();
        const draft = await loadVocabularyDraft(url);
        if (current !== epoch.current) return;
        setBaseUrl(url);
        if (draft) setText(draft.words.join('\n'));
        const remote = await fetchVocabulary(url);
        if (current !== epoch.current) return;
        if (draft?.pending) {
          setStatus('待同步 · 手机已保存的修改尚未确认');
        } else {
          setText(remote.words.join('\n'));
          setStatus(vocabularyStatus(remote));
        }
      } catch (error) {
        if (current === epoch.current) setStatus(`尚未确认后端词表。${error instanceof Error ? error.message : '读取失败。'}`);
      } finally {
        if (current === epoch.current) setBusy(false);
      }
    })();
    return () => { ++epoch.current; };
  }, [visible]);

  async function save() {
    if (saving.current || busy) return;
    let words: string[];
    try {
      words = normalizeVocabulary(text.split(/\r?\n/).map((word) => word.trim()).filter(Boolean));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '词表格式不正确。');
      return;
    }
    saving.current = true;
    setBusy(true);
    setStatus('正在保存并同步…');
    const current = epoch.current;
    try {
      const url = await vocabularyBackendUrl();
      if (url !== baseUrl) throw new Error('电脑后端地址已变化，请重新打开私人词表。');
      const data = await saveVocabulary(url, words);
      if (current === epoch.current) {
        setText(data.words.join('\n'));
        setDirty(false);
        setStatus(vocabularyStatus(data));
      }
    } catch (error) {
      if (current === epoch.current) {
        setStatus(`尚未同步。${error instanceof Error ? error.message : '请稍后重试。'}`);
      }
    } finally {
      saving.current = false;
      if (current === epoch.current) setBusy(false);
    }
  }

  function close() {
    if (dirty) {
      Alert.alert('词表有尚未确认的修改', '仍要关闭吗？', [
        { text: '继续编辑', style: 'cancel' }, { text: '关闭', onPress: onClose },
      ]);
    } else onClose();
  }

  async function refresh() {
    if (busy || dirty || !baseUrl) return;
    setBusy(true);
    const current = epoch.current;
    try {
      const data = await fetchVocabulary(baseUrl);
      const draft = await loadVocabularyDraft(baseUrl);
      if (current === epoch.current) {
        setText((draft?.pending ? draft.words : data.words).join('\n'));
        setStatus(draft?.pending ? '待同步 · 手机已保存的修改尚未确认' : vocabularyStatus(data));
      }
    } catch {
      if (current === epoch.current) setStatus('刷新失败，保留当前词表。');
    } finally {
      if (current === epoch.current) setBusy(false);
    }
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={close}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={[styles.page, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <View style={styles.header}>
          <Text style={styles.title}>私人词表</Text>
          <Pressable accessibilityRole="button" onPress={close} style={styles.button}>
            <Text style={styles.buttonText}>关闭</Text>
          </Pressable>
        </View>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
          <Text style={styles.label}>词条（每行一个，最多 64 个）</Text>
          <TextInput accessibilityLabel="私人词条" editable={!busy && !!baseUrl} multiline
            autoCorrect={false} autoCapitalize="none" textAlignVertical="top"
            placeholder={'云云\n白云小姐'} value={text} style={styles.editor}
            onChangeText={(value) => { setText(value); setDirty(true); setStatus('有未保存的修改'); }} />
          <Text accessibilityLiveRegion="polite" style={styles.status}>{status}</Text>
          <Pressable accessibilityRole="button" disabled={busy || dirty || !baseUrl}
            onPress={() => void refresh()} style={[styles.button, (busy || dirty || !baseUrl) && styles.disabled]}>
            <Text style={styles.buttonText}>刷新状态</Text>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy || !baseUrl }}
            disabled={busy || !baseUrl} onPress={() => void save()}
            style={[styles.save, (busy || !baseUrl) && styles.disabled]}>
            <Text style={styles.saveText}>{busy ? '处理中…' : '保存并同步'}</Text>
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#f7faf9' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16, gap: 12 },
  title: { fontSize: 22, color: '#243d36', flexShrink: 1, fontWeight: '600' },
  content: { padding: 16, gap: 16 },
  label: { color: '#37564b', fontSize: 16 },
  editor: { minHeight: 240, maxHeight: 400, borderWidth: 1, borderColor: '#9fb8ae', borderRadius: 8,
    padding: 12, backgroundColor: '#ffffff', color: '#243d36', fontSize: 18, lineHeight: 28 },
  status: { color: '#535f65', fontSize: 15, lineHeight: 23 },
  button: { padding: 12, minHeight: 44 },
  buttonText: { fontSize: 16, color: '#37564b' },
  save: { alignSelf: 'flex-start', paddingVertical: 12, paddingHorizontal: 20, backgroundColor: '#376b59', borderRadius: 8 },
  saveText: { fontSize: 16, color: '#ffffff' },
  disabled: { opacity: 0.5 },
});
