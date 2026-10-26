import { useCallback, useEffect, useRef, useState } from 'react';
import { BackHandler } from 'react-native';
import { subscribeBackupRestoreRuntimeState } from '../backup/backupRestoreCoordinator';
import { subscribeChatDataChanges } from './chatDataChanges';
import { chatHistoryReader } from './chatHistorySearchStorage';
import type { ChatHistoryQuery, ChatHistoryWindow, ChatSearchCursor, ChatSearchHit } from './chatHistorySearch';

export function useChatHistorySearchController(active: boolean) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState<ChatHistoryQuery>({ text: '' });
  const [hits, setHits] = useState<ChatSearchHit[]>([]);
  const [next, setNext] = useState<ChatSearchCursor | null>(null);
  const [searched, setSearched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [browsing, setBrowsing] = useState(false);
  const [window, setWindow] = useState<ChatHistoryWindow | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [focusVersion, setFocusVersion] = useState(0);
  const generation = useRef(0);
  const offset = useRef(0);
  const anchorId = useRef<string | null>(null);

  const returnToLatest = useCallback(() => {
    generation.current += 1;
    anchorId.current = null;
    setBusy(false);
    setBrowsing(false);
    setWindow(null);
    setHighlightId(null);
  }, []);

  useEffect(() => {
    const invalidate = () => {
      generation.current += 1;
      setHits([]);
      setNext(null);
      setSearched(false);
      setBusy(false);
      setNotice('聊天记录已更新，请重新查找。');
      const anchor = anchorId.current;
      setWindow(null);
      if (!anchor) return;
      const ticket = generation.current;
      void chatHistoryReader().context(anchor).then(result => {
        if (ticket !== generation.current) return;
        setWindow(result);
        if (!result) { anchorId.current = null; setNotice('这条消息已不存在。'); }
      }).catch(error => {
        if (ticket === generation.current) setNotice(error instanceof Error ? error.message : '聊天记录读取失败。');
      });
    };
    const unsubscribe = subscribeChatDataChanges(invalidate);
    const unsubscribeRestore = subscribeBackupRestoreRuntimeState(() => {
      generation.current += 1;
      anchorId.current = null;
      setHits([]); setNext(null); setWindow(null); setBusy(false); setSearched(false);
      setNotice('聊天数据已变化，请重新查找。');
    });
    return () => { generation.current += 1; unsubscribe(); unsubscribeRestore(); };
  }, []);

  useEffect(() => {
    if (!active) {
      returnToLatest(); setSearchOpen(false); setHits([]); setNext(null); setSearched(false);
    }
  }, [active, returnToLatest]);
  useEffect(() => {
    if (!highlightId) return;
    const timer = setTimeout(() => setHighlightId(null), 2400);
    return () => clearTimeout(timer);
  }, [highlightId, focusVersion]);
  useEffect(() => {
    if (!active || !browsing || searchOpen) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => { setSearchOpen(true); return true; });
    return () => subscription.remove();
  }, [active, browsing, searchOpen]);

  const changeQuery = (value: ChatHistoryQuery) => {
    generation.current += 1;
    setQuery(value); setHits([]); setNext(null); setSearched(false); setBusy(false); setNotice(''); offset.current = 0;
  };
  const search = async (more = false) => {
    if (more && (!next || busy)) return;
    const ticket = ++generation.current;
    setBusy(true); setNotice('');
    if (!more) { setHits([]); setNext(null); offset.current = 0; }
    try {
      const page = await chatHistoryReader().search(query, more ? next : null);
      if (ticket !== generation.current) return;
      setHits(previous => more ? [...previous, ...page.hits] : page.hits);
      setNext(page.next); setSearched(true);
    } catch (error) {
      if (ticket === generation.current) { setHits([]); setNext(null); setNotice(error instanceof Error ? error.message : '查找失败，请重试。'); }
    } finally { if (ticket === generation.current) setBusy(false); }
  };
  const locate = async (id: string, direction?: 'older' | 'newer') => {
    const ticket = ++generation.current;
    setBusy(true); setNotice('');
    try {
      const result = await chatHistoryReader().context(id, direction);
      if (ticket !== generation.current) return;
      if (!result) {
        anchorId.current = null;
        setWindow(null); setHits([]); setNext(null); setSearched(false);
        setNotice('这条消息已不存在，请重新查找。'); return;
      }
      anchorId.current = result.anchorId;
      setWindow(result); setBrowsing(true); setSearchOpen(false);
      setHighlightId(direction ? null : id); setFocusVersion(value => value + 1);
    } catch (error) {
      if (ticket === generation.current) {
        anchorId.current = null;
        setWindow(null); setHits([]); setNext(null); setSearched(false);
        setNotice(error instanceof Error ? error.message : '聊天记录读取失败。');
      }
    } finally { if (ticket === generation.current) setBusy(false); }
  };
  const older = () => { const first = window?.messages[0]; if (first && !busy) void locate(first.id, 'older'); };
  const newer = () => { const last = window?.messages.at(-1); if (last && !busy) void locate(last.id, 'newer'); };
  return { searchOpen, query, hits, next, searched, busy, notice, browsing, window, highlightId, focusVersion, offset,
    changeQuery, search, locate, older, newer, returnToLatest,
    openSearch: () => setSearchOpen(true), closeSearch: () => setSearchOpen(false) };
}
