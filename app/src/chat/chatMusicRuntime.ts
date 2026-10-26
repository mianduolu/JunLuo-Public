import type {
  MessageMusicCard,
  MusicSong,
  SubjectiveMessage,
} from '../ai/subjectiveMessages';
import {
  applyMusicPreferenceToKeyword,
  buildMusicPreferenceMemoryContext,
} from '../music/musicPreferenceMemory';
import type { MusicControlAction } from '../tools/musicPlaybackBridge';
import {
  buildMusicAvoidance,
  getMessageMusicCards,
  getMusicCardLimit,
  shouldAutoplayMusicCard,
  withUpdatedMessageMusicCard,
} from './chatMusicLogic';
import type { ChatPreferences } from './chatPreferences';

export type MusicPreferences = Pick<
  ChatPreferences,
  'musicAutoplay' | 'musicEnabled' | 'musicMultipleCardsEnabled'
>;

type MusicSearchCandidatesData = {
  candidates?: MusicSong[];
  duplicateAvoided?: boolean;
  requestedKeyword?: string;
  searchKeyword?: string;
  song?: MusicSong;
};

type MusicToolResult<T = unknown> = {
  callId?: string;
  data?: T;
  error?: { code?: string; message?: string };
  ok: boolean;
  status?: string;
  summary: string;
};

type MusicSearchInput = {
  avoidSongIds: string[];
  avoidSongKeys: string[];
  keyword: string;
};

export type MusicToolExecutionContext = {
  executionIntentId?: string;
  executionIntentSource?: string;
};

export type ChatMusicRuntimeOptions = {
  commitMessages: (messages: SubjectiveMessage[]) => void;
  onError: (message: string) => void;
  requestMusicPlayback: (
    song: MusicSong,
    sourceMessageId?: string,
    executionContext?: MusicToolExecutionContext,
  ) => Promise<MusicToolResult>;
  requestMusicControl: (action: MusicControlAction, sourceMessageId?: string) => Promise<MusicToolResult>;
  searchMusicCandidates: (
    input: MusicSearchInput,
    sourceMessageId: string,
    executionContext?: MusicToolExecutionContext,
  ) => Promise<MusicToolResult>;
};

