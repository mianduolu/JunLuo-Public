import * as Battery from 'expo-battery';
import { AppState, Dimensions, Platform } from 'react-native';

import {
  beginRuntimeWorkload,
  observeRuntimeWorkload,
  type RuntimeWorkloadStage,
} from '../../runtime/runtimeWorkloadDiagnostics';
import { createToolError } from '../toolErrors';
import { createToolErrorResult, createToolSuccessResult } from '../toolResult';
import type {
  JunLuoToolCall,
  JunLuoToolDefinition,
  JunLuoToolExecutorContext,
  JunLuoToolPackage,
  JunLuoToolResult,
} from '../toolTypes';
import { isOneOf, readNumberInput, readOptionalStringInput, validationFailed } from './builtinToolValidation';

type TimeDateParts = {
  day: number;
  hour: number;
  minute: number;
  month: number;
  second: number;
  weekday: string;
  year: number;
};

type SystemStatusTimeData = {
  dateParts: TimeDateParts;
  displayText: string;
  iso: string;
  timeZone: string;
  timezoneOffsetMinutes: number;
  timestamp: number;
};

type SystemStatusFormatTimeData = {
  displayText: string;
  iso: string;
  style: 'short' | 'medium' | 'full';
  timeZone: string;
  timestamp: number;
};

type SystemStatusBatteryData = {
  checkedAt: number;
  isLowPowerModeEnabled?: boolean;
  level: number | null;
  percentage: number | null;
  state: 'unknown' | 'unplugged' | 'charging' | 'full';
};

type SystemStatusDeviceInfoData = {
  fontScale?: number;
  isPad?: boolean;
  os: string;
  osVersion?: string | number;
  scale: number;
  screenHeight: number;
  screenWidth: number;
};

type SystemStatusDeviceStatusData = {
  appState: string;
  battery: SystemStatusBatteryData;
  checkedAt: number;
  deviceInfo: SystemStatusDeviceInfoData;
  time: SystemStatusTimeData;
};

const FORMAT_STYLES = ['short', 'medium', 'full'] as const;

function readLocale(input: Record<string, unknown>) {
  return readOptionalStringInput(input, 'locale') || 'zh-CN';
}

function readTimeZone(input: Record<string, unknown>) {
  return readOptionalStringInput(input, 'timeZone') || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function isValidTimeZone(timeZone: string) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function getPartsMap(date: Date, timeZone: string, locale = 'zh-CN') {
  const parts = new Intl.DateTimeFormat(locale, {
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
    minute: '2-digit',
    month: '2-digit',
    second: '2-digit',
    timeZone,
    weekday: 'long',
    year: 'numeric',
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function buildDateParts(date: Date, timeZone: string, locale: string): TimeDateParts {
  const parts = getPartsMap(date, timeZone, locale);
  return {
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    month: Number(parts.month),
    second: Number(parts.second),
    weekday: parts.weekday || '',
    year: Number(parts.year),
  };
}

function getTimeZoneOffsetMinutes(date: Date, timeZone: string) {
  const parts = getPartsMap(date, timeZone, 'en-US');
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return Math.round((asUtc - date.getTime()) / 60000);
}

function formatDisplayTime(date: Date, timeZone: string, locale: string, style: SystemStatusFormatTimeData['style']) {
  if (style === 'short') {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: 'short',
      timeStyle: 'short',
      timeZone,
    }).format(date);
  }
  if (style === 'medium') {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'medium',
      timeZone,
    }).format(date);
  }
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'full',
    timeStyle: 'medium',
    timeZone,
  }).format(date);
}

function buildTimeData(date: Date, timeZone: string, locale: string, style: SystemStatusFormatTimeData['style'] = 'full'): SystemStatusTimeData {
  return {
    dateParts: buildDateParts(date, timeZone, locale),
    displayText: formatDisplayTime(date, timeZone, locale, style),
    iso: date.toISOString(),
    timeZone,
    timezoneOffsetMinutes: getTimeZoneOffsetMinutes(date, timeZone),
    timestamp: date.getTime(),
  };
}

