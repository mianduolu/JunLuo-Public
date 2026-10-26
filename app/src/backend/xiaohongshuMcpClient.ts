const DEFAULT_BASE_URL = 'http://127.0.0.1:18060';

type McpEnvelope<T> =
  | { success: true; data: T; message?: string }
  | { code?: string; details?: unknown; error: string };

export type XiaohongshuMcpUser = {
  nickName?: string;
  nickname?: string;
  userId?: string;
};

export type XiaohongshuMcpInteractInfo = {
  collected?: boolean;
  collectedCount?: string;
  commentCount?: string;
  liked?: boolean;
  likedCount?: string;
  sharedCount?: string;
};

export type XiaohongshuMcpFeed = {
  id: string;
  index?: number;
  modelType?: string;
  noteCard?: {
    cover?: {
      urlDefault?: string;
      urlPre?: string;
    };
    displayTitle?: string;
    interactInfo?: XiaohongshuMcpInteractInfo;
    type?: string;
    user?: XiaohongshuMcpUser;
    video?: {
      capa?: {
        duration?: number;
      };
    } | null;
  };
  xsecToken: string;
};

export type XiaohongshuMcpComment = {
  content?: string;
  id?: string;
  likeCount?: string;
  subComments?: XiaohongshuMcpComment[];
  userInfo?: XiaohongshuMcpUser;
};

export type XiaohongshuMcpDetail = {
  comments?: {
    list?: XiaohongshuMcpComment[];
  };
  note?: {
    desc?: string;
    interactInfo?: XiaohongshuMcpInteractInfo;
    noteId?: string;
    title?: string;
    user?: XiaohongshuMcpUser;
  };
};

type XiaohongshuMcpDetailEnvelope = XiaohongshuMcpDetail | {
  data?: XiaohongshuMcpDetail;
  feed_id?: string;
};

export type XiaohongshuMcpActionResult = {
  detail?: XiaohongshuMcpDetail;
  feeds: XiaohongshuMcpFeed[];
  selectedFeed?: XiaohongshuMcpFeed;
  skippedFeeds?: Array<{
    reason: string;
    title: string;
  }>;
  source: 'mcp';
};

export type XiaohongshuMcpCommentPostResult = {
  feed_id?: string;
  message?: string;
  success?: boolean;
};

function withTimeout(ms: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { controller, done: () => clearTimeout(timer) };
}

async function requestJson<T>(path: string, init?: RequestInit, timeoutMs = 15000): Promise<T> {
  const { controller, done } = withTimeout(timeoutMs);
  try {
    const response = await fetch(`${DEFAULT_BASE_URL}${path}`, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init?.body ? { 'Content-Type': 'application/json' } : null),
        ...(init?.headers ?? {}),
      },
      signal: controller.signal,
    });
    const json = (await response.json()) as McpEnvelope<T>;
    if (!response.ok || !('success' in json) || json.success !== true) {
      const message = 'error' in json ? json.error : `HTTP_${response.status}`;
      throw new Error(message);
    }
    return json.data;
  } finally {
    done();
  }
}

export async function getXiaohongshuMcpHealth() {
  return requestJson<{ service?: string; status?: string }>('/health', undefined, 1500);
}

export async function isXiaohongshuMcpAvailable() {
  try {
    await getXiaohongshuMcpHealth();
    return true;
  } catch {
    return false;
  }
}

export async function listXiaohongshuMcpFeeds() {
  return requestJson<{ count?: number; feeds?: XiaohongshuMcpFeed[] }>('/api/v1/feeds/list', undefined, 25000);
}

export async function searchXiaohongshuMcpFeeds(keyword: string) {
  const query = encodeURIComponent(keyword);
  return requestJson<{ count?: number; feeds?: XiaohongshuMcpFeed[] }>(`/api/v1/feeds/search?keyword=${query}`, undefined, 25000);
}

export async function getXiaohongshuMcpFeedDetail(feed: XiaohongshuMcpFeed, maxComments = 20) {
  if (!feed.id || !feed.xsecToken) return null;
  const result = await requestJson<XiaohongshuMcpDetailEnvelope>(
    '/api/v1/feeds/detail',
    {
      body: JSON.stringify({
        comment_config: {
          click_more_replies: false,
          max_comment_items: maxComments,
          max_replies_threshold: 10,
          scroll_speed: 'fast',
        },
        feed_id: feed.id,
        load_all_comments: maxComments > 0,
        xsec_token: feed.xsecToken,
      }),
      method: 'POST',
    },
    45000,
  );
  if ('data' in result && result.data?.note) return result.data;
  return result as XiaohongshuMcpDetail;
}

export async function postXiaohongshuMcpComment(feed: XiaohongshuMcpFeed, content: string) {
  if (!feed.id || !feed.xsecToken || !content.trim()) return null;
  return requestJson<XiaohongshuMcpCommentPostResult>(
    '/api/v1/feeds/comment',
    {
      body: JSON.stringify({
        content: content.trim(),
        feed_id: feed.id,
        xsec_token: feed.xsecToken,
      }),
      method: 'POST',
    },
    45000,
  );
}

