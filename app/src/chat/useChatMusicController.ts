import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import { extractMusicCommand } from '../music/musicCommands';
import {
  loadNeteaseMusicU,
  saveNeteaseMusicU,
  testNeteaseMusic,
} from '../music/neteaseMusic';
import {
  getMessageMusicCards,
  getMusicCardLimit,
  normalizeMusicKeywords,
} from './chatMusicLogic';
import { saveChatPreferences } from './chatPreferences';
import {
  createChatMusicRuntime,
  type ChatMusicRuntimeOptions,
  type MusicPreferences,
} from './chatMusicRuntime';
export type { MusicToolExecutionContext } from './chatMusicRuntime';

export type UseChatMusicControllerOptions = ChatMusicRuntimeOptions & {
  active: boolean;
  historyLoaded: boolean;
  messages: SubjectiveMessage[];
  getWaitingModeEnabled: () => boolean;
  onNotice: (message: string | null) => void;
  persistRepairedMessages: (messages: SubjectiveMessage[]) => Promise<void> | void;
};

export function useChatMusicController(options: UseChatMusicControllerOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const [musicEnabled, setMusicEnabledState] = useState(false);
  const [musicAutoplay, setMusicAutoplayState] = useState(false);
  const [musicMultipleCardsEnabled, setMusicMultipleCardsEnabledState] = useState(false);
  const [musicSettingsOpen, setMusicSettingsOpen] = useState(false);
  const [musicConnectionOpen, setMusicConnectionOpen] = useState(false);
  const [musicCookieDraft, setMusicCookieDraftState] = useState('');
  const [musicCookieSaved, setMusicCookieSaved] = useState(false);
  const [musicCookieBusy, setMusicCookieBusy] = useState(false);

  const musicEnabledRef = useRef(false);
  const musicAutoplayRef = useRef(false);
  const musicMultipleCardsEnabledRef = useRef(false);
  const musicCookieDraftRef = useRef('');
  const musicCookieSavedRef = useRef(false);
  const latestMessagesRef = useRef(options.messages);
  const repairedMusicCommandMessageIdsRef = useRef(new Set<string>());
  const resolvingMusicCardMessageIdsRef = useRef(new Set<string>());
  latestMessagesRef.current = options.messages;

  useEffect(() => {
    if (!options.active) setMusicSettingsOpen(false);
  }, [options.active]);

  useEffect(() => {
    let mounted = true;
    void loadNeteaseMusicU().then((musicU) => {
      if (!mounted) return;
      const saved = !!musicU;
      musicCookieSavedRef.current = saved;
      musicCookieDraftRef.current = '';
      setMusicCookieSaved(saved);
      setMusicCookieDraftState('');
    });
    return () => {
      mounted = false;
    };
  }, []);

  const hydrateMusicPreferences = useCallback((preferences: MusicPreferences) => {
    musicEnabledRef.current = preferences.musicEnabled;
    musicAutoplayRef.current = preferences.musicAutoplay;
    musicMultipleCardsEnabledRef.current = preferences.musicMultipleCardsEnabled;
    setMusicEnabledState(preferences.musicEnabled);
    setMusicAutoplayState(preferences.musicAutoplay);
    setMusicMultipleCardsEnabledState(preferences.musicMultipleCardsEnabled);
  }, []);

  const {
    getPreferencesSnapshot,
    getCurrentMusicCardLimit,
    isMusicEnabled,
    controlMusic,
    playMusicSong,
    resolveMusicCard,
    resolveMusicCardsSequentially,
  } = useMemo(() => createChatMusicRuntime({
    optionsRef,
    musicEnabledRef,
    musicAutoplayRef,
    musicMultipleCardsEnabledRef,
    latestMessagesRef,
    resolvingMusicCardMessageIdsRef,
  }), []);

  const saveMusicPreferences = useCallback((preferences: MusicPreferences) => {
    hydrateMusicPreferences(preferences);
    optionsRef.current.onNotice(null);
    void saveChatPreferences({
      ...preferences,
      waitingModeEnabled: optionsRef.current.getWaitingModeEnabled(),
    }).catch(() => {
      optionsRef.current.onNotice('音乐设置保存失败，请稍后再试。');
    });
  }, [hydrateMusicPreferences]);

  const setMusicEnabled = useCallback((enabled: boolean) => {
    saveMusicPreferences({
      musicAutoplay: musicAutoplayRef.current,
      musicEnabled: enabled,
      musicMultipleCardsEnabled: musicMultipleCardsEnabledRef.current,
    });
  }, [saveMusicPreferences]);

  const setMusicAutoplay = useCallback((enabled: boolean) => {
    saveMusicPreferences({
      musicAutoplay: enabled,
      musicEnabled: musicEnabledRef.current,
      musicMultipleCardsEnabled: musicMultipleCardsEnabledRef.current,
    });
  }, [saveMusicPreferences]);

  const setMusicMultipleCardsEnabled = useCallback((enabled: boolean) => {
    saveMusicPreferences({
      musicAutoplay: musicAutoplayRef.current,
      musicEnabled: musicEnabledRef.current,
      musicMultipleCardsEnabled: enabled,
    });
  }, [saveMusicPreferences]);

  const toggleMusicSettings = useCallback(() => {
    setMusicSettingsOpen((current) => !current);
  }, []);

  const toggleMusicConnection = useCallback(() => {
    setMusicConnectionOpen((current) => !current);
  }, []);

  const setMusicCookieDraft = useCallback((value: string) => {
    musicCookieDraftRef.current = value;
    setMusicCookieDraftState(value);
  }, []);

  const saveMusicCookie = useCallback(async (testAfterSave = false) => {
    setMusicCookieBusy(true);
    optionsRef.current.onNotice(null);
    try {
      const draft = musicCookieDraftRef.current;
      const shouldKeepSavedCookie = testAfterSave && !draft.trim() && musicCookieSavedRef.current;
      const saved = shouldKeepSavedCookie
        ? await loadNeteaseMusicU()
        : await saveNeteaseMusicU(draft);
      const cookieSaved = !!saved;
      musicCookieSavedRef.current = cookieSaved;
      setMusicCookieSaved(cookieSaved);
      if (!shouldKeepSavedCookie) {
        musicCookieDraftRef.current = '';
        setMusicCookieDraftState('');
      }
      if (testAfterSave) {
        const result = await testNeteaseMusic();
        optionsRef.current.onNotice(result.detail);
      } else {
        optionsRef.current.onNotice(
          saved ? '网易云登录凭证已安全保存在这台手机。' : '已切换为匿名播放。',
        );
      }
    } catch {
      optionsRef.current.onNotice('网易云登录凭证保存失败，请稍后再试。');
    } finally {
      setMusicCookieBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!options.active || !options.historyLoaded) return;
    if (!musicEnabledRef.current) return;

    const repairs: Array<{ id: string; keyword: string; cardIndex: number }> = [];
    const nextMessages = latestMessagesRef.current.map((message) => {
      if (
        message.role !== 'I'
        || getMessageMusicCards(message).length
        || repairedMusicCommandMessageIdsRef.current.has(message.id)
      ) {
        return message;
      }
      const parsedMusic = extractMusicCommand([message.content]);
      const musicKeywords = normalizeMusicKeywords(
        getMusicCardLimit(musicMultipleCardsEnabledRef.current),
        parsedMusic.keywords,
      );
      if (!musicKeywords.length || parsedMusic.contents.join('\n') === message.content) return message;

      repairedMusicCommandMessageIdsRef.current.add(message.id);
      musicKeywords.forEach((keyword, cardIndex) => repairs.push({ id: message.id, keyword, cardIndex }));
      const musicCards = musicKeywords.map((keyword) => ({ keyword, status: 'loading' as const }));
      return {
        ...message,
        content: parsedMusic.contents.join('\n'),
        musicCard: musicCards[0],
        musicCards,
      };
    });

    if (!repairs.length) return;
    latestMessagesRef.current = nextMessages;
    optionsRef.current.commitMessages(nextMessages);
    const repairsByMessage = repairs.reduce((groups, repair) => {
      const current = groups.get(repair.id) || [];
      current[repair.cardIndex] = repair.keyword;
      groups.set(repair.id, current);
      return groups;
    }, new Map<string, string[]>());
    repairsByMessage.forEach((keywords, messageId) => {
      void (async () => {
        for (const [cardIndex, keyword] of keywords.filter(Boolean).entries()) {
          await resolveMusicCard(messageId, keyword, cardIndex, { autoplay: false });
        }
      })();
    });
    void optionsRef.current.persistRepairedMessages(nextMessages);
  }, [options.active, options.historyLoaded, options.messages, resolveMusicCardsSequentially]);

  useEffect(() => {
    if (!options.active || !options.historyLoaded) return;

    latestMessagesRef.current.forEach((message) => {
      if (message.role !== 'I') return;
      const loadingCards = getMessageMusicCards(message)
        .map((card, cardIndex) => ({ card, cardIndex }))
        .filter(({ card }) => card.status === 'loading');
      if (!loadingCards.length) return;
      void (async () => {
        for (const { card, cardIndex } of loadingCards) {
          await resolveMusicCard(message.id, card.keyword, cardIndex, { autoplay: false });
        }
      })();
    });
  }, [options.active, options.historyLoaded, options.messages, resolveMusicCard]);

  return {
    getCurrentMusicCardLimit,
    getPreferencesSnapshot,
    hydrateMusicPreferences,
    isMusicEnabled,
    musicAutoplay,
    musicConnectionOpen,
    musicCookieBusy,
    musicCookieDraft,
    musicCookieSaved,
    musicEnabled,
    musicMultipleCardsEnabled,
    musicSettingsOpen,
    controlMusic,
    playMusicSong,
    resolveMusicCard,
    resolveMusicCardsSequentially,
    saveMusicCookie,
    setMusicAutoplay,
    setMusicCookieDraft,
    setMusicEnabled,
    setMusicMultipleCardsEnabled,
    toggleMusicConnection,
    toggleMusicSettings,
  };
}
