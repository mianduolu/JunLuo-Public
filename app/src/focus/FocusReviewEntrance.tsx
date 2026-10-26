import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { AppText as Text } from '../components/AppText';
import { canCommitBackupRestoreDataEpoch, captureBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { subscribeMemoryProcessingUpdates } from '../memory/memoryProcessingSignals';
import { focusJournalPalette } from './FocusJournal';
import { loadUnfinishedFocusReviews } from './focusOrganizationRuntime';
import { loadFocusLogs, loadFocusSessionById, type FocusLogEntry, type FocusSession } from './focusStore';

export function FocusReviewEntrance({ active, onSelect }: {
  active: boolean; onSelect: (session: FocusSession, logs: FocusLogEntry[]) => void;
}) {
  const [reviews, setReviews] = useState<Awaited<ReturnType<typeof loadUnfinishedFocusReviews>>>([]);
  const [notice, setNotice] = useState('');
  const [reading, setReading] = useState(false);
  const [opening, setOpening] = useState(false);
  const busy = reading || opening;
  const live = useRef(false);
  const locked = useRef(false);
  const readingNow = useRef(false);
  const latestRead = useRef(0);
  const readEpoch = useRef<number | null>(null);
  const read = async () => {
    if (!live.current) return;
    const revision = ++latestRead.current;
    const current = () => live.current && latestRead.current === revision;
    readingNow.current = true; setReading(true);
    const epoch = captureBackupRestoreDataEpoch();
    try {
      const pending = await loadUnfinishedFocusReviews();
      if (!current() || !canCommitBackupRestoreDataEpoch(epoch)) return;
      setReviews(pending); readEpoch.current = epoch; setNotice('');
    } catch {
      if (current() && canCommitBackupRestoreDataEpoch(epoch)) setNotice('待确认记忆暂未读取成功。');
    } finally { if (current()) { readingNow.current = false; setReading(false); } }
  };
  useEffect(() => {
    live.current = active;
    setOpening(active && locked.current);
    if (active) void read();
    const unsubscribe = active ? subscribeMemoryProcessingUpdates(() => void read()) : undefined;
    return () => { live.current = false; latestRead.current += 1; unsubscribe?.(); };
  }, [active]);
  const open = async (sessionId: string) => {
    if (locked.current || readingNow.current || !live.current) return;
    locked.current = true; setOpening(true);
    const revision = latestRead.current;
    const current = () => live.current && latestRead.current === revision;
    const epoch = readEpoch.current;
    try {
      if (!canCommitBackupRestoreDataEpoch(epoch)) throw new Error('MEMORY_DATA_CHANGED');
      const session = await loadFocusSessionById(sessionId);
      if (!current() || !canCommitBackupRestoreDataEpoch(epoch)) return;
      const logs = await loadFocusLogs(sessionId);
      if (!session) throw new Error('MEMORY_SOURCE_CHANGED');
      if (current() && canCommitBackupRestoreDataEpoch(epoch)) onSelect(session, logs);
    } catch {
      if (current()) setNotice('这条记录已变化，请重新读取。');
    } finally { locked.current = false; if (live.current) setOpening(false); }
  };
  if (!reviews.length && !notice) return null;
  return <View style={styles.section}>
    <Text style={styles.title}>待确认记忆</Text>
    {reviews.map(({ session, count }) => <Pressable key={session.id} accessibilityRole="button" disabled={busy}
      onPress={() => void open(session.id)} style={styles.card}>
      <Text style={styles.activity}>{session.userActivity}</Text>
      <Text style={styles.date}>{new Date(session.startedAt).toLocaleDateString()} · {Math.floor(session.durationSeconds / 60)} 分钟</Text>
      <Text style={styles.link}>继续审阅 · {count}</Text>
    </Pressable>)}
    {notice ? <Text accessibilityRole="alert" style={styles.date}>{notice}</Text> : null}
    {notice ? <Pressable accessibilityRole="button" disabled={busy} onPress={() => void read()}>
      <Text style={styles.link}>重新读取</Text>
    </Pressable> : null}
  </View>;
}

const styles = StyleSheet.create({
  section: { backgroundColor: focusJournalPalette.paper, borderRadius: 24, padding: 16, marginTop: 22 },
  title: { color: '#475D70', fontSize: 18, fontWeight: '500', marginBottom: 10 },
  card: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#D7E2E9', paddingVertical: 12 },
  activity: { color: '#475D70', fontSize: 15, fontWeight: '500' },
  date: { color: '#8A9BA7', fontSize: 12, lineHeight: 19, marginTop: 4 },
  link: { color: '#5180A5', fontSize: 13, fontWeight: '500', marginTop: 6 },
});
