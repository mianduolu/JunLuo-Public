import AsyncStorage from '@react-native-async-storage/async-storage';

import type { MusicSong } from '../ai/subjectiveMessages';
import { getSecretItem } from '../storage/secretStore';
import {
  NETEASE_MUSIC_U_SECRET_KEY,
} from '../sync/syncVaultExportableSessionRegistry';
import {
  deleteVaultExportableSessionSecret,
  setVaultExportableSessionSecret,
} from '../sync/syncVaultExportableSessionsStorageBridge';

const NETEASE_BASE_URL = 'https://music.163.com';
const COMMON_HEADERS = {
  Referer: `${NETEASE_BASE_URL}/`,
  'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Mobile Safari/537.36',
};
const NON_SONG_PATTERN =
  /广播剧|有声书|有声小说|剧情|对白|念白|朗诵|播客|电台|片段|花絮|配音|翻配|声展|主题曲剧情版|纯人声对白|雨声|白噪|白噪音|自然声|环境音|溪水|流水|海浪|雷雨|助眠|睡眠|催眠|冥想|疗愈|治疗|放松音效|ASMR/i;

type NeteaseSong = {
  id?: unknown;
  name?: unknown;
  artists?: Array<{ name?: unknown }>;
  album?: { name?: unknown; picUrl?: unknown };
  duration?: unknown;
  fee?: unknown;
};

type NeteasePlayItem = {
  id?: unknown;
  url?: unknown;
};

type MusicCandidate = {
  fee?: number;
  song: MusicSong;
};

type MusicRequestResult = {
  candidates: MusicSong[];
  duplicateAvoided?: boolean;
  searchKeyword: string;
  song: MusicSong;
};

type MusicRequestOptions = {
  avoidSongIds?: string[];
  avoidSongKeys?: string[];
};

const streamUrlCache = new Map<string, { expiresAt: number; url: string }>();

function normalizeMusicU(value: string) {
  const trimmed = value.trim();
  const match = trimmed.match(/(?:^|;\s*)MUSIC_U=([^;]+)/i);
  return (match?.[1] || trimmed).trim();
}

async function buildHeaders() {
  const musicU = await loadNeteaseMusicU();
  return musicU
    ? { ...COMMON_HEADERS, Cookie: `MUSIC_U=${musicU}` }
    : COMMON_HEADERS;
}

function normalizeSong(song: NeteaseSong): MusicCandidate | null {
  if ((typeof song.id !== 'number' && typeof song.id !== 'string') || typeof song.name !== 'string') {
    return null;
  }
  const artist = Array.isArray(song.artists)
    ? song.artists
      .map((item) => (typeof item?.name === 'string' ? item.name : ''))
      .filter(Boolean)
      .join(' / ')
    : '';
  const album = song.album && typeof song.album === 'object' ? song.album : {};
  return {
    fee: typeof song.fee === 'number' ? song.fee : undefined,
    song: {
      album: typeof album.name === 'string' ? album.name : '',
      artist,
      cover:
        typeof album.picUrl === 'string' && album.picUrl
          ? `${album.picUrl}?param=240y240`
          : '',
      duration: typeof song.duration === 'number' ? song.duration : 0,
      id: String(song.id),
      name: song.name,
    },
  };
}

export async function loadNeteaseMusicU() {
  const secureValue = await getSecretItem(
    NETEASE_MUSIC_U_SECRET_KEY,
  );
  if (secureValue !== null) {
    await AsyncStorage.removeItem(
      NETEASE_MUSIC_U_SECRET_KEY,
    ).catch(() => undefined);
    return secureValue;
  }
  const legacyValue = await AsyncStorage.getItem(
    NETEASE_MUSIC_U_SECRET_KEY,
  );
  if (legacyValue === null) return null;
  const migrated = await saveNeteaseMusicU(legacyValue);
  await AsyncStorage.removeItem(NETEASE_MUSIC_U_SECRET_KEY);
  return migrated || null;
}

export async function saveNeteaseMusicU(value: string) {
  const normalized = normalizeMusicU(value);
  if (!normalized) {
    await deleteVaultExportableSessionSecret(
      NETEASE_MUSIC_U_SECRET_KEY,
    );
    await AsyncStorage.removeItem(NETEASE_MUSIC_U_SECRET_KEY);
    return '';
  }
  await setVaultExportableSessionSecret(
    NETEASE_MUSIC_U_SECRET_KEY,
    normalized,
  );
  await AsyncStorage.removeItem(NETEASE_MUSIC_U_SECRET_KEY);
  return normalized;
}

