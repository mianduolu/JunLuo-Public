import { toolsWorkspaceStorageBridge as AsyncStorage } from '../sync/syncToolsWorkspaceStorageBridge';

export type JunLuoWorkflowOnError = 'continue' | 'stop';

export type JunLuoWorkflowStep = {
  id: string;
  input: Record<string, unknown>;
  name: string;
  onError: JunLuoWorkflowOnError;
  toolId: string;
};

export type JunLuoWorkflowRecord = {
  createdAt: number;
  description?: string;
  enabled: boolean;
  id: string;
  lastRunAt?: number;
  lastRunSummary?: string;
  mode: 'linear';
  name: string;
  runCount: number;
  steps: JunLuoWorkflowStep[];
  templateId?: string;
  updatedAt: number;
  version: 1;
};

export type JunLuoWorkflowTemplate = {
  description: string;
  id: string;
  name: string;
  requiredInputs?: string[];
  steps: JunLuoWorkflowStep[];
};

const WORKFLOW_STORE_KEY = 'junluo.tool.workflows.v1';
const MAX_WORKFLOWS = 80;

function createWorkflowId() {
  return `workflow-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createStepId(index: number) {
  return `step-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 6)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeStep(value: unknown, index: number): JunLuoWorkflowStep | null {
  if (!isRecord(value)) return null;
  const toolId = typeof value.toolId === 'string' ? value.toolId.trim() : '';
  const name = typeof value.name === 'string' && value.name.trim() ? value.name.trim() : toolId;
  if (!toolId || !name) return null;
  const onError = value.onError === 'continue' ? 'continue' : 'stop';
  return {
    id: typeof value.id === 'string' && value.id.trim() ? value.id.trim() : createStepId(index),
    input: isRecord(value.input) ? value.input : {},
    name,
    onError,
    toolId,
  };
}

function normalizeWorkflow(value: unknown): JunLuoWorkflowRecord | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === 'string' ? value.id.trim() : '';
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  const rawSteps = Array.isArray(value.steps) ? value.steps : [];
  const steps = rawSteps.map(normalizeStep).filter((step): step is JunLuoWorkflowStep => Boolean(step));
  if (!id || !name || !steps.length) return null;
  const now = Date.now();
  return {
    createdAt: typeof value.createdAt === 'number' ? value.createdAt : now,
    description: typeof value.description === 'string' ? value.description : undefined,
    enabled: typeof value.enabled === 'boolean' ? value.enabled : true,
    id,
    lastRunAt: typeof value.lastRunAt === 'number' ? value.lastRunAt : undefined,
    lastRunSummary: typeof value.lastRunSummary === 'string' ? value.lastRunSummary : undefined,
    mode: 'linear',
    name,
    runCount: typeof value.runCount === 'number' && Number.isFinite(value.runCount) ? value.runCount : 0,
    steps,
    templateId: typeof value.templateId === 'string' ? value.templateId : undefined,
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : now,
    version: 1,
  };
}

export function normalizeWorkflowSteps(value: unknown): JunLuoWorkflowStep[] {
  if (!Array.isArray(value)) return [];
  return value.map(normalizeStep).filter((step): step is JunLuoWorkflowStep => Boolean(step));
}

async function saveWorkflows(records: JunLuoWorkflowRecord[]) {
  const normalized = records.map(normalizeWorkflow).filter((item): item is JunLuoWorkflowRecord => Boolean(item));
  await AsyncStorage.setItem(WORKFLOW_STORE_KEY, JSON.stringify(normalized.slice(-MAX_WORKFLOWS)));
}

export async function loadWorkflows() {
  const raw = await AsyncStorage.getItem(WORKFLOW_STORE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.map(normalizeWorkflow).filter((item): item is JunLuoWorkflowRecord => Boolean(item))
      : [];
  } catch {
    return [];
  }
}

export async function getWorkflow(workflowId: string) {
  const workflows = await loadWorkflows();
  return workflows.find((workflow) => workflow.id === workflowId) ?? null;
}

export async function createWorkflowRecord(input: {
  description?: string;
  enabled?: boolean;
  name: string;
  steps: JunLuoWorkflowStep[];
  templateId?: string;
}) {
  const now = Date.now();
  const workflow: JunLuoWorkflowRecord = {
    createdAt: now,
    description: input.description,
    enabled: input.enabled ?? true,
    id: createWorkflowId(),
    mode: 'linear',
    name: input.name.trim(),
    runCount: 0,
    steps: input.steps,
    templateId: input.templateId,
    updatedAt: now,
    version: 1,
  };
  await saveWorkflows([...(await loadWorkflows()), workflow]);
  return workflow;
}

export async function updateWorkflowRecord(workflowId: string, patch: Partial<Pick<JunLuoWorkflowRecord, 'description' | 'enabled' | 'name' | 'steps'>>) {
  const workflows = await loadWorkflows();
  const index = workflows.findIndex((workflow) => workflow.id === workflowId);
  if (index < 0) return null;
  const current = workflows[index];
  const next: JunLuoWorkflowRecord = {
    ...current,
    ...patch,
    name: patch.name?.trim() || current.name,
    steps: patch.steps?.length ? patch.steps : current.steps,
    updatedAt: Date.now(),
  };
  workflows[index] = next;
  await saveWorkflows(workflows);
  return next;
}

export async function setWorkflowEnabled(workflowId: string, enabled: boolean) {
  return updateWorkflowRecord(workflowId, { enabled });
}

export async function recordWorkflowRun(workflowId: string, summary: string) {
  const workflows = await loadWorkflows();
  const index = workflows.findIndex((workflow) => workflow.id === workflowId);
  if (index < 0) return null;
  const current = workflows[index];
  const next: JunLuoWorkflowRecord = {
    ...current,
    lastRunAt: Date.now(),
    lastRunSummary: summary,
    runCount: current.runCount + 1,
    updatedAt: Date.now(),
  };
  workflows[index] = next;
  await saveWorkflows(workflows);
  return next;
}

export async function clearWorkflowsForTests() {
  await AsyncStorage.removeItem(WORKFLOW_STORE_KEY);
}
