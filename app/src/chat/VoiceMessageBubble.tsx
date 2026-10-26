import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { useEffect, useMemo, useRef, useState } from 'react';
import { PanResponder, Pressable, type StyleProp, StyleSheet, type TextStyle, View } from 'react-native';

import type { MessageVoice, SubjectiveRole } from '../ai/subjectiveMessages';
import { AppText as Text } from '../components/AppText';

type Props = {
  role: SubjectiveRole;
  transcriptTextStyle?: StyleProp<TextStyle>;
  voice: MessageVoice;
};

function formatVoiceDuration(durationMs: number) {
  const seconds = Math.max(1, Math.round(durationMs / 1000));
  if (seconds < 60) return `${seconds}"`;
  return `${Math.floor(seconds / 60)}'${String(seconds % 60).padStart(2, '0')}"`;
}

const WAVE_BARS = [8, 14, 22, 28, 19, 13, 24, 17, 9];

export function VoiceMessageBubble({ role, transcriptTextStyle, voice }: Props) {
  const player = useAudioPlayer(null, { updateInterval: 120 });
  const status = useAudioPlayerStatus(player);
  const loadedUriRef = useRef<string | null>(null);
  const [trackWidth, setTrackWidth] = useState(1);
  const durationSeconds = status.duration > 0 ? status.duration : Math.max(1, voice.durationMs / 1000);
  const progress = durationSeconds > 0 ? Math.max(0, Math.min(1, status.currentTime / durationSeconds)) : 0;
  const isMine = role === 'you';

  useEffect(() => {
    if (!status.didJustFinish) return;
    player.pause();
    void player.seekTo(0);
  }, [player, status.didJustFinish]);

  const seekFromX = (x: number) => {
    const target = (Math.max(0, Math.min(trackWidth, x)) / trackWidth) * durationSeconds;
    void player.seekTo(target);
  };

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (event) => seekFromX(event.nativeEvent.locationX),
        onPanResponderMove: (event) => seekFromX(event.nativeEvent.locationX),
      }),
    [durationSeconds, trackWidth],
  );

  const togglePlayback = () => {
    if (status.playing) {
      player.pause();
      return;
    }
    if (loadedUriRef.current !== voice.uri || !status.isLoaded) {
      player.replace({ uri: voice.uri });
      loadedUriRef.current = voice.uri;
    }
    if (status.didJustFinish || progress >= 0.995) {
      void player.seekTo(0).then(() => player.play());
      return;
    }
    player.play();
  };

  const transcript = voice.transcript?.trim();
  const transcriptText =
    transcript ||
    (voice.transcriptionStatus === 'pending'
      ? '正在把语音转成文字...'
      : voice.transcriptionStatus === 'error'
        ? voice.transcriptionError || '语音暂时没有转成文字。'
        : '');

  return (
    <View style={[styles.wrapper, isMine ? styles.mineWrapper : null]}>
      <View style={[styles.voicePill, isMine ? styles.minePill : styles.assistantPill]}>
        <Pressable
          accessibilityLabel={status.playing ? '暂停语音' : '播放语音'}
          hitSlop={8}
          onPress={togglePlayback}
          style={[
            styles.playButton,
            isMine ? styles.minePlayButton : styles.assistantPlayButton,
            status.playing ? styles.playButtonActive : null,
          ]}
        >
          <Text style={[styles.playIcon, isMine ? styles.minePlayIcon : styles.assistantPlayIcon]}>
            {status.playing ? 'Ⅱ' : '▶'}
          </Text>
        </Pressable>
        <View
          {...panResponder.panHandlers}
          onLayout={(event) => setTrackWidth(Math.max(1, event.nativeEvent.layout.width))}
          style={styles.waveTrack}
        >
          <View style={[styles.waveProgress, { width: `${progress * 100}%` }]} />
          <View style={styles.waveBars}>
            {WAVE_BARS.map((height, index) => (
              <View
                key={`${height}-${index}`}
                style={[
                  styles.waveBar,
                  isMine ? styles.mineWaveBar : styles.assistantWaveBar,
                  { height },
                  index / WAVE_BARS.length <= progress
                    ? isMine ? styles.mineWaveBarPlayed : styles.assistantWaveBarPlayed
                    : null,
                ]}
              />
            ))}
          </View>
        </View>
        <Text style={[styles.duration, isMine ? styles.mineDuration : styles.assistantDuration]}>
          {formatVoiceDuration(voice.durationMs)}
        </Text>
      </View>
      {transcriptText ? (
        <Text style={[styles.transcript, transcriptTextStyle, isMine ? styles.mineTranscript : null]}>{transcriptText}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    gap: 5,
    minWidth: 142,
  },
  mineWrapper: {
    alignItems: 'flex-end',
  },
  voicePill: {
    minWidth: 148,
    maxWidth: 218,
    minHeight: 42,
    borderRadius: 16,
    paddingHorizontal: 9,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 3,
    elevation: 1,
  },
  minePill: {
    backgroundColor: 'rgba(255, 222, 226, 0.98)',
    borderTopRightRadius: 5,
    borderColor: 'rgba(246, 176, 173, 0.56)',
    shadowColor: '#BA7E77',
  },
  assistantPill: {
    backgroundColor: 'rgba(222, 240, 255, 0.98)',
    borderTopLeftRadius: 5,
    borderColor: 'rgba(157, 201, 240, 0.62)',
    shadowColor: '#7195B8',
  },
  playButton: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  minePlayButton: {
    backgroundColor: 'rgba(255, 246, 246, 0.78)',
  },
  assistantPlayButton: {
    backgroundColor: 'rgba(249, 253, 255, 0.8)',
  },
  playButtonActive: {
    opacity: 0.78,
  },
  playIcon: {
    fontSize: 12,
    fontWeight: '900',
    lineHeight: 15,
  },
  minePlayIcon: {
    color: '#D87E91',
  },
  assistantPlayIcon: {
    color: '#6A9EC8',
  },
  waveTrack: {
    flex: 1,
    height: 30,
    justifyContent: 'center',
    overflow: 'hidden',
  },
  waveProgress: {
    position: 'absolute',
    left: 0,
    top: 4,
    bottom: 4,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.26)',
  },
  waveBars: {
    height: 30,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  waveBar: {
    width: 3,
    borderRadius: 3,
  },
  mineWaveBar: {
    backgroundColor: 'rgba(210, 126, 145, 0.34)',
  },
  assistantWaveBar: {
    backgroundColor: 'rgba(106, 158, 200, 0.34)',
  },
  mineWaveBarPlayed: {
    backgroundColor: '#D87E91',
  },
  assistantWaveBarPlayed: {
    backgroundColor: '#6A9EC8',
  },
  duration: {
    width: 28,
    fontSize: 12,
    fontWeight: '800',
    textAlign: 'right',
  },
  mineDuration: {
    color: '#C87584',
  },
  assistantDuration: {
    color: '#5F8EB4',
  },
  transcript: {
    maxWidth: 218,
    color: '#667684',
    fontSize: 12.5,
    lineHeight: 17,
  },
  mineTranscript: {
    color: '#617080',
    textAlign: 'right',
  },
});
