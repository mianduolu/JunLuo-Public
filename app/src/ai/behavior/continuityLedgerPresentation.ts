import {
  deriveBaiyunContinuityTimingState,
  type BaiyunContinuityEvent,
  type BaiyunContinuityEventKind,
  type BaiyunContinuityEventStage,
  type BaiyunContinuityTimingState,
} from './continuityEvent';
import type { BaiyunContinuityDateRange } from './continuityLedger';
import { isBaiyunLowBatteryActionSourceId } from './actionExecution';
import { isHeartCareMatter } from './heartCareMatter';

export const BAIYUN_CONTINUITY_KIND_LABELS: Readonly<Record<BaiyunContinuityEventKind, string>> = {
  closeness_request: '亲近请求',
  relationship_rupture: '关系受伤与修复',
  return_commitment: '回来约定',
  proactive_intention: '主动联系',
  care_process: '照护过程',
  shared_task: '共同事项',
  cross_day_life: '跨日生活回访',
};

export const BAIYUN_CONTINUITY_TIMING_LABELS: Readonly<
  Record<Extract<BaiyunContinuityTimingState, 'active' | 'waiting' | 'due'>, string>
> = {
  active: '现在要继续',
  waiting: '正在等待',
  due: '已经到时间',
};

const STAGE_LABELS: Readonly<Record<BaiyunContinuityEventStage, string>> = {
  waiting_delivery: '等待这次亲近真实送达',
  rupture_detected: '已经发现关系受伤，等待先挽留',
  retained: '已经挽留，修复仍未完成',
  paused_for_return: '已经暂停，并留下回来约定',
  returned: '已经回来，接下来继续修复',
  repairing: '正在处理具体受伤点',
  awaiting_confirmation: '等待确认这次修复是否真的接住',
  waiting_pause_delivery: '等待暂停消息真实送达',
  waiting_condition: '等待约定的回来条件',
  due: '回来条件已经到达',
  waiting_return_delivery: '等待回来消息真实送达',
  pending_expression: '等待把主动心意真实表达出来',
  blocked: '这次主动表达受阻，仍未结算',
  signal_seen: '已经看到照护信号',
  preparing_check: '准备进行具体照护确认',
  reminded_or_interrupted: '提醒或打断已经执行，恢复尚未确认',
  awaiting_response: '等待回应或可观察变化',
  follow_up_due: '照护回访已经到时间',
  intervention_paused: '照护执行暂停，事件仍然保留',
  waiting_shared_action: '等待共同事项真实推进',
  awaiting_shared_confirmation: '已推进·等你确认',
  recorded: '已经记录，等待跨日回访',
};

function formatNextAction(nextActionAt?: number) {
  if (nextActionAt === undefined) return undefined;
  return new Date(nextActionAt).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function sourceLabel(event: BaiyunContinuityEvent) {
  if (isHeartCareMatter(event)) return '设备心率';
  const sourceId = event.source.sourceId.toLowerCase();
  if (isBaiyunLowBatteryActionSourceId(event.source.sourceId)) return '手机电量';
  if (/period|menstrual|经期/u.test(sourceId)) return '经期陪伴';
  if (/phone|usage|blacklist|whitelist/u.test(sourceId)) return '手机活动';
  if (event.source.kind === 'global_relationship') return '关系连续性';
  if (event.source.kind === 'bedtime_care') return '睡前提醒';
  if (event.source.kind === 'real_care') return '聊天照护';
  if (event.source.kind === 'real_life') return '共同生活';
  if (event.source.kind === 'real_tool_execution') return '工具执行';
  if (event.source.kind === 'global_action_plan') return '行动计划';
  return '小剧场';
}

export function presentBaiyunContinuityEvent(
  event: BaiyunContinuityEvent,
  now = Date.now(),
) {
  const timing = deriveBaiyunContinuityTimingState(event, now);
  const activeTiming = timing === 'completed' || timing === 'cancelled' ? 'active' : timing;
  const chatCare = event.schemaVersion === 3 && event.kind === 'care_process' && event.careEvidence;
  const stageLabel = chatCare ? '仍在留意' : event.kind === 'care_process'
    && isBaiyunLowBatteryActionSourceId(event.source.sourceId)
    && event.status !== 'completed'
    && event.status !== 'cancelled'
      ? '等待手机开始充电'
      : event.progress ? `当前进度：${event.progress}` : STAGE_LABELS[event.stage];
  return {
    id: event.id,
    kindLabel: BAIYUN_CONTINUITY_KIND_LABELS[event.kind],
    sourceLabel: sourceLabel(event),
    itemName: chatCare ? chatCare.origin.quote : event.itemName ?? event.focusExcerpt,
    statusLabel: BAIYUN_CONTINUITY_TIMING_LABELS[activeTiming],
    stageLabel,
    focusExcerpt: chatCare || isHeartCareMatter(event)
      ? event.careEvidence?.latest?.quote ?? event.careEvidence?.origin.quote ?? event.focusExcerpt : event.focusExcerpt,
    nextActionLabel: formatNextAction(event.nextActionAt),
    openedAt: event.occurredAt,
    updatedAt: event.updatedAt,
    revision: event.revision,
  };
}

export function presentBaiyunContinuityEventForDateRange(
  event: BaiyunContinuityEvent,
  range: BaiyunContinuityDateRange,
) {
  if (
    !Number.isSafeInteger(range.fromInclusive)
    || !Number.isSafeInteger(range.toExclusive)
    || range.toExclusive <= range.fromInclusive
  ) {
    throw new Error('continuity_date_range_invalid');
  }
  const terminalAt = event.completedAt ?? event.cancelledAt;
  const terminalInRange = typeof terminalAt === 'number'
    && terminalAt >= range.fromInclusive
    && terminalAt < range.toExclusive;
  const openedInRange = event.occurredAt >= range.fromInclusive
    && event.occurredAt < range.toExclusive;
  let dateStatusLabel: string;
  if (terminalInRange) {
    dateStatusLabel = `${event.completedAt !== undefined ? '当天完成' : '当天取消'} ${new Date(terminalAt).toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })}`;
  } else if (openedInRange) {
    dateStatusLabel = '当天建立 · 当天仍未结束';
  } else {
    dateStatusLabel = '由此前延续 · 当天仍未结束';
  }
  return {
    id: event.id,
    kindLabel: BAIYUN_CONTINUITY_KIND_LABELS[event.kind],
    focusExcerpt: event.focusExcerpt,
    dateStatusLabel,
    openedAt: event.occurredAt,
    terminalAt,
  };
}
