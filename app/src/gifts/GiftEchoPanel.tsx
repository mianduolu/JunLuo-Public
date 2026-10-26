import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, View } from 'react-native';
import { randomUUID } from 'expo-crypto';
import { AppText as Text, AppTextInput as TextInput } from '../components/AppText';
import { captureBackupRestoreDataEpoch, canCommitBackupRestoreDataEpoch, subscribeBackupRestoreRuntimeState } from '../backup/backupRestoreCoordinator';
import { captureGiftWork } from './giftStore';
import { adoptGiftUnderstandingEchoes, appendGiftYouEcho, loadGiftEchoThread } from './giftEchoStore';
import { subscribeGiftChanges, emitGiftChanges } from './giftEvents';
import { giftDate, giftErrorText } from './giftPresentation';
import { giftStyles as s } from './giftStyles';
import type { GiftEchoThread, GiftVersion } from './giftTypes';

export function GiftEchoPanel({ gift, onGuardChange }: {
  gift: GiftVersion; onGuardChange?: (guard: (() => Promise<boolean>) | null) => void;
}) {
  const [thread, setThread] = useState<GiftEchoThread | null>(null), [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [requesting, setRequesting] = useState(false);
  const [error, setError] = useState('');
  const alive = useRef(true), serial = useRef(0), lock = useRef(false), requestingRef = useRef(false);
  const epoch = useRef(captureBackupRestoreDataEpoch()).current;
  const draftRef = useRef(draft); draftRef.current = draft;
  const attempt = useRef<{ id: string; content: string; createdAt: number } | null>(null);
  const current = () => alive.current && canCommitBackupRestoreDataEpoch(epoch);
  const refresh = async () => {
    const read = ++serial.current;
    try {
      const token = await captureGiftWork(gift.id);
      if (!current() || !token || token.revision !== gift.revision || token.dataEpoch !== epoch) return;
      await adoptGiftUnderstandingEchoes(token);
      const next = await loadGiftEchoThread(gift, 'you');
      if (current() && read === serial.current && next.token.dataEpoch === epoch) setThread(next);
    } catch (cause) { if (current() && read === serial.current) setError(giftErrorText(cause)); }
    finally { if (current() && read === serial.current) setLoading(false); }
  };
  useEffect(() => {
    alive.current = true; void refresh();
    const gifts = subscribeGiftChanges(() => { if (current()) void refresh(); });
    const restore = subscribeBackupRestoreRuntimeState(state => {
      if (state.status !== 'ready') { serial.current++; setThread(null); setDraft(''); attempt.current = null; setBusy(false); setError(''); }
    });
    return () => { alive.current = false; serial.current++; gifts(); restore(); };
  }, [gift.id, gift.revision]);
  useEffect(() => {
    onGuardChange?.(async () => {
      if (lock.current) return false;
      if (!draftRef.current.trim()) return true;
      return new Promise<boolean>(resolve => Alert.alert('放下未发送的回音？', '内容还没有发送。', [
        { text: '继续写', style: 'cancel', onPress: () => resolve(false) },
        { text: '放下', style: 'destructive', onPress: () => { if (current()) { setDraft(''); attempt.current = null; } resolve(true); } },
      ], { cancelable: true, onDismiss: () => resolve(false) }));
    });
    return () => onGuardChange?.(null);
  }, [onGuardChange]);
  const requestReply = () => {
    if (requestingRef.current || !current()) return;
    requestingRef.current = true; setRequesting(true); setError('');
    void import('./giftEchoRuntime').then(runtime => runtime.runGiftEchoReplies({ giftId: gift.id, manual: true }))
      .catch(() => { if (current()) setError('回音已保存，回应暂未完成，可以重试。'); })
      .finally(() => { requestingRef.current = false; if (current()) { setRequesting(false); void refresh(); } });
  };
  const send = async () => {
    if (lock.current || !current() || !thread || !draft.trim()) return;
    lock.current = true; setBusy(true); setError('');
    const input = attempt.current?.content === draft ? attempt.current : { id: randomUUID(), content: draft, createdAt: Date.now() };
    attempt.current = input;
    try {
      const saved = await appendGiftYouEcho(thread.token, input);
      if (!current()) return;
      setDraft(''); draftRef.current = ''; attempt.current = null;
      setThread(previous => previous ? { ...previous,
        messages: [...previous.messages.filter(item => item.id !== saved.id), saved].sort((a, b) => a.sequence - b.sequence),
        pendingYouIds: [...new Set([...previous.pendingYouIds, saved.id])] } : previous);
      emitGiftChanges(); requestReply();
    } catch (cause) { if (current()) setError(giftErrorText(cause)); }
    finally { lock.current = false; if (current()) setBusy(false); }
  };
  return <View style={s.section}>
    <Text style={s.ink}>回音</Text>
    {loading && <ActivityIndicator accessibilityLabel="正在读取回音" color="#697184" />}
    {!loading && thread && !thread.messages.length && <Text style={s.muted}>还没有回音。</Text>}
    {thread?.messages.map(item => <View key={item.id} style={[s.echoMessage, item.subject === 'you' ? s.echoYou : s.echoI]}>
      <Text style={s.muted}>{item.subject === 'you' ? '我' : '白云小姐'} · {giftDate(item.createdAt)}</Text>
      <Text selectable style={s.ink}>{item.content}</Text>
      {thread.pendingYouIds.includes(item.id) && <Text style={s.muted}>等待回应</Text>}
    </View>)}
    {!!thread && <>
      <TextInput accessibilityLabel="礼物回音" value={draft} editable={!busy} multiline placeholder="继续聊聊这份礼物"
        style={[s.input, s.note]} onChangeText={value => { setDraft(value); if (attempt.current?.content !== value) attempt.current = null; }} />
      <View style={s.row}>
        <Pressable accessibilityRole="button" disabled={busy || !draft.trim()} style={[s.button, s.primary, (busy || !draft.trim()) && s.disabled]}
          onPress={() => { void send(); }}><Text style={s.ink}>发送回音</Text></Pressable>
        {!!thread.pendingYouIds.length && <Pressable accessibilityRole="button" disabled={busy || requesting}
          style={[s.button, (busy || requesting) && s.disabled]} onPress={requestReply}><Text style={s.ink}>重试回应</Text></Pressable>}
      </View>
    </>}
    {!!error && <Text accessibilityRole="alert" style={s.error}>{error}</Text>}
    {!thread && !loading && <Pressable accessibilityRole="button" style={s.button} onPress={() => { setError(''); setLoading(true); void refresh(); }}><Text style={s.link}>重新读取回音</Text></Pressable>}
  </View>;
}
