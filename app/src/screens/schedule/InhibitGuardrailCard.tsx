import { memo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { AppText as Text } from '../../components/AppText';
import type { InhibitOutcome, TodoInhibitLog, TodoItem } from '../../schedule/todoStore';
import { colors } from '../../theme/colors';

export type InhibitGuardrailEntry = { todo: TodoItem; log?: TodoInhibitLog };

type Props = {
  canReview: boolean;
  entries: InhibitGuardrailEntry[];
  onAcknowledge: (todoId: string) => void;
  onOpen: (todo: TodoItem) => void;
  onOutcome: (todoId: string, outcome: InhibitOutcome) => void;
};

export const InhibitGuardrailCard = memo(function InhibitGuardrailCard({
  canReview,
  entries,
  onAcknowledge,
  onOpen,
  onOutcome,
}: Props) {
  if (!entries.length) return null;
  return (
    <View style={styles.card}>
      <Text style={styles.heading}>今天轻轻记着</Text>
      {entries.map(({ todo, log }) => {
        const acknowledged = !!log?.acknowledgedAt;
        return (
          <View key={todo.id} style={[styles.row, acknowledged && styles.rowAcknowledged]}>
            <Pressable onPress={() => onOpen(todo)} style={styles.copy}>
              <Text style={styles.title}>{todo.title}</Text>
              <Text style={styles.hint}>{acknowledged ? '鼠已经看见啦，白云不追着问。' : '不是任务，不需要打勾完成。'}</Text>
            </Pressable>
            {!acknowledged ? (
              <Pressable onPress={() => onAcknowledge(todo.id)} style={styles.ackButton}>
                <Text style={styles.ackText}>我知道了</Text>
              </Pressable>
            ) : null}
            {canReview ? (
              <View style={styles.outcomes}>
                {([
                  ['kept', '今天守住了'],
                  ['slipped', '没忍住'],
                  ['unrecorded', '暂不记录'],
                ] as Array<[InhibitOutcome, string]>).map(([outcome, label]) => (
                  <Pressable
                    key={outcome}
                    onPress={() => onOutcome(todo.id, outcome)}
                    style={[styles.outcomeButton, log?.outcome === outcome && styles.outcomeButtonActive]}
                  >
                    <Text style={[styles.outcomeText, log?.outcome === outcome && styles.outcomeTextActive]}>{label}</Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
          </View>
        );
      })}
    </View>
  );
});

const styles = StyleSheet.create({
  card: { backgroundColor: '#F2FAF6', borderColor: '#CDE7D8', borderRadius: 12, borderWidth: 1, gap: 7, marginBottom: 10, padding: 11 },
  heading: { color: '#4D7861', fontSize: 13, fontWeight: '500' },
  row: { backgroundColor: '#FFFFFF', borderRadius: 10, gap: 8, padding: 10 },
  rowAcknowledged: { opacity: 0.78 },
  copy: { gap: 2 },
  title: { color: colors.ink, fontSize: 14, fontWeight: '500' },
  hint: { color: colors.muted, fontSize: 11, fontWeight: '400' },
  ackButton: { alignSelf: 'flex-start', backgroundColor: '#E6F4EC', borderRadius: 12, paddingHorizontal: 11, paddingVertical: 6 },
  ackText: { color: '#4D7861', fontSize: 12, fontWeight: '500' },
  outcomes: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  outcomeButton: { borderColor: '#D8E5DE', borderRadius: 12, borderWidth: 1, paddingHorizontal: 9, paddingVertical: 5 },
  outcomeButtonActive: { backgroundColor: '#6E9B7E', borderColor: '#6E9B7E' },
  outcomeText: { color: '#65736B', fontSize: 11, fontWeight: '400' },
  outcomeTextActive: { color: '#FFFFFF' },
});
