const DEVICE_SNAPSHOT_PATTERN =
  /(?:看(?:一下|看)?|读取|读(?:一下)?|识别|总结|告诉我).{0,12}(?:当前|现在|手机|屏幕|页面|界面|窗口)|(?:当前|现在).{0,8}(?:手机|屏幕|页面|界面|窗口).{0,8}(?:是什么|有什么|在哪|内容)/;

export function looksLikeDeviceSnapshotRequest(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return DEVICE_SNAPSHOT_PATTERN.test(trimmed);
}

export function parseDeviceSnapshotInputFromText(text: string) {
  if (!looksLikeDeviceSnapshotRequest(text)) return null;
  const wantsMoreNodes = /详细|多一点|完整|全部|更多/.test(text);
  return { maxNodes: wantsMoreNodes ? 120 : 80 };
}

const DEVICE_INSTALLED_APPS_PATTERN = /(?:手机|设备)?.{0,8}(?:装了哪些|安装了哪些|已安装|应用列表|app 列表|APP 列表|有哪些 App|有哪些APP)|(?:查|看|列出).{0,10}(?:已安装应用|手机应用|App 列表|APP 列表)/i;
const DEVICE_SYSTEM_SETTING_PATTERN = /(?:系统设置|设置摘要|权限状态|无障碍权限|通知权限|使用情况权限|字体缩放|屏幕尺寸|显示设置)/;
const DEVICE_BLUETOOTH_STATUS_PATTERN = /(?:蓝牙).{0,8}(?:开了吗|开着吗|状态|权限|能用吗|可用吗)/;
const DEVICE_BLUETOOTH_SCAN_PATTERN = /(?:扫描|扫一下|搜一下|查一下|看看).{0,12}(?:蓝牙|BLE|附近设备|附近蓝牙)/i;
const DEVICE_COLMI_SCAN_PATTERN = /(?:扫描|扫一下|搜一下|查一下|看看).{0,12}(?:COLMI|R02|戒指|智能戒指|指环)/i;
const DEVICE_UNSUPPORTED_CONTROL_PATTERN = /(?:连接|配对|写入|发送).{0,8}(?:蓝牙|BLE|戒指|设备)|(?:修改|更改|调整).{0,8}(?:系统设置|亮度|字体|音量)|(?:安装|卸载|强停|停止).{0,8}(?:应用|App|APP)/i;

export type DeviceSystemBleIntentRoute = {
  candidateTools: string[];
  reason: string;
  unsupported?: boolean;
};

export function routeDeviceSystemBleIntent(text: string): DeviceSystemBleIntentRoute | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (DEVICE_UNSUPPORTED_CONTROL_PATTERN.test(trimmed)) {
    return {
      candidateTools: [],
      reason: 'device-control-unsupported',
      unsupported: true,
    };
  }
  if (DEVICE_COLMI_SCAN_PATTERN.test(trimmed)) {
    return { candidateTools: ['device.colmi_scan'], reason: 'device-colmi-scan' };
  }
  if (DEVICE_BLUETOOTH_SCAN_PATTERN.test(trimmed)) {
    return { candidateTools: ['device.bluetooth_scan'], reason: 'device-bluetooth-scan' };
  }
  if (DEVICE_BLUETOOTH_STATUS_PATTERN.test(trimmed)) {
    return { candidateTools: ['device.bluetooth_status'], reason: 'device-bluetooth-status' };
  }
  if (DEVICE_INSTALLED_APPS_PATTERN.test(trimmed)) {
    return { candidateTools: ['device.list_installed_apps'], reason: 'device-installed-apps' };
  }
  if (DEVICE_SYSTEM_SETTING_PATTERN.test(trimmed)) {
    return { candidateTools: ['device.get_system_setting'], reason: 'device-system-setting' };
  }
  return null;
}

export function parseDeviceSystemBleInputFromText(toolId: string, text: string) {
  const wantsLongerScan = /久一点|多扫|详细|多一点|完整|全部|更多/.test(text);
  if (toolId === 'device.bluetooth_scan' || toolId === 'device.colmi_scan') {
    return { durationMs: wantsLongerScan ? 8_000 : 4_000 };
  }
  if (toolId === 'device.list_installed_apps') {
    return { limit: /全部|完整|更多/.test(text) ? 300 : 120 };
  }
  if (toolId === 'device.get_system_setting') {
    if (/权限|无障碍|通知|使用情况/.test(text)) return { key: 'permissions' };
    if (/字体/.test(text)) return { key: 'font_scale' };
    if (/屏幕|显示|尺寸/.test(text)) return { key: 'display' };
    return { key: 'summary' };
  }
  return {};
}
