import { createAudioPlayer, setAudioModeAsync, type AudioPlayer, type AudioStatus } from 'expo-audio';

import type { MusicSong } from '../ai/subjectiveMessages';
import { recordMusicPlaybackObservation } from '../tools/toolAuditStore';
import {
  registerMusicPlaybackHost,
  type JunLuoMusicPlaybackHost,
  type MusicControlAction,
  type MusicPlaybackReceipt,
  type MusicPlaybackState,
  type PreparedMusicPlayback,
  type ReminderMusicPlaybackOwner,
} from '../tools/musicPlaybackBridge';
import { createMusicPlaybackObserver, type MusicPlaybackObservationOwner } from './musicPlaybackObserver';
import type { MusicPlaybackObservation } from './musicPlaybackObservation';

type PlayerPort = Pick<AudioPlayer, 'currentStatus' | 'replace' | 'play' | 'pause' | 'seekTo'
  | 'setActiveForLockScreen' | 'clearLockScreenControls' | 'remove' | 'addListener'>;
type ReceiptResult = { receipt: MusicPlaybackReceipt } | { error: Error };
type Pending = {
  action: 'play' | MusicControlAction;
  attemptId: string;
  song: MusicSong | null;
  reminderOwner?: ReminderMusicPlaybackOwner;
  observationOwner?: MusicPlaybackObservationOwner;
  evidenceCallId?: string;
  statusAtDispatch: AudioStatus;
  timeout: ReturnType<typeof setTimeout>;
};

