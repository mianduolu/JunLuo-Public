import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Image, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { AppText as Text, AppTextInput as TextInput } from '../components/AppText';
import { DateTimePickerSheet } from '../components/DateTimePickerSheet';
import { dateKeyFromTimestamp, clockFromTimestamp, combineDateTime, type DateTimeSelection } from '../schedule/dateTimeSelection';
import { captureBackupRestoreDataEpoch, canCommitBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { deleteGiftDraft, recordGiftDelivery, saveGiftDraft, scheduleGiftDelivery } from './giftStore';
import { giftOriginalUri } from './giftFiles';
import { giftDate, giftDraftContents, giftErrorText, giftKindLabel } from './giftPresentation';
import { GiftIcon } from './GiftIcon';
import { giftStyles as s } from './giftStyles';
import type { GiftDraftContents, GiftFileKind, GiftFileSource, GiftRecord } from './giftTypes';

export function GiftEditor({ gift, newDraft, onClose, onSaved }: {
  gift: GiftRecord; newDraft: boolean; onClose: () => void; onSaved: (gift: GiftRecord, notice?: string) => void;
}) {
  const [form, setForm] = useState<GiftDraftContents>(() => giftDraftContents(gift));
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [picker, setPicker] = useState<'date' | 'time' | null>(null);
  const live = useRef(true);
  const active = useRef(false);
  const version = useRef(gift);
  const savedOnce = useRef(false);
  const epoch = useRef(captureBackupRestoreDataEpoch()).current;
  const cacheFiles = useRef(new Set<string>());
  const pendingSave = useRef<Promise<unknown> | null>(null);
  const current = () => live.current && canCommitBackupRestoreDataEpoch(epoch);
  const cleanup = async (uris = [...cacheFiles.current]) => {
    for (const uri of uris) {
      const cache = FileSystem.cacheDirectory;
      if (!cache || !uri.startsWith(cache) || /(?:^|\/)\.\.(?:\/|$)/.test(uri)) continue;
      try {
        const info = await FileSystem.getInfoAsync(uri);
        if (info.exists && !info.isDirectory) await FileSystem.deleteAsync(uri, { idempotent: true });
      } catch { /* The picker cache is separate from the saved original. */ }
    }
  };
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      const pending = pendingSave.current;
      if (pending) void pending.then(() => cleanup(), () => cleanup());
      else void cleanup();
    };
  }, []);
  const update = (next: Partial<GiftDraftContents>) => { if (!active.current) { setForm(value => ({ ...value, ...next })); setError(''); } };
  const close = async () => {
    if (active.current || !current()) return;
    active.current = true; setBusy(true);
    try {
      if (newDraft && !savedOnce.current) await deleteGiftDraft(version.current);
      if (current()) onClose();
    } catch (cause) { if (current()) setError(giftErrorText(cause)); }
    finally { active.current = false; if (current()) setBusy(false); }
  };
  const requestClose = () => {
    if (active.current) return;
    if (JSON.stringify(form) !== JSON.stringify(giftDraftContents(version.current)) || url.trim()) {
      Alert.alert('保存这次准备？', '可以先存成草稿，之后继续准备。', [
        { text: '继续准备', style: 'cancel' },
        { text: '不保存', style: 'destructive', onPress: () => { void close(); } },
        { text: '保存草稿', onPress: () => { void save(false); } },
      ]);
    } else void close();
  };
  const pick = async (kind: GiftFileKind | 'cover') => {
    if (active.current || !current()) return;
    active.current = true; setBusy(true); setError('');
    try {
      const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true,
        multiple: kind !== 'cover', type: kind === 'cover' || kind === 'image' ? 'image/*' : kind === 'audio' ? 'audio/*' : ['text/html', 'application/xhtml+xml'] });
      if (result.canceled) return;
      const files: GiftFileSource[] = result.assets.map(asset => {
        const extension = asset.name.split('.').pop()?.toLowerCase() ?? '';
        const known: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
          webp: 'image/webp', gif: 'image/gif', wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', html: 'text/html', htm: 'text/html' };
        return { uri: asset.uri, name: asset.name, mimeType: asset.mimeType && asset.mimeType !== 'application/octet-stream'
          ? asset.mimeType : known[extension] ?? (kind === 'html' ? 'text/html' : 'application/octet-stream') };
      });
      if (!files.length) return;
      files.forEach(file => cacheFiles.current.add(file.uri));
      if (!current()) { await cleanup(files.map(file => file.uri)); return; }
      setForm(value => kind === 'cover' ? { ...value, cover: { file: files[0] } }
        : { ...value, attachments: [...value.attachments, ...files.map(file => ({ kind, file }))] });
    } catch (cause) { if (current()) setError(giftErrorText(cause)); }
    finally { active.current = false; if (current()) setBusy(false); }
  };
  const addUrl = () => {
    try {
      if (!['http:', 'https:'].includes(new URL(url.trim()).protocol)) throw new Error('gift-invalid-url');
      update({ attachments: [...form.attachments, { kind: 'url', url: url.trim() }] }); setUrl('');
    } catch { setError('请填写完整的 http 或 https 网页地址。'); }
  };
  const move = (index: number, delta: number) => {
    const next = [...form.attachments], target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]]; update({ attachments: next });
  };
  async function save(send: boolean, schedule = false) {
    if (active.current || !current()) return;
    if (url.trim()) { setError('请先把网页链接放入礼物，或清空地址。'); return; }
    active.current = true; setBusy(true); setError('');
    try {
      const pending = saveGiftDraft(version.current, form);
      pendingSave.current = pending;
      const result = await pending;
      version.current = result.gift; savedOnce.current = true;
      if (!current()) return;
      setForm(giftDraftContents(result.gift));
      const next = send ? await recordGiftDelivery(result.gift)
        : schedule ? await scheduleGiftDelivery(result.gift) : result.gift;
      if (send) void import('./giftReceptionRuntime').then(module => module.runGiftReceptionTick()).catch(() => undefined);
      if (current()) onSaved(next, result.collection.failed ? '礼物已保存，部分旧原件稍后再清理。' : undefined);
    } catch (cause) { if (current()) setError(giftErrorText(cause)); }
    finally { pendingSave.current = null; active.current = false; if (current()) setBusy(false); }
  }
  const at = form.deliveryPlan?.at ?? Date.now();
  const selection: DateTimeSelection = { date: dateKeyFromTimestamp(at), time: clockFromTimestamp(at),
    recurrence: 'none', reminderChoice: 'none', reminderClock: '09:00', reminderIntensity: 'gentle' };
  const cover = form.cover && ('file' in form.cover ? form.cover.file.uri
    : [...(version.current.cover ? [version.current.cover] : []),
      ...version.current.attachments.flatMap(item => item.kind === 'url' ? [] : [item.original])]
      .find(original => original.id === (form.cover && 'existingOriginalId' in form.cover ? form.cover.existingOriginalId : '')));
  const coverUri = typeof cover === 'string' ? cover : cover ? giftOriginalUri(cover) : null;
  return <Modal visible animationType="slide" onRequestClose={requestClose}>
    <SafeAreaView style={s.sheet}>
      <View style={s.sheetHeader}>
        <Pressable accessibilityRole="button" accessibilityLabel="返回礼物柜" style={s.smallButton} onPress={requestClose}><Text style={s.link}>‹ 返回</Text></Pressable>
        <Text style={s.sheetTitle}>准备礼物</Text>
        <View style={{ width: 52 }} />
      </View>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
          <Text style={s.muted}>本机保存</Text>
          <Text style={s.label}>名字</Text>
          <TextInput accessibilityLabel="礼物名字" editable={!busy} value={form.title} onChangeText={title => update({ title })} placeholder="给这份礼物起个名字" style={s.input} />
          <Text style={s.label}>赠送留言</Text>
          <TextInput accessibilityLabel="赠送留言" editable={!busy} multiline value={form.note} onChangeText={note => update({ note })} placeholder="想在她打开时说的话" style={[s.input, s.note]} />
          <Text style={s.label}>包装封面</Text>
          <View style={[s.cover, { backgroundColor: '#E5F2FF' }]}>
            {coverUri ? <Image accessibilityLabel="已选包装封面" source={{ uri: coverUri }} style={s.image} resizeMode="cover" /> : <GiftIcon size={38} />}
          </View>
          <View style={s.row}>
            <Pressable disabled={busy} accessibilityRole="button" style={s.button} onPress={() => { void pick('cover'); }}><Text style={s.ink}>选择封面</Text></Pressable>
            {form.cover && <Pressable disabled={busy} accessibilityRole="button" style={s.smallButton} onPress={() => update({ cover: null })}><Text style={s.link}>用礼物图标</Text></Pressable>}
          </View>
          <Text style={s.label}>礼物里的原件</Text>
          {form.attachments.map((item, index) => {
            const existing = 'existingId' in item ? version.current.attachments.find(value => value.id === item.existingId) : null;
            const kind = existing?.kind ?? ('kind' in item ? item.kind : 'image');
            const name = existing ? existing.kind === 'url' ? existing.url : existing.original.originalName
              : 'file' in item ? item.file.name : 'url' in item ? item.url : '';
            return <View key={'existingId' in item ? item.existingId : String(index) + name} style={s.attachment}>
              <Text style={s.muted}>{giftKindLabel(kind)} · {index + 1}</Text>
              <Text style={s.ink}>{name}</Text>
              <View style={s.row}>
                <Pressable accessibilityRole="button" accessibilityLabel={'上移第' + (index + 1) + '个原件'} disabled={busy || index === 0} style={[s.smallButton, (busy || index === 0) && s.disabled]} onPress={() => move(index, -1)}><Text style={s.link}>↑ 上移</Text></Pressable>
                <Pressable accessibilityRole="button" accessibilityLabel={'下移第' + (index + 1) + '个原件'} disabled={busy || index === form.attachments.length - 1} style={[s.smallButton, (busy || index === form.attachments.length - 1) && s.disabled]} onPress={() => move(index, 1)}><Text style={s.link}>↓ 下移</Text></Pressable>
                <Pressable accessibilityRole="button" accessibilityLabel={'移除第' + (index + 1) + '个原件'} disabled={busy} style={s.smallButton} onPress={() => update({ attachments: form.attachments.filter((_, position) => position !== index) })}><Text style={s.link}>移除</Text></Pressable>
              </View>
            </View>;
          })}
          <View style={s.row}>{(['image', 'audio', 'html'] as const).map(kind => <Pressable key={kind} accessibilityRole="button" disabled={busy} style={s.button} onPress={() => { void pick(kind); }}><Text style={s.ink}>＋ {giftKindLabel(kind)}</Text></Pressable>)}</View>
          <Text style={s.label}>网页链接</Text>
          <TextInput accessibilityLabel="网页地址" editable={!busy} value={url} onChangeText={setUrl} placeholder="https://" autoCapitalize="none" keyboardType="url" style={s.input} />
          <Pressable accessibilityRole="button" disabled={busy || !url.trim()} style={[s.button, { marginTop: 8 }]} onPress={addUrl}><Text style={s.ink}>放入网页链接</Text></Pressable>
          <Text style={s.label}>准备的赠送时间</Text>
          <View style={s.row}>
            <Pressable accessibilityRole="button" disabled={busy} style={s.button} onPress={() => setPicker('date')}><Text style={s.ink}>{form.deliveryPlan ? dateKeyFromTimestamp(at) : '选择日期'}</Text></Pressable>
            <Pressable accessibilityRole="button" disabled={busy} style={s.button} onPress={() => setPicker('time')}><Text style={s.ink}>{form.deliveryPlan ? clockFromTimestamp(at) : '选择时间'}</Text></Pressable>
            {form.deliveryPlan && <Pressable accessibilityRole="button" disabled={busy} style={s.smallButton} onPress={() => update({ deliveryPlan: null })}><Text style={s.link}>清除</Text></Pressable>}
          </View>
          {form.deliveryPlan && <Text style={s.info}>{giftDate(form.deliveryPlan.at)} · 保存草稿会记下时间；安排赠送后才会定时送达。</Text>}
          {!!error && <Text accessibilityRole="alert" style={s.error}>{error}</Text>}
          {busy && <ActivityIndicator accessibilityLabel="正在保存或选择原件" color="#697184" />}
          <View style={[s.row, { marginTop: 22, marginBottom: 18 }]}>
            <Pressable accessibilityRole="button" disabled={busy} style={[s.button, { flex: 1 }, busy && s.disabled]} onPress={() => { void save(false); }}><Text style={s.ink}>保存草稿</Text></Pressable>
            <Pressable accessibilityRole="button" disabled={busy || !form.title.trim() || !form.attachments.length} style={[s.button, s.primary, { flex: 1 }, (busy || !form.title.trim() || !form.attachments.length) && s.disabled]} onPress={() => { void save(true); }}><Text style={s.ink}>现在赠送</Text></Pressable>
          </View>
          <Pressable accessibilityRole="button" disabled={busy || !form.deliveryPlan || !form.title.trim() || !form.attachments.length}
            style={[s.button, (busy || !form.deliveryPlan || !form.title.trim() || !form.attachments.length) && s.disabled]}
            onPress={() => { void save(false, true); }}><Text style={s.ink}>安排赠送</Text></Pressable>
          <Text style={s.info}>错过计划时间会在后续运行机会补送；接收状态会在处理后更新。</Text>
        </ScrollView>
      </KeyboardAvoidingView>
      {picker && <DateTimePickerSheet visible dateOnly={picker === 'date'} timeOnly={picker === 'time'} title={picker === 'date' ? '准备赠送的日期' : '准备赠送的时间'}
        value={selection} onClose={() => setPicker(null)} onConfirm={value => {
          if (value) update({ deliveryPlan: { at: combineDateTime(value.date, value.time ?? '09:00'), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } });
          setPicker(null);
        }} />}
    </SafeAreaView>
  </Modal>;
}
