import { createToolError } from '../toolErrors';
import { createToolErrorResult, createToolSuccessResult } from '../toolResult';
import type {
  JunLuoToolCall,
  JunLuoToolDefinition,
  JunLuoToolExecutorContext,
  JunLuoToolPackage,
  JunLuoToolResult,
} from '../toolTypes';
import { executeWorkflowRecord, validateWorkflowSteps, type JunLuoWorkflowRunData } from '../workflowExecutor';
import {
  createWorkflowRecord,
  getWorkflow,
  loadWorkflows,
  normalizeWorkflowSteps,
  setWorkflowEnabled,
  updateWorkflowRecord,
  type JunLuoWorkflowRecord,
} from '../workflowStore';
import { getWorkflowTemplate, listWorkflowTemplates } from '../workflowTemplates';
import { readBooleanInput, readOptionalStringInput, readStringInput, validationFailed } from './builtinToolValidation';

function workflowSummary(workflow: JunLuoWorkflowRecord) {
  return {
    description: workflow.description,
    enabled: workflow.enabled,
    id: workflow.id,
    lastRunAt: workflow.lastRunAt,
    lastRunSummary: workflow.lastRunSummary,
    mode: workflow.mode,
    name: workflow.name,
    runCount: workflow.runCount,
    stepCount: workflow.steps.length,
    templateId: workflow.templateId,
    updatedAt: workflow.updatedAt,
    version: workflow.version,
  };
}

