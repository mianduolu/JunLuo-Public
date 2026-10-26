
import { useEffect, useRef, useState } from 'react';
import {
  Keyboard,
  Pressable,
  ScrollView,
  type StyleProp,
  View,
  useWindowDimensions,
  type ViewStyle,
} from 'react-native';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppText as Text, AppTextInput as TextInput } from '../components/AppText';
import { buildWalletReviewTitle } from '../expense/walletChatCopy';
import type { WalletDecisionReviewAction } from '../expense/walletChatPipeline';
import {
  formatMemoryEventTimeLabel,
  getMemoryAtomicKindLabel,
  getMemoryExtractionBasisLabel,
} from '../memory/memoryAtomicity';
import {
  formatMemoryEventTimeInput,
  parseManualMemoryEventTime,
} from '../memory/memoryCalendarTime';
import { getAnchorKindLabel } from '../memory/memoryAnchorContext';
import type { MemoryCandidateReview } from '../memory/memoryCandidateReview';
import { CurrentStateCandidateEvidence, MemoryCandidateComparison, MemoryCurrentStateCard, MemoryUnderstandingCard, MemoryEpisodeSummaryEditor } from '../memory/MemoryUnderstandingPanel';
import { recheckCurrentStateCandidate } from '../memory/memoryCurrentStateReview';
import { recheckWeeklyRefreshCandidate } from '../memory/memoryWeeklyRefresh';
import { recheckConversationMemoryCandidate } from '../memory/memoryEpisodeReview';
import { getMemoryCandidateKind, getMemoryCandidateKindPolicy } from '../memory/memoryCandidateKindPolicy';
import type {
  MemoryCurrentStateCandidate,
  MemoryCurrentStateResolveCandidate,
} from '../memory/memoryCurrentStateCandidates';
import { MEMORY_DOMAINS } from '../memory/memoryStore';
import { buildRecurrenceRule, formatRecurrenceLabel } from '../schedule/calendarRules';
import { styles } from '../screens/ChatScreen.styles';
import { colors } from '../theme/colors';
import {
  ChatContinuityReviewTray,
  type ChatContinuityReviewTrayProps,
} from './ChatContinuityReviewTray';
import { formatScheduleDraftDateTime, formatScheduleDraftReminder } from './chatScheduleText';

import type { ExpenseReviewAction } from './useChatExpenseController';
import type { ScheduleReviewAction } from './useChatScheduleController';

export type { ExpenseReviewAction } from './useChatExpenseController';
export type { ScheduleReviewAction } from './useChatScheduleController';

type ScheduleReviewGroup = {
  formatOccurrenceDateTime: (timestamp: number) => string;
  onCancel: (review: ScheduleReviewAction) => void;
  onDismiss: (reviewId: string) => void;
  onSaveHabit: (review: ScheduleReviewAction) => void;
  onSaveSchedule: (review: ScheduleReviewAction) => void;
  onSaveTodo: (review: ScheduleReviewAction, status: 'inbox' | 'today') => void;
  onScheduleTodo: (review: ScheduleReviewAction) => void;
  reviews: ScheduleReviewAction[];
};

type WalletDecisionReviewGroup = {
  onMark: (review: WalletDecisionReviewAction, status: 'deferred' | 'rejected') => void;
  onOpenWallet: (review: WalletDecisionReviewAction) => void;
  onSave: (review: WalletDecisionReviewAction) => void;
  reviews: WalletDecisionReviewAction[];
};

type ExpenseReviewGroup = {
  editingNote: string;
  editingReviewId: string | null;
  onBeginEditing: (review: ExpenseReviewAction) => void;
  onCancelEditing: () => void;
  onChangeNote: (value: string) => void;
  onDismiss: (reviewId: string) => void;
  onSave: (review: ExpenseReviewAction) => void;
  onSaveNote: (reviewId: string) => void;
  reviews: ExpenseReviewAction[];
};

type CurrentStateReviewGroup = {
  candidates: MemoryCurrentStateCandidate[];
  onDiscard: (reviewId: string) => void;
  onDiscardResolve: (reviewId: string) => void;
  onSave: (reviewId: string) => void | Promise<void>;
  onSaveResolve: (reviewId: string) => void | Promise<void>;
  resolveCandidates: MemoryCurrentStateResolveCandidate[];
};

