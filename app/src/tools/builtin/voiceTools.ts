import { createToolSuccessResult } from '../toolResult';
import type { JunLuoToolCall, JunLuoToolDefinition, JunLuoToolPackage, JunLuoToolResult } from '../toolTypes';
import {
  readNumberInput,
  readStringInput,
  validationFailed,
} from './builtinToolValidation';

type VoiceTranscribeData = {
  durationMs?: number;
  source: 'native_speech';
  transcript: string;
};

async function executeVoiceTranscribe(call: JunLuoToolCall): Promise<JunLuoToolResult<VoiceTranscribeData>> {
  const transcript = readStringInput(call.input, 'transcript');
  if (!transcript) {
    return validationFailed(call, '手机内置语音识别没有得到文字', '没有完成语音转写');
  }
  const durationMs = readNumberInput(call.input, 'durationMs');
  return createToolSuccessResult(call, '已记录手机内置语音识别结果', {
    durationMs,
    source: 'native_speech',
    transcript,
  });
}

export const voiceTranscribeTool: JunLuoToolDefinition<Record<string, unknown>, VoiceTranscribeData> = {
  id: 'voice.transcribe',
  chatExposure: 'explicit_only',
  proactiveEligible: false,
  packageId: 'voice',
  name: '记录语音转写',
  description: '记录手机内置语音识别已经得到的文字；不调用已停用的电脑后端文件转写。',
  inputSchema: {
    type: 'object',
    required: ['transcript'],
    properties: {
      durationMs: { type: 'number', description: '语音时长，毫秒' },
      transcript: { type: 'string', description: '手机内置语音识别得到的文字' },
    },
  },
  permission: 'allow',
  riskLevel: 'read',
  readOnly: true,
  executor: executeVoiceTranscribe,
};

export const voiceToolPackage: JunLuoToolPackage = {
  id: 'voice',
  name: '语音识别',
  description: '记录手机内置语音识别结果，提供可审计的语音转写回执。',
  category: 'media',
  tools: [voiceTranscribeTool],
  defaultEnabled: true,
  riskLevel: 'read',
  source: 'builtin',
};
