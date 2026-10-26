export type ScheduleCompanionResponse = 'done' | 'extend' | 'rest' | 'stuck' | 'tomorrow' | 'unknown';
export type ParsedScheduleCompanionResponse = { kind: ScheduleCompanionResponse; extendMinutes?: number };

export function parseScheduleCompanionResponse(text: string): ParsedScheduleCompanionResponse {
  const normalized = text.trim();
  if (/^(完成|做完|弄完|结束了|好了|搞定)[啦了啊呀!！。]*$/.test(normalized)) return { kind: 'done' };
  const extension = normalized.match(/(?:再给|再来|延长|继续)(?:我)?\s*(\d+|半|一刻钟)\s*(分钟|分|小时)?/);
  if (extension) {
    const raw = extension[1];
    const unit = extension[2];
    const amount = raw === '半' ? 0.5 : raw === '一刻钟' ? 15 : Number(raw);
    return { kind: 'extend', extendMinutes: unit === '小时' ? Math.round(amount * 60) : Math.round(amount) };
  }
  if (/明天|今天不做|推到明天|挪到明天/.test(normalized)) return { kind: 'tomorrow' };
  if (/卡住|不会|做不动|不知道怎么|没思路/.test(normalized)) return { kind: 'stuck' };
  if (/休息|歇一会|缓一缓|先停|不做了/.test(normalized)) return { kind: 'rest' };
  return { kind: 'unknown' };
}
