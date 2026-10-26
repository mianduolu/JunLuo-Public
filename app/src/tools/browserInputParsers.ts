import { extractResearchUrl } from './researchInputParsers';
import { shouldProtectFromBroadToolRouting } from './toolRouteSemanticGuards';

export type BrowserIntentRoute = {
  candidateTools: string[];
  reason: 'browser_open' | 'browser_read' | 'browser_list_recent' | 'browser_unsupported_action';
  unsupported?: boolean;
};

const BROWSER_TEXT_PATTERN = /(?:网页|链接|URL|url|浏览器|页面|网站|网址|http|https)/i;
const BROWSER_OPEN_PATTERN = /(?:打开|开启|跳转|用浏览器|浏览器打开).{0,18}(?:网页|链接|URL|url|网站|网址|https?:\/\/)|https?:\/\/\S+.{0,16}(?:打开|开启|跳转)/i;
const BROWSER_READ_PATTERN =
  /(?:读|读取|看|看看|总结|概括|讲讲|说说).{0,20}(?:网页|链接|URL|url|页面|网站|网址|https?:\/\/)|(?:网页|链接|URL|url|页面|网站|网址).{0,20}(?:写了什么|讲什么|内容|总结|概括)/i;
const BROWSER_LIST_PATTERN = /(?:最近|刚才|之前).{0,16}(?:打开|读过|看过|浏览).{0,16}(?:网页|链接|页面|网站)|(?:网页|浏览).{0,12}(?:记录|历史|列表|标签)/i;
const BROWSER_UNSUPPORTED_ACTION_PATTERN =
  /(?:点击|点一下|输入|填写|填表|登录|登陆|提交|上传|下载|评价|购买|下单|注册).{0,24}(?:网页|页面|链接|网站|按钮|表单|账号|密码)/i;

export function routeBrowserIntent(text: string): BrowserIntentRoute | null {
  const trimmed = text.trim();
  if (!trimmed || !BROWSER_TEXT_PATTERN.test(trimmed)) return null;
  if (shouldProtectFromBroadToolRouting(trimmed)) return null;
  if (BROWSER_UNSUPPORTED_ACTION_PATTERN.test(trimmed)) {
    return { candidateTools: [], reason: 'browser_unsupported_action', unsupported: true };
  }
  if (BROWSER_LIST_PATTERN.test(trimmed)) {
    return { candidateTools: ['browser.list_tabs'], reason: 'browser_list_recent' };
  }
  if (BROWSER_OPEN_PATTERN.test(trimmed)) {
    return { candidateTools: ['browser.open'], reason: 'browser_open' };
  }
  if (BROWSER_READ_PATTERN.test(trimmed)) {
    return { candidateTools: ['browser.snapshot'], reason: 'browser_read' };
  }
  return null;
}

export function parseBrowserUrlInputFromText(text: string): Record<string, unknown> | null {
  const url = extractResearchUrl(text);
  return url ? { url } : null;
}

export function parseBrowserListInputFromText(text: string): Record<string, unknown> {
  const limitMatch = /(?:最近|前)\s*(\d{1,2})\s*(?:个|条)?/.exec(text);
  const limit = limitMatch ? Number(limitMatch[1]) : 20;
  return { limit };
}
