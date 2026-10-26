export function routeSystemStatusIntent(text: string): { candidateTools: string[]; reason: string } | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  if (/(?:手机|设备|系统).{0,12}(?:信息|系统版本|版本|屏幕|尺寸|分辨率)|(?:屏幕尺寸|系统版本|设备信息)/.test(trimmed)) {
    return {
      candidateTools: ['system_status.get_device_info'],
      reason: 'system_status_device_info',
    };
  }

  if (/(?:设备|手机).{0,12}(?:状态|怎么样|情况)|(?:现在设备怎么样|手机状态怎么样)/.test(trimmed)) {
    return {
      candidateTools: ['system_status.get_device_status'],
      reason: 'system_status_device_status',
    };
  }

  if (/(?:手机)?(?:还有多少电|电量|电池|充电了吗|在充电吗|低电量模式|省电模式)/.test(trimmed)) {
    return {
      candidateTools: ['system_status.get_battery'],
      reason: 'system_status_battery',
    };
  }

  if (/(?:现在几点|几点了|当前时间|今天几号|今天星期几|星期几|今天日期|现在时间|现在是几点)/.test(trimmed)) {
    return {
      candidateTools: ['system_status.get_time'],
      reason: 'system_status_time',
    };
  }

  return null;
}
