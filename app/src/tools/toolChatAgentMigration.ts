import { registerBuiltinTools } from './builtin/registerBuiltinTools';
import { listToolPackages, listTools } from './toolRegistry';
import type { JunLuoToolCandidateAvailabilitySnapshot } from './toolCapabilityDiscovery';
import { createDefaultToolCandidateAvailabilitySnapshot } from './toolCapabilityDiscovery';
import { resolveToolPermissionForCall } from './toolPermissions';
import { readToolPermissionSettingsRaw } from './toolPermissionStore';
import {
  getToolAgentConfirmationPresenter,
  SCHEDULE_COMPLETE_OCCURRENCE_CONFIRMATION_PRESENTER_ID,
  SCHEDULE_CREATE_EVENT_CONFIRMATION_PRESENTER_ID,
  TODO_COMPLETE_CONFIRMATION_PRESENTER_ID,
  TODO_CREATE_CONFIRMATION_PRESENTER_ID,
} from './toolAgentConfirmationPresenter';
import { isRegisteredToolAgentSideEffectGatePolicy, MUSIC_PLAYBACK_INTENT_SIDE_EFFECT_GATE_POLICY_ID, CAMERA_STANDBY_SIDE_EFFECT_GATE_POLICY_ID, SLEEP_CHAT_WINDOW_SIDE_EFFECT_GATE_POLICY_ID } from './toolAgentSideEffectGatePolicy';
import { MEMORY_CORRECTION_PRESENTER_ID } from './memoryCorrection';
import { CONTACT_CHAT_SIDE_EFFECT_GATE_POLICY_ID } from './toolAgentSideEffectGatePolicy';
import { READING_ACTIVITY_SIDE_EFFECT_GATE_POLICY_ID } from './toolAgentSideEffectGatePolicy';
import { isBodySignalHistoryTool } from './bodySignalHistoryToolDefinition';
import { OWN_SCHEDULE_SIDE_EFFECT_GATE_POLICY_ID } from './toolAgentSideEffectGatePolicy';
import { DIALER_SIDE_EFFECT_GATE_POLICY_ID } from './toolAgentSideEffectGatePolicy';
import { WISH_SIDE_EFFECT_GATE_POLICY_ID } from './toolAgentSideEffectGatePolicy';
import { isWishToolId } from '../wishPool/wishToolContract';
import { GIFT_TOOL_IDS, isGiftToolId } from '../gifts/giftToolContract';
import { GIFT_SIDE_EFFECT_GATE_POLICY_ID } from './toolAgentSideEffectGatePolicy';
import { MAP_QUERY_SIDE_EFFECT_GATE_POLICY_ID, MAP_QUERY_STATE_TOOL_IDS } from './toolAgentSideEffectGatePolicy';
import { BROWSER_OPEN_SIDE_EFFECT_GATE_POLICY_ID } from './toolAgentSideEffectGatePolicy';
import { TEXT_FILE_CHAT_SIDE_EFFECT_GATE_POLICY_ID } from './toolAgentSideEffectGatePolicy';
import { isTextFileChatTool, TEXT_FILE_WRITE_TOOL_IDS } from './textFileChatTools';
import { CHAT_IMAGE_SIDE_EFFECT_GATE_POLICY_ID } from './toolAgentSideEffectGatePolicy';
import { CHAT_SCHEDULE_SIDE_EFFECT_GATE_POLICY_ID } from './toolAgentSideEffectGatePolicy';
import { isExpenseChatTool } from './expenseChatTools';
import { isReminderChatTool } from './chatReminderTools';
import { APP_LAUNCH_SIDE_EFFECT_GATE_POLICY_ID, PHONE_LIMIT_SIDE_EFFECT_GATE_POLICY_ID } from './toolAgentSideEffectGatePolicy';

export type JunLuoToolChatAgentMigrationMode =
  | 'legacy_only'
  | 'shadow_only'
  | 'agent_primary';

export type JunLuoToolChatAgentReconciliationMode =
  | 'none'
  | 'automatic'
  | 'manual_review';

export type JunLuoToolChatAgentReadiness = {
  toolId: string;
  mode: JunLuoToolChatAgentMigrationMode;
  confirmationPresenterId?: string;
  sideEffectGatePolicyId?: string;
  reconciliationMode: JunLuoToolChatAgentReconciliationMode;
};

/**
 * Chapter 10 starts with every builtin tool on its existing production route.
 * Domain chapters 11-19 must change entries deliberately after their own gates pass.
 */
