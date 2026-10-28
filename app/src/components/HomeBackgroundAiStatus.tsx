import { Alert, Pressable, StyleSheet, View } from 'react-native';
import { AppText as Text } from './AppText';
import { useHomeBackgroundAiStatus } from '../runtime/useHomeBackgroundAiStatus';

export function HomeBackgroundAiStatus({ active }: { active: boolean }) {
  const { snapshot, readFailed } = useHomeBackgroundAiStatus(active);
  const view = snapshot?.view;
  const title = readFailed ? '后台状态读取失败' : view?.title ?? '正在读取后台状态';
  const detail = readFailed ? '暂时读不到运行记录；不能据此判断模型是否失败。' : view?.detail;
  const warning = readFailed || view?.tone === 'error' || view?.tone === 'warning';
  const checkedAt = snapshot ? `状态检查时间：${new Date(snapshot.checkedAt).toLocaleString('zh-CN')}` : undefined;
  const showDetails = () => Alert.alert('后台 AI 运行状态', [
    readFailed ? `${title}\n${detail}` : detail ?? title, checkedAt,
  ].filter(Boolean).join('\n\n'), [
    { text: '关闭', style: 'cancel' },
    ...(!readFailed && view?.historyDetail ? [{ text: '更多记录', onPress: () => Alert.alert(
      '更多后台记录', [view.historyDetail, checkedAt].filter(Boolean).join('\n\n'),
    ) }] : []),
  ]);
  return (
    <Pressable accessibilityRole="button" accessibilityLabel="查看后台AI运行状态" onPress={showDetails}
      style={styles.container}>
      <View style={styles.row}>
        <Text style={styles.label}>后台</Text>
        <Text numberOfLines={2} style={[styles.status, warning && styles.warning]}>{title}</Text>
        <Text style={styles.arrow}>›</Text>
      </View>
      {view?.lastFailure && !readFailed ? <Text numberOfLines={2} style={styles.failure}>{view.lastFailure}</Text> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { marginTop: 6, paddingTop: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#CBD9E2' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  label: { color: '#687D8C', fontSize: 11 },
  status: { color: '#4F6777', fontSize: 11, lineHeight: 16, flex: 1 },
  warning: { color: '#A35A45' },
  arrow: { color: '#687D8C', fontSize: 17 },
  failure: { color: '#A35A45', fontSize: 11, lineHeight: 16, marginTop: 3 },
});
