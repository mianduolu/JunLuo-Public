import type { ChatPreferences } from '../../chat/chatPreferences';
import { loadChatPreferences, saveChatPreferences } from '../../chat/chatPreferences';
import { getMusicStreamUrl, requestMusicCandidates, testNeteaseMusic } from '../../music/neteaseMusic';
import type { MusicSong } from '../../ai/subjectiveMessages';
import { captureBackupRestoreDataEpoch } from '../../backup/backupRestoreCoordinator';
import {
  dispatchMusicPlaybackControl,
  dispatchPreparedMusicPlayback,
  hasRegisteredMusicPlaybackHost,
  playMusicThroughRegisteredExecutor,
} from '../musicPlaybackBridge';
import type { MusicControlAction } from '../musicPlaybackBridge';
import { createToolError } from '../toolErrors';
import { createToolErrorResult, createToolSuccessResult } from '../toolResult';
import type { JunLuoToolCall, JunLuoToolDefinition, JunLuoToolPackage, JunLuoToolResult } from '../toolTypes';
import {
  readBooleanInput,
  readStringArrayInput,
  readStringInput,
  validationFailed,
} from './builtinToolValidation';

type MusicSearchCandidatesData = {
  candidates: MusicSong[];
  duplicateAvoided?: boolean;
  requestedKeyword: string;
  searchKeyword: string;
  song: MusicSong;
};

type MusicPlayData = {
  candidates?: MusicSong[];
  requestedKeyword?: string;
  searchKeyword?: string;
  duplicateAvoided?: boolean;
  album: string;
  artist: string;
  confirmedAt: number;
  duration: number;
  id: string;
  name: string;
  playbackState: 'playing';
  song: MusicSong;
};

type MusicControlData = {
  action: MusicControlAction;
  confirmedAt: number;
  currentSong: MusicSong | null;
  playbackState: 'paused' | 'playing' | 'stopped';
};

type MusicPreferenceData = Pick<ChatPreferences, 'musicAutoplay' | 'musicEnabled' | 'musicMultipleCardsEnabled'>;

type MusicConnectionData = {
  detail: string;
};

function readSongInput(input: Record<string, unknown>): MusicSong | null {
  const song = input.song;
  if (!song || typeof song !== 'object') return null;
  const candidate = song as Record<string, unknown>;
  if (typeof candidate.id !== 'string' || !candidate.id.trim()) return null;
  if (typeof candidate.name !== 'string' || !candidate.name.trim()) return null;
  return {
    album: typeof candidate.album === 'string' ? candidate.album : '',
    artist: typeof candidate.artist === 'string' ? candidate.artist : '',
    cover: typeof candidate.cover === 'string' ? candidate.cover : '',
    duration: typeof candidate.duration === 'number' && Number.isFinite(candidate.duration) ? candidate.duration : 0,
    id: candidate.id.trim(),
    name: candidate.name.trim(),
  };
}

async function executeMusicSearchCandidates(
  call: JunLuoToolCall,
): Promise<JunLuoToolResult<MusicSearchCandidatesData>> {
  const keyword = readStringInput(call.input, 'keyword');
  if (!keyword) return validationFailed(call, '缺少搜歌关键词', '没有搜索歌曲');
  const result = await requestMusicCandidates(keyword, {
    avoidSongIds: readStringArrayInput(call.input, 'avoidSongIds'),
    avoidSongKeys: readStringArrayInput(call.input, 'avoidSongKeys'),
  });
  return createToolSuccessResult(call, `已找到歌曲候选：${result.song.name} - ${result.song.artist}`, {
    candidates: result.candidates,
    duplicateAvoided: result.duplicateAvoided,
    requestedKeyword: keyword,
    searchKeyword: result.searchKeyword,
    song: result.song,
  });
}

