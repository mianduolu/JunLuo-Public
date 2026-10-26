import { registerBuiltinTools } from './builtin/registerBuiltinTools';
import { isWishToolId } from '../wishPool/wishToolContract';
import { GIFT_TOOL_IDS, isGiftToolId } from '../gifts/giftToolContract';
import { routeChatToolIntent } from './toolIntentRouter';
import { classifyToolRouteUtterance } from './toolRouteSemanticGuards';
import { getToolDefinition, listTools } from './toolRegistry';
import { chatMemoryCorrectionDefinition } from './memoryCorrection';
import { chatMemoryReadDefinition } from './memoryReadDefinition';
import { RESEARCH_CHAT_TOOL_IDS, researchChatToolDefinition } from './researchChatTools';
import { BROWSER_OPEN_TOOL_ID } from './browserChatTool';
import { isReminderChatTool } from './chatReminderTools';
import { BODY_SIGNAL_HISTORY_TOOL_IDS, isBodySignalHistoryTool } from './bodySignalHistoryToolDefinition';
import {
  analyzeWeatherMapNearbyIntent,
  isWeatherMapNearbyAgentToolId,
  type WeatherMapNearbyIntentEvidence,
} from './weatherMapNearbyAgentEvidence';
import {
  buildToolCapabilityCatalogInstruction,
  createDefaultToolCandidateAvailabilitySnapshot,
  eligibleToolCapabilityPackageIds,
  type JunLuoToolCandidateAvailabilitySnapshot,
  type JunLuoToolCapabilityDiscoveryOffer,
  type JunLuoToolCapabilityDiscoveryTrigger,
} from './toolCapabilityDiscovery';
import type {
  JunLuoRegisteredToolDefinition,
  JunLuoToolResult,
} from './toolTypes';
import {
  chatMusicPlayDefinition,
  type MusicAgentPlaybackContext,
  type MusicAgentPreferenceSnapshot,
} from './musicAgentPolicy';

export type JunLuoToolCandidateSource =
  | 'available_confirmation'
  | 'available_read'
  | 'explicit_signal'
  | 'conversation_context'
  | 'pending_confirmation'
  | 'proactive_read'
  | 'manual_activation';

export type JunLuoToolCandidateReason = {
  toolId: string;
  source: JunLuoToolCandidateSource;
  strength: 'strong' | 'possible';
};

export type JunLuoToolCandidateExecutionMode =
  | 'executable'
  | 'discovery_only';

export type JunLuoToolExecutionAuthorityKind =
  | 'available_confirmation'
  | 'available_read'
  | 'you_explicit'
  | 'you_confirmation'
  | 'pending_proposal'
  | 'manual_activation';

export type JunLuoToolExecutionAuthority = {
  kind: JunLuoToolExecutionAuthorityKind;
  referenceId?: string;
  dataEpoch: number;
  issuedAt?: number;
  expiresAt?: number;
  allowedToolIds: readonly string[];
};

export type JunLuoToolCandidateEntry = {
  tool: JunLuoRegisteredToolDefinition;
  source: JunLuoToolCandidateSource;
  strength: 'strong' | 'possible';
  executionMode: JunLuoToolCandidateExecutionMode;
  authority?: JunLuoToolExecutionAuthority;
};

export type JunLuoToolCandidateSelectionMode =
  | 'chat_only'
  | 'direct_tools'
  | 'package_discovery';

export type JunLuoToolCandidatePendingAction = {
  actionId: string;
  toolId: string;
  sourceMessageId: string;
  status: 'proposed' | 'awaiting_confirmation';
  proposalId?: string;
  dataEpoch: number;
  createdAt: number;
  expiresAt?: number;
};

export type JunLuoToolCandidateRecentResult = {
  callId: string;
  toolId: string;
  ok: boolean;
  status: JunLuoToolResult['status'];
  finishedAt: number;
  followUpToolIds: string[];
};

export type JunLuoToolCandidateContextSnapshot = {
  pendingActions: JunLuoToolCandidatePendingAction[];
  recentResults: JunLuoToolCandidateRecentResult[];
  recentMessages: JunLuoToolCandidateMessage[];
};

export type JunLuoToolCandidateFollowUpResolution = {
  kind: 'confirm' | 'modify' | 'cancel' | 'retry' | 'continue' | 'ambiguous';
  actionIds: string[];
  toolIds: string[];
  proposalId?: string;
};

export type JunLuoToolCandidateSelection = {
  giftPackageEntry?: boolean;
  wishPackageEntry?: boolean;
  readingReferenceTools?: boolean;
  desktopReminderTools?: boolean;
  mode: JunLuoToolCandidateSelectionMode;
  candidates: JunLuoToolCandidateEntry[];
  executableTools: JunLuoRegisteredToolDefinition[];
  discoveryToolIds: string[];
  /** @deprecated Use executableTools. Kept while the unfinished agent foundation migrates. */
  tools: JunLuoRegisteredToolDefinition[];
  packages: string[];
  reasons: JunLuoToolCandidateReason[];
  packageDiscovery?: JunLuoToolCapabilityDiscoveryOffer;
  followUpResolution?: JunLuoToolCandidateFollowUpResolution;
  weatherMapNearbyEvidence?: WeatherMapNearbyIntentEvidence;
  serializedCharacterCount: number;
  truncated: boolean;
};

