import type { JunLuoToolResult } from './toolTypes';

const NUMBER = '[0-9]+(?:\\.[0-9]+)?|[零〇一二两三四五六七八九十百]+';
const DURATION = `(?:${NUMBER})\\s*(?:小时|分钟|秒钟?|分)(?:(?:${NUMBER})\\s*(?:分钟|秒钟?|分))?`;
const CLAIM = new RegExp(`(每次|一次|单次|单轮|连续(?:使用)?|每天|每日|一天)\\s*(?:的)?\\s*(?:(?:上限|最多|至多|限时|限制|不超过|能用|可以用|是|为|：|:)\\s*)*(${DURATION})`, 'g');
const NON_FACT = /如果|要不要|不如|下次|以后|打算|建议|想(?:把|给|将|让)|(?:你|鼠|我)(?:刚才|之前|以前)?(?:说|问|要求)|(?:你|鼠)(?:刚才|之前)?的(?:要求|提议)|我的想法|还(?:没|没有)改|好不好|行不行|可不可以|怎么样|[？?]/;

// Match only an entire checking prelude, never a quote, proposal or factual answer.
const DEFERRED_REPLY = /^(?:(?:我先|我来|让我|我|先|现在|这就)\s*)?(?:查查|查一下|看看|看一下|查看一下)\s*(?:(?:现在|目前)?(?:设好|设置好)的)?(?:手机情况|手机限制|时长限制|使用情况|限制)?\s*(?:给(?:你|鼠|小仓鼠)看|再告诉(?:你|鼠|小仓鼠))?[\s，。！!…—\-☁️～~]*$/;

export function hasPhoneLimitDeferredReply(text: string, results: readonly JunLuoToolResult[]): boolean {
  const latest = [...results].reverse().find(result => result.toolId === 'phone_limit.get_status');
  if (!latest?.ok || latest.status !== 'success') return false;
  const visible = text.trim().replace(/^消息序号\s*\d+\s*[｜|]\s*发送时间\s*\d{4}-\d{2}-\d{2}\s*\d{2}:\d{2}\s*\n/, '');
  return DEFERRED_REPLY.test(visible);
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function number(value: string): number {
  if (/^[0-9.]+$/.test(value)) return Number(value);
  const digits = '零一二三四五六七八九';
  let total = 0, digit = 0;
  for (const char of value.replace(/两/g, '二').replace(/〇/g, '零')) {
    if (char === '十' || char === '百') { total += (digit || 1) * (char === '十' ? 10 : 100); digit = 0; }
    else digit = digits.indexOf(char);
  }
  return total + digit;
}

function seconds(value: unknown): number | null {
  if (typeof value !== 'string' || !new RegExp(`^${DURATION}$`).test(value.replace(/\s/g, ''))) return null;
  const units = new RegExp(`(${NUMBER})\\s*(小时|分钟|秒钟?|分)`, 'g');
  return [...value.matchAll(units)].reduce((sum, part) => sum + number(part[1]) * (part[2] === '小时' ? 3600 : part[2] === '分钟' || part[2] === '分' ? 60 : 1), 0);
}

// A narrow check of explicit saved limits. Unknown names/data, quoted requests
// and proposals remain outside it; reuse the existing review and request budget.
export function hasPhoneLimitReplyMismatch(text: string, results: readonly JunLuoToolResult[]): boolean {
  const latest = [...results].reverse().find(result => result.toolId === 'phone_limit.get_status');
  if (!latest?.ok || latest.status !== 'success') return false;
  const data = object(latest.data);
  const limits = object(object(data?.appLimits)?.apps);
  const usage = object(object(data?.usage)?.apps);
  if (!limits || !usage) return false;
  const apps = Object.entries(limits).flatMap(([id, value]) => {
    const label = typeof usage[id] === 'string' ? (usage[id] as string).match(/^([^：:]+)[：:][^：:]*$/)?.[1] : null;
    const limit = object(value);
    if (!label || !limit) return [];
    const cap = (key: string) => Array.isArray(limit[key]) ? seconds((limit[key] as unknown[])[1]) : null;
    return [{ label, session: cap('session'), daily: cap('daily') }];
  });
  const unique = apps.filter(app => apps.filter(other => other.label === app.label).length === 1);
  const named = (prefix: string) => unique.filter(app => {
    const escaped = app.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Do not read “微信” inside “企业微信”, or English names inside words.
    return new RegExp(`(?:^|[\\s、，,:：「“"—-]|给|把|的|是|用|看|还有|包括)${escaped}(?=$|[\\s、，,:：」”"]|每|一|单|今|已|设|上|的|和|与|是|都|能|只|限|时|连续|目前|当前)`).test(prefix);
  });
  for (const clause of text.match(/[^。！？!?；;\n]+[。！？!?；;\n]?/g) ?? []) {
    if (NON_FACT.test(clause)) continue;
    let active: typeof unique = [], end = 0;
    for (const claim of clause.matchAll(CLAIM)) {
      const prefix = clause.slice(end, claim.index);
      const subjects = named(prefix);
      if (subjects.length) active = subjects;
      else if (!/^[\s、，,:：\/／「」“”"]*(?:(?:而|并且|且|以及|同时|则)\s*)?$/.test(prefix)) active = [];
      end = claim.index! + claim[0].length;
      if (/(?:不是|并非|不为|不再是)\s*$/.test(prefix)) continue;
      if (/^\s*(?:的)?(?:实际|累计)?(?:使用|用量|用了)/.test(clause.slice(end))) continue;
      if (claim[1].startsWith('连续') && !/上限|最多|至多|限时|限制|不超过|能用|可以用/.test(claim[0])) continue;
      const scope = /^(每天|每日|一天)$/.test(claim[1]) ? 'daily' : 'session';
      const actual = seconds(claim[2]);
      if (actual !== null && active.some(app => app[scope] !== null && app[scope] !== actual)) return true;
    }
  }
  return false;
}
