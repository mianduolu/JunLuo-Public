const URL_PATTERN = /https?:\/\/[^\s"'，。；、]+/i;
const DOI_PATTERN = /(?:https?:\/\/(?:dx\.)?doi\.org\/)?(10\.\d{4,9}\/[\-._;()/:A-Z0-9]+)/i;

function cleanQueryText(text: string) {
  return text
    .replace(URL_PATTERN, ' ')
    .replace(/^(帮(?:我|鼠)?|请|给(?:我|鼠)?)/, '')
    .replace(/(?:查一下|查查|搜索一下|搜索|搜一下|搜搜|找一下|找找|找|看看|查|搜)/g, ' ')
    .replace(/(?:最新消息|最新新闻|最新资讯|今天的新闻|今天新闻|最近消息|现在的情况|资料|来源|证据)/g, ' ')
    .replace(/[：:，,。！？!?\s]+/g, ' ')
    .trim();
}

function cleanExtendedQueryText(text: string) {
  return cleanQueryText(text)
    .replace(/(?:多平台|多源|多个来源|多个网站|不同来源|不同网站|多找几个|多搜几个|对比来源|来源对比|来源分布|交叉来源|对比)/g, ' ')
    .replace(/(?:图片|图源|配图|照片|图像|素材|候选|几张|一张|几幅|一幅)/g, ' ')
    .replace(/(?:论文|文献|学术|期刊文章|作者论文|Crossref|crossref|DOI|doi)/g, ' ')
    .replace(/[：:，,。！？!?\s]+/g, ' ')
    .trim();
}

export function extractResearchUrl(text: string) {
  const match = text.match(URL_PATTERN);
  if (!match) return null;
  try {
    const url = new URL(match[0]);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function parseResearchFetchPageInputFromText(text: string): Record<string, unknown> | null {
  const url = extractResearchUrl(text);
  return url ? { url } : null;
}

export function parseResearchSearchInputFromText(text: string): Record<string, unknown> | null {
  const url = extractResearchUrl(text);
  const withoutUrl = url ? text.replace(url, ' ') : text;
  const query = cleanQueryText(withoutUrl);
  return query ? { query, limit: 6 } : null;
}

export function parseResearchMultiSearchInputFromText(text: string): Record<string, unknown> | null {
  const query = cleanExtendedQueryText(text) || cleanQueryText(text);
  return query ? { query, limit: 8, maxEngines: 3 } : null;
}

export function parseResearchCompareSourcesInputFromText(text: string): Record<string, unknown> | null {
  const query = cleanExtendedQueryText(text) || cleanQueryText(text);
  return query ? { query, limit: 8 } : null;
}

export function parseResearchImageSearchInputFromText(text: string): Record<string, unknown> | null {
  const query = cleanExtendedQueryText(text) || cleanQueryText(text);
  return query ? { query, limit: 8 } : null;
}

export function parseResearchAcademicSearchInputFromText(text: string): Record<string, unknown> | null {
  const query = cleanExtendedQueryText(text) || cleanQueryText(text);
  if (!query) return null;
  const mode = /作者|author/i.test(text) ? 'author' : /标题|题名|title/i.test(text) ? 'title' : 'keyword';
  return { mode, query, rows: 5 };
}

export function parseResearchDoiInputFromText(text: string): Record<string, unknown> | null {
  const match = text.match(DOI_PATTERN);
  if (!match) return null;
  return { doi: match[1] };
}

export function parseResearchVerifyInputFromText(text: string): Record<string, unknown> | null {
  const normalized = text.trim();
  const markerMatch = normalized.match(/(?:这个说法|这句话|说法|结论|消息)?(?:是)?(?:真的|靠谱吗|可靠吗|可信吗|对吗|真实吗|准确吗|有没有证据|能证实吗|证实一下|核对一下|验证一下)[：:，,]?\s*(.+)$/);
  const claim = (markerMatch?.[1] ?? normalized)
    .replace(/^(帮(?:我|鼠)?|请|给(?:我|鼠)?)/, '')
    .replace(/(?:查一下|搜索一下|搜一下|核对一下|验证一下|证实一下)/g, '')
    .trim();
  const query = cleanQueryText(claim);
  return claim && query ? { claim, query } : null;
}


