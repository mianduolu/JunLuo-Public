import { registerBuiltinTools } from './builtin/registerBuiltinTools';
import { GIFT_PACKAGE_DESCRIPTION } from '../gifts/giftToolContract';
import { TEXT_FILE_CATALOG_DESCRIPTION } from './textFileChatTools';
import { APP_LAUNCH_CATALOG_DESCRIPTION } from './chatAppLaunch';
import { DIALER_CATALOG_DESCRIPTION } from './chatDialer';
import { backendOverviewChatDefinition, BACKEND_OVERVIEW_CATALOG_DESCRIPTION, BACKEND_OVERVIEW_TOOL_NAME } from './chatBackendOverview';
import { PHONE_LIMIT_PACKAGE_ID, PHONE_LIMIT_PACKAGE_NAME, PHONE_LIMIT_PACKAGE_DESCRIPTION } from './phoneLimitContract';
import { REMINDER_CATALOG_DESCRIPTION, REMINDER_QUERY_DESCRIPTION, REMINDER_QUERY_SCHEMA } from './chatReminderTools';
import { EXPENSE_CATALOG_DESCRIPTION, EXPENSE_OPEN_DESCRIPTION, EXPENSE_QUERY_SCHEMA } from './expenseChatTools';
import { systemUsePackageTool } from './builtin/systemTools';
import { listToolPackages, listTools } from './toolRegistry';
import type {
  JunLuoToolCandidateEntry,
  JunLuoToolCandidateSource,
  JunLuoToolExecutionAuthority,
} from './toolCandidateSelector';
import type { JunLuoRegisteredToolDefinition } from './toolTypes';

export const TOOL_CAPABILITY_CATALOG_TITLE = '【可选工具包】';
export const TOOL_CAPABILITY_PACKAGE_IDS_DESCRIPTION = 'I 想打开的一至三个工具包 ID。';
export const TOOL_CAPABILITY_MAX_PACKAGES = 3;
export const TOOL_CAPABILITY_MAX_CATALOG_CHARACTERS = 2000;
export const TOOL_CAPABILITY_MAX_TOOLS = 6;
export const TOOL_CAPABILITY_MAX_SCHEMA_CHARACTERS = 8000;

export type JunLuoToolCapabilityDiscoveryTrigger =
  | 'explicit_generic_action'
  | 'weak_package_hint'
  | 'conversation_context'
  | 'pending_action'
  | 'manual_activation'
  | 'unlanded_commitment';

export type JunLuoToolCandidateAvailabilitySnapshot = {
  enabledPackageIds: string[];
  deniedToolIds: string[];
  unavailableToolIds: string[];
};

export type JunLuoToolCapabilityCatalogEntry = {
  id: string;
  name: string;
  purpose: string;
};

export type JunLuoToolCapabilityDiscoveryOffer = {
  alongsideTools?: boolean;
  chatBackendOverview?: boolean;
  trigger: JunLuoToolCapabilityDiscoveryTrigger;
  catalogPackageIds: string[];
  catalogInstruction: string;
  authority?: JunLuoToolExecutionAuthority;
  availability: JunLuoToolCandidateAvailabilitySnapshot;
  preferredToolIds: string[];
  youText: string;
};

export type JunLuoToolCapabilityDiscoveryErrorCode =
  | 'INVALID_PACKAGE_IDS'
  | 'PACKAGE_NOT_AVAILABLE'
  | 'PACKAGE_EMPTY'
  | 'PACKAGE_SCHEMA_BUDGET_EXCEEDED'
  | 'PACKAGE_DISCOVERY_LIMIT';

export type JunLuoToolCapabilityDiscoveryStatus =
  | 'tools_ready'
  | 'confirmation_needed'
  | 'package_discovery_rejected';

export type JunLuoToolCapabilityDiscoverySnapshot = {
  callId: string;
  status: JunLuoToolCapabilityDiscoveryStatus;
  packageIds: string[];
  toolIds: string[];
  errorCode?: JunLuoToolCapabilityDiscoveryErrorCode;
};

export type JunLuoToolCapabilityDiscoveryResult = {
  candidates: JunLuoToolCandidateEntry[];
  content: string;
  snapshot: JunLuoToolCapabilityDiscoverySnapshot;
};

