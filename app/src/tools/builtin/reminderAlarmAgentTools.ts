import { createToolError } from '../toolErrors';
import { chatReminderTools, REMINDER_CATALOG_DESCRIPTION } from '../chatReminderTools';
import { createToolErrorResult, createToolSuccessResult } from '../toolResult';
import type { MusicSong } from '../../ai/subjectiveMessages';
import type { StrongAlarmRingtone } from '../../backend/strongAlarmNative';
import type { JunLuoToolCall, JunLuoToolDefinition, JunLuoToolPackage, JunLuoToolResult } from '../toolTypes';
import {
  isValidTimestamp,
  readBooleanInput,
  readOptionalStringInput,
  readStringInput,
  validationFailed,
} from './builtinToolValidation';

type ReminderCreateData = {
  companionEnabled: boolean;
  id: string;
  notificationSynced: boolean;
  reminderAt: number;
  title: string;
  triggerAt: number;
};

type AlarmRecordData = {
  id: string;
  message: string;
  musicFallbackToNotification?: boolean;
  musicKeyword?: string;
  musicPlayErrorMessage?: string;
  musicPlayResultSummary?: string;
  musicPlayStatus?: string;
  musicSong?: MusicSong;
  notificationId?: string;
  soundMode: string;
  status: string;
  strongAlarmBatteryOptimizationIgnored?: boolean;
  strongAlarmErrorMessage?: string;
  strongAlarmExactAlarmAllowed?: boolean;
  strongAlarmNativeId?: string;
  strongAlarmNotificationEnabled?: boolean;
  strongAlarmNotificationShown?: boolean;
  strongAlarmRingStatus?: string;
  strongAlarmRingtone?: string;
  strongAlarmTriggeredAt?: number;
  title: string;
  triggerAt: number;
  vibrate?: boolean;
};

type AlarmListData = {
  alarms: AlarmRecordData[];
  count: number;
};

type StrongAlarmStatusData = {
  available: boolean;
  batteryOptimizationIgnored?: boolean;
  canScheduleExactAlarms: boolean;
  notificationEnabled: boolean;
  platform: string;
  reason?: string;
};

function isFutureTimestamp(value: unknown): value is number {
  return isValidTimestamp(value) && value > Date.now() + 1000;
}

function readAlarmSoundMode(input: Record<string, unknown>) {
  return input.soundMode === 'music' ? 'music' : 'notification';
}

function readStrongAlarmRingtone(input: Record<string, unknown>): StrongAlarmRingtone {
  return 'default';
}

function readMusicSongInput(input: Record<string, unknown>, key: string): MusicSong | null {
  const value = input[key];
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.id !== 'string' || !candidate.id.trim()) return null;
  if (typeof candidate.name !== 'string' || !candidate.name.trim()) return null;
  return {
    album: typeof candidate.album === 'string' ? candidate.album : '',
    artist: typeof candidate.artist === 'string' ? candidate.artist : '',
    cover: typeof candidate.cover === 'string' ? candidate.cover : '',
    duration: typeof candidate.duration === 'number' && Number.isFinite(candidate.duration) ? candidate.duration : 0,
    id: candidate.id.trim(),
    name: candidate.name.trim(),
  };
}

