import { Alert } from 'react-native';

import type { JunLuoToolCall, JunLuoToolDefinition } from './toolTypes';

export type JunLuoToolPermissionPromptDecision = 'allowed' | 'cancelled';

export type JunLuoToolPermissionPrompt = (
  tool: JunLuoToolDefinition,
  call: JunLuoToolCall,
) => Promise<JunLuoToolPermissionPromptDecision>;

const MAX_INPUT_PREVIEW_FIELDS = 8;
const MAX_STRING_PREVIEW_LENGTH = 80;

function formatPreviewValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return value.slice(0, MAX_STRING_PREVIEW_LENGTH);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[数组，${value.length} 项]`;
  if (value && typeof value === 'object') return `{对象：${Object.keys(value).slice(0, MAX_INPUT_PREVIEW_FIELDS).join(', ')}}`;
  return '[未知值]';
}

function formatInputPreview(input: Record<string, unknown>) {
  const entries = Object.entries(input).slice(0, MAX_INPUT_PREVIEW_FIELDS);
  if (!entries.length) return '参数：无';
  return entries.map(([key, value]) => `${key}: ${formatPreviewValue(value)}`).join('\n');
}

export const promptForToolPermission: JunLuoToolPermissionPrompt = (tool, call) => (
  new Promise((resolve) => {
    Alert.alert(
      '允许白云执行这个动作吗？',
      [
        `工具：${tool.name}`,
        tool.description,
        `风险：${tool.riskLevel}`,
        formatInputPreview(call.input),
      ].filter(Boolean).join('\n\n'),
      [
        { text: '取消', style: 'cancel', onPress: () => resolve('cancelled') },
        { text: '允许一次', onPress: () => resolve('allowed') },
      ],
    );
  })
);
