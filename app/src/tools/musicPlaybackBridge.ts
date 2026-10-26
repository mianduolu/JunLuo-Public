import type { MusicSong } from '../ai/subjectiveMessages';
import type { MusicPlaybackObservationOwner } from '../music/musicPlaybackObserver';

export type JunLuoMusicPlaybackExecutor = (song: MusicSong) => Promise<void> | void;

export type MusicPlaybackState = 'playing' | 'paused' | 'stopped';

export type MusicControlAction = 'pause' | 'resume' | 'stop';

export type ReminderMusicPlaybackOwner = {
  occurrenceId: string;
  attemptId: string;
};

export type MusicPlaybackSnapshot = {
  currentSong: MusicSong | null;
  state: MusicPlaybackState;
  updatedAt: number;
  reminderOwner?: ReminderMusicPlaybackOwner;
};

export type MusicPlaybackReceipt = {
  attemptId: string;
  state: MusicPlaybackState;
  song: MusicSong | null;
  confirmedAt: number;
  reminderOwner?: ReminderMusicPlaybackOwner;
};

export type PreparedMusicPlayback = {
  song: MusicSong;
  streamUrl: string;
  observationOwner?: MusicPlaybackObservationOwner;
  reminderOwner?: ReminderMusicPlaybackOwner;
};

export type JunLuoMusicPlaybackHost = {
  dispatchPlay: (prepared: PreparedMusicPlayback) => { attemptId: string };
  dispatchControl: (action: MusicControlAction, evidenceCallId?: string) => { attemptId: string };
  waitForReceipt: (attemptId: string) => Promise<MusicPlaybackReceipt>;
  getSnapshot: () => MusicPlaybackSnapshot;
  supportsReminderOwnership?: boolean;
  prepareForPlayback?: () => Promise<void>;
};

let musicPlaybackExecutor: JunLuoMusicPlaybackExecutor | null = null;
let musicPlaybackHost: JunLuoMusicPlaybackHost | null = null;

export function registerMusicPlaybackHost(host: JunLuoMusicPlaybackHost) {
  musicPlaybackHost = host;
  return () => {
    if (musicPlaybackHost === host) {
      musicPlaybackHost = null;
    }
  };
}

export function registerMusicPlaybackExecutor(executor: JunLuoMusicPlaybackExecutor) {
  musicPlaybackExecutor = executor;
  return () => {
    if (musicPlaybackExecutor === executor) {
      musicPlaybackExecutor = null;
    }
  };
}

export function clearMusicPlaybackExecutorForTests() {
  musicPlaybackExecutor = null;
}

export function clearMusicPlaybackHostForTests() {
  musicPlaybackHost = null;
}

export function getRegisteredMusicPlaybackSnapshot() {
  return musicPlaybackHost?.getSnapshot() ?? null;
}

export function hasRegisteredMusicPlaybackHost() {
  return musicPlaybackHost !== null;
}

export async function dispatchPreparedMusicPlayback(
  prepared: PreparedMusicPlayback,
  runDispatch?: <T>(work: () => T) => Promise<T>,
): Promise<MusicPlaybackReceipt> {
  if (musicPlaybackHost) {
    const host = musicPlaybackHost;
    const dispatch = () => host.dispatchPlay(prepared);
    const { attemptId } = runDispatch ? await runDispatch(dispatch) : dispatch();
    const receipt = await host.waitForReceipt(attemptId);
    if (
      receipt.attemptId !== attemptId
      || receipt.state !== 'playing'
      || receipt.song?.id !== prepared.song.id
    ) {
      throw new Error('音乐播放器没有确认目标歌曲进入播放状态。');
    }
    return receipt;
  }
  if (musicPlaybackExecutor) {
    await musicPlaybackExecutor(prepared.song);
    return {
      attemptId: 'legacy-music-playback',
      state: 'playing',
      song: prepared.song,
      confirmedAt: Date.now(),
    };
  }
  throw new Error('音乐播放器宿主尚未注册。');
}