export type JunLuoToolCandidateMessage = {
  id?: string;
  subject: 'I' | 'you';
  content: string;
};

export type SelectChatToolCandidatesInput = {
  includeGiftPackage?: boolean;
  includeAppLaunch?: boolean;
  includeDialer?: boolean;
  includeCameraObservationBook?: boolean;
  includeWishPackage?: boolean;
  includeReadingReference?: boolean;
  includeResearchReads?: boolean;
  includeBrowserOpen?: boolean;
  dataEpoch: number;
  youText: string;
  includePhoneBattery?: boolean;
  includeWearableHistory?: boolean;
  includePhoneContextReads?: boolean;
  includeMemoryCorrection?: boolean;
  includeMemoryRead?: boolean;
  includeProactiveContact?: boolean;
  includeMusicPlayback?: boolean;
  includeScheduleAgenda?: boolean;
  includeUserRoutine?: boolean;
  includeScheduleComplete?: boolean;
  includeScheduleCreate?: boolean;
  includeTodoComplete?: boolean;
  includeTodoCreate?: boolean;
  recentMessages?: readonly JunLuoToolCandidateMessage[];
  context?: JunLuoToolCandidateContextSnapshot;
  availability?: JunLuoToolCandidateAvailabilitySnapshot;
  pendingToolIds?: readonly string[];
  manualToolIds?: readonly string[];
  unlandedCommitment?: {
    authority?: JunLuoToolExecutionAuthority;
    preferredToolIds?: readonly string[];
  };
  weatherMapNearbyFollowUp?: {
    actionId: string;
    evidence: WeatherMapNearbyIntentEvidence;
  };
  musicPreferences?: MusicAgentPreferenceSnapshot;
  musicPlaybackContext?: MusicAgentPlaybackContext;
  allowProactive?: boolean;
  maxTools?: number;
  maxSerializedCharacters?: number;
  now?: number;
};

const DEFAULT_MAX_TOOLS = 6;
const DEFAULT_MAX_SERIALIZED_CHARACTERS = 8000;

const EXPLICIT_ACTION_PATTERN =
  /^(?:老师[，,、\s]*)?(?:帮我|请|麻烦|替我|给我|能不能|可以帮我|查一下|查询|搜索|搜一下|搜一搜|看看|看一下|读一下|总结|列出|检查|测试|定位|导航|扫一下|记一笔|记下来|记录一下|提醒我|创建|新增|删除|移除|修改|改成|打开|播放|放一首|放首|点一首|点首)/iu;

const EXPLICIT_FIRST_PERSON_PATTERN =
  /^我(?:想|要|需要)(?:让你|请你|你帮我)?(?:查|搜|看|读|记|提醒|创建|删除|修改|打开|播放|放|点)/u;

const EXPLICIT_NEARBY_QUESTION_PATTERN =
  /^(?:我这边|我这里|这附近|附近|周围).{0,18}(?:有什么|有没有|哪里|哪家|推荐|怎么走)/u;

const IMPLICIT_NEARBY_DISCOVERY_PATTERN =
  /(?:这附近|附近|周围|旁边).{0,24}(?:有啥|有什么|有没有|哪里|哪家|能.{0,8}(?:坐|逛|吃|喝|玩).{0,8}(?:地方|店)?)/u;

const SHORT_CONFIRMATION_PATTERN = /^(?:好|好呀|好啊|可以|嗯|行|查吧|放吧|记吧|记一下|就这样|麻烦你了)[！!。.]?$/u;
const CANCEL_FOLLOW_UP_PATTERN = /^(?:算了|不用了|取消)[！!。.]?$/u;
const RETRY_FOLLOW_UP_PATTERN = /^(?:再试一次|重试|再来一次)[！!。.]?$/u;
const CONTINUE_FOLLOW_UP_PATTERN = /^(?:继续|接着来|继续吧)[！!。.]?$/u;
const MODIFY_FOLLOW_UP_PATTERN = /(?:不是.{0,24}(?:是|改成)|改成|改为|换成|调整到)/u;
const GENERIC_ACTION_RESCUE_PATTERN = /^(?:老师[，,、\s]*)?(?:(?:明早|明天早上|今晚|等会儿?)[，,、\s]*)?(?:帮我|请|麻烦|替我|给我|能不能|可以帮我|别让我|替我想办法|帮我弄|帮我处理)/u;
const LOCAL_NARRATIVE_PROTECTION_PATTERN = /^(?:(?:他|她|它|同学|同事).{0,48}(?:旁边|附近|位置|座位|地图|歌曲|音乐)|(?:我)?(?:朋友|同学|同事|别人)说.{0,48}(?:查|搜|放|播放|记|提醒|打开))/u;