async function executeReminderCreate(call: JunLuoToolCall): Promise<JunLuoToolResult<ReminderCreateData>> {
  const title = readStringInput(call.input, 'title');
  if (!title) return validationFailed(call, '缺少提醒标题', '没有创建提醒');

  const triggerAt = call.input.triggerAt;
  if (!isFutureTimestamp(triggerAt)) return validationFailed(call, '缺少有效的未来提醒时间', '没有创建提醒');

  const { requestNotificationPermission, syncScheduleNotifications } = await import('../../schedule/scheduleNotifications');
  const granted = await requestNotificationPermission();
  if (!granted) {
    return createToolErrorResult(
      call,
      createToolError('EXECUTION_FAILED', '通知权限不可用，不能创建会真正响起的提醒'),
      '没有创建提醒',
    );
  }

  const { createScheduleItem, deleteScheduleItem } = await import('../../schedule/scheduleStore');
  const companionEnabled = readBooleanInput(call.input, 'companionEnabled') ?? false;
  const item = await createScheduleItem({
    title,
    notes: readOptionalStringInput(call.input, 'notes') ?? '',
    startAt: triggerAt,
    reminderMinutesBefore: 0,
    recurrence: 'none',
    reminderText: readOptionalStringInput(call.input, 'reminderText') ?? title,
    reminderIntensity: 'gentle',
    source: 'ai',
    companionEnabled,
  });
  const notificationSynced = await syncScheduleNotifications();
  if (!notificationSynced) {
    await deleteScheduleItem(item.id).catch(() => undefined);
    return createToolErrorResult(
      call,
      createToolError('EXECUTION_FAILED', '提醒已回滚：通知同步没有成功'),
      '没有创建提醒',
    );
  }

  return createToolSuccessResult<ReminderCreateData>(call, `已创建提醒：${item.title}`, {
    companionEnabled,
    id: item.id,
    notificationSynced,
    reminderAt: triggerAt,
    title: item.title,
    triggerAt,
  });
}

async function executeAlarmCreate(call: JunLuoToolCall): Promise<JunLuoToolResult<AlarmRecordData>> {
  const title = readStringInput(call.input, 'title');
  if (!title) return validationFailed(call, '缺少闹钟标题', '没有创建闹钟');

  const triggerAt = call.input.triggerAt;
  if (!isFutureTimestamp(triggerAt)) return validationFailed(call, '缺少有效的未来闹钟时间', '没有创建闹钟');

  const soundMode = readAlarmSoundMode(call.input);
  const musicKeyword = readOptionalStringInput(call.input, 'musicKeyword');
  let musicSong = readMusicSongInput(call.input, 'musicSong') ?? undefined;
  if (soundMode === 'music' && !musicSong) {
    if (!musicKeyword) {
      return validationFailed(call, '音乐闹钟缺少歌曲或搜歌关键词', '没有创建音乐闹钟');
    }
    try {
      const { requestMusicCandidates } = await import('../../music/neteaseMusic');
      const candidates = await requestMusicCandidates(musicKeyword);
      musicSong = candidates.song;
    } catch (error) {
      return createToolErrorResult(
        call,
        createToolError('EXECUTION_FAILED', error instanceof Error ? error.message : String(error)),
        '没有创建音乐闹钟：没有解析到可播放歌曲',
      );
    }
  }

  const { createAlarmRecord } = await import('../../schedule/alarmStore');
  const alarm = await createAlarmRecord({
    title,
    message: readOptionalStringInput(call.input, 'message') ?? title,
    musicFallbackToNotification: readBooleanInput(call.input, 'musicFallbackToNotification') ?? true,
    musicKeyword,
    musicSong,
    soundMode,
    triggerAt,
  });
  const summary = soundMode === 'music'
    ? `已安排音乐闹钟播放计划：${alarm.title}，到点会尝试播放${musicSong ? `《${musicSong.name}》` : '音乐'}`
    : `已创建君落闹钟：${alarm.title}`;
  return createToolSuccessResult<AlarmRecordData>(call, summary, {
    id: alarm.id,
    message: alarm.message,
    musicFallbackToNotification: alarm.musicFallbackToNotification,
    musicKeyword: alarm.musicKeyword,
    musicPlayErrorMessage: alarm.musicPlayErrorMessage,
    musicPlayResultSummary: alarm.musicPlayResultSummary,
    musicPlayStatus: alarm.musicPlayStatus,
    musicSong: alarm.musicSong,
    notificationId: alarm.notificationId,
    soundMode: alarm.soundMode,
    status: alarm.status,
    title: alarm.title,
    triggerAt: alarm.triggerAt,
  });
}

