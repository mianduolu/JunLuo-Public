function compactText(value: unknown, limit = 120) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, limit) : '';
}

export function cleanLifeSearchQueryCandidate(value: unknown, limit = 24) {
  return compactText(value, 80)
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .replace(/[{}\[\]<>`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

const GENERIC_LIFE_SEARCH_QUERIES = new Set([
  '好奇',
  '社交',
  '想看看',
  '看看',
  '搜索',
  '资料',
  '信息',
  '内容',
  '今天小事',
  '公开网页',
  '公开网页远游',
  '小项目',
  '傍晚',
  '晚上',
  '下午',
  '上午',
  '睡前',
]);

const LIFE_SEARCH_QUERY_META_PATTERN =
  /(?:分析需求|当前任务|当前驱力|白云小姐|搜索词|短关键词|JSON|query|返回|需要选择|视角|公开网页远游|生成搜索词|系统提示|用户要求|以\s*I|作为第一人称|偏好时段|preferredPeriod|projectType|requiresExternalSources)/i;

const LIFE_SEARCH_TIME_META_PATTERN =
  /(?:几点|几时|时间段|到几点|从几点|上午|中午|下午|傍晚|晚上|睡前|深夜).{0,8}(?:几点|几时|时间|时段|开始|结束)|(?:morning|afternoon|evening|bedtime)/i;

export function looksLikeLifeSearchPromptLeak(rawText: string, query: string) {
  const compact = `${rawText} ${query}`.replace(/\s+/g, ' ').trim();
  if (LIFE_SEARCH_QUERY_META_PATTERN.test(compact)) return true;
  if (LIFE_SEARCH_TIME_META_PATTERN.test(compact)) return true;
  return /(?:我们|我|I).{0,12}(?:分析|需求|视角|需要|选择)/i.test(compact);
}

export function isSpecificLifeSearchQuery(query: string) {
  const compact = query.replace(/\s+/g, '');
  if (compact.length < 3 || compact.length > 24) return false;
  if (GENERIC_LIFE_SEARCH_QUERIES.has(compact)) return false;
  if (/^(为什么|怎么|如何|哪里|什么|有没有|可不可以)$/.test(compact)) return false;
  if (LIFE_SEARCH_TIME_META_PATTERN.test(compact)) return false;
  return /[\u4e00-\u9fffA-Za-z0-9]/.test(compact);
}

export function safeLifeSearchQuery(value: unknown, limit = 24) {
  const query = cleanLifeSearchQueryCandidate(value, limit);
  if (!query) return '';
  if (looksLikeLifeSearchPromptLeak(String(value ?? ''), query)) return '';
  return isSpecificLifeSearchQuery(query) ? query : '';
}

export function pickSafeLifeSearchQueries(values: unknown[], fallback: string, limit = 2) {
  const queries = values
    .map((value) => safeLifeSearchQuery(value))
    .filter(Boolean);
  const fallbackQuery = safeLifeSearchQuery(fallback);
  const unique = Array.from(new Set([...queries, fallbackQuery].filter(Boolean)));
  return unique.slice(0, Math.max(1, limit));
}
