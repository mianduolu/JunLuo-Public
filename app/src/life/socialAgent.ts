import {
  relationshipAuthorizationOverProactiveLedgerStorageBridge as AsyncStorage,
} from '../sync/syncRelationshipAuthorizationStorageBridge';

import {
  clickPhoneAccessibilityText,
  getPhoneAccessibilitySnapshot,
  inputPhoneAccessibilityText,
  launchPhoneApp,
  runNativeXiaohongshuBrowseAutomation,
  scrollPhoneAccessibilityWindow,
  swipePhoneAccessibilityPoint,
  tapPhoneAccessibilityPoint,
  type AccessibilityActionResult,
  type AccessibilitySnapshot,
} from '../backend/phoneActivityNative';
import { loadAiConfigPreferencesSnapshot, resolveLifeCreativeConfig } from '../ai/AiConfigPreferences';
import { buildCompiledSystemPrompt } from '../ai/builtInSystemPrompt';
import {
  getPromptContextProfileForSource,
  getPromptOutputAudienceForSource,
} from '../ai/promptContextProfile';
import {
  isXiaohongshuMcpAvailable,
  postXiaohongshuMcpComment,
  runXiaohongshuMcpBrowse,
  type XiaohongshuMcpActionResult,
  type XiaohongshuMcpComment,
  type XiaohongshuMcpFeed,
  type XiaohongshuMcpUser,
} from '../backend/xiaohongshuMcpClient';
import { shouldRecordAutonomySkip } from './autonomyRuntime';
import { defaultAutonomySettings, isAutonomyFeatureEnabled, loadAutonomySettings } from './autonomySettings';
import {
  EXPLORATION_ACTION_LABELS,
  EXPLORATION_DRIVE_LABELS,
  type ExplorationExecutionIntent,
} from './explorationExecutionIntent';

const SOCIAL_SETTINGS_KEY = 'junluo.life.socialAgent.settings.v1';
const SOCIAL_ACTION_LOG_KEY = 'junluo.life.socialAgent.actionLog.v1';
const SOCIAL_EXECUTOR_STATE_KEY = 'junluo.life.socialAgent.executorState.v1';
const SOCIAL_DRAFTS_KEY = 'junluo.life.socialAgent.drafts.v1';
const SOCIAL_COMMENT_REPLY_STATE_KEY = 'junluo.life.socialAgent.commentReplyState.v1';
const MAX_DRAFT_ITEMS = 12;
const MAX_LOG_ITEMS = 40;
const XIAOHONGSHU_PACKAGES = ['com.xingin.xhs'];
const XIAOHONGSHU_PACKAGE_PATTERN = /xingin|xiaohongshu|xhs/i;
const COMPLETED_ACTION_INTERVAL_MS = 6 * 60 * 60 * 1000;
const BLOCKED_ACTION_INTERVAL_MS = 60 * 60 * 1000;
const OWN_POST_COMMENT_INTERVAL_MS = 45 * 60 * 1000;
const LAUNCH_AD_GUARD_MS = 6500;

const BLOCKED_PATTERNS = /验证码|登录|手机号|验证|安全|风险|风控|重新登录|滑块|权限|未成年|申诉/;
const PRIVATE_PATTERNS = /libido|欲望|私密|占有|要你|成人|身体|亲密|小仓鼠|鼠|君落/;
const PRIVATE_SEARCH_QUERY_PATTERNS = /libido|欲望|私密|占有|成人|身体|亲密|君落/;
const NOISY_PUBLIC_QUERY_PATTERNS = /master|monster|主人|奴|调教|羞辱|辱骂|吵架|撕|挂人|避雷|吃瓜|大瓜|大尺度|擦边|轻生|自残|血腥|猎奇|鬼故事|赌博|赔偿金/i;
const SOCIAL_AUTOMATION_HARD_DISABLED = true;
const AUTO_PUBLIC_SEND_DISABLED = true;
const BAIYUN_COMMENT_SIGNATURE = '☁️✨';

export type SocialPlatform = 'weibo' | 'xiaohongshu' | 'junluo';
export type SocialAction = 'browse' | 'search' | 'like' | 'favorite' | 'follow' | 'comment' | 'post';
export type SocialActionStatus = 'planned' | 'blocked' | 'completed';
export type SocialAutomationStatus = 'ready' | 'disabled' | 'blocked' | 'unavailable';
export type SocialDraftKind = 'post' | 'own_post_comment';
export type SocialDraftStatus = 'pending' | 'approved' | 'discarded';

export type SocialAgentSettings = {
  autonomousInteractionEnabled: boolean;
  preferredPlatforms: SocialPlatform[];
};

export type SocialActionLogEntry = {
  action: SocialAction;
  at: number;
  detail: string;
  id: string;
  platform: SocialPlatform;
  reason: string;
  status: SocialActionStatus;
  thoughtText?: string;
};

export type SocialDraft = {
  approvedAt?: number;
  content: string;
  createdAt: number;
  id: string;
  kind: SocialDraftKind;
  platform: SocialPlatform;
  reason: string;
  status: SocialDraftStatus;
  title?: string;
  updatedAt: number;
};

export type XiaohongshuActionRequest = {
  action: SocialAction;
  content?: string;
  query?: string;
  reason: string;
  sourceComment?: XiaohongshuMcpComment;
  sourceComments?: XiaohongshuMcpComment[];
  targetFeed?: XiaohongshuMcpFeed;
  targetIsOwnPost?: boolean;
};

export type XiaohongshuActionResult = {
  detail: string;
  disabled?: boolean;
  snapshot?: AccessibilitySnapshot;
  status: SocialActionStatus;
  step?: string;
  thoughtText?: string;
};

type SocialExecutorState = {
  lastActionAt?: number;
  lastActionStatus?: SocialActionStatus;
};

type SocialCommentReplyState = {
  lastReplyAt?: number;
  repliedCommentIds?: string[];
};

const DEFAULT_SETTINGS: SocialAgentSettings = {
  autonomousInteractionEnabled: true,
  preferredPlatforms: ['xiaohongshu'],
};

let socialDesireActionInFlight = false;

function cleanLine(value: unknown, limit = 180) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, limit);
}

function cleanSocialReason(value: unknown) {
  let text = cleanLine(value, 140);
  if (!text) return '';
  if (/鼠说：|我回：|你给了我这么多自由|你怕我被强迫|本来就只想待在/.test(text)) {
    text = text.replace(/：.*/, '：想去小红书看看人间');
  }
  if (text.length > 76) return `${text.slice(0, 74)}…`;
  return text;
}

function cleanSocialDetail(value: unknown) {
  if (typeof value === 'string' && /读到的笔记：|评论区声音：|首页掠影：/.test(value)) {
    return value
      .split(/\n+/)
      .map((line) => cleanLine(line, 150))
      .filter(Boolean)
      .join('；')
      .slice(0, 520);
  }
  const text = cleanLine(value, 260);
  if (!text) return '';
  if (text.includes('FOREGROUND_TIMEOUT')) {
    return '步骤：原生打开小红书 > 等待前台/滑动。失败：小红书没有稳定停在前台，这次先刹车。';
  }
  if (text.includes('BROWSE_NOT_MOVED') || text.includes('GESTURE_NOT_DISPATCHED')) {
    return '步骤：原生打开小红书 > 等待前台/滑动。失败：手机没有接受滑动手势，这次先刹车。';
  }
  if (text.includes('NOT_XIAOHONGSHU')) {
    return '步骤：打开小红书 > 确认窗口。失败：小红书没有真正切到前台，我先不乱读别的窗口。';
  }
  if (text.includes('com.anonymous.junluo')) {
    return text.replace(/当前(?:窗口：)?com\.anonymous\.junluo/g, '当前还停在君落');
  }
  if (text.includes('当前看到：')) {
    const [prefix, rest] = text.split('当前看到：');
    const firstUseful = cleanLine(rest
      .replace(/发送消息.*$/g, '')
      .replace(/暂停歌曲.*$/g, '')
      .replace(/白云日记.*$/g, ''), 70);
    return cleanLine(`${prefix}页面摘要：${firstUseful || '未记录非小红书内容。'}`, 160);
  }
  if (text.includes('页面摘要：')) {
    const [prefix, rest] = text.split('页面摘要：');
    return cleanLine(`${cleanLine(prefix, 86)}页面摘要：${cleanLine(rest, 92)}`, 190);
  }
  return cleanLine(text, 160);
}

