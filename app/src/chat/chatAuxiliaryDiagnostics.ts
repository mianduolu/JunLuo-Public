import AsyncStorage from '@react-native-async-storage/async-storage';

export type ChatAuxiliaryStage =
  | 'user_correction'
  | 'action_snapshot'
  | 'continuity_ledger'
  | 'share_ledger'
  | 'notebook'
  | 'memory_usage'
  | 'wants_clock'
  | 'keyword_counter';

export type ChatAuxiliaryPhase = 'read' | 'prepare' | 'commit' | 'recover';

export const CHAT_AUXILIARY_STEP_LABELS = {
  continuity_context: '读取开放牵挂',
  body_doorbell_read: '读取身体门铃',
  body_heart_read: '读取心率照护材料',
  body_period_read: '读取经期照护材料',
  body_doorbell_commit: '登记身体门铃已处理',
  web_share_prepare: '读取失败见闻承接材料',
  web_share_commit: '登记聊天中实际送达的见闻',
  action_continuity_prepare: '建立或复用行动牵挂',
  event_updates_commit: '更新本轮指定牵挂',
  care_updates_commit: '更新本轮指定事项',
  presence_update_commit: '保存本轮位置说明',
  music_playback_context: '读取真实听歌背景',
  action_continuity_commit: '关联行动与牵挂',
  return_commitment_commit: '保存返回约定',
  action_delivery_commit: '登记行动送达与进度',
  notebook_prepare: '检查本轮心声是否可记入小本本',
  notebook_commit: '保存本轮心声到小本本',
} as const;

type ChatAuxiliaryStep = keyof typeof CHAT_AUXILIARY_STEP_LABELS;

function isAuxiliaryStep(value: unknown): value is ChatAuxiliaryStep {
  return typeof value === 'string'
    && Object.prototype.hasOwnProperty.call(CHAT_AUXILIARY_STEP_LABELS, value);
}

export function getChatAuxiliaryStepLabel(step: unknown) {
  return isAuxiliaryStep(step) ? CHAT_AUXILIARY_STEP_LABELS[step] : '未记录具体步骤';
}

export type ChatAuxiliaryFailureCode =
  | 'database_busy'
  | 'backup_restore_boundary'
  | 'sync_capture_failed'
  | 'local_storage_failed'
  | 'revision_conflict'
  | 'invalid_data'
  | 'write_rejected'
  | 'unknown';

export type ChatAuxiliaryDiagnosticEntry = {
  attemptedAt: number;
  durationMs: number;
  failureCode: ChatAuxiliaryFailureCode;
  id: string;
  phase: ChatAuxiliaryPhase;
  retryAttempted: boolean;
  stage: ChatAuxiliaryStage;
  step?: ChatAuxiliaryStep;
  status: 'failed' | 'recovered';
  reasonCode?: string;
};

export type ChatAuxiliaryDiagnostics = {
  entries: ChatAuxiliaryDiagnosticEntry[];
};

export function shouldMarkChatMessageFailed(input: {
  userMessagePersisted: boolean;
}) {
  return !input.userMessagePersisted;
}

const CHAT_AUXILIARY_DIAGNOSTICS_KEY = 'junluo.chat.auxiliaryDiagnostics.v1';
const MAX_DIAGNOSTIC_ENTRIES = 30;

export const CHAT_AUXILIARY_STAGE_LABELS: Record<ChatAuxiliaryStage, string> = {
  memory_usage: '记忆使用记录',
  user_correction: '长期纠错',
  action_snapshot: '行动快照',
  continuity_ledger: '行动账本',
  share_ledger: '分享账本',
  notebook: '小本本',
  wants_clock: '留言计时',
  keyword_counter: '关键词统计',
};

export const CHAT_AUXILIARY_PHASE_LABELS: Record<ChatAuxiliaryPhase, string> = {
  read: '读取',
  prepare: '准备',
  commit: '提交',
  recover: '恢复',
};

export const CHAT_AUXILIARY_FAILURE_LABELS: Record<ChatAuxiliaryFailureCode, string> = {
  database_busy: '数据库正忙',
  backup_restore_boundary: '备份恢复边界',
  sync_capture_failed: '同步捕获失败',
  local_storage_failed: '本机存储失败',
  revision_conflict: '版本冲突',
  invalid_data: '数据格式非法',
  write_rejected: '本次写入未被接受',
  unknown: '未知故障',
};