function looksExplicit(text: string) {
  const trimmed = text.trim();
  return (
    EXPLICIT_ACTION_PATTERN.test(trimmed)
    || EXPLICIT_FIRST_PERSON_PATTERN.test(trimmed)
    || EXPLICIT_NEARBY_QUESTION_PATTERN.test(trimmed)
  );
}

export function candidateSerializedCharacters(tool: JunLuoRegisteredToolDefinition) {
  return JSON.stringify({
    description: tool.description,
    id: tool.id,
    inputSchema: tool.inputSchema,
    name: tool.name,
  }).length;
}

function canDiscover(
  tool: JunLuoRegisteredToolDefinition,
  source: JunLuoToolCandidateSource,
  strength: JunLuoToolCandidateReason['strength'],
  allowProactive: boolean,
  availability: JunLuoToolCandidateAvailabilitySnapshot,
) {
  if (
    !availability.enabledPackageIds.includes(tool.packageId)
    || availability.deniedToolIds.includes(tool.id)
    || availability.unavailableToolIds.includes(tool.id)
    || typeof tool.executor !== 'function'
  ) return false;
  if (tool.chatExposure === 'disabled' || tool.chatExposure === 'internal_only') return false;
  if (source === 'available_read') return tool.readOnly;
  if (source === 'available_confirmation') return !tool.readOnly;
  if (tool.chatExposure === 'explicit_only') {
    return (
      source === 'pending_confirmation'
      || source === 'manual_activation'
      || strength === 'strong'
    );
  }
  if (strength === 'strong') return true;
  if (['map.search_nearby', 'map.search_destination', 'map.more_results'].includes(tool.id)
    && (source === 'explicit_signal' || source === 'proactive_read' && allowProactive)) return true;
  return allowProactive && tool.proactiveEligible;
}

function authorityForReason(
  reason: JunLuoToolCandidateReason,
  dataEpoch: number,
): JunLuoToolExecutionAuthority | undefined {
  if (reason.strength !== 'strong') return undefined;
  const allowedToolIds = [reason.toolId];
  switch (reason.source) {
    case 'explicit_signal':
      return { kind: 'you_explicit', dataEpoch, allowedToolIds };
    case 'conversation_context':
      return { kind: 'you_confirmation', dataEpoch, allowedToolIds };
    case 'pending_confirmation':
      return { kind: 'pending_proposal', dataEpoch, allowedToolIds };
    case 'manual_activation':
      return { kind: 'manual_activation', dataEpoch, allowedToolIds };
    case 'proactive_read':
    case 'available_confirmation':
    case 'available_read':
      return undefined;
  }
}

function reasonPriority(reason: JunLuoToolCandidateReason) {
  const sourcePriority: Record<JunLuoToolCandidateSource, number> = {
    available_read: -2,
    available_confirmation: -1,
    pending_confirmation: 0,
    manual_activation: 1,
    conversation_context: 2,
    explicit_signal: 3,
    proactive_read: 4,
  };
  return sourcePriority[reason.source] * 2 + (reason.strength === 'strong' ? 0 : 1);
}

export function isExplicitChatToolAction(text: string) {
  return looksExplicit(text);
}

