import { locationSummary, type CurrentLocationData } from './locationResultSummary';
import type { JunLuoToolResult } from './toolTypes';

function withoutSegments(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const { segments, ...visible } = value as Record<string, unknown>;
  return visible;
}

// Only the model copy is reduced; execution, audit and UI retain the original receipt.
export function projectPhoneLocationResultForModel(result: JunLuoToolResult): JunLuoToolResult {
  if (!result.ok || !result.data || typeof result.data !== 'object' || Array.isArray(result.data)) return result;
  const data = result.data as Record<string, unknown>;
  if (result.toolId === 'location.get_current_position') {
    const { backgroundProfile, precisionStopReason, precisionLastActiveAt, ...visible } = data;
    if (typeof visible.latitude !== 'number' || typeof visible.longitude !== 'number') return result;
    return { ...result, data: visible, summary: locationSummary(visible as CurrentLocationData) };
  }
  if (result.toolId === 'phone_context.get_recent_activity' && Array.isArray(data.activities)) {
    return { ...result, data: { ...data, activities: data.activities.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
      const { id, sensitiveLevel, ...visible } = item;
      return visible;
    }) } };
  }
  if (result.toolId === 'phone_context.get_app_usage'
    && typeof data.segmentCount === 'number'
    && Array.isArray(data.days) && Array.isArray(data.todayTopApps) && Array.isArray(data.weekTopApps)) {
    const { segmentCount, ...visible } = data;
    const days = data.days.map(day => {
      if (!day || typeof day !== 'object' || Array.isArray(day)) return day;
      const { segments, ...fields } = day as Record<string, unknown>;
      return { ...fields, ...(Array.isArray(fields.topApps) ? { topApps: fields.topApps.map(withoutSegments) } : {}) };
    });
    // Equal totals across different dates still describe different periods.
    if (data.days.length === 1 && JSON.stringify(data.todayTopApps) === JSON.stringify(data.weekTopApps)) {
      delete visible.weekTopApps;
    } else visible.weekTopApps = data.weekTopApps.map(withoutSegments);
    return { ...result,
      summary: result.summary.replace(/^手机使用记录共有 \d+ 段，合计 /u, '手机使用记录合计 '),
      data: { ...visible, days, todayTopApps: data.todayTopApps.map(withoutSegments) },
    };
  }
  return result;
}