// Only fixed codes are retained; exception messages may contain private content.
const AUXILIARY_REASON_LABELS: Record<string, string> = {
  care_matter_name_conflict: '牵挂名称重复，未能保存这项变化',
  care_matter_target_not_found: '原牵挂已不存在，未能更新',
  care_matter_terminal_event: '原牵挂已结束，未能更新',
  care_matter_revision_conflict: '牵挂版本与本轮记录不一致，本次变化未写入',
  care_matter_invalid_expired_reply: '本轮回复已失效，未写入牵挂',
  care_matter_invalid_legacy_format: '牵挂使用已退役的旧格式，未写入',
  'care_matter_invalid_evidence': '牵挂原话或状态不符合要求，未写入',
  care_matter_source_invalid: '牵挂的消息来源或时间不符合要求，未写入',
  care_matter_invalid_snapshot_capacity: '本轮开始时牵挂已满，不接受新增',
  care_matter_invalid_capacity: '保存时牵挂已满六件，未新增',
  care_matter_invalid_duplicate_quote: '同一段原话已记过，未重复新增',
  care_matter_write_rejected: '牵挂写入被拒绝，具体原因未记录',
  notebook_write_disabled: '小本本已关闭，本轮未写入',
  notebook_write_cooldown: '小本本尚在冷却，本轮未写入',
  'notebook_write_content-rejected': '内容未通过小本本现有规则，本轮未写入',
  'notebook_write_empty-content': '没有可保存的小本本内容，本轮未写入',
  'notebook_write_write-failed': '小本本未接受本轮内容，未完成写入',
};

function isNotebookWriteRejection(error: unknown) {
  const message = error instanceof Error ? error.message : error;
  return typeof message === 'string' && message.startsWith('notebook_write_')
    && Object.prototype.hasOwnProperty.call(AUXILIARY_REASON_LABELS, message);
}

export type ChatAuxiliaryFailureDetails = {
  failureCode?: ChatAuxiliaryFailureCode;
  reasonCode?: string;
  retryAttempted?: boolean;
};

export function normalizeChatAuxiliaryFailureDetails(value: {
  failureCode?: unknown; reasonCode?: unknown; retryAttempted?: unknown;
}): ChatAuxiliaryFailureDetails {
  return {
    failureCode: typeof value.failureCode === 'string'
      && Object.prototype.hasOwnProperty.call(CHAT_AUXILIARY_FAILURE_LABELS, value.failureCode)
      ? value.failureCode as ChatAuxiliaryFailureCode : undefined,
    reasonCode: typeof value.reasonCode === 'string'
      && Object.prototype.hasOwnProperty.call(AUXILIARY_REASON_LABELS, value.reasonCode)
      ? value.reasonCode : undefined,
    retryAttempted: typeof value.retryAttempted === 'boolean' ? value.retryAttempted : undefined,
  };
}

export function getChatAuxiliaryFailureDetails(error: unknown): ChatAuxiliaryFailureDetails {
  return normalizeChatAuxiliaryFailureDetails({
    failureCode: classifyChatAuxiliaryError(error),
    reasonCode: error instanceof Error ? error.message : error,
  });
}

export function describeChatAuxiliaryFailure(value: ChatAuxiliaryFailureDetails): string {
  const detail = normalizeChatAuxiliaryFailureDetails(value);
  if (detail.reasonCode) return `${AUXILIARY_REASON_LABELS[detail.reasonCode]}（${detail.reasonCode}）`;
  if (!detail.failureCode) return '旧记录未记录具体原因';
  return detail.failureCode === 'unknown' ? '未能识别具体原因（unknown）'
    : `${CHAT_AUXILIARY_FAILURE_LABELS[detail.failureCode]}（${detail.failureCode}）`;
}

export function getChatAuxiliaryOutcomeLabel(
  entry: Pick<ChatAuxiliaryDiagnosticEntry, 'phase' | 'status'>,
) {
  if (entry.status === 'recovered') return '重试成功';
  if (entry.phase === 'read') return '读取失败';
  if (entry.phase === 'prepare') return '准备失败';
  if (entry.phase === 'recover') return '恢复失败';
  return '当次写入失败';
}

function isDiagnosticEntry(value: unknown): value is ChatAuxiliaryDiagnosticEntry {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<ChatAuxiliaryDiagnosticEntry>;
  return typeof item.id === 'string'
    && typeof item.attemptedAt === 'number'
    && typeof item.durationMs === 'number'
    && typeof item.retryAttempted === 'boolean'
    && (item.status === 'failed' || item.status === 'recovered')
    && typeof item.stage === 'string'
    && typeof item.phase === 'string'
    && typeof item.failureCode === 'string'
    && Object.prototype.hasOwnProperty.call(CHAT_AUXILIARY_STAGE_LABELS, item.stage)
    && Object.prototype.hasOwnProperty.call(CHAT_AUXILIARY_PHASE_LABELS, item.phase)
    && Object.prototype.hasOwnProperty.call(CHAT_AUXILIARY_FAILURE_LABELS, item.failureCode);
}

export function classifyChatAuxiliaryError(error: unknown): ChatAuxiliaryFailureCode {
  if (isNotebookWriteRejection(error)) return 'write_rejected';
  const message = error instanceof Error ? error.message : String(error ?? '');
  const normalized = message.toLocaleLowerCase();
  if (/database.*(?:locked|busy)|(?:locked|busy).*database|sqlite_busy|sqlite_locked/.test(normalized)) {
    return 'database_busy';
  }
  if (/backup.*restore|restore.*backup|data.?epoch|write_blocked_by_backup_restore/.test(normalized)) {
    return 'backup_restore_boundary';
  }
  if (/sync.*capture|capture.*sync|sync.*outbox|outbox.*sync|durable.*intent/.test(normalized)) {
    return 'sync_capture_failed';
  }
  if (/revision|version.*conflict|conflict.*version|stale.*write/.test(normalized)) {
    return 'revision_conflict';
  }
  if (/invalid|malformed|schema|parse|json|format/.test(normalized)) {
    return 'invalid_data';
  }
  if (/asyncstorage|storage|setitem|getitem|removeitem|enospc|eio|filesystem|disk/.test(normalized)) {
    return 'local_storage_failed';
  }
  return 'unknown';
}

