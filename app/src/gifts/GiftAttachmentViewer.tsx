import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, Image, Modal, Pressable, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import * as FileSystem from 'expo-file-system/legacy';
import { AppText as Text } from '../components/AppText';
import { canCommitBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { openGiftAttachment, recordGiftPlayback } from './giftAttachmentStore';
import { giftOriginalUri } from './giftFiles';
import { giftDate, giftErrorText } from './giftPresentation';
import { GiftWebReader } from './GiftWebReader';
import { giftStyles as s } from './giftStyles';
import type { GiftAttachmentAccess, GiftVersion } from './giftTypes';

export function GiftAttachmentViewer({ target, onClose }: {
  target: GiftVersion & { attachmentId: string }; onClose(): void;
}) {
  const [loaded, setLoaded] = useState<{ access: GiftAttachmentAccess; html?: string } | null>(null);
  const [error, setError] = useState('');
  const beforeClose = useRef<(() => Promise<unknown>) | null>(null), closing = useRef(false);
  const discardWeb = useRef<(() => void) | null>(null), discardDecision = useRef<((discard: boolean) => void) | null>(null);
  const mounted = useRef(true);
  const close = async () => {
    if (closing.current) return;
    closing.current = true;
    try { await beforeClose.current?.(); if (mounted.current) onClose(); }
    catch (cause) {
      if (!mounted.current) return;
      setError(giftErrorText(cause));
      if (loaded?.access.attachment.kind !== 'html') return;
      const discard = await new Promise<boolean>(resolve => {
        discardDecision.current = resolve;
        const choose = (value: boolean) => {
          if (discardDecision.current !== resolve) return;
          discardDecision.current = null; resolve(value);
        };
        Alert.alert('这次进度还没保存', '可以留在这里继续，或放弃这次未保存的进度并退出。退出后会保留上次成功保存的进度。', [
          { text: '留在这里', style: 'cancel', onPress: () => choose(false) },
          { text: '放弃这次未保存进度并退出', style: 'destructive', onPress: () => choose(true) },
        ], { cancelable: true, onDismiss: () => choose(false) });
      });
      if (discard && mounted.current) { discardWeb.current?.(); onClose(); }
    }
    finally { closing.current = false; }
  };
  useEffect(() => {
    mounted.current = true;
    let current = true;
    void (async () => {
      const access = await openGiftAttachment(target, target.attachmentId, 'you');
      const html = access.attachment.kind === 'html' ? await FileSystem.readAsStringAsync(giftOriginalUri(access.attachment.original)) : undefined;
      const latest = await openGiftAttachment(target, target.attachmentId, 'you');
      if (!canCommitBackupRestoreDataEpoch(access.token.dataEpoch)) throw Error('gift-stale-data-epoch');
      if (current) setLoaded({ access: latest, html });
    })().catch(cause => { if (current) setError(giftErrorText(cause)); });
    return () => { current = false; mounted.current = false; discardDecision.current?.(false); discardDecision.current = null; };
  }, [target.id, target.revision, target.attachmentId]);
  const attachment = loaded?.access.attachment;
  return <Modal visible animationType="slide" onRequestClose={() => { void close(); }}>
    <SafeAreaView style={s.sheet}>
      <View style={s.sheetHeader}>
        <Pressable accessibilityRole="button" accessibilityLabel="关闭礼物原件" style={s.smallButton} onPress={() => { void close(); }}><Text style={s.link}>‹ 返回</Text></Pressable>
        <Text numberOfLines={1} style={[s.sheetTitle, { flex: 1, textAlign: 'center' }]}>{attachment && attachment.kind !== 'url' ? attachment.original.originalName : '礼物原件'}</Text>
        <View style={{ width: 52 }} />
      </View>
      {!!error && <Text accessibilityRole="alert" style={[s.error, { marginHorizontal: 20 }]}>{error}</Text>}
      {!loaded && !error && <ActivityIndicator accessibilityLabel="正在读取原件" color="#697184" />}
      {loaded && attachment?.kind === 'image' && <Image accessibilityLabel="礼物大图" source={{ uri: giftOriginalUri(attachment.original) }} resizeMode="contain" style={{ flex: 1, width: '100%' }} onError={() => setError('图片暂时无法打开，原件仍保留。')} />}
      {loaded && attachment?.kind === 'audio' && <GiftAudioPlayer access={loaded.access} />}
      {loaded && attachment?.kind === 'html' && <GiftWebReader access={loaded.access} html={loaded.html!}
        onBeforeCloseChange={callback => { beforeClose.current = callback; }} onDiscardChange={callback => { discardWeb.current = callback; }} />}
    </SafeAreaView>
  </Modal>;
}

const clock = (value: number) => `${Math.floor(Math.max(0, value) / 60)}:${String(Math.floor(Math.max(0, value) % 60)).padStart(2, '0')}`;
function GiftAudioPlayer({ access }: { access: GiftAttachmentAccess }) {
  const uri = access.attachment.kind === 'audio' ? giftOriginalUri(access.attachment.original) : '';
  const player = useAudioPlayer({ uri }, { updateInterval: 300 });
  const status = useAudioPlayerStatus(player);
  const [error, setError] = useState(''), [lastPlayedAt, setLastPlayedAt] = useState(access.activity.lastPlayedAt);
  const recorded = useRef(false), live = useRef(true), busy = useRef(false);
  const recording = useRef<object | null>(null);
  const foreground = useRef(AppState.currentState !== 'background' && AppState.currentState !== 'inactive');
  const [trackWidth, setTrackWidth] = useState(1);
  useEffect(() => {
    live.current = true;
    const appState = AppState.addEventListener('change', state => {
      foreground.current = state === 'active';
      if (live.current && !foreground.current) player.pause();
    });
    // useAudioPlayer releases (and stops) its native player on unmount.
    return () => { live.current = false; recorded.current = false; recording.current = null; appState.remove(); };
  }, [player]);
  useEffect(() => {
    if (status.didJustFinish) { recorded.current = false; return; }
    if (!status.isLoaded || !status.playing || recorded.current) return;
    recorded.current = true;
    const attempt = {}; recording.current = attempt;
    void recordGiftPlayback(access.token).then(activity => { if (live.current && recording.current === attempt) setLastPlayedAt(activity.lastPlayedAt); })
      .catch(() => { if (live.current && recording.current === attempt) { recorded.current = false; setError('播放已开始，播放记录暂未保存。'); } });
  }, [player, status.isLoaded, status.playing, status.didJustFinish, access.token]);
  const play = async () => {
    if (busy.current || !foreground.current) return;
    busy.current = true; setError('');
    try {
      if (status.playing) { player.pause(); return; }
      await openGiftAttachment(access.token, access.token.attachmentId, 'you');
      if (!live.current || !foreground.current || !canCommitBackupRestoreDataEpoch(access.token.dataEpoch)) return;
      if (status.didJustFinish || status.duration > 0 && status.currentTime >= status.duration) await player.seekTo(0);
      if (live.current && foreground.current && canCommitBackupRestoreDataEpoch(access.token.dataEpoch)) player.play();
    } catch (cause) { if (live.current) setError(giftErrorText(cause)); }
    finally { busy.current = false; }
  };
  return <ScrollView contentContainerStyle={[s.content, { paddingTop: 32 }]}>
    <Text style={s.heading}>原录音</Text>
    <Text style={s.muted}>播放由当前设备发声。</Text>
    <Pressable accessibilityRole="button" accessibilityLabel={status.playing ? '暂停礼物音频' : '播放礼物音频'} style={[s.button, s.primary, { marginVertical: 24 }]} onPress={() => { void play(); }}>
      <Text style={s.ink}>{status.playing ? 'Ⅱ 暂停' : '▶ 播放'}</Text>
    </Pressable>
    <Text style={s.ink}>{clock(status.currentTime)} / {clock(status.duration)}</Text>
    <Pressable accessibilityRole="adjustable" accessibilityLabel="礼物音频播放进度" style={{ height: 44, justifyContent: 'center' }}
      onLayout={event => setTrackWidth(Math.max(1, event.nativeEvent.layout.width))}
      onPress={event => { if (status.duration > 0) void player.seekTo(Math.max(0, Math.min(1, event.nativeEvent.locationX / trackWidth)) * status.duration).catch(() => { if (live.current) setError('暂时无法跳转播放位置。'); }); }}>
      <View style={{ height: 5, borderRadius: 3, backgroundColor: '#E7DDD4' }}><View style={{ height: 5, borderRadius: 3, backgroundColor: '#D5A28C', width: `${status.duration > 0 ? Math.min(100, status.currentTime / status.duration * 100) : 0}%` }} /></View>
    </Pressable>
    {status.playbackState === 'error' && <Text accessibilityRole="alert" style={s.error}>音频暂时无法播放；原件仍保留，可以重试或选择兼容格式。</Text>}
    {!!error && <Text accessibilityRole="alert" style={s.error}>{error}</Text>}
    {lastPlayedAt !== null && <Text style={s.info}>最近播放：{giftDate(lastPlayedAt)}</Text>}
  </ScrollView>;
}
