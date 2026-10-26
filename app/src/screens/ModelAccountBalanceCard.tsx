import { useEffect, useRef, useState } from 'react';
import { Linking, Pressable, StyleSheet, View } from 'react-native';
import { AppText } from '../components/AppText';
import { getModelBalanceProvider, queryDeepSeekBalance, type ModelAccountBalance } from '../ai/modelAccountBalance';
import type { AiConnection } from '../ai/types';
import {
  canCommitBackupRestoreDataEpoch,
  captureBackupRestoreDataEpoch,
  subscribeBackupRestoreRuntimeState,
} from '../backup/backupRestoreCoordinator';

export function ModelAccountBalanceCard({ connections, getConnectionKey }: {
  connections: AiConnection[];
  getConnectionKey: (id: string) => string;
}) {
  const deepSeekConnections = connections.filter(connection => getModelBalanceProvider(connection) === 'deepseek');
  const selected = deepSeekConnections.find(connection => getConnectionKey(connection.id).trim()) ?? deepSeekConnections[0];
  const apiKey = selected ? getConnectionKey(selected.id) : '';
  const [balance, setBalance] = useState<ModelAccountBalance | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  const request = useRef<AbortController | null>(null);
  const identity = useRef({ id: selected?.id, baseUrl: selected?.baseUrl, apiKey });
  identity.current = { id: selected?.id, baseUrl: selected?.baseUrl, apiKey };
  const balanceSource = useRef<typeof identity.current | null>(null);
  const matchesIdentity = (source: typeof identity.current | null) => source !== null
    && source.id === identity.current.id && source.baseUrl === identity.current.baseUrl
    && source.apiKey === identity.current.apiKey;
  const visibleBalance = matchesIdentity(balanceSource.current) ? balance : null;

  const invalidate = () => {
    balanceSource.current = null;
    const previous = request.current;
    request.current = null;
    previous?.abort();
  };
  useEffect(() => {
    invalidate();
    setBalance(null); setError(''); setBusy(false);
    return invalidate;
  }, [selected?.id, selected?.baseUrl, apiKey]);
  useEffect(() => {
    mounted.current = true;
    const unsubscribe = subscribeBackupRestoreRuntimeState(state => {
      if (state.status === 'ready') return;
      invalidate();
      setBalance(null); setBusy(false); setError('资料恢复期间不能查询余额。');
    });
    return () => { mounted.current = false; invalidate(); unsubscribe(); };
  }, []);

  const refresh = async () => {
    if (!selected || request.current) return;
    const epoch = captureBackupRestoreDataEpoch();
    if (!canCommitBackupRestoreDataEpoch(epoch)) { setError('资料恢复期间不能查询余额。'); return; }
    const controller = new AbortController();
    const source = identity.current;
    request.current = controller;
    const isCurrent = () => mounted.current && request.current === controller
      && !controller.signal.aborted && canCommitBackupRestoreDataEpoch(epoch)
      && matchesIdentity(source);
    setBusy(true); setBalance(null); setError('');
    try {
      const result = await queryDeepSeekBalance(selected, apiKey, { signal: controller.signal });
      if (isCurrent()) { balanceSource.current = source; setBalance(result); }
    } catch (failure) {
      if (isCurrent()) setError(failure instanceof Error ? failure.message : '这次没有取得余额资料。');
    } finally {
      if (isCurrent()) { request.current = null; setBusy(false); }
    }
  };
  const openSiliconFlow = async () => {
    try { await Linking.openURL('https://cloud.siliconflow.cn/'); }
    catch { if (mounted.current) setError('未能打开硅基流动官网。'); }
  };

  return (
    <View style={styles.card}>
      <AppText style={styles.title}>账号余额</AppText>
      <AppText style={styles.hint}>手动查询，不自动刷新。</AppText>
      <View style={styles.heading}>
        <AppText style={styles.provider}>DeepSeek</AppText>
        <Pressable accessibilityRole="button" accessibilityLabel="刷新 DeepSeek 余额"
          disabled={!selected || busy} onPress={() => { void refresh(); }}
          style={[styles.button, (!selected || busy) && styles.disabled]}>
          <AppText style={styles.buttonText}>{busy ? '查询中…' : '刷新'}</AppText>
        </Pressable>
      </View>
      {!selected ? <AppText style={styles.hint}>请先保存 DeepSeek 官方连接。</AppText> : null}
      {visibleBalance ? <View style={styles.balances}>
        {visibleBalance.balances.map(entry => <AppText key={entry.currency} style={styles.amount}>
          可用余额：{entry.totalBalance} {entry.currency}
        </AppText>)}
        <AppText style={styles.hint}>查询时间：{new Date(visibleBalance.queriedAt).toLocaleString()}</AppText>
      </View> : <AppText style={styles.hint}>{busy ? '正在查询余额…' : '尚未查询'}</AppText>}
      {error ? <AppText style={styles.error}>{error}</AppText> : null}
      <View style={styles.siliconFlow}>
        <AppText style={styles.provider}>硅基流动</AppText>
        <AppText style={styles.hint}>暂不能自动查询</AppText>
        <Pressable accessibilityRole="link" onPress={() => { void openSiliconFlow(); }} style={styles.button}>
          <AppText style={styles.buttonText}>打开硅基流动官网</AppText>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: '#FFFFFF', borderColor: '#FFE2DA', borderWidth: 1, borderRadius: 16, padding: 16, gap: 10, marginBottom: 18 },
  title: { fontSize: 18, fontWeight: '700', color: '#384052' },
  provider: { fontSize: 15, fontWeight: '700', color: '#384052' },
  hint: { fontSize: 13, color: '#697184', lineHeight: 20 },
  heading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 },
  button: { backgroundColor: '#FFF1ED', borderRadius: 11, paddingHorizontal: 14, paddingVertical: 10, alignSelf: 'flex-start' },
  buttonText: { fontSize: 13, fontWeight: '600', color: '#B76558' },
  disabled: { opacity: 0.5 },
  balances: { gap: 8 },
  amount: { fontSize: 17, fontWeight: '600', color: '#384052' },
  error: { fontSize: 13, color: '#B34B4B', lineHeight: 20 },
  siliconFlow: { borderTopWidth: 1, borderColor: '#FFE2DA', paddingTop: 14, marginTop: 6, gap: 8 },
});
