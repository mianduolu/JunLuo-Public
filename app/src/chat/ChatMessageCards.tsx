import { useState } from 'react';
import { Pressable, Switch, View } from 'react-native';
import type {
  GoalTimeCreditCard,
  ScheduleChangeCard,
  SchedulePlanCard,
} from '../ai/subjectiveMessages';
import { AppText as Text } from '../components/AppText';
import { DateTimePickerSheet } from '../components/DateTimePickerSheet';
import {
  clockFromTimestamp,
  combineDateTime,
  dateKeyFromTimestamp,
  type DateTimeSelection,
} from '../schedule/dateTimeSelection';
import type { ClassifiedTask } from '../schedule/dayScheduler';
import type { DayPlanChange } from '../schedule/dayPlan';
import { ChatDayPlanRows } from './ChatDayPlanRows';
import { ChatMemoryCorrectionFields } from './ChatMemoryCorrectionFields';
import { ChatTextFileReader } from './ChatTextFileReader';
import { getCategoryConfig, getQuadrantConfig } from '../schedule/taskMeta';
import { styles } from '../screens/ChatScreen.styles';
import { formatMessageTime } from './chatMessageDisplay';
import { formatChatDateTime } from './chatScheduleText';
import type { JunLuoToolCallCard } from './toolCallMessageTypes';
import {
  decideToolAgentFrozenProposal,
  getToolAgentFrozenProposalInput,
  type JunLuoToolAgentConfirmationPresentation,
} from '../tools/toolAgentFrozenProposal';
import {
  amendScheduleCreateEventConfirmationCompanion,
  amendScheduleCreateEventConfirmationTimes,
} from '../tools/toolAgentConfirmationPresenter';

const quadrantEmoji: Record<ClassifiedTask['quadrant'], string> = {
  q1: '🔴',
  q2: '🟡',
  q3: '🔵',
  q4: '🟣',
};

export function formatPlanTaskMeta({
  category,
  quadrant,
  estimatedMinutes,
}: {
  category: ClassifiedTask['category'];
  quadrant: ClassifiedTask['quadrant'];
  estimatedMinutes?: number;
}) {
  const categoryConfig = getCategoryConfig(category);
  const quadrantConfig = getQuadrantConfig(quadrant);
  return [
    `${categoryConfig.icon} ${categoryConfig.label}`,
    `${quadrantEmoji[quadrant]} ${quadrantConfig.title}`,
    estimatedMinutes ? `${estimatedMinutes}分钟` : '待估时',
  ].join(' · ');
}

type ChatGoalTimeCreditCardProps = {
  card: GoalTimeCreditCard;
  onConfirm: () => void;
  onEdit: () => void;
  onSkip: () => void;
};

export function ChatGoalTimeCreditCard({ card, onConfirm, onEdit, onSkip }: ChatGoalTimeCreditCardProps) {
  return (
    <View style={styles.groupScheduleCard}>
      <Text style={styles.candidateLabel}>时间目标 · 待确认投入</Text>
      <Text style={styles.groupScheduleTitle}>{card.todoTitle}</Text>
      <Text style={styles.unscheduledText}>白云建议按 {card.suggestedMinutes} 分钟计算{card.reason ? ` · ${card.reason}` : ''}</Text>
      {card.status === 'pending' ? (
        <View style={styles.groupScheduleActions}>
          <Pressable onPress={onSkip} style={styles.groupScheduleGhost}>
            <Text style={styles.candidateDismissText}>这次不计</Text>
          </Pressable>
          <Pressable onPress={onEdit} style={styles.groupScheduleGhost}>
            <Text style={styles.candidateDismissText}>改分钟</Text>
          </Pressable>
          <Pressable onPress={onConfirm} style={styles.candidateSave}>
            <Text style={styles.candidateSaveText}>按这个算</Text>
          </Pressable>
        </View>
      ) : (
        <Text style={styles.adjustmentHint}>{card.status === 'confirmed' ? `已记入 ${card.suggestedMinutes} 分钟` : card.status === 'skipped' ? '这次没有计入目标' : '这次记录已撤销'}</Text>
      )}
    </View>
  );
}

type ChatScheduleChangeCardProps = {
  card: ScheduleChangeCard;
  onCancel: () => void;
  onConfirm: () => void;
};