async function executeAlarmList(call: JunLuoToolCall): Promise<JunLuoToolResult<AlarmListData>> {
  const includePast = readBooleanInput(call.input, 'includePast') ?? false;
  const { loadAlarmRecords } = await import('../../schedule/alarmStore');
  const alarms = await loadAlarmRecords({ includePast });
  const data = alarms.map((alarm) => ({
    id: alarm.id,
    message: alarm.message,
    musicFallbackToNotification: alarm.musicFallbackToNotification,
    musicKeyword: alarm.musicKeyword,
    musicPlayErrorMessage: alarm.musicPlayErrorMessage,
    musicPlayResultSummary: alarm.musicPlayResultSummary,
    musicPlayStatus: alarm.musicPlayStatus,
    musicSong: alarm.musicSong,
    notificationId: alarm.notificationId,
    soundMode: alarm.soundMode,
    status: alarm.status,
    strongAlarmBatteryOptimizationIgnored: alarm.strongAlarmBatteryOptimizationIgnored,
    strongAlarmErrorMessage: alarm.strongAlarmErrorMessage,
    strongAlarmExactAlarmAllowed: alarm.strongAlarmExactAlarmAllowed,
    strongAlarmNativeId: alarm.strongAlarmNativeId,
    strongAlarmNotificationEnabled: alarm.strongAlarmNotificationEnabled,
    strongAlarmNotificationShown: alarm.strongAlarmNotificationShown,
    strongAlarmRingStatus: alarm.strongAlarmRingStatus,
    strongAlarmRingtone: alarm.strongAlarmRingtone,
    strongAlarmTriggeredAt: alarm.strongAlarmTriggeredAt,
    title: alarm.title,
    triggerAt: alarm.triggerAt,
    vibrate: alarm.vibrate,
  }));
  return createToolSuccessResult<AlarmListData>(
    call,
    data.length ? `闹钟列表显示 ${data.length} 条记录` : '闹钟列表里没有待响起记录',
    { alarms: data, count: data.length },
  );
}

async function executeStrongAlarmStatus(call: JunLuoToolCall): Promise<JunLuoToolResult<StrongAlarmStatusData>> {
  const { getStrongAlarmNativeStatus } = await import('../../backend/strongAlarmNative');
  const status = await getStrongAlarmNativeStatus();
  if (!status.available) {
    return createToolErrorResult(
      call,
      createToolError('EXECUTION_FAILED', status.reason ?? 'Android 闹钟模块不可用', status),
      'Android 闹钟当前不可用',
    );
  }
  if (!status.canScheduleExactAlarms) {
    return createToolErrorResult(
      call,
      createToolError('PERMISSION_DENIED', '系统没有允许君落安排精确闹钟', status),
      'Android 闹钟精确闹钟权限不可用',
    );
  }
  return createToolSuccessResult(call, 'Android 闹钟能力可用', status);
}

async function executeStrongAlarmCreate(call: JunLuoToolCall): Promise<JunLuoToolResult<AlarmRecordData>> {
  const title = readStringInput(call.input, 'title');
  if (!title) return validationFailed(call, '缺少闹钟标题', '没有创建闹钟');

  const triggerAt = call.input.triggerAt;
  if (!isFutureTimestamp(triggerAt)) return validationFailed(call, '缺少有效的未来闹钟时间', '没有创建闹钟');

  const { getStrongAlarmNativeStatus, scheduleNativeStrongAlarm } = await import('../../backend/strongAlarmNative');
  const status = await getStrongAlarmNativeStatus();
  if (!status.available) {
    return createToolErrorResult(
      call,
      createToolError('EXECUTION_FAILED', status.reason ?? 'Android 闹钟模块不可用', status),
      '没有创建闹钟：当前安装包还没有原生闹钟能力',
    );
  }
  if (!status.canScheduleExactAlarms) {
    return createToolErrorResult(
      call,
      createToolError('PERMISSION_DENIED', '系统没有允许君落安排精确闹钟', status),
      '没有创建闹钟：缺少精确闹钟权限',
    );
  }

  const ringtone = readStrongAlarmRingtone(call.input);
  const message = readOptionalStringInput(call.input, 'message') ?? title;
  const vibrate = readBooleanInput(call.input, 'vibrate') ?? true;
  const native = await scheduleNativeStrongAlarm({ message, ringtone, title, triggerAt, vibrate });
  if (!native.nativeId) {
    return createToolErrorResult(
      call,
      createToolError('EXECUTION_FAILED', '原生闹钟没有返回有效 ID', native),
      '没有创建闹钟：原生调度失败',
    );
  }

  const { createStrongAlarmRecord } = await import('../../schedule/alarmStore');
  const alarm = await createStrongAlarmRecord({
    batteryOptimizationIgnored: native.batteryOptimizationIgnored,
    exactAlarmAllowed: native.exactAlarmAllowed,
    message,
    nativeId: native.nativeId,
    notificationEnabled: native.notificationEnabled,
    ringtone,
    title,
    triggerAt,
    vibrate,
  });
  return createToolSuccessResult<AlarmRecordData>(
    call,
    `已安排闹钟：${alarm.title}。这表示系统闹钟已尽量安排，不等于保证一定叫醒。`,
    {
      id: alarm.id,
      message: alarm.message,
      soundMode: alarm.soundMode,
      status: alarm.status,
      strongAlarmBatteryOptimizationIgnored: alarm.strongAlarmBatteryOptimizationIgnored,
      strongAlarmExactAlarmAllowed: alarm.strongAlarmExactAlarmAllowed,
      strongAlarmNativeId: alarm.strongAlarmNativeId,
      strongAlarmNotificationEnabled: alarm.strongAlarmNotificationEnabled,
      strongAlarmRingStatus: alarm.strongAlarmRingStatus,
      strongAlarmRingtone: alarm.strongAlarmRingtone,
      title: alarm.title,
      triggerAt: alarm.triggerAt,
      vibrate: alarm.vibrate,
    },
  );
}

