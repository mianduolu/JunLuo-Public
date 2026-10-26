import type { JunLuoToolDefinition } from './toolTypes';

export const PHONE_LIMIT_PACKAGE_ID = 'phone_limit';
export const PHONE_LIMIT_PACKAGE_NAME = '交出手机';
export const PHONE_LIMIT_PACKAGE_DESCRIPTION = 'I 可以看 you 用了哪些 App、用了多久，也能查看手机现在的锁定情况。在 you 已经允许的范围里，I 可以锁住手机或指定 App，也可以安排、修改锁定计划。you 来和 I 商量时，I 可以缩短剩余时间，暂时放行某个 App；遇到特殊情况，也可以结束这次锁定。I 会根据手机实际返回的结果，告诉 you 做到了什么。';

export type PhoneLimitToolId =
  | 'phone_limit.get_status'
  | 'phone_limit.start'
  | 'phone_limit.shorten'
  | 'phone_limit.end'
  | 'phone_limit.release_app'
  | 'phone_limit.set_plan';

type PhoneLimitToolMetadata = Pick<JunLuoToolDefinition, 'name' | 'description' | 'inputSchema'> & {
  id: PhoneLimitToolId;
  packageId: typeof PHONE_LIMIT_PACKAGE_ID;
};

// Exact approved metadata; the host must supply executors before registration.
export const PHONE_LIMIT_TOOL_METADATA: PhoneLimitToolMetadata[] = [
  {
    id: 'phone_limit.get_status', packageId: PHONE_LIMIT_PACKAGE_ID, name: '查看手机情况',
    description: 'I 可以查看 you 的手机用量、锁定、放行、应急解锁和可用锁定选项。',
    inputSchema: { type: 'object', required: [], additionalProperties: false, properties: {} },
  },
  {
    id: 'phone_limit.start', packageId: PHONE_LIMIT_PACKAGE_ID, name: '锁手机或 App',
    description: 'I 可以锁住整个手机，或锁住几个 App。锁多久由 I 填；不填就用默认时长。',
    inputSchema: {
      type: 'object', required: ['optionId'], additionalProperties: false,
      properties: {
        optionId: { type: 'string', description: '填写选项编号。' },
        packages: { type: 'array', nullable: true, description: '填选项中的 App 包名；锁整机留空。', items: { type: 'string' } },
        durationMinutes: { type: 'number', nullable: true, description: '1至选项上限的整数分钟；留空用默认。' },
      },
    },
  },
  {
    id: 'phone_limit.shorten', packageId: PHONE_LIMIT_PACKAGE_ID, name: '缩短这次锁定',
    description: 'I 可以缩短这次锁定的剩余时间。',
    inputSchema: {
      type: 'object', required: ['id', 'remainingMinutes'], additionalProperties: false,
      properties: {
        id: { type: 'string', description: '填写这次锁定的编号。' },
        remainingMinutes: { type: 'number', description: '从现在起还锁几分钟，填至少1的整数。' },
      },
    },
  },
  {
    id: 'phone_limit.end', packageId: PHONE_LIMIT_PACKAGE_ID, name: '结束这次锁定',
    description: 'I 可以结束这次锁定。',
    inputSchema: {
      type: 'object', required: ['id'], additionalProperties: false,
      properties: { id: { type: 'string', description: '填写这次锁定的编号。' } },
    },
  },
  {
    id: 'phone_limit.release_app', packageId: PHONE_LIMIT_PACKAGE_ID, name: '暂时放行一个 App',
    description: 'I 可以暂时放行一个 App。放行多久由 I 填；不填就用默认时长。',
    inputSchema: {
      type: 'object', required: ['packageName'], additionalProperties: false,
      properties: {
        packageName: { type: 'string', description: '填写要放行的 App 包名。' },
        durationMinutes: { type: 'number', nullable: true, description: '1至放行上限的整数分钟；留空用默认。' },
      },
    },
  },
  {
    id: 'phone_limit.set_plan', packageId: PHONE_LIMIT_PACKAGE_ID, name: '设定锁定计划',
    description: 'I 可以安排一次或每周重复的锁定，也可以调整计划的时间。',
    inputSchema: {
      type: 'object', required: ['times'], additionalProperties: false,
      properties: {
        optionId: { type: 'string', nullable: true, description: '新建填计划选项编号；修改留空。' },
        id: { type: 'string', nullable: true, description: '修改填可修改的计划编号；新建留空。' },
        packages: { type: 'array', nullable: true, description: '新建App计划填选项中的包名；锁整机或修改留空。', items: { type: 'string' } },
        date: { type: 'string', nullable: true, description: '只安排一次填YYYY-MM-DD；每周重复留空。' },
        weekdays: { type: 'array', nullable: true, description: '每周重复填1至7，表示周一至周日；只安排一次留空。', items: { type: 'number' } },
        times: { type: 'array', description: '填HH:mm起止时刻，每对一段；结束早于开始表示跨夜。', items: { type: 'array', items: { type: 'string' } } },
      },
    },
  },
];