type MemoryCandidateReviewGroup = {
  candidates: MemoryCandidateReview[];
  onAdjustImportance: (reviewId: string, delta: number) => void;
  onDiscard: (reviewId: string) => void;
  onSave: (candidate: MemoryCandidateReview, index: number) => void | Promise<void>;
  onToggleAnchor: (reviewId: string) => void;
  onTogglePinned: (reviewId: string) => void;
  onUpdate: (reviewId: string, patch: Partial<MemoryCandidateReview>) => void;
};

type ChatReviewTraysProps = {
  continuity: Omit<ChatContinuityReviewTrayProps, 'keyboardStyle'>;
  currentState: CurrentStateReviewGroup;
  expense: ExpenseReviewGroup;
  keyboardStyle: StyleProp<ViewStyle>;
  memory: MemoryCandidateReviewGroup;
  schedule: ScheduleReviewGroup;
  wallet: WalletDecisionReviewGroup;
};

export function ChatReviewTrays({
  continuity,
  currentState,
  expense,
  keyboardStyle,
  memory,
  schedule,
  wallet,
}: ChatReviewTraysProps) {
  return (
    <>
      <ChatContinuityReviewTray keyboardStyle={keyboardStyle} {...continuity} />
      <ScheduleReviewTray keyboardStyle={keyboardStyle} {...schedule} />
      <WalletDecisionReviewTray keyboardStyle={keyboardStyle} {...wallet} />
      <ExpenseReviewTray keyboardStyle={keyboardStyle} {...expense} />
      <CurrentStateResolveTray
        candidates={currentState.resolveCandidates}
        keyboardStyle={keyboardStyle}
        onDiscard={currentState.onDiscardResolve}
        onSave={currentState.onSaveResolve}
      />
      <CurrentStateCandidateTray
        candidates={currentState.candidates}
        keyboardStyle={keyboardStyle}
        onDiscard={currentState.onDiscard}
        onSave={currentState.onSave}
      />
      <MemoryCandidateTray keyboardStyle={keyboardStyle} {...memory} />
    </>
  );
}

type TrayLayoutProps = {
  keyboardStyle: StyleProp<ViewStyle>;
};

