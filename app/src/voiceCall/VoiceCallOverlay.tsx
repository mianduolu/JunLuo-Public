import { useAudioPlayer } from 'expo-audio';
import { useEffect, useMemo, useState } from 'react';
import { Image, ImageBackground, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppText as Text } from '../components/AppText';
import type { BaiyunCallBrainSnapshot } from './baiyunCallBrain';
import { voiceCallAssets } from './voiceCallAssets';
import type { VoiceCallRoomSnapshot } from './voiceCallClient';

export type VoiceCallAuditionState =
  | 'available'
  | 'call-limit'
  | 'daily-limit'
  | 'failed'
  | 'idle'
  | 'interrupted'
  | 'requesting'
  | 'used';
export type VoiceCallUiState = 'incoming' | 'connecting' | 'active' | 'ending';

type VoiceCallAudioPlayer = ReturnType<typeof useAudioPlayer>;

type Props = {
  auditionState: VoiceCallAuditionState;
  brainSnapshot?: BaiyunCallBrainSnapshot;
  callerName?: string;
  callStartedAt: number | null;
  onAccept: () => void;
  onAuditionReply: () => void;
  onHangup: () => void;
  onMissed: () => void;
  nativeRinging?: boolean;
  roomSnapshot?: VoiceCallRoomSnapshot;
  state: VoiceCallUiState | null;
  technicalNotices?: string[];
};

const RING_TIMEOUT_MS = 60_000;

function runPlayerAction(action: () => void | Promise<void>) {
  try {
    void Promise.resolve(action()).catch(() => undefined);
  } catch {
    // Expo can release audio player shared objects during unmount or fast refresh.
  }
}

function pausePlayer(player: VoiceCallAudioPlayer) {
  runPlayerAction(() => player.pause());
}

function pauseAndResetPlayer(player: VoiceCallAudioPlayer) {
  pausePlayer(player);
  runPlayerAction(() => player.seekTo(0));
}

function playPlayerFromStart(player: VoiceCallAudioPlayer) {
  runPlayerAction(async () => {
    await player.seekTo(0);
    await Promise.resolve(player.play());
  });
}

function getVadLabel(roomSnapshot: VoiceCallRoomSnapshot | undefined) {
  if (roomSnapshot?.localSpeaking) return '小仓鼠说话中';
  if (!roomSnapshot?.localMicEnabled) return '还没收到小仓鼠声音';
  if (roomSnapshot.vadState === 'unavailable') return 'VAD 暂时不可用';
  if (
    roomSnapshot.micFrames > 0
    && roomSnapshot.lastMicRms <= 0
    && roomSnapshot.lastMicPeak <= 0
  ) return '收到麦克风音频，但音量还是 0';
  if (roomSnapshot.micFrames > 0) return '小仓鼠安静中';
  return '正在听小仓鼠';
}

function getRemoteAudioLabel(roomSnapshot: VoiceCallRoomSnapshot) {
  if (roomSnapshot.playbackState === 'interrupted') {
    return '云云已停下，正在听小仓鼠';
  }
  if (roomSnapshot.playbackState === 'started' && roomSnapshot.remoteSpeaking) {
    return '云云说话中';
  }
  if (roomSnapshot.remoteAudioSubscriptionError) {
    return '云云音轨订阅失败（' + roomSnapshot.remoteAudioSubscriptionError + '）';
  }
  if (roomSnapshot.remoteAudioSubscribed) return '云云声音已接入';
  if (roomSnapshot.remoteAudioPublished) return '云云音轨已发布，正在订阅';
  if (roomSnapshot.remoteParticipants > 0) return '云云在房间里';
  return '等待云云接入';
}

function getSttLabel(roomSnapshot: VoiceCallRoomSnapshot) {
  if (roomSnapshot.lastTranscriptStatus === 'ok' && roomSnapshot.lastTranscript) {
    return `听见：${roomSnapshot.lastTranscript}`;
  }
  if (roomSnapshot.lastTranscriptStatus === 'not_heard') return '这句没有识别出文字';
  if (roomSnapshot.lastTranscriptStatus === 'failed') return roomSnapshot.sttMessage;
  if (roomSnapshot.sttState === 'transcribing') return '正在识别这句话';
  if (roomSnapshot.sttState === 'loading') return '本地语音识别正在准备';
  if (roomSnapshot.sttState === 'ready') return '本地语音识别已准备';
  if (roomSnapshot.sttState === 'disabled') return '本地语音识别已关闭';
  return roomSnapshot.sttMessage;
}

