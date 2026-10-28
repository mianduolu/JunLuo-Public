import { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Alert,
  AppState,
  Image,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';

import { homeImages } from '../assets/homeImages';
import { useAiConfigPreferences } from '../ai/AiConfigPreferences';
import {
  getAssistantPortrait,
  DEFAULT_ASSISTANT_STATE,
  NEAR_STATUS_INTERVAL_MS,
  getHomeAssistantDisplayState,
  loadAssistantState,
  subscribeAssistantStateChanged,
  subscribeNearStatusUpdating,
  type AssistantState,
  type AssistantMoodId,
} from '../ai/assistantState';
import { HOME_ASSISTANT_FALLBACK_ROTATION_MS } from '../ai/homeAssistantFallback';
import { refreshAssistantLifeState } from '../ai/assistantLife';
import { loadJunluoAffectState } from '../life/junluoInnerStateStore';
import { resolveBaiyunPortraitState } from '../life/junluoInnerStateGeneration';
import type { BackgroundSettings } from '../backgrounds/BackgroundPreferences';
import {
  canCommitBackupRestoreDataEpoch,
  captureBackupRestoreDataEpoch,
  runBackupRestoreDataEpochCommit,
} from '../backup/backupRestoreCoordinator';
import { runBackupProtectedTask } from '../backup/backupService';
import { AppText as Text } from '../components/AppText';
import { BackgroundSurface } from '../components/BackgroundSurface';
import { HomeNowScheduleCard } from '../components/HomeNowScheduleCard';
import { HomeBackgroundAiStatus } from '../components/HomeBackgroundAiStatus';
import { JunLuoPortraitSurface } from '../components/JunLuoPortraitSurface';
import { ScalePressable } from '../components/ScalePressable';
import { generateFocusInvitation } from '../focus/focusCompanion';
import {
  canOfferFocusInvite,
  getActiveFocusDisplaySeconds,
  loadActiveFocusSession,
  markFocusInviteOffered,
  savePendingFocusInvite,
  type ActiveFocusSession,
} from '../focus/focusStore';
import { useWeather } from '../hooks/useWeather';
import { beginRuntimeWorkload, observeRuntimeWorkload } from '../runtime/runtimeWorkloadDiagnostics';
import {
  isAutomaticRemoteAiAllowed,
  loadAutomaticRemoteAiPolicy,
} from '../runtime/automaticRemoteAiPolicy';
import { colors } from '../theme/colors';
import { getOverlayTextStyle, type HomeBackgroundReadability } from '../theme/homeReadability';
import type { SkyTheme } from '../utils/sky';
import type { Navigate, ScreenName } from '../types/navigation';

type Props = {
  active: boolean;
  backgroundReadability: HomeBackgroundReadability;
  backgroundSettings: BackgroundSettings;
  navigate: Navigate;
  skyTheme: SkyTheme;
  weatherAnimationsEnabled: boolean;
};

type FeatureButton = {
  label: string;
  image: number;
  target: ScreenName;
};

const FORCE_DIAGNOSTIC_HOME_RAIN =
  process.env.EXPO_PUBLIC_JUNLUO_RAIN_HOME_DIAGNOSTICS === '1';
const FORCE_DIAGNOSTIC_HOME_HAIL =
  process.env.EXPO_PUBLIC_JUNLUO_HAIL_HOME_DIAGNOSTICS === '1';
const FORCE_DIAGNOSTIC_HOME_SNOW =
  process.env.EXPO_PUBLIC_JUNLUO_SNOW_HOME_DIAGNOSTICS === '1';
const FORCE_DIAGNOSTIC_HOME_FOG =
  process.env.EXPO_PUBLIC_JUNLUO_FOG_HOME_DIAGNOSTICS === '1';
const FORCE_DIAGNOSTIC_HOME_DUST =
  process.env.EXPO_PUBLIC_JUNLUO_DUST_HOME_DIAGNOSTICS === '1';

const devNow = () => (typeof globalThis.performance?.now === 'function' ? globalThis.performance.now() : Date.now());
const devLogHomePerf = (label: string, fields: Record<string, unknown>) => {
  if (__DEV__) {
    console.log(`[perf][home] ${label}`, fields);
  }
};


const featureButtons: FeatureButton[] = [
  { label: '往来', image: homeImages.letter, target: 'letter' },
  { label: '记忆', image: homeImages.memory, target: 'memory' },
  { label: '与你', image: homeImages.withYou, target: 'period' },
  { label: '记账', image: homeImages.wallet, target: 'expense' },
  { label: '日程', image: homeImages.schedule, target: 'schedule' },
  { label: '共读', image: homeImages.gift, target: 'co-reading' },
];

function formatFocusCardTimer(totalSeconds: number) {
  const safeSeconds = Math.max(0, totalSeconds);
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function HomeClock({
  active,
  headerTextStyle,
  weatherText,
}: {
  active: boolean;
  headerTextStyle: ReturnType<typeof getOverlayTextStyle>;
  weatherText: string;
}) {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const scheduleNextMinute = () => {
      const delay = 60_000 - (Date.now() % 60_000) + 50;
      timer = setTimeout(() => {
        setNow(new Date());
        scheduleNextMinute();
      }, delay);
    };
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      if (timer !== undefined) clearTimeout(timer);
      setNow(new Date());
      scheduleNextMinute();
    });

    setNow(new Date());
    scheduleNextMinute();
    return () => {
      subscription.remove();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [active]);

  const timeText = now.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const dateText = now.toLocaleDateString('zh-CN', {
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  });

  return (
    <View style={styles.topModule}>
      <Text style={[styles.time, headerTextStyle]}>{timeText}</Text>
      <Text style={[styles.date, headerTextStyle]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.82}>
        {dateText} · {weatherText}
      </Text>
    </View>
  );
}