function ScheduleReviewTray({
  formatOccurrenceDateTime,
  keyboardStyle,
  onCancel,
  onDismiss,
  onSaveHabit,
  onSaveSchedule,
  onSaveTodo,
  onScheduleTodo,
  reviews,
}: ScheduleReviewGroup & TrayLayoutProps) {
  if (!reviews.length) return null;

  return (
    <Animated.View style={keyboardStyle}>
      <ScrollView
        horizontal
        contentContainerStyle={styles.candidateRow}
        showsHorizontalScrollIndicator={false}
        style={styles.candidateTray}
      >
        {reviews.map((review) => (
          <View key={review.reviewId} style={styles.scheduleCard}>
            {review.kind === 'create' ? (
              <>
                <Text style={styles.candidateLabel}>待确认日程</Text>
                <Text style={styles.scheduleTitle}>{review.draft.title}</Text>
                <Text style={styles.scheduleMeta}>{formatScheduleDraftDateTime(review.draft)}</Text>
                <Text style={styles.scheduleMeta}>
                  {formatScheduleDraftReminder(review.draft)} · {formatRecurrenceLabel(
                    review.draft.recurrenceRule
                      ?? buildRecurrenceRule(review.draft.recurrence, review.draft.startAt),
                  )}
                </Text>
                {review.sourceReason ? <Text numberOfLines={2} style={styles.scheduleNotes}>来自未解决记忆：{review.sourceReason}</Text> : null}
                {review.draft.notes ? <Text numberOfLines={3} style={styles.scheduleNotes}>{review.draft.notes}</Text> : null}
                <View style={styles.candidateActions}>
                  <Pressable onPress={() => onDismiss(review.reviewId)} style={styles.candidateDismiss}>
                    <Text style={styles.candidateDismissText}>舍弃</Text>
                  </Pressable>
                  <Pressable onPress={() => onSaveSchedule(review)} style={styles.candidateSave}>
                    <Text style={styles.candidateSaveText}>保存</Text>
                  </Pressable>
                </View>
              </>
            ) : review.kind === 'todo' ? (
              <>
                <Text style={styles.candidateLabel}>待确认待办</Text>
                <Text style={styles.scheduleTitle}>{review.draft.title}</Text>
                <Text style={styles.scheduleMeta}>
                  {review.draft.plannedForDate ? `${review.draft.plannedForDate} 会自动进今日待办` : '先放进待办池'}
                </Text>
                {review.sourceReason ? <Text numberOfLines={2} style={styles.scheduleNotes}>来自未解决记忆：{review.sourceReason}</Text> : null}
                {review.draft.notes ? <Text numberOfLines={3} style={styles.scheduleNotes}>{review.draft.notes}</Text> : null}
                <View style={styles.candidateActions}>
                  <Pressable onPress={() => onDismiss(review.reviewId)} style={styles.candidateDismiss}>
                    <Text style={styles.candidateDismissText}>舍弃</Text>
                  </Pressable>
                  <Pressable onPress={() => onSaveTodo(review, 'inbox')} style={styles.candidateDismiss}>
                    <Text style={styles.candidateDismissText}>入池</Text>
                  </Pressable>
                  <Pressable onPress={() => onScheduleTodo(review)} style={styles.candidateDismiss}>
                    <Text style={styles.candidateDismissText}>定时间</Text>
                  </Pressable>
                  <Pressable onPress={() => onSaveTodo(review, 'today')} style={styles.candidateSave}>
                    <Text style={styles.candidateSaveText}>放今日</Text>
                  </Pressable>
                </View>
              </>
            ) : review.kind === 'habit' ? (
              <>
                <Text style={styles.candidateLabel}>待确认习惯</Text>
                <Text style={styles.scheduleTitle}>{review.draft.title}</Text>
                <Text style={styles.scheduleMeta}>
                  每天 · {review.draft.targetCount ?? 1} 次 · 不自动排进日程
                </Text>
                {review.sourceReason ? <Text numberOfLines={3} style={styles.scheduleNotes}>来自未解决记忆：{review.sourceReason}</Text> : null}
                <View style={styles.candidateActions}>
                  <Pressable onPress={() => onDismiss(review.reviewId)} style={styles.candidateDismiss}>
                    <Text style={styles.candidateDismissText}>舍弃</Text>
                  </Pressable>
                  <Pressable onPress={() => onSaveHabit(review)} style={styles.candidateSave}>
                    <Text style={styles.candidateSaveText}>保存</Text>
                  </Pressable>
                </View>
              </>
            ) : (
              <>
                <Text style={styles.candidateLabel}>确认取消</Text>
                <Text style={styles.scheduleTitle}>{review.occurrence.title}</Text>
                <Text style={styles.scheduleMeta}>{formatOccurrenceDateTime(review.occurrence.scheduledStartAt)}</Text>
                {review.occurrence.notes ? <Text numberOfLines={3} style={styles.scheduleNotes}>{review.occurrence.notes}</Text> : null}
                <View style={styles.candidateActions}>
                  <Pressable onPress={() => onDismiss(review.reviewId)} style={styles.candidateDismiss}>
                    <Text style={styles.candidateDismissText}>不删</Text>
                  </Pressable>
                  <Pressable onPress={() => onCancel(review)} style={styles.scheduleDangerButton}>
                    <Text style={styles.scheduleDangerText}>取消这次</Text>
                  </Pressable>
                </View>
              </>
            )}
          </View>
        ))}
      </ScrollView>
    </Animated.View>
  );
}

function WalletDecisionReviewTray({
  keyboardStyle,
  onMark,
  onOpenWallet,
  onSave,
  reviews,
}: WalletDecisionReviewGroup & TrayLayoutProps) {
  if (!reviews.length) return null;

  return (
    <Animated.View style={keyboardStyle}>
      <ScrollView
        horizontal
        contentContainerStyle={styles.candidateRow}
        showsHorizontalScrollIndicator={false}
        style={styles.candidateTray}
      >
        {reviews.map((review) => (
          <View key={review.reviewId} style={styles.scheduleCard}>
            <Text style={styles.candidateLabel}>待确认小金库</Text>
            <Text style={styles.scheduleTitle}>{buildWalletReviewTitle(review.draft.action)}</Text>
            <Text style={styles.scheduleMeta}>
              {review.draft.fundName} · {review.draft.fundCode} · ¥{(review.draft.amount ?? 0).toFixed(2)}
            </Text>
            <Text numberOfLines={2} style={styles.scheduleNotes}>我为什么这样想：{review.draft.reasoning}</Text>
            <Text numberOfLines={2} style={styles.scheduleNotes}>风险小铃铛：{review.draft.riskWarning}</Text>
            <Text numberOfLines={2} style={styles.scheduleNotes}>为什么不多买：{review.draft.whyNotMore}</Text>
            <View style={styles.candidateActions}>
              <Pressable onPress={() => onMark(review, 'deferred')} style={styles.candidateDismiss}>
                <Text style={styles.candidateDismissText}>以后再说</Text>
              </Pressable>
              <Pressable onPress={() => onMark(review, 'rejected')} style={styles.candidateDismiss}>
                <Text style={styles.candidateDismissText}>不买啦</Text>
              </Pressable>
              <Pressable onPress={() => onOpenWallet(review)} style={styles.candidateDismiss}>
                <Text style={styles.candidateDismissText}>去小金库</Text>
              </Pressable>
              <Pressable onPress={() => onSave(review)} style={styles.candidateSave}>
                <Text style={styles.candidateSaveText}>同意记录</Text>
              </Pressable>
            </View>
          </View>
        ))}
      </ScrollView>
    </Animated.View>
  );
}

