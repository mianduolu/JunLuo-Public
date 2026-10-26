import { createToolError } from './toolErrors';
import { executeToolCall } from './toolExecution';
import { getToolDefinition } from './toolRegistry';
import type { JunLuoToolCall, JunLuoToolExecutorContext, JunLuoToolResult } from './toolTypes';
import { recordWorkflowRun, type JunLuoWorkflowRecord, type JunLuoWorkflowStep } from './workflowStore';

export type JunLuoWorkflowStepRun = {
  input: Record<string, unknown>;
  ok: boolean;
  result: JunLuoToolResult;
  stepId: string;
  stepName: string;
  toolId: string;
};

export type JunLuoWorkflowRunData = {
  completedStepCount: number;
  executionId: string;
  failedStepId?: string;
  input: Record<string, unknown>;
  ok: boolean;
  stepResults: JunLuoWorkflowStepRun[];
  stoppedAtStepId?: string;
  summary: string;
  totalStepCount: number;
  workflowId: string;
  workflowName: string;
};

export function isWorkflowStepToolAllowed(toolId: string) {
  if (toolId.startsWith('workflow.')) return false;
  const tool = getToolDefinition(toolId);
  if (!tool) return false;
  if (tool.riskLevel === 'dangerous' || tool.riskLevel === 'device_control' || tool.riskLevel === 'social_action') return false;
  if (tool.riskLevel === 'external_network') return tool.readOnly === true;
  return tool.riskLevel === 'read' || tool.riskLevel === 'write_local';
}

export function validateWorkflowSteps(steps: JunLuoWorkflowStep[]) {
  if (!steps.length) {
    return createToolError('VALIDATION_FAILED', '工作流至少需要一个步骤');
  }
  for (const step of steps) {
    if (!step.name.trim() || !step.toolId.trim()) {
      return createToolError('VALIDATION_FAILED', '工作流步骤缺少名称或工具 ID');
    }
    const tool = getToolDefinition(step.toolId);
    if (!tool) {
      return createToolError('TOOL_NOT_FOUND', `工作流步骤引用了不存在的工具：${step.toolId}`);
    }
    if (!isWorkflowStepToolAllowed(step.toolId)) {
      return createToolError('PERMISSION_DENIED', `工作流第一版不允许编排这个工具：${step.toolId}`, {
        riskLevel: tool.riskLevel,
        toolId: step.toolId,
      });
    }
  }
  return null;
}

function replaceTemplateValue(value: unknown, input: Record<string, unknown>): unknown {
  if (typeof value === 'string') {
    const exact = /^\{\{([A-Za-z0-9_.-]+)\}\}$/.exec(value);
    if (exact) return input[exact[1]] ?? '';
    return value.replace(/\{\{([A-Za-z0-9_.-]+)\}\}/g, (_, key: string) => String(input[key] ?? ''));
  }
  if (Array.isArray(value)) return value.map((item) => replaceTemplateValue(item, input));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, replaceTemplateValue(item, input)]),
    );
  }
  return value;
}

export function resolveWorkflowStepInput(step: JunLuoWorkflowStep, input: Record<string, unknown>) {
  return replaceTemplateValue(step.input, input) as Record<string, unknown>;
}

function createStepCall(workflowCall: JunLuoToolCall, workflow: JunLuoWorkflowRecord, step: JunLuoWorkflowStep, input: Record<string, unknown>, index: number): JunLuoToolCall {
  return {
    callId: `${workflowCall.callId}:step-${index + 1}-${step.id}`,
    createdAt: Date.now(),
    input,
    requestedBy: workflowCall.requestedBy,
    sourceMessageId: workflowCall.sourceMessageId,
    toolId: step.toolId,
  };
}

export async function executeWorkflowRecord(
  workflowCall: JunLuoToolCall,
  workflow: JunLuoWorkflowRecord,
  input: Record<string, unknown> = {},
  context: JunLuoToolExecutorContext = { backupRestoreLeaseHeld: false },
): Promise<JunLuoWorkflowRunData> {
  const recordRun = (summary: string) => context.runBackupRestoreDataEpochCommit
    ? context.runBackupRestoreDataEpochCommit(() => recordWorkflowRun(workflow.id, summary))
    : recordWorkflowRun(workflow.id, summary);
  const validationError = validateWorkflowSteps(workflow.steps);
  const executionId = `workflow-${workflow.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  if (validationError) {
    const summary = `工作流没有运行：${validationError.message}`;
    await recordRun(summary);
    return {
      completedStepCount: 0,
      executionId,
      input,
      ok: false,
      stepResults: [],
      summary,
      totalStepCount: workflow.steps.length,
      workflowId: workflow.id,
      workflowName: workflow.name,
    };
  }

  const stepResults: JunLuoWorkflowStepRun[] = [];
  for (const [index, step] of workflow.steps.entries()) {
    const stepInput = resolveWorkflowStepInput(step, input);
    const result = await executeToolCall(createStepCall(workflowCall, workflow, step, stepInput, index), {
      backupRestoreLeaseHeld: context.backupRestoreLeaseHeld,
      executionId,
    });
    stepResults.push({
      input: stepInput,
      ok: result.ok,
      result,
      stepId: step.id,
      stepName: step.name,
      toolId: step.toolId,
    });
    if (!result.ok && step.onError !== 'continue') {
      const summary = `工作流停在第 ${index + 1}/${workflow.steps.length} 步：${step.name}。${result.summary}`;
      await recordRun(summary);
      return {
        completedStepCount: stepResults.filter((item) => item.ok).length,
        executionId,
        failedStepId: step.id,
        input,
        ok: false,
        stepResults,
        stoppedAtStepId: step.id,
        summary,
        totalStepCount: workflow.steps.length,
        workflowId: workflow.id,
        workflowName: workflow.name,
      };
    }
  }

  const failedCount = stepResults.filter((item) => !item.ok).length;
  const summary = failedCount
    ? `工作流运行结束：${workflow.name}，成功 ${stepResults.length - failedCount}/${workflow.steps.length} 步，失败 ${failedCount} 步。`
    : `工作流运行完成：${workflow.name}，共 ${workflow.steps.length} 步。`;
  await recordRun(summary);
  return {
    completedStepCount: stepResults.filter((item) => item.ok).length,
    executionId,
    input,
    ok: failedCount === 0,
    stepResults,
    summary,
    totalStepCount: workflow.steps.length,
    workflowId: workflow.id,
    workflowName: workflow.name,
  };
}
