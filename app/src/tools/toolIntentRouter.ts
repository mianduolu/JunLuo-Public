import { routeBrowserIntent } from './browserInputParsers';
import { routeBodySignalIntent } from './bodySignalInputParsers';
import { routeCommunicationIntent } from './communicationInputParsers';
import { classifyScheduleIntent, isExplicitTodoListRequest, looksLikeSpecificScheduleRequest } from '../schedule/schedulePlanner';
import { routeCredentialAccountIntent } from './credentialAccountIntent';
import { looksLikeDeviceSnapshotRequest, routeDeviceSystemBleIntent } from './deviceInputParsers';
import { routeFileIntent } from './fileInputParsers';
import { routeGithubIntent } from './githubInputParsers';
import { routeHttpIntent } from './httpInputParsers';
import { routeMemoryIntent } from './memoryInputParsers';
import { routeMediaImageIntent } from './mediaImageInputParsers';
import { looksLikeLocationRequest, looksLikeNearbyWorldStatusRequest } from './locationInputParsers';
import { routePhoneContextIntent } from './phoneContextInputParsers';
import { routeReminderAlarmIntent } from './reminderAlarmInputParsers';
import { routeResearchIntent } from './researchIntent';
import { routeSystemStatusIntent } from './systemStatusInputParsers';
import { classifyToolRouteUtterance } from './toolRouteSemanticGuards';
import { routeWeatherMapNearbyIntent } from './weatherMapNearbyInputParsers';
import { routeWorkflowIntent } from './workflowInputParsers';

export type JunLuoToolIntentRoute = {
  shouldUseTool: boolean;
  candidateTools: string[];
  reason: string;
  requiresConfirmation: boolean;
  unsupported?: boolean;
};

const CODE_TERMINAL_UNSUPPORTED_PATTERN =
  /跑(?:一段)?(?:代码|JS|JavaScript|Python|python|js)|运行(?:代码|脚本|JS|JavaScript|Python|python|js)|执行(?:代码|脚本|命令|Python|python|JS|JavaScript|js)|命令行|终端|shell|Shell|Shizuku|shizuku/;

const SEND_OR_PUBLISH_UNSUPPORTED_PATTERN =
  /(?:发送|发出去|发给|发布|发小红书|发微博|发朋友圈|发帖)/;

const SOCIAL_AUTOMATION_UNSUPPORTED_PATTERN =
  /(?:小红书|微博|朋友圈|社交账号|帖子|笔记|动态|视频).{0,16}(?:点赞|评论|收藏|转发|发布|发帖|浏览|自动)|(?:点赞|评论|收藏|转发).{0,16}(?:小红书|微博|朋友圈|帖子|笔记|动态|视频)/;

const OPEN_OR_LAUNCH_UNSUPPORTED_PATTERN =
  /(?:打开|启动).{0,12}(?:小红书|微信|QQ|星野|微博|网易云|音乐|浏览器|网页|链接|URL|App|app|应用|设置|文件|文档|相册|短信|拨号|通知栏|蓝牙|戒指)/i;

const DEVICE_CONTROL_UNSUPPORTED_PATTERN =
  /(?:点击|点一下|滑动|滑一下|划一下).{0,14}(?:屏幕|按钮|广告|页面|网页|窗口|手机|坐标|这里|那里|这个|那个|登录|跳过)|(?:输入).{0,14}(?:文本|文字|账号|密码|输入框|文本框|页面|网页|窗口|手机)|(?:按返回|返回键|返回上一页|返回上一级|帮我返回|替我返回)/;

const MUSIC_UNSUPPORTED_PATTERN =
  /(?:播放|点歌|放歌).{0,14}(?:音乐|歌曲|歌|网易云|声音)|(?:播放音乐|点首歌|放首歌)/;

function looksLikeUnsupportedToolIntent(text: string) {
  return (
    CODE_TERMINAL_UNSUPPORTED_PATTERN.test(text) ||
    SEND_OR_PUBLISH_UNSUPPORTED_PATTERN.test(text) ||
    SOCIAL_AUTOMATION_UNSUPPORTED_PATTERN.test(text) ||
    OPEN_OR_LAUNCH_UNSUPPORTED_PATTERN.test(text) ||
    DEVICE_CONTROL_UNSUPPORTED_PATTERN.test(text) ||
    MUSIC_UNSUPPORTED_PATTERN.test(text)
  );
}

