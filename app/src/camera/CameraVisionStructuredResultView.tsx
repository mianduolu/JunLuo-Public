import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { AppText as Text } from '../components/AppText';
import type { CameraVisionAnalysisSuccessV1 } from './cameraVisionStructured';

type Props = {
  analysis: CameraVisionAnalysisSuccessV1;
  deletionLabel?: string;
  persistenceLabel?: string;
};

function describePeople(analysis: CameraVisionAnalysisSuccessV1) {
  const visibility = analysis.result.subjectVisibility;
  if (visibility.status === 'none') return '0 人';
  if (visibility.status === 'unknown') return '人数未知';
  return `${visibility.visibleCount ?? visibility.subjects.length} 人`;
}

export function CameraVisionStructuredResultView({ analysis, deletionLabel, persistenceLabel }: Props) {
  const [expanded, setExpanded] = useState(false);
  const { result } = analysis;

  return (
    <View style={styles.card}>
      <Text style={styles.title}>结构化整理完成</Text>
      <Text style={styles.summary}>{result.sceneSummary}</Text>
      <View style={styles.chips}>
        <Text style={styles.chip}>画面：{result.frameUsability}</Text>
        <Text style={styles.chip}>把握：{result.overallConfidence}</Text>
        <Text style={styles.chip}>人物：{describePeople(analysis)}</Text>
      </View>
      <Text style={styles.meta}>人物身份：身份材料未提供</Text>
      <Text style={styles.meta}>模型：{analysis.provider} · {analysis.model}</Text>
      <Text style={styles.meta}>耗时：{analysis.latencyMs} ms · 调用 {analysis.attemptCount} 次{analysis.repairUsed ? ' · 已再次整理' : ''}</Text>
      {deletionLabel ? <Text style={styles.meta}>临时帧：{deletionLabel}</Text> : null}
      <Text style={styles.boundary}>{persistenceLabel ?? '本次结果未写入观察记录，也没有形成白云回应。'}</Text>

      <Pressable accessibilityRole="button" onPress={() => setExpanded((value) => !value)} style={styles.toggle}>
        <Text style={styles.toggleText}>{expanded ? '收起结构化详情' : '查看客观事实、谨慎推断与不确定性'}</Text>
      </Pressable>

      {expanded ? <View style={styles.details}>
        <Text style={styles.sectionTitle}>客观事实</Text>
        {result.objectiveFacts.length > 0
          ? result.objectiveFacts.map((fact) => <Text key={fact.factId} style={styles.item}>• {fact.text}（{fact.evidenceQuality}）</Text>)
          : <Text style={styles.empty}>暂无</Text>}

        <Text style={styles.sectionTitle}>谨慎推断</Text>
        {result.inferences.length > 0
          ? result.inferences.map((inference) => <Text key={inference.inferenceId} style={styles.item}>• {inference.text}（{inference.confidence}；依据 {inference.evidenceFactIds.join('、')}）</Text>)
          : <Text style={styles.empty}>暂无</Text>}

        <Text style={styles.sectionTitle}>不确定性</Text>
        {result.uncertainties.length > 0
          ? result.uncertainties.map((uncertainty) => <Text key={uncertainty.uncertaintyId} style={styles.item}>• {uncertainty.text}</Text>)
          : <Text style={styles.empty}>暂无</Text>}

        <Text style={styles.sectionTitle}>设备信息</Text>
        {result.deviceContextFacts.length > 0
          ? result.deviceContextFacts.map((fact) => <Text key={fact.factId} style={styles.item}>• {fact.text}</Text>)
          : <Text style={styles.empty}>本轮未提供</Text>}
        <Text style={styles.meta}>JSON mode：{analysis.responseFormatRequested ? '已请求' : '未请求'}</Text>
      </View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: 9,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: '#E5D8F4',
    backgroundColor: '#F8F2FF',
    padding: 16,
  },
  title: { color: '#51435D', fontSize: 17, fontWeight: '600' },
  summary: { color: '#3E4351', fontSize: 15, lineHeight: 23, fontWeight: '400' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  chip: { color: '#6A526B', backgroundColor: '#F0E2F4', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5, fontSize: 13, fontWeight: '600' },
  meta: { color: '#766E7D', fontSize: 13, lineHeight: 19 },
  boundary: { color: '#9B6178', fontSize: 13, lineHeight: 20, fontWeight: '600' },
  toggle: { borderRadius: 16, borderWidth: 1, borderColor: '#E6C8D7', backgroundColor: '#FFF7FA', paddingHorizontal: 12, paddingVertical: 11 },
  toggleText: { color: '#A84E71', fontSize: 14, fontWeight: '800', textAlign: 'center' },
  details: { gap: 7, paddingTop: 3 },
  sectionTitle: { color: '#504659', fontSize: 15, fontWeight: '800', marginTop: 5 },
  item: { color: '#5F5A67', fontSize: 14, lineHeight: 21 },
  empty: { color: '#9A929D', fontSize: 14 },
});