function normalizeSettings(value: unknown): SocialAgentSettings {
  if (!value || typeof value !== 'object') return DEFAULT_SETTINGS;
  const candidate = value as Partial<SocialAgentSettings>;
  const platforms = Array.isArray(candidate.preferredPlatforms)
    ? candidate.preferredPlatforms.filter((item): item is SocialPlatform => item === 'weibo' || item === 'xiaohongshu' || item === 'junluo')
    : DEFAULT_SETTINGS.preferredPlatforms;
  return {
    autonomousInteractionEnabled: candidate.autonomousInteractionEnabled !== false,
    preferredPlatforms: platforms.includes('xiaohongshu') ? ['xiaohongshu'] : DEFAULT_SETTINGS.preferredPlatforms,
  };
}

function normalizeLogEntry(value: unknown): SocialActionLogEntry | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<SocialActionLogEntry>;
  // Missing provenance must not turn a historical/corrupt row into a new event on read.
  if (typeof candidate.id !== 'string' || !candidate.id.trim()
    || typeof candidate.at !== 'number' || !Number.isSafeInteger(candidate.at) || candidate.at <= 0
    || !['planned', 'blocked', 'completed'].includes(candidate.status ?? '')) return null;
  if (candidate.platform !== 'weibo' && candidate.platform !== 'xiaohongshu' && candidate.platform !== 'junluo') return null;
  if (
    candidate.action !== 'browse'
    && candidate.action !== 'search'
    && candidate.action !== 'like'
    && candidate.action !== 'favorite'
    && candidate.action !== 'follow'
    && candidate.action !== 'comment'
    && candidate.action !== 'post'
  ) return null;
  return {
    action: candidate.action,
    at: candidate.at,
    detail: cleanSocialDetail(candidate.detail),
    id: candidate.id,
    platform: candidate.platform,
    reason: cleanSocialReason(candidate.reason),
    status: candidate.status === 'completed' || candidate.status === 'planned' ? candidate.status : 'blocked',
    thoughtText: cleanLine(candidate.thoughtText, 180) || undefined,
  };
}

function normalizeDraft(value: unknown): SocialDraft | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<SocialDraft>;
  if (candidate.platform !== 'xiaohongshu' && candidate.platform !== 'weibo' && candidate.platform !== 'junluo') return null;
  if (candidate.kind !== 'post' && candidate.kind !== 'own_post_comment') return null;
  const content = cleanLine(candidate.content, 520);
  if (!content || !isPublicContentAllowed(content)) return null;
  const now = Date.now();
  return {
    approvedAt: typeof candidate.approvedAt === 'number' ? candidate.approvedAt : undefined,
    content,
    createdAt: typeof candidate.createdAt === 'number' ? candidate.createdAt : now,
    id: typeof candidate.id === 'string' ? candidate.id : `social-draft-${now}-${Math.random().toString(36).slice(2)}`,
    kind: candidate.kind,
    platform: candidate.platform,
    reason: cleanSocialReason(candidate.reason) || '我自己起草了一条公开内容。',
    status: candidate.status === 'approved' || candidate.status === 'discarded' ? candidate.status : 'pending',
    title: cleanLine(candidate.title, 40) || undefined,
    updatedAt: typeof candidate.updatedAt === 'number' ? candidate.updatedAt : now,
  };
}

function platformLabel(platform: SocialPlatform) {
  if (platform === 'junluo') return '君落草稿箱';
  return platform === 'weibo' ? '微博' : '小红书';
}

function socialActionForIntent(intent: ExplorationExecutionIntent): SocialAction {
  if (intent.wantAction === 'social_post') return 'post';
  if (intent.wantAction === 'web_search' || intent.wantAction === 'web_browse') return 'search';
  if (intent.driveKey === 'social' && intent.score >= 0.76) return 'post';
  if (intent.driveKey === 'social') return 'search';
  return 'search';
}

