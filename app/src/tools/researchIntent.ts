import { shouldProtectFromBroadToolRouting } from './toolRouteSemanticGuards';

export type JunLuoResearchIntent = {
  candidateTools: string[];
  reason:
    | 'research_fetch_page'
    | 'research_verify_claim'
    | 'research_fresh_search'
    | 'research_search'
    | 'research_multi_search'
    | 'research_compare_sources'
    | 'research_image_search'
    | 'research_academic_search'
    | 'research_doi_search';
};

const RESEARCH_FETCH_PATTERN = /https?:\/\/[^\s"'，。；、]+|(?:读取|总结|概括|看看).{0,10}(?:网页|链接|URL|url)/;
const RESEARCH_DOI_PATTERN = /(?:\bdoi\b|DOI|10\.\d{4,9}\/[\-._;()/:A-Z0-9]+)/i;
const RESEARCH_IMAGE_PATTERN = /(?:找|搜|搜索|查).{0,8}(?:图片|图源|配图|照片|图像)|(?:图片|图源|配图|照片|图像).{0,8}(?:来源|搜索|候选|素材)/;
const RESEARCH_ACADEMIC_PATTERN = /论文|文献|学术|期刊文章|作者论文|Crossref|crossref/;
const RESEARCH_COMPARE_PATTERN = /对比来源|来源对比|多找几个来源|多个来源|不同来源|交叉来源|来源分布|多源对比/;
const RESEARCH_MULTI_PATTERN = /多平台|多源|多个网站|不同网站|多找几个|多搜几个/;
const RESEARCH_VERIFY_PATTERN = /真假|真的(?:吗|么)?|靠谱吗|可靠吗|可信吗|对吗|真实吗|准确吗|有没有证据|证据|证实|核对|验证|辟谣/;
const RESEARCH_FRESH_PATTERN = /最新|今天的新闻|今天新闻|实时(?:新闻|资讯|消息)?|新闻|资讯|(?:现在|目前|最近|刚刚).{0,16}(?:新闻|消息|资讯|进展|情况|动态|版本|价格|政策|发布|更新|怎么样|如何)/;
const RESEARCH_SEARCH_PATTERN = /(?:查一下|查查|搜索|搜一下|搜搜|找一下|找找).{1,80}|(?:有没有|有什么).{0,24}(?:资料|来源|网页|网站|链接)|(?:资料|来源|网页|网站).{0,16}(?:查|搜|找|搜索|链接|出处)/;

export function routeResearchIntent(text: string): JunLuoResearchIntent | null {
  if (shouldProtectFromBroadToolRouting(text)) return null;

  if (RESEARCH_FETCH_PATTERN.test(text)) {
    return { candidateTools: ['research.fetch_page'], reason: 'research_fetch_page' };
  }
  if (RESEARCH_DOI_PATTERN.test(text)) {
    return { candidateTools: ['research.search_doi'], reason: 'research_doi_search' };
  }
  if (RESEARCH_IMAGE_PATTERN.test(text)) {
    return { candidateTools: ['research.search_images'], reason: 'research_image_search' };
  }
  if (RESEARCH_ACADEMIC_PATTERN.test(text)) {
    return { candidateTools: ['research.search_academic'], reason: 'research_academic_search' };
  }
  if (RESEARCH_COMPARE_PATTERN.test(text)) {
    return { candidateTools: ['research.compare_sources'], reason: 'research_compare_sources' };
  }
  if (RESEARCH_MULTI_PATTERN.test(text)) {
    return { candidateTools: ['research.search_multi'], reason: 'research_multi_search' };
  }
  if (RESEARCH_VERIFY_PATTERN.test(text)) {
    return { candidateTools: ['research.verify_claim'], reason: 'research_verify_claim' };
  }
  if (RESEARCH_FRESH_PATTERN.test(text)) {
    return { candidateTools: ['research.search_with_diagnostics'], reason: 'research_fresh_search' };
  }
  if (RESEARCH_SEARCH_PATTERN.test(text)) {
    return { candidateTools: ['research.search_with_diagnostics', 'research.search'], reason: 'research_search' };
  }
  return null;
}
