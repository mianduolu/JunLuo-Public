export type WorkflowIntentRoute = {
  candidateTools: string[];
  reason: string;
  unsupported?: boolean;
};

const WORKFLOW_ID_PATTERN = /workflow-[A-Za-z0-9-]+/;
const NATURAL_COMPOSE_PATTERN = /(?:先|第一步|然后|再|最后).{0,80}(?:工作流|自动流程|流程)/;

function inferTemplateId(text: string) {
  if (/早安|早上|晨间|起床/.test(text)) return 'morning_check';
  if (/手机(?:使用|复盘|监督)|刷了多久|通知(?:摘要)?|App|app/.test(text)) return 'phone_review';
  if (/搜索简报|网页简报|研究简报|搜(?:索)?一下|查一下/.test(text)) return 'research_brief';
  return '';
}

export function routeWorkflowIntent(text: string): WorkflowIntentRoute | null {
  const trimmed = text.trim();
  if (!trimmed || !/工作流|workflow|流程/.test(trimmed)) return null;
  if (NATURAL_COMPOSE_PATTERN.test(trimmed)) {
    return { candidateTools: [], reason: 'workflow_natural_composition_unsupported', unsupported: true };
  }
  if (/模板|有哪些.*流程|有哪些.*工作流/.test(trimmed)) {
    return { candidateTools: ['workflow.list_templates'], reason: 'workflow_list_templates' };
  }
  if (/创建|新建|保存|做一个|建一个/.test(trimmed)) {
    return { candidateTools: ['workflow.create_from_template'], reason: 'workflow_create_from_template' };
  }
  if (/运行|触发|执行|跑一下|启动/.test(trimmed)) {
    return { candidateTools: ['workflow.trigger'], reason: 'workflow_trigger' };
  }
  if (/启用/.test(trimmed)) {
    return { candidateTools: ['workflow.enable'], reason: 'workflow_enable' };
  }
  if (/停用|禁用|关掉|关闭/.test(trimmed)) {
    return { candidateTools: ['workflow.disable'], reason: 'workflow_disable' };
  }
  if (/查看|详情/.test(trimmed) && WORKFLOW_ID_PATTERN.test(trimmed)) {
    return { candidateTools: ['workflow.get'], reason: 'workflow_get' };
  }
  if (/列表|有哪些|全部|看看/.test(trimmed)) {
    return { candidateTools: ['workflow.list'], reason: 'workflow_list' };
  }
  return null;
}

export function parseWorkflowInputFromText(toolId: string, text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const workflowId = WORKFLOW_ID_PATTERN.exec(trimmed)?.[0];
  if (toolId === 'workflow.list' || toolId === 'workflow.list_templates') return {};
  if (toolId === 'workflow.get' || toolId === 'workflow.enable' || toolId === 'workflow.disable') {
    return workflowId ? { workflowId } : null;
  }
  if (toolId === 'workflow.create_from_template') {
    const templateId = inferTemplateId(trimmed);
    if (!templateId) return null;
    return { templateId };
  }
  if (toolId === 'workflow.trigger') {
    if (!workflowId) return null;
    const query = /(?:query|关键词|搜索|查一下|搜一下)[:：]?\s*([^，。！？\n]+)/i.exec(trimmed)?.[1]?.trim();
    return {
      ...(query ? { input: { query } } : {}),
      workflowId,
    };
  }
  return null;
}