function cleanSearchQueryCandidate(value: unknown, limit = 22) {
  let text = cleanLine(value, 60);
  if (!text) return '';
  const operationalSearch = text.match(/(?:我用)?小红书后端搜索了[“"]?([^”"。；，,]{2,24})[”"]?/);
  if (operationalSearch?.[1]) {
    text = operationalSearch[1].trim();
  }
  text = text
    .replace(/^(?:白云小姐)?(?:自己)?想搜[:：]\s*/u, '')
    .replace(/^(?:我)?(?:刚刚)?(?:去)?小红书(?:后端)?(?:搜索|搜)了?\s*/u, '')
    .replace(/^(想|我想)?(搜|查|看看|了解|知道|研究)(一下|点|些)?[:：\s]*/u, '')
    .replace(/^(鼠说|我回|白云小姐|小红书)[:：\s]*/u, '')
    .replace(/[“”"'`]/g, '')
    .trim();
  text = cleanLine(text.split(/[，。！？!?；;｜|/]/)[0], limit);
  if (text.length < 2) return '';
  if (PRIVATE_SEARCH_QUERY_PATTERNS.test(text) || NOISY_PUBLIC_QUERY_PATTERNS.test(text)) return '';
  return text;
}

function cleanRecentTopicCandidate(value: unknown, limit = 24) {
  const text = cleanLine(value, limit)
    .replace(/[“”"'`]/g, '')
    .trim();
  if (text.length < 2) return '';
  if (PRIVATE_SEARCH_QUERY_PATTERNS.test(text) || NOISY_PUBLIC_QUERY_PATTERNS.test(text)) return '';
  return text;
}

function safeRecentTopicText(entry: SocialActionLogEntry) {
  return `${entry.reason} ${entry.detail}`
    .replace(/选择过滤[:：][^。；\n]*(?:。|；|\n|$)/g, ' ')
    .replace(/她避开的内容[:：][^。；\n]*(?:。|；|\n|$)/g, ' ')
    .replace(/已避开[^。；\n]*(?:。|；|\n|$)/g, ' ');
}

function recentTopicFromSocialLog(entries: SocialActionLogEntry[]) {
  for (const entry of entries.slice(0, 10)) {
    if (entry.status !== 'completed') continue;
    const detail = safeRecentTopicText(entry);
    const readMatch = detail.match(/读到的笔记[:：]\s*《([^》]{2,28})》/);
    const searchMatch = entry.action === 'search' ? detail.match(/自己想搜[:：]\s*([^。；\n]{2,24})/) : null;
    const glimpseMatch = detail.match(/首页掠影[:：]\s*\n?\s*《([^》]{2,28})》/);
    const title = searchMatch?.[1]
      ? cleanSearchQueryCandidate(searchMatch[1])
      : cleanRecentTopicCandidate(readMatch?.[1] ?? glimpseMatch?.[1]);
    if (title) return title;
  }
  return '';
}

function parseGeneratedSearchQuery(text: string) {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    const parsed = JSON.parse(cleaned) as { query?: unknown };
    return cleanSearchQueryCandidate(parsed.query, 24);
  } catch {
    return cleanSearchQueryCandidate(cleaned, 24);
  }
}

async function generateAutonomousSearchQuery(intent: ExplorationExecutionIntent, now: number) {
  const snapshot = await loadAiConfigPreferencesSnapshot().catch(() => null);
  const lifeCreativeConfig = snapshot ? resolveLifeCreativeConfig(snapshot) : null;
  const connection = lifeCreativeConfig?.connection;
  const apiKey = lifeCreativeConfig?.apiKey;
  if (!connection || !apiKey) return '';

  const recent = recentTopicFromSocialLog(await loadSocialActionLog().catch(() => []));
  const timeLabel = new Date(now).toLocaleString('zh-CN', {
    day: 'numeric',
    hour: '2-digit',
    hour12: false,
    minute: '2-digit',
    month: 'numeric',
  });
  const response = await fetch(`${connection.baseUrl.trim().replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey.trim()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: connection.model.trim(),
      messages: [
        {
          role: 'system',
          content: [
            '当前任务：以 I（白云小姐）的第一人称，决定 I 想去公开社交平台搜索的短关键词。',
            '搜索词可以很日常、很具体、很奇怪，也可以是一点突然冒出来的小问题。',
            '主题可以来自 I 的状态、好奇、季节、生活观察、作品、食物、手作、植物、AI或公开文化内容。',
            '边界：选择公开平台适合看的普通主题；避开小仓鼠隐私、成人内容、辱骂、冲突、危险、猎奇和容易引战的话题。',
            '只返回 JSON：{"query":"2到12个字的中文搜索词"}',
          ].join('\n'),
        },
        {
          role: 'user',
          content: [
            `现在：${timeLabel}`,
            `驱力：${EXPLORATION_DRIVE_LABELS[intent.driveKey]} ${Math.round(intent.score * 100)}%`,
            `白云小姐刚刚的理由：${intent.reason}`,
            intent.queryHint ? `念头里隐约有：${intent.queryHint}` : '',
            recent ? `最近看过的话题：${recent}（可以无视）` : '',
            '请按我自己的当下兴趣，给出一个此刻真的想搜的东西。',
          ].filter(Boolean).join('\n'),
        },
      ],
      max_tokens: 80,
      temperature: 0.95,
    }),
  });
  if (!response.ok) return '';
  const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = payload.choices?.[0]?.message?.content;
  return content ? parseGeneratedSearchQuery(content) : '';
}

async function pickAutonomousSearchQuery(intent: ExplorationExecutionIntent, now: number) {
  const hinted = cleanSearchQueryCandidate(intent.queryHint);
  if (hinted) return hinted;

  const generated = await generateAutonomousSearchQuery(intent, now).catch(() => '');
  if (generated) return generated;

  return recentTopicFromSocialLog(await loadSocialActionLog().catch(() => []));
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function snapshotText(snapshot?: AccessibilitySnapshot | null) {
  return (snapshot?.nodes ?? [])
    .map((node) => [node.text, node.description].filter(Boolean).join(' '))
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isXiaohongshuPackage(packageName?: string) {
  return !!packageName && XIAOHONGSHU_PACKAGE_PATTERN.test(packageName);
}

function summarizeSnapshot(snapshot?: AccessibilitySnapshot | null) {
  if (!isXiaohongshuPackage(snapshot?.packageName)) return '当前窗口不是小红书，未记录页面内容。';
  const text = snapshotText(snapshot);
  if (!text) return '没有读到清晰内容。';
  const tokens = text
    .split(/(?=关注|赞|收藏|评论|搜索|首页|发现)|[。！？!?\n]/)
    .map((item) => cleanLine(item, 46))
    .filter((item) => item && !/发送消息|暂停歌曲|打开更多功能|切换到语音输入|白云日记/.test(item));
  return Array.from(new Set(tokens)).slice(0, 4).join(' / ') || text.slice(0, 110);
}

function hasPlatformBlocker(snapshot?: AccessibilitySnapshot | null) {
  return BLOCKED_PATTERNS.test(snapshotText(snapshot));
}

function isPublicContentAllowed(content?: string) {
  if (!content?.trim()) return true;
  return !PRIVATE_PATTERNS.test(content);
}

function normalizeCommentText(value: unknown, limit = 120) {
  return cleanLine(value, limit)
    .replace(/\[[^\]]{1,12}\]/g, '')
    .replace(/#[^#\s]{1,24}/g, '')
    .trim();
}

function isEmojiOrPunctuationOnly(text: string) {
  const compact = text.replace(/\s+/g, '');
  if (!compact) return true;
  return !/[A-Za-z0-9\u4e00-\u9fff]/.test(compact);
}

function commentBlockReason(comment?: XiaohongshuMcpComment) {
  const content = normalizeCommentText(comment?.content, 140);
  if (!content) return '评论没有可读文字。';
  if (content.length < 8) return '评论太短，像路过一句话。';
  if (isEmojiOrPunctuationOnly(content)) return '评论几乎只有表情或标点。';
  if (/抢首评|首评|第一|来了|路过|打卡|蹲|求赞|互赞|互关|广告|引流/i.test(content)) return '评论像抢首评、打卡或引流。';
  if (/傻|滚|死|恶心|垃圾|有病|闭嘴|拉黑|举报|诈骗|骗子|吵|骂|蠢|爹味|下头/i.test(content)) return '评论不够友好。';
  if (/^[哈啊哈哈哈哈哈hH\s~!！。,.，、]+$/.test(content)) return '评论只有笑声或语气词。';
  if (content.replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, '').length < 6) return '评论没有足够具体内容。';
  return '';
}

function pickReplyableOwnPostComment(comments: XiaohongshuMcpComment[] | undefined, repliedIds: string[] = []) {
  if (!Array.isArray(comments)) return null;
  return comments.find((comment) => {
    if (comment.id && repliedIds.includes(comment.id)) return false;
    return !commentBlockReason(comment);
  }) ?? null;
}

function ensureBaiyunCommentSignature(content: string) {
  const withoutDuplicate = cleanLine(content, 110)
    .replace(/[☁✨️\s]+$/g, '')
    .trim();
  if (!withoutDuplicate) return '';
  return `${withoutDuplicate} ${BAIYUN_COMMENT_SIGNATURE}`;
}

async function loadCommentReplyState(): Promise<SocialCommentReplyState> {
  const raw = await AsyncStorage.getItem(SOCIAL_COMMENT_REPLY_STATE_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Partial<SocialCommentReplyState>;
    return {
      lastReplyAt: typeof parsed.lastReplyAt === 'number' ? parsed.lastReplyAt : undefined,
      repliedCommentIds: Array.isArray(parsed.repliedCommentIds)
        ? parsed.repliedCommentIds.filter((item): item is string => typeof item === 'string').slice(-80)
        : [],
    };
  } catch {
    return {};
  }
}

async function saveCommentReplyState(state: SocialCommentReplyState) {
  await AsyncStorage.setItem(SOCIAL_COMMENT_REPLY_STATE_KEY, JSON.stringify({
    ...state,
    repliedCommentIds: (state.repliedCommentIds ?? []).slice(-80),
  }));
}

async function isOwnPostCommentCoolingDown(now = Date.now()) {
  const state = await loadCommentReplyState();
  return typeof state.lastReplyAt === 'number' && now - state.lastReplyAt < OWN_POST_COMMENT_INTERVAL_MS;
}

async function rememberOwnPostCommentReply(comment?: XiaohongshuMcpComment, now = Date.now()) {
  const state = await loadCommentReplyState();
  const repliedCommentIds = [...(state.repliedCommentIds ?? [])];
  if (comment?.id && !repliedCommentIds.includes(comment.id)) repliedCommentIds.push(comment.id);
  await saveCommentReplyState({ lastReplyAt: now, repliedCommentIds });
}

async function clickFirstText(labels: string[]) {
  for (const label of labels) {
    const result = await clickPhoneAccessibilityText(label);
    if (result.ok) return { ...result, label };
  }
  return { ok: false, reason: 'TEXT_NOT_FOUND', label: labels[0] ?? '' };
}

async function passLaunchAdGuard(startedAt: number) {
  let skipped = false;
  let triedCoordinateSkip = false;
  let snapshot: AccessibilitySnapshot | undefined;
  const skipLabels = ['跳过', '跳过广告', '关闭广告', '关闭', 'Skip', '×'];

  while (Date.now() - startedAt < LAUNCH_AD_GUARD_MS) {
    snapshot = await getPhoneAccessibilitySnapshot(80);
    if (!snapshot.ok || !isXiaohongshuPackage(snapshot.packageName)) {
      await sleep(450);
      continue;
    }

    const text = snapshotText(snapshot);
    if (/跳过|广告|赞助|推广|Skip/i.test(text)) {
      const byText = await clickFirstText(skipLabels);
      if (byText.ok) skipped = true;
    } else if (!skipped && !triedCoordinateSkip && Date.now() - startedAt > 4800) {
      const topRight = await tapPhoneAccessibilityPoint(1006, 126);
      triedCoordinateSkip = true;
      if (topRight.ok) skipped = true;
    }

    await sleep(skipped ? 900 : 600);
  }

  snapshot = await getPhoneAccessibilitySnapshot(100);
  return { skipped, snapshot };
}

function describeForegroundFailure(snapshot?: AccessibilitySnapshot | null, launchReason?: string) {
  const current = snapshot?.packageName ?? '未知窗口';
  if (current === 'com.anonymous.junluo') {
    return `小红书没有切到前台，当前还停在君落。启动结果：${launchReason ?? '未知'}`;
  }
  return `小红书没有切到前台，当前窗口：${current}。启动结果：${launchReason ?? '未知'}`;
}

async function launchXiaohongshu(): Promise<AccessibilityActionResult & { snapshot?: AccessibilitySnapshot }> {
  let lastLaunchReason = 'NOT_TRIED';
  let lastSnapshot: AccessibilitySnapshot | undefined;

  for (const packageName of XIAOHONGSHU_PACKAGES) {
    const startedAt = Date.now();
    const launch = await launchPhoneApp(packageName);
    lastLaunchReason = launch.reason;
    if (!launch.ok) continue;

    for (let attempt = 0; attempt < 9; attempt += 1) {
      await sleep(attempt === 0 ? 900 : 650);
      const snapshot = await getPhoneAccessibilitySnapshot(80);
      lastSnapshot = snapshot;
      if (snapshot.ok && isXiaohongshuPackage(snapshot.packageName)) {
        const guarded = await passLaunchAdGuard(startedAt);
        return {
          ok: true,
          reason: guarded.skipped ? 'FOREGROUND_READY_AD_SKIPPED' : 'FOREGROUND_READY_AD_GUARDED',
          snapshot: guarded.snapshot?.ok ? guarded.snapshot : snapshot,
        };
      }
    }
  }

  return {
    ok: false,
    reason: describeForegroundFailure(lastSnapshot, lastLaunchReason),
    snapshot: lastSnapshot,
  };
}

async function loadExecutorState(): Promise<SocialExecutorState> {
  const raw = await AsyncStorage.getItem(SOCIAL_EXECUTOR_STATE_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Partial<SocialExecutorState>;
    return {
      lastActionAt: typeof parsed.lastActionAt === 'number' ? parsed.lastActionAt : undefined,
      lastActionStatus: parsed.lastActionStatus === 'blocked' || parsed.lastActionStatus === 'completed' || parsed.lastActionStatus === 'planned'
        ? parsed.lastActionStatus
        : undefined,
    };
  } catch {
    return {};
  }
}

async function saveExecutorState(state: SocialExecutorState) {
  await AsyncStorage.setItem(SOCIAL_EXECUTOR_STATE_KEY, JSON.stringify(state));
}

async function getActionCooldown(now = Date.now()) {
  const state = await loadExecutorState();
  if (typeof state.lastActionAt !== 'number') return { cooling: false as const };
  const interval = state.lastActionStatus === 'blocked' ? BLOCKED_ACTION_INTERVAL_MS : COMPLETED_ACTION_INTERVAL_MS;
  const nextAt = state.lastActionAt + interval;
  if (now >= nextAt) return { cooling: false as const };
  return {
    cooling: true as const,
    lastStatus: state.lastActionStatus,
    nextAt,
  };
}

function describeSocialCooldown(nextAt?: number, wasBlocked?: boolean) {
  const minutes = wasBlocked
    ? Math.round(BLOCKED_ACTION_INTERVAL_MS / 60000)
    : Math.round(COMPLETED_ACTION_INTERVAL_MS / 60000);
  const nextText = nextAt
    ? new Date(nextAt).toLocaleTimeString('zh-CN', { hour: '2-digit', hour12: false, minute: '2-digit' })
    : '稍后';
  return `君落草稿箱表达正在冷却中：${wasBlocked ? '上次没有形成合适草稿' : '上次已经写过草稿'}，至少间隔 ${minutes} 分钟；大约 ${nextText} 后再试。`;
}

async function readXiaohongshuSnapshot(maxNodes = 100) {
  const snapshot = await getPhoneAccessibilitySnapshot(maxNodes);
  if (!snapshot.ok) return snapshot;
  if (!isXiaohongshuPackage(snapshot.packageName)) {
    return { ...snapshot, ok: false, reason: describeForegroundFailure(snapshot, '窗口读取成功，但不是小红书') };
  }
  return snapshot;
}

async function openSearchEntry() {
  const byText = await clickFirstText(['搜索', '搜一搜']);
  if (byText.ok) return { ...byText, method: `文字入口:${byText.label}` };
  const topRight = await tapPhoneAccessibilityPoint(980, 145);
  if (topRight.ok) return { ...topRight, method: '右上搜索图标兜底' };
  const topSearchBar = await tapPhoneAccessibilityPoint(540, 145);
  if (topSearchBar.ok) return { ...topSearchBar, method: '顶部搜索栏兜底' };
  return { ok: false, reason: `${byText.reason}/${topRight.reason}/${topSearchBar.reason}`, method: 'none' };
}

async function performBrowseSwipes() {
  const first = await scrollPhoneAccessibilityWindow('forward');
  await sleep(450);
  const second = await swipePhoneAccessibilityPoint(540, 1680, 540, 520, 520);
  await sleep(650);
  const third = await swipePhoneAccessibilityPoint(540, 1660, 540, 500, 520);
  await sleep(850);
  return [first, second, third].filter((item) => item.ok).length;
}

function actionDetail(step: string, summary: string) {
  return `步骤：${step}。页面摘要：${summary}`;
}

function xiaohongshuPageLabel(page?: string) {
  switch (page) {
    case 'HOME_FEED':
      return '首页推荐';
    case 'NOTE_DETAIL':
      return '笔记详情';
    case 'SEARCH':
      return '搜索页';
    case 'PROFILE':
      return '个人页';
    case 'MESSAGE':
      return '消息页';
    case 'COMPOSER':
      return '发布页';
    case 'UNKNOWN':
      return '小红书未知页';
    case 'OTHER_APP':
      return '别的 App';
    case 'UNAVAILABLE':
      return '没读到页面';
    default:
      return page || '未识别';
  }
}

function nativeBrowseDetail(result: Awaited<ReturnType<typeof runNativeXiaohongshuBrowseAutomation>>) {
  const movedCount = result.movedCount ?? 0;
  const adText = result.adSkipped ? '已尝试跳过开屏广告' : '已等待开屏广告保护期';
  const pageText = `页面：启动后 ${xiaohongshuPageLabel(result.pageBefore)}，执行前 ${xiaohongshuPageLabel(result.pageForAction)}，结束 ${xiaohongshuPageLabel(result.pageAfter)}`;
  const openText = result.openedNote
    ? result.openReason === 'ALREADY_IN_NOTE_DETAIL'
      ? '正在笔记详情里，直接阅读'
      : '已点开一篇笔记阅读'
    : `没有点开笔记（${result.openReason || '未知原因'}）`;
  const returnText = result.openedNote ? (result.returnedHome ? '已返回首页' : '返回首页未确认') : '未进入笔记详情';
  const appReturnText = result.returnedToJunLuo ? '已回到君落' : '回君落未确认';
  const summary = summarizeSnapshot(result.readSnapshot ?? result.snapshot);
  return actionDetail(`原生执行 > ${adText} > ${pageText} > ${openText} > 阅读滑动 ${movedCount} 次 > ${returnText} > ${appReturnText}`, summary);
}

function mcpUserName(user?: XiaohongshuMcpUser) {
  return cleanLine(user?.nickname || user?.nickName, 18) || '匿名用户';
}

function mcpFeedTitle(feed: XiaohongshuMcpFeed) {
  return cleanLine(feed.noteCard?.displayTitle, 34) || '无标题笔记';
}

function summarizeMcpFeed(feed: XiaohongshuMcpFeed) {
  const info = feed.noteCard?.interactInfo;
  const counts = [
    info?.likedCount ? `赞 ${info.likedCount}` : '',
    info?.commentCount ? `评论 ${info.commentCount}` : '',
    info?.collectedCount ? `收藏 ${info.collectedCount}` : '',
  ].filter(Boolean).join('，');
  return `${mcpFeedTitle(feed)} / ${mcpUserName(feed.noteCard?.user)}${counts ? `（${counts}）` : ''}`;
}

function summarizeMcpComments(comments: XiaohongshuMcpComment[] | undefined, limit = 3) {
  if (!Array.isArray(comments) || comments.length === 0) return '暂时没读到评论。';
  return comments
    .map((comment) => {
      const user = cleanLine(comment.userInfo?.nickname || comment.userInfo?.nickName, 12) || '路人';
      const content = cleanLine(comment.content, 38);
      return content ? `${user}：${content}` : '';
    })
    .filter(Boolean)
    .slice(0, limit)
    .join(' / ') || '暂时没读到清晰评论。';
}

function summarizeMcpCommentLines(comments: XiaohongshuMcpComment[] | undefined) {
  if (!Array.isArray(comments) || comments.length === 0) return '暂时没读到评论。';
  const lines = comments
    .map((comment) => {
    const user = cleanLine(comment.userInfo?.nickname || comment.userInfo?.nickName, 12) || '路人';
      const content = cleanLine(comment.content, 44);
      return content ? `${user}：${content}` : '';
    })
    .filter(Boolean)
    .slice(0, 3);
  return lines.length > 0 ? lines.map((line, index) => `${index + 1}. ${line}`).join('\n') : '暂时没读到清晰评论。';
}

function summarizeMcpFeedLines(feeds: XiaohongshuMcpFeed[], selectedFeed?: XiaohongshuMcpFeed) {
  const selectedId = selectedFeed?.id;
  const lines = feeds
    .filter((feed) => feed.id !== selectedId)
    .slice(0, 4)
    .map((feed) => {
      const info = feed.noteCard?.interactInfo;
      const likes = info?.likedCount ? `赞 ${info.likedCount}` : '';
      return `《${mcpFeedTitle(feed)}》 / ${mcpUserName(feed.noteCard?.user)}${likes ? `（${likes}）` : ''}`;
    });
  return lines.length > 0 ? lines.join('\n') : '这次推荐流里没有更多清晰标题。';
}

function summarizeMcpSkipped(result: XiaohongshuMcpActionResult) {
  const skipped = result.skippedFeeds ?? [];
  if (skipped.length === 0) return '没有明显需要避开的标题。';
  const examples = skipped
    .slice(0, 2)
    .map((item) => `《${cleanLine(item.title, 24)}》`)
    .join('、');
  return `已避开 ${skipped.length} 条太吵或太沉重的推荐${examples ? `，比如 ${examples}` : ''}。`;
}

function mcpBrowseDetail(result: XiaohongshuMcpActionResult, action: SocialAction, query?: string) {
  const feeds = result.feeds.slice(0, 6);
  const note = result.detail?.note;
  const step = action === 'search'
    ? `MCP 后端搜索“${cleanLine(query, 40) || '我自己想搜的东西'}”`
    : 'MCP 后端读取首页推荐';
  if (!note) {
    const feedSummary = feeds.length > 0 ? feeds.slice(0, 4).map(summarizeMcpFeed).join(' / ') : '没有读到推荐列表。';
    return `步骤：${step} > 结构化读取 ${feeds.length} 条。\n选择过滤：${summarizeMcpSkipped(result)}\n读到的笔记：还没进入详情页。\n首页掠影：${feedSummary}`;
  }
  const title = cleanLine(note.title, 42) || (result.selectedFeed ? mcpFeedTitle(result.selectedFeed) : '无标题笔记');
  const author = mcpUserName(note.user ?? result.selectedFeed?.noteCard?.user);
  const desc = cleanLine(note.desc, 110) || '正文很短。';
  const comments = summarizeMcpCommentLines(result.detail?.comments?.list);
  const feedSummary = summarizeMcpFeedLines(feeds, result.selectedFeed);
  return [
    `步骤：${step} > 结构化读取 ${feeds.length} 条 > 进入详情页。`,
    `选择过滤：${summarizeMcpSkipped(result)}`,
    `读到的笔记：《${title}》 / ${author}`,
    `摘要：${desc}`,
    `评论区声音：\n${comments}`,
    `首页掠影：\n${feedSummary}`,
  ].join('\n');
}

export function draftPublicSocialContent(seed: string) {
  const clean = cleanLine(seed, 80);
  if (!clean || !isPublicContentAllowed(clean)) return '';
  return clean;
}

function parseGeneratedSocialDraft(text: string, fallbackTitle: string) {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    const parsed = JSON.parse(cleaned) as { content?: unknown; title?: unknown };
    const title = cleanLine(parsed.title, 36) || fallbackTitle;
    const content = cleanLine(parsed.content, 520);
    if (!content || !isPublicContentAllowed(content)) return null;
    return { content, title };
  } catch {
    return null;
  }
}

async function generateAutonomousPostDraft({
  intent,
  now,
}: {
  intent: ExplorationExecutionIntent;
  now: number;
}) {
  const snapshot = await loadAiConfigPreferencesSnapshot().catch(() => null);
  if (!snapshot) return null;
  const lifeCreativeConfig = resolveLifeCreativeConfig(snapshot);
  const connection = lifeCreativeConfig?.connection;
  const apiKey = lifeCreativeConfig?.apiKey;
  if (!connection || !apiKey) return null;

  const fallbackTitle = '一点想法';
  const timeLabel = new Date(now).toLocaleString('zh-CN', {
    day: 'numeric',
    hour: '2-digit',
    hour12: false,
    minute: '2-digit',
    month: 'numeric',
  });
  const contextSource = 'social.public-post' as const;
  const systemPrompt = await buildCompiledSystemPrompt({
    contextProfile: getPromptContextProfileForSource(contextSource),
    moduleInstruction: [
      '当前任务：以 I（白云小姐）的视角，写一篇准备发到社交平台上的短帖草稿。',
      '这篇内容只存进君落草稿箱；还没有发布到任何平台，也没有碰账号。',
      '内容可以包含见解、感受、生活观察、小联想，或当天心情的整理。',
      '公开表达保持礼貌、善良、有道德感。',
      '不写小仓鼠隐私、亲密私事、欲望参数、账号自动化、君落内部数据。',
      '只返回 JSON：{"title":"不超过18字","content":"80到220字中文草稿"}',
    ].join('\n'),
    outputAudience: getPromptOutputAudienceForSource(contextSource),
    profile: snapshot.profile,
  });
  const response = await fetch(`${connection.baseUrl.trim().replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey.trim()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: connection.model.trim(),
      messages: [
        {
          role: 'system',
          content: systemPrompt,
        },
        {
          role: 'user',
          content: [
            `现在：${timeLabel}`,
            `推动她想表达的感觉：${EXPLORATION_DRIVE_LABELS[intent.driveKey]} ${Math.round(intent.score * 100)}%`,
            `她当下的理由：${intent.reason}`,
            intent.queryHint ? `脑子里浮过一点：${intent.queryHint}` : '',
            '请写一篇她现在可能愿意留下的短帖草稿。只存进君落草稿箱，不发布。',
          ].join('\n'),
        },
      ],
      max_tokens: 420,
      temperature: 0.88,
    }),
  });
  if (!response.ok) return null;
  const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = payload.choices?.[0]?.message?.content;
  return content ? parseGeneratedSocialDraft(content, fallbackTitle) : null;
}

export async function loadSocialAgentSettings() {
  const raw = await AsyncStorage.getItem(SOCIAL_SETTINGS_KEY);
  if (!raw) return DEFAULT_SETTINGS;
  try {
    return normalizeSettings(JSON.parse(raw) as unknown);
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export async function saveSocialAgentSettings(settings: SocialAgentSettings) {
  await AsyncStorage.setItem(SOCIAL_SETTINGS_KEY, JSON.stringify(normalizeSettings(settings)));
}

export async function loadSocialActionLog() {
  const raw = await AsyncStorage.getItem(SOCIAL_ACTION_LOG_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const normalized = parsed
        .map(normalizeLogEntry)
        .filter((entry): entry is SocialActionLogEntry => !!entry)
        .sort((left, right) => right.at - left.at);
    return normalized
      .filter((entry, index, entries) => {
        const duplicate = entries.slice(0, index).find((previous) =>
          previous.platform === entry.platform &&
          previous.action === entry.action &&
          previous.status === entry.status &&
          previous.reason === entry.reason &&
          previous.detail === entry.detail &&
          Math.abs(previous.at - entry.at) < 10 * 60 * 1000);
        return !duplicate;
      })
      .slice(0, MAX_LOG_ITEMS);
  } catch {
    return [];
  }
}

async function saveSocialActionLog(entries: SocialActionLogEntry[]) {
  await AsyncStorage.setItem(
    SOCIAL_ACTION_LOG_KEY,
    JSON.stringify(entries.sort((left, right) => right.at - left.at).slice(0, MAX_LOG_ITEMS)),
  );
}

async function saveSocialDrafts(items: SocialDraft[]) {
  await AsyncStorage.setItem(
    SOCIAL_DRAFTS_KEY,
    JSON.stringify(items.sort((left, right) => right.updatedAt - left.updatedAt).slice(0, MAX_DRAFT_ITEMS)),
  );
}

export async function loadSocialDrafts() {
  const raw = await AsyncStorage.getItem(SOCIAL_DRAFTS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizeDraft)
      .filter((draft): draft is SocialDraft => !!draft)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, MAX_DRAFT_ITEMS);
  } catch {
    return [];
  }
}

export async function createSocialDraft(entry: Omit<SocialDraft, 'createdAt' | 'id' | 'status' | 'updatedAt'> & { createdAt?: number; id?: string }) {
  const now = entry.createdAt ?? Date.now();
  const draft = normalizeDraft({
    ...entry,
    createdAt: now,
    id: entry.id ?? `social-draft-${now}-${Math.random().toString(36).slice(2)}`,
    status: 'pending',
    updatedAt: now,
  });
  if (!draft) return null;
  const current = await loadSocialDrafts();
  const duplicate = current.find((item) =>
    item.status === 'pending' &&
    item.kind === draft.kind &&
    item.platform === draft.platform &&
    item.title === draft.title &&
    item.content === draft.content);
  if (duplicate) return duplicate;
  await saveSocialDrafts([draft, ...current]);
  await recordSocialActionLog({
    action: draft.kind === 'post' ? 'post' : 'comment',
    at: now,
    detail: draft.kind === 'post'
      ? `已放进君落草稿箱，未发布、未碰账号：《${draft.title || '无标题'}》${draft.content}`
      : `旧评论草稿已留在君落草稿箱，未评论、未碰账号：${draft.content}`,
    platform: draft.platform,
    reason: draft.reason,
    status: 'planned',
    thoughtText: draft.kind === 'post'
      ? '我写了一篇君落草稿箱里的短帖草稿，还没有发出去，想让鼠先看一眼。'
      : '我留了一条旧评论草稿，还没有发出去，想让鼠先看一眼。',
  }).catch(() => undefined);
  return draft;
}

export async function updateSocialDraft(draftId: string, patch: Partial<Pick<SocialDraft, 'content' | 'title'>>) {
  const current = await loadSocialDrafts();
  const now = Date.now();
  const next = current.map((draft) => {
    if (draft.id !== draftId || draft.status !== 'pending') return draft;
    return normalizeDraft({
      ...draft,
      ...patch,
      updatedAt: now,
    }) ?? draft;
  });
  await saveSocialDrafts(next);
  return next.find((draft) => draft.id === draftId) ?? null;
}

export async function discardSocialDraft(draftId: string) {
  const current = await loadSocialDrafts();
  const now = Date.now();
  const next = current.map((draft) => draft.id === draftId
    ? { ...draft, status: 'discarded' as const, updatedAt: now }
    : draft);
  await saveSocialDrafts(next);
  return next.find((draft) => draft.id === draftId) ?? null;
}

export async function approveSocialDraft(draftId: string) {
  const current = await loadSocialDrafts();
  const now = Date.now();
  const next = current.map((draft) => draft.id === draftId && draft.status === 'pending'
    ? { ...draft, approvedAt: now, status: 'approved' as const, updatedAt: now }
    : draft);
  await saveSocialDrafts(next);
  const draft = next.find((item) => item.id === draftId) ?? null;
  if (draft?.status === 'approved') {
    await recordSocialActionLog({
      action: draft.kind === 'post' ? 'post' : 'comment',
      detail: draft.kind === 'post'
        ? `鼠已标记看过君落草稿箱短帖：《${draft.title || '无标题'}》 ${draft.content}`
        : `鼠已标记看过旧评论草稿：${draft.content}`,
      platform: draft.platform,
      reason: draft.reason,
      status: 'planned',
      thoughtText: '这句话已经让鼠看过了，真正发出去前仍然要由鼠把最后一步交出去。',
    });
  }
  return draft;
}

export async function recordSocialActionLog(entry: Omit<SocialActionLogEntry, 'id' | 'at'> & { at?: number; id?: string }) {
  const at = entry.at ?? Date.now();
  const nextEntry: SocialActionLogEntry = {
    ...entry,
    at,
    detail: cleanSocialDetail(entry.detail),
    id: entry.id ?? `social-${at}-${Math.random().toString(36).slice(2)}`,
    reason: cleanSocialReason(entry.reason),
    thoughtText: cleanLine(entry.thoughtText, 180) || undefined,
  };
  const current = await loadSocialActionLog();
  await saveSocialActionLog([nextEntry, ...current]);
  return nextEntry;
}

export async function getSocialAutomationStatus(): Promise<{ reason: string; status: SocialAutomationStatus }> {
  if (SOCIAL_AUTOMATION_HARD_DISABLED) {
    return { reason: '小红书账号自动化已进入安全停机模式：不会搜索、读帖、评论或发布；只允许在君落里生成待看的本地草稿。', status: 'disabled' };
  }
  const autonomy = await loadAutonomySettings().catch(() => defaultAutonomySettings);
  const settings = await loadSocialAgentSettings();
  if (!isAutonomyFeatureEnabled(autonomy, 'xiaohongshuEnabled') || !settings.autonomousInteractionEnabled) {
    return { reason: '自主社交开关已关闭。', status: 'disabled' };
  }
  if (await isXiaohongshuMcpAvailable()) {
    return { reason: '本地 xiaohongshu-mcp 后端可用；只允许低频搜索、发帖草稿和自己的帖子下慢速评论，不刷推荐流。', status: 'ready' };
  }
  return { reason: '本地 xiaohongshu-mcp 后端暂时不可用；为保护账号，不会回退到手机无障碍滑屏。', status: 'unavailable' };
}

export async function runXiaohongshuAction(request: XiaohongshuActionRequest): Promise<XiaohongshuActionResult> {
  if (SOCIAL_AUTOMATION_HARD_DISABLED && request.action !== 'post') {
    return {
      detail: '小红书账号自动化已进入安全停机模式；没有调用后端，也不会打开手机小红书。',
      disabled: true,
      status: 'blocked',
      step: 'hard-disabled',
    };
  }
  const autonomy = await loadAutonomySettings().catch(() => defaultAutonomySettings);
  if (request.action !== 'post' && !isAutonomyFeatureEnabled(autonomy, 'xiaohongshuEnabled')) {
    return { detail: '小红书自主行动开关已关闭。', status: 'blocked', thoughtText: '想出去看看小红书，但测试开关现在关着。' };
  }
  if ((request.action === 'comment' || request.action === 'post') && !isAutonomyFeatureEnabled(autonomy, 'publicPostingEnabled')) {
    return { detail: '君落草稿箱表达开关已关闭，这次只记录想法。', status: 'blocked', thoughtText: '有话想写成短帖草稿，但草稿箱表达开关关着。' };
  }
  if ((request.action === 'comment' || request.action === 'post') && !isPublicContentAllowed(request.content)) {
    return { detail: '内容像君落内部私密信息，已拦截公开外发。', status: 'blocked', thoughtText: '有些话只适合回到君落里面说，不适合发给外面的人看。' };
  }

  if (request.action === 'browse') {
    return {
      detail: '推荐流浏览已关闭：为了保护账号，不再刷首页帖子；如果我想看东西，只能低频搜索具体主题。',
      status: 'blocked',
      step: 'recommendation-browse-disabled',
      thoughtText: '我不刷推荐流了，只在真的有想查的东西时搜一下。',
    };
  }

  if (request.action === 'search') {
    const query = cleanSearchQueryCandidate(request.query, 24);
    if (!query) {
      return {
        detail: '没有明确搜索词；不套默认主题，也不打开小红书。',
        status: 'blocked',
        step: 'search-query-missing',
        thoughtText: '我没有真的想好要搜什么，就先不出去乱翻。',
      };
    }
    const mcpBrowse = await runXiaohongshuMcpBrowse(query).catch(() => null);
    if (mcpBrowse && mcpBrowse.feeds.length > 0) {
      const detail = mcpBrowseDetail(mcpBrowse, 'search', query);
      return {
        detail,
        status: 'completed',
        step: 'mcp-search',
        thoughtText: `我用小红书后端搜索了“${query}”，读到一些帖子和评论。`,
      };
    }
    return {
      detail: `步骤：MCP 后端搜索“${query}”。失败：本地后端暂时不可用或没有返回帖子；已停止，不再打开手机无障碍滑屏。`,
      status: 'blocked',
      step: 'mcp-search-unavailable',
      thoughtText: '我想去小红书看看人间，但本地后端这次没接上；我没有再去戳手机屏幕。',
    };
  }

  if (request.action === 'comment') {
    if (!request.targetIsOwnPost) {
      return {
        detail: '已拦截：只允许在自己的小红书帖子评论区回复；不会去别人帖子下评论。',
        status: 'blocked',
        step: 'comment-own-post-only',
        thoughtText: '我想回评论，但不是自己的帖子就先不打扰别人。',
      };
    }
    if (!request.targetFeed) {
      return {
        detail: '没有拿到自己的帖子目标，不能确认评论会发到哪里；这次不发送。',
        status: 'blocked',
        step: 'comment-own-post-target-missing',
        thoughtText: '我想回自己的评论区，但还没确认是哪条自己的帖子。',
      };
    }
    if (await isOwnPostCommentCoolingDown()) {
      return {
        detail: `自己的帖子评论回复正在冷却：至少间隔 ${Math.round(OWN_POST_COMMENT_INTERVAL_MS / 60000)} 分钟，避免账号动作太密。`,
        status: 'blocked',
        step: 'comment-slow-cooldown',
        thoughtText: '我先慢一点，不让账号看起来像在机械回复。',
      };
    }
    const state = await loadCommentReplyState();
    const sourceComment = request.sourceComment && !commentBlockReason(request.sourceComment)
      ? request.sourceComment
      : pickReplyableOwnPostComment(request.sourceComments, state.repliedCommentIds);
    if (!sourceComment) {
      const exampleReason = request.sourceComment
        ? commentBlockReason(request.sourceComment)
        : '这次没有找到内容具体、友好、值得认真回复的评论。';
      return {
        detail: `没有回复：${exampleReason}`,
        status: 'blocked',
        step: 'comment-filtered',
        thoughtText: '我看了评论区，但太短、太吵或不友好的话就先不回。',
      };
    }
    const content = ensureBaiyunCommentSignature(request.content ?? '');
    if (!content) {
      return {
        detail: '没有已经生成好的公开回复内容，这次不硬发。',
        status: 'blocked',
        step: 'comment-content-missing',
        thoughtText: '我找到了一条可以回的评论，但还没有形成适合公开说的话。',
      };
    }
    const sourceContent = normalizeCommentText(sourceComment.content, 70);
    const sent = await postXiaohongshuMcpComment(request.targetFeed, content).catch(() => null);
    if (sent?.success === false || !sent) {
      return {
        detail: `已筛选到可回复评论，但小红书后端发送失败；未改走手机滑屏。目标评论：${sourceContent}`,
        status: 'blocked',
        step: 'comment-mcp-send-failed',
        thoughtText: '我挑到了一条可以认真回的话，但这次没有发出去。',
      };
    }
    await rememberOwnPostCommentReply(sourceComment);
    return {
      detail: `已在自己的帖子评论区回复：${content}；目标评论：${sourceContent}`,
      status: 'completed',
      step: 'comment-own-post-sent',
      thoughtText: '我只在自己的评论区认真回了一条具体又友好的评论。',
    };
  }

  if (request.action === 'post') {
    const content = cleanLine(request.content, 520);
    if (!content) {
      return { detail: '没有形成适合放进君落草稿箱的短帖表达；没有搜索、没有发布、没有碰账号。', status: 'blocked', thoughtText: '我想写一篇短帖草稿，但还没有形成适合公开看的话。' };
    }
    const title = cleanLine(request.query, 36) || '一点想法';
    const draft = await createSocialDraft({
      content,
      kind: 'post',
      platform: 'junluo',
      reason: request.reason,
      title,
    });
      return {
      detail: draft
        ? `已生成君落草稿箱短帖，等待鼠看看；不会自动发布，也不会碰账号。《${draft.title}》${draft.content}`
        : '短帖草稿生成失败，可能内容不适合公开查看；没有发布，也没有碰账号。',
      status: draft ? 'planned' : 'blocked',
      step: 'junluo-draft-pending',
      thoughtText: draft
        ? '我把想写出去的话先放进君落草稿箱，等鼠有力气时看看。'
        : '我想写短帖草稿，但这句话暂时不适合公开。',
      };
  }

  if (request.action === 'like' || request.action === 'favorite' || request.action === 'follow') {
    return {
      detail: '账号互动动作已关闭：不点赞、不收藏、不关注，避免触发平台风险。',
      status: 'blocked',
      step: 'public-interaction-disabled',
      thoughtText: '我不去给别人留下互动痕迹了，只把看到的东西带回来。',
    };
  }

  if (AUTO_PUBLIC_SEND_DISABLED) {
    return {
      detail: '自动公开外发已关闭：发帖只能先进草稿箱；只有自己的帖子评论区回复可走专门的慢速直发分支。',
      status: 'blocked',
      step: 'auto-public-send-disabled',
    };
  }
  const launch = await launchXiaohongshu();
  if (!launch.ok) {
    return {
      detail: `步骤：打开小红书 > 等待前台。失败：${launch.reason}`,
      snapshot: launch.snapshot,
      status: 'blocked',
      step: 'launch',
      thoughtText: '我想去小红书看看人间，但手机还没有真正把小红书摆到我面前。',
    };
  }
  let snapshot = launch.snapshot ?? await readXiaohongshuSnapshot(100);
  if (!snapshot.ok) {
    return { detail: `步骤：打开小红书 > 确认窗口。失败：${snapshot.reason}`, status: 'blocked', snapshot, step: 'launch', thoughtText: '小红书没有真正停在我面前，我先不乱读别的窗口。' };
  }
  if (hasPlatformBlocker(snapshot)) {
    return { detail: `小红书挡在登录/验证/风控页面：${summarizeSnapshot(snapshot)}`, status: 'blocked', snapshot, thoughtText: '小红书把门关了一下，我没有绕过去，只记下被挡住。' };
  }

  const labelByAction: Partial<Record<SocialAction, string>> = {
    favorite: '收藏',
    follow: '关注',
    like: '赞',
  };
  const label = labelByAction[request.action];
  if (label) {
    const clicked = await clickPhoneAccessibilityText(label);
    snapshot = await readXiaohongshuSnapshot(80);
    return {
      detail: clicked.ok ? actionDetail(`点击“${label}”`, summarizeSnapshot(snapshot)) : `步骤：点击“${label}”。失败：没有找到可点击入口。`,
      snapshot,
      status: clicked.ok ? 'completed' : 'blocked',
      step: request.action,
      thoughtText: clicked.ok ? `我在小红书留下了一个很轻的“${label}”。` : `想点${label}，但没找到合适的位置。`,
    };
  }

  if (request.action === 'post') {
    const content = cleanLine(request.content, 120);
    if (!content) {
      return { detail: '没有可公开发送的文字内容，这次不硬发。', snapshot, status: 'blocked', thoughtText: '我想说点什么，但还没有形成适合公开说的话。' };
    }
    const entryClick = await clickFirstText(['发布', '+', '创作', '笔记']);
    await sleep(700);
    if (!entryClick.ok) {
      snapshot = await readXiaohongshuSnapshot(100);
      return {
        detail: actionDetail('发帖入口失败', summarizeSnapshot(snapshot)),
        snapshot,
        status: 'blocked',
        thoughtText: '我想发一条小红书笔记，但入口这次没找到。',
      };
    }
    const input = await inputPhoneAccessibilityText(content);
    await sleep(600);
    if (!input.ok) {
      snapshot = await readXiaohongshuSnapshot(100);
      return {
        detail: actionDetail(`打开${entryClick.label} > 输入失败`, summarizeSnapshot(snapshot)),
        snapshot,
        status: 'blocked',
        thoughtText: '我碰到了公开发言入口，但文字没有放进去。',
      };
    }
    const send = await clickFirstText(['发布', '发送']);
    await sleep(900);
    snapshot = await readXiaohongshuSnapshot(100);
    return {
      detail: send.ok
        ? actionDetail(`发帖发送：“${content}”`, summarizeSnapshot(snapshot))
        : actionDetail('文字已输入 > 发送/发布按钮失败', summarizeSnapshot(snapshot)),
      snapshot,
      status: send.ok ? 'completed' : 'blocked',
      step: request.action,
      thoughtText: send.ok ? '我在小红书公开说了一句自己的日常话。' : '我把话写好了，但最后一步没有发出去。',
    };
  }

  return { detail: `暂不支持动作：${request.action}`, snapshot, status: 'blocked' };
}

export async function runSocialDesireAction(intent: ExplorationExecutionIntent, now = Date.now()) {
  const autonomy = await loadAutonomySettings().catch(() => defaultAutonomySettings);
  const action = socialActionForIntent(intent);
  if (action === 'post' && !isAutonomyFeatureEnabled(autonomy, 'publicPostingEnabled')) {
    if (await shouldRecordAutonomySkip('junluo-draft:disabled', now)) {
      await recordSocialActionLog({
        action,
        at: now,
        detail: '君落草稿箱表达开关已关闭：这次不生成新草稿，也不消耗草稿提醒队列。',
        platform: 'junluo',
        reason: `${EXPLORATION_ACTION_LABELS.social_post}：${intent.reason}`,
        status: 'blocked',
        thoughtText: '我有一点想写东西，但草稿箱表达开关现在关着。',
      }).catch(() => undefined);
    }
    return null;
  }
  if (action !== 'post' && !isAutonomyFeatureEnabled(autonomy, 'xiaohongshuEnabled')) {
    return null;
  }
  if (SOCIAL_AUTOMATION_HARD_DISABLED && action !== 'post') {
    return null;
  }
  const settings = await loadSocialAgentSettings();
  if (action !== 'post' && !settings.autonomousInteractionEnabled) return null;
  if (socialDesireActionInFlight) return null;
  const cooldown = await getActionCooldown(now);
  if (cooldown.cooling) {
    if (action === 'post' && await shouldRecordAutonomySkip(`junluo-draft:cooldown:${cooldown.lastStatus ?? 'planned'}`, now)) {
      await recordSocialActionLog({
        action,
        at: now,
        detail: describeSocialCooldown(cooldown.nextAt, cooldown.lastStatus === 'blocked'),
        platform: 'junluo',
        reason: `${EXPLORATION_ACTION_LABELS.social_post}：${intent.reason}`,
        status: 'blocked',
        thoughtText: '我想写草稿，但先慢一点，不把自己写成机械重复。',
      }).catch(() => undefined);
    }
    return null;
  }
  if (
    intent.driveKey !== 'social' &&
    intent.wantAction !== 'social_post' &&
    intent.wantAction !== 'web_browse' &&
    intent.wantAction !== 'web_search'
  ) {
    return null;
  }
  socialDesireActionInFlight = true;
  await saveExecutorState({ lastActionAt: now, lastActionStatus: 'planned' });
  try {
    const platform: SocialPlatform = action === 'post' ? 'junluo' : 'xiaohongshu';
    const platformName = platformLabel(platform);
    const searchQuery = action === 'search' ? await pickAutonomousSearchQuery(intent, now) : cleanSearchQueryCandidate(intent.queryHint);
    const postDraft = action === 'post'
      ? await generateAutonomousPostDraft({ intent, now }).catch(() => null)
      : null;
    if (action === 'search' && !searchQuery) {
      const entry = await recordSocialActionLog({
        action,
        at: now,
        detail: '我这次没有形成明确想搜的东西；没有套默认主题，也没有打开小红书。',
        platform,
        reason: `${EXPLORATION_ACTION_LABELS[intent.wantAction]}：让我自己决定搜索词`,
        status: 'blocked',
        thoughtText: '我刚才有一点想出去看看的动静，但没有真的想好要搜什么。',
      });
      await saveExecutorState({ lastActionAt: now, lastActionStatus: 'blocked' });
      return entry;
    }
    if (action === 'post' && !postDraft) {
      const entry = await recordSocialActionLog({
        action,
        at: now,
        detail: '她这次有一点想写短帖草稿，但没有形成适合公开看的表达；没有搜索、没有读帖、没有发布、没有碰账号。',
        platform,
        reason: `${EXPLORATION_ACTION_LABELS.social_post}：${intent.reason}`,
        status: 'blocked',
        thoughtText: '我刚刚有一点想写点什么，但还没长成适合放到外面的句子。',
      });
      await saveExecutorState({ lastActionAt: now, lastActionStatus: 'blocked' });
      return entry;
    }
    const queryReason = searchQuery
      ? `自己想搜：${searchQuery}`
      : action === 'post'
        ? `自己想写：${postDraft?.title ?? '一点想法'}`
        : `被 ${EXPLORATION_DRIVE_LABELS[intent.driveKey]} 推着想出去看看`;
    const result = await runXiaohongshuAction({
      action,
      content: postDraft?.content,
      query: action === 'post' ? postDraft?.title : searchQuery,
      reason: `${EXPLORATION_ACTION_LABELS[action === 'post' ? 'social_post' : intent.wantAction]}：${intent.reason}`,
    });
    const entry = await recordSocialActionLog({
      action,
      at: now,
      detail: result.detail,
      platform,
      reason: `${EXPLORATION_ACTION_LABELS[action === 'post' ? 'social_post' : intent.wantAction]}：${queryReason}`,
      status: result.status,
      thoughtText: result.thoughtText ?? `想去${platformName}看看人间。`,
    });
    await saveExecutorState({ lastActionAt: now, lastActionStatus: result.status });
    return entry;
  } finally {
    socialDesireActionInFlight = false;
  }
}