export const TOOL_CAPABILITY_CATALOG: readonly JunLuoToolCapabilityCatalogEntry[] = [
  { id: 'todo', name: '待办', purpose: '记录要完成的事情。' },
  { id: 'schedule', name: '日程', purpose: '查看和调整 you 和 I 的日程，以及 you 的作息。' },
  { id: 'expense', name: '记账', purpose: EXPENSE_CATALOG_DESCRIPTION },
  { id: 'memory', name: '记忆', purpose: '查找、读取、保存或修正本地记忆。' },
  { id: 'system_status', name: '时间与设备状态', purpose: '查看时间、电量和基础设备状态。' },
  { id: 'body_signal', name: '身体信号', purpose: '读取已保存并授权的身体信号。' },
  { id: 'weather', name: '天气', purpose: '查询当前天气和预报。' },
  { id: 'map', name: '地图', purpose: '搜索地点、地址和附近地点。' },
  { id: 'nearby', name: '附近世界', purpose: '读取附近世界摘要和定位一致性。' },
  { id: 'location', name: '定位与位置', purpose: '读取已授权的当前位置和位置质量。' },
  { id: 'phone_context', name: '手机生活上下文', purpose: '读取已授权的当前 App、近期活动和通知摘要。' },
  { id: PHONE_LIMIT_PACKAGE_ID, name: PHONE_LIMIT_PACKAGE_NAME, purpose: PHONE_LIMIT_PACKAGE_DESCRIPTION },
  { id: 'files', name: '本地文件', purpose: TEXT_FILE_CATALOG_DESCRIPTION },
  { id: 'communication', name: '通信、分享与社交草稿', purpose: '准备短信、拨号和分享内容，并打开系统确认界面。' },
  { id: 'workflow', name: '工作流', purpose: '查看、保存、启停或运行工作流。' },
  { id: 'github', name: 'GitHub 与开发协作', purpose: '查询仓库、issue、PR 和文件，或准备写操作。' },
  { id: 'media', name: '媒体采集', purpose: '选择图片、拍照或截图。' },
  { id: 'image', name: '图片工具', purpose: '读取本地图片信息。' },
  { id: 'reminder', name: '提醒与闹钟', purpose: REMINDER_CATALOG_DESCRIPTION },
  { id: 'alarm', name: '君落闹钟', purpose: '创建、查看或管理闹钟。' },
  { id: 'browser', name: '网页浏览', purpose: '打开和读取公开网页，并查看最近网页记录。' },
  { id: 'http', name: 'HTTP/API 连接', purpose: '按明确地址或已配置服务发起受控网络请求。' },
  { id: 'research', name: '公开资料研究', purpose: '搜索公开网页、图片和学术资料。' },
  { id: 'device', name: '手机设备操作', purpose: '读取手机窗口、应用和蓝牙状态，或按明确请求使用受控设备能力。' },
  { id: 'music', name: '音乐播放', purpose: '搜索歌曲、播放音乐和管理音乐偏好。' },
  { id: 'voice', name: '语音识别', purpose: '记录语音识别和转写结果。' },
  { id: 'life', name: '查看自己的作息', purpose: 'I 在这里查看自己的睡觉和起床安排。' },
  { id: 'wish', name: '许愿池', purpose: '这里收着 I 和 you 的愿望。I 想写下、捞起或商量一颗愿望时，就来这里。' },
  { id: 'gift', name: '礼物柜', purpose: GIFT_PACKAGE_DESCRIPTION },
] as const;

const CATALOG_BY_ID = new Map(TOOL_CAPABILITY_CATALOG.map((entry) => [entry.id, entry]));

function catalogLine(entry: JunLuoToolCapabilityCatalogEntry) {
  return `${entry.id}｜${entry.name}｜${entry.purpose}`;
}

function serializedToolCharacters(tool: JunLuoRegisteredToolDefinition) {
  return JSON.stringify({
    description: tool.description,
    id: tool.id,
    inputSchema: tool.inputSchema,
    name: tool.name,
  }).length;
}

function isToolAvailable(
  tool: JunLuoRegisteredToolDefinition,
  availability: JunLuoToolCandidateAvailabilitySnapshot,
) {
  return availability.enabledPackageIds.includes(tool.packageId)
    && !availability.deniedToolIds.includes(tool.id)
    && !availability.unavailableToolIds.includes(tool.id)
    && tool.chatExposure !== 'internal_only'
    && tool.chatExposure !== 'disabled'
    && typeof tool.executor === 'function';
}

