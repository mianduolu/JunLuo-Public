import type {
  ApiChatMessage,
  MessageMusicCard,
  MusicSong,
  SubjectiveMessage,
} from '../ai/subjectiveMessages';
import { extractMusicCommand } from '../music/musicCommands';

const MUSIC_CONFIRMATION_PATTERN =
  /(?:你可以(?:放|点)|可以(?:呀|啊|哇|哦|噢)?(?:放|点)?|(?:放|点|来|听|推|试|去)(?:吧|呀|啊|一下)?|那(?:就|你)(?:放|点)|放给我|给我放|我想听|要听|播放)/;
const MUSIC_CONFIRMATION_NEGATION_PATTERN = /不可以|不用|不要|别|算了|停|不想|不听/;
export const MUSIC_REQUEST_PATTERN = /点歌|听歌|放(?:首|一首|歌)|来(?:首|一首)|想听|播放|音乐|测试点歌|再点一次|点一次/;
const ASSISTANT_MUSIC_ACCEPTANCE_PATTERN =
  /(?:点|放|换|选|挑|送|递|找)(?:一首|首|这首|歌)?|给你(?:测|放|点|听)|陪你听|这就放|这就点/;
const ASSISTANT_MUSIC_PROMISE_PATTERN =
  /(?:(?:点|放|换|选|挑|送|递|找)(?:一首|首|这首)?[^。！？!?\n]{0,24}(?:歌|音乐|纯音乐|轻音乐|曲|钢琴|旋律)|(?:歌|音乐|纯音乐|轻音乐|曲|钢琴|旋律)[^。！？!?\n]{0,24}(?:陪你|给你|放给你|递给你|靠过来|垫着))/;
const MUSIC_ACCEPTANCE_ONLY_PATTERN =
  /^(?:好[，,。.\s]*)?(?:(?:那我|我来|我给你|给你|这就|马上|现在)?[^。！？!?\n]{0,10}(?:点|放|送|递|找|换)[^。！？!?\n]{0,14}(?:给你|给鼠|给小仓鼠|你|鼠)?|这就(?:放|点)(?:给你|给鼠)?)[。.!！\s]*$/;
const GENERIC_MUSIC_KEYWORD_PATTERN =
  /纯音乐|无歌词|轻音乐|安静|舒缓|温柔|睡前|钢琴独奏|器乐|伴奏|lofi|chillhop|适合|场景|氛围|放松|治愈|平静/i;
const MAX_MUSIC_CARDS_PER_REPLY = 3;
const RECENT_MUSIC_HISTORY_LIMIT = 8;

export function getMusicCardLimit(multipleCardsEnabled: boolean) {
  return multipleCardsEnabled ? MAX_MUSIC_CARDS_PER_REPLY : 1;
}

export function shouldAutoplayMusicCard(
  autoplayEnabled: boolean,
  cardIndex: number,
  autoplayOverride?: boolean,
) {
  return autoplayEnabled && (autoplayOverride ?? cardIndex === 0);
}

export function isMusicConfirmationText(text: string) {
  const normalized = text.replace(/\s+/g, '').trim();
  if (!normalized || MUSIC_CONFIRMATION_NEGATION_PATTERN.test(normalized)) return false;
  return MUSIC_CONFIRMATION_PATTERN.test(normalized);
}

export function normalizeMusicKeywords(
  maxCards: number,
  ...groups: Array<string | string[] | null | undefined>
) {
  const keywords: string[] = [];
  groups.flat().forEach((value) => {
    const keyword = value?.trim();
    if (!keyword) return;
    if (keywords.some((item) => item.toLowerCase() === keyword.toLowerCase())) return;
    keywords.push(keyword);
  });
  return keywords.slice(0, Math.max(1, maxCards));
}

export function inferAcceptedMusicKeyword(assistantContents: string[], userText: string, confirmedProposal?: string) {
  if (confirmedProposal) return confirmedProposal;
  const assistantText = assistantContents.join('\n');
  const combinedText = `${assistantText}\n${userText}`;
  const userWantsMusic =
    MUSIC_REQUEST_PATTERN.test(userText)
    || isMusicConfirmationText(userText)
    || ASSISTANT_MUSIC_PROMISE_PATTERN.test(assistantText);
  if (!userWantsMusic || !ASSISTANT_MUSIC_ACCEPTANCE_PATTERN.test(assistantText)) return undefined;

  const titleMatch = /《([^》]{1,80})》/.exec(assistantText);
  if (titleMatch?.[1]?.trim()) {
    const title = titleMatch[1].trim();
    if (/纯音乐|器乐|无歌词|钢琴|伴奏|lofi/i.test(combinedText)) return `${title} 纯音乐`;
    return title;
  }

  return undefined;
}