const HYPOTHETICAL_TOOL_DISCUSSION_PATTERN =
  /(?:假设|如果|要是|以后|未来|将来|之后).{0,20}(?:可以|能|接入|支持|做|实现|开发|加上|拥有|使用).{0,20}(?:工具|能力|生图|画图|生成图片|点歌|放歌|播放|打开|操作|搜索|查询|MCP|插件)/i;

export function routeChatToolIntent(text: string): JunLuoToolIntentRoute {
  const trimmed = text.trim();
  if (!trimmed) {
    return { shouldUseTool: false, candidateTools: [], reason: 'empty', requiresConfirmation: false };
  }

  if (HYPOTHETICAL_TOOL_DISCUSSION_PATTERN.test(trimmed)) {
    return { shouldUseTool: false, candidateTools: [], reason: 'hypothetical_tool_discussion', requiresConfirmation: false };
  }

  const semanticGuard = classifyToolRouteUtterance(trimmed);
  const protectBroadToolRouting = semanticGuard.shouldProtectFromToolRouting;

  const credentialAccountIntent = routeCredentialAccountIntent(trimmed);
  if (credentialAccountIntent) {
    return {
      shouldUseTool: !credentialAccountIntent.unsupported,
      candidateTools: credentialAccountIntent.candidateTools,
      reason: credentialAccountIntent.reason,
      requiresConfirmation: false,
      unsupported: credentialAccountIntent.unsupported,
    };
  }

  const githubIntent = routeGithubIntent(trimmed);
  if (githubIntent) {
    return {
      shouldUseTool: !githubIntent.unsupported,
      candidateTools: githubIntent.candidateTools,
      reason: githubIntent.reason,
      requiresConfirmation: githubIntent.candidateTools.some((toolId) => toolId !== 'github.get_config_status'),
      unsupported: githubIntent.unsupported,
    };
  }

  const httpIntent = routeHttpIntent(trimmed);
  if (httpIntent) {
    return {
      shouldUseTool: !httpIntent.unsupported,
      candidateTools: httpIntent.candidateTools,
      reason: httpIntent.reason,
      requiresConfirmation: httpIntent.candidateTools.includes('http.call_named_service'),
      unsupported: httpIntent.unsupported,
    };
  }

  const bodySignalIntent = routeBodySignalIntent(trimmed);
  if (bodySignalIntent) {
    return {
      shouldUseTool: true,
      candidateTools: bodySignalIntent.candidateTools,
      reason: bodySignalIntent.reason,
      requiresConfirmation: false,
    };
  }

  const systemStatusIntent = routeSystemStatusIntent(trimmed);
  if (systemStatusIntent) {
    return {
      shouldUseTool: true,
      candidateTools: systemStatusIntent.candidateTools,
      reason: systemStatusIntent.reason,
      requiresConfirmation: false,
    };
  }

  const deviceSystemBleIntent = routeDeviceSystemBleIntent(trimmed);
  if (deviceSystemBleIntent) {
    return {
      shouldUseTool: !deviceSystemBleIntent.unsupported,
      candidateTools: deviceSystemBleIntent.candidateTools,
      reason: deviceSystemBleIntent.reason,
      requiresConfirmation: deviceSystemBleIntent.candidateTools.some((toolId) => ['device.bluetooth_scan', 'device.colmi_scan'].includes(toolId)),
      unsupported: deviceSystemBleIntent.unsupported,
    };
  }

  const workflowIntent = routeWorkflowIntent(trimmed);
  if (workflowIntent) {
    return {
      shouldUseTool: !workflowIntent.unsupported,
      candidateTools: workflowIntent.candidateTools,
      reason: workflowIntent.reason,
      requiresConfirmation: workflowIntent.candidateTools.some((toolId) => ['workflow.create_from_template', 'workflow.create', 'workflow.update', 'workflow.enable', 'workflow.disable', 'workflow.trigger'].includes(toolId)),
      unsupported: workflowIntent.unsupported,
    };
  }


  const weatherMapNearbyIntent = protectBroadToolRouting ? null : routeWeatherMapNearbyIntent(trimmed);
  if (weatherMapNearbyIntent) {
    return {
      shouldUseTool: true,
      candidateTools: weatherMapNearbyIntent.candidateTools,
      reason: weatherMapNearbyIntent.reason,
      requiresConfirmation: false,
    };
  }

  const phoneContextIntent = routePhoneContextIntent(trimmed);
  if (phoneContextIntent) {
    return {
      shouldUseTool: true,
      candidateTools: phoneContextIntent.candidateTools,
      reason: phoneContextIntent.reason,
      requiresConfirmation: false,
    };
  }

  const memoryIntent = routeMemoryIntent(trimmed);
  if (memoryIntent) {
    return {
      shouldUseTool: memoryIntent.candidateTools.length > 0,
      candidateTools: memoryIntent.candidateTools,
      reason: memoryIntent.reason,
      requiresConfirmation: memoryIntent.candidateTools.some((toolId) => ['memory.update', 'memory.link', 'memory.update_preference'].includes(toolId)),
      unsupported: memoryIntent.reason === 'memory_delete_unsupported',
    };
  }

  const mediaImageIntent = routeMediaImageIntent(trimmed);
  if (mediaImageIntent) {
    return {
      shouldUseTool: true,
      candidateTools: mediaImageIntent.candidateTools,
      reason: mediaImageIntent.reason,
      requiresConfirmation: true,
    };
  }
  const fileIntent = routeFileIntent(trimmed);
  if (fileIntent) {
    return {
      shouldUseTool: true,
      candidateTools: fileIntent.candidateTools,
      reason: fileIntent.reason,
      requiresConfirmation: false,
    };
  }

  if (protectBroadToolRouting) {
    return { shouldUseTool: false, candidateTools: [], reason: 'semantic_guard_' + semanticGuard.kind, requiresConfirmation: false };
  }

  const communicationIntent = routeCommunicationIntent(trimmed);
  if (communicationIntent) {
    return {
      shouldUseTool: !communicationIntent.unsupported,
      candidateTools: communicationIntent.candidateTools,
      reason: communicationIntent.reason,
      requiresConfirmation: communicationIntent.candidateTools.some((toolId) => toolId.startsWith('communication.')),
      unsupported: communicationIntent.unsupported,
    };
  }

  const reminderAlarmIntent = routeReminderAlarmIntent(trimmed);
  if (reminderAlarmIntent) {
    return {
      shouldUseTool: true,
      candidateTools: reminderAlarmIntent.candidateTools,
      reason: reminderAlarmIntent.reason,
      requiresConfirmation: reminderAlarmIntent.candidateTools.some((toolId) => toolId !== 'alarm.list'),
    };
  }

  if (looksLikeDeviceSnapshotRequest(trimmed)) {
    return {
      shouldUseTool: true,
      candidateTools: ['device.get_accessibility_snapshot'],
      reason: 'device_snapshot',
      requiresConfirmation: true,
    };
  }

  if (looksLikeNearbyWorldStatusRequest(trimmed)) {
    return {
      shouldUseTool: true,
      candidateTools: ['location.get_nearby_world_status'],
      reason: 'nearby_world_location_status',
      requiresConfirmation: true,
    };
  }

  if (looksLikeLocationRequest(trimmed)) {
    return {
      shouldUseTool: true,
      candidateTools: ['location.get_current_position'],
      reason: 'current_location',
      requiresConfirmation: true,
    };
  }

  const browserIntent = protectBroadToolRouting ? null : routeBrowserIntent(trimmed);
  if (browserIntent) {
    return {
      shouldUseTool: !browserIntent.unsupported,
      candidateTools: browserIntent.candidateTools,
      reason: browserIntent.reason,
      requiresConfirmation: browserIntent.candidateTools.some((toolId) => toolId !== 'browser.list_tabs'),
      unsupported: browserIntent.unsupported,
    };
  }

  const researchIntent = protectBroadToolRouting ? null : routeResearchIntent(trimmed);
  if (researchIntent) {
    return {
      shouldUseTool: true,
      candidateTools: researchIntent.candidateTools,
      reason: researchIntent.reason,
      requiresConfirmation: true,
    };
  }

  const scheduleIntent = classifyScheduleIntent(trimmed);
  if (scheduleIntent === 'create') {
    if (isExplicitTodoListRequest(trimmed) && !looksLikeSpecificScheduleRequest(trimmed)) {
      return {
        shouldUseTool: true,
        candidateTools: ['todo.create'],
        reason: 'explicit_todo_list',
        requiresConfirmation: true,
      };
    }
    return {
      shouldUseTool: true,
      candidateTools: ['schedule.create_event', 'todo.create'],
      reason: 'schedule_create_requires_existing_parser',
      requiresConfirmation: true,
    };
  }

  if (!protectBroadToolRouting && looksLikeUnsupportedToolIntent(trimmed)) {
    return {
      shouldUseTool: false,
      candidateTools: [],
      reason: 'unsupported_tool_not_registered',
      requiresConfirmation: false,
      unsupported: true,
    };
  }

  return { shouldUseTool: false, candidateTools: [], reason: 'chat', requiresConfirmation: false };
}






