import { searchSimilarMemoryIds, searchSimilarMemoryTargets } from './memoryEmbedding';
import { loadMemoryCurrentStates, type MemoryCurrentState } from './memoryCurrentStateStore';
import {
  buildMemoryRecall as buildLocalMemoryRecall,
  type MemoryEntry,
  type MemoryTextCandidateScore,
  searchMemoryTextCandidates,
} from './memoryStore';
import type { MemoryRecallRouteMode } from './memoryRecallRouter';
import type { MemoryMaterialPreparation } from './memoryCurrentMaterials';
import { shiyingRecallCandidates, selectShiyingRecall, type ShiyingRecallSelection } from './memoryShiyingRecall';
import { postRecallCandidates, selectPostRecall, type PostRecallSelection } from './memoryPostRecall';

export type StructuredMemoryQuery = {
  userText: string;
  sourceHints?: string;
  activeContext?: string;
  recallMode?: MemoryRecallRouteMode;
};

type NormalizedMemoryQuery = {
  lexicalQuery: string;
  semanticQuery: string;
  hintQuery: string;
};

export type CurrentStateRecallSelection = { items: MemoryCurrentState[] };
export const CURRENT_STATE_TEXT_THRESHOLD = 0.24;
const CURRENT_STATE_SEMANTIC_THRESHOLD = 0.62;
export type MemoryRecallOptions = {
  readOnly?: boolean;
  memoryWorkReporter?: import('./memoryDatabaseWrites').MemoryRecallWorkReporter;
  allowRerank?: boolean;
  currentStateSelection?: CurrentStateRecallSelection;
  shiyingSelection?: ShiyingRecallSelection;
  postSelection?: PostRecallSelection;
  throwOnError?: boolean;
  materialPreparation?: MemoryMaterialPreparation;
  diagnosticParentToken?: number;
  maxResults?: number;
  memories?: readonly MemoryEntry[];
  signal?: AbortSignal;
  touch?: boolean;
  collectBackgroundCandidates?: boolean;
};

async function currentStateCandidates(selection: CurrentStateRecallSelection | undefined, options: MemoryRecallOptions) {
  if (!selection) return [];
  const items: MemoryCurrentState[] = [];
  for (;;) {
    throwIfMemoryRecallAborted(options.signal);
    const page = await loadMemoryCurrentStates({ limit: 100, offset: items.length, currentOnly: true },
      { signal: options.signal, reporter: options.memoryWorkReporter });
    throwIfMemoryRecallAborted(options.signal);
    items.push(...page);
    if (page.length < 100) return items;
  }
}

export function scoreCurrentStateText(state: MemoryCurrentState, query: string) {
  const text = `${state.title}\n${state.content}`.toLocaleLowerCase();
  const tokens = [...new Set(query.toLocaleLowerCase().match(/[a-z0-9_]{2,}|[\p{Script=Han}]{2,}/gu) ?? [])];
  let matched = 0, total = 0;
  for (const token of tokens) {
    const parts = /\p{Script=Han}/u.test(token) ? Array.from({ length: token.length - 1 }, (_, index) => token.slice(index, index + 2)) : [token];
    for (const part of parts) { total++; if (text.includes(part)) matched++; }
  }
  return total ? matched / total : 0;
}

function selectCurrentStates(selection: CurrentStateRecallSelection | undefined, candidates: MemoryCurrentState[], query: string, semantic = new Map<string, number>()) {
  if (!selection) return;
  selection.items = candidates.map(state => ({ state, text: scoreCurrentStateText(state, query), semantic: semantic.get(state.id) ?? 0 }))
    .filter(item => item.text >= CURRENT_STATE_TEXT_THRESHOLD || item.semantic >= CURRENT_STATE_SEMANTIC_THRESHOLD)
    .sort((a, b) => (b.text + b.semantic) - (a.text + a.semantic) || b.state.updatedAt - a.state.updatedAt)
    .map(item => item.state);
}

function throwIfMemoryRecallAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  throw Object.assign(new Error('memory-recall-cancelled'), { name: 'AbortError' });
}

const QUERY_EXPANSIONS: Array<{ pattern: RegExp; terms: string[] }> = [
  { pattern: /喜欢|偏爱|爱听|爱吃|爱看/, terms: ['喜好', '偏好', '喜欢'] },
  { pattern: /讨厌|不喜欢|不要|不能接受/, terms: ['边界', '不喜欢', '避免'] },
  { pattern: /叫我|称呼|名字|昵称/, terms: ['称呼', '昵称', '叫法'] },
  { pattern: /答应|说好|约好|约定/, terms: ['约定', '承诺', '说好'] },
  { pattern: /难受|不舒服|生病|疼|痛/, terms: ['身体', '健康', '不舒服'] },
  { pattern: /app|应用|测试|功能|bug|报错|代码|开发|搜索|检索/i, terms: ['app', '应用', '开发', '代码', '测试', '功能', 'bug', '检索'] },
];