function normalizeBatteryState(value: Battery.BatteryState): SystemStatusBatteryData['state'] {
  if (value === Battery.BatteryState.UNPLUGGED) return 'unplugged';
  if (value === Battery.BatteryState.CHARGING) return 'charging';
  if (value === Battery.BatteryState.FULL) return 'full';
  return 'unknown';
}

function measureSystemStatus<T>(
  stage: RuntimeWorkloadStage,
  diagnosticParentToken: number | undefined,
  operation: () => T,
) {
  if (!diagnosticParentToken) return operation();
  const span = beginRuntimeWorkload(stage, { parentToken: diagnosticParentToken });
  try {
    const value = operation();
    span?.finish('ok');
    return value;
  } catch (error) {
    span?.finish('failed');
    throw error;
  }
}

async function readBatteryData(diagnosticParentToken?: number): Promise<SystemStatusBatteryData> {
  const read = async () => {
    const [levelValue, stateValue, lowPowerModeValue] = await Promise.all([
      Battery.getBatteryLevelAsync(),
      Battery.getBatteryStateAsync(),
      typeof Battery.isLowPowerModeEnabledAsync === 'function'
        ? Battery.isLowPowerModeEnabledAsync().catch(() => undefined)
        : Promise.resolve(undefined),
    ]);
    const level = typeof levelValue === 'number' && Number.isFinite(levelValue)
      ? Math.max(0, Math.min(1, levelValue))
      : null;
    return {
      checkedAt: Date.now(),
      isLowPowerModeEnabled: typeof lowPowerModeValue === 'boolean' ? lowPowerModeValue : undefined,
      level,
      percentage: typeof level === 'number' ? Math.round(level * 100) : null,
      state: normalizeBatteryState(stateValue),
    };
  };
  if (!diagnosticParentToken) return read();
  return observeRuntimeWorkload(
    'system_status.battery_native',
    read,
    undefined,
    { parentToken: diagnosticParentToken },
  );
}

function readDeviceInfo(): SystemStatusDeviceInfoData {
  const window = Dimensions.get('window');
  const platformWithPad = Platform as typeof Platform & { isPad?: boolean };
  return {
    fontScale: typeof window.fontScale === 'number' ? window.fontScale : undefined,
    isPad: typeof platformWithPad.isPad === 'boolean' ? platformWithPad.isPad : undefined,
    os: Platform.OS,
    osVersion: Platform.Version,
    scale: window.scale,
    screenHeight: window.height,
    screenWidth: window.width,
  };
}

async function executeGetTime(call: JunLuoToolCall): Promise<JunLuoToolResult<SystemStatusTimeData>> {
  const locale = readLocale(call.input);
  const timeZone = readTimeZone(call.input);
  if (!isValidTimeZone(timeZone)) {
    return validationFailed(call, `非法时区：${timeZone}`, '没有读取当前时间：时区无效');
  }
  const data = buildTimeData(new Date(), timeZone, locale, 'full');
  return createToolSuccessResult(call, `当前时间：${data.displayText}`, data);
}