function ExpenseReviewTray({
  editingNote,
  editingReviewId,
  keyboardStyle,
  onBeginEditing,
  onCancelEditing,
  onChangeNote,
  onDismiss,
  onSave,
  onSaveNote,
  reviews,
}: ExpenseReviewGroup & TrayLayoutProps) {
  if (!reviews.length) return null;

  return (
    <Animated.View style={keyboardStyle}>
      <ScrollView
        horizontal
        contentContainerStyle={styles.candidateRow}
        showsHorizontalScrollIndicator={false}
        style={styles.candidateTray}
      >
        {reviews.map((review) => {
          const editingThisReview = editingReviewId === review.reviewId;
          return (
            <View key={review.reviewId} style={styles.scheduleCard}>
              <Text style={styles.candidateLabel}>待确认账单</Text>
              <Text style={styles.scheduleTitle}>
                {review.draft.type === 'income' ? '收入' : '支出'} {`¥${review.draft.amount.toFixed(2)}`}
              </Text>
              <Text style={styles.scheduleMeta}>
                {review.draft.category} · {new Date(review.draft.occurredAt).toLocaleString('zh-CN', {
                  month: 'long',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                  hour12: false,
                })}
              </Text>
              {editingThisReview ? (
                <TextInput
                  multiline
                  onChangeText={onChangeNote}
                  placeholder="改一下备注"
                  style={styles.expenseNoteInput}
                  value={editingNote}
                />
              ) : (
                <Text numberOfLines={3} style={styles.scheduleNotes}>{review.draft.note}</Text>
              )}
              <View style={styles.candidateActions}>
                {editingThisReview ? (
                  <>
                    <Pressable onPress={onCancelEditing} style={styles.candidateDismiss}>
                      <Text style={styles.candidateDismissText}>取消</Text>
                    </Pressable>
                    <Pressable onPress={() => onSaveNote(review.reviewId)} style={styles.candidateSave}>
                      <Text style={styles.candidateSaveText}>存备注</Text>
                    </Pressable>
                  </>
                ) : (
                  <>
                    <Pressable onPress={() => onDismiss(review.reviewId)} style={styles.candidateDismiss}>
                      <Text style={styles.candidateDismissText}>舍弃</Text>
                    </Pressable>
                    <Pressable onPress={() => onBeginEditing(review)} style={styles.candidateDismiss}>
                      <Text style={styles.candidateDismissText}>改备注</Text>
                    </Pressable>
                    <Pressable onPress={() => onSave(review)} style={styles.candidateSave}>
                      <Text style={styles.candidateSaveText}>保存</Text>
                    </Pressable>
                  </>
                )}
              </View>
            </View>
          );
        })}
      </ScrollView>
    </Animated.View>
  );
}

