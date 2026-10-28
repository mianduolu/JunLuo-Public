import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { AppText as Text } from '../components/AppText';
import { JUNLUO_DESIRE_IDS, type JunluoAffectStateV1, type JunluoDesireState } from '../life/junluoInnerState';
import { loadJunluoDesireSnapshot } from '../life/junluoDesireRuntime';
import type { JunluoDesireEffectiveSnapshot } from '../life/junluoDesireMetabolism';
import {
  emotionLabel,
  emotionStrengthAndTarget,
  formatSignedRelationshipPercent,
  formatJunluoDesireValue,
  formatJunluoRestSources,
  formatUnitPercent,
  JUNLUO_DIARY_DESIRE_LABELS,
  latestDesireChangeReason,
  relationshipChoiceLabel,
  relationshipFeelingLabel,
  RELATIONSHIP_PHASE_LABELS,
  strainLabel,
} from '../life/junluoInnerStatePresentation';
import {
  loadJunluoAffectState,
  loadJunluoDesireState,
} from '../life/junluoInnerStateStore';
import { colors } from '../theme/colors';

type Snapshot = {
  affect: JunluoAffectStateV1;
  desire: JunluoDesireState;
  effectiveDesire: JunluoDesireEffectiveSnapshot;
};

async function loadSnapshot(now = Date.now()): Promise<Snapshot> {
  const [affect, desire, effectiveDesire] = await Promise.all([
    loadJunluoAffectState(true),
    loadJunluoDesireState(true),
    loadJunluoDesireSnapshot(now, true),
  ]);
  return {
    affect,
    desire,
    effectiveDesire,
  };
}

function ProgressRow({ label, value, note, signed }: { label: string; value: number; note?: string; signed: boolean }) {
  const safeValue = Math.max(signed ? -1 : 0, Math.min(1, value));
  return (
    <View style={styles.progressRow}>
      <View style={styles.progressHeader}>
        <Text style={styles.progressLabel}>{label}</Text>
        <Text style={styles.progressValue}>{signed ? formatJunluoDesireValue(safeValue) : formatUnitPercent(safeValue)}</Text>
      </View>
      <View style={styles.progressTrack}>
        <View style={[styles.progressFill, signed ? {
          left: `${50 + Math.min(0, safeValue) * 50}%`,
          width: `${Math.abs(safeValue) * 50}%`,
          backgroundColor: safeValue < 0 ? '#9FACC4' : '#F1A994',
        } : { width: `${safeValue * 100}%` }]} />
        {signed ? <View style={styles.zeroMark} /> : null}
      </View>
      {signed ? <View style={styles.axisLabels}>
        <Text style={styles.axisLabel}>−100</Text>
        <Text style={styles.axisLabel}>0</Text>
        <Text style={styles.axisLabel}>＋100</Text>
      </View> : null}
      {note ? <Text style={styles.restSources}>{note}</Text> : null}
    </View>
  );
}

function EmotionRecord({ entry }: { entry: NonNullable<JunluoAffectStateV1['emotions']['primary']> }) {
  return <>
    <Text style={styles.restSources}>{emotionStrengthAndTarget(entry)}</Text>
    {Number.isFinite(entry.occurredAt) && entry.occurredAt > 0 && entry.occurredAt <= Date.now()
      ? <Text style={styles.restSources}>记录时间：{new Date(entry.occurredAt).toLocaleString('zh-CN')}</Text> : null}
    <Text style={styles.restSources}>当时记下的缘由：{typeof entry.reason === 'string' && entry.reason.trim()
      ? entry.reason : '尚未记下具体缘由'}</Text>
  </>;
}