/** The live player belongs to the app process, not to the React tree or a persisted alarm. */
export function createSharedMusicPlaybackHost(options: {
  createPlayer: () => PlayerPort;
  saveObservation: (owner: MusicPlaybackObservationOwner, event: MusicPlaybackObservation) => void;
  now?: () => number;
  receiptTimeoutMs?: number;
}) {
  const now = options.now ?? Date.now;
  const observer = createMusicPlaybackObserver(options.saveObservation, now);
  let player: PlayerPort | undefined;
  let statusListener: { remove(): void } | undefined;
  let status: AudioStatus;
  let currentSong: MusicSong | null = null;
  let reminderOwner: ReminderMusicPlaybackOwner | undefined;
  let state: MusicPlaybackState = 'stopped';
  let updatedAt = now();
  let sequence = 0;
  let pending: Pending | undefined;
  const listeners = new Set<() => void>();
  const results = new Map<string, ReceiptResult>();
  const waiters = new Map<string, Array<{ resolve: (receipt: MusicPlaybackReceipt) => void; reject: (error: Error) => void }>>();
  const publish = () => listeners.forEach(listener => listener());
  const settle = (attempt: Pending, result: ReceiptResult) => {
    clearTimeout(attempt.timeout);
    if (pending === attempt) pending = undefined;
    const waiting = waiters.get(attempt.attemptId);
    waiters.delete(attempt.attemptId);
    if (waiting?.length) waiting.forEach(waiter => 'receipt' in result
      ? waiter.resolve(result.receipt) : waiter.reject(result.error));
    else results.set(attempt.attemptId, result);
  };
  const releaseIfIdle = () => {
    if (!player || listeners.size || currentSong || pending) return;
    statusListener?.remove();
    statusListener = undefined;
    player.remove();
    player = undefined;
  };
  const observe = (next: AudioStatus) => {
    status = next;
    const nextState: MusicPlaybackState = !currentSong ? 'stopped' : next.playing ? 'playing' : 'paused';
    if (state !== nextState) updatedAt = now();
    state = nextState;
    const attempt = pending;
    if (attempt) {
      const playConfirmed = attempt.action === 'play' && next !== attempt.statusAtDispatch
        && next.isLoaded && next.playing && currentSong?.id === attempt.song?.id;
      const controlConfirmed = attempt.action === 'stop' ? !next.playing && !currentSong
        : attempt.action === 'pause' ? next.isLoaded && !next.playing
          : attempt.action === 'resume' && next.isLoaded && next.playing;
      if (playConfirmed || controlConfirmed) {
        if (playConfirmed && attempt.song) observer.confirmPlay(attempt.observationOwner, attempt.song);
        else observer.observe({ ...next, stopped: attempt.action === 'stop', evidenceCallId: attempt.evidenceCallId });
        updatedAt = now();
        settle(attempt, { receipt: { attemptId: attempt.attemptId, state, song: currentSong,
          confirmedAt: updatedAt, ...(attempt.reminderOwner ? { reminderOwner: attempt.reminderOwner } : {}) } });
        if (attempt.action === 'stop') reminderOwner = undefined;
      }
    } else if (currentSong) observer.observe(next);
    if (!listeners.size && next.didJustFinish && !pending) {
      currentSong = null;
      reminderOwner = undefined;
      state = 'stopped';
      player?.clearLockScreenControls();
    }
    publish();
    releaseIfIdle();
  };
  const getPlayer = () => {
    if (!player) {
      player = options.createPlayer();
      status = player.currentStatus;
      statusListener = player.addListener('playbackStatusUpdate', observe);
    }
    return player;
  };
  const startAttempt = (input: Omit<Pending, 'attemptId' | 'timeout' | 'statusAtDispatch'>) => {
    const target = getPlayer();
    const attemptId = `music-playback-${now()}-${++sequence}`;
    const attempt: Pending = { ...input, attemptId, statusAtDispatch: status,
      timeout: setTimeout(() => {
        if (pending !== attempt) return;
        settle(attempt, { error: new Error('音乐播放器没有及时确认实际状态。') });
        // Stop an unconfirmed play; it must not quietly start after being reported as failed.
        if (attempt.action === 'play') {
          target.pause(); target.clearLockScreenControls();
          currentSong = null; reminderOwner = undefined; state = 'stopped';
          publish(); releaseIfIdle();
        }
      }, options.receiptTimeoutMs ?? 12_000) };
    pending = attempt;
    return attempt;
  };
  const dispatchPlay = (prepared: PreparedMusicPlayback) => {
    if (pending) {
      if (!prepared.reminderOwner) throw new Error('播放器仍在等待上一项动作的真实状态。');
      settle(pending, { error: new Error('歌曲已被新的提醒替换。') });
    }
    const target = getPlayer();
    const attempt = startAttempt({ action: 'play', song: prepared.song,
      observationOwner: prepared.observationOwner, reminderOwner: prepared.reminderOwner });
    try {
      target.replace({ uri: prepared.streamUrl });
      currentSong = prepared.song;
      reminderOwner = prepared.reminderOwner;
      target.setActiveForLockScreen(true, {
        albumTitle: prepared.song.album, artist: prepared.song.artist,
        artworkUrl: prepared.song.cover || undefined, title: prepared.song.name,
      }, { showSeekBackward: true, showSeekForward: true });
      target.play();
      publish();
      return { attemptId: attempt.attemptId };
    } catch (error) {
      clearTimeout(attempt.timeout); pending = undefined;
      target.pause(); target.clearLockScreenControls();
      currentSong = null; reminderOwner = undefined; state = 'stopped';
      publish(); releaseIfIdle();
      throw error;
    }
  };
  const dispatchControl = (action: MusicControlAction, evidenceCallId?: string) => {
    if (!currentSong) throw new Error('当前没有可以控制的歌曲。');
    if (pending) throw new Error('播放器仍在等待上一项动作的真实状态。');
    const target = getPlayer();
    const attempt = startAttempt({ action, song: action === 'stop' ? null : currentSong,
      reminderOwner, evidenceCallId });
    try {
      if ((action === 'pause' && state === 'paused') || (action === 'resume' && state === 'playing')) {
        settle(attempt, { receipt: { attemptId: attempt.attemptId, state, song: currentSong,
          confirmedAt: updatedAt, ...(reminderOwner ? { reminderOwner } : {}) } });
      } else if (action === 'stop') {
        target.pause(); void target.seekTo(0); target.clearLockScreenControls();
        currentSong = null;
        // Native currentStatus supplies the real stopped state, including an already-paused track.
        observe(target.currentStatus);
      } else if (action === 'pause') target.pause();
      else target.play();
    } catch (error) {
      clearTimeout(attempt.timeout); pending = undefined;
      throw error;
    }
    publish();
    return { attemptId: attempt.attemptId };
  };
  const dispatchUserControl = (action: MusicControlAction) => {
    if (pending) settle(pending, pending.reminderOwner
      ? { error: new Error('音乐播放动作已被手动控制中断。') }
      : { receipt: { attemptId: pending.attemptId, state,
        song: currentSong, confirmedAt: updatedAt, ...(reminderOwner ? { reminderOwner } : {}) } });
    if (!currentSong) return;
    const { attemptId } = dispatchControl(action);
    // User controls do not have a tool waiter, but must not leave an unhandled result or rejection.
    void host.waitForReceipt(attemptId).catch(() => {});
  };
  const host: JunLuoMusicPlaybackHost = {
    supportsReminderOwnership: true, dispatchPlay, dispatchControl,
    getSnapshot: () => ({ currentSong, state, updatedAt, ...(reminderOwner ? { reminderOwner } : {}) }),
    waitForReceipt(attemptId) {
      const result = results.get(attemptId);
      if (result) {
        results.delete(attemptId);
        return 'receipt' in result ? Promise.resolve(result.receipt) : Promise.reject(result.error);
      }
      return new Promise((resolve, reject) => {
        const waiting = waiters.get(attemptId) ?? [];
        waiting.push({ resolve, reject }); waiters.set(attemptId, waiting);
      });
    },
  };
  return {
    host, getPlayer, dispatchUserControl,
    getView: () => ({ ...host.getSnapshot(), status: getPlayer().currentStatus }),
    subscribe(listener: () => void) {
      listeners.add(listener); getPlayer();
      return () => { listeners.delete(listener); releaseIfIdle(); };
    },
  };
}

let shared: ReturnType<typeof createSharedMusicPlaybackHost> | undefined;
let audioMode: Promise<void> | undefined;

export function getSharedMusicPlaybackHost() {
  if (!shared) {
    shared = createSharedMusicPlaybackHost({
      createPlayer: () => createAudioPlayer(null, { updateInterval: 1000 }),
      saveObservation: (owner, event) => { void recordMusicPlaybackObservation(owner.call, event, owner.dataEpoch); },
    });
  }
  registerMusicPlaybackHost(shared.host);
  audioMode ??= setAudioModeAsync({ allowsRecording: false, interruptionMode: 'doNotMix',
    playsInSilentMode: true, shouldPlayInBackground: true, shouldRouteThroughEarpiece: false });
  shared.host.prepareForPlayback = () => audioMode!;
  // Ordinary foreground creation historically did not block render on this async setting.
  void audioMode.catch(() => {});
  return shared;
}

export async function ensureSharedMusicPlaybackHost() {
  const value = getSharedMusicPlaybackHost();
  await audioMode;
  return value;
}