export async function dispatchMusicPlaybackControl(
  action: MusicControlAction,
  runDispatch?: <T>(work: () => T) => Promise<T>,
  evidenceCallId?: string,
): Promise<MusicPlaybackReceipt> {
  if (!musicPlaybackHost) {
    throw new Error('音乐播放器宿主尚未注册。');
  }
  const host = musicPlaybackHost;
  const dispatch = () => host.dispatchControl(action, evidenceCallId);
  const { attemptId } = runDispatch ? await runDispatch(dispatch) : dispatch();
  const receipt = await host.waitForReceipt(attemptId);
  const expectedState: MusicPlaybackState = action === 'pause'
    ? 'paused'
    : action === 'resume'
      ? 'playing'
      : 'stopped';
  if (receipt.attemptId !== attemptId || receipt.state !== expectedState) {
    throw new Error('音乐播放器没有确认控制后的实际状态。');
  }
  return receipt;
}

export function sameReminderMusicOwner(
  left: ReminderMusicPlaybackOwner | undefined,
  right: ReminderMusicPlaybackOwner | undefined,
) {
  return !!left && !!right && left.occurrenceId === right.occurrenceId
    && left.attemptId === right.attemptId;
}

export async function dispatchReminderMusicPlayback(
  prepared: PreparedMusicPlayback,
  owner: ReminderMusicPlaybackOwner,
  runDispatch?: <T>(work: () => T) => Promise<T>,
): Promise<MusicPlaybackReceipt> {
  if (!musicPlaybackHost) {
    const { ensureSharedMusicPlaybackHost } = await import('../music/sharedMusicPlaybackHost');
    await ensureSharedMusicPlaybackHost();
  }
  const host = musicPlaybackHost;
  if (!host?.supportsReminderOwnership) throw new Error('音乐播放器未提供提醒播放回执。');
  await host.prepareForPlayback?.();
  const snapshot = host.getSnapshot();
  if (sameReminderMusicOwner(snapshot.reminderOwner, owner) && snapshot.state === 'playing'
    && snapshot.currentSong?.id === prepared.song.id) {
    return { attemptId: owner.attemptId, state: 'playing', song: snapshot.currentSong,
      confirmedAt: snapshot.updatedAt, reminderOwner: owner };
  }
  const dispatch = () => {
    if (musicPlaybackHost !== host) throw new Error('音乐播放器宿主已改变。');
    return host.dispatchPlay({ ...prepared, reminderOwner: owner });
  };
  const { attemptId } = runDispatch ? await runDispatch(dispatch) : dispatch();
  const receipt = await host.waitForReceipt(attemptId);
  if (receipt.attemptId !== attemptId || receipt.state !== 'playing'
    || receipt.song?.id !== prepared.song.id || !sameReminderMusicOwner(receipt.reminderOwner, owner)) {
    throw new Error('音乐播放器没有确认目标歌曲进入播放状态。');
  }
  return receipt;
}

export async function dispatchReminderMusicControl(
  action: MusicControlAction,
  owner: ReminderMusicPlaybackOwner,
  runDispatch?: <T>(work: () => T) => Promise<T>,
): Promise<MusicPlaybackReceipt> {
  const host = musicPlaybackHost;
  if (!host?.supportsReminderOwnership) throw new Error('音乐播放器宿主尚未注册。');
  const dispatch = () => {
    if (musicPlaybackHost !== host || !sameReminderMusicOwner(host.getSnapshot().reminderOwner, owner)) {
      throw new Error('这次音乐提醒已不再控制当前歌曲。');
    }
    return host.dispatchControl(action);
  };
  const { attemptId } = runDispatch ? await runDispatch(dispatch) : dispatch();
  const receipt = await host.waitForReceipt(attemptId);
  const expectedState = action === 'stop' ? 'stopped' : action === 'pause' ? 'paused' : 'playing';
  if (receipt.attemptId !== attemptId || receipt.state !== expectedState
    || !sameReminderMusicOwner(receipt.reminderOwner, owner)) {
    throw new Error('音乐播放器没有确认控制后的实际状态。');
  }
  return receipt;
}

export async function playMusicThroughRegisteredExecutor(song: MusicSong) {
  if (!musicPlaybackExecutor) {
    throw new Error('音乐播放器宿主尚未注册。');
  }
  await musicPlaybackExecutor(song);
}