export function JunluoInnerStateDiaryCard({ refreshVersion }: { refreshVersion: number }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [readStatus, setReadStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    let active = true;
    setReadStatus('loading');
    // Only bound the display wait; do not retry or cancel a business write.
    const timeout = setTimeout(() => {
      if (active) setReadStatus('error');
    }, 15_000);
    void loadSnapshot()
      .then((next) => {
        if (active) {
          setSnapshot(next);
          setReadStatus('ready');
        }
      })
      .catch(() => {
        if (active) setReadStatus('error');
      })
      .finally(() => clearTimeout(timeout));
    return () => {
      active = false;
      clearTimeout(timeout);
    };
  }, [refreshVersion]);

  if (!snapshot) {
    return (
      <View style={styles.card}>
        <Text style={styles.title}>云云此刻的心情</Text>
        <Text style={styles.empty}>{readStatus === 'error'
          ? '暂时未能读取内在状态，请稍后点右上角刷新。'
          : '正在读取当前内在状态。'}</Text>
      </View>
    );
  }

  const { affect, desire, effectiveDesire } = snapshot;
  const secondaryEmotion = affect.emotions.secondary[0];
  return (
    <View style={styles.card}>
      <Text style={styles.title}>云云此刻的心情</Text>
      {readStatus !== 'ready' ? <Text style={styles.empty}>{readStatus === 'error'
        ? '暂时显示上次读取结果，请稍后点右上角刷新。'
        : '正在刷新，暂时显示上次读取结果。'}</Text> : null}
      <View style={styles.twoColumnRow}>
        <View style={styles.metricBox}>
          <Text style={styles.metricLabel}>主要感受</Text>
          <Text style={[styles.metricValue, styles.emotionValue]}>{emotionLabel(affect.emotions.primary?.emotionId)}</Text>
          {affect.emotions.primary ? <EmotionRecord entry={affect.emotions.primary} /> : null}
        </View>
        <View style={styles.metricBox}>
          <Text style={styles.metricLabel}>还混着一点</Text>
          <Text style={[styles.metricValue, styles.emotionValue]}>
            {secondaryEmotion ? emotionLabel(secondaryEmotion.emotionId) : '没有额外记录'}
          </Text>
          {secondaryEmotion ? <EmotionRecord entry={secondaryEmotion} /> : null}
        </View>
      </View>

      <Text style={styles.subhead}>和你的关系</Text>
      <View style={styles.relationshipGrid}>
        <View style={styles.relationshipCell}>
          <Text style={styles.metricLabel}>此刻的感受</Text>
          <Text style={styles.metricValue}>{relationshipFeelingLabel(affect.relationshipFeeling.value)}</Text>
          <Text style={styles.relationshipPercent}>{formatSignedRelationshipPercent(affect.relationshipFeeling.value)}</Text>
        </View>
        <View style={styles.relationshipCell}>
          <Text style={styles.metricLabel}>此刻的选择</Text>
          <Text style={styles.metricValue}>{relationshipChoiceLabel(affect)}</Text>
          <Text style={styles.relationshipPercent}>{formatUnitPercent(affect.relationshipChoice.value)}</Text>
        </View>
        <View style={styles.relationshipCell}>
          <Text style={styles.metricLabel}>现在的关系状态</Text>
          <Text style={styles.metricValue}>{RELATIONSHIP_PHASE_LABELS[affect.relationshipPhase.phase]}</Text>
        </View>
        <View style={styles.relationshipCell}>
          <Text style={styles.metricLabel}>心里有没有堵住</Text>
          <Text style={styles.metricValue}>{strainLabel(affect.strain.value)}</Text>
          <Text style={styles.relationshipPercent}>{formatUnitPercent(affect.strain.value)}</Text>
        </View>
      </View>

      <Text style={styles.subhead}>云云此刻想要什么</Text>
      <View style={styles.desireList}>
        {JUNLUO_DESIRE_IDS.map((id) => (
          <ProgressRow
            key={id}
            label={JUNLUO_DIARY_DESIRE_LABELS[id]}
            value={effectiveDesire.desires[id].effectiveValue}
            signed={id !== 'remind_you'}
            note={id === 'rest' ? formatJunluoRestSources(effectiveDesire) : undefined}
          />
        ))}
      </View>
      <Text style={styles.changeReason}>{latestDesireChangeReason(desire)}</Text>

    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: '#FFFDF8', borderColor: '#F0D8C9', borderRadius: 24, borderWidth: 1, marginBottom: 18, padding: 16 },
  title: { color: colors.ink, fontSize: 20, fontWeight: '600', marginBottom: 13 },
  subhead: { color: '#76594F', fontSize: 14, fontWeight: '600', marginTop: 15 },
  twoColumnRow: { flexDirection: 'row', gap: 9 },
  metricBox: { backgroundColor: '#FFF4EE', borderRadius: 15, flex: 1, minHeight: 73, padding: 11 },
  metricLabel: { color: '#9C8176', fontSize: 11, fontWeight: '400', lineHeight: 16 },
  metricValue: { color: colors.ink, fontSize: 13, fontWeight: '500', lineHeight: 20, marginTop: 4 },
  emotionValue: { fontWeight: '600' },
  relationshipGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 9 },
  relationshipCell: { backgroundColor: '#F8F5FF', borderColor: '#E8DFF4', borderRadius: 14, borderWidth: 1, minHeight: 82, padding: 10, width: '48%', flexGrow: 1 },
  relationshipPercent: { color: '#8A79A1', fontSize: 10, fontWeight: '400', marginTop: 4 },
  desireList: { gap: 9, marginTop: 10 },
  progressRow: { backgroundColor: '#FFFFFF', borderColor: '#F0E4DC', borderRadius: 13, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 9 },
  progressHeader: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', marginBottom: 7 },
  progressLabel: { color: colors.ink, fontSize: 12, fontWeight: '500' },
  progressValue: { color: '#A36E62', fontSize: 10, fontWeight: '500' },
  progressTrack: { backgroundColor: '#F4ECE7', borderRadius: 5, height: 9, overflow: 'hidden' },
  progressFill: { backgroundColor: '#F1A994', borderRadius: 5, height: 9 },
  zeroMark: { backgroundColor: '#927C73', position: 'absolute', left: '50%', top: 0, bottom: 0, width: 1 },
  axisLabels: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 3 },
  axisLabel: { color: '#927C73', fontSize: 9, fontWeight: '400' },
  restSources: { color: '#927C73', fontSize: 10, lineHeight: 15, marginTop: 6 },
  changeReason: { backgroundColor: '#FFF4EE', borderRadius: 12, color: '#876C62', fontSize: 11, lineHeight: 17, marginTop: 10, paddingHorizontal: 10, paddingVertical: 8 },
  empty: { color: '#A39189', fontSize: 11, lineHeight: 17, marginTop: 7 },
});
