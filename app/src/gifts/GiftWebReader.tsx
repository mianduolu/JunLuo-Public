import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Pressable, UIManager, View } from 'react-native';
import { randomUUID } from 'expo-crypto';
import type { WebView as WebViewType } from 'react-native-webview';
import { AppText as Text } from '../components/AppText';
import { resetGiftWebProgress, saveGiftWebProgress } from './giftAttachmentStore';
import { buildGiftWebDocument, giftScriptJson } from './giftWebDocument';
import { createGiftWebSession } from './giftWebSession';
import { giftDate, giftErrorText } from './giftPresentation';
import { giftStyles as s } from './giftStyles';
import type { GiftAttachmentAccess, GiftAttachmentActivity } from './giftTypes';

export function GiftWebReader({ access, html, onBeforeCloseChange, onDiscardChange }: { access: GiftAttachmentAccess; html: string;
  onBeforeCloseChange?(callback: (() => Promise<unknown>) | null): void;
  onDiscardChange?(callback: (() => void) | null): void }) {
  const [activity, setActivity] = useState(access.activity), [error, setError] = useState('');
  const [generation, setGeneration] = useState(0), [busy, setBusy] = useState(false);
  const session = useRef<ReturnType<typeof createGiftWebSession> | null>(null);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => { onBeforeCloseChange?.(() => session.current?.flush() ?? Promise.resolve());
    onDiscardChange?.(() => session.current?.stop());
    return () => { onBeforeCloseChange?.(null); onDiscardChange?.(null); };
  }, [onBeforeCloseChange, onDiscardChange]);
  const restart = () => Alert.alert('重新开始这个小网页？', '只清除这个作品的游玩进度，原作品会保留。', [
    { text: '继续玩', style: 'cancel' },
    { text: '重新开始', style: 'destructive', onPress: () => {
      if (busy || !session.current) return;
      setBusy(true);
      void session.current.restart().then(next => {
        if (live.current) { setActivity(next); setGeneration(value => value + 1); setError(''); }
      }).catch(cause => { if (live.current) setError(giftErrorText(cause)); })
        .finally(() => { if (live.current) setBusy(false); });
    } },
  ]);
  if (!UIManager.getViewManagerConfig('RNCWebView')) return <View style={s.content}>
    <Text style={s.info}>小网页需要更新开发包后打开。原件和已有进度仍保留。</Text>
  </View>;
  return <View style={{ flex: 1 }}>
    <View style={{ paddingHorizontal: 20, paddingBottom: 10 }}>
      <View style={s.between}><Text style={s.muted}>{activity.progressUpdatedAt === null ? '还没有保存进度' : '进度已保存 · ' + giftDate(activity.progressUpdatedAt)}</Text>
        <Pressable accessibilityRole="button" disabled={busy} style={s.smallButton} onPress={restart}><Text style={s.link}>重新开始</Text></Pressable></View>
      {!!activity.progress.summary && <Text style={s.info}>{activity.progress.summary}</Text>}
      <Text style={s.info}>作品通过存档接口或 localStorage 保存的进度会在下次继续。</Text>
      {!!error && <Text accessibilityRole="alert" style={s.error}>{error}</Text>}
    </View>
    <View style={{ flex: 1 }} pointerEvents={busy ? 'none' : 'auto'}>
      <GiftWebFrame key={generation} access={access} html={html} initial={activity} onChange={next => { setActivity(next); setError(''); }} onError={cause => setError(giftErrorText(cause))} register={value => { session.current = value; }} />
    </View>
  </View>;
}

function GiftWebFrame({ access, html, initial, onChange, onError, register }: {
  access: GiftAttachmentAccess; html: string; initial: GiftAttachmentActivity;
  onChange(activity: GiftAttachmentActivity): void; onError(error: unknown): void;
  register(session: ReturnType<typeof createGiftWebSession> | null): void;
}) {
  // Keep the existing developer package usable until the new native view is installed.
  const WebView = require('react-native-webview').WebView as typeof WebViewType;
  const web = useRef<WebViewType>(null);
  const sessionId = useRef(randomUUID()).current;
  const session = useMemo(() => createGiftWebSession({ sessionId, initialActivity: initial,
    save: (revision, progress) => saveGiftWebProgress(access.token, revision, progress),
    reset: revision => resetGiftWebProgress(access.token, revision),
    onChange, onError,
    reply: message => web.current?.injectJavaScript(`window.__junluoGiftReply(${giftScriptJson(message)});true;`),
  }), []);
  const source = useMemo(() => ({ html: buildGiftWebDocument(html, sessionId, initial) }), []);
  useEffect(() => { register(session); return () => { register(null); session.stop(); }; }, [session]);
  return <WebView ref={web} source={source} style={{ flex: 1, backgroundColor: '#FFF7EF' }}
    originWhitelist={['*']} javaScriptEnabled domStorageEnabled={false} allowFileAccess={false}
    allowFileAccessFromFileURLs={false} allowUniversalAccessFromFileURLs={false} setSupportMultipleWindows={false}
    mediaPlaybackRequiresUserAction onShouldStartLoadWithRequest={request => request.url === 'about:blank' || request.url.startsWith('about:blank#')}
    onMessage={event => session.receive(event.nativeEvent.data)}
    onError={() => onError(Error('gift-web-open-failed'))} onRenderProcessGone={() => onError(Error('gift-web-open-failed'))} />;
}