export function selectChatToolCandidates(
  input: SelectChatToolCandidatesInput,
): JunLuoToolCandidateSelection {
  registerBuiltinTools();
  const maxTools = Math.max(1, input.maxTools ?? DEFAULT_MAX_TOOLS);
  const maxSerializedCharacters = Math.max(
    256,
    input.maxSerializedCharacters ?? DEFAULT_MAX_SERIALIZED_CHARACTERS,
  );
  const allowProactive = input.allowProactive ?? true;
  const now = input.now ?? Date.now();
  const availability = input.availability ?? createDefaultToolCandidateAvailabilitySnapshot();
  const context = input.context ?? {
    pendingActions: [],
    recentResults: [],
    recentMessages: [...(input.recentMessages ?? [])],
  };
  const route = routeChatToolIntent(input.youText);
  const legacyWeatherMapNearbyEvidence = input.weatherMapNearbyFollowUp?.evidence
    ?? analyzeWeatherMapNearbyIntent(input.youText);
  const weatherMapNearbyEvidence = !allowProactive && legacyWeatherMapNearbyEvidence?.primaryToolId.startsWith('weather.')
    ? undefined : legacyWeatherMapNearbyEvidence;
  const routeGuard = classifyToolRouteUtterance(input.youText);
  const locallyExplicit = looksExplicit(input.youText);
  const explicitNarrativeDelegation = locallyExplicit
    && (routeGuard.kind === 'self_narrative' || routeGuard.kind === 'future_self_plan');
  const protectedFromExecution = LOCAL_NARRATIVE_PROTECTION_PATTERN.test(input.youText.trim())
    || (routeGuard.shouldProtectFromToolRouting && !explicitNarrativeDelegation);
  const explicit = !protectedFromExecution && locallyExplicit;
  const validPendingActions = context.pendingActions.filter((action) => (
    action.dataEpoch === input.dataEpoch
    && (action.expiresAt === undefined || action.expiresAt > now)
  ));
  const followUpPendingActions = validPendingActions.filter(
    (action) => !action.toolId.startsWith('music.'),
  );
  const recentResults = [...context.recentResults]
    .sort((left, right) => right.finishedAt - left.finishedAt)
    .slice(0, 2);
  const trimmedYouText = input.youText.trim();
  const followUpKind = SHORT_CONFIRMATION_PATTERN.test(trimmedYouText)
    ? 'confirm'
    : CANCEL_FOLLOW_UP_PATTERN.test(trimmedYouText)
      ? 'cancel'
      : RETRY_FOLLOW_UP_PATTERN.test(trimmedYouText)
        ? 'retry'
        : CONTINUE_FOLLOW_UP_PATTERN.test(trimmedYouText)
          ? 'continue'
          : MODIFY_FOLLOW_UP_PATTERN.test(trimmedYouText)
            ? 'modify'
            : undefined;
  let followUpResolution: JunLuoToolCandidateFollowUpResolution | undefined;
  if (followUpKind) {
    if (followUpKind === 'retry' || followUpKind === 'continue') {
      const result = recentResults.length === 1 ? recentResults[0] : undefined;
      const toolIds = result
        ? followUpKind === 'retry'
          ? [result.toolId]
          : result.followUpToolIds
        : [];
      followUpResolution = toolIds.length === 1
        ? { kind: followUpKind, actionIds: [result!.callId], toolIds }
        : { kind: 'ambiguous', actionIds: recentResults.map((item) => item.callId), toolIds: [] };
    } else {
      const action = followUpPendingActions.length === 1 ? followUpPendingActions[0] : undefined;
      followUpResolution = action
        ? {
            kind: followUpKind,
            actionIds: [action.actionId],
            toolIds: [action.toolId],
            ...(action.proposalId ? { proposalId: action.proposalId } : {}),
          }
        : {
            kind: 'ambiguous',
            actionIds: followUpPendingActions.map((item) => item.actionId),
            toolIds: [],
          };
    }
  }
  const reasonByToolId = new Map<string, JunLuoToolCandidateReason>();
  const authorityByToolId = new Map<string, JunLuoToolExecutionAuthority>();

  const addReason = (
    toolId: string,
    source: JunLuoToolCandidateSource,
    strength: JunLuoToolCandidateReason['strength'],
  ) => {
    const next = { toolId, source, strength };
    const current = reasonByToolId.get(toolId);
    if (!current || reasonPriority(next) < reasonPriority(current)) {
      reasonByToolId.set(toolId, next);
    }
  };

  input.pendingToolIds?.forEach((toolId) => addReason(toolId, 'pending_confirmation', 'strong'));
  input.manualToolIds?.forEach((toolId) => addReason(toolId, 'manual_activation', 'strong'));
  if (followUpResolution?.kind === 'confirm' && followUpResolution.toolIds.length === 1) {
    const toolId = followUpResolution.toolIds[0];
    addReason(toolId, 'conversation_context', 'strong');
    authorityByToolId.set(toolId, followUpResolution.proposalId
      ? {
          kind: 'pending_proposal',
          referenceId: followUpResolution.proposalId,
          dataEpoch: input.dataEpoch,
          allowedToolIds: [toolId],
        }
      : {
          kind: 'you_confirmation',
          referenceId: followUpResolution.actionIds[0],
          dataEpoch: input.dataEpoch,
          allowedToolIds: [toolId],
        });
  }
  if (
    (followUpResolution?.kind === 'retry' || followUpResolution?.kind === 'continue')
    && followUpResolution.toolIds.length === 1
  ) {
    const toolId = followUpResolution.toolIds[0];
    addReason(toolId, 'conversation_context', 'strong');
    authorityByToolId.set(toolId, {
      kind: 'you_confirmation',
      referenceId: followUpResolution.actionIds[0],
      dataEpoch: input.dataEpoch,
      allowedToolIds: [toolId],
    });
  }

  route.candidateTools.filter((toolId) => (
    !isWeatherMapNearbyAgentToolId(toolId)
    && !toolId.startsWith('music.')
    && toolId !== 'schedule.create_event'
    && toolId !== 'todo.create'
  )).forEach((toolId) => {
    addReason(
      toolId,
      explicit ? 'explicit_signal' : 'proactive_read',
      explicit ? 'strong' : 'possible',
    );
  });
  if (weatherMapNearbyEvidence) {
    const source = weatherMapNearbyEvidence.strength === 'strong'
      ? 'explicit_signal'
      : 'proactive_read';
    addReason(
      weatherMapNearbyEvidence.primaryToolId,
      source,
      weatherMapNearbyEvidence.strength,
    );
    if (weatherMapNearbyEvidence.strength === 'strong') {
      authorityByToolId.set(weatherMapNearbyEvidence.primaryToolId, {
        kind: input.weatherMapNearbyFollowUp ? 'you_confirmation' : 'you_explicit',
        referenceId: input.weatherMapNearbyFollowUp?.actionId,
        dataEpoch: input.dataEpoch,
        allowedToolIds: [
          weatherMapNearbyEvidence.primaryToolId,
          ...weatherMapNearbyEvidence.fallbackToolIds,
        ],
      });
    }
  }
  if (explicit && /提醒我/u.test(input.youText)) {
    addReason('reminder.create', 'explicit_signal', 'strong');
  }
  if (explicit && /(?:设|设置|创建|加).{0,6}闹钟|闹钟/u.test(input.youText)) {
    addReason('alarm.create', 'explicit_signal', 'strong');
  }
  if (explicit && /(?:记一笔|记账|记到.{0,6}(?:账|小账本))/u.test(input.youText)) {
    addReason('expense.create_entry', 'explicit_signal', 'strong');
  }
  // These tools are offered regardless of the words in the current message.
  const availableReadToolIds = [
    ...(input.includePhoneBattery ? ['system_status.get_battery'] : []),
    ...(input.includeScheduleAgenda ? ['schedule.query_agenda', 'schedule.submit_day_plan'] : []),
    ...(input.includePhoneContextReads ? [
      'phone_context.get_app_usage',
      'phone_context.get_recent_activity',
      'location.get_current_position',
    ] : []),
    ...(input.includeMemoryCorrection ? ['memory.search'] : []),
    ...(input.includeMemoryRead ? ['memory.get'] : []),
  ];
  for (const toolId of availableReadToolIds) {
    reasonByToolId.set(toolId, { toolId, source: 'available_read', strength: 'possible' });
    authorityByToolId.set(toolId, {
      kind: 'available_read',
      dataEpoch: input.dataEpoch,
      allowedToolIds: [toolId],
    });
  }
  const availableConfirmationToolIds = [
    ...(input.includeScheduleCreate ? ['schedule.create_event'] : []),
    ...(input.includeTodoCreate ? ['todo.create'] : []),
    ...(input.includeScheduleComplete ? ['schedule.complete_occurrence'] : []),
    ...(input.includeTodoComplete ? ['todo.complete'] : []),
    ...(input.includeMemoryCorrection ? ['memory.update'] : []),
    ...(input.includeMusicPlayback && input.musicPreferences?.musicEnabled ? ['music.play'] : []),
  ];
  for (const toolId of availableConfirmationToolIds) {
    reasonByToolId.set(toolId, { toolId, source: 'available_confirmation', strength: 'possible' });
    authorityByToolId.set(toolId, {
      kind: 'available_confirmation',
      dataEpoch: input.dataEpoch,
      allowedToolIds: [toolId],
    });
  }

  const sortedReasons = Array.from(reasonByToolId.values()).sort(
    (left, right) => reasonPriority(left) - reasonPriority(right),
  );
  const candidates: JunLuoToolCandidateEntry[] = [];
  const reasons: JunLuoToolCandidateReason[] = [];
  let serializedCharacterCount = 0;
  let truncated = false;

  for (const reason of sortedReasons) {
    if (!allowProactive && reason.toolId.startsWith('weather.')) continue;
    if (input.includeBrowserOpen && reason.toolId === BROWSER_OPEN_TOOL_ID) continue;
    if (input.includeResearchReads && RESEARCH_CHAT_TOOL_IDS.includes(reason.toolId)) continue;
    if (input.includeWishPackage && !allowProactive && isWishToolId(reason.toolId)) continue;
    if (input.includeGiftPackage && !allowProactive && isGiftToolId(reason.toolId)) continue;
    if (reason.toolId === 'reading.read_material'
      || input.includeReadingReference && reason.toolId === 'schedule.save_own') continue;
    if (input.includeUserRoutine && ['schedule.query_routine', 'schedule.save_routine'].includes(reason.toolId)) continue;
    if (isBodySignalHistoryTool(reason.toolId)) continue;
    if (input.includeProactiveContact && reason.toolId.startsWith('proactive_contact.')) continue;
    if (reason.toolId.startsWith('music.') && !(input.includeMusicPlayback && reason.toolId === 'music.play')) continue;
    const registeredTool = getToolDefinition(reason.toolId);
    const tool = registeredTool && input.includeMemoryCorrection && reason.toolId === 'memory.update'
      ? chatMemoryCorrectionDefinition(registeredTool)
      : registeredTool && input.includeMemoryRead && reason.toolId === 'memory.get'
        ? chatMemoryReadDefinition(registeredTool)
        : registeredTool && input.includeMusicPlayback && reason.toolId === 'music.play'
          ? chatMusicPlayDefinition(registeredTool) : registeredTool;
    if (!tool || !canDiscover(tool, reason.source, reason.strength, allowProactive, availability)) continue;
    if (candidates.length >= maxTools) {
      truncated = true;
      continue;
    }
    const authority = authorityByToolId.get(reason.toolId)
      ?? authorityForReason(reason, input.dataEpoch);
    const executionMode = authority ? 'executable' : 'discovery_only';
    const nextCharacters = executionMode === 'executable'
      ? candidateSerializedCharacters(tool)
      : 0;
    if (serializedCharacterCount + nextCharacters > maxSerializedCharacters) {
      truncated = true;
      continue;
    }
    candidates.push({
      tool,
      source: reason.source,
      strength: reason.strength,
      executionMode,
      authority,
    });
    reasons.push(reason);
    serializedCharacterCount += nextCharacters;
  }

  // Three additional slots/serialized budgets, never displacing existing candidates.
  if (input.includeProactiveContact && !allowProactive) {
    for (const id of ['get_status', 'pause', 'resume']) {
      const tool = getToolDefinition(`proactive_contact.${id}`);
      const source = id === 'get_status' ? 'available_read' : 'available_confirmation';
      if (!tool || !canDiscover(tool, source, 'possible', false, availability)) continue;
      if (candidates.some(candidate => candidate.tool.id === tool.id)) continue;
      candidates.push({ tool, source, strength: 'possible', executionMode: 'executable',
        authority: { kind: source, dataEpoch: input.dataEpoch, allowedToolIds: [tool.id] } });
      reasons.push({ toolId: tool.id, source, strength: 'possible' });
      serializedCharacterCount += candidateSerializedCharacters(tool);
    }
  }

  // Two separate slots preserve the existing candidates and their budgets.
  if (input.includeWearableHistory) {
    for (const toolId of BODY_SIGNAL_HISTORY_TOOL_IDS) {
      const tool = getToolDefinition(toolId);
      if (!tool || !canDiscover(tool, 'available_read', 'possible', allowProactive, availability)) continue;
      candidates.push({ tool, source: 'available_read', strength: 'possible', executionMode: 'executable',
        authority: { kind: 'available_read', dataEpoch: input.dataEpoch, allowedToolIds: [toolId] } });
      reasons.push({ toolId, source: 'available_read', strength: 'possible' });
      serializedCharacterCount += candidateSerializedCharacters(tool);
    }
  }

  // Two bounded chat-only slots; do not displace existing tools or inject routine data.
  if (input.includeUserRoutine && !allowProactive) {
    for (const toolId of ['schedule.query_routine', 'schedule.save_routine']) {
      const tool = getToolDefinition(toolId);
      const source = toolId === 'schedule.query_routine' ? 'available_read' : 'available_confirmation';
      if (!tool || !canDiscover(tool, source, 'possible', false, availability)) continue;
      candidates.push({ tool, source, strength: 'possible', executionMode: 'executable',
        authority: { kind: source, dataEpoch: input.dataEpoch, allowedToolIds: [toolId] } });
      reasons.push({ toolId, source, strength: 'possible' });
      serializedCharacterCount += candidateSerializedCharacters(tool);
    }
  }

  // Four host candidates share one chat transport entry, without displacing standing tools.
  if (input.includeWishPackage && !allowProactive) {
    for (const id of ['wish.propose', 'wish.view', 'wish.pull', 'wish.invite_discussion']) {
      const tool = getToolDefinition(id);
      const source = id === 'wish.view' ? 'available_read' : 'available_confirmation';
      if (!tool || !canDiscover(tool, source, 'possible', false, availability)) continue;
      candidates.push({ tool, source, strength: 'possible', executionMode: 'executable',
        authority: { kind: source, dataEpoch: input.dataEpoch, allowedToolIds: [id] } });
      reasons.push({ toolId: id, source, strength: 'possible' });
      serializedCharacterCount += candidateSerializedCharacters(tool);
    }
  }

  // Three standing gift slots leave the existing candidates and budgets intact.
  if (input.includeGiftPackage && !allowProactive) {
    for (const id of GIFT_TOOL_IDS) {
      const tool = getToolDefinition(id);
      const source = id === 'gift.view' ? 'available_read' : 'available_confirmation';
      if (!tool || !canDiscover(tool, source, 'possible', false, availability)) continue;
      if (candidates.some(candidate => candidate.tool.id === id)) continue;
      candidates.push({ tool, source, strength: 'possible', executionMode: 'executable',
        authority: { kind: source, dataEpoch: input.dataEpoch, allowedToolIds: [id] } });
      reasons.push({ toolId: id, source, strength: 'possible' });
      serializedCharacterCount += candidateSerializedCharacters(tool);
    }
  }

  // Only these two scoped definitions get an extra budget; all baseline slots remain intact.
  if (input.includeReadingReference && !allowProactive) {
    const scoped = ['reading.read_material', 'schedule.save_own'].flatMap(id => {
      const tool = getToolDefinition(id);
      const source = id === 'reading.read_material' ? 'available_read' as const : 'available_confirmation' as const;
      return tool && canDiscover(tool, source, 'possible', false, availability) ? [{ tool, source }] : [];
    });
    if (scoped.reduce((sum, entry) => sum + candidateSerializedCharacters(entry.tool), 0) <= 8000) {
      for (const { tool, source } of scoped) {
        if (candidates.some(candidate => candidate.tool.id === tool.id)) continue;
        candidates.push({ tool, source, strength: 'possible', executionMode: 'executable',
          authority: { kind: source, dataEpoch: input.dataEpoch, allowedToolIds: [tool.id] } });
        reasons.push({ toolId: tool.id, source, strength: 'possible' });
        serializedCharacterCount += candidateSerializedCharacters(tool);
      }
    }
  }
  // Two standing chat-only reads; keep existing slots and keyword routing unchanged.
  if (input.includeResearchReads && !allowProactive) {
    for (const toolId of RESEARCH_CHAT_TOOL_IDS) {
      const registered = getToolDefinition(toolId);
      if (!registered || !canDiscover(registered, 'available_read', 'possible', false, availability)) continue;
      const tool = researchChatToolDefinition(registered);
      candidates.push({ tool, source: 'available_read', strength: 'possible', executionMode: 'executable',
        authority: { kind: 'available_read', dataEpoch: input.dataEpoch, allowedToolIds: [toolId] } });
      reasons.push({ toolId, source: 'available_read', strength: 'possible' });
      serializedCharacterCount += candidateSerializedCharacters(tool);
    }
  }
  if (input.includeBrowserOpen && !allowProactive) {
    const tool = getToolDefinition(BROWSER_OPEN_TOOL_ID);
    if (tool && canDiscover(tool, 'available_confirmation', 'possible', false, availability)) {
      candidates.push({ tool, source: 'available_confirmation', strength: 'possible', executionMode: 'executable',
        authority: { kind: 'available_confirmation', dataEpoch: input.dataEpoch, allowedToolIds: [tool.id] } });
      reasons.push({ toolId: tool.id, source: 'available_confirmation', strength: 'possible' });
      serializedCharacterCount += candidateSerializedCharacters(tool);
    }
  }
  // One local read slot, independent of camera standby and question wording.
  if (input.includeCameraObservationBook) {
    const tool = getToolDefinition('camera.read_observations');
    if (tool && !candidates.some(candidate => candidate.tool.id === tool.id)
      && canDiscover(tool, 'available_read', 'possible', allowProactive, availability)) {
      candidates.push({ tool, source: 'available_read', strength: 'possible', executionMode: 'executable',
        authority: { kind: 'available_read', dataEpoch: input.dataEpoch, allowedToolIds: [tool.id] } });
      reasons.push({ toolId: tool.id, source: 'available_read', strength: 'possible' });
      serializedCharacterCount += candidateSerializedCharacters(tool);
    }
  }
  let packageDiscovery: JunLuoToolCapabilityDiscoveryOffer | undefined;
  const executableTools = candidates
    .filter((candidate) => candidate.executionMode === 'executable')
    .map((candidate) => candidate.tool);
  const discoveryToolIds = candidates
    .filter((candidate) => candidate.executionMode === 'discovery_only')
    .map((candidate) => candidate.tool.id);
  if (!executableTools.length) {
    const eligiblePackageIds = eligibleToolCapabilityPackageIds(availability);
    const weakPackageIds = [...new Set(candidates
      .filter((candidate) => candidate.executionMode === 'discovery_only')
      .map((candidate) => candidate.tool.packageId))]
      .filter((packageId) => eligiblePackageIds.includes(packageId));
    let trigger: JunLuoToolCapabilityDiscoveryTrigger | undefined;
    let catalogPackageIds: string[] = [];
    let discoveryAuthority: JunLuoToolExecutionAuthority | undefined;
    if (input.unlandedCommitment) {
      trigger = 'unlanded_commitment';
      catalogPackageIds = weakPackageIds.length ? weakPackageIds : eligiblePackageIds;
      discoveryAuthority = input.unlandedCommitment.authority;
    } else if (!protectedFromExecution && (explicit || GENERIC_ACTION_RESCUE_PATTERN.test(trimmedYouText))) {
      const scopedPackageIds = weakPackageIds.length === 1 ? weakPackageIds : [];
      const scopedToolIds = candidates
        .filter((candidate) => scopedPackageIds.includes(candidate.tool.packageId))
        .map((candidate) => candidate.tool.id);
      if (scopedPackageIds.length && scopedToolIds.length) {
        trigger = 'explicit_generic_action';
        catalogPackageIds = scopedPackageIds;
        discoveryAuthority = {
          kind: 'you_explicit',
          dataEpoch: input.dataEpoch,
          allowedToolIds: scopedToolIds,
        };
      }
    } else if (
      !protectedFromExecution
      && weakPackageIds.length
      && IMPLICIT_NEARBY_DISCOVERY_PATTERN.test(trimmedYouText)
    ) {
      trigger = 'weak_package_hint';
      catalogPackageIds = weakPackageIds;
    }
    if (trigger && catalogPackageIds.length) {
      packageDiscovery = {
        trigger,
        catalogPackageIds,
        catalogInstruction: buildToolCapabilityCatalogInstruction(catalogPackageIds),
        authority: discoveryAuthority,
        availability,
        preferredToolIds: [
          ...(input.unlandedCommitment?.preferredToolIds ?? []),
          ...validPendingActions.map((action) => action.toolId),
          ...recentResults.flatMap((result) => [result.toolId, ...result.followUpToolIds]),
          ...route.candidateTools,
        ].filter((toolId, index, all) => all.indexOf(toolId) === index),
        youText: input.youText,
      };
    }
  }

  const mode: JunLuoToolCandidateSelectionMode = executableTools.length
    ? 'direct_tools'
    : packageDiscovery
      ? 'package_discovery'
      : 'chat_only';

  return {
    mode,
    ...(input.includeWishPackage && !allowProactive ? { wishPackageEntry: true } : {}),
    ...(input.includeGiftPackage && !allowProactive ? { giftPackageEntry: true } : {}),
    ...(input.includeReadingReference && !allowProactive ? { readingReferenceTools: true } : {}),
    candidates,
    executableTools,
    discoveryToolIds,
    tools: executableTools,
    packages: [...new Set(candidates.map((candidate) => candidate.tool.packageId))],
    reasons,
    packageDiscovery,
    followUpResolution,
    weatherMapNearbyEvidence,
    serializedCharacterCount,
    truncated,
  };
}

