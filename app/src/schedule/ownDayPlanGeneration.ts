import { buildAssistantStatePairEnvelope, fetchAssistantLifeCompletion } from '../ai/assistantLifePromptEnvelope';
import { buildAssistantLifeShortJsonRequest, ASSISTANT_INTERNAL_PAPER_REQUEST_TIMEOUT_MS } from '../ai/assistantLifeShortJsonRequest';
import { isOfficialQwen397bConnection, isOfficialQwenFlashConnection } from '../ai/modelParameters';
import { estimateApiMessagesTokens } from '../chat/contextCompression';
import { readJsonObjects } from '../ai/shortJsonObjects';
import type { AiConnection, AiProfile } from '../ai/types';
import type { OpenAiCompatibleRequestMessage } from '../ai/openAiCompatibleProvider';
import { readingListTool } from '../tools/builtin/readingTools';
import { ownHabitWriteTool } from '../tools/builtin/ownScheduleTools';
import { parseOpenAiToolCalls, toolDefinitionToOpenAiTool, toolIdToOpenAiToolName,
  type OpenAiCompatibleToolCallMessage } from '../tools/toolCallProtocol';
import { OWN_DAY_PLAN_PROMPT, OWN_DAY_PLAN_CORRECTION_PROMPT } from './ownDayPlanPrompt';
import { collectOwnDayPlanPaperChecks, formatOwnDayPlanTime, getOwnDayPlanRequestLimit, OWN_DAY_PLAN_PAPER_MAX_LENGTH,
  normalizeOwnDayPlanPaperFormat, parseOwnDayPlan, type OwnDayPlanRun } from './ownDayPlanPolicy';
import type { loadOwnDayPlanMaterials } from './ownDayPlanMaterials';

export const OWN_DAY_PLAN_OUTPUT_TOKENS = 3200;
export const ownDayPlanTools = [readingListTool, ownHabitWriteTool];

function paperErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || error.name !== 'Error') return undefined;
  if (['invalid-day-plan-object', 'invalid-day-plan-field', 'invalid-day-plan-ids', 'duplicate-day-plan-id',
    'invalid-day-plan-time', 'invalid-day-plan-local-time', 'invalid-day-plan-entries', 'invalid-reading-label',
    'invalid-day-plan-entry', 'schedule-owner-forbidden', 'invalid-day-plan-minutes', 'day-plan-outside-range',
    'duplicate-schedule-target'].includes(error.message)) return error.message;
  if (error.message === '接着已有安排做和重新选择内容，只能填写一种。这次接续还没保存。') return 'day-plan-mixed-reading-choice';
  if (/^标签 r[1-9]\d* 对应了不止一项安排，无法确定要接着哪项做，这次接续还没保存。$/.test(error.message)) return 'day-plan-duplicate-reading-label';
  return undefined;
}