async function executeFormatTime(call: JunLuoToolCall): Promise<JunLuoToolResult<SystemStatusFormatTimeData>> {
  const locale = readLocale(call.input);
  const timeZone = readTimeZone(call.input);
  if (!isValidTimeZone(timeZone)) {
    return validationFailed(call, `非法时区：${timeZone}`, '没有格式化时间：时区无效');
  }
  const styleValue = readOptionalStringInput(call.input, 'style');
  const style = isOneOf(styleValue, FORMAT_STYLES) ? styleValue : 'medium';
  const hasTimestampInput = Object.prototype.hasOwnProperty.call(call.input, 'timestamp');
  const hasIsoInput = Object.prototype.hasOwnProperty.call(call.input, 'iso');
  const timestamp = readNumberInput(call.input, 'timestamp');
  const iso = readOptionalStringInput(call.input, 'iso');
  if (hasTimestampInput && typeof timestamp !== 'number') {
    return validationFailed(call, '非法时间戳', '没有格式化时间：输入时间无效');
  }
  if (hasIsoInput && !iso) {
    return validationFailed(call, '非法 ISO 时间', '没有格式化时间：输入时间无效');
  }
  const date = typeof timestamp === 'number'
    ? new Date(timestamp)
    : iso
      ? new Date(iso)
      : new Date();
  if (!Number.isFinite(date.getTime())) {
    return validationFailed(call, '非法时间戳或 ISO 时间', '没有格式化时间：输入时间无效');
  }
  const displayText = formatDisplayTime(date, timeZone, locale, style);
  return createToolSuccessResult(call, `格式化时间：${displayText}`, {
    displayText,
    iso: date.toISOString(),
    style,
    timeZone,
    timestamp: date.getTime(),
  });
}

async function executeGetBattery(
  call: JunLuoToolCall,
  context?: JunLuoToolExecutorContext,
): Promise<JunLuoToolResult<SystemStatusBatteryData>> {
  try {
    const data = await readBatteryData(context?.diagnosticParentToken);
    const levelText = typeof data.percentage === 'number' ? `${data.percentage}%` : '未知';
    const stateText = data.state === 'charging' ? '充电中' : data.state === 'full' ? '已充满' : data.state === 'unplugged' ? '未充电' : '状态未知';
    return createToolSuccessResult(call, `当前电量：${levelText}，${stateText}`, data);
  } catch (error) {
    return createToolErrorResult(
      call,
      createToolError('EXECUTION_FAILED', error instanceof Error ? error.message : '读取电量失败'),
      '没有读取到电量状态',
    );
  }
}

async function executeGetDeviceInfo(call: JunLuoToolCall): Promise<JunLuoToolResult<SystemStatusDeviceInfoData>> {
  const data = readDeviceInfo();
  return createToolSuccessResult(call, `设备信息：${data.os}${data.osVersion ? ` ${data.osVersion}` : ''}，屏幕 ${Math.round(data.screenWidth)}x${Math.round(data.screenHeight)}`, data);
}

async function executeGetDeviceStatus(
  call: JunLuoToolCall,
  context?: JunLuoToolExecutorContext,
): Promise<JunLuoToolResult<SystemStatusDeviceStatusData>> {
  const locale = readLocale(call.input);
  const timeZone = readTimeZone(call.input);
  if (!isValidTimeZone(timeZone)) {
    return validationFailed(call, `非法时区：${timeZone}`, '没有读取到设备状态：时区无效');
  }
  try {
    const diagnosticParentToken = context?.diagnosticParentToken;
    const [battery] = await Promise.all([readBatteryData(diagnosticParentToken)]);
    const time = measureSystemStatus(
      'system_status.time_build',
      diagnosticParentToken,
      () => buildTimeData(new Date(), timeZone, locale, 'full'),
    );
    const deviceInfo = measureSystemStatus(
      'system_status.device_info',
      diagnosticParentToken,
      readDeviceInfo,
    );
    return measureSystemStatus(
      'system_status.result_build',
      diagnosticParentToken,
      () => {
        const data: SystemStatusDeviceStatusData = {
          appState: AppState.currentState,
          battery,
          checkedAt: Date.now(),
          deviceInfo,
          time,
        };
        const batteryText = typeof battery.percentage === 'number' ? `${battery.percentage}%` : '电量未知';
        return createToolSuccessResult(call, `设备状态：${time.displayText}；电量 ${batteryText}；App 状态 ${data.appState}`, data);
      },
    );
  } catch (error) {
    return createToolErrorResult(
      call,
      createToolError('EXECUTION_FAILED', error instanceof Error ? error.message : '读取设备状态失败'),
      '没有读取到设备状态',
    );
  }
}

