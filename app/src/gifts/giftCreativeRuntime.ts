import { captureBackupRestoreDataEpoch, canCommitBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { runBudgetedAiCall } from '../ai/aiCallBudget';
import { isChatReplyInFlight } from '../ai/aiRuntimeScheduler';
import { isWantsClockOwner, isJunluoWantsAwake } from '../life/junluoDesireRuntime';
import { loadAutonomySettings } from '../life/autonomySettings';
import { isAutomaticRemoteAiAllowed, loadAutomaticRemoteAiPolicy } from '../runtime/automaticRemoteAiPolicy';
import { loadAndroidSyncNetworkClass } from '../sync/syncAndroidNetworkClass';
import { executeToolCall } from '../tools/toolExecution';
import { registerBuiltinTools } from '../tools/builtin/registerBuiltinTools';
import { getToolDefinition } from '../tools/toolRegistry';
import { resolveToolPermissionForCall } from '../tools/toolPermissions';
import { createToolAgentHostExecutionId } from '../tools/toolExecutionAttemptJournal';
import type { JunLuoToolCall, JunLuoToolResult } from '../tools/toolTypes';
import type { GiftCreationResponse } from '../ai/giftCreationRequest';
import { createGiftToolTurn } from './giftToolTurn';
import { GIFT_TOOL_IDS, serializeGiftToolResult } from './giftToolContract';
import { selectGiftCreativeOpportunity, transitionGiftCreativeOpportunity } from './giftCreativeOpportunity';
import { loadGiftCreativeContext, prepareGiftCreativeCall, type GiftCreativeContext } from './giftCreativeModel';
import { loadGiftCreativeState, saveGiftCreativeState, type GiftCreativeState, type GiftCreativeRun } from './giftCreativeStore';

type PaidResponse = { epoch: number | null; key: string; requestCount: number; value: GiftCreationResponse };
type PaidTool = { epoch: number | null; key: string; callId: string; result: JunLuoToolResult;
  checkpoint: GiftCreativeRun['checkpoint'] };
let responseCache: PaidResponse | null = null, toolCache: PaidTool | null = null;
let flight: Promise<{ requested: boolean; changed: boolean }> | null = null;
const RETRY_MS = 5 * 60_000;
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const save = (epoch: number | null, state: GiftCreativeState, patch: Partial<Omit<GiftCreativeState, 'revision'>>) =>
  saveGiftCreativeState(epoch, state, { opportunity: state.opportunity, run: state.run, retryAt: state.retryAt, ...patch });

async function allowed(epoch: number | null) {
  if (!isWantsClockOwner() || !canCommitBackupRestoreDataEpoch(epoch) || isChatReplyInFlight()) return false;
  const [awake, policy, settings, network] = await Promise.all([isJunluoWantsAwake(),
    loadAutomaticRemoteAiPolicy({ strict: true }), loadAutonomySettings({ strict: true }), loadAndroidSyncNetworkClass()]);
  if (!awake || !isAutomaticRemoteAiAllowed(policy) || !settings.masterEnabled || !settings.desireDrivenBehaviorEnabled
    || network === 'offline') return false;
  registerBuiltinTools();
  for (const id of GIFT_TOOL_IDS) {
    const tool = getToolDefinition(id);
    if (!tool || (await resolveToolPermissionForCall(tool, { input: {}, requestedBy: 'life_agent' })).permission !== 'allow') return false;
  }
  return canCommitBackupRestoreDataEpoch(epoch) && !isChatReplyInFlight();
}
async function current(epoch: number | null, run: GiftCreativeRun) {
  if (!await allowed(epoch)) return false;
  const value = await loadGiftCreativeContext(Date.now());
  return value.source.visible && value.sourceStamp === run.sourceStamp && value.historyStamp === run.historyStamp
    && value.configStamp === run.configStamp && canCommitBackupRestoreDataEpoch(epoch);
}
async function finish(epoch: number | null, state: GiftCreativeState, result: 'none' | 'completed' | 'failed') {
  const opportunity = state.opportunity.current;
  if (!opportunity) return state;
  let next = state.opportunity;
  if (opportunity.status === 'ready') next = transitionGiftCreativeOpportunity(next,
    { key: opportunity.key, attempt: opportunity.attempt, event: 'started' }).state;
  next = transitionGiftCreativeOpportunity(next, { key: opportunity.key, attempt: opportunity.attempt, event: result }).state;
  return save(epoch, state, { opportunity: next, run: null, retryAt: result === 'failed' ? Date.now() + RETRY_MS : 0 });
}
async function flush(epoch: number | null) {
  let state = await loadGiftCreativeState(epoch);
  if (responseCache && !canCommitBackupRestoreDataEpoch(responseCache.epoch)) responseCache = null;
  if (toolCache && !canCommitBackupRestoreDataEpoch(toolCache.epoch)) toolCache = null;
  if (responseCache && state.run?.key === responseCache.key && state.run.requesting
    && state.run.requestCount === responseCache.requestCount && epoch === responseCache.epoch) {
    const value = responseCache.value;
    const continuation = [...state.run.continuation];
    if (value.calls.length) continuation.push({ subject: 'I', kind: 'tool_request', content: value.content,
      toolCalls: value.calls.map(call => ({ callId: call.callId, type: 'function',
        rawName: call.rawName!, rawArguments: call.rawArguments! })) });
    state = await save(epoch, state, { run: { ...state.run, requesting: false, response: value,
      responseIndex: 0, continuation } }); responseCache = null;
  }
  if (toolCache && state.run?.key === toolCache.key && state.run.executing === toolCache.callId && epoch === toolCache.epoch) {
    const { result, checkpoint } = toolCache;
    state = await save(epoch, state, { run: { ...state.run, checkpoint, executing: null,
      responseIndex: state.run.responseIndex + 1, callCount: state.run.callCount + 1,
      changed: state.run.changed || result.ok && result.toolId !== 'gift.view'
        || !!(result.error?.details && typeof result.error.details === 'object' && 'savedReceipt' in result.error.details),
      continuation: [...state.run.continuation, { subject: 'I', kind: 'tool_result', callId: toolCache.callId,
        toolId: result.toolId, content: serializeGiftToolResult(result) }] } }); toolCache = null;
  }
  return state;
}

async function begin(epoch: number | null, state: GiftCreativeState, context: GiftCreativeContext) {
  const key = state.opportunity.current!.key;
  const host = createGiftToolTurn({ dataEpoch: epoch, isCurrent: () => allowed(epoch) });
  // These are the exact I preparations displayed in the initial system material.
  // A local source read is not an invented utterance or an audio playback.
  await host.seed(context.gifts.filter(view => view.revealed).map(view => ({ id: view.gift.id,
    revision: view.gift.revision, attachmentIds: view.gift.attachments.map(item => item.id) })));
  const run: GiftCreativeRun = { key, sourceStamp: context.sourceStamp, historyStamp: context.historyStamp,
    configStamp: context.configStamp, checkpoint: host.checkpoint(), continuation: [], requestCount: 0, callCount: 0,
    requesting: false, response: null, responseIndex: 0, executing: null, changed: false };
  return save(epoch, state, { run });
}

/** Existing life opportunities call this function; it never installs a timer or visible-message fallback. */
async function drain(options: { allowRequest?: boolean }) {
  const epoch = captureBackupRestoreDataEpoch();
  if (epoch === null) return { requested: false, changed: false };
  let state = await flush(epoch);
  if (options.allowRequest === false || !await allowed(epoch)) return { requested: false, changed: state.run?.changed ?? false };
  let context = await loadGiftCreativeContext(Date.now());
  const selection = selectGiftCreativeOpportunity(state.opportunity, context.source);
  if (selection.state !== state.opportunity) state = await save(epoch, state, { opportunity: selection.state });
  // A returned response or real local receipt is required to leave either unknown boundary.
  if (state.run?.requesting || state.run?.executing) return { requested: false, changed: state.run.changed };
  if (state.run && (state.run.key !== state.opportunity.current?.key || state.run.sourceStamp !== context.sourceStamp || state.run.historyStamp !== context.historyStamp
    || state.run.configStamp !== context.configStamp || state.run.checkpoint.session.dataEpoch !== epoch)) {
    state = state.opportunity.current?.status === 'ready' ? await save(epoch, state, { run: null, retryAt: 0 })
      : await finish(epoch, state, state.run.changed ? 'completed' : 'none');
    return { requested: false, changed: false };
  }
  if (!state.run) {
    if (selection.action === 'retry-required') {
      if (state.retryAt > Date.now() || state.opportunity.current!.attempt >= 1) return { requested: false, changed: false };
      state = await save(epoch, state, { opportunity: transitionGiftCreativeOpportunity(state.opportunity,
        { key: state.opportunity.current!.key, attempt: state.opportunity.current!.attempt, event: 'retry' }).state });
    } else if (selection.action !== 'ready') return { requested: false, changed: false };
    state = await begin(epoch, state, context);
  }
  let requested = false;
  registerBuiltinTools();
  const host = createGiftToolTurn({ dataEpoch: epoch, checkpoint: state.run!.checkpoint,
    isCurrent: () => current(epoch, state.run!) });
  for (;;) {
    const run = state.run!;
    if (!await current(epoch, run)) return { requested, changed: run.changed };
    if (run.response) {
      const call = run.response.calls[run.responseIndex];
      if (!call || run.callCount >= 4) {
        if (!run.response.calls.length || run.requestCount >= 3 || run.callCount >= 4) {
          const changed = run.changed;
          state = await finish(epoch, state, changed ? 'completed' : 'none'); return { requested, changed };
        }
        state = await save(epoch, state, { run: { ...run, response: null, responseIndex: 0 } }); continue;
      }
      state = await save(epoch, state, { run: { ...run, executing: call.callId } });
      const invocation: JunLuoToolCall = { callId: createToolAgentHostExecutionId(`${run.key}:${run.requestCount}:${call.callId}`), toolId: call.toolId, input: call.input,
        requestedBy: 'life_agent', createdAt: Date.now(), executionIntentId: `${run.key}:${call.callId}`,
        executionIntentSource: 'gift-creation' };
      const result = await executeToolCall(invocation, { giftCabinet: host });
      if (['TOOL_OUTCOME_UNKNOWN', 'TOOL_EXECUTION_PENDING', 'TOOL_TIMEOUT'].includes(result.error?.code ?? '')) {
        return { requested, changed: run.changed };
      }
      toolCache = { epoch, key: run.key, callId: call.callId, result: copy(result), checkpoint: host.checkpoint() };
      state = await flush(epoch); continue;
    }
    if (state.retryAt > Date.now()) return { requested, changed: run.changed };
    context = await loadGiftCreativeContext(Date.now());
    await host.seed(context.gifts.filter(view => view.revealed).map(view => ({ id: view.gift.id,
      revision: view.gift.revision, attachmentIds: view.gift.attachments.map(item => item.id) })));
    state = await save(epoch, state, { run: { ...run, checkpoint: host.checkpoint() } });
    const prepared = await prepareGiftCreativeCall(context, run, Date.now());
    try {
      const budget = await runBudgetedAiCall('giftCreation', 'background', async admission => prepared.request(async assertReady => {
        await admission.beforeTransport(undefined, async () => {
          if (!await current(epoch, run)) throw Error('gift-creative-source-changed');
          await assertReady();
          let opportunity = state.opportunity;
          if (opportunity.current?.status === 'ready') opportunity = transitionGiftCreativeOpportunity(opportunity,
            { key: opportunity.current.key, attempt: opportunity.current.attempt, event: 'started' }).state;
          state = await save(epoch, state, { opportunity, run: { ...state.run!, requesting: true, requestCount: run.requestCount + 1 } });
        }); requested = true;
      }, value => {
        const previous = new Set(run.continuation.flatMap(line => line.kind === 'tool_request' ? line.toolCalls.map(call => call.callId) : []));
        if (value.calls.some(call => previous.has(call.callId))) throw Error('gift-creation-request-tools');
        responseCache = { epoch, key: run.key, requestCount: run.requestCount + 1, value: copy(value) };
      }),
      { connection: prepared.connection, dataEpoch: epoch, purpose: 'other' });
      if (!budget.ok) {
        state = await save(epoch, state, { retryAt: Math.max(Date.now() + 60_000, budget.retryAfter ?? 0) });
        return { requested, changed: run.changed };
      }
      state = await flush(epoch);
    } catch (error) {
      if (responseCache) { state = await flush(epoch); continue; }
      const code = error instanceof Error ? error.message : '';
      if (/^gift-creation-request-(auth|rate-limited|http|response|incomplete|tools|config|input)$/.test(code)) {
        await finish(epoch, state, 'failed');
      }
      // A transport without a returned result stays requesting; another tick cannot repay it.
      return { requested, changed: run.changed };
    }
  }
}
export function runGiftCreativeTick(options: { now?: number; allowRequest?: boolean } = {}) {
  if (flight) return flight;
  flight = drain(options).finally(() => { flight = null; }); return flight;
}
