import {
  createDefaultToolCandidateAvailabilitySnapshot,
  eligibleToolCapabilityPackageIds, buildToolCapabilityCatalogInstruction, resolveToolCapabilityDiscovery,
} from './toolCapabilityDiscovery';
import {
  selectChatToolCandidates,
  candidateSerializedCharacters,
  type JunLuoToolCandidateReason,
  type JunLuoToolCandidateSelection,
  type SelectChatToolCandidatesInput,
} from './toolCandidateSelector';
import {
  BUILTIN_TOOL_CHAT_AGENT_READINESS,
  buildToolChatAgentAvailabilitySnapshot,
  createToolChatAgentProductionAvailabilitySnapshot,
  getEffectiveBuiltinToolChatAgentReadiness,
} from './toolChatAgentMigration';
import { loadChatPreferences } from '../chat/chatPreferences';
import { listTools } from './toolRegistry';
import { RESEARCH_CHAT_TOOL_IDS } from './researchChatTools';
import { TEXT_FILE_CHAT_TOOL_IDS } from './textFileChatTools';
import { EXPENSE_CHAT_TOOL_IDS } from './expenseChatTools';
import { REMINDER_CHAT_TOOL_IDS, isReminderChatTool } from './chatReminderTools';
import { Platform } from 'react-native';
import { PHONE_LIMIT_TOOL_METADATA } from './phoneLimitContract';
import { availablePhoneLimitToolIds } from '../backend/phoneLimitActionNative';
import { DIALER_TOOL_ID } from './chatDialer';
import { BACKEND_OVERVIEW_TOOL_ID } from './chatBackendOverview';

export type JunLuoToolChatAgentShadowDiagnostic = {
  candidateToolIds: string[];
  reasons: JunLuoToolCandidateReason[];
};

export type JunLuoToolChatAgentProductionSelection = {
  selection: JunLuoToolCandidateSelection;
  shadow: JunLuoToolChatAgentShadowDiagnostic;
};

