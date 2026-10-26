import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import {
  formatBodySignalHeartRateRemaining,
  startBodySignalContinuousHeartRate,
  stopBodySignalContinuousHeartRate,
} from './bodySignalHeartRateControl';
import { formatHeartRateTrendText } from './bodySignalHistory';
import { BodySignalEcgStrip } from './BodySignalEcgStrip';
import { useBodySignalSnapshot } from './useBodySignalSnapshot';
import { bodySignalBatteryHint } from './bodySignalBatteryPresentation';
import { AppText as Text } from '../components/AppText';
import { colors } from '../theme/colors';
import type { Navigate } from '../types/navigation';

type Props = {
  navigate: Navigate;
};

function formatMeasuredAt(value?: number): string {
  if (!value) return '暂未记录';
  return new Date(value).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function sourceLabel(provider?: string): string {
  if (provider === 'smarthealth_r99') return 'R99 戒指';
  if (provider === 'standard_gatt') return '穿戴设备';
  if (provider === 'colmi_rxx') return 'COLMI 戒指';
  return '身体设备';
}

export function BodySignalSummaryCard({ navigate }: Props) {
  const snapshot = useBodySignalSnapshot();
  const heartRate = snapshot.heartRate;
  const connected = snapshot.connection.isConnected;
  const receiving = snapshot.isReceivingHeartRate;
  const continuousSession = snapshot.heartRateContinuousSession;
  const continuousStatus = continuousSession?.status ?? 'idle';
  const isContinuous = snapshot.heartRateControlMode === 'continuous';
  const isContinuousRunning = continuousStatus === 'running';
  const isContinuousTransitioning = continuousStatus === 'starting' || continuousStatus === 'stopping';
  const [clockNow, setClockNow] = useState(() => Date.now());
  const busy = isContinuous
    ? isContinuousTransitioning
    : snapshot.isMeasuringHeartRate || snapshot.isConnectionBusy || receiving;

  useEffect(() => {
    if (!isContinuousRunning) return undefined;
    setClockNow(Date.now());
    const timer = setInterval(() => setClockNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [isContinuousRunning, continuousSession?.endsAt]);
  const trendText = formatHeartRateTrendText(snapshot.heartRateTodaySummary, snapshot.recentHeartRates);
  const recentHeartRates = snapshot.recentHeartRates.slice(0, 8);
  const displayedDeviceName = snapshot.connection.deviceName ?? heartRate?.sourceDeviceName;
  const battery = snapshot.battery?.deviceProfileId || !displayedDeviceName || !snapshot.battery?.sourceDeviceName
    || snapshot.battery.sourceDeviceName === displayedDeviceName ? snapshot.battery : undefined;

  const handlePrimaryPress = () => {
    if (busy) return;
    if (isContinuous && connected && snapshot.canMeasureHeartRate) {
      if (isContinuousRunning) {
        void stopBodySignalContinuousHeartRate().catch(() => undefined);
      } else {
        void startBodySignalContinuousHeartRate().catch(() => undefined);
      }
      return;
    }
    navigate('body-signal');
  };

  const primaryLabel = !connected
    ? '去连接设备'
    : isContinuous
      ? continuousStatus === 'starting'
        ? '正在启动'
        : continuousStatus === 'running'
          ? `停止连续测量 · ${formatBodySignalHeartRateRemaining(continuousSession?.endsAt, clockNow, continuousSession?.startedAt)}`
          : continuousStatus === 'stopping'
            ? '正在停止'
            : snapshot.canMeasureHeartRate
              ? '连续测量 5 分钟'
              : '去设置设备'
      : snapshot.isMeasuringHeartRate
        ? '测量中'
        : snapshot.isConnectionBusy
          ? '准备中'
          : receiving
            ? '正在接收心率'
            : '去设置页测量';
  const detailText = heartRate
    ? `${heartRate.sourceDeviceName ?? sourceLabel(heartRate.sourceProvider)} · ${heartRate.stale ? '稍早读到' : '刚读到'} · ${formatMeasuredAt(heartRate.measuredAt)}`
    : connected
      ? '设备已连接，还没有读到心率。'
      : '连接穿戴设备后，白云就能在这里看到最近心率。';
  const batteryText = battery ? `${battery.value}%` : '暂未读到';
  const batteryHint = battery ? bodySignalBatteryHint(snapshot) : '等待支持设备回报';

  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <View>
          <Text style={styles.kicker}>身体信号</Text>
          <Text style={styles.title}>{connected ? snapshot.connection.deviceName ?? '穿戴设备已连接' : '还没有连接穿戴设备'}</Text>
        </View>
        <View style={[styles.statusPill, connected && styles.statusPillConnected]}>
          <Text style={[styles.statusPillText, connected && styles.statusPillTextConnected]}>
            {connected ? '已连接' : '未连接'}
          </Text>
        </View>
      </View>

      <View style={styles.metricRow}>
        <View style={styles.heartBlock}>
          <Text style={styles.metricLabel}>心率</Text>
          <View style={styles.valueRow}>
            <Text style={styles.heartValue}>{heartRate ? heartRate.value : '--'}</Text>
            <Text style={styles.unit}>bpm</Text>
          </View>
          <Text style={styles.detailText}>{detailText}</Text>
          {snapshot.heartRateMeasurementErrorMessage ? (
            <Text style={styles.errorText}>{snapshot.heartRateMeasurementErrorMessage}</Text>
          ) : null}
        </View>
        <View style={styles.sideMetric}>
          <Text style={styles.metricLabel}>电量</Text>
          <Text style={styles.sideValue}>{batteryText}</Text>
          <Text style={styles.sideHint}>{batteryHint}</Text>
        </View>
      </View>

      <View style={styles.trendBlock}>
        <View style={styles.trendHeaderRow}>
          <Text style={styles.trendLabel}>心跳波形</Text>
          <Text style={styles.trendSummary}>{trendText.summaryText}</Text>
        </View>
        <BodySignalEcgStrip
          heartRate={heartRate?.value}
          readingKey={heartRate?.measuredAt}
          recentValues={recentHeartRates.map((reading) => reading.value)}
        />
        <Text style={styles.waveHint}>{recentHeartRates.length ? '最近样本 ' + trendText.recentText : '连接穿戴设备后，这里会出现轻量波形。'}</Text>
      </View>

      <Pressable
        accessibilityRole="button"
        disabled={busy}
        onPress={handlePrimaryPress}
        style={({ pressed }) => [styles.primaryButton, busy && styles.disabledButton, pressed && styles.pressed]}
      >
        <Text style={styles.primaryButtonText}>{primaryLabel}</Text>
      </Pressable>
      <Text style={styles.footerText}>心率只作为生活参考，不替代医学判断；连续测量每轮 5 分钟，也可以随时停止。</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: 'rgba(255,255,255,0.92)',
    borderColor: 'rgba(178,217,255,0.62)',
    borderRadius: 8,
    borderWidth: 1,
    padding: 16,
  },
  detailText: {
    color: colors.muted,
    fontSize: 12,
    lineHeight: 18,
    marginTop: 4,
  },
  disabledButton: {
    opacity: 0.58,
  },
  errorText: {
    color: '#A85A4C',
    fontSize: 12,
    lineHeight: 18,
    marginTop: 4,
  },
  footerText: {
    color: colors.muted,
    fontSize: 12,
    lineHeight: 18,
    marginTop: 8,
  },
  headerRow: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
  },
  heartBlock: {
    flex: 1,
  },
  heartValue: {
    color: colors.ink,
    fontSize: 34,
    fontWeight: '700',
    letterSpacing: 0,
  },
  kicker: {
    color: colors.primary,
    fontSize: 13,
    fontWeight: '700',
  },
  metricLabel: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: '600',
  },
  metricRow: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 14,
  },
  pressed: {
    opacity: 0.78,
  },
  primaryButton: {
    alignItems: 'center',
    backgroundColor: colors.primary,
    borderRadius: 8,
    justifyContent: 'center',
    marginTop: 14,
    minHeight: 42,
    paddingHorizontal: 14,
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
  sideHint: {
    color: colors.muted,
    fontSize: 11,
    marginTop: 3,
  },
  sideMetric: {
    backgroundColor: 'rgba(203,244,236,0.38)',
    borderColor: 'rgba(105,113,132,0.12)',
    borderRadius: 8,
    borderWidth: 1,
    minWidth: 96,
    padding: 12,
  },
  sideValue: {
    color: colors.ink,
    fontSize: 18,
    fontWeight: '700',
    marginTop: 8,
  },
  statusPill: {
    backgroundColor: 'rgba(105,113,132,0.12)',
    borderRadius: 8,
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  statusPillConnected: {
    backgroundColor: 'rgba(203,244,236,0.74)',
  },
  statusPillText: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: '600',
  },
  statusPillTextConnected: {
    color: '#4E7A64',
  },
  title: {
    color: colors.ink,
    fontSize: 17,
    fontWeight: '700',
    letterSpacing: 0,
    marginTop: 3,
  },
  trendBlock: {
    backgroundColor: 'rgba(255,244,232,0.46)',
    borderColor: 'rgba(105,113,132,0.10)',
    borderRadius: 8,
    borderWidth: 1,
    marginTop: 14,
    padding: 12,
  },
  trendHeaderRow: {
    gap: 4,
  },
  trendLabel: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: '600',
  },

  trendSummary: {
    color: colors.ink,
    fontSize: 13,
    fontWeight: '700',
    lineHeight: 20,
    marginTop: 3,
  },
  waveHint: {
    color: colors.muted,
    fontSize: 11,
    lineHeight: 16,
    marginTop: 6,
  },
  unit: {
    color: colors.muted,
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 7,
  },
  valueRow: {
    alignItems: 'flex-end',
    flexDirection: 'row',
    gap: 6,
    marginTop: 3,
  },
});