const SCENE_BRIDGE_EXPANSIONS: Array<{ pattern: RegExp; terms: string[] }> = [
  {
    pattern: /(?:app|应用|测试|功能|bug|报错|代码|开发|搜索|检索|修|改|优化|构建)[\s\S]*(?:凌晨|半夜|熬夜|睡不着|失眠|困|累|疲惫|压力|焦虑|崩溃|卡住)|(?:凌晨|半夜|熬夜|睡不着|失眠|困|累|疲惫|压力|焦虑|崩溃|卡住)[\s\S]*(?:app|应用|测试|功能|bug|报错|代码|开发|搜索|检索|修|改|优化|构建)/i,
    terms: ['失眠', '熬夜', '睡不着', '凌晨', '疲惫', '压力', '焦虑', '休息'],
  },
];

function expandLexicalQuery(query: string) {
  if (/^[\p{L}\p{N}]$/u.test(query.trim())) return query;
  const additions = new Set<string>();
  QUERY_EXPANSIONS.forEach(({ pattern, terms }) => {
    if (!pattern.test(query)) return;
    terms.forEach((term) => additions.add(term));
  });
  return additions.size ? `${query}\n${Array.from(additions).slice(0, 6).join(' ')}` : query;
}

function buildSceneBridgeQuery(query: string) {
  const additions = new Set<string>();
  SCENE_BRIDGE_EXPANSIONS.forEach(({ pattern, terms }) => {
    if (!pattern.test(query)) return;
    terms.forEach((term) => additions.add(term));
  });
  return additions.size ? Array.from(additions).join(' ') : '';
}

function normalizeQuery(query: string | StructuredMemoryQuery): NormalizedMemoryQuery {
  if (typeof query === 'string') {
    return { lexicalQuery: expandLexicalQuery(query), semanticQuery: query, hintQuery: '' };
  }
  const primaryText = [query.userText, query.activeContext].filter(Boolean).join('\n');
  const bridgeQuery = buildSceneBridgeQuery(primaryText);
  const preciseHints = query.recallMode === 'recall' || query.recallMode === 'detail_recall'
    ? query.sourceHints ?? ''
    : '';
  const lexicalBase = [
    expandLexicalQuery(primaryText || query.userText || ''),
    preciseHints,
    bridgeQuery,
  ].filter(Boolean).join('\n');
  const semanticBase = [
    primaryText,
    preciseHints,
  ].filter(Boolean).join('\n');
  return {
    lexicalQuery: lexicalBase,
    semanticQuery: semanticBase || primaryText,
    hintQuery: query.sourceHints ?? '',
  };
}

export function memoryLocalRecallQuery(query: string | StructuredMemoryQuery) {
  return normalizeQuery(query).lexicalQuery;
}

function mergeTextScores(
  primary: Map<string, { fts: number; cjk: number }>,
  hints: Map<string, { fts: number; cjk: number }>,
  hintWeight = 0.12,
) {
  const merged = new Map<string, MemoryTextCandidateScore>(primary);
  hints.forEach((score, id) => {
    const current = merged.get(id) ?? { fts: 0, cjk: 0 };
    merged.set(id, {
      ...current,
      hintFts: Math.max(current.hintFts ?? 0, score.fts * hintWeight),
      hintCjk: Math.max(current.hintCjk ?? 0, score.cjk * hintWeight),
    });
  });
  return merged;
}