async function executeStrongAlarmCancel(call: JunLuoToolCall): Promise<JunLuoToolResult<{ id: string }>> {
  const alarmId = readStringInput(call.input, 'alarmId');
  if (!alarmId) return validationFailed(call, '缺少要取消的闹钟 ID', '没有取消闹钟');

  const { cancelAlarmRecordOnce } = await import('../../schedule/alarmExecutionOnce');
  const cancelled = await cancelAlarmRecordOnce(alarmId);
  if (!cancelled) {
    return createToolErrorResult(
      call,
      createToolError('EXECUTION_FAILED', '没有找到可取消的待触发闹钟'),
      '没有取消闹钟',
    );
  }
  return createToolSuccessResult(call, '已取消这次闹钟', { id: alarmId });
}

export const reminderCreateTool: JunLuoToolDefinition<Record<string, unknown>, ReminderCreateData> = {
  id: 'reminder.create',
  chatExposure: 'internal_only',
  proactiveEligible: false,
  packageId: 'reminder',
  name: '创建提醒',
  description: '创建一条日程/提醒，到点由君落发出提醒；偏事情提醒。',
  inputSchema: {
    type: 'object',
    required: ['title', 'triggerAt'],
    properties: {
      title: { type: 'string', description: '提醒标题' },
      triggerAt: { type: 'number', description: '提醒触发时间，毫秒时间戳' },
      notes: { type: 'string', description: '提醒备注' },
      reminderText: { type: 'string', description: '通知文案' },
    },
  },
  permission: 'ask',
  riskLevel: 'write_local',
  readOnly: false,
  executor: executeReminderCreate,
};

export const alarmCreateTool: JunLuoToolDefinition<Record<string, unknown>, AlarmRecordData> = {
  id: 'alarm.create',
  chatExposure: 'internal_only',
  proactiveEligible: false,
  packageId: 'alarm',
  name: '创建君落闹钟',
  description: '创建君落自己的闹钟记录，然后用本地通知到点提醒；偏叫一下。',
  inputSchema: {
    type: 'object',
    required: ['title', 'triggerAt'],
    properties: {
      title: { type: 'string', description: '闹钟标题' },
      triggerAt: { type: 'number', description: '闹钟触发时间，毫秒时间戳' },
      message: { type: 'string', description: '闹钟通知正文' },
      soundMode: { type: 'string', enum: ['notification', 'music'], description: '闹钟声音模式：普通通知或音乐闹钟计划；音乐闹钟只代表到点尝试播放音乐' },
      musicKeyword: { type: 'string', description: '音乐闹钟搜歌关键词' },
      musicSong: {
        type: 'object',
        properties: {
          album: { type: 'string' },
          artist: { type: 'string' },
          cover: { type: 'string' },
          duration: { type: 'number' },
          id: { type: 'string' },
          name: { type: 'string' },
        },
        required: ['id', 'name'],
      },
      musicFallbackToNotification: { type: 'boolean', description: '音乐播放失败时是否保留普通本地通知兜底' },
    },
  },
  permission: 'ask',
  riskLevel: 'write_local',
  readOnly: false,
  executor: executeAlarmCreate,
};

