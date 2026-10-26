import type { MusicSong } from '../ai/subjectiveMessages';
import { executeAgentToolCall } from '../tools/toolAgentExecution';
import { executeAlarmHandlingOnce } from './alarmExecutionOnce';
import {
  loadDueMusicAlarms,
  loadAlarmRecordById,
  markAlarmMusicFailed,
  markAlarmMusicPlayed,
  type JunLuoAlarmRecord,
} from './alarmStore';

export type MusicAlarmRunResult = {
  alarmId: string;
  ok: boolean;
  summary: string;
};

const MUSIC_ALARM_ALLOWED_TOOL_IDS = ['music.search_candidates', 'music.play'];

type MusicAlarmRunOptions = {
  backupRestoreLeaseHeld?: boolean;
};

function createMusicAlarmExecutionId(alarm: JunLuoAlarmRecord) {
  return `music-alarm-${alarm.id}-${Date.now()}`;
}

function readSongFromSearchResult(data: unknown): MusicSong | null {
  if (!data || typeof data !== 'object') return null;
  const candidate = (data as { song?: unknown }).song;
  if (!candidate || typeof candidate !== 'object') return null;
  const song = candidate as Partial<MusicSong>;
  if (typeof song.id !== 'string' || !song.id.trim()) return null;
  if (typeof song.name !== 'string' || !song.name.trim()) return null;
  return {
    album: typeof song.album === 'string' ? song.album : '',
    artist: typeof song.artist === 'string' ? song.artist : '',
    cover: typeof song.cover === 'string' ? song.cover : '',
    duration: typeof song.duration === 'number' && Number.isFinite(song.duration) ? song.duration : 0,
    id: song.id.trim(),
    name: song.name.trim(),
  };
}

async function resolveMusicAlarmSong(
  alarm: JunLuoAlarmRecord,
  executionId: string,
  options: MusicAlarmRunOptions,
): Promise<MusicSong | null> {
  if (alarm.musicSong) return alarm.musicSong;
  if (!alarm.musicKeyword) return null;
  const searchResult = await executeAgentToolCall({
    input: { keyword: alarm.musicKeyword },
    requestedBy: 'proactive',
    sourceMessageId: `alarm:${alarm.id}`,
    toolId: 'music.search_candidates',
  }, {
    allowToolIds: MUSIC_ALARM_ALLOWED_TOOL_IDS,
    backupRestoreLeaseHeld: options.backupRestoreLeaseHeld,
    executionId,
  });
  return searchResult.ok ? readSongFromSearchResult(searchResult.data) : null;
}

async function runSingleMusicAlarmLocally(
  alarm: JunLuoAlarmRecord,
  options: MusicAlarmRunOptions,
): Promise<MusicAlarmRunResult> {
  const executionId = createMusicAlarmExecutionId(alarm);
  try {
    const song = await resolveMusicAlarmSong(alarm, executionId, options);
    if (!song) {
      const summary = '音乐闹钟没有解析到可播放歌曲';
      await markAlarmMusicFailed(alarm.id, summary);
      return { alarmId: alarm.id, ok: false, summary };
    }
    const playResult = await executeAgentToolCall({
      input: { song },
      requestedBy: 'proactive',
      sourceMessageId: `alarm:${alarm.id}`,
      toolId: 'music.play',
    }, {
      allowToolIds: MUSIC_ALARM_ALLOWED_TOOL_IDS,
      backupRestoreLeaseHeld: options.backupRestoreLeaseHeld,
      executionId,
    });
    if (playResult.ok) {
      await markAlarmMusicPlayed(alarm.id, playResult.summary);
      return { alarmId: alarm.id, ok: true, summary: playResult.summary };
    }
    await markAlarmMusicFailed(alarm.id, playResult.summary);
    return { alarmId: alarm.id, ok: false, summary: playResult.summary };
  } catch (error) {
    const summary = error instanceof Error ? error.message : String(error);
    await markAlarmMusicFailed(alarm.id, summary);
    return { alarmId: alarm.id, ok: false, summary };
  }
}

async function runSingleMusicAlarm(
  alarm: JunLuoAlarmRecord,
  options: MusicAlarmRunOptions,
): Promise<MusicAlarmRunResult> {
  let localResult: MusicAlarmRunResult | null = null;
  try {
    const handling = await executeAlarmHandlingOnce(
      alarm.id,
      async () => {
        localResult = await runSingleMusicAlarmLocally(alarm, options);
        return localResult.ok ? 'completed' : 'failed';
      },
    );
    if (localResult) return localResult;
    const current = await loadAlarmRecordById(alarm.id);
    return {
      alarmId: alarm.id,
      ok: handling.outcome === 'completed',
      summary: current?.musicPlayResultSummary
        ?? current?.musicPlayErrorMessage
        ?? '',
    };
  } catch (error) {
    return {
      alarmId: alarm.id,
      ok: false,
      summary: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runDueMusicAlarms(now = Date.now(), options: MusicAlarmRunOptions = {}) {
  const dueAlarms = await loadDueMusicAlarms(now);
  const results: MusicAlarmRunResult[] = [];
  for (const alarm of dueAlarms) {
    results.push(await runSingleMusicAlarm(alarm, options));
  }
  return {
    attempted: results.length,
    results,
  };
}
