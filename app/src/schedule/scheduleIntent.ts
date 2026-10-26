import { analyzeScheduleCompletionSemantics } from './scheduleSemanticCleaner';

export type ScheduleIntentKind = 'none' | 'ambiguous' | 'create' | 'cancel' | 'update' | 'complete';

const META_PATTERN = /(?:日程|待办|代办|提醒|四象限|目标|习惯|回顾).{0,12}(?:功能|系统|页面|界面|视图|模式|排版|识别|数据流|计划书|代码|debug|优化|改|修|做|实现)|(?:功能|系统|页面|界面|视图|模式|排版|识别|数据流|计划书|代码|debug|优化).{0,12}(?:日程|待办|代办|提醒|四象限|目标|习惯|回顾)/i;
const CANCEL_PATTERN = /(?:取消|删除|清除|清空|不用|别|撤掉|去掉|移除).{0,18}(?:提醒|日程|安排|待办|代办|清单)|(?:提醒|日程|安排|待办|代办|清单).{0,18}(?:取消|删除|清除|清空|撤掉|去掉|移除)/;
const UPDATE_PATTERN = /(?:修改|改成|改到|换到|提前|推迟|延期).{0,18}(?:提醒|日程|安排|待办|代办|清单)|(?:提醒|日程|安排|待办|代办|清单).{0,18}(?:修改|改成|改到|换到|提前|推迟|延期)/;
const NEGATIVE_CONTEXT_PATTERN = /(?:不(?:用|要|想)|别|无需).{0,8}(?:安排|排程|提醒|记待办)|(?:日程|待办|提醒).{0,15}(?:太挤|难用|卡|bug|出错|有问题|怎么改|怎么做)|(?:回来|稍后|等会|改天).{0,12}(?:再|才).{0,8}(?:做|处理|debug|修).{0,8}(?:日程|待办|功能|系统)?|(?:也|都|还|竟然|居然|就|怎么)(?:不|没)(?:提醒|叫|告诉)/i;
const THIRD_PARTY_REPORT_PATTERN = /(?:妈妈?|爸爸?|老板|朋友|同学|同事|医生)(?:说|告诉|提醒|要求|嘱咐|让|叫|给(?:我|鼠)安排|帮(?:我|鼠)安排)(?:了)?(?:我|鼠)?/;
const DIRECT_REQUEST_AFTER_BOUNDARY_PATTERN = /[，。；,;]\s*(?:请)?(?:提醒(?:我|鼠)|帮(?:我|鼠)安排|给(?:我|鼠)安排|记个?待办|新增待办|设个?提醒|定个?提醒)/;
const CREATE_PATTERN = /(?:提醒(?:我|鼠)?|叫(?:我|鼠)?|闹钟|定个提醒|设个提醒|到点提醒)|(?:帮(?:我|鼠)?|给(?:我|鼠)?).{0,12}(?:安排|排一下|排个|排日程|排程|排表|排布|计划|规划)|(?:记|新增|添加|创建|新建|加).{0,10}(?:日程|提醒|安排|待办|代办|清单)|(?:今日|今天|明天|后天|本周|这周|周[一二三四五六日天]|星期[一二三四五六日天])(?:的)?(?:待办|代办|清单|要做的事|想做的事)|(?:待办|代办|清单|要做的事|想做的事)\s*[:：]/;
const TODO_LIST_PATTERN = /(?:记|新增|添加|创建|新建|加).{0,8}(?:待办|代办|清单)|(?:今日|今天|明天|后天|本周|这周)(?:的)?(?:待办|代办|清单)|(?:待办|代办|清单)\s*[:：]/;
const AMBIGUOUS_PATTERN = /(?:今天|明天|后天|本周|这周|周[一二三四五六日天]|星期[一二三四五六日天]).{0,18}(?:要|想|可能|打算|准备|试试|看看|努力).{0,24}(?:做|写|学|看|复习|整理|处理|开发|买|吃|去|练|读|背|跑|运动)/;
const AUTOFILL_QUERY_PATTERN = /(?:今天|明天|后天|周[一二三四五六日天]|星期[一二三四五六日天]|20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}日?).{0,10}(?:怎么|如何).{0,8}(?:安排|排|规划)/;
const EXPLICIT_SCHEDULE_COMMAND_PATTERN = /(?:提醒(?:我|鼠)|叫(?:我|鼠)|帮(?:我|鼠)?安排|给(?:我|鼠)?安排|排(?:一下|个|日程|程|表|布)|记(?:个|一下)?待办|新增待办|设个?提醒|定个?提醒|待办\s*[:：]|清单\s*[:：]|日程\s*[:：])/;
const CASUAL_NON_SCHEDULE_PATTERN = /^(?:[啊呀唉诶额呃嗯呜]{1,4}[，,。!！~～…\s]*)?(?:好累|累死了?|好困|困死了?|不想动|动不了|崩溃了?|麻了|烦死了?|难受|饿了?|想哭|哭了?|救命|笑死|哈哈哈+|呜呜+|晚安|早安|谢谢|辛苦了|抱抱|贴贴|算了|先这样|不想了|没事|没有|不是|不用了|好吧|好的|嗯嗯|行吧)[。！？!~～…\s]*$/;
const CASUAL_CONTEXT_PATTERN = /(?:今天|明天|今晚|现在|刚刚|刚才)?.{0,8}(?:好累|累死|好困|困死|不想动|动不了|崩溃|难受|想哭|烦|麻了)|(?:明天|改天|之后|以后|回头).{0,6}再说/;

