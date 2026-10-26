export type PeriodLifeMaterialImportance = 'low' | 'medium' | 'high';

export type PeriodLifeMaterialLog = {
  bodyState: 'normal' | 'uncertain' | 'period';
  dateKey: string;
  flow: 'none' | 'spotting' | 'light' | 'medium' | 'heavy';
  note: string;
  painLevel: number;
  symptoms: string[];
  updatedAt: number;
};

export type PeriodLifeMaterialInput = {
  currentDay: number | null;
  daysUntilDue: number | null;
  isCurrent: boolean;
  now: number;
  previousLog: PeriodLifeMaterialLog | null;
  todayDateKey: string;
  todayLog: PeriodLifeMaterialLog | null;
};

export type PeriodLifeMaterial = {
  expiresAt: number;
  fingerprintKey: string;
  id: string;
  importance: PeriodLifeMaterialImportance;
  occurredAt: number;
  promptLine: string;
  summary: string;
};

const FLOW_LABELS: Record<PeriodLifeMaterialLog['flow'], string> = {
  heavy: '多',
  light: '少',
  medium: '中',
  none: '无',
  spotting: '点滴',
};

function compactText(value: unknown, limit = 80) {
  return typeof value === 'string'
    ? value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit)
    : '';
}

function localDateKey(timestamp: number) {
  const date = new Date(timestamp);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

function startOfLocalDay(timestamp: number) {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function startOfNextLocalDay(timestamp: number) {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + 1);
  return date.getTime();
}

function previousLocalDateKey(timestamp: number) {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - 1);
  return localDateKey(date.getTime());
}

function hasLogContent(log: PeriodLifeMaterialLog | null) {
  if (!log) return false;
  return log.bodyState !== 'normal'
    || log.flow !== 'none'
    || log.painLevel > 0
    || log.symptoms.some((symptom) => compactText(symptom))
    || Boolean(compactText(log.note));
}

function isHighImportanceLog(log: PeriodLifeMaterialLog | null) {
  if (!log) return false;
  return log.bodyState === 'uncertain'
    || log.painLevel >= 3
    || log.flow === 'heavy';
}

function formatLogParts(
  log: PeriodLifeMaterialLog,
  options: { includePeriodState?: boolean; today?: boolean } = {},
) {
  const parts: string[] = [];
  if (log.bodyState === 'uncertain') {
    parts.push(options.today ? '今天记录了身体不舒服' : '记录了身体不舒服');
  } else if (options.includePeriodState && log.bodyState === 'period') {
    parts.push(options.today ? '今天记录为经期' : '记录为经期');
  }
  if (log.painLevel > 0) parts.push(`疼痛 ${log.painLevel}/5`);
  if (log.flow !== 'none') parts.push(`流量 ${FLOW_LABELS[log.flow]}`);
  const symptoms = log.symptoms
    .map((symptom) => compactText(symptom, 30))
    .filter(Boolean)
    .slice(0, 8);
  if (symptoms.length) parts.push(`症状：${symptoms.join('、')}`);
  const note = compactText(log.note);
  if (note) parts.push(`备注：${note}`);
  return parts;
}

function logFingerprint(log: PeriodLifeMaterialLog | null) {
  if (!log) return '';
  return [
    log.dateKey,
    log.bodyState,
    log.flow,
    Math.max(0, Math.min(5, Math.round(log.painLevel))),
    log.symptoms.map((symptom) => compactText(symptom, 30)).filter(Boolean).join(','),
    compactText(log.note),
  ].join('|');
}

function isDueSoon(daysUntilDue: number | null) {
  return typeof daysUntilDue === 'number'
    && Number.isFinite(daysUntilDue)
    && daysUntilDue <= 7
    && daysUntilDue >= -14;
}

export function selectPeriodLifeMaterial(input: PeriodLifeMaterialInput): PeriodLifeMaterial | null {
  const todayLog = input.todayLog?.dateKey === input.todayDateKey
    ? input.todayLog
    : null;
  const todayHasContent = hasLogContent(todayLog);
  const previousLog = input.previousLog?.dateKey === previousLocalDateKey(input.now)
    ? input.previousLog
    : null;
  const carryPrevious = !todayLog
    && hasLogContent(previousLog)
    && isHighImportanceLog(previousLog);
  const currentParts: string[] = [];

  if (input.isCurrent && typeof input.currentDay === 'number' && input.currentDay > 0) {
    currentParts.push(`经期第 ${Math.round(input.currentDay)} 天`);
  }
  if (todayHasContent && todayLog) {
    currentParts.push(...formatLogParts(todayLog, {
      includePeriodState: !input.isCurrent,
      today: true,
    }));
  } else if (input.isCurrent && carryPrevious && previousLog) {
    currentParts.push(`昨天记录：${formatLogParts(previousLog).join('；')}`);
  }

  if (currentParts.length) {
    const importance: PeriodLifeMaterialImportance = todayHasContent && isHighImportanceLog(todayLog)
      ? 'high'
      : 'medium';
    const occurredAt = todayHasContent && todayLog
      ? todayLog.updatedAt
      : startOfLocalDay(input.now);
    return {
      expiresAt: startOfNextLocalDay(input.now),
      fingerprintKey: [
        input.todayDateKey,
        input.isCurrent,
        input.currentDay ?? '',
        todayHasContent ? logFingerprint(todayLog) : '',
        carryPrevious ? logFingerprint(previousLog) : '',
      ].join('|'),
      id: `period:${input.todayDateKey}`,
      importance,
      occurredAt,
      promptLine: `小仓鼠身体记录：${currentParts.join('；')}。I 会留意这些具体感受，温柔照看小仓鼠。`,
      summary: currentParts.join('；'),
    };
  }

  if (carryPrevious && previousLog) {
    const parts = formatLogParts(previousLog);
    return {
      expiresAt: startOfNextLocalDay(input.now),
      fingerprintKey: `${input.todayDateKey}|previous|${logFingerprint(previousLog)}`,
      id: `period:previous:${previousLog.dateKey}`,
      importance: 'medium',
      occurredAt: previousLog.updatedAt,
      promptLine: `小仓鼠身体记录：昨天留下的记录是${parts.join('；')}。I 今天会继续留意小仓鼠有没有新的变化。`,
      summary: `昨天：${parts.join('；')}`,
    };
  }

  if (isDueSoon(input.daysUntilDue)) {
    return {
      expiresAt: startOfNextLocalDay(input.now),
      fingerprintKey: `${input.todayDateKey}|prediction|${input.daysUntilDue}`,
      id: `period:prediction:${input.todayDateKey}`,
      importance: 'low',
      occurredAt: startOfLocalDay(input.now),
      promptLine: '小仓鼠身体记录：根据已有日期，最近可能接近经期窗口。I 会把它当作时间参考，留意小仓鼠今天实际说出的感受。',
      summary: '根据已有日期，最近可能接近经期窗口',
    };
  }

  return null;
}