export function selectFollowUpToolCandidates(
  initial: JunLuoToolCandidateSelection,
  results: readonly JunLuoToolResult[],
  _options: {
    musicPreferences?: MusicAgentPreferenceSnapshot;
  } = {},
): JunLuoToolCandidateSelection {
  const candidates = initial.candidates.filter((candidate) => (
    !results.some((result) => result.toolId === 'memory.update') || candidate.tool.id === 'music.play'
  ) && !results.some((result) => (
    result.toolId === candidate.tool.id
    && (
      isWeatherMapNearbyAgentToolId(candidate.tool.id)
      || candidate.tool.id === 'music.play'
      || candidate.tool.id === 'camera.look_once'
      || candidate.tool.id === BROWSER_OPEN_TOOL_ID
      || candidate.tool.id === 'device.launch_app'
      || candidate.tool.id === 'communication.open_phone_dialer'
      || result.ok && !candidate.tool.readOnly && !isGiftToolId(candidate.tool.id)
    )
  )));
  const deduplicated = candidates.filter((candidate, index, all) => (
    all.findIndex((entry) => entry.tool.id === candidate.tool.id) === index
  ));
  let serializedCharacterCount = 0;
  const boundedCandidates: JunLuoToolCandidateEntry[] = [];
  const additionalCharacters = deduplicated.filter(candidate => (
    candidate.tool.packageId === 'proactive_contact' || isBodySignalHistoryTool(candidate.tool.id)
    || RESEARCH_CHAT_TOOL_IDS.includes(candidate.tool.id)
    || candidate.tool.id === BROWSER_OPEN_TOOL_ID
    || candidate.tool.id === 'camera.read_observations'
    || initial.wishPackageEntry && isWishToolId(candidate.tool.id)
    || initial.giftPackageEntry && isGiftToolId(candidate.tool.id)
    || initial.desktopReminderTools && isReminderChatTool(candidate.tool.id)
    || ['schedule.query_routine', 'schedule.save_routine'].includes(candidate.tool.id)
    || initial.readingReferenceTools && ['reading.read_material', 'schedule.save_own'].includes(candidate.tool.id)
  ))
    .reduce((sum, candidate) => sum + candidateSerializedCharacters(candidate.tool), 0);
  for (const candidate of deduplicated) {
    const characters = candidate.executionMode === 'executable'
      ? candidateSerializedCharacters(candidate.tool)
      : 0;
    if (serializedCharacterCount + characters > DEFAULT_MAX_SERIALIZED_CHARACTERS + additionalCharacters) break;
    boundedCandidates.push(candidate);
    serializedCharacterCount += characters;
  }
  const executableTools = boundedCandidates
    .filter((candidate) => candidate.executionMode === 'executable')
    .map((candidate) => candidate.tool);
  const discoveryToolIds = boundedCandidates
    .filter((candidate) => candidate.executionMode === 'discovery_only')
    .map((candidate) => candidate.tool.id);
  return {
    mode: executableTools.length ? 'direct_tools' : 'chat_only',
    ...(initial.wishPackageEntry ? { wishPackageEntry: true } : {}),
    ...(initial.giftPackageEntry ? { giftPackageEntry: true } : {}),
    ...(initial.readingReferenceTools ? { readingReferenceTools: true } : {}),
    ...(initial.desktopReminderTools ? { desktopReminderTools: true } : {}),
    candidates: boundedCandidates,
    executableTools,
    discoveryToolIds,
    tools: executableTools,
    packages: [...new Set(boundedCandidates.map((candidate) => candidate.tool.packageId))],
    reasons: boundedCandidates.map((candidate) => ({
      toolId: candidate.tool.id,
      source: candidate.source,
      strength: candidate.strength,
    })),
    followUpResolution: initial.followUpResolution,
    serializedCharacterCount,
    truncated: boundedCandidates.length < deduplicated.length,
  };
}