export function createChatMusicRuntime({
  optionsRef,
  musicEnabledRef,
  musicAutoplayRef,
  musicMultipleCardsEnabledRef,
  latestMessagesRef,
  resolvingMusicCardMessageIdsRef,
}: {
  optionsRef: { current: ChatMusicRuntimeOptions };
  musicEnabledRef: { current: boolean };
  musicAutoplayRef: { current: boolean };
  musicMultipleCardsEnabledRef: { current: boolean };
  latestMessagesRef: { current: SubjectiveMessage[] };
  resolvingMusicCardMessageIdsRef: { current: Set<string> };
}) {
  const getPreferencesSnapshot = (): MusicPreferences => ({
    musicAutoplay: musicAutoplayRef.current,
    musicEnabled: musicEnabledRef.current,
    musicMultipleCardsEnabled: musicMultipleCardsEnabledRef.current,
  });

  const getCurrentMusicCardLimit = () => (
    getMusicCardLimit(musicMultipleCardsEnabledRef.current)
  );

  const isMusicEnabled = () => musicEnabledRef.current;

  const updateMessageMusicCard = (
    messageId: string,
    musicCard: MessageMusicCard,
    cardIndex = 0,
  ) => {
    const nextMessages = latestMessagesRef.current.map((message) => (
      message.id === messageId
        ? withUpdatedMessageMusicCard(message, cardIndex, musicCard)
        : message
    ));
    latestMessagesRef.current = nextMessages;
    optionsRef.current.commitMessages(nextMessages);
  };

  const updateManualMusicCard = (
    messageId: string | undefined,
    songId: string | undefined,
    result: MusicToolResult,
    action: 'play' | MusicControlAction,
  ) => {
    if (!messageId) return;
    const message = latestMessagesRef.current.find((item) => item.id === messageId);
    if (!message) return;
    const cards = getMessageMusicCards(message);
    const cardIndex = songId ? cards.findIndex((card) => card.song?.id === songId) : 0;
    if (cardIndex < 0) return;
    const card = cards[cardIndex];
    if (!card) return;
    const playbackState = (result.data as { playbackState?: unknown } | undefined)?.playbackState;
    const playbackStatus = result.error?.code === 'TOOL_OUTCOME_UNKNOWN'
      ? 'outcome_unknown' as const
      : result.ok && (playbackState === 'playing' || playbackState === 'paused' || playbackState === 'stopped')
        ? playbackState
        : card.playbackStatus;
    const agentBinding = card.agentBinding && result.callId
      ? action === 'play'
        ? { ...card.agentBinding, playAuditId: result.callId }
        : {
            ...card.agentBinding,
            controlAuditIds: [...(card.agentBinding.controlAuditIds ?? []), result.callId],
          }
      : card.agentBinding;
    updateMessageMusicCard(messageId, {
      ...card,
      agentBinding,
      error: result.ok ? undefined : (result.summary || result.error?.message),
      playbackStatus,
    }, cardIndex);
  };

  const playMusicSong = async (
    song: MusicSong,
    sourceMessageId?: string,
    executionContext?: MusicToolExecutionContext,
  ) => {
    const result = await optionsRef.current.requestMusicPlayback(song, sourceMessageId, executionContext);
    updateManualMusicCard(sourceMessageId, song.id, result, 'play');
    if (!result.ok) {
      throw new Error(result.summary || result.error?.message || '歌曲暂时播放不了。');
    }
  };

  const controlMusic = async (action: MusicControlAction, sourceMessageId?: string) => {
    const result = await optionsRef.current.requestMusicControl(action, sourceMessageId);
    updateManualMusicCard(sourceMessageId, undefined, result, action);
    if (!result.ok) {
      throw new Error(result.summary || result.error?.message || 'EXECUTION_FAILED');
    }
  };

  const resolveMusicCard = async (
    messageId: string,
    keyword: string,
    cardIndex = 0,
    resolveOptions: MusicToolExecutionContext & { autoplay?: boolean } = {},
  ) => {
    const resolvingKey = `${messageId}:${cardIndex}`;
    if (resolvingMusicCardMessageIdsRef.current.has(resolvingKey)) return;
    resolvingMusicCardMessageIdsRef.current.add(resolvingKey);
    updateMessageMusicCard(messageId, { keyword, status: 'loading' }, cardIndex);
    try {
      const musicPreferenceContext = await buildMusicPreferenceMemoryContext().catch(() => '');
      const searchKeyword = applyMusicPreferenceToKeyword(keyword, musicPreferenceContext);
      const avoidance = buildMusicAvoidance(latestMessagesRef.current, messageId, cardIndex);
      const result = await optionsRef.current.searchMusicCandidates({
        avoidSongIds: avoidance.songIds,
        avoidSongKeys: avoidance.songKeys,
        keyword: searchKeyword,
      }, messageId, resolveOptions);
      if (!result.ok) {
        throw new Error(result.summary || result.error?.message || '歌曲暂时没有找到。');
      }
      const data = result.data as MusicSearchCandidatesData | undefined;
      if (!data?.song) throw new Error('歌曲候选结果不完整。');
      const song: MusicSong = {
        album: data.song.album,
        artist: data.song.artist,
        cover: data.song.cover,
        duration: data.song.duration,
        id: data.song.id,
        name: data.song.name,
      };
      updateMessageMusicCard(messageId, {
        candidates: data.candidates ?? [],
        duplicateAvoided: data.duplicateAvoided,
        keyword: data.searchKeyword ?? searchKeyword,
        requestedKeyword: keyword,
        song,
        status: 'ready',
      }, cardIndex);
      if (shouldAutoplayMusicCard(
        musicAutoplayRef.current,
        cardIndex,
        resolveOptions.autoplay,
      )) {
        try {
          await playMusicSong(song, messageId, resolveOptions);
        } catch (caught) {
          optionsRef.current.onError(caught instanceof Error ? caught.message : '歌曲暂时播放不了。');
        }
      }
    } catch (caught) {
      updateMessageMusicCard(messageId, {
        error: caught instanceof Error ? caught.message : '歌曲暂时没有找到。',
        keyword,
        requestedKeyword: keyword,
        status: 'error',
      }, cardIndex);
    } finally {
      resolvingMusicCardMessageIdsRef.current.delete(resolvingKey);
    }
  };

  const resolveMusicCardsSequentially = async (
    messageId: string,
    keywords: string[],
    context: MusicToolExecutionContext = {},
  ) => {
    for (const [cardIndex, keyword] of keywords.entries()) {
      await resolveMusicCard(messageId, keyword, cardIndex, {
        executionIntentId: context.executionIntentId,
        executionIntentSource: context.executionIntentSource,
        autoplay: cardIndex === 0,
      });
    }
  };

  return {
    getPreferencesSnapshot,
    getCurrentMusicCardLimit,
    isMusicEnabled,
    controlMusic,
    playMusicSong,
    resolveMusicCard,
    resolveMusicCardsSequentially,
  };
}