export async function loadChatAuxiliaryDiagnostics(
  options: { strict?: boolean } = {},
): Promise<ChatAuxiliaryDiagnostics> {
  try {
    const raw = await AsyncStorage.getItem(CHAT_AUXILIARY_DIAGNOSTICS_KEY);
    if (raw === null || (!options.strict && !raw)) return { entries: [] };
    const parsed = JSON.parse(raw) as { entries?: unknown };
    if (options.strict && (!parsed || !Array.isArray(parsed.entries))) {
      throw new Error('invalid-chat-auxiliary-diagnostics');
    }
    const entries = Array.isArray(parsed.entries)
      ? parsed.entries.filter(isDiagnosticEntry).slice(-MAX_DIAGNOSTIC_ENTRIES)
      : [];
    return { entries };
  } catch (error) {
    if (options.strict) throw error;
    return { entries: [] };
  }
}

let diagnosticsMutationQueue: Promise<unknown> = Promise.resolve();

export function recordChatAuxiliaryDiagnostic(input: {
  attemptedAt?: number;
  durationMs: number;
  error: unknown;
  phase: ChatAuxiliaryPhase;
  retryAttempted: boolean;
  stage: ChatAuxiliaryStage;
  step?: ChatAuxiliaryStep;
  status: 'failed' | 'recovered';
  reasonCode?: string;
}) {
  const attemptedAt = input.attemptedAt ?? Date.now();
  const { failureCode, reasonCode } = getChatAuxiliaryFailureDetails(input.error);
  console.warn('[chat-auxiliary]', input.stage, input.phase, input.status, input.error);
  diagnosticsMutationQueue = diagnosticsMutationQueue.catch(() => undefined).then(async () => {
    const current = await loadChatAuxiliaryDiagnostics();
    const entry: ChatAuxiliaryDiagnosticEntry = {
      attemptedAt,
      durationMs: Math.max(0, Math.round(input.durationMs)),
      failureCode: failureCode ?? 'unknown',
      id: `chat-aux-${attemptedAt}-${Math.random().toString(36).slice(2, 8)}`,
      phase: input.phase,
      retryAttempted: input.retryAttempted,
      stage: input.stage,
      ...(isAuxiliaryStep(input.step) ? { step: input.step } : {}),
      status: input.status,
      ...(input.reasonCode && /^care_[a-z_]+$/.test(input.reasonCode)
        ? { reasonCode: input.reasonCode } : reasonCode ? { reasonCode } : {}),
    };
    await AsyncStorage.setItem(
      CHAT_AUXILIARY_DIAGNOSTICS_KEY,
      JSON.stringify({ entries: [...current.entries, entry].slice(-MAX_DIAGNOSTIC_ENTRIES) }),
    );
  }).catch(() => undefined);
  return diagnosticsMutationQueue;
}

export function recordChatCareRejection(reasonCode: string) {
  return recordChatAuxiliaryDiagnostic({ durationMs: 0, error: new Error(reasonCode), reasonCode,
    phase: 'commit', retryAttempted: false, stage: 'continuity_ledger', step: 'care_updates_commit', status: 'failed' });
}

export type ChatAuxiliaryOperationResult<T> =
  | { ok: true; value: T }
  | { error: unknown; ok: false; diagnostic: ChatAuxiliaryFailureDetails };

export async function runChatAuxiliaryOperation<T>(
  input: {
    phase: ChatAuxiliaryPhase;
    retryLocalSave?: boolean;
    stage: ChatAuxiliaryStage;
    step?: ChatAuxiliaryStep;
  },
  operation: () => Promise<T>,
): Promise<ChatAuxiliaryOperationResult<T>> {
  const startedAt = Date.now();
  let lastError: unknown;
  let retryAttempted = false;
  const attempts = input.retryLocalSave ? 4 : 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    retryAttempted = attempt > 0;
    try {
      const value = await operation();
      if (attempt > 0) {
        void recordChatAuxiliaryDiagnostic({
          attemptedAt: startedAt,
          durationMs: Date.now() - startedAt,
          error: lastError,
          phase: input.phase,
          retryAttempted: true,
          stage: input.stage,
          step: input.step,
          status: 'recovered',
        });
      }
      return { ok: true, value };
    } catch (error) {
      lastError = error;
      if (isNotebookWriteRejection(error)) break;
    }
  }
  void recordChatAuxiliaryDiagnostic({
    attemptedAt: startedAt,
    durationMs: Date.now() - startedAt,
    error: lastError,
    phase: input.phase,
    retryAttempted,
    stage: input.stage,
    step: input.step,
    status: 'failed',
  });
  return { error: lastError, ok: false,
    diagnostic: { ...getChatAuxiliaryFailureDetails(lastError), retryAttempted } };
}