export function createDefaultToolCandidateAvailabilitySnapshot(): JunLuoToolCandidateAvailabilitySnapshot {
  registerBuiltinTools();
  const builtinPackages = listToolPackages().filter((toolPackage) => (
    toolPackage.source === 'builtin' && toolPackage.defaultEnabled
  ));
  return {
    enabledPackageIds: builtinPackages.map((toolPackage) => toolPackage.id),
    deniedToolIds: [],
    unavailableToolIds: builtinPackages.flatMap((toolPackage) => (
      listTools(toolPackage.id)
        .filter((tool) => typeof tool.executor !== 'function')
        .map((tool) => tool.id)
    )),
  };
}

export function validateToolCapabilityCatalog() {
  registerBuiltinTools();
  const packagesById = new Map(listToolPackages().map((toolPackage) => [toolPackage.id, toolPackage]));
  if (TOOL_CAPABILITY_CATALOG.length !== 29) {
    throw new Error(`工具包目录数量必须为 29，当前为 ${TOOL_CAPABILITY_CATALOG.length}`);
  }
  const ids = new Set<string>();
  TOOL_CAPABILITY_CATALOG.forEach((entry) => {
    if (ids.has(entry.id)) throw new Error(`工具包目录 ID 重复：${entry.id}`);
    ids.add(entry.id);
    const toolPackage = packagesById.get(entry.id);
    if (!toolPackage || toolPackage.source !== 'builtin' || toolPackage.name !== entry.name) {
      throw new Error(`工具包目录与注册表不一致：${entry.id}`);
    }
  });
  const fullCatalog = buildToolCapabilityCatalogInstruction(TOOL_CAPABILITY_CATALOG.map((entry) => entry.id));
  if (fullCatalog.length > TOOL_CAPABILITY_MAX_CATALOG_CHARACTERS) {
    throw new Error(`工具包目录超过 ${TOOL_CAPABILITY_MAX_CATALOG_CHARACTERS} 字符`);
  }
  return true;
}

export function buildToolCapabilityCatalogInstruction(packageIds: readonly string[], options?: { chatAppLaunch?: boolean; chatDialer?: boolean; chatBackendOverview?: boolean }) {
  const lines = packageIds.map((packageId) => {
    const entry = CATALOG_BY_ID.get(packageId);
    if (!entry) throw new Error(`工具包没有审核目录项：${packageId}`);
    return catalogLine(options?.chatAppLaunch && packageId === 'device'
      ? { id: 'device', name: '打开手机应用', purpose: APP_LAUNCH_CATALOG_DESCRIPTION }
      : options?.chatDialer && packageId === 'communication'
        ? { id: 'communication', name: '拨号准备', purpose: DIALER_CATALOG_DESCRIPTION }
        : options?.chatBackendOverview && packageId === 'http'
          ? { id: 'http', name: BACKEND_OVERVIEW_TOOL_NAME, purpose: BACKEND_OVERVIEW_CATALOG_DESCRIPTION } : entry);
  });
  return `${TOOL_CAPABILITY_CATALOG_TITLE}\n${lines.join('\n')}`;
}

export function eligibleToolCapabilityPackageIds(
  availability: JunLuoToolCandidateAvailabilitySnapshot,
) {
  registerBuiltinTools();
  const packagesById = new Map(listToolPackages().map((toolPackage) => [toolPackage.id, toolPackage]));
  return TOOL_CAPABILITY_CATALOG
    .filter((entry) => {
      const toolPackage = packagesById.get(entry.id);
      return !!toolPackage
        && toolPackage.source === 'builtin'
        && availability.enabledPackageIds.includes(entry.id)
        && listTools(entry.id).some((tool) => isToolAvailable(tool as JunLuoRegisteredToolDefinition, availability));
    })
    .map((entry) => entry.id);
}

export function createNativeToolPackageDiscoveryTool(
  offer: JunLuoToolCapabilityDiscoveryOffer,
): JunLuoRegisteredToolDefinition {
  return {
    id: systemUsePackageTool.id,
    packageId: systemUsePackageTool.packageId,
    name: systemUsePackageTool.name,
    description: systemUsePackageTool.description,
    inputSchema: {
      type: 'object',
      required: ['packageIds'],
      properties: {
        packageIds: {
          type: 'array',
          description: TOOL_CAPABILITY_PACKAGE_IDS_DESCRIPTION,
          items: { type: 'string', enum: [...offer.catalogPackageIds] },
        },
        ...(offer.catalogPackageIds.includes('expense') ? {
          expenseQuery: { ...EXPENSE_QUERY_SCHEMA, description: EXPENSE_OPEN_DESCRIPTION },
        } : {}),
        ...(offer.catalogPackageIds.includes('reminder') ? {
          reminderQuery: { ...REMINDER_QUERY_SCHEMA, description: REMINDER_QUERY_DESCRIPTION },
        } : {}),
      },
    },
    permission: 'allow',
    riskLevel: 'read',
    readOnly: true,
    chatExposure: 'internal_only',
    proactiveEligible: false,
  };
}