export function isPhoneLimitToolId(value: string): value is PhoneLimitToolId {
  return PHONE_LIMIT_TOOL_METADATA.some(tool => tool.id === value);
}

export type PhoneLimitStartInput = { optionId: string; packages?: string[]; durationMinutes?: number };
export type PhoneLimitShortenInput = { id: string; remainingMinutes: number };
export type PhoneLimitEndInput = { id: string };
export type PhoneLimitReleaseAppInput = { packageName: string; durationMinutes?: number };
export type PhoneLimitSetPlanInput = {
  optionId?: string;
  id?: string;
  packages?: string[];
  date?: string;
  weekdays?: number[];
  times: [string, string][];
};
export type PhoneLimitToolInputs = {
  'phone_limit.get_status': Record<string, never>;
  'phone_limit.start': PhoneLimitStartInput;
  'phone_limit.shorten': PhoneLimitShortenInput;
  'phone_limit.end': PhoneLimitEndInput;
  'phone_limit.release_app': PhoneLimitReleaseAppInput;
  'phone_limit.set_plan': PhoneLimitSetPlanInput;
};
export type PhoneLimitInputParseResult<T extends PhoneLimitToolId = PhoneLimitToolId> =
  | { ok: true; input: PhoneLimitToolInputs[T] }
  | { ok: false };

function nonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function integerMinutes(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function packageList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(nonemptyString) && new Set(value).size === value.length;
}

function calendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

function weekdayList(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0
    && value.every(day => Number.isInteger(day) && day >= 1 && day <= 7)
    && new Set(value).size === value.length;
}

function timeWindows(value: unknown): value is [string, string][] {
  const clock = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
  return Array.isArray(value) && value.length > 0 && value.every(pair =>
    Array.isArray(pair) && pair.length === 2
    && pair.every(time => typeof time === 'string' && clock.test(time)) && pair[0] !== pair[1]);
}

// Validate syntax only. Saved options, bounds, time zone, and current ownership are host facts.
export function parsePhoneLimitToolInput<T extends PhoneLimitToolId>(
  toolId: T,
  raw: unknown,
): PhoneLimitInputParseResult<T> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false };
  const metadata = PHONE_LIMIT_TOOL_METADATA.find(tool => tool.id === toolId);
  if (!metadata) return { ok: false };
  const properties = metadata.inputSchema.properties ?? {};
  if (Object.keys(raw).some(key => !Object.hasOwn(properties, key))) return { ok: false };
  const required = metadata.inputSchema.required ?? [];
  const input = Object.fromEntries(Object.entries(raw).filter(([key, value]) =>
    value !== undefined && !(value === null && properties[key]?.nullable && !required.includes(key))));
  if (required.some(key => !Object.hasOwn(input, key))) return { ok: false };

  let valid = false;
  switch (toolId) {
    case 'phone_limit.get_status':
      valid = true;
      break;
    case 'phone_limit.start':
      valid = nonemptyString(input.optionId)
        && (input.packages === undefined || packageList(input.packages))
        && (input.durationMinutes === undefined || integerMinutes(input.durationMinutes));
      break;
    case 'phone_limit.shorten':
      valid = nonemptyString(input.id) && integerMinutes(input.remainingMinutes);
      break;
    case 'phone_limit.end':
      valid = nonemptyString(input.id);
      break;
    case 'phone_limit.release_app':
      valid = nonemptyString(input.packageName)
        && (input.durationMinutes === undefined || integerMinutes(input.durationMinutes));
      break;
    case 'phone_limit.set_plan':
      valid = (input.optionId === undefined || nonemptyString(input.optionId))
        && (input.id === undefined || nonemptyString(input.id))
        && ((input.optionId !== undefined) !== (input.id !== undefined))
        && (input.packages === undefined || (input.id === undefined && packageList(input.packages)))
        && (input.date === undefined || calendarDate(input.date))
        && (input.weekdays === undefined || weekdayList(input.weekdays))
        && ((input.date !== undefined) !== (input.weekdays !== undefined))
        && timeWindows(input.times);
      break;
  }
  return valid ? { ok: true, input: input as PhoneLimitToolInputs[T] } : { ok: false };
}
