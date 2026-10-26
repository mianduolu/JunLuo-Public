export type PhoneContextIntentRoute = {
  candidateTools: string[];
  reason: string;
};

const PERMISSION_STATUS_PATTERN =
  /(?:本机小管家|手机小管家|使用情况权限|通知监听|无障碍|悬浮窗|手机活动权限).{0,18}(?:权限|状态|开(?:了|启)?|能不能|可用|有没有)/;
const APP_USAGE_PATTERN =
  /(?:刷(?:了)?多久|手机(?:用|看)(?:了)?多久|屏幕使用(?:时长)?|使用时长|App\s*使用|app\s*使用|应用使用|今天.{0,8}(?:刷|手机|屏幕|用).{0,8}多久|监督我.{0,8}手机使用)/i;
const NOTIFICATION_PATTERN =
  /(?:通知(?:有什么|摘要|记录|提醒|消息)|收到.{0,8}通知|最近.{0,8}通知|有(?:没有)?新通知)/;
const WINDOW_SUMMARY_PATTERN =
  /(?:当前|现在|刚才).{0,10}(?:窗口|页面).{0,12}(?:是什么|显示什么|有什么|摘要|内容)|(?:窗口摘要|页面摘要)/;
const RECENT_ACTIVITY_PATTERN =
  /(?:最近|刚才|这会儿).{0,12}(?:在看什么|看了什么|用什么\s*App|用了什么\s*App|手机活动|手机记录|前台\s*App)/i;
const ACTIVITY_SUMMARY_PATTERN =
  /(?:手机活动|手机情况|生活上下文|最近手机情况|最近手机状态|监督我手机|帮我看看手机使用)/;

export function routePhoneContextIntent(text: string): PhoneContextIntentRoute | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (PERMISSION_STATUS_PATTERN.test(trimmed)) {
    return {
      candidateTools: ['phone_context.get_permission_status'],
      reason: 'phone_context_permission_status',
    };
  }
  if (APP_USAGE_PATTERN.test(trimmed)) {
    return {
      candidateTools: ['phone_context.get_app_usage'],
      reason: 'phone_context_app_usage',
    };
  }
  if (NOTIFICATION_PATTERN.test(trimmed)) {
    return {
      candidateTools: ['phone_context.get_notifications'],
      reason: 'phone_context_notifications',
    };
  }
  if (WINDOW_SUMMARY_PATTERN.test(trimmed)) {
    return {
      candidateTools: ['phone_context.get_window_summary'],
      reason: 'phone_context_window_summary',
    };
  }
  if (RECENT_ACTIVITY_PATTERN.test(trimmed)) {
    return {
      candidateTools: ['phone_context.get_recent_activity'],
      reason: 'phone_context_recent_activity',
    };
  }
  if (ACTIVITY_SUMMARY_PATTERN.test(trimmed)) {
    return {
      candidateTools: ['phone_context.summarize_recent_activity'],
      reason: 'phone_context_activity_summary',
    };
  }
  return null;
}

function parseDaysFromText(text: string) {
  if (/一周|7\s*天|七天|最近一周|近一周/.test(text)) return 7;
  if (/三天|3\s*天/.test(text)) return 3;
  if (/昨天|前天|今天/.test(text)) return 1;
  return 1;
}

function parseMinutesFromText(text: string, fallback: number) {
  const hourMatch = text.match(/(\d{1,2})\s*(?:个)?小时/);
  if (hourMatch) return Math.max(5, Math.min(24 * 60, Number(hourMatch[1]) * 60));
  const minuteMatch = text.match(/(\d{1,4})\s*分钟/);
  if (minuteMatch) return Math.max(5, Math.min(24 * 60, Number(minuteMatch[1])));
  if (/今天/.test(text)) return 24 * 60;
  if (/最近|刚才|这会儿/.test(text)) return fallback;
  return fallback;
}

export function parsePhoneContextAppUsageInputFromText(text: string): Record<string, unknown> {
  return { days: parseDaysFromText(text) };
}

export function parsePhoneContextRecentActivityInputFromText(text: string): Record<string, unknown> {
  return {
    limit: 20,
    minutes: parseMinutesFromText(text, 60),
  };
}

export function parsePhoneContextNotificationsInputFromText(text: string): Record<string, unknown> {
  return {
    limit: 10,
    minutes: parseMinutesFromText(text, 24 * 60),
  };
}

export function parsePhoneContextSummaryInputFromText(text: string): Record<string, unknown> {
  return {
    minutes: parseMinutesFromText(text, 30),
  };
}

export function parsePhoneContextWindowSummaryInputFromText(_text: string): Record<string, unknown> {
  return {};
}
