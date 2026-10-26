import type { JunLuoWorkflowTemplate } from './workflowStore';

export const WORKFLOW_TEMPLATES: JunLuoWorkflowTemplate[] = [
  {
    description: '读取当前设备状态、天气和最近手机活动摘要。',
    id: 'morning_check',
    name: '早安检查',
    steps: [
      { id: 'system-status', input: {}, name: '读取设备状态', onError: 'continue', toolId: 'system_status.get_device_status' },
      { id: 'weather-current', input: {}, name: '读取当前天气', onError: 'continue', toolId: 'weather.get_current' },
      { id: 'phone-activity', input: { minutes: 180 }, name: '读取最近手机活动', onError: 'continue', toolId: 'phone_context.summarize_recent_activity' },
    ],
  },
  {
    description: '查看今日 App 使用和最近通知轻摘要。',
    id: 'phone_review',
    name: '手机使用复盘',
    steps: [
      { id: 'app-usage', input: { days: 1, limit: 8 }, name: '读取 App 使用时长', onError: 'continue', toolId: 'phone_context.get_app_usage' },
      { id: 'notifications', input: { limit: 8 }, name: '读取通知轻摘要', onError: 'continue', toolId: 'phone_context.get_notifications' },
    ],
  },
  {
    description: '按触发输入 query 搜索公开网页并保留诊断。',
    id: 'research_brief',
    name: '网页搜索简报',
    requiredInputs: ['query'],
    steps: [
      { id: 'research-search', input: { limit: 5, query: '{{query}}' }, name: '搜索公开网页', onError: 'stop', toolId: 'research.search_with_diagnostics' },
    ],
  },
];

export function listWorkflowTemplates() {
  return WORKFLOW_TEMPLATES.map((template) => ({
    description: template.description,
    id: template.id,
    name: template.name,
    requiredInputs: template.requiredInputs ?? [],
    stepCount: template.steps.length,
    steps: template.steps.map((step) => ({ id: step.id, name: step.name, toolId: step.toolId })),
  }));
}

export function getWorkflowTemplate(templateId: string) {
  return WORKFLOW_TEMPLATES.find((template) => template.id === templateId) ?? null;
}
