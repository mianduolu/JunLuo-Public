import type { ExpenseDraft } from './expenseStore';

const EXPENSE_PATTERN = /(?:花了|花掉|用了|付了|买了|消费|支出)/;
const INCOME_PATTERN = /(?:收入|赚了|到账|报销|工资|薪水|奖金|副业|稿费|外包|兼职|红包|转账)/;
const MONEY_WITH_UNIT_PATTERN =
  /(?:￥|¥)\s*\d|(?:\d+(?:\.\d{1,2})?)\s*(?:元|块|块钱|人民币|rmb|RMB|k|K|千|万)|[一二两三四五六七八九十百千万]{1,9}(?:元|块|块钱|人民币)/;
const BARE_AMOUNT_AFTER_ACTION_PATTERN =
  /(?:花了|花掉|用了|付了|买了|消费|支出|收入|赚了|到账|报销|工资|薪水|奖金|副业|稿费|外包|兼职).{0,14}(?:\d+(?:\.\d{1,2})?|[一二两三四五六七八九十百千万]{1,9})(?:$|[，。,.！!？?\s]|买|购|入账|到账)/;

export const expenseCategories = ['饮食', '零食', '交通', '购物', '娱乐', '学习', '医疗', '养云', '生活用品', '缴费', '人情', '其他'];
export const incomeCategories = ['工资', '副业', '报销', '礼物', '其他收入'];
export const allExpenseCategories = [...expenseCategories, ...incomeCategories];

const categoryRules: Array<[string, RegExp]> = [
  ['养云', /api|API|模型|token|Token|deepseek|gemini|openai|claude|服务器|云云|白云|开发素材|素材|君落/],
  ['生活用品', /扫地机|拖把|纸巾|洗衣液|洗洁精|垃圾袋|收纳|被子|毯|枕头|牙刷|牙膏|日用品|生活用品|家电/],
  ['零食', /奶茶|咖啡|冰淇淋|巧克力|零食|饮料|甜品|蛋糕|薯片|糖|饼干/],
  ['饮食', /饭|餐|面|粉|水果|外卖|吃|早餐|午餐|晚餐|夜宵|烤肉|火锅/],
  ['交通', /车|地铁|公交|打车|滴滴|高铁|火车|机票|油费|停车/],
  ['购物', /买|衣服|鞋|包|化妆|护肤|快递|淘宝|京东|拼多多|小红书/],
  ['娱乐', /电影|游戏|会员|漫画|音乐|演出|门票|玩/],
  ['学习', /书|课程|文具|资料|考试|学习/],
  ['医疗', /药|医院|挂号|检查|牙|感冒|治疗/],
  ['工资', /工资|薪水|发薪/],
  ['副业', /副业|稿费|外包|兼职|接单/],
  ['报销', /报销/],
  ['礼物', /红包|礼金|转账/],
  ['其他收入', /收入|赚了|到账|奖金/],
];

const chineseDigitMap: Record<string, number> = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

export function looksLikeExpenseIntent(text: string): boolean {
  return (
    (EXPENSE_PATTERN.test(text) || INCOME_PATTERN.test(text)) &&
    (MONEY_WITH_UNIT_PATTERN.test(text) || BARE_AMOUNT_AFTER_ACTION_PATTERN.test(text))
  );
}

function parseChineseInteger(value: string): number | null {
  if (!value) return null;
  let total = 0;
  let section = 0;
  let number = 0;
  let lastLargeUnit = 1;

  for (const char of value) {
    if (char in chineseDigitMap) {
      number = chineseDigitMap[char];
      continue;
    }
    if (char === '十' || char === '百' || char === '千') {
      const unit = char === '十' ? 10 : char === '百' ? 100 : 1000;
      section += (number || 1) * unit;
      number = 0;
      lastLargeUnit = unit;
      continue;
    }
    if (char === '万') {
      total += (section + number) * 10000;
      section = 0;
      number = 0;
      lastLargeUnit = 10000;
    }
  }

  if (number && lastLargeUnit >= 100 && !/[十百]$/.test(value)) {
    section += number * (lastLargeUnit / 10);
  } else {
    section += number;
  }
  return total + section || null;
}