/** One actual transport only. The saved night run, not this helper, owns continuation and limits. */
export async function prepareOwnDayPlanRequest(input: {
  connection: AiConnection; profile: AiProfile; run: OwnDayPlanRun;
  materials: Awaited<ReturnType<typeof loadOwnDayPlanMaterials>>;
}) {
  const envelope = await buildAssistantStatePairEnvelope({ contextSource: 'assistant-life.state', materialPrompt: '', profile: input.profile });
  let candidates = input.materials.candidates;
  const correction = input.run.paperCorrection;
  const toolsCompleted = ownDayPlanTools.every(tool => input.run.tools?.some(saved => saved.toolId === tool.id && saved.result.ok));
  const allowTools = !correction && !toolsCompleted;
  const forceJsonPaper = !allowTools && isOfficialQwenFlashConnection(input.connection);
  const tools = allowTools || forceJsonPaper ? ownDayPlanTools.map(tool => toolDefinitionToOpenAiTool(tool)) : [];
  const buildMessages = (): OpenAiCompatibleRequestMessage[] => {
    const messages: OpenAiCompatibleRequestMessage[] = [
      { role: 'system', content: envelope.stableSystemPrompt },
      { role: 'system', content: input.materials.render(candidates) },
      { role: 'system', content: OWN_DAY_PLAN_PROMPT },
    ];
    for (const saved of input.run.tools ?? []) {
      messages.push({ role: 'assistant', content: '', tool_calls: [{ id: saved.callId, type: 'function',
        function: { name: toolIdToOpenAiToolName(saved.toolId), arguments: JSON.stringify(saved.input) } }] });
      messages.push({ role: 'tool', tool_call_id: saved.callId, content: JSON.stringify(saved.result) });
    }
    if (correction) {
      messages.push({ role: 'assistant', content: correction.content });
      messages.push({ role: 'system', content: `${JSON.stringify({ subject: 'I', checks: correction.checks,
        window: { startAt: formatOwnDayPlanTime(input.run.bounds.startAt, input.run.bounds.timeZone),
          endAt: formatOwnDayPlanTime(input.run.bounds.endAt, input.run.bounds.timeZone), timeZone: input.run.bounds.timeZone } })}\n\n${OWN_DAY_PLAN_CORRECTION_PROMPT}` });
    }
    return messages;
  };
  const fits = () => estimateApiMessagesTokens(buildMessages()) + Math.ceil(JSON.stringify(tools).length / 2)
    + OWN_DAY_PLAN_OUTPUT_TOKENS + 512 <= (input.connection.contextWindowTokens ?? 65536);
  while (!fits() && candidates.length) candidates = candidates.slice(0, -1);
  const apiMessages = buildMessages();
  return { fits: fits(), apiMessages, candidateIds: candidates.map(book => book.id), execute: async (request: {
    apiKey: string; signal: AbortSignal; onRequestStart: () => Promise<void>;
    onTransportAttempt?: Parameters<typeof fetchAssistantLifeCompletion>[0]['onTransportAttempt'];
    onStage?: (stage: 'transport' | 'tool-parse' | 'paper-json' | 'paper-parse') => void;
  }) => {
    if (!fits() || correction?.attempted || input.run.requestCount >= getOwnDayPlanRequestLimit(input.run)) throw new Error('day-plan-request-unavailable');
    if (correction && correction.content.length > OWN_DAY_PLAN_PAPER_MAX_LENGTH) throw new Error('day-plan-paper-too-large');
    request.onStage?.('transport');
    const result = await fetchAssistantLifeCompletion({ ...request, connection: input.connection, envelope,
      contextSource: 'own-day-plan', userPrompt: '', apiMessagesOverride: apiMessages,
      timeoutMs: ASSISTANT_INTERNAL_PAPER_REQUEST_TIMEOUT_MS,
      request: { ...buildAssistantLifeShortJsonRequest(input.connection, 0.7), max_tokens: OWN_DAY_PLAN_OUTPUT_TOKENS,
        ...(isOfficialQwen397bConnection(input.connection) || isOfficialQwenFlashConnection(input.connection) ? { enable_thinking: false } : {}),
        ...(allowTools ? { tools, tool_choice: 'auto' }
          : forceJsonPaper ? { tools, tool_choice: 'none', response_format: { type: 'json_object' } } : {}) },
    });
    const raw = result.payload.choices?.[0]?.message as OpenAiCompatibleToolCallMessage | undefined;
    request.onStage?.('tool-parse');
    const calls = parseOpenAiToolCalls(raw ?? {}, ownDayPlanTools);
    if (calls.rawCallCount) {
      if (!allowTools || calls.errors.length || !calls.invocations.length) throw new Error('day-plan-invalid-tools');
      return { kind: 'tools' as const, calls: calls.invocations, usage: result.usage };
    }
    request.onStage?.('paper-json');
    if (result.content.length > OWN_DAY_PLAN_PAPER_MAX_LENGTH) throw new Error('day-plan-paper-too-large');
    const objects = readJsonObjects(result.content);
    if (objects.length !== 1) return { kind: 'invalid-paper' as const, content: result.content,
      checks: [{ path: '$', code: 'day-plan-invalid-paper' }], reason: 'day-plan-invalid-paper', usage: result.usage };
    request.onStage?.('paper-parse');
    const paperValue = normalizeOwnDayPlanPaperFormat(objects[0]);
    try {
      return { kind: 'paper' as const, paper: parseOwnDayPlan(paperValue, input.run.bounds), usage: result.usage };
    } catch (error) {
      const reason = paperErrorCode(error);
      if (!reason) throw error;
      return { kind: 'invalid-paper' as const, content: result.content,
        checks: collectOwnDayPlanPaperChecks(paperValue, input.run.bounds, reason), reason, usage: result.usage };
    }
  } };
}
