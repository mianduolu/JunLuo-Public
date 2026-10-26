
import {
  Alert,
  AppState,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

import type { BaiyunContinuityEvent } from '../ai/behavior/continuityEvent';
import {
  acceptBaiyunContinuityCandidate,
  completeBaiyunContinuityEventManually,
  dismissBaiyunContinuityCandidate,
  listPendingBaiyunContinuityCandidates,
  type BaiyunContinuityCandidate,
} from '../ai/behavior/continuityLedger';
import {
  BAIYUN_CONTINUITY_KIND_LABELS,
  presentBaiyunContinuityEvent,
} from '../ai/behavior/continuityLedgerPresentation';
import { loadChatSessionMessages } from '../chat/chatStorage';
import { AppText as Text } from '../components/AppText';
import { colors } from '../theme/colors';
import { AssistantDiaryContinuitySource } from './AssistantDiaryContinuitySource';
import type { ContinuitySourceMessages } from '../ai/behavior/continuitySourceMessages';

type AssistantDiaryContinuityReviewSectionProps = {
  events: readonly BaiyunContinuityEvent[];
  sources: Readonly<Record<string, ContinuitySourceMessages>>;
  onChanged: () => void | Promise<void>;
  showManualCompletion: boolean;
};

function compactExcerpt(value: string) {
  const compact = value.replace(/\s+/gu, ' ').trim();
  if (!compact) return '来源消息不可用';
  return compact.length > 160
    ? `${compact.slice(0, 159)}…`
    : compact;
}

function candidateTitle(candidate: BaiyunContinuityCandidate) {
  return candidate.kind === 'create_event'
    ? '可能是一条牵挂'
    : '可能已有进展';
}

function candidateMeta(candidate: BaiyunContinuityCandidate) {
  if (candidate.eventKind) {
    return BAIYUN_CONTINUITY_KIND_LABELS[candidate.eventKind];
  }
  if (candidate.proposedResolution === 'progressed') return '建议状态：已有进展';
  if (candidate.proposedResolution === 'completed') return '建议状态：已经完成';
  if (candidate.proposedResolution === 'cancelled') return '建议状态：已经取消';
  return '既有牵挂';
}

export function AssistantDiaryContinuityReviewSection({
  events,
  sources,
  onChanged,
  showManualCompletion,
}: AssistantDiaryContinuityReviewSectionProps) {
  const [candidates, setCandidates] = useState<BaiyunContinuityCandidate[]>([]);
  const [excerptByCandidateId, setExcerptByCandidateId] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState('');
  const [busyIds, setBusyIds] = useState<string[]>([]);
  const generationRef = useRef(0);

  const refresh = useCallback(async () => {
    const generation = ++generationRef.current;
    const next = await listPendingBaiyunContinuityCandidates({ limit: 100 });
    const sessionIds = [...new Set(next.map((candidate) => candidate.sessionId))];
    const sessionMessages = await Promise.all(sessionIds.map(async (sessionId) => {
      try {
        return [sessionId, await loadChatSessionMessages(sessionId)] as const;
      } catch {
        return [
          sessionId,
          [] as Awaited<ReturnType<typeof loadChatSessionMessages>>,
        ] as const;
      }
    }));
    if (generation !== generationRef.current) return;
    const messagesBySession = new Map(sessionMessages);
    const excerpts: Record<string, string> = {};
    for (const candidate of next) {
      const message = messagesBySession
        .get(candidate.sessionId)
        ?.find((item) => item.id === candidate.messageId);
      excerpts[candidate.id] = compactExcerpt(message?.content ?? '');
    }
    setCandidates(next);
    setExcerptByCandidateId(excerpts);
  }, []);

  useEffect(() => {
    const load = () => {
      void refresh().catch(() => {
        setNotice('待确认篮子暂时没有刷新成功，可以稍后重试。');
      });
    };
    load();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') load();
    });
    return () => {
      generationRef.current += 1;
      subscription.remove();
    };
  }, [refresh]);

  const run = useCallback(async (
    id: string,
    action: () => Promise<unknown>,
  ) => {
    setBusyIds((current) => current.includes(id) ? current : [...current, id]);
    try {
      setNotice('');
      await action();
      await refresh();
      await onChanged();
    } catch {
      setNotice('这次操作没有成功，请刷新后确认卡片状态再试。');
      await refresh().catch(() => undefined);
      await onChanged();
    } finally {
      setBusyIds((current) => current.filter((value) => value !== id));
    }
  }, [onChanged, refresh]);

  const confirmManualCompletion = useCallback((event: BaiyunContinuityEvent) => {
    Alert.alert(
      '确认标记完成',
      event.schemaVersion === 3 && event.careEvidence
        ? '这会删除这件聊天牵挂及其关联记录，两个栏目一起撤下；原聊天保留。'
        : '这会把本次牵挂标记为已完成，已有历史会继续保留。',
      [
        { text: '先不改', style: 'cancel' },
        {
          text: '标记完成',
          onPress: () => {
            void run(event.id, async () => {
              const completed = await completeBaiyunContinuityEventManually({
                eventId: event.id,
                expectedRevision: event.revision,
              });
              return completed;
            });
          },
        },
      ],
    );
  }, [run]);

  return (
    <>
      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>待确认</Text>
          <Text style={styles.count}>{candidates.length}</Text>
        </View>
        <Text style={styles.hint}>
          意思还不够明确的牵挂会留在这里，确认后才会登记或改变状态。
        </Text>
        {notice ? <Text style={styles.notice}>{notice}</Text> : null}
        {candidates.length ? candidates.map((candidate) => {
          const busy = busyIds.includes(candidate.id);
          return (
            <View key={candidate.id} style={styles.card}>
              <Text style={styles.cardTitle}>{candidateTitle(candidate)}</Text>
              <Text style={styles.meta}>{candidateMeta(candidate)}</Text>
              <Text style={styles.excerpt} numberOfLines={4}>
                {excerptByCandidateId[candidate.id] ?? '来源消息不可用'}
              </Text>
              <View style={styles.actions}>
                <Pressable
                  disabled={busy}
                  onPress={() => void run(candidate.id, () => (
                    dismissBaiyunContinuityCandidate({
                      candidateId: candidate.id,
                      expectedRevision: candidate.revision,
                    })
                  ))}
                  style={({ pressed }) => [
                    styles.secondaryButton,
                    pressed && styles.pressed,
                    busy && styles.disabled,
                  ]}
                >
                  <Text style={styles.secondaryText}>暂不登记</Text>
                </Pressable>
                <Pressable
                  disabled={busy}
                  onPress={() => void run(candidate.id, async () => {
                    const accepted = await acceptBaiyunContinuityCandidate({
                      candidateId: candidate.id,
                      expectedRevision: candidate.revision,
                    });
                    return accepted;
                  })}
                  style={({ pressed }) => [
                    styles.primaryButton,
                    pressed && styles.pressed,
                    busy && styles.disabled,
                  ]}
                >
                  <Text style={styles.primaryText}>
                    {candidate.kind === 'create_event' ? '确认登记' : '确认状态'}
                  </Text>
                </Pressable>
              </View>
            </View>
          );
        }) : (
          <Text style={styles.empty}>现在没有待确认的牵挂。</Text>
        )}
      </View>

      {showManualCompletion && events.length ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>手动标记完成</Text>
          <Text style={styles.hint}>
            聊天牵挂完成后会从两个栏目撤下，原聊天保留；其他类型记录沿用原来的完成方式。
          </Text>
          {events.map((event) => {
            const presentation = presentBaiyunContinuityEvent(event);
            const busy = busyIds.includes(event.id);
            return (
              <View key={event.id} style={styles.manualRow}>
                <View style={styles.manualCopy}>
                  <Text style={styles.cardTitle}>
                    {presentation.kindLabel}｜{presentation.sourceLabel}{presentation.itemName ? `｜${presentation.itemName}` : ''}
                  </Text>
                  <Text style={styles.meta}>{presentation.stageLabel}</Text>
                  <Text style={styles.hint}>
                    建立于 {new Date(presentation.openedAt).toLocaleString('zh-CN', { hour12: false })}
                  </Text>
                  <AssistantDiaryContinuitySource source={sources[event.id]} />
                </View>
                <Pressable
                  disabled={busy}
                  onPress={() => confirmManualCompletion(event)}
                  style={({ pressed }) => [
                    styles.secondaryButton,
                    pressed && styles.pressed,
                    busy && styles.disabled,
                  ]}
                >
                  <Text style={styles.secondaryText}>标记完成</Text>
                </Pressable>
              </View>
            );
          })}
        </View>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  section: {
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(157, 134, 185, 0.2)',
    backgroundColor: 'rgba(255, 252, 255, 0.78)',
    marginTop: 14,
    padding: 15,
    gap: 10,
  },
  sectionHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  sectionTitle: {
    color: colors.ink,
    fontSize: 16,
    fontWeight: '700',
  },
  count: {
    color: colors.primary,
    fontSize: 13,
    fontWeight: '700',
  },
  hint: {
    color: colors.muted,
    fontSize: 12,
    lineHeight: 18,
  },
  notice: {
    color: colors.primary,
    fontSize: 12,
    lineHeight: 18,
  },
  card: {
    borderRadius: 15,
    backgroundColor: 'rgba(157, 134, 185, 0.08)',
    padding: 12,
    gap: 5,
  },
  cardTitle: {
    color: colors.ink,
    fontSize: 14,
    fontWeight: '700',
  },
  meta: {
    color: colors.primary,
    fontSize: 12,
  },
  excerpt: {
    color: colors.ink,
    fontSize: 13,
    lineHeight: 19,
  },
  actions: {
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'flex-end',
    marginTop: 4,
  },
  primaryButton: {
    borderRadius: 999,
    backgroundColor: colors.primary,
    paddingHorizontal: 13,
    paddingVertical: 8,
  },
  secondaryButton: {
    borderRadius: 999,
    backgroundColor: 'rgba(157, 134, 185, 0.13)',
    paddingHorizontal: 13,
    paddingVertical: 8,
  },
  primaryText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '700',
  },
  secondaryText: {
    color: colors.ink,
    fontSize: 12,
    fontWeight: '600',
  },
  empty: {
    color: colors.muted,
    fontSize: 12,
  },
  manualRow: {
    alignItems: 'stretch',
    borderRadius: 15,
    backgroundColor: 'rgba(157, 134, 185, 0.08)',
    flexDirection: 'column',
    gap: 10,
    justifyContent: 'space-between',
    padding: 12,
  },
  manualCopy: {
    gap: 3,
  },
  pressed: {
    opacity: 0.72,
  },
  disabled: {
    opacity: 0.45,
  },
});