export function ChatScheduleChangeCard({ card, onCancel, onConfirm }: ChatScheduleChangeCardProps) {
  const actionable = card.status === 'pending';
  const statusText =
    card.status === 'confirmed' ? '已同步'
      : card.status === 'cancelled' ? '已放下'
        : card.status === 'failed' ? '同步失败'
          : '待确认变更';
  const kindText =
    card.kind === 'delete-schedule' || card.kind === 'delete-todo' ? '删除'
      : '改时间';
  return (
    <View style={styles.groupScheduleCard}>
      <View style={styles.groupScheduleHeader}>
        <View style={styles.groupScheduleTask}>
          <Text style={styles.candidateLabel}>{statusText} · {kindText}</Text>
          <Text numberOfLines={2} style={styles.groupScheduleDate}>{card.title}</Text>
        </View>
        <Text style={styles.groupScheduleCount}>
          {card.bulkOccurrences?.length ? `${card.bulkOccurrences.length} 条日程` : card.kind.includes('schedule') ? '日程' : '待办'}
        </Text>
      </View>
      <View style={styles.scheduleChangeDiff}>
        <Text style={styles.unscheduledText}>现在：{card.before}</Text>
        {card.after ? <Text style={styles.unscheduledText}>改成：{card.after}</Text> : null}
        {card.bulkOccurrences?.slice(0, 5).map((item) => (
          <Text key={item.occurrenceId} style={styles.unscheduledText}>
            · {formatChatDateTime(item.scheduledStartAt)} {item.title}
          </Text>
        ))}
        {card.bulkOccurrences && card.bulkOccurrences.length > 5 ? (
          <Text style={styles.adjustmentHint}>还有 {card.bulkOccurrences.length - 5} 条没有展开显示。</Text>
        ) : null}
        {card.kind.startsWith('delete') ? <Text style={styles.adjustmentHint}>确认后会从日程/待办里移除。</Text> : null}
      </View>
      {actionable ? (
        <View style={styles.groupScheduleActions}>
          <Pressable hitSlop={10} onPress={onCancel} style={styles.groupScheduleGhost}>
            <Text style={styles.candidateDismissText}>不要改</Text>
          </Pressable>
          <Pressable hitSlop={10} onPress={onConfirm} style={styles.groupScheduleSave}>
            <Text style={styles.candidateSaveText}>确认同步</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

type ChatSchedulePlanCardProps = {
  card: SchedulePlanCard;
  onAdjust: () => void;
  onConfirm: () => void;
  onDiscard: () => void;
  saving: boolean;
  onEditEntry?: (entryId: string, change: DayPlanChange) => void;
  onSetEndQuestions?: (enabled: boolean) => void;
  onRemoveEntry?: (entryId: string) => void;
};

export function ChatSchedulePlanCard({ card, onAdjust, onConfirm, onDiscard, saving, onEditEntry, onRemoveEntry, onSetEndQuestions }: ChatSchedulePlanCardProps) {
  const plan = card.plan;
  const actionable = card.status === 'pending' || card.status === 'conflict';
  return (
    <View style={styles.groupScheduleCard}>
      <View style={styles.groupScheduleHeader}>
        <View>
          <Text style={styles.candidateLabel}>
            {card.status === 'confirmed' ? '已保存的安排' : card.status === 'cancelled' ? '已放下的安排' : card.status === 'conflict' ? '需要重新调整' : '待确认整组安排'}
          </Text>
          <Text style={styles.groupScheduleDate}>{plan.dateKey}</Text>
        </View>
        <Text style={styles.groupScheduleCount}>
          {plan.dayPlan ? `${plan.dayPlan.entries.length} 项` : `${plan.scheduled.slots.length} 个时间块${plan.inhibitTasks?.length ? ` · ${plan.inhibitTasks.length} 个持续提醒` : ''}`}
        </Text>
      </View>
      {plan.dayPlan ? (
        <ChatDayPlanRows entries={plan.dayPlan.entries} editable={actionable && !saving} onEditEntry={onEditEntry} onRemoveEntry={onRemoveEntry} onSetEndQuestions={onSetEndQuestions} />
      ) : <>
      {plan.scheduled.slots.map((slot) => (
        <View key={`${slot.taskId}-${slot.segmentIndex}`} style={styles.groupScheduleRow}>
          <Text style={styles.groupScheduleTime}>
            {new Date(slot.startAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}
          </Text>
          <View style={styles.groupScheduleTask}>
            <Text numberOfLines={2} style={styles.groupScheduleTitle}>{slot.displayTitle}</Text>
            <Text style={styles.scheduleMeta}>
              {formatPlanTaskMeta({ category: slot.category, quadrant: slot.quadrant, estimatedMinutes: slot.estimatedMinutes })}
            </Text>
          </View>
        </View>
      ))}
      {plan.scheduled.floatingCommitments.length ? (
        <View style={styles.unscheduledSection}>
          <Text style={styles.unscheduledHeading}>每日挑战 · 找时间做</Text>
          {plan.scheduled.floatingCommitments.map((item) => (
            <Text key={item.id} style={styles.unscheduledText}>· {item.title}（{item.estimatedMinutes}分钟）</Text>
          ))}
        </View>
      ) : null}
      {plan.scheduled.unscheduled.length ? (
        <View style={styles.unscheduledSection}>
          <Text style={styles.unscheduledHeading}>找时间做</Text>
          {plan.scheduled.unscheduled.map(({ task, reason }) => (
            <Text key={task.id} style={styles.unscheduledText}>
              · {task.title}（{formatPlanTaskMeta(task)} · {reason === 'missing-estimate' ? '待补估时' : '当天暂时放不下'}）
            </Text>
          ))}
        </View>
      ) : null}
      {plan.inhibitTasks?.length ? (
        <View style={styles.unscheduledSection}>
          <Text style={styles.unscheduledHeading}>今天轻轻记着</Text>
          {plan.inhibitTasks.map((task) => (
            <Text key={task.id} style={styles.unscheduledText}>· {task.title}（持续到手动结束）</Text>
          ))}
        </View>
      ) : null}
      {plan.reviewSuggestions.length ? (
        <View style={styles.planReviewSection}>
          <Text style={styles.unscheduledHeading}>白云看了一眼</Text>
          {plan.reviewSuggestions.map((suggestion) => <Text key={suggestion} style={styles.unscheduledText}>· {suggestion}</Text>)}
        </View>
      ) : null}
      </>}
      {actionable ? (
        <View style={styles.groupScheduleActions}>
          <Pressable disabled={saving} hitSlop={10} onPress={onDiscard} style={styles.groupScheduleGhost}>
            <Text style={styles.candidateDismissText}>不想排了</Text>
          </Pressable>
          <Pressable disabled={saving} hitSlop={10} onPress={onAdjust} style={styles.groupScheduleGhost}>
            <Text style={styles.candidateDismissText}>调整</Text>
          </Pressable>
          <Pressable disabled={saving} hitSlop={10} onPress={onConfirm} style={styles.groupScheduleSave}>
            <Text style={styles.candidateSaveText}>{saving ? '保存中' : plan.dayPlan?.entries.some((entry) => entry.saved) ? '重试未成功项' : '就这样'}</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

type ChatToolCallCardsProps = {
  cards: JunLuoToolCallCard[];
  messageId?: string;
  wishBusy?: boolean;
  onWishInvite?: (callId: string) => void;
  onProposalAdjusted?: (
    proposalId: string,
    presentation: JunLuoToolAgentConfirmationPresentation,
  ) => void;
};

type ScheduleEndAdjustment = {
  proposalId: string;
  startAt: number;
  value: DateTimeSelection;
};

function scheduleEndAdjustment(proposalId: string): ScheduleEndAdjustment | null {
  const input = getToolAgentFrozenProposalInput(proposalId);
  const startAt = input?.startAt;
  if (typeof startAt !== 'number' || !Number.isFinite(startAt)) return null;
  const endAt = typeof input?.endAt === 'number' && Number.isFinite(input.endAt)
    ? input.endAt
    : undefined;
  const date = dateKeyFromTimestamp(startAt);
  return {
    proposalId,
    startAt,
    value: {
      date,
      time: clockFromTimestamp(startAt),
      endTime: endAt === undefined ? undefined : clockFromTimestamp(endAt),
      estimateMinutes: endAt === undefined ? undefined : Math.max(1, Math.round((endAt - startAt) / 60_000)),
      recurrence: 'none',
      reminderChoice: 'none',
      reminderClock: '09:00',
      reminderIntensity: 'gentle',
    },
  };
}

export function ChatToolCallCards({ cards, messageId, onProposalAdjusted, wishBusy, onWishInvite }: ChatToolCallCardsProps) {
  const [endAdjustment, setEndAdjustment] = useState<ScheduleEndAdjustment | null>(null);
  const [, refreshCorrectionInput] = useState(0);
  if (!cards.length) return null;
  return (
    <>
      <View style={styles.toolCallCardStack}>
        {cards.map((card) => {
          const statusText =
            card.status === 'success' ? (card.toolId.startsWith('wish.') ? '已保存结果' : '已完成')
              : card.status === 'running' ? '执行中'
                : card.status === 'awaiting_permission' ? '等待权限'
                  : card.status === 'awaiting_confirmation' && card.confirmationDecision === 'expired' ? '确认已过期'
                    : card.status === 'awaiting_confirmation' ? '等待确认'
                      : card.status === 'outcome_unknown' ? '结果待核对'
                        : card.status === 'requested' ? '等待确认'
                          : card.status === 'permission_denied' ? '未允许'
                            : card.status === 'cancelled' ? '已取消'
                              : '执行失败';
          const statusStyle =
            card.status === 'success' ? styles.toolCallStatusSuccess
              : card.status === 'running' || card.status === 'requested' || card.status === 'awaiting_permission' || card.status === 'awaiting_confirmation' || card.status === 'outcome_unknown' ? styles.toolCallStatusRunning
                : styles.toolCallStatusError;
          const memoryCorrection = card.toolId === 'memory.update';
          const pendingConfirmation = card.status === 'awaiting_confirmation' && card.confirmationDecision === 'pending' && !!card.proposalId;
          const correctionInput = memoryCorrection && card.proposalId ? getToolAgentFrozenProposalInput(card.proposalId) : null;
          const correctionReady = !memoryCorrection || (
            typeof correctionInput?.title === 'string' && !!correctionInput.title.trim()
            && typeof correctionInput?.content === 'string' && !!correctionInput.content.trim()
          );
          const finishedAt = card.finishedAt ?? card.startedAt ?? card.createdAt;
          const completionFollowUpEnabled = card.proposalId
            ? getToolAgentFrozenProposalInput(card.proposalId)?.companionEnabled === true
            : false;
          return (
            <View key={card.callId} style={[
              styles.toolCallCard,
              card.status === 'success' ? styles.toolCallCardSuccess : null,
              card.status === 'error' || card.status === 'permission_denied' || card.status === 'cancelled' ? styles.toolCallCardError : null,
            ]}>
            <View style={styles.toolCallHeader}>
              <View style={styles.groupScheduleTask}>
                <Text numberOfLines={2} style={styles.toolCallTitle}>{card.toolName}</Text>
              </View>
              <Text style={[styles.toolCallStatus, statusStyle]}>{statusText}</Text>
            </View>
            {memoryCorrection && pendingConfirmation && card.confirmationPresentation ? (
              <ChatMemoryCorrectionFields
                key={card.proposalId}
                proposalId={card.proposalId!}
                presentation={card.confirmationPresentation}
                editable={!!correctionInput}
                onProposalAdjusted={(proposalId, presentation) => {
                  refreshCorrectionInput((revision) => revision + 1);
                  onProposalAdjusted?.(proposalId, presentation);
                }}
              />
            ) : card.confirmationPresentation ? (
              <View style={styles.toolCallPreview}>
                {card.confirmationPresentation.summary ? (
                  <Text style={styles.toolCallSummary}>{card.confirmationPresentation.summary}</Text>
                ) : null}
                {card.confirmationPresentation.fields.map((field) => (
                  <Text key={`${field.label}:${field.value}`} numberOfLines={memoryCorrection ? undefined : 2} style={styles.toolCallPreviewText}>
                    {field.label}：{field.value}
                  </Text>
                ))}
              </View>
            ) : null}
            {card.resultSummary ? (
              <Text style={styles.toolCallSummary}>{card.toolId.startsWith('wish.')
                ? card.resultSummary.replace(/\bI\b/g, '白云小姐').replace(/\byou\b/g, '小仓鼠')
                : card.resultSummary}</Text>
            ) : card.errorMessage ? (
              <Text style={styles.toolCallErrorText}>{card.errorMessage}</Text>
            ) : (
              <Text style={styles.toolCallHint}>
                {card.status === 'running' ? '正在执行真实工具...' : '等待权限确认或执行结果。'}
              </Text>
            )}
            {messageId && card.status === 'success' && card.fileReference ? (
              <ChatTextFileReader messageId={messageId} card={card} />
            ) : null}
            {card.status === 'awaiting_confirmation' && card.confirmationDecision === 'pending' && card.proposalId ? (
              <>
                {card.toolId === 'schedule.create_event' ? (
                  <View style={styles.toolCallToggleRow}>
                    <View style={styles.groupScheduleTask}>
                      <Text style={styles.toolCallToggleTitle}>结束时来问问我</Text>
                      <Text style={styles.toolCallPreviewText}>没回应时再追问一次</Text>
                    </View>
                    <Switch
                      onValueChange={(companionEnabled) => {
                        const amended = amendScheduleCreateEventConfirmationCompanion({
                          proposalId: card.proposalId!,
                          companionEnabled,
                        });
                        if (amended) onProposalAdjusted?.(amended.proposalId, amended.presentation);
                      }}
                      trackColor={{ false: '#E7E1EF', true: '#B2D9FF' }}
                      thumbColor={completionFollowUpEnabled ? '#5C9DD8' : '#FFFFFF'}
                      value={completionFollowUpEnabled}
                    />
                  </View>
                ) : null}
                <View style={styles.groupScheduleActions}>
                  {card.toolId === 'schedule.create_event' ? (
                  <Pressable
                    hitSlop={10}
                    onPress={() => setEndAdjustment(scheduleEndAdjustment(card.proposalId!))}
                    style={styles.groupScheduleGhost}
                  >
                    <Text style={styles.candidateDismissText}>调整结束</Text>
                  </Pressable>
                  ) : null}
                  <Pressable
                  hitSlop={10}
                  onPress={() => {
                    decideToolAgentFrozenProposal(card.proposalId!, 'declined');
                    if (memoryCorrection) refreshCorrectionInput((revision) => revision + 1);
                  }}
                  style={styles.groupScheduleGhost}
                >
                  <Text style={styles.candidateDismissText}>{memoryCorrection ? '取消' : '不执行'}</Text>
                  </Pressable>
                  <Pressable
                  disabled={!correctionReady}
                  accessibilityState={{ disabled: !correctionReady }}
                  hitSlop={10}
                  onPress={() => {
                    if (memoryCorrection) {
                      const input = getToolAgentFrozenProposalInput(card.proposalId!);
                      if (typeof input?.title !== 'string' || !input.title.trim()
                        || typeof input.content !== 'string' || !input.content.trim()) return;
                    }
                    decideToolAgentFrozenProposal(card.proposalId!, 'confirmed');
                    if (memoryCorrection) refreshCorrectionInput((revision) => revision + 1);
                  }}
                  style={[styles.groupScheduleSave, !correctionReady ? { opacity: 0.5 } : null]}
                >
                  <Text style={styles.candidateSaveText}>{memoryCorrection ? '保存' : '确认执行'}</Text>
                  </Pressable>
                </View>
              </>
            ) : null}
            {card.toolId === 'wish.invite_discussion' && card.status === 'success' && onWishInvite ? (
              <View>
              {typeof card.inputPreview.content === 'string' ? <Text style={styles.toolCallPreviewText}>{card.inputPreview.content}</Text> : null}
              <Pressable accessibilityRole="button" accessibilityState={{ disabled: !!wishBusy }} disabled={wishBusy}
                hitSlop={10} onPress={() => onWishInvite(card.callId)}
                style={[styles.groupScheduleSave, wishBusy ? { opacity: 0.5 } : null]}>
                <Text style={styles.candidateSaveText}>进入商量</Text>
              </Pressable>
              </View>
            ) : null}
            <Text style={styles.toolCallTime}>{formatMessageTime(finishedAt)}</Text>
            </View>
          );
        })}
      </View>
      {endAdjustment ? (
        <DateTimePickerSheet
          onClose={() => setEndAdjustment(null)}
          onConfirm={(selection) => {
            if (selection?.endTime) {
              let endAt = combineDateTime(selection.date, selection.endTime);
              if (endAt <= endAdjustment.startAt) endAt += 24 * 60 * 60 * 1000;
              const amended = amendScheduleCreateEventConfirmationTimes({
                proposalId: endAdjustment.proposalId,
                startAt: endAdjustment.startAt,
                endAt,
              });
              if (amended) {
                onProposalAdjusted?.(amended.proposalId, amended.presentation);
              }
            } else if (selection) {
              const amended = amendScheduleCreateEventConfirmationTimes({
                proposalId: endAdjustment.proposalId,
                startAt: endAdjustment.startAt,
              });
              if (amended) {
                onProposalAdjusted?.(amended.proposalId, amended.presentation);
              }
            }
            setEndAdjustment(null);
          }}
          timeOnly
          timeOnlyTarget="end"
          title="调整结束时间"
          value={endAdjustment.value}
          visible
        />
      ) : null}
    </>
  );
}
