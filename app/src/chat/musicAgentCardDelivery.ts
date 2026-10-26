import {
  createSubjectiveMessage,
  type MessageMusicCard,
  type MusicSong,
  type SubjectiveMessage,
} from '../ai/subjectiveMessages';
import type { JunLuoToolInvocation, JunLuoToolResult } from '../tools';
import { claimToolAgentCardForDomain } from './toolAgentCardDelivery';

export function upsertMusicAgentResultCardMessage(
  messages: readonly SubjectiveMessage[],
  invocation: JunLuoToolInvocation,
  result: JunLuoToolResult,
  auditId: string,
  fallbackSongId?: string,
): { claimed: boolean; messages: SubjectiveMessage[] } {
  if (invocation.toolId === 'music.search_candidates') {
    return {
      claimed: true,
      messages: upsertSearchCard(claimToolAgentCardForDomain(messages, auditId), invocation, result, auditId),
    };
  }
  if (invocation.toolId !== 'music.play' && invocation.toolId !== 'music.control') {
    return { claimed: false, messages: [...messages] };
  }
  const song = readSong(
    (result.data as Record<string, unknown> | undefined)?.song
    ?? (result.data as Record<string, unknown> | undefined)?.currentSong
    ?? invocation.input.song,
  );
  const target = invocation.toolId === 'music.play'
    ? findMusicCard(messages, undefined, auditId)
      ?? (invocation.input.song ? findMusicCard(messages, song?.id ?? fallbackSongId) : undefined)
    : findMusicCard(messages, song?.id ?? fallbackSongId);
  if (!target) {
    if (invocation.toolId !== 'music.play') return { claimed: false, messages: [...messages] };
    const keyword = typeof invocation.input.keyword === 'string'
      ? invocation.input.keyword
      : [invocation.input.title, invocation.input.artist].filter((value) => typeof value === 'string').join(' ').trim();
    const card = updatePlayCard({
      agentBinding: { cardId: auditId, playAuditId: auditId },
      keyword,
      requestedKeyword: keyword,
      status: 'error',
      playbackStatus: 'ready',
    }, result, auditId);
    return {
      claimed: true,
      messages: [...claimToolAgentCardForDomain(messages, auditId), {
        ...createSubjectiveMessage('I', '', { source: 'tool-call' }),
        musicCard: card,
        musicCards: [card],
      }],
    };
  }
  const withoutGeneric = claimToolAgentCardForDomain(messages, auditId);
  return {
    claimed: true,
    messages: withoutGeneric.map((message) => {
      if (message.id !== target.messageId) return message;
      const cards = [...(message.musicCards ?? (message.musicCard ? [message.musicCard] : []))];
      const current = cards[target.cardIndex];
      const next = invocation.toolId === 'music.play'
        ? updatePlayCard(current, result, auditId)
        : updateControlCard(current, result, auditId);
      cards[target.cardIndex] = next;
      return { ...message, musicCard: cards[0], musicCards: cards };
    }),
  };
}

function upsertSearchCard(
  messages: readonly SubjectiveMessage[],
  invocation: JunLuoToolInvocation,
  result: JunLuoToolResult,
  auditId: string,
) {
  const existing = messages.findIndex((message) => (
    message.musicCards?.some((card) => card.agentBinding?.searchAuditId === auditId)
    || message.musicCard?.agentBinding?.searchAuditId === auditId
  ));
  const keyword = typeof invocation.input.keyword === 'string' ? invocation.input.keyword : '';
  const data = result.data as Record<string, unknown> | undefined;
  const song = readSong(data?.song);
  const candidates = Array.isArray(data?.candidates)
    ? data.candidates.map(readSong).filter((item): item is MusicSong => !!item)
    : [];
  const card: MessageMusicCard = result.ok && song
    ? {
        agentBinding: { cardId: auditId, searchAuditId: auditId },
        candidates,
        duplicateAvoided: data?.duplicateAvoided === true,
        keyword: typeof data?.searchKeyword === 'string' ? data.searchKeyword : keyword,
        requestedKeyword: keyword,
        playbackStatus: 'ready',
        song,
        status: 'ready',
      }
    : {
        agentBinding: { cardId: auditId, searchAuditId: auditId },
        error: result.summary || result.error?.message,
        keyword,
        requestedKeyword: keyword,
        status: 'error',
      };
  if (existing < 0) {
    return [...messages, {
      ...createSubjectiveMessage('I', '', { source: 'tool-call' }),
      musicCard: card,
      musicCards: [card],
    }];
  }
  return messages.map((message, index) => index === existing
    ? { ...message, musicCard: card, musicCards: [card] }
    : message);
}