const CHAPTER_11_WEATHER_MAP_NEARBY_TOOL_IDS = new Set([
  'weather.get_current',
  'weather.get_forecast',
  'map.reverse_geocode',
  'map.geocode_place',
  'map.search_destination',
  'map.search_nearby',
  'map.more_results',
  'nearby.describe_place_context',
  'nearby.verify_location_consistency',
]);

export const BUILTIN_TOOL_CHAT_AGENT_READINESS: readonly JunLuoToolChatAgentReadiness[] = [
  'phone_limit.get_status',
  'phone_limit.start',
  'phone_limit.shorten',
  'phone_limit.end',
  'phone_limit.release_app',
  'phone_limit.set_plan',
  'alarm.create',
  'alarm.get_strong_alarm_status',
  'alarm.list',
  'alarm.strong_cancel',
  'alarm.strong_create',
  'body_signal.get_battery',
  'body_signal.get_latest',
  'body_signal.get_summary',
  'body_signal.get_steps_history',
  'body_signal.get_sleep_history',
  'browser.list_tabs',
  'browser.open',
  'browser.read_text',
  'browser.snapshot',
  'camera.look_once',
  'camera.read_observations',
  'proactive_contact.get_status',
  'proactive_contact.pause',
  'proactive_contact.resume',
  'communication.draft_sms',
  'communication.draft_social_post',
  'communication.open_phone_dialer',
  'communication.open_sms_composer',
  'communication.share_file',
  'communication.share_text',
  'credential.check_configured',
  'credential.list_status',
  'credential.reveal',
  'developer_lab.get_status',
  'developer_lab.run_js_sandboxed',
  'developer_lab.run_python_sandboxed',
  'device.back',
  'device.bluetooth_scan',
  'device.bluetooth_status',
  'device.click_text',
  'device.colmi_scan',
  'device.get_accessibility_snapshot',
  'device.get_system_setting',
  'device.launch_app',
  'device.list_installed_apps',
  'device.swipe_point',
  'device.tap_point',
  'expense.create_entry',
  'expense.query_entries',
  'expense.more_entries',
  'expense.propose_entries',
  'expense.propose_updates',
  'expense.propose_deletions',
  'expense.propose_refunds',
  'files.copy',
  'files.delete_external_file',
  'files.external_file_info',
  'files.file_info',
  'files.get_external_access_status',
  'files.import_external_file',
  'files.list_recent_imports',
  'files.move',
  'files.move_external_file',
  'files.open',
  'files.open_external_access_settings',
  'files.overwrite_external_file',
  'files.pick_document',
  'files.read_part',
  'files.read_text',
  'files.scan_external_files',
  'files.search_external_files',
  'files.search_text',
  'files.share',
  'files.unzip',
  'files.write_text',
  'files.zip',
  'github.comment_issue',
  'github.create_issue',
  'github.create_pull_request',
  'github.delete_file',
  'github.get_config_status',
  'github.get_file',
  'github.get_readme',
  'github.get_pull_request',
  'github.get_repository',
  'github.list_issue_comments',
  'github.list_issues',
  'github.list_pull_requests',
  'github.search_repositories',
  'github.update_file',
  'http.call_named_service',
  'http.manage_cookie_status',
  'http.request',
  'http.upload',
  'image.describe_local',
  'life.get_sleep_schedule',
  'reading.list',
  'reading.control',
  'reading.read_material',
  'schedule.save_own',
  'schedule.save_own_habits',
  'schedule.query_routine',
  'schedule.save_routine',
  'life.set_sleep_schedule',
  'image.generate',
  'location.get_current_position',
  'location.get_nearby_world_status',
  'map.geocode_place',
  'map.reverse_geocode',
  'map.search_destination',
  'map.search_nearby',
  'map.more_results',
  'mcp_admin.add_server',
  'mcp_admin.get_package_preview',
  'mcp_admin.list_servers',
  'mcp_admin.remove_server',
  'mcp_admin.sync_server',
  'media.open_camera',
  'media.pick_image',
  'media.take_screenshot',
  'memory.create',
  'memory.get',
  'memory.link',
  'memory.query_links',
  'memory.search',
  'memory.update',
  'memory.update_preference',
  'music.play',
  'music.control',
  'music.save_preference',
  'music.search_candidates',
  'music.test_connection',
  'nearby.describe_place_context',
  'nearby.verify_location_consistency',
  'phone_context.get_app_usage',
  'phone_context.get_notifications',
  'phone_context.get_permission_status',
  'phone_context.get_recent_activity',
  'phone_context.get_window_summary',
  'phone_context.summarize_recent_activity',
  'reminder.create',
  'reminder.query',
  'reminder.propose_reminders',
  'reminder.propose_updates',
  'reminder.propose_cancellations',
  'research.compare_sources',
  'research.fetch_page',
  'research.search',
  'research.search_academic',
  'research.search_doi',
  'research.search_images',
  'research.search_multi',
  'research.search_with_diagnostics',
  'research.verify_claim',
  'schedule.create_event',
  'schedule.complete_occurrence',
  'schedule.query_agenda',
  'schedule.submit_day_plan',
  'system_status.format_time',
  'system_status.get_battery',
  'system_status.get_device_info',
  'system_status.get_device_status',
  'system_status.get_time',
  'system.use_package',
  'todo.create',
  'todo.complete',
  'video.generate',
  'voice.transcribe',
  'weather.get_current',
  'weather.get_forecast',
  'workflow.create',
  'workflow.create_from_template',
  'workflow.disable',
  'workflow.enable',
  'workflow.get',
  'workflow.list',
  'workflow.list_templates',
  'workflow.trigger',
  'workflow.update',
  'wish.propose',
  'wish.view',
  'wish.pull',
  'wish.invite_discussion',
  ...GIFT_TOOL_IDS,
].map((toolId) => {
  return {
    toolId,
    mode: toolId === 'reminder.create' || toolId === 'alarm.create' ? 'shadow_only' as const : (
      CHAPTER_11_WEATHER_MAP_NEARBY_TOOL_IDS.has(toolId)
      || isTextFileChatTool(toolId)
      || isExpenseChatTool(toolId)
      || isReminderChatTool(toolId)
      || isWishToolId(toolId)
      || isGiftToolId(toolId)
      || isBodySignalHistoryTool(toolId)
      || toolId === 'system_status.get_battery'
      || toolId === 'memory.search'
      || toolId === 'research.search'
      || toolId === 'research.fetch_page'
      || toolId === 'browser.open'
      || toolId === 'device.launch_app'
      || toolId === 'communication.open_phone_dialer'
      || toolId === 'http.call_named_service'
      || toolId === 'memory.get'
      || toolId === 'memory.update'
      || toolId === 'music.play'
      || toolId === 'camera.look_once'
      || toolId === 'camera.read_observations'
      || toolId === 'image.describe_local'
      || toolId.startsWith('proactive_contact.')
      || toolId === 'phone_context.get_app_usage'
      || toolId === 'phone_context.get_recent_activity'
      || toolId.startsWith('phone_limit.')
      || toolId === 'location.get_current_position'
      || toolId === 'schedule.query_agenda'
      || toolId === 'life.get_sleep_schedule'
      || toolId === 'reading.list'
      || toolId === 'reading.control'
      || toolId === 'reading.read_material'
      || toolId === 'schedule.save_own'
      || toolId === 'schedule.save_own_habits'
      || toolId === 'schedule.query_routine'
      || toolId === 'schedule.save_routine'
      || toolId === 'life.set_sleep_schedule'
      || toolId === 'schedule.submit_day_plan'
      || toolId === 'schedule.create_event'
      || toolId === 'schedule.complete_occurrence'
      || toolId === 'todo.create'
      || toolId === 'todo.complete'
    )
      ? 'agent_primary' as const
      : 'legacy_only' as const,
    ...(toolId === 'memory.update'
      ? { confirmationPresenterId: MEMORY_CORRECTION_PRESENTER_ID }
      : toolId === 'schedule.create_event'
      ? { confirmationPresenterId: SCHEDULE_CREATE_EVENT_CONFIRMATION_PRESENTER_ID }
      : toolId === 'todo.create'
          ? { confirmationPresenterId: TODO_CREATE_CONFIRMATION_PRESENTER_ID }
            : {}),
    reconciliationMode: 'none' as const,
    ...(toolId.startsWith('phone_limit.') && toolId !== 'phone_limit.get_status'
      ? { sideEffectGatePolicyId: PHONE_LIMIT_SIDE_EFFECT_GATE_POLICY_ID } : {}),
    ...(TEXT_FILE_WRITE_TOOL_IDS.includes(toolId) ? { sideEffectGatePolicyId: TEXT_FILE_CHAT_SIDE_EFFECT_GATE_POLICY_ID } : {}),
    ...(toolId === 'browser.open' ? { sideEffectGatePolicyId: BROWSER_OPEN_SIDE_EFFECT_GATE_POLICY_ID } : {}),
    ...(toolId === 'device.launch_app' ? { sideEffectGatePolicyId: APP_LAUNCH_SIDE_EFFECT_GATE_POLICY_ID } : {}),
    ...(toolId === 'communication.open_phone_dialer' ? { sideEffectGatePolicyId: DIALER_SIDE_EFFECT_GATE_POLICY_ID } : {}),
    ...(MAP_QUERY_STATE_TOOL_IDS.has(toolId) ? { sideEffectGatePolicyId: MAP_QUERY_SIDE_EFFECT_GATE_POLICY_ID } : {}),
    ...(isWishToolId(toolId) && toolId !== 'wish.view' ? { sideEffectGatePolicyId: WISH_SIDE_EFFECT_GATE_POLICY_ID } : {}),
    ...(isGiftToolId(toolId) && toolId !== 'gift.view' ? { sideEffectGatePolicyId: GIFT_SIDE_EFFECT_GATE_POLICY_ID } : {}),
    ...(toolId === 'music.play' ? { sideEffectGatePolicyId: MUSIC_PLAYBACK_INTENT_SIDE_EFFECT_GATE_POLICY_ID } : {}),
    ...(toolId === 'camera.look_once' ? { sideEffectGatePolicyId: CAMERA_STANDBY_SIDE_EFFECT_GATE_POLICY_ID } : {}),
    ...(toolId === 'image.describe_local' ? { sideEffectGatePolicyId: CHAT_IMAGE_SIDE_EFFECT_GATE_POLICY_ID } : {}),
    ...(['schedule.complete_occurrence', 'todo.complete'].includes(toolId) ? { sideEffectGatePolicyId: CHAT_SCHEDULE_SIDE_EFFECT_GATE_POLICY_ID } : {}),
    ...(['proactive_contact.pause', 'proactive_contact.resume'].includes(toolId) ? { sideEffectGatePolicyId: CONTACT_CHAT_SIDE_EFFECT_GATE_POLICY_ID } : {}),
    ...(toolId === 'life.set_sleep_schedule' ? { sideEffectGatePolicyId: SLEEP_CHAT_WINDOW_SIDE_EFFECT_GATE_POLICY_ID } : {}),
    ...(toolId === 'reading.control' ? { sideEffectGatePolicyId: READING_ACTIVITY_SIDE_EFFECT_GATE_POLICY_ID } : {}),
    ...(['schedule.save_own', 'schedule.save_own_habits', 'schedule.save_routine'].includes(toolId) ? { sideEffectGatePolicyId: OWN_SCHEDULE_SIDE_EFFECT_GATE_POLICY_ID } : {}),
  };
});

