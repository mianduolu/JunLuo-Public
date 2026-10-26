import AsyncStorage from '@react-native-async-storage/async-storage';
import { canCommitBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import { readPhoneLimitActionQuery } from '../backend/phoneLimitActionNative';
import { PHONE_ACTIVITY_PROACTIVE_SETTINGS_KEY } from '../proactive/phoneRestrictionSettings';
import { isPhoneLimitToolId, parsePhoneLimitToolInput } from './phoneLimitContract';
import { executePhoneLimitCall, reconcilePhoneLimitAction } from './phoneLimitExecution';
import { reconcilePhoneLimitPlan, type PhoneLimitPreparedPlan } from './phoneLimitPlanExecution';
import { phoneLimitPreExecutionResult, projectPhoneLimitModelResult } from './phoneLimitModelResult';
import { phoneLimitObject } from './phoneLimitStatus';
import { createToolAgentInputHash } from './toolAgentHostIdentity';
import { claimPhoneLimitSave, recordPhoneLimitPrepared, recordPhoneLimitResult } from './toolAuditStore';
import type { JunLuoToolCall, JunLuoToolResult } from './toolTypes';

// Only simultaneous deliveries share this promise. The existing audit owns cold
// replay; no second journal, request key, retry queue or persistent result cache.
const inFlight = new Map<string, { hash: string; work: Promise<JunLuoToolResult> }>();
function unknown(call: JunLuoToolCall): JunLuoToolResult {
  const now = Date.now();
  const base: JunLuoToolResult = { callId: call.callId, toolId: call.toolId, ok: false, status: 'error',
    summary: '', startedAt: now, finishedAt: now, error: { code: 'TOOL_OUTCOME_UNKNOWN', message: 'PHONE_LIMIT_OUTCOME_UNKNOWN' } };
  const projection = projectPhoneLimitModelResult(base)!;
  return { ...base, summary: projection.summary, data: projection.data };
}
function rejected(call: JunLuoToolCall) {
  return phoneLimitPreExecutionResult({ ...unknown(call), status: 'permission_denied' });
}
function planResult(call: JunLuoToolCall, result: ReturnType<typeof reconcilePhoneLimitPlan>): JunLuoToolResult {
  const summaries = { saved: '计划已保存。', unchanged: '计划没有改变。', rejected: '本次计划设置未执行。',
    source_saved: '计划设置已保存，暂时无法确认手机是否采用。', unknown: '暂时无法确认计划设置结果。' } as const;
  const ok = result.outcome === 'saved' || result.outcome === 'unchanged';
  const base = unknown(call);
  return { ...base, ok, status: ok ? 'success' : 'error', summary: summaries[result.outcome], data: result.data,
    error: ok ? undefined : base.error };
}

export function createPhoneLimitToolTurn(input: {
  dataEpoch: number; sourceMessageId: string; signal?: AbortSignal; isCurrent?: () => boolean | Promise<boolean>;
  requestedBy?: 'chat' | 'proactive';
}) {
  const valid = async () => !input.signal?.aborted && canCommitBackupRestoreDataEpoch(input.dataEpoch)
    && (input.requestedBy !== 'proactive' || typeof input.isCurrent === 'function')
    && (!input.isCurrent || await input.isCurrent());
  const execute = async (call: JunLuoToolCall, signal?: AbortSignal): Promise<JunLuoToolResult> => {
    const current = async () => !signal?.aborted && await valid();
    if (call.requestedBy !== (input.requestedBy ?? 'chat') || call.sourceMessageId !== input.sourceMessageId
      || !isPhoneLimitToolId(call.toolId) || !await current()) return rejected(call);
    const parsed = parsePhoneLimitToolInput(call.toolId, call.input);
    if (!parsed.ok) return rejected(call);
    if (call.toolId === 'phone_limit.get_status') {
      const value = await executePhoneLimitCall(call);
      return await current() ? value : unknown(call);
    }
    const hash = createToolAgentInputHash(parsed.input as unknown as Record<string, unknown>);
    const key = `${input.dataEpoch}:${call.callId}`;
    const pending = inFlight.get(key);
    if (pending) return pending.hash === hash ? pending.work : unknown(call);
    const work = (async () => {
      try {
        const claimed = await runBackupRestoreDataEpochCommit(input.dataEpoch,
          () => claimPhoneLimitSave(call, input.dataEpoch, hash));
        if (!claimed.committed || !await current()) return unknown(call);
        const { state, claimed: first } = claimed.value;
        if (!first) {
          // Explicit rejection is retained; all ambiguous attempts only inspect
          // original facts. They never prepare again, dispatch, or recreate.
          if (state.result?.summary === rejected(call).summary) return state.result;
          let value: JunLuoToolResult;
          if (!state.prepared) value = state.result ?? unknown(call);
          else if ('action' in state.prepared) value = reconcilePhoneLimitAction(call, state.prepared,
            await readPhoneLimitActionQuery(input.dataEpoch));
          else {
            const raw = await AsyncStorage.getItem(PHONE_ACTIVITY_PROACTIVE_SETTINGS_KEY);
            const settings = raw === null ? null : phoneLimitObject(JSON.parse(raw));
            value = planResult(call, reconcilePhoneLimitPlan(state.prepared as PhoneLimitPreparedPlan,
              settings, await readPhoneLimitActionQuery(input.dataEpoch)));
          }
          return await current() ? value : unknown(call);
        }
        const freeze = async (prepared: import('./phoneLimitExecution').PhoneLimitPreparedAction | PhoneLimitPreparedPlan) => {
          if (!await current()) throw new Error('PHONE_LIMIT_SOURCE_STALE');
          await recordPhoneLimitPrepared(call.callId, input.dataEpoch, hash, prepared);
          if (!await current()) throw new Error('PHONE_LIMIT_SOURCE_STALE');
        };
        const value = await executePhoneLimitCall(call, { beforeDispatch: freeze, beforePlanWrite: freeze,
          beforePlanSourceSave: input.requestedBy === 'proactive' ? async () => {
            if (!await current()) throw new Error('PHONE_LIMIT_SOURCE_STALE');
          } : undefined });
        if (await current()) {
          try { await recordPhoneLimitResult(call.callId, input.dataEpoch, hash, value); }
          catch { /* The first claim/facts remain; recovery only reads. */ }
        }
        return await current() ? value : unknown(call);
      } catch { return unknown(call); }
    })();
    inFlight.set(key, { hash, work });
    try { return await work; } finally { if (inFlight.get(key)?.work === work) inFlight.delete(key); }
  };
  return { execute, available: valid };
}