function readInputObject(call: JunLuoToolCall, key: string) {
  const value = call.input[key];
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function missingTemplateInputs(workflow: JunLuoWorkflowRecord, input: Record<string, unknown>) {
  const template = workflow.templateId ? getWorkflowTemplate(workflow.templateId) : null;
  const requiredInputs = template?.requiredInputs ?? [];
  return requiredInputs.filter((key) => {
    const value = input[key];
    return value === undefined || value === null || (typeof value === 'string' && !value.trim());
  });
}

async function executeListWorkflows(call: JunLuoToolCall) {
  const workflows = await loadWorkflows();
  return createToolSuccessResult(call, workflows.length ? `共有 ${workflows.length} 个工作流` : '还没有保存的工作流', {
    workflows: workflows.map(workflowSummary),
  });
}

async function executeGetWorkflow(call: JunLuoToolCall) {
  const workflowId = readStringInput(call.input, 'workflowId');
  if (!workflowId) return validationFailed(call, '缺少 workflowId', '没有读取工作流：缺少 ID');
  const workflow = await getWorkflow(workflowId);
  if (!workflow) {
    return createToolErrorResult(call, createToolError('VALIDATION_FAILED', `工作流不存在：${workflowId}`), '没有读取工作流：ID 不存在');
  }
  return createToolSuccessResult(call, `已读取工作流：${workflow.name}`, { workflow });
}

async function executeListTemplates(call: JunLuoToolCall) {
  const templates = listWorkflowTemplates();
  return createToolSuccessResult(call, `可用工作流模板：${templates.map((template) => template.name).join('、')}`, { templates });
}

async function executeCreateFromTemplate(call: JunLuoToolCall) {
  const templateId = readStringInput(call.input, 'templateId');
  if (!templateId) return validationFailed(call, '缺少 templateId', '没有创建工作流：缺少模板 ID');
  const template = getWorkflowTemplate(templateId);
  if (!template) {
    return createToolErrorResult(call, createToolError('VALIDATION_FAILED', `模板不存在：${templateId}`), '没有创建工作流：模板不存在');
  }
  const name = readOptionalStringInput(call.input, 'name') || template.name;
  const description = readOptionalStringInput(call.input, 'description') || template.description;
  const enabled = readBooleanInput(call.input, 'enabled');
  const workflow = await createWorkflowRecord({
    description,
    enabled: enabled ?? true,
    name,
    steps: template.steps,
    templateId: template.id,
  });
  return createToolSuccessResult(call, `已保存工作流：${workflow.name}`, { workflow: workflowSummary(workflow), templateId });
}

async function executeCreateWorkflow(call: JunLuoToolCall) {
  const name = readStringInput(call.input, 'name');
  if (!name) return validationFailed(call, '缺少工作流名称', '没有创建工作流：缺少名称');
  const steps = normalizeWorkflowSteps(call.input.steps);
  const validationError = validateWorkflowSteps(steps);
  if (validationError) return createToolErrorResult(call, validationError, '没有创建工作流：步骤不安全或无效');
  const workflow = await createWorkflowRecord({
    description: readOptionalStringInput(call.input, 'description'),
    enabled: readBooleanInput(call.input, 'enabled') ?? true,
    name,
    steps,
  });
  return createToolSuccessResult(call, `已保存工作流：${workflow.name}`, { workflow: workflowSummary(workflow) });
}

async function executeUpdateWorkflow(call: JunLuoToolCall) {
  const workflowId = readStringInput(call.input, 'workflowId');
  if (!workflowId) return validationFailed(call, '缺少 workflowId', '没有更新工作流：缺少 ID');
  const patch: Parameters<typeof updateWorkflowRecord>[1] = {};
  const name = readOptionalStringInput(call.input, 'name');
  const description = readOptionalStringInput(call.input, 'description');
  const enabled = readBooleanInput(call.input, 'enabled');
  if (name) patch.name = name;
  if (description !== undefined) patch.description = description;
  if (enabled !== undefined) patch.enabled = enabled;
  if (Array.isArray(call.input.steps)) {
    const steps = normalizeWorkflowSteps(call.input.steps);
    const validationError = validateWorkflowSteps(steps);
    if (validationError) return createToolErrorResult(call, validationError, '没有更新工作流：步骤不安全或无效');
    patch.steps = steps;
  }
  const workflow = await updateWorkflowRecord(workflowId, patch);
  if (!workflow) {
    return createToolErrorResult(call, createToolError('VALIDATION_FAILED', `工作流不存在：${workflowId}`), '没有更新工作流：ID 不存在');
  }
  return createToolSuccessResult(call, `已更新工作流：${workflow.name}`, { workflow: workflowSummary(workflow) });
}

async function executeSetEnabled(call: JunLuoToolCall, enabled: boolean) {
  const workflowId = readStringInput(call.input, 'workflowId');
  if (!workflowId) return validationFailed(call, '缺少 workflowId', enabled ? '没有启用工作流：缺少 ID' : '没有停用工作流：缺少 ID');
  const workflow = await setWorkflowEnabled(workflowId, enabled);
  if (!workflow) {
    return createToolErrorResult(call, createToolError('VALIDATION_FAILED', `工作流不存在：${workflowId}`), enabled ? '没有启用工作流：ID 不存在' : '没有停用工作流：ID 不存在');
  }
  return createToolSuccessResult(call, `${enabled ? '已启用' : '已停用'}工作流：${workflow.name}`, { workflow: workflowSummary(workflow) });
}

async function executeTriggerWorkflow(
  call: JunLuoToolCall,
  context?: JunLuoToolExecutorContext,
): Promise<JunLuoToolResult<JunLuoWorkflowRunData>> {
  const workflowId = readStringInput(call.input, 'workflowId');
  if (!workflowId) return validationFailed(call, '缺少 workflowId', '没有运行工作流：缺少 ID');
  const workflow = await getWorkflow(workflowId);
  if (!workflow) {
    return createToolErrorResult(call, createToolError('VALIDATION_FAILED', `工作流不存在：${workflowId}`), '没有运行工作流：ID 不存在');
  }
  if (!workflow.enabled) {
    return createToolErrorResult(call, createToolError('PERMISSION_DENIED', `工作流已停用：${workflow.name}`), '没有运行工作流：它现在是停用状态');
  }
  const input = readInputObject(call, 'input');
  const missing = missingTemplateInputs(workflow, input);
  if (missing.length) {
    return validationFailed(call, `缺少工作流触发输入：${missing.join(', ')}`, `没有运行工作流：缺少 ${missing.join('、')}`);
  }
  const run = await executeWorkflowRecord(call, workflow, input, context);
  if (!run.ok) {
    return {
      ...createToolErrorResult<JunLuoWorkflowRunData>(call, createToolError('EXECUTION_FAILED', run.summary, run), run.summary),
      data: run,
    };
  }
  return createToolSuccessResult(call, run.summary, run);
}

const emptySchema = { type: 'object' as const, properties: {} };

export const workflowTools: JunLuoToolDefinition[] = [
  {
    id: 'workflow.list',
    chatExposure: 'explicit_only',
    proactiveEligible: false,
    packageId: 'workflow',
    name: '列出工作流',
    description: '列出君落已保存的手动工作流。',
    inputSchema: emptySchema,
    permission: 'allow',
    riskLevel: 'read',
    readOnly: true,
    executor: executeListWorkflows,
  },
  {
    id: 'workflow.get',
    chatExposure: 'explicit_only',
    proactiveEligible: false,
    packageId: 'workflow',
    name: '读取工作流',
    description: '读取指定工作流的完整步骤。',
    inputSchema: { type: 'object', required: ['workflowId'], properties: { workflowId: { type: 'string', description: '工作流 ID' } } },
    permission: 'allow',
    riskLevel: 'read',
    readOnly: true,
    executor: executeGetWorkflow,
  },
  {
    id: 'workflow.list_templates',
    chatExposure: 'explicit_only',
    proactiveEligible: false,
    packageId: 'workflow',
    name: '列出工作流模板',
    description: '列出可用于创建工作流的内置简单模板。',
    inputSchema: emptySchema,
    permission: 'allow',
    riskLevel: 'read',
    readOnly: true,
    executor: executeListTemplates,
  },
  {
    id: 'workflow.create_from_template',
    chatExposure: 'explicit_only',
    proactiveEligible: false,
    packageId: 'workflow',
    name: '从模板创建工作流',
    description: '从内置模板创建一个线性手动工作流。',
    inputSchema: {
      type: 'object',
      required: ['templateId'],
      properties: {
        description: { type: 'string', description: '自定义描述' },
        enabled: { type: 'boolean', description: '是否创建后启用' },
        name: { type: 'string', description: '自定义名称' },
        templateId: { type: 'string', enum: ['morning_check', 'phone_review', 'research_brief'], description: '模板 ID' },
      },
    },
    permission: 'ask',
    riskLevel: 'write_local',
    readOnly: false,
    executor: executeCreateFromTemplate,
  },
  {
    id: 'workflow.create',
    chatExposure: 'explicit_only',
    proactiveEligible: false,
    packageId: 'workflow',
    name: '创建工作流',
    description: '用结构化 steps 创建一个线性手动工作流。',
    inputSchema: {
      type: 'object',
      required: ['name', 'steps'],
      properties: {
        description: { type: 'string', description: '工作流描述' },
        enabled: { type: 'boolean', description: '是否启用' },
        name: { type: 'string', description: '工作流名称' },
        steps: { type: 'array', description: '线性步骤数组', items: { type: 'object' } },
      },
    },
    permission: 'ask',
    riskLevel: 'write_local',
    readOnly: false,
    executor: executeCreateWorkflow,
  },
  {
    id: 'workflow.update',
    chatExposure: 'explicit_only',
    proactiveEligible: false,
    packageId: 'workflow',
    name: '更新工作流',
    description: '更新一个已保存的线性手动工作流。',
    inputSchema: {
      type: 'object',
      required: ['workflowId'],
      properties: {
        description: { type: 'string', description: '工作流描述' },
        enabled: { type: 'boolean', description: '是否启用' },
        name: { type: 'string', description: '工作流名称' },
        steps: { type: 'array', description: '线性步骤数组', items: { type: 'object' } },
        workflowId: { type: 'string', description: '工作流 ID' },
      },
    },
    permission: 'ask',
    riskLevel: 'write_local',
    readOnly: false,
    executor: executeUpdateWorkflow,
  },
  {
    id: 'workflow.enable',
    chatExposure: 'explicit_only',
    proactiveEligible: false,
    packageId: 'workflow',
    name: '启用工作流',
    description: '允许指定工作流被手动触发。',
    inputSchema: { type: 'object', required: ['workflowId'], properties: { workflowId: { type: 'string', description: '工作流 ID' } } },
    permission: 'ask',
    riskLevel: 'write_local',
    readOnly: false,
    executor: (call) => executeSetEnabled(call, true),
  },
  {
    id: 'workflow.disable',
    chatExposure: 'explicit_only',
    proactiveEligible: false,
    packageId: 'workflow',
    name: '停用工作流',
    description: '禁止指定工作流被手动触发。',
    inputSchema: { type: 'object', required: ['workflowId'], properties: { workflowId: { type: 'string', description: '工作流 ID' } } },
    permission: 'ask',
    riskLevel: 'write_local',
    readOnly: false,
    executor: (call) => executeSetEnabled(call, false),
  },
  {
    id: 'workflow.trigger',
    chatExposure: 'explicit_only',
    proactiveEligible: false,
    packageId: 'workflow',
    name: '手动触发工作流',
    description: '手动运行一个已保存且启用的线性工作流。',
    inputSchema: {
      type: 'object',
      required: ['workflowId'],
      properties: {
        input: { type: 'object', description: '模板参数，例如 research_brief 的 query' },
        workflowId: { type: 'string', description: '工作流 ID' },
      },
    },
    permission: 'ask',
    riskLevel: 'write_local',
    readOnly: false,
    backupRestoreSafeOutsideLease: true,
    executor: executeTriggerWorkflow,
  },
];

export const workflowToolPackage: JunLuoToolPackage = {
  id: 'workflow',
  name: '工作流',
  description: '保存、查看、启停和手动触发安全线性工作流。',
  category: 'workflow',
  defaultEnabled: true,
  riskLevel: 'write_local',
  source: 'builtin',
  tools: workflowTools,
};
