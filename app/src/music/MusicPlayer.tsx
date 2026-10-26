import type { AudioPlayer } from 'expo-audio';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { Image, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { MusicSong } from '../ai/subjectiveMessages';
import { AppText as Text } from '../components/AppText';
import { getMusicStreamUrl } from './neteaseMusic';
import { getSharedMusicPlaybackHost } from './sharedMusicPlaybackHost';

type PlayerInstance = Pick<AudioPlayer, 'seekTo'>;

type MusicPlayerActions = {
  close: () => void;
  playSong: (song: MusicSong) => Promise<void>;
  seek: (seconds: number) => Promise<void>;
  togglePlayback: () => void;
};

type MusicPlayerState = {
  currentSong: MusicSong | null;
  isPlaying: boolean;
};

const MusicPlayerActionsContext = createContext<MusicPlayerActions | null>(null);
const MusicPlayerStateContext = createContext<MusicPlayerState | null>(null);

type MiniPlayerProps = {
  close: () => void;
  currentSong: MusicSong;
  currentTime: number;
  duration: number;
  playing: boolean;
  player: PlayerInstance;
  togglePlayback: () => void;
};

function MiniMusicPlayer({
  close,
  currentSong,
  currentTime,
  duration,
  playing,
  player,
  togglePlayback,
}: MiniPlayerProps) {
  const insets = useSafeAreaInsets();
  const [progressWidth, setProgressWidth] = useState(1);
  const progress = duration > 0 ? Math.min(1, currentTime / duration) : 0;

  const seekFromTrackPosition = (position: number) => {
    if (!duration) return;
    const target = (Math.max(0, Math.min(position, progressWidth)) / progressWidth) * duration;
    void player.seekTo(target);
  };

  return (
    <View
      pointerEvents="auto"
      style={[styles.miniPlayer, { top: Math.max(insets.top + 48, 72) }]}
    >
      {currentSong.cover ? (
        <Image source={{ uri: currentSong.cover }} style={styles.cover} />
      ) : (
        <View style={styles.coverFallback} />
      )}
      <View style={styles.songText}>
        <Text numberOfLines={1} style={styles.songName}>{currentSong.name}</Text>
        <Text numberOfLines={1} style={styles.artist}>{currentSong.artist}</Text>
      </View>
      <Pressable
        accessibilityLabel={playing ? '暂停音乐' : '继续播放音乐'}
        hitSlop={8}
        onPress={togglePlayback}
        style={styles.control}
      >
        <Text style={styles.controlText}>{playing ? 'Ⅱ' : '▶'}</Text>
      </Pressable>
      <Pressable
        accessibilityLabel="关闭播放器"
        hitSlop={8}
        onPress={close}
        style={styles.control}
      >
        <Text style={styles.closeText}>×</Text>
      </Pressable>
      <Pressable
        accessibilityLabel="音乐播放进度"
        onLayout={(event) => setProgressWidth(Math.max(1, event.nativeEvent.layout.width))}
        onPress={(event) => seekFromTrackPosition(event.nativeEvent.locationX)}
        style={styles.progressTrack}
      >
        <View style={[styles.progressFill, { width: `${progress * 100}%` }]} />
      </Pressable>
    </View>
  );
}

export function MusicPlayerProvider({ children }: { children: ReactNode }) {
  const shared = useMemo(() => getSharedMusicPlaybackHost(), []);
  const [view, setView] = useState(() => shared.getView());
  useEffect(() => {
    const update = () => setView(shared.getView());
    const unsubscribe = shared.subscribe(update);
    update();
    return unsubscribe;
  }, [shared]);
  const { currentSong, status } = view;
  const isPlaying = view.state === 'playing';
  const player = shared.getPlayer();

  const playSong = useCallback(async (song: MusicSong) => {
    const streamUrl = await getMusicStreamUrl(song.id);
    const { attemptId } = shared.host.dispatchPlay({ song, streamUrl });
    await shared.host.waitForReceipt(attemptId);
  }, [shared]);

  const close = useCallback(() => {
    shared.dispatchUserControl('stop');
  }, [shared]);

  const togglePlayback = useCallback(() => {
    const snapshot = shared.host.getSnapshot();
    if (!snapshot.currentSong) return;
    shared.dispatchUserControl(snapshot.state === 'playing' ? 'pause' : 'resume');
  }, [shared]);

  const seek = useCallback(async (seconds: number) => {
    await shared.getPlayer().seekTo(Math.max(0, seconds));
  }, [shared]);

  const actions = useMemo<MusicPlayerActions>(
    () => ({ close, playSong, seek, togglePlayback }),
    [close, playSong, seek, togglePlayback],
  );
  const state = useMemo<MusicPlayerState>(
    () => ({ currentSong, isPlaying }),
    [currentSong, isPlaying],
  );

  return (
    <MusicPlayerActionsContext.Provider value={actions}>
      <MusicPlayerStateContext.Provider value={state}>
        {children}
        {currentSong ? (
          <MiniMusicPlayer
            close={close}
            currentSong={currentSong}
            currentTime={status.currentTime}
            duration={status.duration}
            playing={status.playing}
            player={player}
            togglePlayback={togglePlayback}
          />
        ) : null}
      </MusicPlayerStateContext.Provider>
    </MusicPlayerActionsContext.Provider>
  );
}

export function useMusicPlayerActions() {
  const context = useContext(MusicPlayerActionsContext);
  if (!context) throw new Error('useMusicPlayerActions must be used inside MusicPlayerProvider');
  return context;
}

export function useMusicPlayerState() {
  const context = useContext(MusicPlayerStateContext);
  if (!context) throw new Error('useMusicPlayerState must be used inside MusicPlayerProvider');
  return context;
}

export function useMusicPlayer() {
  return {
    ...useMusicPlayerState(),
    ...useMusicPlayerActions(),
  };
}

const styles = StyleSheet.create({
  miniPlayer: {
    position: 'absolute',
    left: 18,
    right: 18,
    zIndex: 300,
    elevation: 12,
    minHeight: 58,
    borderRadius: 20,
    padding: 8,
    paddingBottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255, 250, 247, 0.96)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.88)',
    shadowColor: '#596D78',
    shadowOpacity: 0.18,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 5 },
  },
  cover: {
    width: 42,
    height: 42,
    borderRadius: 13,
    backgroundColor: '#E8EEF2',
  },
  coverFallback: {
    width: 42,
    height: 42,
    borderRadius: 13,
    backgroundColor: '#F2DFD5',
  },
  songText: {
    flex: 1,
    paddingHorizontal: 10,
  },
  songName: {
    color: '#405261',
    fontSize: 14,
    fontWeight: '700',
  },
  artist: {
    color: '#82909A',
    fontSize: 11,
    marginTop: 3,
  },
  control: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
  },
  controlText: {
    color: '#D87A69',
    fontSize: 16,
    fontWeight: '800',
  },
  closeText: {
    color: '#87949C',
    fontSize: 25,
    lineHeight: 26,
  },
  progressTrack: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: 5,
    height: 8,
    paddingVertical: 3,
  },
  progressFill: {
    height: 2,
    borderRadius: 2,
    backgroundColor: '#E8907E',
  },
});
