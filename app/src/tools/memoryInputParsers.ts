export type MemoryIntentRoute = {
  candidateTools: string[];
  reason:
    | 'memory_search'
    | 'memory_get'
    | 'memory_update_requires_search'
    | 'memory_update'
    | 'memory_link'
    | 'memory_query_links'
    | 'memory_update_preference'
    | 'memory_delete_unsupported';
};

const MEMORY_ID_PATTERN = /memory-[0-9]+-[a-z0-9]+/gi;
const MEMORY_TEXT_PATTERN = /记忆|记得|记住|记下|以前|之前|上次|过去|偏好|喜欢|不喜欢|讨厌|称呼|边界|约定/;
const MEMORY_SEARCH_PATTERN = /(?:查|搜索|搜|找|翻|看看|看一下).{0,18}(?:记忆|记忆里|记忆本)|(?:你记得我什么|记忆里有没有|我以前说过什么|为什么你记得|为什么会记得|你为什么记得|查一下记忆)/;
const MEMORY_GET_PATTERN = /(?:看|读取|打开|详情|来源|原文|怎么来的).{0,24}(?:这条记忆|记忆|memory-)|(?:这条记忆).{0,16}(?:来源|原文|怎么来的|详情)/;
const MEMORY_UPDATE_PATTERN = /(?:修改|更新|改掉|改成|修正|纠正).{0,24}(?:记忆|这条记忆|memory-)|(?:这条记忆).{0,18}(?:错了|不对|改成|更新为|修正)/;
const MEMORY_LINK_PATTERN = /(?:连接|关联|连起来|建立关系|有关系).{0,30}(?:记忆|两条|memory-)|(?:这两条记忆).{0,16}(?:有关|连起来|关联)/;
const MEMORY_QUERY_LINKS_PATTERN = /(?:记忆).{0,16}(?:关系线|关联记忆|相关记忆|连着哪些)|(?:memory-[0-9]+-[a-z0-9]+).{0,20}(?:关系|关联|连着)/i;
const MEMORY_UPDATE_PREFERENCE_PATTERN = /(?:记住|更新|保存|记录).{0,18}(?:我的)?(?:偏好|喜好|不喜欢|讨厌|称呼|边界|约定)|(?:以后|今后).{0,8}(?:我|鼠|小仓鼠).{0,20}(?:更喜欢|不喜欢|讨厌|叫我|不要|别)/;
const MEMORY_DELETE_PATTERN = /(?:删除|删掉|移除|清掉).{0,18}(?:记忆|这条记忆|memory-)/;

export function parseMemoryIdsFromText(text: string) {
  return Array.from(new Set(text.match(MEMORY_ID_PATTERN)?.map((item) => item.toLowerCase()) ?? []));
}

export function routeMemoryIntent(text: string): MemoryIntentRoute | null {
  const trimmed = text.trim();
  if (!trimmed || !MEMORY_TEXT_PATTERN.test(trimmed)) return null;
  const ids = parseMemoryIdsFromText(trimmed);
  if (MEMORY_DELETE_PATTERN.test(trimmed)) return { candidateTools: [], reason: 'memory_delete_unsupported' };
  if (MEMORY_LINK_PATTERN.test(trimmed)) {
    return ids.length >= 2
      ? { candidateTools: ['memory.link'], reason: 'memory_link' }
      : { candidateTools: ['memory.search'], reason: 'memory_update_requires_search' };
  }
  if (MEMORY_QUERY_LINKS_PATTERN.test(trimmed)) {
    return ids.length
      ? { candidateTools: ['memory.query_links'], reason: 'memory_query_links' }
      : { candidateTools: ['memory.search'], reason: 'memory_search' };
  }
  if (MEMORY_GET_PATTERN.test(trimmed) && ids.length) return { candidateTools: ['memory.get'], reason: 'memory_get' };
  if (MEMORY_UPDATE_PATTERN.test(trimmed)) {
    return ids.length
      ? { candidateTools: ['memory.update'], reason: 'memory_update' }
      : { candidateTools: ['memory.search'], reason: 'memory_update_requires_search' };
  }
  if (MEMORY_UPDATE_PREFERENCE_PATTERN.test(trimmed)) {
    return { candidateTools: ['memory.update_preference'], reason: 'memory_update_preference' };
  }
  if (MEMORY_SEARCH_PATTERN.test(trimmed)) return { candidateTools: ['memory.search'], reason: 'memory_search' };
  return null;
}

