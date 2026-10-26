import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { AppText as Text } from '../components/AppText';
import type { JunluoThoughtStateV2 } from '../life/junluoInnerState';
import { groupActiveThoughts, THOUGHT_GROUPS } from '../life/junluoInnerStatePresentation';
import { advanceJunluoThoughtLifecycle } from '../life/junluoThoughtLifecycle';
import { colors } from '../theme/colors';

export function JunluoThoughtDiaryCard({ state }: { state: JunluoThoughtStateV2 | null }) {
  const [dormantExpanded, setDormantExpanded] = useState(false);
  const thoughtGroups = useMemo(() => {
    if (!state) return null;
    const now = Date.now();
    // Read-only display preview, as in the original diary section; no lifecycle writes.
    const preview = advanceJunluoThoughtLifecycle({
      now, operationId: `diary-preview:${Math.floor(now / 60_000)}`, state,
    });
    return groupActiveThoughts(preview.thoughts);
  }, [state]);

  return (
    <View style={styles.card}>
      <Text style={styles.title}>云云的念头</Text>
      {!thoughtGroups ? <Text style={styles.empty}>正在读取念头。</Text> : THOUGHT_GROUPS.map((group) => {
        const entries = thoughtGroups[group.id];
        const collapsed = group.id === 'dormant' && !dormantExpanded;
        return (
          <View key={group.id} style={styles.thoughtSection}>
            <View style={styles.thoughtHeadingRow}>
              <Text style={styles.subhead}>{group.label}</Text>
              {group.id === 'dormant' && entries.length ? (
                <Pressable onPress={() => setDormantExpanded((current) => !current)} style={styles.expandButton}
                  accessibilityRole="button" accessibilityState={{ expanded: dormantExpanded }}>
                  <Text style={styles.expandText}>{dormantExpanded ? '收起' : `展开 ${entries.length}`}</Text>
                </Pressable>
              ) : null}
            </View>
            {entries.length === 0 ? (
              <Text style={styles.empty}>现在没有这类念头。</Text>
            ) : collapsed ? (
              <Text style={styles.empty}>休眠库默认收起。</Text>
            ) : entries.slice(0, group.id === 'dormant' ? 24 : 3).map((entry) => (
              <View key={entry.thoughtId} style={styles.thoughtItem}>
                <Text style={styles.thoughtContent}>{entry.content}</Text>
                {entry.lastOutcome ? (
                  <Text style={styles.thoughtMeta}>
                    最近一次真实结果：{entry.lastOutcome === 'failed'
                      ? '没有成功'
                      : entry.lastOutcome === 'blocked'
                        ? '被现实条件挡住了'
                        : '还没有完成'}
                  </Text>
                ) : null}
              </View>
            ))}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: 'rgba(255, 246, 250, 0.82)', borderColor: '#F4C6D6', borderRadius: 24, borderWidth: 1, marginTop: 14, padding: 18 },
  title: { color: colors.ink, fontSize: 20, fontWeight: '600' },
  subhead: { color: '#976678', fontSize: 14, fontWeight: '500', marginTop: 15, flexShrink: 1 },
  thoughtSection: { borderTopColor: '#F2DFE7', borderTopWidth: 1, marginTop: 13, paddingTop: 2 },
  thoughtHeadingRow: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  thoughtItem: { backgroundColor: 'rgba(255,255,255,0.66)', borderRadius: 12, marginTop: 8, paddingHorizontal: 10, paddingVertical: 9 },
  thoughtContent: { color: colors.ink, fontSize: 13, fontWeight: '400', lineHeight: 21 },
  thoughtMeta: { color: '#A58696', fontSize: 10, lineHeight: 15, marginTop: 5 },
  empty: { color: '#A39189', fontSize: 11, lineHeight: 17, marginTop: 7 },
  expandButton: { backgroundColor: '#F0EAF7', borderRadius: 11, marginTop: 12, paddingHorizontal: 9, paddingVertical: 5 },
  expandText: { color: '#79658F', fontSize: 10, fontWeight: '500' },
});
