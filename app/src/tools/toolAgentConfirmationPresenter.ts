import {
  amendToolAgentFrozenProposal,
  getToolAgentFrozenProposalInput,
  type JunLuoToolAgentConfirmationPresentation,
} from './toolAgentFrozenProposal';
import type { JunLuoRegisteredToolDefinition } from './toolTypes';
import { MEMORY_CORRECTION_PRESENTER_ID } from './memoryCorrection';

export type JunLuoToolAgentConfirmationPresenter = (input: {
  tool: JunLuoRegisteredToolDefinition;
  arguments: Readonly<Record<string, unknown>>;
}) => JunLuoToolAgentConfirmationPresentation;

export const SCHEDULE_CREATE_EVENT_CONFIRMATION_PRESENTER_ID = 'builtin.schedule.create_event';
export const SCHEDULE_COMPLETE_OCCURRENCE_CONFIRMATION_PRESENTER_ID = 'builtin.schedule.complete_occurrence';
export const TODO_CREATE_CONFIRMATION_PRESENTER_ID = 'builtin.todo.create';
export const TODO_COMPLETE_CONFIRMATION_PRESENTER_ID = 'builtin.todo.complete';

const presenters = new Map<string, JunLuoToolAgentConfirmationPresenter>();

function readText(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function formatLocalDateTime(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return String(value ?? '');
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value);
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function presentScheduleCreateEvent(input: Readonly<Record<string, unknown>>) {
  const fields = [
    { label: '标题', value: readText(input.title) },
    { label: '开始时间', value: formatLocalDateTime(input.startAt) },
  ];
  if (input.endAt !== undefined) {
    fields.push({ label: '结束时间', value: formatLocalDateTime(input.endAt) });
  }
  fields.push({
    label: '结束询问',
    value: input.companionEnabled === true ? '开启（未回应时再追问一次）' : '关闭',
  });
  const notes = readText(input.notes);
  if (notes) fields.push({ label: '备注', value: notes });
  return { title: '确认创建日程', fields };
}

const builtinPresenters = new Map<string, JunLuoToolAgentConfirmationPresenter>([
  [MEMORY_CORRECTION_PRESENTER_ID, () => {
    // The chat host must supply the original record, not model-written old text.
    throw new Error('MEMORY_CORRECTION_ORIGINAL_REQUIRED');
  }],
  [SCHEDULE_CREATE_EVENT_CONFIRMATION_PRESENTER_ID, ({ arguments: input }) => (
    presentScheduleCreateEvent(input)
  )],
  [SCHEDULE_COMPLETE_OCCURRENCE_CONFIRMATION_PRESENTER_ID, ({ arguments: input }) => ({
    title: '确认完成日程',
    fields: [{ label: '日程', value: readText(input.title) }],
  })],
  [TODO_CREATE_CONFIRMATION_PRESENTER_ID, ({ arguments: input }) => {
    const plannedForDate = readText(input.plannedForDate);
    const fields = [
      { label: '标题', value: readText(input.title) },
      { label: '安排日期', value: plannedForDate || '待办池' },
    ];
    const notes = readText(input.notes);
    if (notes) fields.push({ label: '备注', value: notes });
    return { title: '确认创建待办', fields };
  }],
  [TODO_COMPLETE_CONFIRMATION_PRESENTER_ID, ({ arguments: input }) => ({
    title: '确认完成待办',
    fields: [{ label: '待办', value: readText(input.title) }],
  })],
]);

export function registerToolAgentConfirmationPresenter(
  presenterId: string,
  presenter: JunLuoToolAgentConfirmationPresenter,
) {
  if (!presenterId.trim()) throw new Error('TOOL_AGENT_CONFIRMATION_PRESENTER_ID_REQUIRED');
  if (presenters.has(presenterId)) throw new Error('TOOL_AGENT_CONFIRMATION_PRESENTER_DUPLICATE');
  presenters.set(presenterId, presenter);
}

export function getToolAgentConfirmationPresenter(presenterId: string | undefined) {
  return presenterId
    ? presenters.get(presenterId) ?? builtinPresenters.get(presenterId)
    : undefined;
}

export function clearToolAgentConfirmationPresentersForTests() {
  presenters.clear();
}

export function amendScheduleCreateEventConfirmationTimes(input: {
  proposalId: string;
  startAt: number;
  endAt?: number;
}) {
  if (
    !Number.isFinite(input.startAt)
    || input.endAt !== undefined && (
      !Number.isFinite(input.endAt)
      || input.endAt <= input.startAt
    )
  ) {
    return null;
  }
  const currentInput = getToolAgentFrozenProposalInput(input.proposalId);
  if (!currentInput) return null;
  const nextInput: Record<string, unknown> = {
    ...currentInput,
    startAt: input.startAt,
  };
  if (input.endAt === undefined) delete nextInput.endAt;
  else nextInput.endAt = input.endAt;
  return amendToolAgentFrozenProposal({
    proposalId: input.proposalId,
    toolId: 'schedule.create_event',
    rawInput: nextInput,
    presentation: presentScheduleCreateEvent(nextInput),
  });
}

export function amendScheduleCreateEventConfirmationCompanion(input: {
  proposalId: string;
  companionEnabled: boolean;
}) {
  const currentInput = getToolAgentFrozenProposalInput(input.proposalId);
  if (!currentInput) return null;
  const nextInput: Record<string, unknown> = {
    ...currentInput,
    companionEnabled: input.companionEnabled,
  };
  return amendToolAgentFrozenProposal({
    proposalId: input.proposalId,
    toolId: 'schedule.create_event',
    rawInput: nextInput,
    presentation: presentScheduleCreateEvent(nextInput),
  });
}