export async function selectProductionChatToolAgentCandidates(
  input: Omit<SelectChatToolCandidatesInput, 'availability'>,
): Promise<JunLuoToolChatAgentProductionSelection> {
  const [availability, base, musicPreferences] = await Promise.all([
    createToolChatAgentProductionAvailabilitySnapshot(),
    Promise.resolve(createDefaultToolCandidateAvailabilitySnapshot()),
    input.musicPreferences ?? loadChatPreferences(),
  ]);
  const phoneIds = PHONE_LIMIT_TOOL_METADATA.map(tool => tool.id);
  const phoneAvailable = input.allowProactive ? [] : availablePhoneLimitToolIds();
  const backendOverviewAvailable = !input.allowProactive && (Platform.OS === 'android' || Platform.OS === 'ios');
  const httpToolIds = listTools('http').map(tool => tool.id);
  availability.unavailableToolIds.push(...phoneIds.filter(id => !phoneAvailable.includes(id)));
  const selection = selectChatToolCandidates({
    ...input,
    // Ordinary chat gets two standing reads; proactive exposure remains unchanged.
    availability: input.allowProactive
      ? { ...availability, unavailableToolIds: [...availability.unavailableToolIds, ...httpToolIds, ...RESEARCH_CHAT_TOOL_IDS, ...TEXT_FILE_CHAT_TOOL_IDS, ...EXPENSE_CHAT_TOOL_IDS, ...REMINDER_CHAT_TOOL_IDS, 'browser.open', 'image.describe_local', 'device.launch_app', DIALER_TOOL_ID] }
      : { ...availability, unavailableToolIds: [...availability.unavailableToolIds, ...httpToolIds, ...TEXT_FILE_CHAT_TOOL_IDS, ...EXPENSE_CHAT_TOOL_IDS, ...REMINDER_CHAT_TOOL_IDS, 'weather.get_current', 'weather.get_forecast', 'image.describe_local', 'device.launch_app', DIALER_TOOL_ID] },
    includeResearchReads: !input.allowProactive,
    includeBrowserOpen: !input.allowProactive,
    includeCameraObservationBook: true,
    includePhoneBattery: true,
    includeWishPackage: !input.allowProactive,
    includeGiftPackage: !input.allowProactive,
    includeWearableHistory: true,
    includePhoneContextReads: true,
    includeMemoryCorrection: true,
    includeMemoryRead: true,
    includeProactiveContact: !input.allowProactive,
    includeMusicPlayback: true,
    musicPreferences,
    includeScheduleAgenda: true,
    includeUserRoutine: !input.allowProactive,
    includeScheduleComplete: true,
    includeScheduleCreate: false,
    includeTodoComplete: true,
    includeTodoCreate: false,
    allowProactive: input.allowProactive === true,
    maxTools: Math.min(15, input.maxTools ?? 15),
  });
  // Keep existing direct tools; the schedule package adds only the missing I schedule writer.
  const discoveryToolIds = ['schedule.save_own', 'map.search_nearby', 'map.search_destination', 'map.more_results', 'weather.get_current', 'weather.get_forecast', ...TEXT_FILE_CHAT_TOOL_IDS, ...EXPENSE_CHAT_TOOL_IDS, ...REMINDER_CHAT_TOOL_IDS];
  if (backendOverviewAvailable) discoveryToolIds.push(BACKEND_OVERVIEW_TOOL_ID);
  if (!input.allowProactive) discoveryToolIds.push(...phoneAvailable);
  if (Platform.OS === 'android' && input.includeAppLaunch && !input.allowProactive) discoveryToolIds.push('device.launch_app');
  if (Platform.OS === 'android' && input.includeDialer && !input.allowProactive) discoveryToolIds.push(DIALER_TOOL_ID);
  const discoveryAvailability = { ...availability, unavailableToolIds: [...availability.unavailableToolIds,
    ...[...listTools('schedule'), ...listTools('map'), ...listTools('weather'), ...listTools('reminder'), ...listTools('device'), ...listTools('communication'), ...listTools('http')].filter(tool => !discoveryToolIds.includes(tool.id)).map(tool => tool.id)] };
  const catalogPackageIds = ['schedule', 'map', 'weather', ...(Platform.OS === 'android' || Platform.OS === 'ios' ? ['files', 'expense', 'reminder'] : Platform.OS === 'windows' ? ['reminder'] : [])]
    .concat(!input.allowProactive && phoneAvailable.length ? ['phone_limit'] : [])
    .concat(Platform.OS === 'android' && input.includeAppLaunch && !input.allowProactive ? ['device'] : [])
    .concat(Platform.OS === 'android' && input.includeDialer && !input.allowProactive ? ['communication'] : [])
    .concat(backendOverviewAvailable ? ['http'] : [])
    .filter(id => eligibleToolCapabilityPackageIds(discoveryAvailability).includes(id));
  if (!input.allowProactive && !selection.packageDiscovery && catalogPackageIds.length) {
    selection.packageDiscovery = { alongsideTools: true, chatBackendOverview: backendOverviewAvailable, trigger: 'conversation_context',
      catalogPackageIds, catalogInstruction: buildToolCapabilityCatalogInstruction(catalogPackageIds, { chatAppLaunch: true, chatDialer: true, chatBackendOverview: backendOverviewAvailable }),
      availability: discoveryAvailability, preferredToolIds: [], youText: '',
      authority: { kind: 'available_confirmation', dataEpoch: input.dataEpoch,
        allowedToolIds: discoveryToolIds } };
    if (selection.mode === 'chat_only') selection.mode = 'package_discovery';
  }
  // A pre-existing scoped offer must not hide the new standing read or widen its other targets.
  if (backendOverviewAvailable && catalogPackageIds.includes('http') && selection.packageDiscovery
    && !selection.packageDiscovery.chatBackendOverview) {
    const offer = selection.packageDiscovery;
    const ids = [...new Set([...offer.catalogPackageIds, 'http'])];
    selection.packageDiscovery = { ...offer, chatBackendOverview: true, catalogPackageIds: ids,
      catalogInstruction: buildToolCapabilityCatalogInstruction(ids, { chatBackendOverview: true }),
      availability: { ...offer.availability, unavailableToolIds: [...new Set([
        ...offer.availability.unavailableToolIds.filter(id => id !== BACKEND_OVERVIEW_TOOL_ID),
        ...httpToolIds.filter(id => id !== BACKEND_OVERVIEW_TOOL_ID),
      ])] },
      authority: { ...(offer.authority ?? { kind: 'available_read', dataEpoch: input.dataEpoch }),
        allowedToolIds: [...new Set([...(offer.authority?.allowedToolIds ?? []), BACKEND_OVERVIEW_TOOL_ID])] } };
  }
  if (Platform.OS === 'windows' && !input.allowProactive
    && selection.packageDiscovery?.catalogPackageIds.includes('reminder')) {
    selection.packageDiscovery.catalogInstruction += '\n\nyou 想新建提醒时，I 先发起 reminder.propose_reminders 的原生工具调用，准备待确认草稿。修改或取消提醒时，I 先用 reminder.query 查找，再用 reminder.propose_updates 或 reminder.propose_cancellations 准备草稿。工具结果回来后，I 再按本轮 JSON 格式写下要对 you 说的话。you 点保存后，I 再根据保存结果说明提醒是否已保存。';
    // Resolve the existing definitions and authority only; no tool is executed
    // and the resolver's synthetic result is never sent or saved as a receipt.
    const reminderCandidates = resolveToolCapabilityDiscovery({
      callId: 'desktop-reminder-catalog', arguments: { packageIds: ['reminder'] },
      offer: selection.packageDiscovery,
    }).candidates.filter(candidate => isReminderChatTool(candidate.tool.id)
      && candidate.executionMode === 'executable'
      && candidate.authority?.allowedToolIds.includes(candidate.tool.id))
      .map(candidate => candidate.tool.id === 'reminder.propose_reminders'
        ? { ...candidate, tool: { ...candidate.tool,
          description: '准备待确认的提醒草稿，交给 you 点保存。一次可以安排多条。单次的相对时间填写 afterMinutes；指定日期时间或重复提醒填写 date 和 clock。' } }
        : candidate);
    if (reminderCandidates.length) {
      const added = reminderCandidates.filter(candidate => !selection.candidates.some(entry => entry.tool.id === candidate.tool.id));
      selection.candidates.push(...added);
      selection.executableTools = selection.candidates.filter(candidate => candidate.executionMode === 'executable').map(candidate => candidate.tool);
      selection.tools = selection.executableTools;
      selection.packages = [...new Set(selection.candidates.map(candidate => candidate.tool.packageId))];
      selection.reasons.push(...added.map(({ tool, source, strength }) => ({ toolId: tool.id, source, strength })));
      selection.serializedCharacterCount += added.reduce((sum, candidate) => sum + candidateSerializedCharacters(candidate.tool), 0);
      selection.desktopReminderTools = true;
      selection.mode = 'direct_tools';
    }
    if (['schedule.submit_day_plan', 'reminder.propose_reminders'].every(id => selection.candidates.some(candidate =>
      candidate.tool.id === id && candidate.executionMode === 'executable'
      && candidate.authority?.allowedToolIds.includes(id)))) {
      selection.packageDiscovery.catalogInstruction += '\n\nyou 要排日程时，I 用 schedule.submit_day_plan 准备日程草稿，提前提醒也填在同一件安排里。reminderAction 填 null。\nyou 要单独设提醒或闹钟时，I 用 reminder.propose_reminders 准备提醒草稿，reminderAction 写这次的选择。';
    }
  }
  const shadowSelection = selectChatToolCandidates({
    ...input,
    includeResearchReads: false,
    includeBrowserOpen: false,
    includeCameraObservationBook: false,
    includeReadingReference: false,
    includeWishPackage: false,
    includeGiftPackage: false,
    includePhoneBattery: false,
    includeWearableHistory: false,
    includePhoneContextReads: false,
    includeMemoryCorrection: false,
    includeMemoryRead: false,
    includeProactiveContact: false,
    includeMusicPlayback: false,
    includeScheduleAgenda: false,
    includeUserRoutine: false,
    includeScheduleComplete: false,
    includeScheduleCreate: false,
    includeTodoComplete: false,
    includeTodoCreate: false,
    availability: buildToolChatAgentAvailabilitySnapshot(
      base,
      getEffectiveBuiltinToolChatAgentReadiness() === BUILTIN_TOOL_CHAT_AGENT_READINESS
        ? BUILTIN_TOOL_CHAT_AGENT_READINESS
        : [],
      ['shadow_only'],
    ),
    allowProactive: false,
  });
  return {
    selection,
    shadow: {
      candidateToolIds: shadowSelection.candidates.map((candidate) => candidate.tool.id),
      reasons: shadowSelection.reasons.map((reason) => ({ ...reason })),
    },
  };
}