async function executeMusicPlay(
  call: JunLuoToolCall,
  context?: { runBackupRestoreDataEpochCommit?: <T>(work: () => Promise<T> | T) => Promise<T> },
): Promise<JunLuoToolResult<MusicPlayData | MusicSearchCandidatesData>> {
  const dataEpoch = captureBackupRestoreDataEpoch();
  let song = readSongInput(call.input);
  const keyword = readStringInput(call.input, 'keyword');
  if (!song && !keyword) return validationFailed(call, '缺少歌曲或搜歌关键词', '没有播放音乐');
  let search: Awaited<ReturnType<typeof requestMusicCandidates>> | undefined;
  try {
    if (!song) {
      search = await requestMusicCandidates(keyword);
      song = search.song;
    }
    let confirmedAt = Date.now();
    if (hasRegisteredMusicPlaybackHost()) {
      const streamUrl = await getMusicStreamUrl(song.id);
      const receipt = await dispatchPreparedMusicPlayback(
        { song, streamUrl, ...(dataEpoch === null ? {} : { observationOwner: { call, dataEpoch } }) },
        context?.runBackupRestoreDataEpochCommit,
      );
      confirmedAt = receipt.confirmedAt;
    } else {
      await playMusicThroughRegisteredExecutor(song);
    }
    return createToolSuccessResult(call, `已开始播放：${song.name} - ${song.artist}`, {
      album: song.album,
      artist: song.artist,
      confirmedAt,
      duration: song.duration,
      id: song.id,
      name: song.name,
      playbackState: 'playing',
      song,
      ...(search ? { candidates: search.candidates, searchKeyword: search.searchKeyword, requestedKeyword: keyword, duplicateAvoided: search.duplicateAvoided } : {}),
    });
  } catch (error) {
    return { ...createToolErrorResult(
      call,
      createToolError('EXECUTION_FAILED', error instanceof Error ? error.message : String(error)),
      `没有播放音乐：${song?.name || keyword}`,
    ), ...(search ? { data: { ...search, requestedKeyword: keyword } } : {}) };
  }
}

function readMusicControlAction(input: Record<string, unknown>): MusicControlAction | null {
  const action = readStringInput(input, 'action');
  return action === 'pause' || action === 'resume' || action === 'stop' ? action : null;
}

async function executeMusicControl(
  call: JunLuoToolCall,
  context?: { runBackupRestoreDataEpochCommit?: <T>(work: () => Promise<T> | T) => Promise<T> },
): Promise<JunLuoToolResult<MusicControlData>> {
  const action = readMusicControlAction(call.input);
  if (!action) return validationFailed(call, '缺少有效的播放器控制动作', '没有控制音乐播放器');
  try {
    const receipt = await dispatchMusicPlaybackControl(
      action,
      context?.runBackupRestoreDataEpochCommit,
      call.callId,
    );
    return createToolSuccessResult(call, '音乐播放器状态已经更新', {
      action,
      confirmedAt: receipt.confirmedAt,
      currentSong: receipt.song,
      playbackState: receipt.state,
    });
  } catch (error) {
    return createToolErrorResult(
      call,
      createToolError('EXECUTION_FAILED', error instanceof Error ? error.message : String(error)),
      '没有控制音乐播放器',
    );
  }
}

async function executeMusicSavePreference(call: JunLuoToolCall): Promise<JunLuoToolResult<MusicPreferenceData>> {
  const current = await loadChatPreferences();
  const next: ChatPreferences = {
    ...current,
    musicAutoplay: readBooleanInput(call.input, 'musicAutoplay') ?? current.musicAutoplay,
    musicEnabled: readBooleanInput(call.input, 'musicEnabled') ?? current.musicEnabled,
    musicMultipleCardsEnabled: readBooleanInput(call.input, 'musicMultipleCardsEnabled') ?? current.musicMultipleCardsEnabled,
  };
  await saveChatPreferences(next);
  return createToolSuccessResult(call, '已保存音乐点歌偏好', {
    musicAutoplay: next.musicAutoplay,
    musicEnabled: next.musicEnabled,
    musicMultipleCardsEnabled: next.musicMultipleCardsEnabled,
  });
}

async function executeMusicTestConnection(call: JunLuoToolCall): Promise<JunLuoToolResult<MusicConnectionData>> {
  const result = await testNeteaseMusic();
  if (!result.ok) return validationFailed(call, result.detail, '网易云音乐连接测试没有通过');
  return createToolSuccessResult(call, result.detail, { detail: result.detail });
}

export const musicSearchCandidatesTool: JunLuoToolDefinition<Record<string, unknown>, MusicSearchCandidatesData> = {
  id: 'music.search_candidates',
  chatExposure: 'candidate',
  proactiveEligible: true,
  packageId: 'music',
  name: '搜索音乐候选',
  description: '搜索网易云音乐候选歌曲，返回主歌曲和备用候选。搜索成功不等于已经播放。',
  inputSchema: {
    type: 'object',
    required: ['keyword'],
    properties: {
      keyword: { type: 'string', description: '搜歌关键词' },
    },
  },
  permission: 'ask',
  riskLevel: 'external_network',
  readOnly: true,
  conflictGroup: 'music-search',
  agentEpochMode: 'read_only_outside_lease',
  agentSettlementDeadlineMs: 30_000,
  backupRestoreSafeOutsideLease: true,
  executor: executeMusicSearchCandidates,
};