export const systemStatusGetTimeTool: JunLuoToolDefinition<Record<string, unknown>, SystemStatusTimeData> = {
  id: 'system_status.get_time',
  chatExposure: 'candidate',
  proactiveEligible: true,
  packageId: 'system_status',
  name: '读取当前时间',
  description: '读取设备当前时间、日期、星期、时区和 ISO 时间。',
  inputSchema: {
    type: 'object',
    properties: {
      locale: { type: 'string', description: '显示语言，默认 zh-CN' },
      timeZone: { type: 'string', description: 'IANA 时区，默认设备当前时区' },
    },
  },
  permission: 'allow',
  riskLevel: 'read',
  readOnly: true,
  executor: executeGetTime,
};

export const systemStatusFormatTimeTool: JunLuoToolDefinition<Record<string, unknown>, SystemStatusFormatTimeData> = {
  id: 'system_status.format_time',
  chatExposure: 'candidate',
  proactiveEligible: true,
  packageId: 'system_status',
  name: '格式化时间',
  description: '把 timestamp 或 ISO 时间格式化成指定时区和语言的可读文本。',
  inputSchema: {
    type: 'object',
    properties: {
      iso: { type: 'string', description: 'ISO 时间字符串' },
      locale: { type: 'string', description: '显示语言，默认 zh-CN' },
      style: { type: 'string', enum: ['short', 'medium', 'full'], description: '显示详细程度，默认 medium' },
      timestamp: { type: 'number', description: '毫秒时间戳' },
      timeZone: { type: 'string', description: 'IANA 时区，默认设备当前时区' },
    },
  },
  permission: 'allow',
  riskLevel: 'read',
  readOnly: true,
  executor: executeFormatTime,
};

export const systemStatusGetBatteryTool: JunLuoToolDefinition<Record<string, unknown>, SystemStatusBatteryData> = {
  id: 'system_status.get_battery',
  chatExposure: 'candidate',
  proactiveEligible: true,
  packageId: 'system_status',
  name: '读取电量状态',
  description: '读取手机电量百分比、充电状态和低电量模式状态。',
  inputSchema: { type: 'object' },
  permission: 'allow',
  riskLevel: 'read',
  readOnly: true,
  executor: executeGetBattery,
};

export const systemStatusGetDeviceStatusTool: JunLuoToolDefinition<Record<string, unknown>, SystemStatusDeviceStatusData> = {
  id: 'system_status.get_device_status',
  chatExposure: 'candidate',
  proactiveEligible: true,
  packageId: 'system_status',
  name: '读取设备状态',
  description: '聚合当前时间、电量、App 前后台状态和基础平台信息。',
  inputSchema: {
    type: 'object',
    properties: {
      locale: { type: 'string', description: '显示语言，默认 zh-CN' },
      timeZone: { type: 'string', description: 'IANA 时区，默认设备当前时区' },
    },
  },
  permission: 'allow',
  riskLevel: 'read',
  readOnly: true,
  executor: executeGetDeviceStatus,
};

export const systemStatusGetDeviceInfoTool: JunLuoToolDefinition<Record<string, unknown>, SystemStatusDeviceInfoData> = {
  id: 'system_status.get_device_info',
  chatExposure: 'candidate',
  proactiveEligible: true,
  packageId: 'system_status',
  name: '读取设备信息',
  description: '读取平台、系统版本、屏幕尺寸、像素密度等基础设备信息。',
  inputSchema: { type: 'object' },
  permission: 'allow',
  riskLevel: 'read',
  readOnly: true,
  executor: executeGetDeviceInfo,
};

export const systemStatusToolPackage: JunLuoToolPackage = {
  id: 'system_status',
  name: '时间与设备状态',
  description: '读取当前时间、电量、设备状态和基础系统信息。',
  category: 'system_status',
  tools: [
    systemStatusGetTimeTool,
    systemStatusFormatTimeTool,
    systemStatusGetBatteryTool,
    systemStatusGetDeviceStatusTool,
    systemStatusGetDeviceInfoTool,
  ],
  defaultEnabled: true,
  riskLevel: 'read',
  source: 'builtin',
};
