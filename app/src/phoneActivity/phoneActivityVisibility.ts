export type PhoneActivityVisibilityInput = {
  kind?: string | null;
  source?: string | null;
  title?: string | null;
};

const PHONE_USAGE_KINDS = new Set(['foreground_app', 'foreground_app_duration']);
const HIDDEN_TECHNICAL_KINDS = new Set([
  'body_signal_navigation_enter',
  'body_signal_navigation_exit',
]);

export function isVisiblePhoneUsageApp(source?: string | null, title?: string | null) {
  const normalizedSource = source?.trim().toLowerCase() ?? '';
  const normalizedTitle = title?.trim().toLowerCase() ?? '';
  if (
    normalizedSource === 'com.anonymous.junluo'
    || normalizedTitle === '君落'
    || normalizedTitle === 'junluo'
  ) {
    return false;
  }
  const hiddenPackage = /launcher|systemui|settings|packageinstaller|permissioncontroller|inputmethod|keyboard|android\.providers|com\.miui\.home|com\.miui\.aod|com\.huawei\.android\.launcher|com\.oppo\.launcher|com\.vivo\.launcher/.test(normalizedSource);
  const hiddenTitle = /系统桌面|桌面启动器|锁屏|设置|权限管理|输入法|键盘|系统界面|软件包安装程序/.test(normalizedTitle);
  return !hiddenPackage && !hiddenTitle;
}

export function isVisiblePhoneActivityLog(log: PhoneActivityVisibilityInput) {
  if (HIDDEN_TECHNICAL_KINDS.has(log.kind?.trim() ?? '')) return false;
  if (!PHONE_USAGE_KINDS.has(log.kind?.trim() ?? '')) return true;
  return isVisiblePhoneUsageApp(log.source, log.title);
}
