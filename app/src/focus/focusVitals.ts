export type FocusVitalEvent =
  | 'praised'
  | 'affection'
  | 'bug-frustration'
  | 'comforted'
  | 'focused-calm'
  | 'baiyun-working';

export type FocusVitals = {
  heartRate: number;
  temperature: number;
};

const BASE_VITALS: FocusVitals = {
  heartRate: 76,
  temperature: 36.2,
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function jitter(range: number) {
  return (Math.random() - 0.5) * range;
}

export function createInitialFocusVitals(): FocusVitals {
  return {
    heartRate: Math.round(BASE_VITALS.heartRate + jitter(6)),
    temperature: Math.round((BASE_VITALS.temperature + jitter(0.18)) * 10) / 10,
  };
}

export function updateFocusVitals(current: FocusVitals, event: FocusVitalEvent): FocusVitals {
  const effect: Record<FocusVitalEvent, FocusVitals> = {
    praised: { heartRate: 5, temperature: 0.1 },
    affection: { heartRate: 8, temperature: 0.2 },
    'bug-frustration': { heartRate: 10, temperature: 0.1 },
    comforted: { heartRate: -6, temperature: -0.1 },
    'focused-calm': { heartRate: -3, temperature: 0 },
    'baiyun-working': { heartRate: 2, temperature: 0 },
  };
  const delta = effect[event];

  return {
    heartRate: Math.round(clamp(current.heartRate + delta.heartRate + jitter(3), 68, 108)),
    temperature: Math.round(clamp(current.temperature + delta.temperature + jitter(0.08), 35.9, 37.2) * 10) / 10,
  };
}

export function coolFocusVitals(current: FocusVitals): FocusVitals {
  return {
    heartRate: Math.round(clamp(current.heartRate + (BASE_VITALS.heartRate - current.heartRate) * 0.22 + jitter(1.2), 68, 108)),
    temperature: Math.round(clamp(current.temperature + (BASE_VITALS.temperature - current.temperature) * 0.18 + jitter(0.04), 35.9, 37.2) * 10) / 10,
  };
}

export function detectFocusVitalEvent(message: string): FocusVitalEvent {
  const normalized = message.toLowerCase();
  if (/喜欢|爱你|可爱|亲亲|贴贴|老婆|宝宝/.test(message)) return 'affection';
  if (/夸|厉害|棒|好乖|好好|谢谢|辛苦/.test(message)) return 'praised';
  if (/bug|报错|崩|炸|坏了|无能狂怒|测试|出错|错误/.test(normalized) || /报错|崩溃|气死|急死/.test(message)) {
    return 'bug-frustration';
  }
  if (/没事|抱抱|摸摸|安慰|慢慢来|不急/.test(message)) return 'comforted';
  return 'focused-calm';
}