function BaiyunPortrait({ active, mood, cloudForm }: { active: boolean; mood: AssistantMoodId; cloudForm?: AssistantState['cloudForm'] }) {
  const moodBounce = useRef(new Animated.Value(1)).current;
  const previousMood = useRef(mood);

  useEffect(() => {
    if (previousMood.current === mood) {
      return;
    }

    previousMood.current = mood;
    moodBounce.setValue(0.9);
    Animated.spring(moodBounce, {
      toValue: 1,
      speed: 22,
      bounciness: 12,
      useNativeDriver: true,
    }).start();
  }, [mood, moodBounce]);

  return (
    <Animated.View
      style={[
        styles.aiPortraitSurfaceFrame,
        {
          transform: [{ scale: moodBounce }],
        },
      ]}
    >
      <JunLuoPortraitSurface
        active={active}
        source={getAssistantPortrait(mood, cloudForm)}
        style={styles.aiPortraitSurface}
      />
    </Animated.View>
  );
}

export function HomeScreen({
  active,
  backgroundReadability,
  backgroundSettings,
  navigate,
  skyTheme,
  weatherAnimationsEnabled,
}: Props) {
  const { chatConnection, chatKey, lifeCreativeConnection, lifeCreativeKey, loaded: aiConfigLoaded, profile } = useAiConfigPreferences();
  const lifeCreativeConnectionForUse = lifeCreativeConnection ?? chatConnection;
  const lifeCreativeKeyForUse = lifeCreativeConnection ? lifeCreativeKey : chatKey;
  const [assistantStatus, setAssistantStatus] = useState(DEFAULT_ASSISTANT_STATE);
  const assistantDisplayVersionRef = useRef({ version: 0, updatedAt: 0, dataEpoch: null as number | null });
  const [activeFocus, setActiveFocus] = useState<ActiveFocusSession | null>(null);
  const [focusCardSeconds, setFocusCardSeconds] = useState(25 * 60);
  const homeMountSpanRef = useRef<ReturnType<typeof beginRuntimeWorkload>>(null);
  const sky = skyTheme;
  const readability = backgroundReadability;
  const weather = useWeather(active);
  const { width, fontScale } = useWindowDimensions();
  const contentWidth = width - 40;
  const featureSize = (contentWidth - 24) / 3;
  const toolSize = (contentWidth - 16) / 2;
  const weatherText = weather.isLoading
    ? '天气读取中'
    : `${weather.placeLabel ? `${weather.placeLabel} · ` : ''}${weather.label}${
        weather.temperature === undefined ? '' : ` ${weather.temperature}°C`
      }`;
  const displayedWeatherKind = weatherAnimationsEnabled ? weather.kind : 'clear';
  const headerTextStyle = getOverlayTextStyle(readability.headerText);
  const exposedLabelTextStyle = getOverlayTextStyle(readability.exposedLabelText);
  const showAssistantState = async (state: AssistantState, isCurrent: () => boolean) => {
    const dataEpoch = captureBackupRestoreDataEpoch();
    const previous = assistantDisplayVersionRef.current;
    if (!isCurrent() || dataEpoch === null
      || (previous.dataEpoch === dataEpoch && state.updatedAt < previous.updatedAt)) return;
    const version = previous.version + 1;
    assistantDisplayVersionRef.current = { version, updatedAt: state.updatedAt, dataEpoch };
    const canDisplay = () => isCurrent() && version === assistantDisplayVersionRef.current.version
      && canCommitBackupRestoreDataEpoch(dataEpoch);
    // Resolve the portrait before publishing: an awake state may still contain yesterday's sleep mood.
    const affect = state.lifeMode === 'sleeping' ? null : await loadJunluoAffectState().catch(() => null);
    if (!canDisplay()) return;
    setAssistantStatus(current => {
      if (!canDisplay()) return current;
      const moodId = state.lifeMode === 'sleeping' ? 'asleep'
        : affect ? resolveBaiyunPortraitState({ affect, sleeping: false })
          : current.moodId === 'asleep' ? DEFAULT_ASSISTANT_STATE.moodId : current.moodId;
      return { ...getHomeAssistantDisplayState(state, Date.now(), weather), moodId };
    });
  };

  useEffect(() => {
    const span = beginRuntimeWorkload('home.mount_lifetime');
    homeMountSpanRef.current = span;
    return () => {
      span?.finish('cancelled');
      if (homeMountSpanRef.current === span) homeMountSpanRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!active) return;
    let current = true;
    let readVersion = 0;
    const reload = () => {
      const version = ++readVersion;
      void loadAssistantState().then(state => {
        if (current && version === readVersion) void showAssistantState(state, () => current && version === readVersion);
      }).catch(() => undefined);
    };
    reload();
    const unsubscribe = subscribeAssistantStateChanged((state) => {
      const version = ++readVersion;
      if (current) void showAssistantState(state, () => current && version === readVersion);
    });
    const unsubscribeUpdating = subscribeNearStatusUpdating(reload);
    return () => {
      current = false;
      unsubscribe();
      unsubscribeUpdating();
    };
  }, [active, weather.error, weather.isLoading, weather.kind, weather.temperature]);

  useEffect(() => {
    if (!active || !aiConfigLoaded) return;
    let current = true;
    const refreshState = async () => {
      const dataEpoch = captureBackupRestoreDataEpoch();
      if (dataEpoch === null) return;
      const automaticRemoteAiEnabled = isAutomaticRemoteAiAllowed(
        await loadAutomaticRemoteAiPolicy(),
      );
      const startedAt = devNow();
      const preflight = await runBackupProtectedTask(async () => true);
      if (!preflight.ran || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      const refreshed = await refreshAssistantLifeState({
        apiKey: automaticRemoteAiEnabled ? lifeCreativeKeyForUse : undefined,
        connection: automaticRemoteAiEnabled ? lifeCreativeConnectionForUse : undefined,
        dataEpoch,
        profile,
      });
      if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      devLogHomePerf('assistant-state-refresh', {
        ms: Math.round(devNow() - startedAt),
        lifeMode: refreshed.lifeMode,
        sourceType: refreshed.sourceType,
      });
      if (current) await showAssistantState(refreshed, () => current && canCommitBackupRestoreDataEpoch(dataEpoch));
    };

    void refreshState().catch(() => undefined);
    return () => {
      current = false;
    };
  }, [active, aiConfigLoaded, lifeCreativeConnectionForUse, lifeCreativeKeyForUse, profile]);

  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expireText = () => setAssistantStatus(state => getHomeAssistantDisplayState(state, Date.now(), weather));
    const scheduleDisplayDeadline = () => {
      expireText();
      const now = Date.now();
      const writtenAt = assistantStatus.textUpdatedAt ?? 0;
      const expiresAt = writtenAt + NEAR_STATUS_INTERVAL_MS;
      const nextRotationAt = (Math.floor(now / HOME_ASSISTANT_FALLBACK_ROTATION_MS) + 1)
        * HOME_ASSISTANT_FALLBACK_ROTATION_MS;
      const nextAt = assistantStatus.lifeMode !== 'sleeping'
        && writtenAt > 0 && writtenAt <= now && expiresAt > now
        ? expiresAt
        : nextRotationAt;
      timer = setTimeout(scheduleDisplayDeadline, Math.max(1, nextAt - now));
    };
    // One display-only timer: first withdraw an expired model draft, then rotate local copy by time slot.
    scheduleDisplayDeadline();
    const subscription = AppState.addEventListener('change', state => {
      if (state !== 'active') return;
      if (timer !== undefined) clearTimeout(timer);
      scheduleDisplayDeadline();
    });
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      subscription.remove();
    };
  }, [active, assistantStatus.lifeMode, assistantStatus.textUpdatedAt, assistantStatus.sleepNearStatus,
    weather.error, weather.isLoading, weather.kind, weather.temperature]);

  useEffect(() => {
    if (!active) return;
    let current = true;
    const refreshFocusCard = async () => {
      const session = await loadActiveFocusSession();
      if (!current) return;
      setActiveFocus(session);
      setFocusCardSeconds(session ? getActiveFocusDisplaySeconds(session) : 25 * 60);
    };
    void refreshFocusCard();
    const intervalId = setInterval(() => void refreshFocusCard(), 30 * 1000);
    return () => {
      current = false;
      clearInterval(intervalId);
    };
  }, [active]);

  useEffect(() => {
    if (!active || !activeFocus) return;
    const intervalId = setInterval(() => {
      setFocusCardSeconds(getActiveFocusDisplaySeconds(activeFocus));
    }, 1000);
    return () => clearInterval(intervalId);
  }, [active, activeFocus]);

  useEffect(() => {
    if (!active || !lifeCreativeConnectionForUse || !lifeCreativeKeyForUse.trim()) return;
    let current = true;
    const timerId = setTimeout(() => {
      void observeRuntimeWorkload('home.focus_invite_prepare', async () => {
        if (!isAutomaticRemoteAiAllowed(await loadAutomaticRemoteAiPolicy())) return;
        const dataEpoch = captureBackupRestoreDataEpoch();
        if (dataEpoch === null) return;
        const prepared = await runBackupProtectedTask(async () => {
          if (!current || !(await canOfferFocusInvite())) return null;
          return true;
        });
        if (
          !prepared.ran
          || !prepared.value
          || !current
          || !canCommitBackupRestoreDataEpoch(dataEpoch)
        ) return;
        const currentState = await refreshAssistantLifeState({
          apiKey: lifeCreativeKeyForUse,
          connection: lifeCreativeConnectionForUse,
          dataEpoch,
          profile,
        }).catch(() => loadAssistantState());
        if (
          !current
          || currentState.lifeMode === 'sleeping'
          || !canCommitBackupRestoreDataEpoch(dataEpoch)
        ) return;
        const invitation = await generateFocusInvitation({
          apiKey: lifeCreativeKeyForUse,
          previousState: currentState,
          connection: lifeCreativeConnectionForUse,
          profile,
          skipGlobalCognition: true,
        });
        if (!current || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
        const offered = await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
          if (!current || !(await canOfferFocusInvite())) return false;
          await markFocusInviteOffered();
          return true;
        });
        if (!offered.committed || !offered.value || !canCommitBackupRestoreDataEpoch(dataEpoch) || !invitation) return;
        void showAssistantState(currentState, () => current && canCommitBackupRestoreDataEpoch(dataEpoch));
        Alert.alert('我想一起专注', invitation.message, [
          { text: '先不要', style: 'cancel' },
          {
            text: '一起',
            onPress: () => {
              void (async () => {
                const saved = await runBackupRestoreDataEpochCommit(dataEpoch, () =>
                  savePendingFocusInvite({
                    baiyunActivity: invitation.baiyunActivity,
                    readingId: invitation.readingId,
                    readingActivityId: invitation.readingActivityId,
                    createdAt: Date.now(),
                    message: invitation.message,
                    mode: 'cowork',
                  }),
                );
                if (!saved.committed || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
                navigate('focus');
              })().catch(() => undefined);
            },
          },
        ]);
      });
    }, 45 * 1000);
    return () => {
      current = false;
      clearTimeout(timerId);
    };
  }, [active, lifeCreativeConnectionForUse, lifeCreativeKeyForUse, navigate, profile]);


  return (
    <BackgroundSurface active={active}
      settings={backgroundSettings}
      skyTheme={sky}
      weatherKind={FORCE_DIAGNOSTIC_HOME_DUST ? 'dust' : FORCE_DIAGNOSTIC_HOME_FOG ? 'fog' : FORCE_DIAGNOSTIC_HOME_HAIL ? 'hail' : FORCE_DIAGNOSTIC_HOME_SNOW ? 'snow' : FORCE_DIAGNOSTIC_HOME_RAIN ? 'rain' : displayedWeatherKind}
    >
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.page}>
        <HomeClock active={active} headerTextStyle={headerTextStyle} weatherText={weatherText} />

        <View style={styles.settingsSlot}>
          <ScalePressable onPress={() => navigate('settings')} style={styles.settingsButton}>
            <Image source={homeImages.settings} resizeMode="contain" style={styles.settingsIcon} />
          </ScalePressable>
        </View>

        <View style={styles.aiCard}>
          <ScalePressable accessibilityRole="button" accessibilityLabel="查看白云日记" onPress={() => navigate('assistant-diary')}>
            <BaiyunPortrait active={active} mood={assistantStatus.moodId} cloudForm={assistantStatus.cloudForm} />
          </ScalePressable>
          <View style={styles.aiCopy}>
            <ScalePressable accessibilityRole="button" onPress={() => navigate('assistant-diary')}>
              <Text style={styles.aiTitle}>{assistantStatus.title}</Text>
            </ScalePressable>
            <ScrollView style={{ maxHeight: styles.aiStatus.lineHeight * 3 * fontScale + styles.aiStatus.marginTop }} nestedScrollEnabled showsVerticalScrollIndicator>
              <Text style={styles.aiStatus}>{assistantStatus.activity}</Text>
              <HomeBackgroundAiStatus active={active} />
            </ScrollView>
          </View>
        </View>

        <View style={styles.featureGrid}>
          {featureButtons.map((item) => (
            <ScalePressable
              key={item.label}
              onPress={() => navigate(item.target)}
              style={[styles.featureCard, { width: featureSize, height: featureSize }]}
            >
              <Image source={item.image} resizeMode="contain" style={styles.featureIcon} />
              <Text style={[styles.featureLabel, exposedLabelTextStyle]}>{item.label}</Text>
            </ScalePressable>
          ))}
        </View>

        <View style={styles.toolsRow}>
          <ScalePressable onPress={() => navigate('focus')} style={[styles.toolCard, { width: toolSize, height: toolSize }]}>
            <Image source={homeImages.focus} resizeMode="contain" style={styles.toolImage} />
            <View style={styles.timerPill}>
              <Text style={styles.timerText}>{formatFocusCardTimer(focusCardSeconds)}</Text>
            </View>
          </ScalePressable>

          <HomeNowScheduleCard active={active} size={toolSize} onPress={() => navigate('today-timeline')} />
        </View>

        <ScalePressable onPress={() => navigate('chat')} style={styles.chatEntry}>
          <Image source={homeImages.chatBubble} resizeMode="contain" style={styles.chatBubble} />
          <Text style={styles.chatText}>来说说话吧</Text>
          <Image source={homeImages.mePortraitDefault} resizeMode="contain" style={styles.mePortrait} />
        </ScalePressable>
        </View>
      </SafeAreaView>
    </BackgroundSurface>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
  },
  page: {
    flex: 1,
    paddingTop: 34,
    paddingHorizontal: 20,
    paddingBottom: 50,
    justifyContent: 'space-between',
  },
  topModule: {
    minHeight: 112,
    alignItems: 'center',
    justifyContent: 'center',
  },
  time: {
    color: '#FFFFFF',
    fontSize: 62,
    lineHeight: 68,
    fontWeight: '700',
  },
  date: {
    color: 'rgba(255,255,255,0.92)',
    fontSize: 16,
    lineHeight: 22,
    fontWeight: '600',
  },
  settingsSlot: {
    position: 'absolute',
    right: 18,
    top: 44,
  },
  settingsButton: {
    width: 46,
    height: 46,
    alignItems: 'center',
    justifyContent: 'center',
  },
  settingsIcon: {
    width: 46,
    height: 46,
  },
  aiCard: {
    minHeight: 104,
    borderRadius: 34,
    backgroundColor: 'rgba(255,255,255,0.72)',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  aiPortraitSurfaceFrame: {
    width: 60,
    height: 60,
    overflow: 'visible',
  },
  aiPortraitSurface: {
    position: 'absolute',
    left: -5,
    top: -5,
    width: 70,
    height: 70,
  },
  aiCopy: {
    flex: 1,
    justifyContent: 'center',
    marginLeft: 12,
    minHeight: 68,
  },
  aiTitle: {
    color: colors.ink,
    fontSize: 20,
    lineHeight: 26,
    fontWeight: '700',
  },
  aiStatus: {
    color: colors.ink,
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '500',
    marginTop: 2,
  },
  featureGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  featureCard: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  featureIcon: {
    width: 78,
    height: 78,
  },
  featureLabel: {
    marginTop: 4,
    color: colors.ink,
    fontSize: 14,
    lineHeight: 18,
    fontWeight: '600',
    textAlign: 'center',
  },
  toolsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  toolCard: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  toolImage: {
    ...StyleSheet.absoluteFillObject,
    width: '100%',
    height: '100%',
    opacity: 0.92,
  },
  timerPill: {
    alignItems: 'center',
    height: '50%',
    justifyContent: 'center',
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  timerText: {
    color: colors.ink,
    fontSize: 34,
    lineHeight: 40,
    fontWeight: '700',
    textAlign: 'center',
  },
  chatEntry: {
    minHeight: 92,
    borderRadius: 32,
    backgroundColor: 'rgba(255,255,255,0.78)',
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 20,
    paddingRight: 8,
  },
  mePortrait: {
    width: 88,
    height: 80,
  },
  chatText: {
    flex: 1,
    color: colors.ink,
    fontSize: 28,
    lineHeight: 34,
    fontWeight: '700',
    textAlign: 'center',
  },
  chatBubble: {
    width: 42,
    height: 42,
  },
});