export function classifyScheduleIntent(text: string): ScheduleIntentKind {
  const normalized = text.trim();
  if (!normalized) return 'none';
  if (looksLikeCasualNonScheduleText(normalized)) return 'none';
  if (NEGATIVE_CONTEXT_PATTERN.test(normalized)) return 'none';
  if (THIRD_PARTY_REPORT_PATTERN.test(normalized) && !DIRECT_REQUEST_AFTER_BOUNDARY_PATTERN.test(normalized)) return 'none';
  if (looksLikeScheduleCompletionCommand(normalized)) return 'complete';
  if (analyzeScheduleCompletionSemantics(normalized).isLikelyProgressReport) return 'none';
  if (META_PATTERN.test(normalized)) return 'none';
  if (AUTOFILL_QUERY_PATTERN.test(normalized)) return 'create';
  if (TODO_LIST_PATTERN.test(normalized)) return 'create';
  if (CANCEL_PATTERN.test(normalized)) return 'cancel';
  if (UPDATE_PATTERN.test(normalized)) return 'update';
  if (CREATE_PATTERN.test(normalized)) return 'create';
  if (AMBIGUOUS_PATTERN.test(normalized)) return 'ambiguous';
  return 'none';
}

export function looksLikeCasualNonScheduleText(text: string) {
  const normalized = text.trim();
  if (!normalized) return false;
  if (EXPLICIT_SCHEDULE_COMMAND_PATTERN.test(normalized)) return false;
  return CASUAL_NON_SCHEDULE_PATTERN.test(normalized) || CASUAL_CONTEXT_PATTERN.test(normalized);
}

export function looksLikeScheduleCompletionCommand(text: string) {
  const normalized = text.trim();
  if (!normalized || normalized.length > 90) return false;
  return analyzeScheduleCompletionSemantics(normalized).isExplicitCompletionCommand;
}

export function isExplicitTodoListRequest(text: string) {
  return TODO_LIST_PATTERN.test(text.trim());
}

export function isSmartScheduleRequest(text: string) {
  const normalized = text.trim();
  if (META_PATTERN.test(normalized) || NEGATIVE_CONTEXT_PATTERN.test(normalized)) return false;
  return /(?:帮(?:我|鼠)?|给(?:我|鼠)?|请).{0,16}(?:安排|排一下|排个|排日程|排程|排表|排布|规划)|(?:一键|自动|智能).{0,8}(?:安排|排程|排表|排布)|(?:今天|明天|后天|周[一二三四五六日天]|星期[一二三四五六日天]).{0,8}(?:待办|清单|要做的事|想做的事).{0,4}[:：]/.test(normalized);
}

export function isAutoFillScheduleRequest(text: string) {
  const normalized = text.trim();
  if (!resolveScheduleDate(normalized)) return false;
  if (/(?:待办|清单)\s*[:：]|(?:有|包括|要做)(?:的是|这些)?\s*[:：]/.test(normalized)) return false;
  return /(?:怎么|如何).{0,8}(?:安排|排|规划)|(?:帮(?:我|鼠)?|给(?:我|鼠)?).{0,8}(?:安排|排一下|规划)(?:一下)?(?:今天|明天|后天|周|星期|\d)/.test(normalized);
}

function localDateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function resolveScheduleDate(text: string, now = new Date()): string | undefined {
  const normalized = text.trim();
  const explicit = normalized.match(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})日?/);
  if (explicit) {
    const year = Number(explicit[1]);
    const month = Number(explicit[2]);
    const day = Number(explicit[3]);
    const candidate = new Date(year, month - 1, day, 12);
    return Number.isFinite(candidate.getTime()) && candidate.getFullYear() === year && candidate.getMonth() === month - 1 && candidate.getDate() === day ? localDateKey(candidate) : undefined;
  }
  const monthDay = normalized.match(/(\d{1,2})月(\d{1,2})日?/);
  if (monthDay) {
    const month = Number(monthDay[1]);
    const day = Number(monthDay[2]);
    const candidate = new Date(now.getFullYear(), month - 1, day, 12);
    if (candidate.getMonth() !== month - 1 || candidate.getDate() !== day) return undefined;
    if (candidate.getTime() < new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) candidate.setFullYear(candidate.getFullYear() + 1);
    return Number.isFinite(candidate.getTime()) ? localDateKey(candidate) : undefined;
  }
  const offset = normalized.includes('后天') ? 2 : normalized.includes('明天') ? 1 : normalized.includes('今天') || normalized.includes('今日') ? 0 : undefined;
  if (offset !== undefined) return localDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, 12));
  if (/(?:现在|马上|待会|等会|稍后|一会儿|过一会儿|今天之内)/.test(normalized)) return localDateKey(now);
  const weekday = normalized.match(/(?:周|星期)([一二三四五六日天])/);
  if (weekday) {
    const target = '日一二三四五六'.indexOf(weekday[1] === '天' ? '日' : weekday[1]);
    let distance = (target - now.getDay() + 7) % 7;
    if (distance === 0 && !/(?:本周|这周)/.test(normalized)) distance = 7;
    return localDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + distance, 12));
  }
  return undefined;
}