const READINESS_BY_TOOL_ID = new Map(
  BUILTIN_TOOL_CHAT_AGENT_READINESS.map((entry) => [entry.toolId, entry]),
);

export function getEffectiveBuiltinToolChatAgentReadiness() {
  return BUILTIN_TOOL_CHAT_AGENT_READINESS;
}

export function getToolChatAgentReadiness(
  toolId: string,
  readiness: readonly JunLuoToolChatAgentReadiness[] = getEffectiveBuiltinToolChatAgentReadiness(),
) {
  return readiness === BUILTIN_TOOL_CHAT_AGENT_READINESS
    ? READINESS_BY_TOOL_ID.get(toolId)
    : readiness.find((entry) => entry.toolId === toolId);
}

export function isLegacyChatToolExecutionAllowed(
  toolId: string,
  readiness: readonly JunLuoToolChatAgentReadiness[] = getEffectiveBuiltinToolChatAgentReadiness(),
) {
  if (toolId === 'reminder.create' || toolId === 'alarm.create') return false;
  const entry = getToolChatAgentReadiness(toolId, readiness);
  return entry?.mode === 'legacy_only' || entry?.mode === 'shadow_only';
}

export function isNativeChatToolAgentEnabled(
  toolId: string,
  readiness: readonly JunLuoToolChatAgentReadiness[] = getEffectiveBuiltinToolChatAgentReadiness(),
) {
  return getToolChatAgentReadiness(toolId, readiness)?.mode === 'agent_primary';
}