export const alarmListTool: JunLuoToolDefinition<Record<string, unknown>, AlarmListData> = {
  id: 'alarm.list',
  chatExposure: 'explicit_only',
  proactiveEligible: false,
  packageId: 'alarm',
  name: '查看君落闹钟',
  description: '查看君落通知型闹钟记录。',
  inputSchema: {
    type: 'object',
    properties: {
      includePast: { type: 'boolean', description: '是否包含已触发或已取消记录' },
    },
  },
  permission: 'allow',
  riskLevel: 'read',
  readOnly: true,
  executor: executeAlarmList,
};

export const alarmStrongStatusTool: JunLuoToolDefinition<Record<string, unknown>, StrongAlarmStatusData> = {
  id: 'alarm.get_strong_alarm_status',
  chatExposure: 'explicit_only',
  proactiveEligible: false,
  packageId: 'alarm',
  name: '检查 Android 闹钟能力',
  description: '检查当前 Android 安装包是否具备 Android 闹钟模块、通知权限和精确闹钟能力。',
  inputSchema: { type: 'object' },
  permission: 'allow',
  riskLevel: 'read',
  readOnly: true,
  executor: executeStrongAlarmStatus,
};

export const alarmStrongCreateTool: JunLuoToolDefinition<Record<string, unknown>, AlarmRecordData> = {
  id: 'alarm.strong_create',
  chatExposure: 'explicit_only',
  proactiveEligible: false,
  packageId: 'alarm',
  name: '创建闹钟',
  description: '走 Android 原生闹钟能力和本地铃声/通知，适合更醒目的提醒、怕错过或怕睡过的场景。',
  inputSchema: {
    type: 'object',
    required: ['title', 'triggerAt'],
    properties: {
      title: { type: 'string', description: '闹钟标题' },
      triggerAt: { type: 'number', description: '闹钟触发时间，毫秒时间戳' },
      message: { type: 'string', description: '闹钟提示正文' },
      ringtone: { type: 'string', description: '兼容旧记录的铃声字段。当前 Android 闹钟兜底统一使用一段先轻后急的本地铃声。' },
      vibrate: { type: 'boolean', description: '是否震动' },
    },
  },
  permission: 'ask',
  riskLevel: 'write_local',
  readOnly: false,
  executor: executeStrongAlarmCreate,
};

export const alarmStrongCancelTool: JunLuoToolDefinition<Record<string, unknown>, { id: string }> = {
  id: 'alarm.strong_cancel',
  chatExposure: 'explicit_only',
  proactiveEligible: false,
  packageId: 'alarm',
  name: '取消闹钟',
  description: '取消一条尚未触发的 Android 闹钟。',
  inputSchema: {
    type: 'object',
    required: ['alarmId'],
    properties: {
      alarmId: { type: 'string', description: '要取消的闹钟 ID' },
    },
  },
  permission: 'ask',
  riskLevel: 'write_local',
  readOnly: false,
  executor: executeStrongAlarmCancel,
};

export const reminderToolPackage: JunLuoToolPackage = {
  id: 'reminder',
  name: '提醒与闹钟',
  description: REMINDER_CATALOG_DESCRIPTION,
  category: 'local_write',
  tools: [reminderCreateTool, ...chatReminderTools],
  defaultEnabled: true,
  riskLevel: 'write_local',
  source: 'builtin',
};

export const alarmToolPackage: JunLuoToolPackage = {
  id: 'alarm',
  name: '君落闹钟',
  description: '管理君落通知闹钟、君落音乐闹钟和 Android 闹钟。',
  category: 'local_write',
  tools: [alarmCreateTool, alarmListTool, alarmStrongStatusTool, alarmStrongCreateTool, alarmStrongCancelTool],
  defaultEnabled: true,
  riskLevel: 'write_local',
  source: 'builtin',
};
