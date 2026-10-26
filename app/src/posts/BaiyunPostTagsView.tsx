import { useRef, useState } from 'react';
import { Alert, Modal, Pressable, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AppText as Text, AppTextInput as TextInput } from '../components/AppText';
import type { PostAuthor } from './baiyunPostData';
import { createPostTag, deletePostTag, mergePostTags, PostTagNameConflictError, tagAllowsAuthor,
  updatePostTag, type PostTag } from './baiyunPostTags';
import { postStyles as s } from './baiyunPostStyles';

const scopeNames = { you: '仓鼠可用', I: '云云可用', both: '双方可用' };
export function PostTagPicker({ tags, author, selected, onChange, onClose, onCancel, disabled = false, error = '' }: {
  tags: PostTag[]; author: PostAuthor; selected: string[]; onChange: (ids: string[]) => void; onClose: () => void;
  onCancel?: () => void; disabled?: boolean; error?: string;
}) {
  const available = tags.filter(tag => tagAllowsAuthor(tag, author));
  const validSelected = selected.filter(id => available.some(tag => tag.id === id));
  return <Modal transparent animationType="fade" onRequestClose={() => { if (!disabled) (onCancel ?? onClose)(); }}>
    <View style={s.overlay}><View style={s.dialog}>
      <View style={s.row}><Text style={[s.heading, s.grow]}>选择标签</Text>{onCancel ? <Pressable disabled={disabled} onPress={onCancel} style={s.button}><Text style={s.link}>取消</Text></Pressable> : null}<Pressable disabled={disabled} onPress={onClose} style={s.button}><Text style={s.link}>{disabled ? '保存中' : '完成'}</Text></Pressable></View>
      <Text style={s.muted}>最多 3 个，也可以不选。</Text>
      {error ? <Text accessibilityRole="alert" style={s.error}>{error}</Text> : null}
      <ScrollView keyboardShouldPersistTaps="handled"><View style={s.wrap}>
        {available.map(tag => {
          const checked = validSelected.includes(tag.id), blocked = disabled || (!checked && validSelected.length >= 3);
          return <Pressable key={tag.id} accessibilityRole="checkbox" accessibilityState={{ checked, disabled: blocked }} disabled={blocked}
            style={[s.button, checked && s.selected, blocked && s.disabled]} onPress={() => onChange(checked ? validSelected.filter(id => id !== tag.id) : [...validSelected, tag.id])}>
            <Text style={s.link}>#{tag.name}</Text>
          </Pressable>;
        })}
        {!available.length ? <Text style={s.muted}>这个标签库还是空的，可以在标签管理里添加。</Text> : null}
      </View></ScrollView>
    </View></View>
  </Modal>;
}

export function PostTagManager({ tags, refresh, onClose }: { tags: PostTag[]; refresh: () => Promise<void>; onClose: () => void }) {
  const [editing, setEditing] = useState<PostTag | 'new' | null>(null);
  const [name, setName] = useState('');
  const [scope, setScope] = useState<PostTag['scope']>('you');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const mutate = async (action: () => Promise<unknown>, done = true) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try { await action(); if (done) setEditing(null); await refresh(); }
    catch (cause) {
      if (cause instanceof PostTagNameConflictError && editing && editing !== 'new') {
        const target = tags.find(tag => tag.id === cause.targetId);
        Alert.alert('合并同名标签？', `合并到“${target?.name ?? name}”后，原有动态会使用同一个标签，适用范围取两者的并集。`, [
          { text: '取消', style: 'cancel' }, { text: '合并', onPress: () => void mutate(() => mergePostTags(editing.id, cause.targetId)) },
        ]);
      } else setError(cause instanceof PostTagNameConflictError ? '已有同名标签，可以直接使用。' : '保存失败。标签名称需为 1～12 个可见字符，不能换行；请检查后重试。');
    } finally { lock.current = false; setBusy(false); }
  };
  const start = (tag: PostTag | 'new') => { setEditing(tag); setName(tag === 'new' ? '' : tag.name); setScope(tag === 'new' ? 'you' : tag.scope); setError(''); };
  const save = () => {
    if (!editing) return;
    const apply = () => void mutate(() => editing === 'new' ? createPostTag(name, scope) : updatePostTag(editing.id, name, scope));
    if (editing !== 'new' && editing.scope !== scope && scope !== 'both') {
      Alert.alert('调整适用范围？', '不再适用的一方，其旧动态上的这个标签会移除；动态本身保留。', [
        { text: '取消', style: 'cancel' }, { text: '确认', onPress: apply },
      ]);
    } else apply();
  };
  return <Modal animationType="slide" onRequestClose={() => { if (!busy) onClose(); }}>
    <SafeAreaView style={s.page}>
      <View style={s.header}><Pressable disabled={busy} style={s.button} onPress={onClose}><Text style={s.link}>返回</Text></Pressable><Text style={[s.heading, s.grow]}>标签管理</Text><Pressable disabled={busy} onPress={() => start('new')} style={s.button}><Text style={s.link}>新增</Text></Pressable></View>
      <ScrollView contentContainerStyle={s.section} keyboardShouldPersistTaps="handled">
        {editing ? <View style={{ gap: 10 }}>
          <TextInput accessibilityLabel="标签名称" value={name} onChangeText={setName} editable={!busy} style={[s.input, s.field]} placeholder="标签名称" />
          <View style={s.wrap}>{(['you', 'I', 'both'] as const).map(item => <Pressable key={item} disabled={busy} style={[s.button, scope === item && s.selected]} onPress={() => setScope(item)} accessibilityState={{ selected: scope === item }}><Text style={s.link}>{scopeNames[item]}</Text></Pressable>)}</View>
          <View style={s.row}><Pressable disabled={busy} style={s.button} onPress={() => setEditing(null)}><Text style={s.link}>取消</Text></Pressable><Pressable disabled={busy} style={[s.button, s.primary]} onPress={save}><Text style={s.primaryText}>{busy ? '保存中' : '保存'}</Text></Pressable></View>
        </View> : null}
        {error ? <Text accessibilityRole="alert" style={s.error}>{error}</Text> : null}
        {tags.map(tag => <View key={tag.id} style={[s.row, { borderBottomWidth: 1, borderBottomColor: '#DFE7EF', paddingVertical: 10 }]}>
          <View style={s.grow}><Text style={s.text}>#{tag.name}</Text><Text style={s.muted}>{scopeNames[tag.scope]}</Text></View>
          <Pressable disabled={busy} onPress={() => start(tag)} style={s.button}><Text style={s.link}>编辑</Text></Pressable>
          <Pressable disabled={busy} onPress={() => Alert.alert('删除这个标签？', '它会从所有动态上移除，动态和评论保留。', [{ text: '取消', style: 'cancel' },
            { text: '删除', style: 'destructive', onPress: () => void mutate(() => deletePostTag(tag.id), false) }])} style={s.button}><Text style={s.error}>删除</Text></Pressable>
        </View>)}
        {!tags.length ? <Text style={s.muted}>还没有标签。</Text> : null}
      </ScrollView>
    </SafeAreaView>
  </Modal>;
}