function isGenericMusicKeyword(keyword: string) {
  const normalized = keyword.trim();
  if (!normalized) return true;
  if (/《[^》]{1,80}》/.test(normalized)) return false;
  const compact = normalized.replace(/[\s，,、。！？!?；;…~～\-_/]+/g, '');
  if (compact.length > 26 && GENERIC_MUSIC_KEYWORD_PATTERN.test(normalized)) return true;
  return GENERIC_MUSIC_KEYWORD_PATTERN.test(normalized) && !/[《》]/.test(normalized) && normalized.split(/\s+/).length >= 3;
}

export function needsConcreteMusicRetry(
  contents: string[],
  musicKeywords: string[],
  userText: string,
  confirmedProposal?: string,
) {
  const assistantText = contents.join('\n');
  const assistantPromisesMusic = ASSISTANT_MUSIC_PROMISE_PATTERN.test(assistantText);
  if (!assistantPromisesMusic && !isMusicConfirmationText(userText) && !MUSIC_REQUEST_PATTERN.test(userText)) return false;
  if (confirmedProposal) return false;
  if (!musicKeywords.length) {
    return assistantPromisesMusic || ASSISTANT_MUSIC_ACCEPTANCE_PATTERN.test(assistantText);
  }
  return musicKeywords.some(isGenericMusicKeyword);
}

export function shouldRetryConcreteMusicReply(options: {
  assistantContents: string[];
  confirmedProposal?: string;
  musicEnabledAtRequest: boolean;
  musicEnabledNow: boolean;
  musicKeywords: string[];
  userText: string;
}) {
  return (
    options.musicEnabledAtRequest
    && options.musicEnabledNow
    && needsConcreteMusicRetry(
      options.assistantContents,
      options.musicKeywords,
      options.userText,
      options.confirmedProposal,
    )
  );
}

export function buildConcreteMusicRetryInstruction(multipleCardsEnabled: boolean) {
  const cardCountInstruction = multipleCardsEnabled
    ? '如果小仓鼠明确要多首，可以给 2 到 3 首；否则只给一首。'
    : '本机当前关闭了多首音乐卡，只给一首。';
  return `【点歌重写】
刚才的回复没有给出可搜索的具体歌曲，请重新写一版。

I 根据此刻对话氛围亲自选一首具体歌。
回复包含自然聊天正文和一个音乐指令：
[MUSIC:准确歌曲名 准确歌手名/演奏者名]

如果小仓鼠偏好无歌词、纯音乐、钢琴、器乐或轻音乐，选择具体的对应版本。
${cardCountInstruction}

正文只说正在递歌或把歌放到下面。
播放成功前，不写已经播放、正在听或声音响起。`;
}

export function removeMusicAcceptanceOnlyBubbles(contents: string[], hasMusic: boolean) {
  if (!hasMusic) return contents;
  const filtered = contents.filter((content) => !MUSIC_ACCEPTANCE_ONLY_PATTERN.test(content.trim()));
  return filtered.length ? filtered : ['我把歌放在下面。'];
}

export function buildMusicAbilityHandshakeMessages(multipleCardsEnabled: boolean): ApiChatMessage[] {
  const cardModeInstruction = multipleCardsEnabled
    ? '2. 小仓鼠明确要歌单、多首或连放时，可以输出多个 [MUSIC:...]；每个指令一首，系统最多展示三张音乐卡。'
    : '2. 本机当前关闭了“多首音乐卡”：即使小仓鼠要你点歌，也只输出一个 [MUSIC:...]，不要给她选择题。';
  return [
    {
      role: 'user',
      content: [
        '[系统能力] I 可以在回复中根据对话氛围使用以下指令：',
        '1. [MUSIC:歌曲名 歌手名] — 点歌/推荐音乐。应用会自动隐藏指令并展示播放卡片；只说“我来放/我点这首”但不写该指令，就不会触发点歌。',
        cardModeInstruction,
        '3. 小仓鼠偏好纯音乐、钢琴、器乐、轻音乐、无歌词时，指令里要写“纯音乐/钢琴/器乐/伴奏/lofi”等版本关键词。',
        '4. [MUSIC:...] 必须是具体歌曲和歌手/演奏者，不能只写“纯音乐、无歌词、轻音乐、安静、舒缓、睡前”等分类词。',
        '5. 不要在歌曲卡片实际出现前描写已经播放、听见旋律、播放器弹出。',
        '6. 不要把这些指令语法解释给小仓鼠。',
      ].join('\n'),
    },
    {
      role: 'assistant',
      content: '好的，需要点歌时 I 会使用 [MUSIC:歌曲名 歌手名] 指令；如果只是口头说“我来放”，我知道那不算点歌成功。',
    },
  ];
}

