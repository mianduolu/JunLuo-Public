import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { AppText as Text, AppTextInput as TextInput } from '../components/AppText';
import { captureBackupRestoreDataEpoch, canCommitBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { appendGiftAttachments } from './giftStore';
import { giftErrorText, giftKindLabel } from './giftPresentation';
import { giftStyles as s } from './giftStyles';
import type { GiftFileKind, GiftRecord, GiftSupplementAttachmentInput } from './giftTypes';

export function GiftSupplementEditor({ gift, onClose, onSaved }: {
  gift: GiftRecord; onClose: () => void; onSaved: (gift: GiftRecord) => void;
}) {
  const [items, setItems] = useState<GiftSupplementAttachmentInput[]>([]), [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const live = useRef(true), active = useRef(false), cacheFiles = useRef(new Set<string>());
  const pendingSave = useRef<Promise<unknown> | null>(null);
  const epoch = useRef(captureBackupRestoreDataEpoch()).current;
  const current = () => live.current && canCommitBackupRestoreDataEpoch(epoch);
  const cleanup = async () => {
    for (const uri of cacheFiles.current) {
      const cache = FileSystem.cacheDirectory;
      if (!cache || !uri.startsWith(cache) || /(?:^|\/)\.\.(?:\/|$)/.test(uri)) continue;
      try { await FileSystem.deleteAsync(uri, { idempotent: true }); } catch { /* Picker cache only. */ }
    }
  };
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      const pending = pendingSave.current;
      if (pending) void pending.then(cleanup, cleanup); else void cleanup();
    };
  }, []);
  const close = () => {
    if (active.current || !current()) return;
    if (items.length || url.trim()) Alert.alert('放弃这次补充？', '还没保存的附件不会加入礼物。', [
      { text: '继续补充', style: 'cancel' }, { text: '放弃', style: 'destructive', onPress: onClose },
    ]);
    else onClose();
  };
  const pick = async (kind: GiftFileKind) => {
    if (active.current || !current()) return;
    active.current = true; setBusy(true); setError('');
    try {
      const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: true,
        type: kind === 'image' ? 'image/*' : kind === 'audio' ? 'audio/*' : ['text/html', 'application/xhtml+xml'] });
      if (result.canceled) return;
      const additions = result.assets.map(asset => {
        cacheFiles.current.add(asset.uri);
        const known: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
          webp: 'image/webp', gif: 'image/gif', wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', html: 'text/html', htm: 'text/html' };
        return { kind, file: { uri: asset.uri, name: asset.name,
          mimeType: asset.mimeType && asset.mimeType !== 'application/octet-stream' ? asset.mimeType
            : known[asset.name.split('.').pop()?.toLowerCase() ?? ''] ?? (kind === 'html' ? 'text/html' : 'application/octet-stream') } };
      });
      if (current()) setItems(value => [...value, ...additions]); else await cleanup();
    } catch (cause) { if (current()) setError(giftErrorText(cause)); }
    finally { active.current = false; if (current()) setBusy(false); }
  };
  const addUrl = () => {
    if (active.current || !current()) return;
    try {
      const value = url.trim();
      if (!['http:', 'https:'].includes(new URL(value).protocol)) throw Error('gift-invalid-url');
      setItems(previous => [...previous, { kind: 'url', url: value }]); setUrl(''); setError('');
    } catch { setError('请填写完整的 http 或 https 网页地址。'); }
  };
  const save = async () => {
    if (active.current || !current()) return;
    if (url.trim()) { setError('请先把网页链接加入附件，或清空地址。'); return; }
    active.current = true; setBusy(true); setError('');
    try {
      const pending = appendGiftAttachments(gift, 'you', items); pendingSave.current = pending;
      const result = await pending;
      if (current()) onSaved(result.gift);
    } catch (cause) { if (current()) setError(giftErrorText(cause)); }
    finally { pendingSave.current = null; active.current = false; if (current()) setBusy(false); }
  };
  const move = (index: number, delta: number) => {
    if (active.current) return;
    setItems(previous => {
      const next = [...previous], target = index + delta;
      if (target < 0 || target >= next.length) return previous;
      [next[index], next[target]] = [next[target], next[index]]; return next;
    });
  };
  return <Modal visible animationType="slide" onRequestClose={close}>
    <SafeAreaView style={s.sheet}>
      <View style={s.sheetHeader}>
        <Pressable accessibilityRole="button" style={s.smallButton} onPress={close}><Text style={s.link}>‹ 返回</Text></Pressable>
        <Text style={s.sheetTitle}>补充附件</Text><View style={{ width: 52 }} />
      </View>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
          <Text style={s.heading}>{gift.title}</Text>
          <Text style={s.info}>新附件会留在这份礼物里，原件和赠送留言仍保留。</Text>
          {items.map((item, index) => <View key={index} style={s.attachment}>
            <Text style={s.muted}>{index + 1} · {giftKindLabel(item.kind)}</Text>
            <Text style={s.ink}>{item.kind === 'url' ? item.url : item.file.name}</Text>
            <View style={s.row}>
            <Pressable accessibilityRole="button" accessibilityLabel={'上移第' + (index + 1) + '个补充附件'} disabled={busy || index === 0}
              style={s.smallButton} onPress={() => move(index, -1)}><Text style={s.link}>↑ 上移</Text></Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel={'下移第' + (index + 1) + '个补充附件'} disabled={busy || index === items.length - 1}
              style={s.smallButton} onPress={() => move(index, 1)}><Text style={s.link}>↓ 下移</Text></Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel={'移除第' + (index + 1) + '个补充附件'} disabled={busy}
              style={s.smallButton} onPress={() => setItems(value => value.filter((_, at) => at !== index))}><Text style={s.link}>移除</Text></Pressable>
            </View>
          </View>)}
          <View style={s.row}>{(['image', 'audio', 'html'] as const).map(kind => <Pressable key={kind} accessibilityRole="button"
            disabled={busy} style={s.button} onPress={() => { void pick(kind); }}><Text style={s.ink}>＋ {giftKindLabel(kind)}</Text></Pressable>)}</View>
          <Text style={s.label}>网页链接</Text>
          <TextInput accessibilityLabel="补充网页地址" editable={!busy} value={url} onChangeText={setUrl}
            placeholder="https://" autoCapitalize="none" keyboardType="url" style={s.input} />
          <Pressable accessibilityRole="button" disabled={busy || !url.trim()} style={s.button} onPress={addUrl}><Text style={s.ink}>加入网页链接</Text></Pressable>
          {!!error && <Text accessibilityRole="alert" style={s.error}>{error}</Text>}
          {busy && <ActivityIndicator accessibilityLabel="正在保存或选择补充附件" color="#697184" />}
          <Pressable accessibilityRole="button" disabled={busy || !items.length} style={[s.button, s.primary, (busy || !items.length) && s.disabled]}
            onPress={() => { void save(); }}><Text style={s.ink}>保存补充附件</Text></Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  </Modal>;
}