export const musicPlayTool: JunLuoToolDefinition<Record<string, unknown>, MusicPlayData | MusicSearchCandidatesData> = {
  id: 'music.play',
  chatExposure: 'candidate',
  proactiveEligible: true,
  packageId: 'music',
  name: '点歌并播放',
  description: '提供搜索词时，搜索并播放一首歌曲；提供本轮搜索返回的歌曲对象时，播放该歌曲。只有播放器确认进入播放状态才返回成功。',
  inputSchema: {
    type: 'object',
    properties: {
      keyword: { type: 'string', description: '搜歌关键词' },
      song: {
        type: 'object',
        description: '本轮搜索结果中的完整歌曲对象；保持候选 ID、歌名和歌手不变。',
        required: ['id', 'name'],
        properties: {
          album: { type: 'string' },
          artist: { type: 'string' },
          cover: { type: 'string' },
          duration: { type: 'number' },
          id: { type: 'string' },
          name: { type: 'string' },
        },
      },
    },
  },
  permission: 'ask',
  riskLevel: 'external_network',
  readOnly: false,
  conflictGroup: 'music-player',
  executionScope: 'local_device',
  agentEpochMode: 'bounded_local_commits',
  agentSettlementDeadlineMs: 90_000,
  backupRestoreSafeOutsideLease: true,
  executor: executeMusicPlay,
};

export const musicControlTool: JunLuoToolDefinition<Record<string, unknown>, MusicControlData> = {
  id: 'music.control',
  chatExposure: 'candidate',
  proactiveEligible: false,
  packageId: 'music',
  name: '控制音乐播放器',
  description: '控制君落当前播放器，暂停、继续或停止当前歌曲，并返回实际播放状态。',
  inputSchema: {
    type: 'object',
    required: ['action'],
    properties: {
      action: {
        type: 'string',
        enum: ['pause', 'resume', 'stop'],
        description: '对当前播放器执行的动作：pause 暂停，resume 继续，stop 停止并关闭当前歌曲。',
      },
    },
  },
  permission: 'ask',
  riskLevel: 'device_control',
  readOnly: false,
  conflictGroup: 'music-player',
  executionScope: 'local_device',
  agentEpochMode: 'bounded_local_commits',
  agentSettlementDeadlineMs: 90_000,
  backupRestoreSafeOutsideLease: true,
  executor: executeMusicControl,
};

export const musicSavePreferenceTool: JunLuoToolDefinition<Record<string, unknown>, MusicPreferenceData> = {
  id: 'music.save_preference',
  chatExposure: 'explicit_only',
  proactiveEligible: false,
  packageId: 'music',
  name: '保存音乐偏好',
  description: '保存君落聊天里的音乐点歌开关、自动播放和多音乐卡偏好。不保存网易云 Cookie。',
  inputSchema: {
    type: 'object',
    properties: {
      musicAutoplay: { type: 'boolean', description: '是否自动播放第一首音乐卡' },
      musicEnabled: { type: 'boolean', description: '是否允许白云点歌' },
      musicMultipleCardsEnabled: { type: 'boolean', description: '是否允许一次给多首音乐卡' },
    },
  },
  permission: 'ask',
  riskLevel: 'write_local',
  readOnly: false,
  executor: executeMusicSavePreference,
};

export const musicTestConnectionTool: JunLuoToolDefinition<Record<string, unknown>, MusicConnectionData> = {
  id: 'music.test_connection',
  chatExposure: 'explicit_only',
  proactiveEligible: false,
  packageId: 'music',
  name: '测试网易云连接',
  description: '测试当前匿名或已登录网易云播放连接是否可用。',
  inputSchema: { type: 'object' },
  permission: 'ask',
  riskLevel: 'external_network',
  readOnly: true,
  executor: executeMusicTestConnection,
};

export const musicToolPackage: JunLuoToolPackage = {
  id: 'music',
  name: '音乐播放',
  description: '搜索音乐候选、播放歌曲、保存音乐偏好和测试网易云连接。',
  category: 'media',
  tools: [
    musicSearchCandidatesTool,
    musicPlayTool,
    musicControlTool,
    musicSavePreferenceTool,
    musicTestConnectionTool,
  ],
  defaultEnabled: true,
  riskLevel: 'external_network',
  source: 'builtin',
};