function updatePlayCard(card: MessageMusicCard, result: JunLuoToolResult, auditId: string) {
  const data = result.data as Record<string, unknown> | undefined;
  const song = readSong(data?.song) ?? card.song;
  return {
    ...card,
    song,
    status: song ? 'ready' as const : card.status,
    candidates: Array.isArray(data?.candidates)
      ? data.candidates.map(readSong).filter((item): item is MusicSong => !!item)
      : card.candidates,
    duplicateAvoided: typeof data?.duplicateAvoided === 'boolean' ? data.duplicateAvoided : card.duplicateAvoided,
    keyword: typeof data?.searchKeyword === 'string' ? data.searchKeyword : card.keyword,
    requestedKeyword: typeof data?.requestedKeyword === 'string' ? data.requestedKeyword : card.requestedKeyword,
    agentBinding: card.agentBinding
      ? { ...card.agentBinding, playAuditId: auditId }
      : card.agentBinding,
    playbackStatus: result.error?.code === 'TOOL_OUTCOME_UNKNOWN'
      ? 'outcome_unknown' as const
      : result.ok && (result.data as { playbackState?: unknown } | undefined)?.playbackState === 'playing'
        ? 'playing' as const
        : card.playbackStatus,
    error: result.ok ? undefined : (result.summary || result.error?.message),
  };
}

function updateControlCard(card: MessageMusicCard, result: JunLuoToolResult, auditId: string) {
  const state = (result.data as { playbackState?: unknown } | undefined)?.playbackState;
  const playbackStatus = result.error?.code === 'TOOL_OUTCOME_UNKNOWN'
    ? 'outcome_unknown' as const
    : result.ok && (state === 'playing' || state === 'paused' || state === 'stopped')
      ? state
      : card.playbackStatus;
  return {
    ...card,
    agentBinding: card.agentBinding
      ? {
          ...card.agentBinding,
          controlAuditIds: [...(card.agentBinding.controlAuditIds ?? []), auditId],
        }
      : card.agentBinding,
    playbackStatus,
    error: result.ok ? undefined : (result.summary || result.error?.message),
  };
}

function findMusicCard(messages: readonly SubjectiveMessage[], songId: string | undefined, playAuditId?: string) {
  if (!songId && !playAuditId) return undefined;
  for (const message of messages) {
    const cards = message.musicCards ?? (message.musicCard ? [message.musicCard] : []);
    const cardIndex = cards.findIndex((card) => playAuditId
      ? card.agentBinding?.playAuditId === playAuditId
      : card.song?.id === songId);
    if (cardIndex >= 0) return { messageId: message.id, cardIndex };
  }
  return undefined;
}

function readSong(value: unknown): MusicSong | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const song = value as Record<string, unknown>;
  if (typeof song.id !== 'string' || typeof song.name !== 'string') return undefined;
  return {
    id: song.id,
    name: song.name,
    artist: typeof song.artist === 'string' ? song.artist : '',
    album: typeof song.album === 'string' ? song.album : '',
    cover: typeof song.cover === 'string' ? song.cover : '',
    duration: typeof song.duration === 'number' && Number.isFinite(song.duration) ? song.duration : 0,
  };
}