function normalizeSearchText(value: string) {
  return value.toLowerCase().replace(/[\s·•・\-—_《》〈〉「」『』“”"'，。！？、]/g, '');
}

function songMatchScore(song: MusicSong, keyword: string) {
  const query = normalizeSearchText(keyword);
  const name = normalizeSearchText(song.name);
  const artist = normalizeSearchText(song.artist);
  let score = 0;
  if (NON_SONG_PATTERN.test(`${song.name} ${song.album} ${song.artist}`)) score -= 1000;
  if (song.duration > 0 && song.duration < 60_000) score -= 300;
  if (song.duration >= 120_000 && song.duration <= 480_000) score += 20;
  if (query.includes(name)) score += 100;
  if (artist && query.includes(artist)) score += 60;
  if (query === `${name}${artist}` || query === `${artist}${name}`) score += 80;
  return score;
}

function isLikelySong(song: MusicSong) {
  if (NON_SONG_PATTERN.test(`${song.name} ${song.album} ${song.artist}`)) return false;
  return song.duration <= 0 || song.duration >= 60_000;
}

function buildSongAvoidance(options?: MusicRequestOptions) {
  const ids = new Set((options?.avoidSongIds || []).map((id) => id.trim()).filter(Boolean));
  const keys = new Set((options?.avoidSongKeys || []).map(normalizeSearchText).filter(Boolean));
  return (song: MusicSong) => {
    if (ids.has(song.id)) return true;
    const songKey = normalizeSearchText(`${song.name} ${song.artist}`);
    return !!songKey && keys.has(songKey);
  };
}

function buildMusicSearchQueries(keyword: string) {
  const trimmed = keyword.trim().replace(/\s{2,}/g, ' ');
  const queries: string[] = [];
  const push = (value: string) => {
    const query = value.trim().replace(/\s{2,}/g, ' ');
    if (!query || queries.some((item) => item.toLowerCase() === query.toLowerCase())) return;
    queries.push(query);
  };

  push(trimmed);
  const descriptorLike =
    trimmed.length > 18
    || /纯音乐|无歌词|轻音乐|安静|舒缓|温柔|睡前|钢琴独奏|器乐|伴奏|lofi|chillhop/i.test(trimmed);
  if (!descriptorLike) return queries;

  if (/《([^》]{1,80})》/.test(trimmed)) {
    const title = trimmed.match(/《([^》]{1,80})》/)?.[1];
    if (title) {
      push(`${title} 纯音乐`);
      push(title);
    }
  }
  const simplified = trimmed
    .replace(/纯音乐|无歌词|轻音乐|钢琴独奏|钢琴版|器乐版|器乐|伴奏版|伴奏|睡前|安静|静静|舒缓|温柔|放松|治愈|平静/gi, ' ')
    .replace(/\b(?:instrumental|piano|lofi|lo-fi|chillhop)\b/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (simplified && simplified !== trimmed) push(simplified);
  return queries.slice(0, 6);
}

async function searchMusicCandidates(keyword: string, options?: MusicRequestOptions): Promise<MusicRequestResult> {
  const body = new URLSearchParams({
    limit: '12',
    offset: '0',
    s: keyword.trim(),
    total: 'true',
    type: '1',
  });
  const response = await fetch(`${NETEASE_BASE_URL}/api/search/get/web`, {
    body: body.toString(),
    headers: {
      ...(await buildHeaders()),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    method: 'POST',
  });
  if (!response.ok) throw new Error('网易云搜索暂时不可用。');

  const payload = (await response.json()) as { result?: { songs?: NeteaseSong[] } };
  const candidates = (payload.result?.songs || [])
    .map(normalizeSong)
    .filter((candidate): candidate is MusicCandidate => !!candidate)
    .filter((candidate) => isLikelySong(candidate.song))
    .map((candidate, index) => ({
      ...candidate,
      index,
      score: songMatchScore(candidate.song, keyword) + (candidate.fee === 0 ? 35 : candidate.fee ? -35 : 0),
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index);
  if (!candidates.length) throw new Error('没有找到相关歌曲。');

  const playableSongs: MusicSong[] = [];
  for (const candidate of candidates.slice(0, 8)) {
    try {
      await getMusicStreamUrl(candidate.song.id);
      playableSongs.push(candidate.song);
      if (playableSongs.length >= 5) break;
    } catch {
      // Try the next close match instead of presenting an unplayable card.
    }
  }
  if (playableSongs.length) {
    const isAvoided = buildSongAvoidance(options);
    const song = playableSongs.find((candidate) => !isAvoided(candidate)) || playableSongs[0];
    return {
      candidates: playableSongs.filter((candidate) => candidate.id !== song.id).slice(0, 4),
      duplicateAvoided: song.id !== playableSongs[0]?.id,
      searchKeyword: keyword,
      song,
    };
  }
  throw new Error('找到的版本都暂时无法播放，可能需要会员或没有版权。');
}

export async function requestMusicCandidates(keyword: string, options?: MusicRequestOptions): Promise<MusicRequestResult> {
  const queries = buildMusicSearchQueries(keyword);
  let lastError: unknown;
  for (const query of queries) {
    try {
      return await searchMusicCandidates(query, options);
    } catch (caught) {
      lastError = caught;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('没有找到相关歌曲。');
}

export async function requestMusic(keyword: string): Promise<MusicSong> {
  return (await requestMusicCandidates(keyword)).song;
}

export async function getMusicStreamUrl(songId: string) {
  const cached = streamUrlCache.get(songId);
  if (cached && cached.expiresAt > Date.now()) return cached.url;
  const body = new URLSearchParams({
    br: '320000',
    ids: `[${songId}]`,
  });
  const response = await fetch(`${NETEASE_BASE_URL}/api/song/enhance/player/url`, {
    body: body.toString(),
    headers: {
      ...(await buildHeaders()),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    method: 'POST',
  });
  if (!response.ok) throw new Error('获取歌曲播放地址失败。');

  const payload = (await response.json()) as { data?: NeteasePlayItem[] };
  const item = payload.data?.find((candidate) => String(candidate.id) === songId) || payload.data?.[0];
  if (!item || typeof item.url !== 'string' || !item.url) {
    throw new Error('这首歌暂时无法播放，可能需要网易云会员或没有版权。');
  }
  const url = item.url.replace(/^http:\/\//i, 'https://');
  streamUrlCache.set(songId, { expiresAt: Date.now() + 10 * 60 * 1000, url });
  return url;
}

export async function testNeteaseMusic() {
  try {
    const result = await requestMusic('晴天 周杰伦');
    await getMusicStreamUrl(result.id);
    return { detail: '网易云音乐可以使用啦。', ok: true };
  } catch (caught) {
    return {
      detail: caught instanceof Error ? caught.message : '网易云音乐暂时连接失败。',
      ok: false,
    };
  }
}