export function getMessageMusicCards(message: SubjectiveMessage) {
  return message.musicCards?.length ? message.musicCards : message.musicCard ? [message.musicCard] : [];
}

function getMusicSongKey(song: MusicSong) {
  return `${song.name} ${song.artist}`.toLowerCase().replace(/[\s·•・\-—_《》〈〉「」『』“”"'，。！？、]/g, '');
}

export function withUpdatedMessageMusicCard(
  message: SubjectiveMessage,
  cardIndex: number,
  musicCard: MessageMusicCard,
) {
  const cards = getMessageMusicCards(message);
  const nextCards = cards.length ? [...cards] : [musicCard];
  nextCards[cardIndex] = musicCard;
  return {
    ...message,
    musicCard: nextCards[0],
    musicCards: nextCards,
  };
}

export function buildMusicAvoidance(messages: SubjectiveMessage[], currentMessageId?: string, currentCardIndex?: number) {
  const songIds: string[] = [];
  const songKeys: string[] = [];
  const seen = new Set<string>();

  for (const message of [...messages].reverse()) {
    if (message.role !== 'I') continue;
    for (const [cardIndex, card] of getMessageMusicCards(message).entries()) {
      if (message.id === currentMessageId && cardIndex === currentCardIndex) continue;
      if (card.status !== 'ready' || !card.song) continue;
      const key = getMusicSongKey(card.song);
      if (seen.has(key)) continue;
      seen.add(key);
      songIds.push(card.song.id);
      songKeys.push(`${card.song.name} ${card.song.artist}`);
      if (songIds.length >= RECENT_MUSIC_HISTORY_LIMIT) break;
    }
    if (songIds.length >= RECENT_MUSIC_HISTORY_LIMIT) break;
  }

  return { songIds, songKeys };
}

export function buildRecentMusicHistoryContext(messages: SubjectiveMessage[]) {
  const seen = new Set<string>();
  const lines: string[] = [];

  for (const message of [...messages].reverse()) {
    if (message.role !== 'I') continue;
    for (const card of getMessageMusicCards(message)) {
      if (card.status !== 'ready' || !card.song) continue;
      const key = getMusicSongKey(card.song);
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(`- 《${card.song.name}》 - ${card.song.artist || '未知歌手'}（搜索词：${card.keyword}）`);
      if (lines.length >= RECENT_MUSIC_HISTORY_LIMIT) break;
    }
    if (lines.length >= RECENT_MUSIC_HISTORY_LIMIT) break;
  }

  if (!lines.length) return '';
  return [
    '【最近实际点过的歌】',
    ...lines,
    '除非小仓鼠明确要求重听，否则本轮点歌不要重复以上歌曲；想呼应旧歌时，换成相近但不同的曲子或不同的纯音乐/器乐版本。',
  ].join('\n');
}

export function getLastAssistantMusicProposal(messages: SubjectiveMessage[], latestYouMessage: SubjectiveMessage) {
  const latestYouIndex = messages.findIndex((message) => message.id === latestYouMessage.id);
  const previousMessages = latestYouIndex >= 0 ? messages.slice(0, latestYouIndex) : messages;
  for (const message of [...previousMessages].reverse()) {
    if (message.role === 'you' && message.deliveryStatus !== 'failed') return undefined;
    if (message.role !== 'I') continue;
    const previousCard = getMessageMusicCards(message)[0];
    if (previousCard?.song) {
      return `${previousCard.song.name} ${previousCard.song.artist}`.trim();
    }
    if (previousCard?.keyword?.trim()) return previousCard.keyword.trim();
    const keyword = extractMusicCommand([message.content]).keyword;
    if (keyword) return keyword;
  }
  return undefined;
}
