import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { AppText as Text, AppTextInput as TextInput } from '../components/AppText';
import { canCommitBackupRestoreDataEpoch, captureBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { changeFocusTag, loadFocusTags } from './focusTagStore';
import type { FocusTag, FocusTagSnapshot } from './focusReviewData';

export function FocusTagPicker({ categoryId, selected, onSelect }: {
  categoryId: string; selected?: FocusTagSnapshot; onSelect: (tag: FocusTagSnapshot | undefined) => void;
}) {
  const [tags, setTags] = useState<FocusTag[]>([]);
  const [label, setLabel] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const live = useRef(false);
  const locked = useRef(false);
  const readEpoch = useRef<number | null>(null);
  const currentCategory = useRef(categoryId);
  currentCategory.current = categoryId;
  const read = async () => {
    const epoch = captureBackupRestoreDataEpoch();
    try {
      const value = await loadFocusTags();
      if (!live.current || !canCommitBackupRestoreDataEpoch(epoch)) return;
      readEpoch.current = epoch; setTags(value); setNotice('');
    } catch { if (live.current) setNotice('标签暂未读取成功，请重试。'); }
  };
  useEffect(() => { live.current = true; void read(); return () => { live.current = false; }; }, []);
  const change = async (input: { label: string } | { deleteId: string }) => {
    if (locked.current) return;
    const epoch = readEpoch.current;
    if (!canCommitBackupRestoreDataEpoch(epoch)) { setNotice('标签已变化，请重新读取。'); return; }
    locked.current = true; setBusy(true);
    try {
      const result = await changeFocusTag(categoryId, input, epoch);
      if (!live.current || !canCommitBackupRestoreDataEpoch(epoch)) return;
      setTags(result.tags); setNotice('');
      if (currentCategory.current === categoryId) {
        if ('label' in input) { onSelect(result.selected ?? undefined); setLabel(''); }
        else if (input.deleteId === selected?.id) onSelect(undefined);
      }
    } catch { if (live.current) setNotice('标签暂未保存，请重试。'); }
    finally { locked.current = false; if (live.current) setBusy(false); }
  };
  return <View style={styles.root}>
    <Text style={styles.label}>常做的事情</Text>
    <View style={styles.tags}>{tags.filter(tag => tag.categoryId === categoryId).map(tag => <View key={tag.id}
      style={[styles.chip, selected?.id === tag.id && styles.selected]}>
      <Pressable accessibilityRole="button" accessibilityState={{ selected: selected?.id === tag.id }} disabled={busy}
        onPress={() => {
          if (canCommitBackupRestoreDataEpoch(readEpoch.current)) onSelect(selected?.id === tag.id ? undefined : tag);
          else setNotice('标签已变化，请重新读取。');
        }} style={styles.pick}><Text style={styles.text}>{tag.label}</Text></Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel={`删除常用标签${tag.label}`} disabled={busy}
        onPress={() => void change({ deleteId: tag.id })} style={styles.remove}><Text style={styles.removeText}>×</Text></Pressable>
    </View>)}</View>
    <View style={styles.add}>
      <TextInput value={label} onChangeText={value => { if (!locked.current) setLabel(value); }} maxLength={32} placeholder="常做的事情" editable={!busy}
        onSubmitEditing={() => { if (label.trim()) void change({ label }); }} style={styles.input}
        placeholderTextColor="#8A9BA7" underlineColorAndroid="transparent" />
      <Pressable accessibilityRole="button" disabled={busy || !label.trim()} onPress={() => void change({ label })}
        style={[styles.save, !label.trim() && { opacity: 0.5 }]}><Text style={styles.text}>保存为标签</Text></Pressable>
    </View>
    {selected ? <Text style={styles.selection}>{selected.label} · 再点一次取消</Text> : null}
    {notice ? <Pressable accessibilityRole="button" onPress={() => void read()}><Text style={styles.notice}>{notice}</Text></Pressable> : null}
  </View>;
}
const styles = StyleSheet.create({
  root: { marginTop: 14, marginBottom: 10 }, label: { color: '#8A9BA7', fontSize: 13, marginBottom: 10 },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { flexDirection: 'row', backgroundColor: '#E8F0F6', borderRadius: 12, maxWidth: '100%' },
  selected: { backgroundColor: '#B2D9FF' }, pick: { paddingLeft: 12, paddingVertical: 10, minHeight: 44, flexShrink: 1, justifyContent: 'center' },
  text: { color: '#475D70', fontSize: 13, fontWeight: '400' }, remove: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  removeText: { color: '#8A9BA7', fontSize: 18 }, add: { flexDirection: 'row', gap: 8, marginTop: 12, alignItems: 'center' },
  input: { flex: 1, minWidth: 0, backgroundColor: '#FDFDFC', borderWidth: StyleSheet.hairlineWidth, borderColor: '#D7E2E9', borderRadius: 12, padding: 12, color: '#475D70', fontSize: 14 },
  save: { backgroundColor: '#B2D9FF', borderRadius: 12, minHeight: 44, paddingHorizontal: 10, justifyContent: 'center' },
  selection: { color: '#527C9D', fontSize: 12, lineHeight: 20, marginTop: 8 }, notice: { color: '#527C9D', fontSize: 12, lineHeight: 20, marginTop: 8 },
});
