import React, { useEffect, useRef, useState } from 'react';
import { AppState, Pressable, StyleSheet, Text, View } from 'react-native';
import { getMiBand6ActivitySyncState, syncMiBand6ActivityHistory } from './miBand6Activity';
import { miBand6ActivityError } from './colmi/miBand6ActivityProtocol';
import type { MiBand6ActivitySyncState } from './miBand6ActivityNative';
import { subscribeGuardianActivitySaved } from './bodySignalGuardianRuntime';
import { readMiBand6Battery } from './miBand6Battery';

const time = (value?: number) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '暂未记录';
const status = (value?: MiBand6ActivitySyncState['status']) => ({
  syncing: '正在读取活动记录', pending_save: '等待保存，记录仍在补录队列中',
  completed: '已保存', error: '本次未完成，保留上次记录', candidate: '等待首次正式同步',
}[value ?? 'candidate']);

export function MiBand6ActivitySection({ ready, identity, showManualAction = true }: { ready: boolean; identity?: string; showManualAction?: boolean }) {
  const [state, setState] = useState<MiBand6ActivitySyncState>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const generation = useRef(0);
  const inFlight = useRef(false);
  useEffect(() => {
    generation.current += 1;
    let active = true;
    setError(undefined); setState(undefined);
    const load = async () => {
      try {
        const next = await getMiBand6ActivitySyncState();
        if (active) {
          setState(next);
          if (next.formallyVerified !== true) setError(miBand6ActivityError('activity_update_required'));
        }
      } catch (failure) {
        if (active && failure instanceof Error && failure.message === 'activity_update_required') setError(miBand6ActivityError(failure.message));
      }
    };
    const refresh = async () => {
      await load();
      if (active && ready) {
        await readMiBand6Battery({ trigger: 'foreground' }).catch(() => undefined);
        if (!active) return;
        await syncMiBand6ActivityHistory({ trigger: 'foreground' }).catch(() => undefined);
        await load();
      }
    };
    void refresh();
    const saved = subscribeGuardianActivitySaved(() => { void load(); });
    const subscription = AppState.addEventListener('change', value => { if (value === 'active') void refresh(); });
    return () => { active = false; generation.current += 1; saved(); subscription.remove(); };
  }, [identity, ready]);
  const sync = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    const version = generation.current;
    setBusy(true); setError(undefined);
    try {
      await syncMiBand6ActivityHistory({ trigger: 'manual' });
    } catch (failure) {
      if (version === generation.current) setError(miBand6ActivityError(failure instanceof Error ? failure.message : ''));
    } finally {
      try {
        const next = await getMiBand6ActivitySyncState();
        if (version === generation.current) setState(next);
      } catch { /* The device may have been disconnected during transfer. */ }
      inFlight.current = false; setBusy(false);
    }
  };
  const disabled = !ready || busy || state?.formallyVerified !== true;
  return <View style={styles.section}>
    <Text style={styles.title}>手环活动记录</Text>
    <Text style={styles.text}>{busy ? '正在同步活动记录' : status(state?.status)}</Text>
    <Text style={styles.text}>最近保存：{time(state?.lastSuccessAt)}</Text>
    <Text style={styles.text}>已同步至：{time(state?.syncedThroughAt)}</Text>
    {state?.receivedCount !== undefined ? <Text style={styles.text}>最近收到 {state.receivedCount} 组分钟记录</Text> : null}
    {state?.gap ? <Text style={styles.text}>手环返回的历史存在缺口，未补零。</Text> : null}
    {showManualAction ? <Pressable accessibilityRole="button" disabled={disabled} onPress={() => void sync()}
      style={[styles.button, disabled && styles.disabled]}>
      <Text style={styles.buttonText}>{busy ? '正在同步活动记录' : '同步活动记录'}</Text>
    </Pressable> : null}
    {error || state?.lastErrorCode ? <Text style={styles.text}>{error ?? miBand6ActivityError(state!.lastErrorCode!)}</Text> : null}
  </View>;
}

const styles = StyleSheet.create({
  section: { borderTopWidth: 1, borderTopColor: '#edf0e9', marginTop: 16, paddingTop: 16, gap: 10 },
  title: { fontSize: 14, fontWeight: '700', color: '#737b86' },
  text: { fontSize: 14, lineHeight: 21, color: '#788272', flexShrink: 1 },
  button: { backgroundColor: '#809f7b', borderRadius: 8, paddingVertical: 13, paddingHorizontal: 16, alignItems: 'center' },
  buttonText: { color: '#fff', fontSize: 15, fontWeight: '700', flexShrink: 1 },
  disabled: { opacity: 0.45 },
});