const emotionLabels: Record<string, string> = {
  angry: '生气',
  disgusted: '抗拒',
  fearful: '害怕',
  happy: '开心',
  neutral: '中性',
  other: '其他',
  sad: '难过',
  surprised: '惊讶',
  unknown: '不确定',
};

function getEmotionLabel(roomSnapshot: VoiceCallRoomSnapshot) {
  if (roomSnapshot.emotionState === 'analyzing') return '正在整理声音里的情绪线索';
  if (roomSnapshot.emotionState === 'loading') return '本地声音情绪识别正在准备';
  if (roomSnapshot.emotionState === 'unavailable') return '声音情绪识别模型还没有准备';
  if (roomSnapshot.emotionState === 'failed') return roomSnapshot.emotionMessage;
  if (!roomSnapshot.emotionLabel) return roomSnapshot.emotionMessage;
  if (
    roomSnapshot.emotionConfidenceLevel === 'low'
    || ['neutral', 'other', 'unknown'].includes(roomSnapshot.emotionLabel)
  ) {
    return '声音情绪线索：没有可靠的明显倾向';
  }
  const label = emotionLabels[roomSnapshot.emotionLabel] ?? roomSnapshot.emotionLabel;
  return `声音情绪线索：可能偏${label}（${Math.round(roomSnapshot.emotionScore * 100)}%）`;
}

function getBrainStatusLabel(snapshot: BaiyunCallBrainSnapshot) {
  if (snapshot.status === 'generating') return snapshot.message;
  if (snapshot.status === 'ready') return '电话影子回复已生成';
  if (snapshot.status === 'interrupted') return snapshot.message;
  if (snapshot.status === 'failed') return snapshot.message;
  if (snapshot.status === 'stopped') return '本次通话回复会话已经结束';
  return '等待小仓鼠说完一句话';
}

function getAuditionLabel(state: VoiceCallAuditionState) {
  if (state === 'available') return '试听这句';
  if (state === 'requesting') return '正在提交试听';
  if (state === 'used') return '本次试听已使用';
  if (state === 'interrupted') return '试听已被打断';
  if (state === 'daily-limit') return '今日语音额度已用完';
  if (state === 'call-limit') return '本通语音次数已用完';
  if (state === 'failed') return '试听没有启动';
  return '等待影子回复';
}