export function parseMemorySearchInputFromText(text: string): Record<string, unknown> {
  const cleaned = text
    .replace(/(?:帮我|请|一下|查|搜索|搜|找|翻|看看|看一下|记忆里|记忆本|记忆|你记得|我以前说过|为什么你记得|为什么会记得|你为什么记得)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return {
    includeSourceTrace: /来源|原文|为什么|怎么来的|以前说过什么/.test(text),
    limit: 6,
    query: cleaned || text.trim(),
  };
}

export function parseMemoryGetInputFromText(text: string): Record<string, unknown> | null {
  const memoryId = parseMemoryIdsFromText(text)[0];
  if (!memoryId) return null;
  return {
    includeComments: /补记|评论|详情|全部/.test(text),
    includeLinks: /关系|关联|连着|相关|全部/.test(text),
    includeSourceTrace: /来源|原文|怎么来的|为什么|全部/.test(text),
    memoryId,
  };
}

export function parseMemoryUpdateInputFromText(text: string): Record<string, unknown> | null {
  const memoryId = parseMemoryIdsFromText(text)[0];
  if (!memoryId) return null;
  const content = /(?:改成|更新为|修正为|内容为|正文为)[：:]?\s*([\s\S]+)$/.exec(text)?.[1]?.trim();
  const title = /(?:标题为|标题改成|改名为)[：:]?\s*([^，。！？\n]{1,40})/.exec(text)?.[1]?.trim();
  const input: Record<string, unknown> = { memoryId };
  if (content) input.content = content;
  if (title) input.title = title;
  return input;
}

export function parseMemoryLinkInputFromText(text: string): Record<string, unknown> | null {
  const ids = parseMemoryIdsFromText(text);
  if (ids.length < 2) return null;
  const relationType = /矛盾|冲突/.test(text)
    ? 'contradicts'
    : /更新|替代|修正/.test(text)
      ? 'updates'
      : /支持|证明/.test(text)
        ? 'supports'
        : /承诺|约定/.test(text)
          ? 'promises'
          : 'relates_to';
  return {
    confidence: 0.7,
    reason: text.slice(0, 120),
    relationType,
    sourceMemoryId: ids[0],
    targetMemoryId: ids[1],
  };
}

export function parseMemoryQueryLinksInputFromText(text: string): Record<string, unknown> | null {
  const memoryId = parseMemoryIdsFromText(text)[0];
  return memoryId ? { memoryId, limit: 8, minConfidence: 0 } : null;
}

export function parseMemoryPreferenceInputFromText(text: string): Record<string, unknown> {
  const memoryId = parseMemoryIdsFromText(text)[0];
  const preferenceKind = /不喜欢|讨厌|不想|不要|别/.test(text)
    ? 'dislike'
    : /边界|不能接受|不可以/.test(text)
      ? 'boundary'
      : /称呼|叫我|名字|昵称/.test(text)
        ? 'name'
        : /约定|说好|承诺/.test(text)
          ? 'promise'
          : /身份|我是/.test(text)
            ? 'identity'
            : /喜欢|偏好|更爱/.test(text)
              ? 'like'
              : 'other';
  const content = text
    .replace(/(?:帮我|请|记住|更新|保存|记录|我的|偏好|喜好|以后|今后)/g, ' ')
    .replace(MEMORY_ID_PATTERN, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return {
    content: content || text.trim(),
    memoryId,
    preferenceKind,
    reason: '用户在聊天中明确要求更新偏好',
  };
}