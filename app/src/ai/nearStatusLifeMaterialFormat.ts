import type { CoReadingProgressMaterial, CoReadingResultMaterial } from '../reading/readingLifeMaterialPolicy';
import type { WebVoyageLifeMaterialInput } from '../life/webVoyageLifeMaterialPolicy';
import { webVoyageReadingStatusText } from '../life/webVoyageReading';
import type { BodySignalLifeMaterialReading } from '../bodySignal/bodySignalLifeMaterialPolicy';
import { formatBodySignalReadingContext, unknownBodySignalReadingContext } from '../bodySignal/bodySignalReadingContext';
import type { PeriodLifeMaterialLog } from '../period/periodLifeMaterialPolicy';
import type { SystemStatusAmbientSnapshot } from './systemStatusAmbientContext';

export function formatNearStatusRecordedAt(timestamp: number) {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatNearStatusReadingProgress(progress: CoReadingProgressMaterial) {
  return [
    progress.sharedRecently
      ? `I 最近和 you 一起读《${progress.title}》。`
      : `you 最近在读《${progress.title}》。`,
    '',
    `读到：第 ${progress.chapterIndex + 1} / ${progress.totalChapters} 章，段落 P${progress.paragraphIndex}。`,
    `最近阅读：${formatNearStatusRecordedAt(progress.lastActivityAt)}`,
    ...(progress.dayAge === 0 && progress.todayActiveSeconds > 0
      ? [`you 今天阅读约 ${Math.max(1, Math.round(progress.todayActiveSeconds / 60))} 分钟。`]
      : []),
  ].join('\n');
}

export function formatNearStatusReadingResult(result: CoReadingResultMaterial) {
  const title = `${formatNearStatusRecordedAt(result.occurredAt)}｜《${result.title}》`;
  if (result.kind === 'question') {
    return `${title}\nyou 问：\n${result.question}\n\nI 回答：\n${result.answer}`;
  }
  const label = result.kind === 'summary' ? 'I 写的读后感：'
    : result.kind === 'annotation' ? 'I 写的批注：' : 'you 写的笔记：';
  return `${title}\n${label}\n${result.text}`;
}

export function formatNearStatusWebVoyage(entry: WebVoyageLifeMaterialInput) {
  if (entry.status !== 'failed' || entry.title || entry.summary || entry.url) {
    const content = entry.status === 'failed' ? entry.summary : entry.summary || entry.detail;
    return [formatNearStatusRecordedAt(entry.at), webVoyageReadingStatusText(entry.readingStatus, entry.sourceType),
      entry.title || entry.query || '公开材料', content, entry.url].filter(Boolean).join('\n');
  }
  if (entry.status === 'failed') {
    // 保留现役阶段映射；只陈述记录中的停止位置。
    const stage = entry.stage === 'waiting' || entry.stage === 'query' ? '准备搜索词'
      : entry.stage === 'fetch' ? '读取页面'
        : entry.stage === 'summarize' ? '整理内容' : '寻找结果';
    const query = entry.query || entry.title || '这次探索';
    return `${formatNearStatusRecordedAt(entry.at)}\nI 这次试着在网上找找“${query}”，停在了${stage}这一步，没能带回内容。`;
  }
  return '';
}

export function formatNearStatusFocus(focus: {
  startedAt: number;
  paused: boolean;
  endedAt?: number;
  userActivity: string;
  baiyunActivity: string;
}) {
  if (focus.endedAt !== undefined) {
    return `共同专注｜已结束\n开始时间：${formatNearStatusRecordedAt(focus.startedAt)}\n结束时间：${formatNearStatusRecordedAt(focus.endedAt)}\nyou 的事情：${focus.userActivity}\nI 的事情：${focus.baiyunActivity}`;
  }
  return `共同专注｜${focus.paused ? '已暂停' : '进行中'}\n开始时间：${formatNearStatusRecordedAt(focus.startedAt)}\nyou 的事情：${focus.userActivity}\nI 的事情：${focus.baiyunActivity}`;
}

export function formatNearStatusBodySignal(reading: BodySignalLifeMaterialReading, battery: boolean, wantsFactsOnly = false) {
  const recordedAt = formatNearStatusRecordedAt(reading.measuredAt);
  if (battery) {
    return `穿戴设备在 ${recordedAt} 记录到的电量：${Math.max(0, Math.min(100, Math.round(reading.value)))}%。`
      + (wantsFactsOnly ? '' : '\nI 会留意它是不是该充电了。');
  }
  const confidence = reading.confidence === 'high' ? '高' : '中';
  const context = formatBodySignalReadingContext(reading.readingContext ?? unknownBodySignalReadingContext(reading));
  return `穿戴设备在 ${recordedAt} 记录到 you 的心率：${Math.round(reading.value)} 次/分钟（可信度${confidence}）。\n${context}`
    + (wantsFactsOnly ? '' : '\n\nI 会结合 you 当时的活动理解这次读数，也留意 you 现在感觉怎么样。');
}

export function formatNearStatusPeriodLogParts(log: PeriodLifeMaterialLog, options: { today?: boolean; includePeriodState?: boolean } = {}) {
  const parts: string[] = [];
  if (log.bodyState === 'uncertain') parts.push(options.today ? '今天记录了身体不舒服' : '记录了身体不舒服');
  else if (options.includePeriodState && log.bodyState === 'period') parts.push(options.today ? '今天记录为经期' : '记录为经期');
  if (log.painLevel > 0) parts.push(`疼痛 ${log.painLevel}/5`);
  const flow = { heavy: '多', light: '少', medium: '中', none: '无', spotting: '点滴' };
  if (log.flow !== 'none') parts.push(`流量 ${flow[log.flow]}`);
  const symptoms = log.symptoms.filter((symptom) => symptom.trim());
  if (symptoms.length) parts.push(`症状：${symptoms.join('、')}`);
  if (log.note.trim()) parts.push(`备注：${log.note}`);
  return parts;
}

export function formatNearStatusPhone(snapshot: SystemStatusAmbientSnapshot) {
  const chargingState = snapshot.battery.state === 'charging' ? '充电中'
    : snapshot.battery.state === 'full' ? '已充满'
      : snapshot.battery.state === 'unplugged' ? '未充电' : '充电状态未知';
  const batteryText = snapshot.battery.percentage === null ? '未知' : `${snapshot.battery.percentage}%`;
  return [
    `手机状态记录：${formatNearStatusRecordedAt(snapshot.checkedAt)}`,
    `手机电量：${batteryText}，${chargingState}。`,
    ...(typeof snapshot.battery.isLowPowerModeEnabled === 'boolean'
      ? [`低电量模式：${snapshot.battery.isLowPowerModeEnabled ? '已开启' : '未开启'}。`] : []),
    ...(snapshot.appState ? [`君落运行状态：${snapshot.appState}。`] : []),
    ...(snapshot.stale ? ['这是较早的记录，手机状态可能已经变化。'] : []),
  ].join('\n');
}

export function formatNearStatusLifeEntries(entries: { promptLine: string }[]) {
  return entries.length ? `【最近的生活】\n\n${entries.map((item) => item.promptLine).join('\n\n')}` : '';
}

export function selectNearStatusLifeEntries<T extends { id: string; source: string; fingerprint: string; promptLine: string }>(
  sortedItems: T[],
  excludeIds: readonly string[] = [],
) {
  const excluded = new Set(excludeIds);
  const seen = new Set<string>();
  const selected: T[] = [];
  for (const item of sortedItems) {
    if (selected.length >= 8) break;
    const key = `${item.source}\0${item.id}\0${item.fingerprint}`;
    if (excluded.has(item.id) || seen.has(key)) continue;
    seen.add(key);
    if (Array.from(formatNearStatusLifeEntries([...selected, item])).length <= 1000) selected.push(item);
  }
  return selected;
}