export async function buildLocalMemoryRecallOnly(
  query: string | StructuredMemoryQuery,
  options: MemoryRecallOptions = {},
) {
  throwIfMemoryRecallAborted(options.signal);
  const { lexicalQuery, hintQuery } = normalizeQuery(query);
  const precise = typeof query !== 'string' && (query.recallMode === 'recall' || query.recallMode === 'detail_recall');
  const states = await currentStateCandidates(options.currentStateSelection, options);
  const papers = await shiyingRecallCandidates(options.shiyingSelection, options.signal);
  const posts = await postRecallCandidates(options.postSelection, options.signal, options.readOnly);
  selectCurrentStates(options.currentStateSelection, states, lexicalQuery);
  selectShiyingRecall(options.shiyingSelection, papers, lexicalQuery);
  selectPostRecall(options.postSelection, posts, lexicalQuery);
  try {
    const [primaryScores, hintScores] = await Promise.all([
      searchMemoryTextCandidates(lexicalQuery, 50, 'active', options.memories, options.materialPreparation,
        { signal: options.signal, reporter: options.memoryWorkReporter }),
      hintQuery ? searchMemoryTextCandidates(hintQuery, 20, 'active', options.memories, options.materialPreparation,
        { signal: options.signal, reporter: options.memoryWorkReporter }) : Promise.resolve(new Map()),
    ]);
    throwIfMemoryRecallAborted(options.signal);
    const textScores = mergeTextScores(primaryScores, hintScores, precise ? 0.34 : 0.12);
    return await buildLocalMemoryRecall(lexicalQuery, { ...options, textScores, allowRerank: false });
  } catch (error) {
    if (options.signal?.aborted || options.throwOnError) throw error;
    try {
      return await buildLocalMemoryRecall(lexicalQuery, { ...options, allowRerank: false });
    } catch (fallbackError) {
      if (options.signal?.aborted) throw fallbackError;
      return { context: '', items: [] };
    }
  }
}

export async function buildMemoryRecall(
  query: string | StructuredMemoryQuery,
  options: MemoryRecallOptions = {},
) {
  throwIfMemoryRecallAborted(options.signal);
  const { lexicalQuery, semanticQuery, hintQuery } = normalizeQuery(query);
  const precise = typeof query !== 'string' && (query.recallMode === 'recall' || query.recallMode === 'detail_recall');
  const states = await currentStateCandidates(options.currentStateSelection, options);
  const papers = await shiyingRecallCandidates(options.shiyingSelection, options.signal);
  const posts = await postRecallCandidates(options.postSelection, options.signal, options.readOnly);
  try {
    const findVectors = async () => {
      const finish = options.memoryWorkReporter?.start('vector_search');
      try { return await (options.currentStateSelection || options.shiyingSelection || options.postSelection ? searchSimilarMemoryTargets(semanticQuery, 40, {
        throwOnError: options.throwOnError, diagnosticParentToken: options.diagnosticParentToken,
        signal: options.signal, eligibleMemoryIds: options.memories ? new Set(options.memories.map(item => item.id)) : undefined,
        reporter: options.memoryWorkReporter,
        eligibleCurrentStateIds: new Set(states.map(item => item.id)),
        eligibleShiyingRecordIds: new Set(papers.map(item => item.recordId)),
        eligiblePostSourceIds: new Set(posts.flatMap(item => item.sources.map(source => source.messageId))),
      }).then(scores => {
        selectCurrentStates(options.currentStateSelection, states, lexicalQuery, scores.currentStates);
        selectShiyingRecall(options.shiyingSelection, papers, lexicalQuery, scores.shiyingRecords);
        selectPostRecall(options.postSelection, posts, lexicalQuery, scores.postSources, scores.postSourceRanges);
        return scores.memories;
      })
        : searchSimilarMemoryIds(semanticQuery, 40, {
        throwOnError: options.throwOnError,
        diagnosticParentToken: options.diagnosticParentToken,
        signal: options.signal,
        reporter: options.memoryWorkReporter,
      })); } finally { finish?.(); }
    };
    const [semanticScores, primaryScores, hintScores] = await Promise.all([
      findVectors(),
      searchMemoryTextCandidates(lexicalQuery, 50, 'active', options.memories, options.materialPreparation,
        { signal: options.signal, reporter: options.memoryWorkReporter }),
      hintQuery ? searchMemoryTextCandidates(hintQuery, 20, 'active', options.memories, options.materialPreparation,
        { signal: options.signal, reporter: options.memoryWorkReporter }) : Promise.resolve(new Map()),
    ]);
    throwIfMemoryRecallAborted(options.signal);
    const textScores = mergeTextScores(primaryScores, hintScores, precise ? 0.34 : 0.12);
    return await buildLocalMemoryRecall(lexicalQuery, { ...options, semanticScores, textScores });
  } catch (error) {
    if (options.signal?.aborted || options.throwOnError) throw error;
    try {
      return await buildLocalMemoryRecallOnly(query, options);
    } catch (fallbackError) {
      if (options.signal?.aborted) throw fallbackError;
      return { context: '', items: [] };
    }
  }
}

export { buildMemoryContext, buildMemoryIntrospection } from './memoryStore';