function triggerSource(trigger: JunLuoToolCapabilityDiscoveryTrigger): JunLuoToolCandidateSource {
  switch (trigger) {
    case 'pending_action':
      return 'pending_confirmation';
    case 'manual_activation':
      return 'manual_activation';
    case 'conversation_context':
      return 'conversation_context';
    case 'explicit_generic_action':
    case 'unlanded_commitment':
      return 'explicit_signal';
    case 'weak_package_hint':
      return 'proactive_read';
  }
}

function normalizedSearchText(value: string) {
  return value.toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

function bigrams(value: string) {
  const normalized = normalizedSearchText(value);
  const result = new Set<string>();
  for (let index = 0; index < normalized.length - 1; index += 1) {
    result.add(normalized.slice(index, index + 2));
  }
  return result;
}

function lexicalScore(youText: string, tool: JunLuoRegisteredToolDefinition) {
  const query = normalizedSearchText(youText);
  if (!query) return 0;
  const parameterNames = Object.keys(tool.inputSchema.properties ?? {}).join(' ');
  const haystack = normalizedSearchText([
    tool.id,
    tool.name,
    tool.description,
    parameterNames,
  ].join(' '));
  let score = haystack.includes(query) ? 20 : 0;
  bigrams(query).forEach((token) => {
    if (haystack.includes(token)) score += 1;
  });
  return score;
}

function rejectedDiscovery(
  callId: string,
  errorCode: JunLuoToolCapabilityDiscoveryErrorCode,
): JunLuoToolCapabilityDiscoveryResult {
  return {
    candidates: [],
    content: JSON.stringify({
      ok: false,
      status: 'package_discovery_rejected',
      errorCode,
    }),
    snapshot: {
      callId,
      status: 'package_discovery_rejected',
      packageIds: [],
      toolIds: [],
      errorCode,
    },
  };
}

function parsePackageIds(input: Record<string, unknown>) {
  if (Object.keys(input).some((key) => !['packageIds', 'expenseQuery', 'reminderQuery'].includes(key))) return undefined;
  const value = input.packageIds;
  if (!Array.isArray(value) || value.length < 1 || value.length > TOOL_CAPABILITY_MAX_PACKAGES) {
    return undefined;
  }
  if (value.some((packageId) => typeof packageId !== 'string' || !packageId.trim())) return undefined;
  const packageIds = value.map((packageId) => (packageId as string).trim());
  if (new Set(packageIds).size !== packageIds.length) return undefined;
  if (input.expenseQuery !== undefined && (!packageIds.includes('expense')
    || !input.expenseQuery || typeof input.expenseQuery !== 'object' || Array.isArray(input.expenseQuery))) return undefined;
  if (input.reminderQuery !== undefined && (!packageIds.includes('reminder')
    || !input.reminderQuery || typeof input.reminderQuery !== 'object' || Array.isArray(input.reminderQuery))) return undefined;
  return packageIds;
}

export function resolveToolCapabilityDiscovery(input: {
  callId: string;
  arguments: Record<string, unknown>;
  offer: JunLuoToolCapabilityDiscoveryOffer;
}): JunLuoToolCapabilityDiscoveryResult {
  registerBuiltinTools();
  const packageIds = parsePackageIds(input.arguments);
  if (!packageIds) return rejectedDiscovery(input.callId, 'INVALID_PACKAGE_IDS');
  const offeredIds = new Set(input.offer.catalogPackageIds);
  if (packageIds.some((packageId) => !offeredIds.has(packageId))) {
    return rejectedDiscovery(input.callId, 'PACKAGE_NOT_AVAILABLE');
  }

  const preferred = new Map(input.offer.preferredToolIds.map((toolId, index) => [toolId, index]));
  const packageOrder = new Map(packageIds.map((packageId, index) => [packageId, index]));
  const eligibleByPackage = new Map<string, JunLuoRegisteredToolDefinition[]>();
  for (const packageId of packageIds) {
    const eligible = listTools(packageId)
      .map((tool) => tool as JunLuoRegisteredToolDefinition)
      .map((tool) => input.offer.chatBackendOverview ? backendOverviewChatDefinition(tool) : tool)
      .filter((tool) => isToolAvailable(tool, input.offer.availability))
      .sort((left, right) => {
        const leftPreferred = preferred.get(left.id) ?? Number.MAX_SAFE_INTEGER;
        const rightPreferred = preferred.get(right.id) ?? Number.MAX_SAFE_INTEGER;
        if (leftPreferred !== rightPreferred) return leftPreferred - rightPreferred;
        const scoreDifference = lexicalScore(input.offer.youText, right)
          - lexicalScore(input.offer.youText, left);
        return scoreDifference || left.id.localeCompare(right.id);
      });
    if (!eligible.length) return rejectedDiscovery(input.callId, 'PACKAGE_EMPTY');
    eligibleByPackage.set(packageId, eligible);
  }

  const selected: JunLuoRegisteredToolDefinition[] = [];
  let serializedCharacterCount = 0;
  for (const packageId of packageIds) {
    const first = eligibleByPackage.get(packageId)![0];
    const nextCharacters = serializedToolCharacters(first);
    if (
      selected.length >= TOOL_CAPABILITY_MAX_TOOLS
      || serializedCharacterCount + nextCharacters > TOOL_CAPABILITY_MAX_SCHEMA_CHARACTERS
    ) {
      return rejectedDiscovery(input.callId, 'PACKAGE_SCHEMA_BUDGET_EXCEEDED');
    }
    selected.push(first);
    serializedCharacterCount += nextCharacters;
  }

  const remaining = packageIds
    .flatMap((packageId) => eligibleByPackage.get(packageId)!.slice(1))
    .sort((left, right) => {
      const leftPreferred = preferred.get(left.id) ?? Number.MAX_SAFE_INTEGER;
      const rightPreferred = preferred.get(right.id) ?? Number.MAX_SAFE_INTEGER;
      if (leftPreferred !== rightPreferred) return leftPreferred - rightPreferred;
      const scoreDifference = lexicalScore(input.offer.youText, right)
        - lexicalScore(input.offer.youText, left);
      if (scoreDifference) return scoreDifference;
      const packageDifference = (packageOrder.get(left.packageId) ?? 0)
        - (packageOrder.get(right.packageId) ?? 0);
      return packageDifference || left.id.localeCompare(right.id);
    });
  for (const tool of remaining) {
    if (selected.length >= TOOL_CAPABILITY_MAX_TOOLS) break;
    const nextCharacters = serializedToolCharacters(tool);
    if (serializedCharacterCount + nextCharacters > TOOL_CAPABILITY_MAX_SCHEMA_CHARACTERS) continue;
    selected.push(tool);
    serializedCharacterCount += nextCharacters;
  }

  const toolIds = selected.map((tool) => tool.id);
  const resolvedAuthority = input.offer.authority
    ? {
        ...input.offer.authority,
        allowedToolIds: input.offer.authority.allowedToolIds.filter((toolId) => (
          toolIds.includes(toolId)
        )),
      }
    : undefined;
  const source = triggerSource(input.offer.trigger);
  const candidates = selected.map((tool): JunLuoToolCandidateEntry => ({
    tool,
    source,
    strength: resolvedAuthority?.allowedToolIds.includes(tool.id) ? 'strong' : 'possible',
    executionMode: resolvedAuthority?.allowedToolIds.includes(tool.id)
      ? 'executable'
      : 'discovery_only',
    authority: resolvedAuthority?.allowedToolIds.includes(tool.id)
      ? resolvedAuthority
      : undefined,
  }));
  const status = candidates.some((candidate) => candidate.executionMode === 'executable')
    ? 'tools_ready'
    : 'confirmation_needed';
  return {
    candidates,
    content: JSON.stringify({ ok: true, status, packageIds, toolIds }),
    snapshot: {
      callId: input.callId,
      status,
      packageIds,
      toolIds,
    },
  };
}

export function rejectToolCapabilityDiscoveryLimit(callId: string) {
  return rejectedDiscovery(callId, 'PACKAGE_DISCOVERY_LIMIT');
}