export function shouldLegacyChatToolRouteYield(
  candidateToolIds: readonly string[],
  readiness: readonly JunLuoToolChatAgentReadiness[] = getEffectiveBuiltinToolChatAgentReadiness(),
) {
  return candidateToolIds.length > 0
    && candidateToolIds.every((toolId) => !isLegacyChatToolExecutionAllowed(toolId, readiness));
}

export function buildToolChatAgentAvailabilitySnapshot(
  base: JunLuoToolCandidateAvailabilitySnapshot,
  readiness: readonly JunLuoToolChatAgentReadiness[] = BUILTIN_TOOL_CHAT_AGENT_READINESS,
  includedModes: readonly JunLuoToolChatAgentMigrationMode[] = ['agent_primary'],
): JunLuoToolCandidateAvailabilitySnapshot {
  const nativeToolIds = new Set(
    readiness.filter((entry) => includedModes.includes(entry.mode)).map((entry) => entry.toolId),
  );
  registerBuiltinTools();
  const unavailableToolIds = new Set(base.unavailableToolIds);
  listToolPackages().forEach((toolPackage) => {
    toolPackage.tools.forEach((tool) => {
      if (!nativeToolIds.has(tool.id)) unavailableToolIds.add(tool.id);
    });
  });
  return {
    enabledPackageIds: [...base.enabledPackageIds],
    deniedToolIds: [...base.deniedToolIds],
    unavailableToolIds: [...unavailableToolIds],
  };
}

