import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { AppText as Text } from '../components/AppText';
import { captureBackupRestoreDataEpoch, canCommitBackupRestoreDataEpoch,
  subscribeBackupRestoreRuntimeState } from '../backup/backupRestoreCoordinator';
import type { getShiyingVisualPalette } from './ShiyingFeature';
import { createShiyingRecordContentHash, type ShiyingRecordV1 } from './shiyingJournalContract';
import type { ShiyingTopicV1 } from './shiyingReviewContract';
import { getShiyingTopicsForSource } from './shiyingReviewStore';
import { subscribeShiyingWeeklyReviews } from './shiyingReviewCoordinator';
import { getShiyingRecordImageNote, isShiyingImageNoteSourceCurrent } from './shiyingImageNoteStore';
import { createShiyingImageNoteResultHash } from './shiyingImageNoteContract';
import { getShiyingReadingHighlights, isShiyingReadingRangeCurrent, type ShiyingReadingRange } from './shiyingReviewPresentation';

/** Only mounted for an opened, finalized paper. Never creates or modifies a record. */
export function ShiyingRecordTopics({ record, active, visual, onJump }: {
  record: ShiyingRecordV1; active: boolean; visual: ReturnType<typeof getShiyingVisualPalette>;
  onJump: (y: number) => void;
}) {
  const [topics, setTopics] = useState<ShiyingTopicV1[]>([]);
  const [selected, setSelected] = useState<ShiyingReadingRange[]>([]);
  const [unavailable, setUnavailable] = useState(false);
  const [imageExcerpt, setImageExcerpt] = useState<string | null>(null);
  const positions = useRef<Array<{ start: number; end: number; y: number }>>([]);
  const bodyTop = useRef(0);
  const selectionVersion = useRef(0);
  const hash = useMemo(() => createShiyingRecordContentHash(record), [record]);
  const view = useRef({ active, id: record.id, hash });
  view.current = { active, id: record.id, hash };
  useEffect(() => {
    let cancelled = false, readVersion = 0;
    const clear = () => {
      readVersion += 1; selectionVersion.current += 1;
      setTopics([]); setSelected([]); setUnavailable(false); setImageExcerpt(null);
    };
    clear();
    if (!active) return;
    const read = () => {
      const epoch = captureBackupRestoreDataEpoch(), version = ++readVersion;
      if (epoch === null) return;
      const current = () => !cancelled && version === readVersion && view.current.active
        && view.current.id === record.id && view.current.hash === hash && canCommitBackupRestoreDataEpoch(epoch);
      void getShiyingTopicsForSource('record', record.id).then(items => {
        if (current()) setTopics(items);
      }).catch(() => { if (current()) setUnavailable(true); });
    };
    read();
    const unsubscribe = subscribeShiyingWeeklyReviews(read);
    const unsubscribeRestore = subscribeBackupRestoreRuntimeState(state => {
      if (cancelled) return;
      if (state.status !== 'ready') clear();
      else read();
    });
    return () => { cancelled = true; selectionVersion.current += 1; unsubscribe(); unsubscribeRestore(); };
  }, [active, record.id, hash]);

  const open = async (topic: ShiyingTopicV1) => {
    const epoch = captureBackupRestoreDataEpoch(), version = ++selectionVersion.current;
    const current = () => epoch !== null && version === selectionVersion.current && view.current.active
      && view.current.id === record.id && view.current.hash === hash && canCommitBackupRestoreDataEpoch(epoch);
    if (!current()) return;
    const source = topic.sources.find(item => item.kind === 'record' && item.id === record.id);
    if (!source || source.contentHash !== hash || source.textRanges.some(range => !isShiyingReadingRangeCurrent(range, record.body))) {
      setUnavailable(true); setSelected([]); setImageExcerpt(null); return;
    }
    setUnavailable(false); setSelected(source.textRanges); setImageExcerpt(null);
    const first = source.textRanges[0];
    const line = first ? positions.current.find(item => item.end > first.start) : undefined;
    if (line) onJump(bodyTop.current + line.y);
    if (source.imageNoteRanges.length) {
      const note = await getShiyingRecordImageNote(record.id).catch(() => null);
      if (!current()) return;
      if (!note || note.status !== 'ready' || !isShiyingImageNoteSourceCurrent(record, note)
        || createShiyingImageNoteResultHash(note) !== source.imageNoteHash
        || source.imageNoteRanges.some(range => !isShiyingReadingRangeCurrent(range, note.body ?? ''))) {
        setUnavailable(true); return;
      }
      setImageExcerpt(source.imageNoteRanges.map(range => note.body!.slice(range.start, range.end)).join('\n\n'));
    }
  };

  return <View>
    {topics.length ? <View style={styles.index}>
      <Text style={[styles.label, { color: visual.secondaryText }]}>话题目录</Text>
      <View style={styles.topics}>{topics.map(topic => <Pressable key={topic.id} onPress={() => void open(topic)}
        style={[styles.topic, { backgroundColor: visual.actionSurface }]}>
        <Text style={{ color: visual.primaryText, fontSize: 13 }}>{topic.title}{topic.dirty ? ' · 待更新' : ''}</Text>
      </Pressable>)}</View>
    </View> : null}
    {unavailable ? <Text style={[styles.label, { color: visual.secondaryText }]}>话题位置暂不可用</Text> : null}
    {imageExcerpt !== null ? <View style={[styles.excerpt, { backgroundColor: visual.actionSurface }]}>
      <Text style={[styles.label, { color: visual.secondaryText }]}>图片记录 · 话题位置</Text>
      <Text selectable style={[styles.paragraph, { color: visual.primaryText }]}>{imageExcerpt}</Text>
    </View> : null}
    <View onLayout={event => { bodyTop.current = event.nativeEvent.layout.y; }} style={styles.body}>
      <Text selectable style={[styles.paragraph, { color: visual.primaryText }]} onTextLayout={event => {
        let cursor = 0;
        positions.current = event.nativeEvent.lines.map(line => {
          const start = record.body.indexOf(line.text, cursor);
          const resolved = start < 0 ? cursor : start;
          cursor = resolved + line.text.length;
          return { start: resolved, end: cursor, y: line.y };
        });
      }}>{getShiyingReadingHighlights(record.body, selected).map(part => <Text key={part.start}
        style={part.highlighted ? { backgroundColor: visual.actionSurface } : undefined}>{part.text}</Text>)}</Text>
    </View>
  </View>;
}

const styles = StyleSheet.create({
  index: { paddingTop: 8, paddingBottom: 10 },
  label: { fontSize: 12, lineHeight: 20, marginBottom: 8 },
  topics: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  topic: { minHeight: 40, borderRadius: 11, paddingHorizontal: 11, paddingVertical: 10, justifyContent: 'center' },
  body: { minHeight: 80, paddingVertical: 17 },
  paragraph: { fontSize: 17, lineHeight: 31 },
  excerpt: { borderRadius: 12, padding: 14, marginVertical: 12 },
});