function CurrentStateCandidateTray({
  candidates,
  keyboardStyle,
  onDiscard,
  onSave,
}: {
  candidates: Array<MemoryCurrentStateCandidate | MemoryCurrentStateResolveCandidate>;
  onDiscard: (reviewId: string) => void;
  onSave: (reviewId: string) => void | Promise<void>;
} & TrayLayoutProps) {
  const [busyIds, setBusyIds] = useState(new Set<string>());
  const [notices, setNotices] = useState<Record<string, string>>({});
  const inFlight = useRef(new Set<string>());
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const { height, width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const recheck = async (reviewId: string) => {
    if (inFlight.current.has(reviewId)) return;
    inFlight.current.add(reviewId); setBusyIds(new Set(inFlight.current));
    try { await onSave(reviewId); }
    catch (error) { if (live.current) setNotices(current => ({ ...current, [reviewId]: error instanceof Error ? error.message : '核对未完成，旧稿仍保留。' })); }
    finally { inFlight.current.delete(reviewId); if (live.current) setBusyIds(new Set(inFlight.current)); }
  };
  if (!candidates.length) return null;

  return (
    <Animated.View style={keyboardStyle}>
      <ScrollView
        horizontal
        contentContainerStyle={styles.candidateRow}
        showsHorizontalScrollIndicator={false}
        style={styles.candidateTray}
      >
        {candidates.map((candidate) => (
          <View key={candidate.reviewId} style={[styles.scheduleCard, { height: Math.max(96, Math.min(320, (height - insets.top - insets.bottom) * 0.4)), width: Math.min(292, Math.max(160, width - insets.left - insets.right - 48)) }]}>
            <Text style={styles.candidateLabel}>旧近况待核对 · {'stateId' in candidate ? '收起' : '新建'}</Text>
            <ScrollView nestedScrollEnabled keyboardShouldPersistTaps="handled" style={styles.memoryCardBody}>
            <Text style={styles.scheduleTitle}>{candidate.title}</Text>
            <Text selectable style={styles.scheduleNotes}>{candidate.content}</Text>
            <CurrentStateCandidateEvidence candidate={candidate} />
            <Text style={styles.candidateHint}>重新核对后会生成待确认候选，当前旧稿不会直接保存。</Text>
            {notices[candidate.reviewId] ? <Text style={styles.candidateHint}>{notices[candidate.reviewId]}</Text> : null}
            </ScrollView>
            <View style={[styles.candidateActions, styles.memoryCardActions]}>
              <Pressable disabled={busyIds.has(candidate.reviewId)} onPress={() => onDiscard(candidate.reviewId)} style={styles.candidateDismiss}>
                <Text style={styles.candidateDismissText}>舍弃</Text>
              </Pressable>
              <Pressable disabled={busyIds.has(candidate.reviewId)} onPress={() => void recheck(candidate.reviewId)} style={styles.candidateSave}>
                <Text style={styles.candidateSaveText}>{busyIds.has(candidate.reviewId) ? '核对中…' : '重新核对'}</Text>
              </Pressable>
            </View>
          </View>
        ))}
      </ScrollView>
    </Animated.View>
  );
}

const CurrentStateResolveTray = CurrentStateCandidateTray;

function getMemoryCandidateDisplay(candidate: MemoryCandidateReview) {
  if (candidate.weeklyRefresh) {
    return { hint: '确认后更新原周脉络，周范围保持不变', label: '待确认周脉络更新' };
  }
  if (candidate.origin === 'weekly') {
    return { hint: '这一周的连续总结，不是单条事实', label: '本周脉络' };
  }
  if (candidate.origin === 'episode') {
    return { hint: '一段经历的回顾，不是单条事实', label: '阶段记忆' };
  }
  if (candidate.origin === 'proposal') {
    const policy = getMemoryCandidateKindPolicy(candidate);
    return { hint: policy.hint, label: `待确认${policy.label}` };
  }
  const kind = getMemoryCandidateKind(candidate);
  return {
    hint: kind === 'long_term' ? '' : getMemoryCandidateKindPolicy(candidate).hint,
    label: '待确认记忆',
  };
}

function MemoryCandidateTray({
  candidates,
  keyboardStyle,
  onAdjustImportance,
  onDiscard,
  onSave,
  onToggleAnchor,
  onTogglePinned,
  onUpdate: updateFromParent,
}: MemoryCandidateReviewGroup & TrayLayoutProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [busyIds, setBusyIds] = useState(new Set<string>());
  const [notices, setNotices] = useState<Record<string, string>>({});
  const [checked, setChecked] = useState<Record<string, { candidate: MemoryCandidateReview; status: MemoryCandidateReview['reviewStatus'] }>>({});
  const inFlight = useRef(new Set<string>());
  const live = useRef(true);
  const latestCandidates = useRef(candidates);
  latestCandidates.current = candidates;
  const onUpdate = (id: string, patch: Partial<MemoryCandidateReview>) => {
    latestCandidates.current = latestCandidates.current.map(item => item.reviewId === id ? { ...item, ...patch } : item);
    updateFromParent(id, patch);
  };
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const run = async (candidate: MemoryCandidateReview, action: 'save' | 'discard' | 'recheck', index: number) => {
    if (inFlight.current.has(candidate.reviewId)) return;
    inFlight.current.add(candidate.reviewId); setBusyIds(new Set(inFlight.current));
    setNotices(current => ({ ...current, [candidate.reviewId]: '' }));
    try {
      const latest = latestCandidates.current.find(item => item.reviewId === candidate.reviewId);
      if (!latest) return;
      if (action === 'save') await onSave(latest, index);
      else if (action === 'recheck') {
        if (latest.shiyingBindings?.length) {
          const updated = await (await import('../shiying/shiyingMemoryReview')).recheckShiyingMemoryCandidate(latest);
          if (live.current) onUpdate(latest.reviewId, updated);
        }
        else if (latest.readingBinding) {
          const updated = await (await import('../reading/readingMemoryReview')).recheckReadingMemoryCandidate(latest);
          if (live.current) onUpdate(latest.reviewId, updated.candidate);
        }
        else if (latest.readingBindings?.length) {
          const updated = await (await import('../reading/readingMemoryOrganizationReview')).recheckReadingOrganizationCandidate(latest);
          if (live.current) onUpdate(latest.reviewId, updated);
        }
        else if (latest.currentStateReview) await recheckCurrentStateCandidate(latest);
        else if (latest.continuationReview || latest.letterBindings?.length || latest.observationBindings?.length) await recheckConversationMemoryCandidate(latest);
        else await recheckWeeklyRefreshCandidate(latest);
      }
      else await onDiscard(candidate.reviewId);
    } catch {
      if (live.current) setNotices(current => ({ ...current, [candidate.reviewId]: '操作未完成，输入已保留；请核对原卡和材料后重试。' }));
    } finally {
      inFlight.current.delete(candidate.reviewId);
      if (live.current) setBusyIds(new Set(inFlight.current));
    }
  };
  const [keyboardTop, setKeyboardTop] = useState(() => Keyboard.metrics()?.screenY);
  const { height, width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  useEffect(() => {
    const shown = Keyboard.addListener('keyboardDidShow', event => setKeyboardTop(event.endCoordinates.screenY));
    const hidden = Keyboard.addListener('keyboardDidHide', () => setKeyboardTop(undefined));
    return () => { shown.remove(); hidden.remove(); };
  }, []);
  // The existing composer owns navigation-bar padding and keyboard translation.
  // Limit only this tray, leaving room above it to keep reading the conversation.
  const visibleHeight = Math.max(0, Math.min(height, keyboardTop ?? height) - insets.top - insets.bottom);
  const cardHeight = Math.max(96, Math.min(360, visibleHeight * 0.45));
  const cardWidth = Math.min(292, Math.max(160, width - insets.left - insets.right - 48));
  if (!candidates.length) return null;

  return (
    <Animated.View style={keyboardStyle}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: !collapsed }}
        onPress={() => { Keyboard.dismiss(); setCollapsed(value => !value); }}
        style={styles.memoryTrayToggle}
      >
        <Text style={styles.candidateDismissText}>待确认记忆 · {candidates.length}</Text>
        <Text style={styles.candidateSaveText}>{collapsed ? '展开' : '收起'}</Text>
      </Pressable>
      {!collapsed ? (
      <ScrollView
        horizontal
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.candidateRow}
        showsHorizontalScrollIndicator={false}
        style={styles.candidateTray}
      >
        {candidates.map((candidate, index) => {
          if (candidate.currentStateReview) return <MemoryCurrentStateCard key={candidate.reviewId} candidate={candidate}
            busy={busyIds.has(candidate.reviewId)} notice={notices[candidate.reviewId]} chatSize={{ height: cardHeight, width: cardWidth }}
            onUpdate={patch => onUpdate(candidate.reviewId, patch)} onSave={() => void run(candidate, 'save', index)}
            onDiscard={() => void run(candidate, 'discard', index)} onRecheck={() => run(candidate, 'recheck', index)} />;
          if (candidate.understandingSubject) return <MemoryUnderstandingCard key={candidate.reviewId} candidate={candidate}
            chatSize={{ height: cardHeight, width: cardWidth }}
            onUpdate={patch => onUpdate(candidate.reviewId, patch)} onSave={() => onSave(candidate, index)} onDiscard={() => onDiscard(candidate.reviewId)} />;
          const display = getMemoryCandidateDisplay(candidate);
          const busy = busyIds.has(candidate.reviewId);
          const manualEventTimeText = candidate.manualEventTimeText
            ?? formatMemoryEventTimeInput(candidate.eventTime);
          const manualEventTimeValid = !manualEventTimeText.trim()
            || parseManualMemoryEventTime(manualEventTimeText)?.startAt !== undefined;
          const frozenWeek = candidate.origin === 'weekly' || candidate.source === 'weekly-context' || !!candidate.weeklyRefresh;
          const shouldReviewEventTime = !frozenWeek && (!!candidate.eventTime
            || ['event', 'relationship_change', 'stage_conclusion'].includes(candidate.atomicKind ?? ''));
          const technicalLabel = [
            getMemoryAtomicKindLabel(candidate.atomicKind ?? 'unknown'),
            getMemoryCandidateKindPolicy(candidate).label,
            formatMemoryEventTimeLabel(candidate.eventTime),
            getMemoryExtractionBasisLabel(candidate.extractionBasis ?? 'unknown'),
            '自动整理',
          ].join(' · ');
          return (
            <View key={candidate.reviewId} style={[styles.candidateCard, { height: cardHeight, width: cardWidth }]}>
              <Text style={styles.candidateLabel}>{display.label}</Text>
              <ScrollView nestedScrollEnabled keyboardShouldPersistTaps="handled" style={styles.memoryCardBody}>
              <MemoryCandidateComparison candidate={candidate} disabled={busy} onUpdate={patch => onUpdate(candidate.reviewId, patch)}
                onStatusChange={status => setChecked(current => ({ ...current, [candidate.reviewId]: { candidate, status } }))}
                onRecheck={() => run(candidate, 'recheck', index)} />
              {notices[candidate.reviewId] ? <Text accessibilityLiveRegion="polite" style={styles.candidateHint}>{notices[candidate.reviewId]}</Text> : null}
              {display.hint ? <Text style={styles.candidateHint}>{display.hint}</Text> : null}
              <Text style={styles.candidateHint}>{technicalLabel}</Text>
              {candidate.admission ? (
                <Text style={styles.candidateHint}>
                  {candidate.admission.label}：{candidate.admission.reasons.slice(0, 2).join('；')}
                </Text>
              ) : null}
              {frozenWeek ? (
                <Text style={styles.candidateHint}>
                  原周范围（固定）：{candidate.weeklyContextBasis
                    ? `${new Date(candidate.weeklyContextBasis.startAt).toLocaleDateString('zh-CN')} 至 ${new Date(candidate.weeklyContextBasis.endAt - 1).toLocaleDateString('zh-CN')}`
                    : formatMemoryEventTimeLabel(candidate.eventTime)}
                </Text>
              ) : null}
              {candidate.weeklyRefresh ? (
                <>
                  <Text style={styles.candidateLabel}>原周脉络 · {candidate.weeklyRefresh.previousTitle}</Text>
                  <TextInput
                    accessibilityLabel="原周脉络正文"
                    editable={false}
                    multiline
                    style={[styles.candidateInput, styles.episodeCandidateInput]}
                    textAlignVertical="top"
                    value={candidate.weeklyRefresh.previousContent}
                  />
                  <Text style={styles.candidateLabel}>新候选</Text>
                </>
              ) : null}
              {candidate.continuationReview?.targetMemoryId ? <>
                <Text style={styles.candidateLabel}>原稿 · {candidate.continuationReview.previousTitle}</Text>
                <Text selectable style={styles.candidateHint}>{candidate.continuationReview.previousContent}</Text>
                <Text style={styles.candidateLabel}>新稿</Text>
              </> : null}
              {shouldReviewEventTime ? (
                <>
                  <Text style={styles.candidateHint}>
                    事件时间（可纠正；没有足够日期线索时可以留空）
                  </Text>
                  <TextInput
                    autoCapitalize="none"
                    editable={!busy}
                    onChangeText={(value) => {
                      const eventTime = parseManualMemoryEventTime(value);
                      onUpdate(candidate.reviewId, {
                        eventAt: eventTime?.startAt,
                        eventTime,
                        manualEventTimeText: value,
                      });
                    }}
                    placeholder="2026-07-28 或 2026-07-28 至 2026-07-29"
                    placeholderTextColor={colors.muted}
                    style={styles.candidateTagInput}
                    value={manualEventTimeText}
                  />
                  {!manualEventTimeValid ? (
                    <Text style={styles.candidateHint}>时间格式尚未确认，将按“时间未确定”保存</Text>
                  ) : null}
                </>
              ) : null}
              <TextInput
                editable={!busy}
                onChangeText={(value) => onUpdate(candidate.reviewId, { title: value })}
                placeholder="记忆标题"
                placeholderTextColor={colors.muted}
                style={styles.candidateTitleInput}
                value={candidate.title}
              />
              <TextInput
                editable={!busy}
                multiline
                onChangeText={(value) => onUpdate(candidate.reviewId, { content: value })}
                style={[
                  styles.candidateInput,
                  (candidate.origin === 'episode' || candidate.origin === 'weekly') && styles.episodeCandidateInput,
                ]}
                textAlignVertical="top"
                value={candidate.content}
              />
              <TextInput
                editable={!busy}
                onChangeText={(value) => onUpdate(candidate.reviewId, {
                  tags: value.split(/[，,、\s]+/).filter(Boolean),
                })}
                placeholder="标签，用顿号隔开"
                placeholderTextColor={colors.muted}
                style={styles.candidateTagInput}
                value={candidate.tags.join('、')}
              />
              <TextInput editable={!busy} value={candidate.recallCues.join('、')}
                onChangeText={value => onUpdate(candidate.reviewId, { recallCues: value.split(/[，,、\s]+/).filter(Boolean) })}
                placeholder="回想线索，用顿号隔开" placeholderTextColor={colors.muted} style={styles.candidateTagInput} />
              <TextInput editable={!busy} multiline value={candidate.rememberedReason ?? ''}
                onChangeText={rememberedReason => onUpdate(candidate.reviewId, { rememberedReason })}
                placeholder="记住的理由" placeholderTextColor={colors.muted} style={styles.candidateTagInput} />
              <MemoryEpisodeSummaryEditor candidate={candidate} disabled={busy} onUpdate={patch => onUpdate(candidate.reviewId, patch)} />
              <ScrollView horizontal contentContainerStyle={styles.candidateDomainRow} showsHorizontalScrollIndicator={false}>
                {MEMORY_DOMAINS.map((domain) => (
                  <Pressable
                    key={domain}
                    disabled={busy}
                    onPress={() => onUpdate(candidate.reviewId, { domain })}
                    style={[styles.candidateDomain, candidate.domain === domain && styles.candidateDomainActive]}
                  >
                    <Text style={[styles.candidateTags, candidate.domain === domain && styles.candidateDomainTextActive]}>{domain}</Text>
                  </Pressable>
                ))}
              </ScrollView>
              <View style={styles.candidateMeta}>
                <View style={styles.candidateScore}>
                  <Text style={styles.candidateTags}>重要度</Text>
                  <Pressable disabled={busy} onPress={() => onAdjustImportance(candidate.reviewId, -1)} style={styles.candidateStep}>
                    <Text style={styles.candidateTags}>-</Text>
                  </Pressable>
                  <Text style={styles.candidateTags}>{candidate.importance}</Text>
                  <Pressable disabled={busy} onPress={() => onAdjustImportance(candidate.reviewId, 1)} style={styles.candidateStep}>
                    <Text style={styles.candidateTags}>+</Text>
                  </Pressable>
                </View>
                <View style={styles.candidateToggles}>
                  <Pressable
                    disabled={busy}
                    onPress={() => onToggleAnchor(candidate.reviewId)}
                    style={[styles.candidatePin, candidate.anchor && styles.candidateAnchorActive]}
                  >
                    <Text style={styles.candidateTags}>
                      {candidate.anchor ? `${getAnchorKindLabel(candidate.anchorKind)}坐标` : '设锚点'}
                    </Text>
                  </Pressable>
                  <Pressable
                    disabled={busy}
                    onPress={() => onTogglePinned(candidate.reviewId)}
                    style={[styles.candidatePin, candidate.pinned && styles.candidatePinActive]}
                  >
                    <Text style={styles.candidateTags}>{candidate.pinned ? '钉住' : '设钉住'}</Text>
                  </Pressable>
                </View>
              </View>
              </ScrollView>
              <View style={[styles.candidateActions, styles.memoryCardActions]}>
                <Pressable disabled={busy} onPress={() => void run(candidate, 'discard', index)} style={styles.candidateDismiss}>
                  <Text style={styles.candidateDismissText}>舍弃</Text>
                </Pressable>
                <Pressable disabled={busy || (!!candidate.continuationReview && !!candidate.reviewStatus && candidate.reviewStatus !== 'current')
                  || (!!(candidate.letterBindings?.length || candidate.observationBindings?.length) && (checked[candidate.reviewId]?.candidate !== candidate
                    || checked[candidate.reviewId]?.status !== 'current'))
                  || !candidate.title.trim() || !candidate.content.trim()} onPress={() => void run(candidate, 'save', index)} style={styles.candidateSave}>
                  <Text style={styles.candidateSaveText}>{busy ? '处理中…' : '保存'}</Text>
                </Pressable>
              </View>
            </View>
          );
        })}
      </ScrollView>
      ) : null}
    </Animated.View>
  );
}
