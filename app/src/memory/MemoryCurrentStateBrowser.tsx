import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { isLetterMemorySource, loadMemorySourceMessage } from './memorySourceReader';
import { getMemorySourceStatus, memorySourceStatusLabel } from './memorySourceStatus';
import { loadMemoryCurrentStates, type MemoryCurrentState } from './memoryCurrentStateStore';
import { stableMemoryHash } from './memoryAtomicity';

const PAGE_SIZE = 12;
const time = (value?: number) => value === undefined ? '未记录' : new Date(value).toLocaleString('zh-CN');

function CurrentStateDetails({ state }: { state: MemoryCurrentState }) {
  const [sources, setSources] = useState<string[] | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let alive = true;
    setSources(null);
    setError(false);
    void Promise.all(state.sourceRefs.map(async ref => {
      const message = await loadMemorySourceMessage(ref.sessionId, ref.messageId);
      const contentHash = (ref as typeof ref & { contentHash?: string }).contentHash;
      const available = !!message && message.role === ref.role && message.createdAt === ref.messageCreatedAt
        && (!contentHash || stableMemoryHash(message.content) === contentHash);
      const status = getMemorySourceStatus({ available, retainedExcerpt: !available && !!ref.excerpt, mode: 'exact' });
      return `${memorySourceStatusLabel[status]} · ${ref.relation === 'direct' ? '直接依据' : '派生依据'}\n`
        + `${ref.role === 'I' ? '白云小姐' : '小仓鼠'} · ${time(ref.messageCreatedAt)}\n`
        + `${isLetterMemorySource(ref.sessionId) ? '信件' : '会话'} ${ref.sessionId} · 消息 ${ref.messageId}\n${available ? message.content : ref.excerpt ?? ''}`;
    })).then(value => { if (alive) setSources(value); }, () => { if (alive) setError(true); });
    return () => { alive = false; };
  }, [state]);
  return <View style={styles.details}>
    <Text selectable style={styles.body}>{state.content}</Text>
    <Text style={styles.meta}>得知时间：{time(state.knownAt)}</Text>
    {error ? <Text style={styles.meta}>出处读取失败，请收起后重试。</Text>
      : sources === null ? <Text style={styles.meta}>正在读取出处…</Text>
        : sources.length ? sources.map((source, index) => <Text selectable key={index} style={styles.source}>{source}</Text>)
          : <Text style={styles.meta}>原话未找到 · 未记录可核对的出处</Text>}
  </View>;
}

export function MemoryCurrentStateBrowser({ items, onCloseState }: {
  items: MemoryCurrentState[]; onCloseState: (id: string) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [rows, setRows] = useState<MemoryCurrentState[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const requestVersion = useRef(0);
  useEffect(() => {
    const version = ++requestVersion.current;
    if (!expanded) return;
    let alive = true;
    setLoading(true);
    setError(false);
    void loadMemoryCurrentStates({ limit: PAGE_SIZE + 1 }).then(page => {
      if (!alive || version !== requestVersion.current) return;
      setRows(page.slice(0, PAGE_SIZE));
      setHasMore(page.length > PAGE_SIZE);
    }, () => { if (alive) setError(true); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [expanded, items]);
  const more = async () => {
    const version = requestVersion.current;
    setLoading(true);
    setError(false);
    try {
      const page = await loadMemoryCurrentStates({ limit: PAGE_SIZE + 1, offset: rows.length });
      if (version !== requestVersion.current) return;
      setRows(current => [...current, ...page.slice(0, PAGE_SIZE)]);
      setHasMore(page.length > PAGE_SIZE);
    } catch { if (version === requestVersion.current) setError(true); }
    finally { if (version === requestVersion.current) setLoading(false); }
  };
  const visible = expanded ? rows.filter(state => state.status === 'active') : items.filter(state => state.status === 'active').slice(0, 4);
  return <View style={styles.panel}>
    <View style={styles.actions}>
      <Text style={styles.heading}>当前近况</Text>
      <Pressable onPress={() => setExpanded(value => !value)}><Text style={styles.action}>{expanded ? '收起列表' : '展开查看'}</Text></Pressable>
    </View>
    {visible.map(state => <View key={state.id} style={styles.card}>
      <Pressable onPress={() => setSelected(value => value === state.id ? null : state.id)}>
        <Text style={styles.heading}>{state.title}</Text>
        <Text style={styles.meta}>得知时间：{time(state.knownAt)} · {selected === state.id ? '收起正文与出处' : '查看正文与出处'}</Text>
      </Pressable>
      {selected === state.id ? <CurrentStateDetails state={state} /> : null}
      {state.status === 'active' ? <Pressable onPress={() => void onCloseState(state.id).catch(() => setError(true))}>
        <Text style={styles.action}>收起这条近况</Text>
      </Pressable> : null}
    </View>)}
    {!visible.length && !loading ? <Text style={styles.meta}>暂无当前近况。</Text> : null}
    {error ? <Text style={styles.meta}>近况读取或保存失败，原记录未清除。</Text> : null}
    {loading ? <Text style={styles.meta}>读取中…</Text> : null}
    {expanded && hasMore ? <Pressable disabled={loading} onPress={() => void more()}><Text style={styles.action}>加载更多</Text></Pressable> : null}
  </View>;
}

const styles = StyleSheet.create({
  panel: { gap: 10, borderRadius: 14, backgroundColor: '#F4FAFE', padding: 12 },
  actions: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  card: { gap: 8, padding: 10, backgroundColor: '#FFFFFF', borderRadius: 12 },
  heading: { color: '#34556B', fontSize: 13, fontWeight: '600' },
  meta: { color: '#6B8BAA', fontSize: 11, lineHeight: 17 },
  action: { color: '#547FA0', fontSize: 12, paddingVertical: 5 },
  details: { gap: 8 }, body: { color: '#34556B', fontSize: 13, lineHeight: 20 },
  source: { color: '#56738A', fontSize: 11, lineHeight: 17, backgroundColor: '#F4FAFE', padding: 8, borderRadius: 8 },
});
