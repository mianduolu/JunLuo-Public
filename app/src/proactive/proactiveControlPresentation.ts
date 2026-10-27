export type ProactiveControlTechnicalState = {
  contactDeviceId: string | null; used: number | null; day: string | null; waitReason: string;
  participants: Array<{ deviceId: string; platform: 'android' | 'windows'; fresh: boolean; sampleStatus: 'ready' | 'unknown' }>;
};
export function proactiveContactDeviceLabel(state: ProactiveControlTechnicalState | null) {
  if (state?.waitReason === 'phone-primary-ready') return '手机（独立运行）';
  if (state?.waitReason === 'phone-primary-handover-pending') return '手机（等待首次交接）';
  if (state?.waitReason === 'phone-primary-on-mobile') return '手机';
  const platform = state?.participants.find(p => p.deviceId === state.contactDeviceId)?.platform;
  return platform === 'android' ? '手机' : platform === 'windows' ? '电脑' : '等待确认';
}
export function proactiveContactSourceLabel(state: ProactiveControlTechnicalState | null) {
  if (state?.waitReason === 'phone-primary-ready') return '本机执行，无需两端操作信号';
  if (state?.waitReason === 'phone-primary-handover-pending') return '等待接回原主动次数与冷却记录';
  if (state?.waitReason === 'phone-primary-on-mobile') return '自动生活和主动由手机处理';
  return state?.participants.length ? state.participants.map(p => `${p.platform === 'android' ? '手机' : '电脑'}：${
    p.fresh && p.sampleStatus === 'ready' ? '已确认' : '待确认'}`).join('；') : '尚未取得两端操作信号';
}
export function proactiveContactWaitLabel(state: ProactiveControlTechnicalState | null) {
  const labels: Record<string, string> = { 'phone-primary-ready': '本机协调就绪',
    'phone-primary-handover-pending': '等待首次交接', 'phone-primary-on-mobile': '电脑保留手动功能与同步',
    ready: '共同协调就绪', 'proactive-control-unavailable': '等待兼容版本与共同账',
    'migration-required': '等待两端关闭后台并初始化共同账', 'participants-not-paired': '等待手机与电脑配对',
    'client-incompatible': '等待兼容版本', 'device-state-stale': '等待两端新鲜状态',
    'input-sample-unknown': '操作来源暂不可确认', 'input-order-unknown': '操作先后暂不可确认',
    'route-automatic-disabled': '最近使用端的后台模型已关闭' };
  return labels[state?.waitReason ?? 'proactive-control-unavailable'] ?? state?.waitReason ?? '等待共同协调';
}
