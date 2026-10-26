import {
  clickPhoneAccessibilityText,
  getPhoneAccessibilitySnapshot,
  launchPhoneApp,
  performPhoneAccessibilityBack,
  swipePhoneAccessibilityPoint,
  tapPhoneAccessibilityPoint,
  type AccessibilityActionResult,
  type AccessibilitySnapshot,
} from '../../backend/phoneActivityNative';
import { createToolSuccessResult, createToolErrorResult } from '../toolResult';
import { createToolError } from '../toolErrors';
import { APP_LAUNCH_DESCRIPTION, APP_LAUNCH_APP_NAME_DESCRIPTION, APP_LAUNCH_UNAVAILABLE } from '../chatAppLaunch';
import type { JunLuoToolCall, JunLuoToolDefinition, JunLuoToolPackage, JunLuoToolResult } from '../toolTypes';
import {
  readNumberInput,
  readStringInput,
  validationFailed,
} from './builtinToolValidation';
import { deviceSystemBleTools } from './deviceSystemBleTools';

type DeviceActionData = AccessibilityActionResult & Record<string, unknown>;

type DeviceSnapshotData = AccessibilitySnapshot & {
  maxNodes: number;
};

function actionFailed<TData = unknown>(call: JunLuoToolCall, result: AccessibilityActionResult, summary: string) {
  return validationFailed<TData>(call, result.reason || '设备操作失败', summary);
}

function ensureFiniteNumber(call: JunLuoToolCall, key: string) {
  const value = readNumberInput(call.input, key);
  if (typeof value !== 'number') {
    return { ok: false as const, result: validationFailed<DeviceActionData>(call, `缺少或无效的 ${key}`, '没有执行设备操作') };
  }
  return { ok: true as const, value };
}

async function executeDeviceSnapshot(call: JunLuoToolCall): Promise<JunLuoToolResult<DeviceSnapshotData>> {
  const maxNodesInput = readNumberInput(call.input, 'maxNodes');
  const maxNodes = Math.max(1, Math.min(200, Math.round(maxNodesInput ?? 80)));
  const snapshot = await getPhoneAccessibilitySnapshot(maxNodes);
  if (!snapshot.ok) {
    return actionFailed<DeviceSnapshotData>(call, snapshot, `没有读取到当前手机窗口：${snapshot.reason}`);
  }
  const nodeCount = snapshot.nodes?.length ?? 0;
  const packageName = snapshot.packageName ? `（${snapshot.packageName}）` : '';
  return createToolSuccessResult(call, `已读取当前手机窗口${packageName}，共 ${nodeCount} 个节点`, {
    ...snapshot,
    maxNodes,
  });
}

async function executeDeviceClickText(call: JunLuoToolCall): Promise<JunLuoToolResult<DeviceActionData>> {
  const text = readStringInput(call.input, 'text');
  if (!text) return validationFailed(call, '缺少要点击的文字', '没有执行文字点击');
  const result = await clickPhoneAccessibilityText(text);
  if (!result.ok) return actionFailed(call, result, `没有点击文字：${text}`);
  return createToolSuccessResult(call, `已点击文字：${text}`, { ...result, text });
}

async function executeDeviceTapPoint(call: JunLuoToolCall): Promise<JunLuoToolResult<DeviceActionData>> {
  const x = ensureFiniteNumber(call, 'x');
  if (!x.ok) return x.result;
  const y = ensureFiniteNumber(call, 'y');
  if (!y.ok) return y.result;
  const result = await tapPhoneAccessibilityPoint(x.value, y.value);
  if (!result.ok) return actionFailed(call, result, `没有点击坐标：${Math.round(x.value)}, ${Math.round(y.value)}`);
  return createToolSuccessResult(call, `已点击坐标：${Math.round(x.value)}, ${Math.round(y.value)}`, {
    ...result,
    x: Math.round(x.value),
    y: Math.round(y.value),
  });
}

async function executeDeviceSwipePoint(call: JunLuoToolCall): Promise<JunLuoToolResult<DeviceActionData>> {
  const startX = ensureFiniteNumber(call, 'startX');
  if (!startX.ok) return startX.result;
  const startY = ensureFiniteNumber(call, 'startY');
  if (!startY.ok) return startY.result;
  const endX = ensureFiniteNumber(call, 'endX');
  if (!endX.ok) return endX.result;
  const endY = ensureFiniteNumber(call, 'endY');
  if (!endY.ok) return endY.result;
  const durationMs = Math.max(80, Math.min(2000, Math.round(readNumberInput(call.input, 'durationMs') ?? 420)));
  const result = await swipePhoneAccessibilityPoint(startX.value, startY.value, endX.value, endY.value, durationMs);
  if (!result.ok) return actionFailed(call, result, '没有完成坐标滑动');
  return createToolSuccessResult(call, '已完成坐标滑动', {
    ...result,
    durationMs,
    endX: Math.round(endX.value),
    endY: Math.round(endY.value),
    startX: Math.round(startX.value),
    startY: Math.round(startY.value),
  });
}

async function executeDeviceBack(call: JunLuoToolCall): Promise<JunLuoToolResult<DeviceActionData>> {
  const result = await performPhoneAccessibilityBack();
  if (!result.ok) return actionFailed(call, result, `没有执行返回：${result.reason}`);
  return createToolSuccessResult(call, '已执行手机返回', result);
}