function parseAmount(text: string): number | null {
  const numericMatch = text.match(/(?:￥|¥)\s*(\d+(?:\.\d{1,2})?)|(\d+(?:\.\d{1,2})?)\s*(k|K|千|万|元|块|块钱|人民币|rmb|RMB)/);
  if (numericMatch) {
    const value = Number(numericMatch[1] ?? numericMatch[2]);
    const unit = numericMatch[3];
    if (unit === 'k' || unit === 'K' || unit === '千') return value * 1000;
    if (unit === '万') return value * 10000;
    return value;
  }

  const chineseMatch = text.match(/([一二两三四五六七八九十百千万]{1,9})(?:元|块|块钱|人民币)/);
  if (chineseMatch) return parseChineseInteger(chineseMatch[1]);

  const bareAmountMatch = text.match(BARE_AMOUNT_AFTER_ACTION_PATTERN);
  if (!bareAmountMatch) return null;
  const bareValues = Array.from(bareAmountMatch[0].matchAll(/\d+(?:\.\d{1,2})?|[一二两三四五六七八九十百千万]{1,9}/g));
  const bareValue = bareValues[bareValues.length - 1]?.[0];
  if (!bareValue) return null;
  if (/^\d/.test(bareValue)) return Number(bareValue);
  const chineseBare = bareValue.match(/[一二两三四五六七八九十百千万]{1,9}/)?.[0];
  if (!chineseBare) return null;
  return parseChineseInteger(chineseBare);
}

function findAmountText(text: string): string | null {
  const numericMatch = text.match(/(?:￥|¥)\s*\d+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?\s*(?:k|K|千|万|元|块|块钱|人民币|rmb|RMB)/);
  if (numericMatch) return numericMatch[0];

  const chineseMatch = text.match(/[一二两三四五六七八九十百千万]{1,9}(?:元|块钱|块|人民币)/);
  if (chineseMatch) return chineseMatch[0];

  const bareAmountMatch = text.match(BARE_AMOUNT_AFTER_ACTION_PATTERN);
  if (!bareAmountMatch) return null;
  const bareValues = Array.from(bareAmountMatch[0].matchAll(/\d+(?:\.\d{1,2})?|[一二两三四五六七八九十百千万]{1,9}/g));
  return bareValues[bareValues.length - 1]?.[0] ?? null;
}

function removeAmountText(text: string): string {
  const amountText = findAmountText(text);
  return amountText ? text.replace(amountText, '') : text;
}

function inferCategory(text: string, type: ExpenseDraft['type']): string {
  if (type === 'income') return categoryRules.find(([category, pattern]) => incomeCategories.includes(category) && pattern.test(text))?.[0] ?? '其他收入';
  return categoryRules.find(([, pattern]) => pattern.test(text))?.[0] ?? '其他';
}

function cleanNote(text: string, amount: number): string {
  return removeAmountText(text)
    .replace(/^(我|鼠|小仓鼠|仓鼠|本鼠)/, '')
    .replace(EXPENSE_PATTERN, '')
    .replace(INCOME_PATTERN, '')
    .replace(new RegExp(`${amount}(?:\\.0+)?\\s*(?:元|块)?`), '')
    .replace(/[，。,.！!？?]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 36);
}

export function parseExpenseDraftFromText(text: string): ExpenseDraft | null {
  if (!looksLikeExpenseIntent(text)) return null;
  const amount = parseAmount(text);
  if (!amount || !Number.isFinite(amount) || amount <= 0) return null;
  const type: ExpenseDraft['type'] = INCOME_PATTERN.test(text) && !EXPENSE_PATTERN.test(text) ? 'income' : 'expense';
  const category = inferCategory(text, type);
  const note = cleanNote(text, amount) || (type === 'income' ? '一笔收入' : '一笔支出');
  return {
    amount,
    category,
    note,
    occurredAt: Date.now(),
    source: 'chat',
    type,
  };
}
