import { createToolError } from '../toolErrors';
import { createToolErrorResult, createToolSuccessResult } from '../toolResult';
import type { JunLuoToolCall, JunLuoToolDefinition, JunLuoToolPackage, JunLuoToolResult } from '../toolTypes';
import { readNumberInput, readStringInput, validationFailed } from './builtinToolValidation';

type DeveloperLabRuntimeStatus = {
  available: boolean;
  reason: string;
};

type DeveloperLabStatusData = {
  javascriptSandbox: DeveloperLabRuntimeStatus;
  pythonSandbox: DeveloperLabRuntimeStatus;
  terminal: DeveloperLabRuntimeStatus;
  shizukuShell: DeveloperLabRuntimeStatus;
  androidShell: DeveloperLabRuntimeStatus;
  packageInstall: DeveloperLabRuntimeStatus;
};

type DeveloperLabRunData = {
  language: 'javascript' | 'python';
  runtimeStatus: 'unsupported';
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
};

const UNSUPPORTED_RUNTIME = 'UNSUPPORTED_RUNTIME';
const MAX_CODE_CHARS = 20_000;
const DEFAULT_TIMEOUT_MS = 3_000;
const MAX_TIMEOUT_MS = 10_000;

function unavailable(reason: string): DeveloperLabRuntimeStatus {
  return { available: false, reason };
}

function getDeveloperLabStatus(): DeveloperLabStatusData {
  return {
    javascriptSandbox: unavailable('尚未接入安全 JS sandbox runtime'),
    pythonSandbox: unavailable('尚未接入 Python runtime'),
    terminal: unavailable('终端会话尚未接入君落工具系统'),
    shizukuShell: unavailable('Shizuku shell 尚未接入君落工具系统'),
    androidShell: unavailable('Android shell 尚未接入君落工具系统'),
    packageInstall: unavailable('包安装能力尚未接入君落工具系统'),
  };
}

function executeGetStatus(call: JunLuoToolCall): JunLuoToolResult<DeveloperLabStatusData> {
  return createToolSuccessResult(
    call,
    '危险实验区状态已读取：当前没有可用代码执行或终端运行时',
    getDeveloperLabStatus(),
  );
}

function readRunInput(call: JunLuoToolCall) {
  const code = readStringInput(call.input, 'code');
  if (!code) {
    return { error: validationFailed<DeveloperLabRunData>(call, 'code 不能为空', '没有运行代码：缺少代码内容'), code: '' };
  }
  if (code.length > MAX_CODE_CHARS) {
    return {
      error: validationFailed<DeveloperLabRunData>(call, `code 不能超过 ${MAX_CODE_CHARS} 字符`, '没有运行代码：代码内容太长'),
      code: '',
    };
  }
  const requestedTimeout = readNumberInput(call.input, 'timeoutMs');
  const timeoutMs = typeof requestedTimeout === 'number' && Number.isFinite(requestedTimeout)
    ? Math.max(1, Math.min(MAX_TIMEOUT_MS, Math.round(requestedTimeout)))
    : DEFAULT_TIMEOUT_MS;
  return { code, error: null, timeoutMs };
}

function unsupportedRuntime(
  call: JunLuoToolCall,
  language: DeveloperLabRunData['language'],
  summary: string,
): JunLuoToolResult<DeveloperLabRunData> {
  return createToolErrorResult(
    call,
    createToolError('EXECUTION_FAILED', summary, {
      code: UNSUPPORTED_RUNTIME,
      exitCode: null,
      language,
      runtimeStatus: 'unsupported',
      stderr: '',
      stdout: '',
      timedOut: false,
    }),
    summary,
  );
}

function executeRunJs(call: JunLuoToolCall): JunLuoToolResult<DeveloperLabRunData> {
  const input = readRunInput(call);
  if (input.error) return input.error;
  return unsupportedRuntime(call, 'javascript', '没有运行 JavaScript：安全 JS sandbox runtime 尚未接入');
}

function executeRunPython(call: JunLuoToolCall): JunLuoToolResult<DeveloperLabRunData> {
  const input = readRunInput(call);
  if (input.error) return input.error;
  return unsupportedRuntime(call, 'python', '没有运行 Python：Python runtime 尚未接入');
}

function labTool(definition: Omit<JunLuoToolDefinition, 'packageId'>): JunLuoToolDefinition {
  return { ...definition, packageId: 'developer_lab' };
}

export const developerLabToolPackage: JunLuoToolPackage = {
  id: 'developer_lab',
  name: '代码执行危险实验区',
  description: '预留受限代码执行和终端能力边界；当前不执行代码、不接终端、不接 Shizuku shell。',
  category: 'development',
  defaultEnabled: false,
  riskLevel: 'dangerous',
  source: 'builtin',
  tools: [
    labTool({
      id: 'developer_lab.get_status',
      chatExposure: 'disabled',
      proactiveEligible: false,
      name: '查看危险实验区状态',
      description: '查看 JS/Python sandbox、终端、Shizuku shell、Android shell 和包安装能力是否可用。',
      inputSchema: { type: 'object', properties: {} },
      permission: 'allow',
      riskLevel: 'read',
      readOnly: true,
      executor: executeGetStatus,
    }),
    labTool({
      id: 'developer_lab.run_js_sandboxed',
      chatExposure: 'disabled',
      proactiveEligible: false,
      name: '运行受限 JavaScript',
      description: '预留受限 JS 执行入口；当前没有安全 sandbox runtime，会明确返回不可用。',
      inputSchema: {
        type: 'object',
        properties: {
          code: { type: 'string', description: '要运行的 JavaScript 代码' },
          timeoutMs: { type: 'number', description: '超时时间，当前仅用于未来 runtime 边界' },
        },
        required: ['code'],
      },
      permission: 'deny',
      riskLevel: 'dangerous',
      readOnly: false,
      executor: executeRunJs,
    }),
    labTool({
      id: 'developer_lab.run_python_sandboxed',
      chatExposure: 'disabled',
      proactiveEligible: false,
      name: '运行受限 Python',
      description: '预留受限 Python 执行入口；当前没有 Python runtime，会明确返回不可用。',
      inputSchema: {
        type: 'object',
        properties: {
          code: { type: 'string', description: '要运行的 Python 代码' },
          timeoutMs: { type: 'number', description: '超时时间，当前仅用于未来 runtime 边界' },
        },
        required: ['code'],
      },
      permission: 'deny',
      riskLevel: 'dangerous',
      readOnly: false,
      executor: executeRunPython,
    }),
  ],
};
