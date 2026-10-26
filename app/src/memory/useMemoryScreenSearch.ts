import { useEffect, useMemo, useRef, useState } from 'react';
import { getMemoryEmbeddingText, searchSimilarMemoryIds } from './memoryEmbedding';
import { isWhisperMemory, loadMemories, searchMemoryScreenEntries, searchMemoryTextCandidates, type MemoryEntry } from './memoryStore';
import type { MemoryScreenViewMode } from './memoryScreenSelectors';

type SearchScope = { query: string; mode: MemoryScreenViewMode };
type SearchResult = { scope: SearchScope; items: MemoryEntry[]; failed?: boolean };
type MeaningCache = { scores: Map<string, number>; memories: readonly MemoryEntry[] };
type MeaningResult = { scope: SearchScope; loading: boolean; items?: MemoryEntry[]; notice?: string;
  cache?: MeaningCache; checkedMemories?: readonly MemoryEntry[] };

function currentScores(cache: MeaningCache, memories: readonly MemoryEntry[]) {
  const original = new Map(cache.memories.map(memory => [memory.id, getMemoryEmbeddingText(memory)]));
  return new Map(memories.filter(memory => cache.scores.has(memory.id)
    && original.get(memory.id) === getMemoryEmbeddingText(memory))
    .map(memory => [memory.id, cache.scores.get(memory.id)!]));
}

async function searchText(scope: SearchScope) {
  const records = await loadMemories({
    search: scope.query, currentOnly: scope.mode !== 'weekly',
    archivedOnly: scope.mode === 'archived', includeArchived: scope.mode === 'archived' || scope.mode === 'weekly',
  });
  return records.filter(memory => !isWhisperMemory(memory));
}

async function searchMeaning(scope: SearchScope, semanticScores: Map<string, number>) {
  const textScores = await searchMemoryTextCandidates(scope.query, 30, scope.mode === 'archived' ? 'archived' : 'active');
  return searchMemoryScreenEntries(scope.query, {
    archivedOnly: scope.mode === 'archived', textScores, semanticScores,
  });
}

export function useMemoryScreenSearch(query: string, mode: MemoryScreenViewMode, memories: readonly MemoryEntry[]) {
  const scope = useMemo(() => ({ query: query.trim(), mode }), [query, mode]);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const currentMemories = useRef(memories);
  currentMemories.current = memories;
  const meaningRevision = useRef(0);
  const request = useRef<{ scope: SearchScope; controller: AbortController } | null>(null);
  const [local, setLocal] = useState<SearchResult | null>(null);
  const [meaning, setMeaning] = useState<MeaningResult | null>(null);
  const searchable = !!scope.query && mode !== 'calendar' && mode !== 'timeline';

  useEffect(() => () => {
    request.current?.controller.abort();
    request.current = null;
  }, [scope]);

  useEffect(() => {
    let active = true;
    if (searchable) {
      void searchText(scope).then(items => {
        if (active && currentScope.current === scope) setLocal({ scope, items });
      }).catch(() => {
        if (active && currentScope.current === scope) setLocal({ scope, items: [], failed: true });
      });
    }
    return () => { active = false; };
  }, [scope, searchable, memories]);

  // A background reload rechecks saved candidates locally; it is not a new search consent.
  useEffect(() => {
    if (meaning?.scope !== scope || !meaning.cache || meaning.checkedMemories === memories) return;
    let active = true;
    const revision = meaningRevision.current;
    void searchMeaning(scope, currentScores(meaning.cache, memories)).then(items => {
      if (active && currentScope.current === scope && meaningRevision.current === revision) {
        setMeaning({ ...meaning, items, checkedMemories: memories });
      }
    }).catch(() => {
      if (active && currentScope.current === scope && meaningRevision.current === revision) {
        setMeaning({ scope, loading: false, notice: '搜索结果更新未完成，请点击重新查找。' });
      }
    });
    return () => { active = false; };
  }, [scope, memories, meaning?.cache]);

  const searchByMeaning = async () => {
    if (!searchable || mode === 'archived' || mode === 'weekly' || currentScope.current !== scope) return;
    if (request.current?.scope === scope) return;
    request.current?.controller.abort();
    const controller = new AbortController();
    request.current = { scope, controller };
    meaningRevision.current += 1;
    const originalMemories = currentMemories.current;
    const isCurrent = () => !controller.signal.aborted && currentScope.current === scope;
    setMeaning({ scope, loading: true });
    try {
      const scores = await searchSimilarMemoryIds(scope.query, 30, { signal: controller.signal, throwOnError: true });
      if (!isCurrent()) return;
      const cache = { scores, memories: originalMemories };
      const checkedMemories = currentMemories.current;
      const items = await searchMeaning(scope, currentScores(cache, checkedMemories));
      if (isCurrent()) setMeaning({ scope, loading: false, items, cache, checkedMemories, notice: '已结合文字和意思查找。' });
    } catch (error) {
      if (!isCurrent()) return;
      const code = error instanceof Error ? error.message : '';
      const notice = code === 'embedding-disabled' ? '向量搜索未开启，仍显示本地文字结果。'
        : code === 'embedding-not-configured' ? '向量搜索配置不完整，仍显示本地文字结果。'
          : '按意思查找未完成，仍显示本地文字结果；可以点击重试。';
      setMeaning({ scope, loading: false, notice });
    } finally {
      if (request.current?.controller === controller) request.current = null;
    }
  };

  const cancelMeaningSearch = () => {
    meaningRevision.current += 1;
    request.current?.controller.abort();
    request.current = null;
    setMeaning(null);
  };
  const currentMeaning = meaning?.scope === scope ? meaning : null;
  const currentLocal = local?.scope === scope ? local : null;
  return {
    searchResults: searchable ? currentMeaning?.items ?? currentLocal?.items ?? [] : null,
    meaningSearching: currentMeaning?.loading ?? false,
    searchNotice: currentMeaning?.notice ?? (currentLocal?.failed ? '本地文字搜索暂不可用，请重新搜索。' : ''),
    searchByMeaning,
    cancelMeaningSearch,
  };
}