async function executeDeviceLaunchApp(call: JunLuoToolCall, context?: import('../toolTypes').JunLuoToolExecutorContext): Promise<JunLuoToolResult> {
  if (call.requestedBy === 'chat') return context?.appLaunchChat ? context.appLaunchChat(call)
    : createToolErrorResult(call, createToolError('PERMISSION_DENIED', 'PERMISSION_DENIED'), APP_LAUNCH_UNAVAILABLE);
  const packageName = readStringInput(call.input, 'packageName');
  if (!packageName) return validationFailed(call, '缺少应用包名', '没有打开应用');
  const result = await launchPhoneApp(packageName);
  if (!result.ok) return actionFailed(call, result, `没有打开应用：${packageName}`);
  return createToolSuccessResult(call, `已打开应用：${packageName}`, { ...result, packageName });
}

export const deviceSnapshotTool: JunLuoToolDefinition<Record<string, unknown>, DeviceSnapshotData> = {
  id: 'device.get_accessibility_snapshot',
  chatExposure: 'candidate',
  proactiveEligible: true,
  packageId: 'device',
  name: '读取手机窗口',
  description: '读取当前 Android 无障碍窗口摘要，返回包名、窗口类名和可见节点摘要。',
  inputSchema: {
    type: 'object',
    properties: {
      maxNodes: { type: 'number', description: '最多读取节点数，默认 80，最大 200' },
    },
  },
  permission: 'ask',
  riskLevel: 'device_control',
  readOnly: true,
  executor: executeDeviceSnapshot,
};

export const deviceClickTextTool: JunLuoToolDefinition<Record<string, unknown>, DeviceActionData> = {
  id: 'device.click_text',
  chatExposure: 'explicit_only',
  proactiveEligible: false,
  packageId: 'device',
  name: '点击屏幕文字',
  description: '通过 Android 无障碍点击当前窗口中匹配的可见文字。',
  inputSchema: {
    type: 'object',
    required: ['text'],
    properties: {
      text: { type: 'string', description: '要点击的可见文字' },
    },
  },
  permission: 'ask',
  riskLevel: 'device_control',
  readOnly: false,
  executor: executeDeviceClickText,
};

export const deviceTapPointTool: JunLuoToolDefinition<Record<string, unknown>, DeviceActionData> = {
  id: 'device.tap_point',
  chatExposure: 'explicit_only',
  proactiveEligible: false,
  packageId: 'device',
  name: '点击屏幕坐标',
  description: '通过 Android 无障碍点击屏幕坐标。',
  inputSchema: {
    type: 'object',
    required: ['x', 'y'],
    properties: {
      x: { type: 'number', description: '屏幕横坐标' },
      y: { type: 'number', description: '屏幕纵坐标' },
    },
  },
  permission: 'ask',
  riskLevel: 'device_control',
  readOnly: false,
  executor: executeDeviceTapPoint,
};

export const deviceSwipePointTool: JunLuoToolDefinition<Record<string, unknown>, DeviceActionData> = {
  id: 'device.swipe_point',
  chatExposure: 'explicit_only',
  proactiveEligible: false,
  packageId: 'device',
  name: '滑动屏幕坐标',
  description: '通过 Android 无障碍从一个屏幕坐标滑动到另一个坐标。',
  inputSchema: {
    type: 'object',
    required: ['startX', 'startY', 'endX', 'endY'],
    properties: {
      durationMs: { type: 'number', description: '滑动持续时间，默认 420ms' },
      endX: { type: 'number', description: '结束横坐标' },
      endY: { type: 'number', description: '结束纵坐标' },
      startX: { type: 'number', description: '起始横坐标' },
      startY: { type: 'number', description: '起始纵坐标' },
    },
  },
  permission: 'ask',
  riskLevel: 'device_control',
  readOnly: false,
  executor: executeDeviceSwipePoint,
};

export const deviceBackTool: JunLuoToolDefinition<Record<string, unknown>, DeviceActionData> = {
  id: 'device.back',
  chatExposure: 'explicit_only',
  proactiveEligible: false,
  packageId: 'device',
  name: '手机返回',
  description: '通过 Android 无障碍执行返回动作。',
  inputSchema: { type: 'object' },
  permission: 'ask',
  riskLevel: 'device_control',
  readOnly: false,
  executor: executeDeviceBack,
};

export const deviceLaunchAppTool: JunLuoToolDefinition = {
  id: 'device.launch_app',
  chatExposure: 'explicit_only',
  proactiveEligible: false,
  packageId: 'device',
  name: '打开手机应用',
  description: APP_LAUNCH_DESCRIPTION,
  inputSchema: {
    type: 'object',
    required: ['appName'],
    additionalProperties: false,
    properties: {
      appName: { type: 'string', description: APP_LAUNCH_APP_NAME_DESCRIPTION },
    },
  },
  permission: 'ask',
  riskLevel: 'device_control',
  readOnly: false,
  executor: executeDeviceLaunchApp,
  agentEpochMode: 'bounded_local_commits',
  executionScope: 'local_device',
};

export const deviceToolPackage: JunLuoToolPackage = {
  id: 'device',
  name: '手机设备操作',
  description: '读取手机窗口并执行受控的 Android 无障碍点击、滑动、返回和打开应用动作。',
  category: 'device_control',
  tools: [
    deviceSnapshotTool,
    deviceClickTextTool,
    deviceTapPointTool,
    deviceSwipePointTool,
    deviceBackTool,
    deviceLaunchAppTool,
    ...deviceSystemBleTools,
  ],
  defaultEnabled: true,
  riskLevel: 'device_control',
  source: 'builtin',
};