function cleanText(value: unknown) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function countNumber(value: unknown) {
  const text = cleanText(value);
  if (!text) return 0;
  if (text.includes('万')) {
    const number = Number.parseFloat(text.replace('万', ''));
    return Number.isFinite(number) ? number * 10000 : 0;
  }
  const number = Number.parseInt(text.replace(/[^\d]/g, ''), 10);
  return Number.isFinite(number) ? number : 0;
}

const AVOID_TITLE_PATTERNS = [
  /master|monster|主人|奴|调教|惩罚|羞辱|辱骂|厕妹|翻译主人/i,
  /吵架|骂战|撕|挂人|避雷|塌房|曝光|网暴|开盒|人肉|瓜|吐槽大会/i,
  /大尺度|擦边|裸|性|约|涩|黄文|xp|成人|下流|低俗/i,
  /绝望|崩溃|想死|自残|轻生|抑郁发作|精神崩溃|痛苦到/i,
  /血腥|暴力|虐待|猎奇|恐怖|惊悚|鬼故事|尸|死亡/i,
  /赌博|赔偿金|欠债|网贷|暴富|时时彩|彩票/i,
];

const PREFER_TITLE_PATTERNS = [
  /日常|生活|早餐|午餐|晚餐|甜品|咖啡|茶|散步|旅行|风景|天空|花|雨|海/i,
  /手作|绘画|画画|水彩|插画|摄影|手帐|读书|书单|音乐|电影|展览/i,
  /学习|笔记|教程|工具|效率|写作|开源|软件|代码|实验|研究|科普/i,
  /猫|狗|鸟|植物|多肉|园艺|厨房|收纳|家居|穿搭/i,
  /温柔|可爱|治愈|好笑|开心|灵感|记录|分享/i,
];

function avoidReasonForFeed(feed: XiaohongshuMcpFeed) {
  const title = cleanText(feed.noteCard?.displayTitle);
  if (!title) return '';
  const matched = AVOID_TITLE_PATTERNS.find((pattern) => pattern.test(title));
  if (!matched) return '';
  return '标题像吵闹/擦边/沉重内容，先跳过。';
}

function preferredTopicBoost(feed: XiaohongshuMcpFeed) {
  const title = cleanText(feed.noteCard?.displayTitle);
  if (!title) return 0;
  return PREFER_TITLE_PATTERNS.some((pattern) => pattern.test(title)) ? 36 : 0;
}

function scoreReadableFeed(feed: XiaohongshuMcpFeed) {
  if (!feed.id || !feed.xsecToken || feed.modelType !== 'note') return -1000;
  const title = cleanText(feed.noteCard?.displayTitle);
  if (!title) return -500;
  if (avoidReasonForFeed(feed)) return -900;
  let score = 0;
  if (feed.noteCard?.type === 'normal') score += 40;
  if (!feed.noteCard?.video) score += 20;
  score += preferredTopicBoost(feed);
  score += Math.min(title.length, 28);
  score += Math.min(countNumber(feed.noteCard?.interactInfo?.commentCount), 80) / 8;
  score += Math.min(countNumber(feed.noteCard?.interactInfo?.likedCount), 2000) / 400;
  if (feed.noteCard?.cover?.urlDefault || feed.noteCard?.cover?.urlPre) score += 8;
  return score;
}

function pickReadableFeeds(feeds: XiaohongshuMcpFeed[]) {
  return [...feeds]
    .map((feed) => ({ feed, score: scoreReadableFeed(feed) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .map((item) => item.feed);
}

function skippedFeedsForLog(feeds: XiaohongshuMcpFeed[]) {
  return feeds
    .map((feed) => ({
      reason: avoidReasonForFeed(feed),
      title: cleanText(feed.noteCard?.displayTitle),
    }))
    .filter((item) => item.reason && item.title)
    .slice(0, 4);
}

export async function runXiaohongshuMcpBrowse(keyword?: string): Promise<XiaohongshuMcpActionResult | null> {
  if (!(await isXiaohongshuMcpAvailable())) return null;
  const feedResult = keyword ? await searchXiaohongshuMcpFeeds(keyword) : await listXiaohongshuMcpFeeds();
  const feeds = Array.isArray(feedResult.feeds) ? feedResult.feeds : [];
  const readableFeeds = pickReadableFeeds(feeds);
  const skippedFeeds = skippedFeedsForLog(feeds);
  let detail: XiaohongshuMcpDetail | undefined;
  let selectedFeed: XiaohongshuMcpFeed | undefined;
  for (const feed of readableFeeds.slice(0, 5)) {
    const nextDetail = await getXiaohongshuMcpFeedDetail(feed, 20).catch(() => null);
    if (nextDetail?.note) {
      detail = nextDetail;
      selectedFeed = feed;
      break;
    }
  }
  selectedFeed ??= readableFeeds[0];
  return { detail, feeds, selectedFeed, skippedFeeds, source: 'mcp' };
}
