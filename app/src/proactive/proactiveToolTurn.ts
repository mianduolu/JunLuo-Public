import {
  runOpenAiCompatibleToolAgentTurn,
  type RunOpenAiCompatibleToolAgentTurnOptions,
} from '../ai/toolAgentProvider';
import type { AiConnection, AiProfile } from '../ai/types';
import { CONTACT_MODEL_REQUEST_TIMEOUT_MS } from './unifiedContact';
import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import { isSiliconQwenChatConnection, type QwenChatLayoutMode } from '../ai/qwenChatLayout';
import { prepareCameraModelObservationHost } from '../camera/cameraModelObservationRuntime';
import { CAMERA_LOOK_ONCE_TOOL_ID } from '../camera/cameraModelObservationMaterials';
import { CAMERA_STANDBY_SIDE_EFFECT_GATE_POLICY_ID } from '../tools/toolAgentSideEffectGatePolicy';
import { isBodySignalHistoryTool } from '../tools/bodySignalHistoryToolDefinition';
import { createProactiveWishTurn, type WishContactValidity } from '../wishPool/wishProactiveRuntime';
import { isWishToolId } from '../wishPool/wishToolContract';
import { GIFT_TOOL_IDS, isGiftToolId } from '../gifts/giftToolContract';
import { createGiftToolTurn } from '../gifts/giftToolTurn';
import { GIFT_SIDE_EFFECT_GATE_POLICY_ID } from '../tools/toolAgentSideEffectGatePolicy';
import { canCommitBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { PRIMARY_CHAT_SESSION_ID } from '../chat/primaryChat';
import { readUnifiedContactState } from './unifiedContactStore';
import { WISH_SIDE_EFFECT_GATE_POLICY_ID } from '../tools/toolAgentSideEffectGatePolicy';
import { PHONE_LIMIT_SIDE_EFFECT_GATE_POLICY_ID } from '../tools/toolAgentSideEffectGatePolicy';
import { availablePhoneLimitToolIds } from '../backend/phoneLimitActionNative';
import { isPhoneLimitToolId } from '../tools/phoneLimitContract';
import {
  createDefaultToolCandidateAvailabilitySnapshot,
  createToolAgentGateRejectedResult,
  executeNativeChatToolInvocation,
  getToolDefinition,
  MUSIC_PLAYBACK_INTENT_SIDE_EFFECT_GATE_POLICY_ID,
  registerBuiltinTools,
  resolveToolPermissionForCall,
  resolveNativeChatToolInvocationGate,
  type JunLuoToolCandidateSelection,
  type JunLuoToolChatAgentReadiness,
  type JunLuoRegisteredToolDefinition,
} from '../tools';

export const ORDINARY_PROACTIVE_TOOL_IDS = [
  'system_status.get_battery',
  'phone_context.get_recent_activity',
  'phone_context.get_app_usage',
  'location.get_current_position',
  'music.play',
  'body_signal.get_steps_history',
  'body_signal.get_sleep_history',
  'camera.read_observations',
] as const;

const ORDINARY_PROACTIVE_TOOL_ID_SET = new Set<string>(
  ORDINARY_PROACTIVE_TOOL_IDS,
);
const ORDINARY_PROACTIVE_ACTION_TOOL_ID_SET = new Set<string>(['music.play']);
const WISH_PROACTIVE_TOOL_IDS = ['wish.propose', 'wish.view', 'wish.pull', 'wish.invite_discussion'];

export function buildOrdinaryProactiveToolCandidates(
  dataEpoch: number,
  wishEnabled = false,
  phoneEnabled = false,
  giftEnabled = false,
): JunLuoToolCandidateSelection {
  registerBuiltinTools();
  const availability = createDefaultToolCandidateAvailabilitySnapshot();
  const tools = [...ORDINARY_PROACTIVE_TOOL_IDS, ...(wishEnabled ? WISH_PROACTIVE_TOOL_IDS : []),
    ...(giftEnabled ? GIFT_TOOL_IDS : []),
    ...(phoneEnabled ? availablePhoneLimitToolIds() : [])]
    .map((toolId) => getToolDefinition(toolId))
    .filter((tool): tool is JunLuoRegisteredToolDefinition => {
      if (!tool) return false;
      return availability.enabledPackageIds.includes(tool.packageId)
        && (!(isBodySignalHistoryTool(tool.id) || isWishToolId(tool.id) || isGiftToolId(tool.id) || isPhoneLimitToolId(tool.id)
          || tool.id === 'camera.read_observations') || !availability.deniedToolIds.includes(tool.id))
        && !availability.unavailableToolIds.includes(tool.id)
        && (tool.readOnly || ORDINARY_PROACTIVE_ACTION_TOOL_ID_SET.has(tool.id) || isWishToolId(tool.id) || isGiftToolId(tool.id) || isPhoneLimitToolId(tool.id))
        && tool.proactiveEligible
        && typeof tool.executor === 'function';
    });
  const candidates = tools.map((tool) => {
    const directAction = ORDINARY_PROACTIVE_ACTION_TOOL_ID_SET.has(tool.id)
      || (isWishToolId(tool.id) || isGiftToolId(tool.id) || isPhoneLimitToolId(tool.id)) && !tool.readOnly;
    return {
      tool,
      source: directAction ? 'manual_activation' as const : 'proactive_read' as const,
      strength: 'possible' as const,
      executionMode: 'executable' as const,
      authority: {
        kind: directAction ? 'manual_activation' as const : 'available_read' as const,
        dataEpoch,
        allowedToolIds: [tool.id],
      },
    };
  });
  return {
    mode: candidates.length ? 'direct_tools' : 'chat_only',
    ...(giftEnabled ? { giftPackageEntry: true } : {}),
    candidates,
    executableTools: tools,
    discoveryToolIds: [],
    tools,
    packages: [...new Set(tools.map((tool) => tool.packageId))],
    reasons: candidates.map((candidate) => ({
      toolId: candidate.tool.id,
      source: candidate.source,
      strength: candidate.strength,
    })),
    serializedCharacterCount: JSON.stringify(tools).length,
    truncated: false,
  };
}

function noFurtherTools(
  current: JunLuoToolCandidateSelection,
): JunLuoToolCandidateSelection {
  return {
    ...current,
    mode: 'chat_only',
    candidates: [],
    executableTools: [],
    tools: [],
    packages: [],
    reasons: [],
    serializedCharacterCount: 0,
  };
}

function proactiveToolReadiness(toolId: string): JunLuoToolChatAgentReadiness | undefined {
  if (isGiftToolId(toolId)) return { toolId, mode: 'agent_primary', reconciliationMode: 'none',
    ...(toolId !== 'gift.view' ? { sideEffectGatePolicyId: GIFT_SIDE_EFFECT_GATE_POLICY_ID } : {}) };
  if (isPhoneLimitToolId(toolId)) return { toolId, mode: 'agent_primary', reconciliationMode: 'none',
    ...(toolId !== 'phone_limit.get_status' ? { sideEffectGatePolicyId: PHONE_LIMIT_SIDE_EFFECT_GATE_POLICY_ID } : {}) };
  if (isWishToolId(toolId)) return { toolId, mode: 'agent_primary', reconciliationMode: 'none',
    ...(toolId !== 'wish.view' ? { sideEffectGatePolicyId: WISH_SIDE_EFFECT_GATE_POLICY_ID } : {}) };
  if (!ORDINARY_PROACTIVE_TOOL_ID_SET.has(toolId)) return undefined;
  return {
    toolId,
    mode: 'agent_primary',
    reconciliationMode: 'none',
    sideEffectGatePolicyId: ORDINARY_PROACTIVE_ACTION_TOOL_ID_SET.has(toolId)
      ? MUSIC_PLAYBACK_INTENT_SIDE_EFFECT_GATE_POLICY_ID
      : undefined,
  };
}

export async function runOrdinaryProactiveToolTurn({
  apiKey,
  backupRestoreLeaseHeld,
  connection,
  dataEpoch,
  profile,
  responseInstruction,
  allowPhoneEmergencySilence,
  sourceMessageId,
  sourceSessionId,
  triggerSystemMessage,
  recoveryContext,
  todoContext,
  signal,
  beforeModelRequest,
  onSettlement,
  onLateSettlement,
  onTransportAttempt,
  bodyOnlyRetry,
  wishValidity,
  phoneLimitValidity,
  qwenChatLayout,
  messages,
  refreshTriggerSystemMessage,
}: {
  apiKey: string;
  backupRestoreLeaseHeld?: boolean;
  connection: AiConnection;
  dataEpoch: number;
  profile: AiProfile;
  responseInstruction: string;
  allowPhoneEmergencySilence?: boolean;
  sourceMessageId: string;
  sourceSessionId: string;
  triggerSystemMessage: string;
  recoveryContext?: string;
  todoContext?: string;
  signal?: AbortSignal;
  beforeModelRequest?: RunOpenAiCompatibleToolAgentTurnOptions['beforeModelRequest'];
  onSettlement?: RunOpenAiCompatibleToolAgentTurnOptions['onSettlement'];
  onLateSettlement?: RunOpenAiCompatibleToolAgentTurnOptions['onLateSettlement'];
  onTransportAttempt?: RunOpenAiCompatibleToolAgentTurnOptions['onTransportAttempt'];
  bodyOnlyRetry?: RunOpenAiCompatibleToolAgentTurnOptions['bodyOnlyRetry'];
  wishValidity?: WishContactValidity;
  phoneLimitValidity?: () => Promise<boolean>;
  qwenChatLayout?: QwenChatLayoutMode;
  messages?: readonly SubjectiveMessage[];
  refreshTriggerSystemMessage?: () => Promise<string>;
}) {
  const cameraHost = bodyOnlyRetry ? undefined : await prepareCameraModelObservationHost({
    entry: 'proactive_contact', sourceMessageId, sourceSessionId, dataEpoch, responseConnection: connection, signal,
  });
  const wishPool = !bodyOnlyRetry && wishValidity ? createProactiveWishTurn({
    dataEpoch, sourceMessageId, sourceSessionId, signal, valid: wishValidity,
  }) : undefined;
  const giftCurrent = async () => {
    if (signal?.aborted || !canCommitBackupRestoreDataEpoch(dataEpoch) || sourceSessionId !== PRIMARY_CHAT_SESSION_ID
      || !wishValidity) return false;
    const op = (await readUnifiedContactState()).current;
    return !!op && op.id === sourceMessageId && op.sessionId === sourceSessionId && op.epoch === dataEpoch
      && op.status === 'requesting' && !op.important && Date.now() < op.expiresAt && await wishValidity(op)
      && !signal?.aborted && canCommitBackupRestoreDataEpoch(dataEpoch);
  };
  const giftCabinet = !bodyOnlyRetry && wishValidity ? createGiftToolTurn({ dataEpoch, signal, isCurrent: giftCurrent }) : undefined;
  const phoneLimit = !bodyOnlyRetry && phoneLimitValidity ? (await import('../tools/phoneLimitToolTurn')).createPhoneLimitToolTurn({
    dataEpoch, sourceMessageId, signal, requestedBy: 'proactive', isCurrent: phoneLimitValidity,
  }) : undefined;
  const initialCandidates = buildOrdinaryProactiveToolCandidates(dataEpoch, !!wishPool, !!phoneLimit, !!giftCabinet);
  // The existing contact host claims a new opportunity at transport admission,
  // after the first tools offer. Mutations always require that actual claim.
  let modelAdmitted = false;
  const candidates = cameraHost?.addCandidate(initialCandidates) ?? initialCandidates;
  const readiness = (toolId: string): JunLuoToolChatAgentReadiness | undefined =>
    cameraHost && toolId === CAMERA_LOOK_ONCE_TOOL_ID
      ? { toolId, mode: 'agent_primary', reconciliationMode: 'none', sideEffectGatePolicyId: CAMERA_STANDBY_SIDE_EFFECT_GATE_POLICY_ID }
      : proactiveToolReadiness(toolId);
  const isDirectAction = (toolId: string) => ORDINARY_PROACTIVE_ACTION_TOOL_ID_SET.has(toolId)
    || !!wishPool && isWishToolId(toolId) && toolId !== 'wish.view'
    || !!giftCabinet && isGiftToolId(toolId) && toolId !== 'gift.view'
    || !!phoneLimit && isPhoneLimitToolId(toolId) && toolId !== 'phone_limit.get_status'
    || !!cameraHost && toolId === CAMERA_LOOK_ONCE_TOOL_ID;
  const triggerPreamble = { role: 'system' as const, content: triggerSystemMessage };
  return runOpenAiCompatibleToolAgentTurn({
    sourceMessageId,
    sourceSessionId,
    dataEpoch,
    candidates,
    hostOnlyAllowedToolIds: cameraHost ? [CAMERA_LOOK_ONCE_TOOL_ID] : [],
    isToolAvailableForRequest: async toolId => {
      if (isPhoneLimitToolId(toolId)) {
        if (!phoneLimit || !availablePhoneLimitToolIds().includes(toolId)
          || modelAdmitted && !await phoneLimit.available()) return false;
        const tool = getToolDefinition(toolId);
        return !!tool && (await resolveToolPermissionForCall(tool, { input: {}, requestedBy: 'proactive' })).permission === 'allow';
      }
      return toolId !== CAMERA_LOOK_ONCE_TOOL_ID || !!await cameraHost?.available();
    },
    chatOptions: {
      apiKey,
      ambientContext: '',
      connection,
      contextSource: 'proactive.ordinary',
      ...(qwenChatLayout && isSiliconQwenChatConnection(connection)
        ? { qwenChatLayout, messages: [...(messages ?? [])] }
        : { messages: [] }),
      preambleMessages: [
        triggerPreamble,
        ...(recoveryContext ? [{ role: 'system' as const, content: recoveryContext }] : []),
        ...(todoContext ? [{ role: 'system' as const, content: todoContext }] : []),
      ],
      profile,
      responseInstruction,
      allowPhoneEmergencySilence,
      signal,
      ...(refreshTriggerSystemMessage ? { refreshMemoryMaterials: async () => {
        // The existing provider reassembles its local preamble after this hook.
        // Keep the same message identity and position, including tool continuations.
        triggerPreamble.content = await refreshTriggerSystemMessage();
        return {};
      } } : {}),
    },
    allowEmptyResponseRetry: false,
    allowProtocolCorrection: false,
    modelRequestTimeoutMs: CONTACT_MODEL_REQUEST_TIMEOUT_MS,
    requestPreflightAtTransport: true,
    beforeModelRequest: phoneLimit ? async kind => { await beforeModelRequest?.(kind); modelAdmitted = true; } : beforeModelRequest,
    onSettlement,
    onLateSettlement,
    onTransportAttempt,
    bodyOnlyRetry,
    executeInvocation: (invocation, context) => executeNativeChatToolInvocation(invocation, context, {
      candidateSource: isDirectAction(invocation.toolId)
        ? 'manual_activation'
        : 'proactive_read',
      authorityKind: isDirectAction(invocation.toolId)
        ? 'manual_activation'
        : 'available_read',
      executionOptions: { backupRestoreLeaseHeld,
        wishPool,
        giftCabinet,
        phoneLimit: phoneLimit ? call => phoneLimit.execute(call, context.signal) : undefined,
        cameraObservation: cameraHost ? call => cameraHost.execute(call, context.signal) : undefined },
      readiness,
      requestedBy: 'proactive',
    }),
    resolveInvocationGate: (invocation, context) => resolveNativeChatToolInvocationGate(
      invocation,
      context,
      {
        createRejectedResult: createToolAgentGateRejectedResult,
        promptForReadPermission: async () => 'cancelled',
        requestedBy: 'proactive',
        resolveReadiness: readiness,
        allowSideEffectWithoutConfirmation: ({ policyId, invocation: proposed }) => (
          !!phoneLimit && isPhoneLimitToolId(proposed.toolId) && proposed.toolId !== 'phone_limit.get_status'
          && policyId === PHONE_LIMIT_SIDE_EFFECT_GATE_POLICY_ID
          ||
          proposed.toolId === 'music.play'
          && policyId === MUSIC_PLAYBACK_INTENT_SIDE_EFFECT_GATE_POLICY_ID
          || !!cameraHost && proposed.toolId === CAMERA_LOOK_ONCE_TOOL_ID && policyId === CAMERA_STANDBY_SIDE_EFFECT_GATE_POLICY_ID
          || !!wishPool && isWishToolId(proposed.toolId) && policyId === WISH_SIDE_EFFECT_GATE_POLICY_ID
          || !!giftCabinet && isGiftToolId(proposed.toolId) && policyId === GIFT_SIDE_EFFECT_GATE_POLICY_ID
        ),
      },
    ),
    responseFormat: 'proactive_lite',
    selectFollowUpCandidates: (current, results) => {
      const keepCamera = results.some(result => result.toolId === 'camera.read_observations' && result.ok);
      const keepPhone = !!phoneLimit && results.some(result => isPhoneLimitToolId(result.toolId));
      const keepGift = !!giftCabinet && results.some(result => isGiftToolId(result.toolId));
      if (!keepCamera && !keepPhone && !keepGift) return noFurtherTools(current);
      const candidates = current.candidates.filter(candidate => keepCamera && candidate.tool.id === 'camera.read_observations'
        || keepPhone && isPhoneLimitToolId(candidate.tool.id) || keepGift && isGiftToolId(candidate.tool.id));
      const tools = candidates.map(candidate => candidate.tool);
      return { ...noFurtherTools(current), mode: candidates.length ? 'direct_tools' : 'chat_only',
        candidates, tools, executableTools: tools, packages: [...new Set(tools.map(tool => tool.packageId))],
        serializedCharacterCount: JSON.stringify(tools).length };
    },
  });
}
