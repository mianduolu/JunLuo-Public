import {
  BODY_SIGNAL_BATTERY_TOOL_DESCRIPTION,
  BODY_SIGNAL_LATEST_TOOL_DESCRIPTION,
  BODY_SIGNAL_SUMMARY_TOOL_DESCRIPTION,
  BODY_SIGNAL_TOOL_PACKAGE_DESCRIPTION,
  formatBodySignalSummaryForTool,
  formatLatestBatteryForTool,
  formatLatestBodySignalForTool,
  isSameLocalDay,
  presentBodySignalSnapshot,
  type BodySignalAiSnapshot,
} from '../../bodySignal/bodySignalAiPresentation';
import { createToolErrorResult, createToolSuccessResult } from '../toolResult';
import {
  BODY_SIGNAL_STEPS_HISTORY_DESCRIPTION,
  BODY_SIGNAL_SLEEP_HISTORY_DESCRIPTION,
} from '../bodySignalHistoryToolDefinition';
import type { JunLuoToolCall, JunLuoToolDefinition, JunLuoToolPackage } from '../toolTypes';

async function loadAiSnapshot(now = Date.now()) {
  const { loadBodySignalSnapshot } = await import('../../bodySignal/bodySignalReader');
  const snapshot = await loadBodySignalSnapshot(now);
  return presentBodySignalSnapshot(snapshot, now);
}

async function executeGetLatest(call: JunLuoToolCall) {
  const data = await loadAiSnapshot();
  return createToolSuccessResult<BodySignalAiSnapshot>(
    call,
    formatLatestBodySignalForTool(data),
    data,
  );
}

async function executeGetSummary(call: JunLuoToolCall) {
  const data = await loadAiSnapshot();
  const todayData: BodySignalAiSnapshot = {
    ...data,
    latestHeartRate: data.latestHeartRate && isSameLocalDay(data.latestHeartRate.measuredAt, data.checkedAt)
      ? data.latestHeartRate
      : undefined,
    recentHeartRates: data.recentHeartRates.filter((reading) => (
      isSameLocalDay(reading.measuredAt, data.checkedAt)
    )),
  };
  return createToolSuccessResult<BodySignalAiSnapshot>(
    call,
    formatBodySignalSummaryForTool(todayData),
    todayData,
  );
}

async function executeGetBattery(call: JunLuoToolCall) {
  const data = await loadAiSnapshot();
  return createToolSuccessResult<BodySignalAiSnapshot>(
    call,
    formatLatestBatteryForTool(data),
    data,
  );
}

export const bodySignalGetLatestTool: JunLuoToolDefinition<Record<string, unknown>, BodySignalAiSnapshot> = {
  id: 'body_signal.get_latest',
  chatExposure: 'candidate',
  proactiveEligible: true,
  packageId: 'body_signal',
  name: '读取最近身体信号',
  description: BODY_SIGNAL_LATEST_TOOL_DESCRIPTION,
  inputSchema: { type: 'object' },
  permission: 'allow',
  riskLevel: 'read',
  readOnly: true,
  executor: executeGetLatest,
};

export const bodySignalGetSummaryTool: JunLuoToolDefinition<Record<string, unknown>, BodySignalAiSnapshot> = {
  id: 'body_signal.get_summary',
  chatExposure: 'candidate',
  proactiveEligible: true,
  packageId: 'body_signal',
  name: '读取今日身体信号摘要',
  description: BODY_SIGNAL_SUMMARY_TOOL_DESCRIPTION,
  inputSchema: { type: 'object' },
  permission: 'allow',
  riskLevel: 'read',
  readOnly: true,
  executor: executeGetSummary,
};

export const bodySignalGetBatteryTool: JunLuoToolDefinition<Record<string, unknown>, BodySignalAiSnapshot> = {
  id: 'body_signal.get_battery',
  chatExposure: 'candidate',
  proactiveEligible: true,
  packageId: 'body_signal',
  name: '读取戒指电量',
  description: BODY_SIGNAL_BATTERY_TOOL_DESCRIPTION,
  inputSchema: { type: 'object' },
  permission: 'allow',
  riskLevel: 'read',
  readOnly: true,
  executor: executeGetBattery,
};

async function executeGetHistory(call: JunLuoToolCall, kind: 'steps' | 'sleep') {
  try {
    const { loadBodySignalHistoryForTool } = await import('../../bodySignal/bodySignalHistoryToolReader');
    const result = await loadBodySignalHistoryForTool(kind);
    return result.failed
      ? createToolErrorResult(call, { code: 'READ_FAILED', message: result.text }, result.text)
      : createToolSuccessResult(call, result.text);
  } catch {
    const text = '这次暂时没能读取记录。';
    return createToolErrorResult(call, { code: 'READ_FAILED', message: text }, text);
  }
}

export const bodySignalGetStepsHistoryTool: JunLuoToolDefinition = {
  id: 'body_signal.get_steps_history',
  chatExposure: 'candidate',
  proactiveEligible: true,
  packageId: 'body_signal',
  name: '查看步数记录',
  description: BODY_SIGNAL_STEPS_HISTORY_DESCRIPTION,
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  permission: 'allow',
  riskLevel: 'read',
  readOnly: true,
  executor: call => executeGetHistory(call, 'steps'),
};

export const bodySignalGetSleepHistoryTool: JunLuoToolDefinition = {
  id: 'body_signal.get_sleep_history',
  chatExposure: 'candidate',
  proactiveEligible: true,
  packageId: 'body_signal',
  name: '查看主要睡眠记录',
  description: BODY_SIGNAL_SLEEP_HISTORY_DESCRIPTION,
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  permission: 'allow',
  riskLevel: 'read',
  readOnly: true,
  executor: call => executeGetHistory(call, 'sleep'),
};

export const bodySignalToolPackage: JunLuoToolPackage = {
  id: 'body_signal',
  name: '身体信号',
  description: BODY_SIGNAL_TOOL_PACKAGE_DESCRIPTION,
  category: 'body_signal',
  tools: [
    bodySignalGetLatestTool,
    bodySignalGetSummaryTool,
    bodySignalGetBatteryTool,
    bodySignalGetStepsHistoryTool,
    bodySignalGetSleepHistoryTool,
  ],
  defaultEnabled: true,
  riskLevel: 'read',
  source: 'builtin',
};