function formatCallDuration(startedAt: number | null) {
  if (!startedAt) return '00:00';
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function CallDuration({ active, startedAt }: { active: boolean; startedAt: number | null }) {
  const [label, setLabel] = useState('00:00');

  useEffect(() => {
    if (!active) {
      setLabel('00:00');
      return undefined;
    }
    setLabel(formatCallDuration(startedAt));
    const timer = setInterval(() => setLabel(formatCallDuration(startedAt)), 1000);
    return () => clearInterval(timer);
  }, [active, startedAt]);

  return <Text style={styles.duration}>{label}</Text>;
}

export function VoiceCallOverlay({
  auditionState,
  brainSnapshot,
  callerName = '白云小姐',
  callStartedAt,
  onAccept,
  onAuditionReply,
  onHangup,
  onMissed,
  nativeRinging = false,
  roomSnapshot,
  state,
  technicalNotices = [],
}: Props) {
  const insets = useSafeAreaInsets();
  const ringPlayer = useAudioPlayer(voiceCallAssets.ringSound, { keepAudioSessionActive: true });
  const pickupPlayer = useAudioPlayer(voiceCallAssets.pickupSound, { keepAudioSessionActive: true });
  const hangupPlayer = useAudioPlayer(voiceCallAssets.hangupSound, { keepAudioSessionActive: true });
  const visible = state !== null;

  useEffect(() => {
    if (state !== 'incoming' || nativeRinging) {
      pauseAndResetPlayer(ringPlayer);
      return;
    }
    try {
      ringPlayer.loop = true;
      ringPlayer.volume = 0.85;
      playPlayerFromStart(ringPlayer);
    } catch {
      // The UI state machine should keep working even when local audio fails.
    }
  }, [nativeRinging, ringPlayer, state]);

  useEffect(() => {
    if (state !== 'incoming' || nativeRinging) return undefined;
    const timer = setTimeout(onMissed, RING_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [nativeRinging, onMissed, state]);

  useEffect(() => {
    return () => {
      pausePlayer(ringPlayer);
      pausePlayer(pickupPlayer);
      pausePlayer(hangupPlayer);
    };
  }, [hangupPlayer, pickupPlayer, ringPlayer]);

  const statusText = useMemo(() => {
    if (state === 'incoming') return '正在来电';
    if (state === 'connecting') return roomSnapshot?.message ?? '正在接通';
    if (state === 'ending') return '正在挂断';
    if (roomSnapshot?.status === 'failed') return '通话已断开';
    return '通话中';
  }, [roomSnapshot, state]);

  if (!visible) return null;

  const playPickup = () => {
    pauseAndResetPlayer(ringPlayer);
    playPlayerFromStart(pickupPlayer);
    onAccept();
  };

  const playHangup = () => {
    pauseAndResetPlayer(ringPlayer);
    playPlayerFromStart(hangupPlayer);
    onHangup();
  };

  return (
    <View
      accessibilityViewIsModal
      style={styles.overlay}
    >
      <ImageBackground
        resizeMode="cover"
        source={voiceCallAssets.background}
        style={[
          styles.background,
          {
            paddingBottom: Math.max(insets.bottom + 18, 34),
            paddingTop: Math.max(insets.top + 18, 34),
          },
        ]}
      >
        <View style={styles.scrim} />
        <View style={styles.topBar}>
          <Text style={styles.statusText}>{statusText}</Text>
        </View>

        {state === 'incoming' ? (
          <View style={styles.incomingLayout}>
            <View style={styles.identityBlock}>
              <Image resizeMode="cover" source={voiceCallAssets.avatar} style={styles.avatar} />
              <Text numberOfLines={1} adjustsFontSizeToFit style={styles.callerName}>{callerName}</Text>
              <Text style={styles.callHint}>来电</Text>
            </View>
            <View style={styles.incomingActions}>
              <CallImageButton
                accessibilityLabel="挂断白云小姐来电"
                caption="挂断"
                image={voiceCallAssets.hangupButton}
                onPress={playHangup}
              />
              <CallImageButton
                accessibilityLabel="接听白云小姐来电"
                caption="接听"
                image={voiceCallAssets.answerButton}
                onPress={playPickup}
              />
            </View>
          </View>
        ) : (
          <View style={styles.activeLayout}>
            <View style={styles.identityBlock}>
              <Image resizeMode="cover" source={voiceCallAssets.avatar} style={styles.avatarSmall} />
              <Text numberOfLines={1} adjustsFontSizeToFit style={styles.callerName}>{callerName}</Text>
              {roomSnapshot?.status !== 'failed' ? <CallDuration active={state === 'active'} startedAt={callStartedAt} /> : null}
            </View>
            {state === 'ending' ? (
              <>
                <View style={styles.endingPanel}>
                  <Text style={styles.endingTitle}>通话正在结束</Text>
                  <Text style={styles.endingText}>白云小姐已经挂断，马上回到刚才的页面。</Text>
                </View>
                <View style={styles.endingSpacer} />
              </>
            ) : (
              <>
                <ScrollView
                  accessibilityLabel="通话状态与字幕"
                  contentContainerStyle={styles.signalPanelContent}
                  nestedScrollEnabled
                  persistentScrollbar
                  showsVerticalScrollIndicator
                  style={styles.signalPanel}
                >
                  {roomSnapshot ? (
                    <>
                      <SignalRow active={roomSnapshot.status === 'connecting' || roomSnapshot.status === 'fetching-token' || roomSnapshot.status === 'requesting-permission'} label={roomSnapshot.error || roomSnapshot.message} />
                      {technicalNotices.map((notice) => (
                        <SignalRow active={false} key={notice} label={notice} maxLines={3} />
                      ))}
                      {roomSnapshot.status !== 'failed' ? <>
                      <SignalRow active={roomSnapshot.localMicEnabled} label={roomSnapshot.localMicEnabled ? '小仓鼠麦克风已开启' : '小仓鼠麦克风准备中'} />
                      <SignalRow active={roomSnapshot.localSpeaking} label={getVadLabel(roomSnapshot)} />
                      <SignalRow
                        active={roomSnapshot.sttState === 'ready' || roomSnapshot.sttState === 'transcribing'}
                        label={getSttLabel(roomSnapshot)}
                        maxLines={4}
                      />
                      {roomSnapshot.emotion2vecEnabled ? (
                        <SignalRow
                          active={roomSnapshot.emotionState === 'ready' || roomSnapshot.emotionState === 'analyzing'}
                          label={getEmotionLabel(roomSnapshot)}
                        />
                      ) : null}
                      <SignalRow
                        active={roomSnapshot.remoteAudioSubscribed}
                        label={getRemoteAudioLabel(roomSnapshot)}
                      />
                      {brainSnapshot ? (
                        <>
                          <View style={styles.brainDivider} />
                          <SignalRow
                            active={brainSnapshot.status === 'generating' || brainSnapshot.status === 'ready'}
                            label={getBrainStatusLabel(brainSnapshot)}
                            maxLines={3}
                          />
                          {brainSnapshot.status === 'ready' && brainSnapshot.replyText ? (
                            <>
                              <Text
                                accessibilityLabel="白云小姐电话回复字幕"
                                style={styles.brainReplyText}
                              >
                                {brainSnapshot.replyText}
                              </Text>
                              {brainSnapshot.playbackIntent !== 'care_auto' ? (
                                <Pressable
                                  accessibilityLabel="试听这句电话影子回复"
                                  disabled={auditionState !== 'available'}
                                  onPress={onAuditionReply}
                                  style={({ pressed }) => [
                                    styles.auditionButton,
                                    auditionState !== 'available' && styles.auditionButtonDisabled,
                                    pressed && auditionState === 'available' && styles.auditionButtonPressed,
                                  ]}
                                >
                                  <Text style={styles.auditionButtonText}>{getAuditionLabel(auditionState)}</Text>
                                </Pressable>
                              ) : null}
                            </>
                          ) : null}
                        </>
                      ) : null}
                      </> : null}
                    </>
                  ) : (
                    <>
                      <SignalRow active={state === 'connecting'} label={state === 'connecting' ? '电话线正在接通' : '电话线已接通'} />
                      <SignalRow active={false} label="云云说话中" />
                      <SignalRow active={false} label="小仓鼠说话中" />
                    </>
                  )}
                </ScrollView>
                <CallImageButton
                  accessibilityLabel="挂断语音通话"
                  caption="挂断"
                  image={voiceCallAssets.hangupButton}
                  onPress={playHangup}
                />
              </>
            )}
          </View>
        )}
      </ImageBackground>
    </View>
  );
}

function CallImageButton({
  accessibilityLabel,
  caption,
  image,
  onPress,
}: {
  accessibilityLabel: string;
  caption: string;
  image: number;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={({ pressed }) => [styles.callButtonWrap, pressed && styles.callButtonPressed]}
    >
      <Image resizeMode="contain" source={image} style={styles.callButtonImage} />
      <Text style={styles.callButtonCaption}>{caption}</Text>
    </Pressable>
  );
}

function SignalRow({
  active,
  label,
  maxLines = 2,
}: {
  active: boolean;
  label: string;
  maxLines?: number;
}) {
  return (
    <View style={styles.signalRow}>
      <View style={[styles.signalDot, active && styles.signalDotActive]} />
      <Text ellipsizeMode="tail" numberOfLines={maxLines} style={styles.signalText}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#0B101B',
    elevation: 80,
    zIndex: 80,
  },
  background: {
    flex: 1,
  },
  scrim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(9, 14, 23, 0.46)',
  },
  topBar: {
    alignItems: 'center',
    minHeight: 34,
    paddingHorizontal: 24,
    paddingTop: 2,
    width: '100%',
  },
  statusText: {
    color: 'rgba(255,255,255,0.84)',
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0,
  },
  incomingLayout: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'space-between',
    paddingHorizontal: 28,
    paddingTop: 78,
  },
  activeLayout: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'space-between',
    paddingHorizontal: 28,
    paddingTop: 54,
  },
  identityBlock: {
    alignItems: 'center',
    width: '100%',
  },
  avatar: {
    borderColor: 'rgba(255,255,255,0.72)',
    borderRadius: 72,
    borderWidth: 3,
    height: 144,
    marginBottom: 22,
    width: 144,
  },
  avatarSmall: {
    borderColor: 'rgba(255,255,255,0.72)',
    borderRadius: 58,
    borderWidth: 3,
    height: 116,
    marginBottom: 18,
    width: 116,
  },
  callerName: {
    color: '#FFFFFF',
    fontSize: 34,
    fontWeight: '800',
    letterSpacing: 0,
    lineHeight: 42,
    maxWidth: '100%',
    textAlign: 'center',
    textShadowColor: 'rgba(0,0,0,0.34)',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 8,
  },
  callHint: {
    color: 'rgba(255,255,255,0.82)',
    fontSize: 17,
    fontWeight: '700',
    marginTop: 9,
  },
  duration: {
    color: 'rgba(255,255,255,0.88)',
    fontSize: 22,
    fontWeight: '800',
    marginTop: 11,
  },
  incomingActions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    maxWidth: 330,
    width: '100%',
  },
  callButtonWrap: {
    alignItems: 'center',
    flexShrink: 0,
    minHeight: 104,
    width: 104,
  },
  callButtonPressed: {
    opacity: 0.72,
    transform: [{ scale: 0.96 }],
  },
  callButtonImage: {
    height: 82,
    width: 82,
  },
  callButtonCaption: {
    color: 'rgba(255,255,255,0.86)',
    fontSize: 14,
    fontWeight: '800',
    marginTop: 4,
    textShadowColor: 'rgba(0,0,0,0.3)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  signalPanel: {
    backgroundColor: 'rgba(255, 255, 255, 0.16)',
    borderColor: 'rgba(255, 255, 255, 0.24)',
    borderRadius: 24,
    borderWidth: 1,
    flex: 1,
    marginVertical: 16,
    maxWidth: 340,
    minHeight: 0,
    width: '100%',
  },
  signalPanelContent: {
    gap: 14,
    paddingHorizontal: 20,
    paddingVertical: 18,
  },
  signalRow: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 11,
  },
  signalDot: {
    backgroundColor: 'rgba(255,255,255,0.46)',
    borderRadius: 5,
    height: 10,
    marginTop: 5,
    width: 10,
  },
  signalDotActive: {
    backgroundColor: '#A8FFD7',
  },
  signalText: {
    color: 'rgba(255,255,255,0.88)',
    flex: 1,
    fontSize: 15,
    fontWeight: '700',
    lineHeight: 21,
  },
  brainDivider: {
    backgroundColor: 'rgba(255,255,255,0.22)',
    height: 1,
    width: '100%',
  },
  brainReplyText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
    lineHeight: 20,
  },
  auditionButton: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(168,255,215,0.16)',
    borderColor: 'rgba(168,255,215,0.66)',
    borderRadius: 8,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 36,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  auditionButtonDisabled: {
    opacity: 0.52,
  },
  auditionButtonPressed: {
    opacity: 0.72,
  },
  auditionButtonText: {
    color: '#E9FFF5',
    fontSize: 13,
    fontWeight: '700',
  },
  endingPanel: {
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.16)',
    borderColor: 'rgba(255, 255, 255, 0.24)',
    borderRadius: 24,
    borderWidth: 1,
    maxWidth: 340,
    paddingHorizontal: 20,
    paddingVertical: 20,
    width: '100%',
  },
  endingTitle: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '800',
    marginBottom: 8,
    textAlign: 'center',
  },
  endingText: {
    color: 'rgba(255,255,255,0.78)',
    fontSize: 13,
    fontWeight: '700',
    lineHeight: 19,
    textAlign: 'center',
  },
  endingSpacer: {
    height: 104,
    width: 104,
  },
});
