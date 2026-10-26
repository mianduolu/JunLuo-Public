import { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import { AppText as Text } from '../components/AppText';
import { loadPostReplyFailure, retryPostReply, subscribePostReplyStatus } from './baiyunPostReplyRuntime';
import { postStyles as s } from './baiyunPostStyles';

/** Technical status only. Its private event does not reload the post feed or the composer. */
export function BaiyunPostReplyStatus({ postId }: { postId: string }) {
  const [failure, setFailure] = useState<Awaited<ReturnType<typeof loadPostReplyFailure>>>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let current = true, revision = 0;
    const refresh = () => { const request = ++revision; void loadPostReplyFailure(postId).then(value => {
      if (current && request === revision) setFailure(value);
    }).catch(() => undefined); };
    refresh();
    const unsubscribe = subscribePostReplyStatus(refresh);
    return () => { current = false; unsubscribe(); };
  }, [postId]);
  if (!failure) return null;
  return <View style={s.wrap}>
    <Text accessibilityRole="alert" style={[s.muted, s.grow]}>{failure.message}</Text>
    <Pressable accessibilityRole="button" disabled={busy} style={s.button} onPress={() => {
      if (busy) return;
      setBusy(true);
      void retryPostReply(postId, failure.source).catch(() => undefined).finally(() => setBusy(false));
    }}><Text style={s.link}>重试</Text></Pressable>
  </View>;
}