export async function createToolChatAgentProductionAvailabilitySnapshot() {
  registerBuiltinTools();
  const base = createDefaultToolCandidateAvailabilitySnapshot();
  const readiness = getEffectiveBuiltinToolChatAgentReadiness();
  const availability = buildToolChatAgentAvailabilitySnapshot(base, readiness);
  const deniedToolIds = new Set(availability.deniedToolIds);
  const unavailableToolIds = new Set(availability.unavailableToolIds);
  const packageSourceById = new Map(
    listToolPackages().map((toolPackage) => [toolPackage.id, toolPackage.source]),
  );
  // One candidate snapshot only; execution gates keep their default live reader.
  let permissionRaw: Promise<string | null> | undefined;
  const readSettings = () => permissionRaw ??= readToolPermissionSettingsRaw();
  for (const entry of readiness) {
    if (entry.mode !== 'agent_primary') continue;
    const tool = listTools().find((item) => item.id === entry.toolId);
    if (!tool || packageSourceById.get(tool.packageId) !== 'builtin' || typeof tool.executor !== 'function') {
      unavailableToolIds.add(entry.toolId);
      continue;
    }
    if (
      !tool.readOnly
      && (
        tool.agentEpochMode === undefined
        || tool.agentEpochMode === 'whole_execution_lease'
        || (
          !getToolAgentConfirmationPresenter(entry.confirmationPresenterId)
          && !isRegisteredToolAgentSideEffectGatePolicy(entry.sideEffectGatePolicyId)
        )
      )
    ) {
      unavailableToolIds.add(entry.toolId);
      continue;
    }
    const permission = await resolveToolPermissionForCall(tool, { input: {} }, readSettings);
    if (permission.permission === 'deny') deniedToolIds.add(entry.toolId);
  }
  return {
    enabledPackageIds: availability.enabledPackageIds,
    deniedToolIds: [...deniedToolIds],
    unavailableToolIds: [...unavailableToolIds],
  } satisfies JunLuoToolCandidateAvailabilitySnapshot;
}

export function validateBuiltinToolChatAgentReadiness() {
  registerBuiltinTools();
  const registeredBuiltinIds = listToolPackages()
    .filter((toolPackage) => toolPackage.source === 'builtin')
    .flatMap((toolPackage) => listTools(toolPackage.id).map((tool) => tool.id))
    .sort();
  const readinessIds = BUILTIN_TOOL_CHAT_AGENT_READINESS.map((entry) => entry.toolId).sort();
  const duplicateIds = readinessIds.filter((toolId, index) => readinessIds[index - 1] === toolId);
  const missingIds = registeredBuiltinIds.filter((toolId) => !READINESS_BY_TOOL_ID.has(toolId));
  const extraIds = readinessIds.filter((toolId) => !registeredBuiltinIds.includes(toolId));
  if (duplicateIds.length || missingIds.length || extraIds.length) {
    throw new Error(JSON.stringify({ duplicateIds, extraIds, missingIds }));
  }
  if (readinessIds.length !== 188) {
    throw new Error(`内置工具迁移登记数量必须为 188，当前为 ${readinessIds.length}`);
  }
  if (['reminder.query', 'reminder.propose_reminders', 'reminder.propose_updates', 'reminder.propose_cancellations']
    .some(id => READINESS_BY_TOOL_ID.get(id)?.mode !== 'agent_primary')
    || ['reminder.create', 'alarm.create'].some(id => READINESS_BY_TOOL_ID.get(id)?.mode !== 'shadow_only')) {
    throw new Error('提醒聊天入口登记不完整。');
  }
  const unknownSideEffectPolicies = BUILTIN_TOOL_CHAT_AGENT_READINESS
    .filter((entry) => (
      entry.sideEffectGatePolicyId
      && !isRegisteredToolAgentSideEffectGatePolicy(entry.sideEffectGatePolicyId)
    ))
    .map((entry) => entry.toolId);
  if (unknownSideEffectPolicies.length) {
    throw new Error(JSON.stringify({ unknownSideEffectPolicies }));
  }
  return true;
}
