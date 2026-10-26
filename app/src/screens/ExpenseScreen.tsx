import { useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';

import {
  analyzeFundCandidate,
  fetchFundCandidate,
  fetchFundProfile,
  searchFunds,
  type FundCandidate,
  type FundPoolCategory,
  type FundProfile,
  type FundSearchItem,
  type FundSourceType,
  type FundThoughtAnalysis,
  type FundThoughtSignalType,
} from '../backend/backendClient';
import {
  canCommitBackupRestoreDataEpoch,
  captureBackupRestoreDataEpoch,
  runBackupRestoreDataEpochCommit,
} from '../backup/backupRestoreCoordinator';
import { useAiConfigPreferences } from '../ai/AiConfigPreferences';
import { AppText as Text, AppTextInput as TextInput } from '../components/AppText';
import { expenseCategories, incomeCategories } from '../expense/expenseParser';
import { buildWalletHealthReport, type WalletHealthStatus } from '../expense/walletHealthCheck';
import { walletProductName, walletSafetyBoundaries, walletSafetySummary } from '../expense/walletSafety';
import {
  buildWalletFundDecisionFromPools,
  buildWalletFundDecisionFromText,
  type WalletFundDecisionReview,
  type WalletFundSelectionTrace,
} from '../expense/walletFundDecisionPipeline';
import { consumeWalletTabRequest, enqueueWalletChatNotice, type WalletOpenRequest } from '../expense/walletNavigation';
import { refreshWalletDecisionReviews } from '../expense/walletDecisionReviewService';
import { resolveWalletBuyNav, type WalletBuyNavResolution } from '../expense/walletDecisionNavService';
import { buildWalletLearningSummary } from '../expense/walletLearningSummary';
import { buildWalletObservationReminderReport } from '../expense/walletObservationReminderService';
import { assessWalletRisk, type WalletRiskAssessment } from '../expense/walletRiskRules';
import type { WalletValuationReview } from '../expense/walletReviewCopy';
import { refreshWalletValuations } from '../expense/walletValuationService';
import { walletWatchlistCopy } from '../expense/walletWatchlistCopy';
import { refreshWalletWatchlist, type WalletWatchlistItem, type WalletWatchlistResult } from '../expense/walletWatchlistService';
import {
  approveWalletBuyDecisionOnce as approveWalletBuyDecision,
} from '../expense/walletExecutionOnce';
import {
  approveWalletDecision,
  createWalletDecision,
  deleteWalletDebugDecisions,
  importManualWalletHolding,
  loadOrCreateDefaultWallet,
  loadOrCreateWalletPreferences,
  loadWalletDecisions,
  loadWalletDecisionReviews,
  loadWalletHoldings,
  loadWalletSnapshots,
  loadWalletTransactions,
  saveWalletPreferences,
  updateWalletBudget,
  updateWalletDecisionStatus,
  updateWalletRiskProfile,
  type AiWallet,
  type WalletAvoidType,
  type WalletDecision,
  type WalletDecisionAction,
  type WalletDecisionNavSource,
  type WalletDecisionReview,
  type WalletDecisionStatus,
  type WalletHolding,
  type WalletPreferenceConfig,
  type WalletPreferredPool,
  type WalletRiskProfile,
  type WalletSnapshot,
  type WalletTransaction,
} from '../expense/walletStore';
import {
  applyExpenseMutation,
  loadExpenseEntryById,
  loadExpenseRefundOriginalState,
  loadExpenseEntriesBetween,
  type ExpenseDraft,
  type ExpenseEntry,
  type ExpenseEntryType,
} from '../expense/expenseStore';
import { colors } from '../theme/colors';
import type { Navigate } from '../types/navigation';

type ExpenseRange = 'month' | 'lastMonth' | 'last30';
type ExpenseTab = 'ledger' | 'wallet';

type WalletDecisionThoughtContext = {
  candidate: FundCandidate;
  loadedAt: number;
  riskAssessment: WalletRiskAssessment;
  selectionTrace?: WalletFundSelectionTrace;
  thoughtAnalysis: FundThoughtAnalysis;
  warnings: string[];
};

type WalletDecisionNavMeta = {
  manual: boolean;
  message: string;
  resolvedAt: number | null;
  source: WalletDecisionNavSource | 'none';
};

type WalletManualHoldingForm = {
  avgCostNav: string;
  fundCode: string;
  fundName: string;
  fundType: string;
  latestNav: string;
  shares: string;
  totalCost: string;
  warnDownPct: string;
  warnUpPct: string;
};

type WalletPreferenceForm = {
  avoidTypes: WalletAvoidType[];
  budget: string;
  comfortSingleAmount: string;
  enabled: boolean;
  preferredPools: WalletPreferredPool[];
  riskProfile: WalletRiskProfile;
  tendency: string;
};

const walletRiskProfileOptions: Array<{ label: string; value: WalletRiskProfile }> = [
  { label: '只看现金', value: 'cash_like' },
  { label: '稳稳一点', value: 'low' },
  { label: '可以看宽基', value: 'medium' },
];

const walletPreferredPoolOptions: Array<{ label: string; value: WalletPreferredPool }> = [
  { label: '现金停泊', value: 'cash_parking' },
  { label: '稳健', value: 'stable' },
  { label: '宽基', value: 'broad_index' },
];

const walletAvoidTypeOptions: Array<{ label: string; value: WalletAvoidType }> = [
  { label: '主题', value: 'watchlist' },
  { label: 'ETF', value: 'etf' },
  { label: 'QDII', value: 'qdii' },
  { label: '商品', value: 'commodity' },
  { label: '行业', value: 'industry' },
];

type CategoryTotal = {
  amount: number;
  category: string;
  color: string;
  percent: number;
};

const rangeOptions: Array<{ label: string; value: ExpenseRange }> = [
  { label: '本月', value: 'month' },
  { label: '上月', value: 'lastMonth' },
  { label: '近30天', value: 'last30' },
];

const categoryColors = [
  '#F5A89B',
  '#A9D4F8',
  '#FFD88D',
  '#9FD3B1',
  '#CDB8FF',
  '#F6B6D0',
  '#8FD4D1',
  '#F0C38D',
  '#B7C6F7',
  '#BFD7A8',
];

const WALLET_HISTORY_PREVIEW_LIMIT = 6;

function formatMoney(value: number) {
  return `¥${value.toFixed(2)}`;
}

function formatNav(value: number) {
  return value.toFixed(4);
}

function parseNavInput(value: string) {
  const parsed = Number(value.replace(/[^\d.]/g, ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parsePositiveInput(value: string) {
  const parsed = Number(value.replace(/[^\d.]/g, ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseOptionalSignedInput(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed.replace(/[^\d.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function createEmptyManualHoldingForm(): WalletManualHoldingForm {
  return {
    avgCostNav: '',
    fundCode: '',
    fundName: '',
    fundType: '',
    latestNav: '',
    shares: '',
    totalCost: '',
    warnDownPct: '-3',
    warnUpPct: '15',
  };
}

function createWalletPreferenceForm(wallet: AiWallet | null, preferences: WalletPreferenceConfig | null): WalletPreferenceForm {
  return {
    avoidTypes: preferences?.avoidTypes ?? [],
    budget: wallet ? String(wallet.totalBudget) : '100',
    comfortSingleAmount: preferences?.comfortSingleAmount ? String(preferences.comfortSingleAmount) : '',
    enabled: preferences?.enabled ?? true,
    preferredPools: preferences?.preferredPools ?? [],
    riskProfile: wallet?.riskProfile ?? 'low',
    tendency: preferences?.tendency ?? '',
  };
}

function toggleArrayValue<T extends string>(values: T[], value: T) {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

function formatWalletRiskProfileLabel(profile: WalletRiskProfile | undefined) {
  if (profile === 'cash_like') return '只看现金';
  if (profile === 'medium') return '可以看宽基';
  if (profile === 'high') return '高风险';
  return '稳稳一点';
}

function formatWalletPreferenceSummary(preferences: WalletPreferenceConfig | null) {
  if (!preferences) return '还没写计划，先按默认小额稳稳路线来。';
  if (!preferences.enabled) return '这次先不让白云小姐自动挑基金，只看记录和观察。';
  const poolLabels = preferences.preferredPools
    .map((pool) => walletPreferredPoolOptions.find((option) => option.value === pool)?.label)
    .filter(Boolean)
    .join('、');
  const avoidLabels = preferences.avoidTypes
    .map((type) => walletAvoidTypeOptions.find((option) => option.value === type)?.label)
    .filter(Boolean)
    .join('、');
  const parts = [
    poolLabels ? `更想先看：${poolLabels}` : '先按现金、稳健、宽基顺序看',
    avoidLabels ? `暂时避开：${avoidLabels}` : '',
    preferences.comfortSingleAmount ? `舒服单笔：${formatMoney(preferences.comfortSingleAmount)}` : '舒服单笔：默认 10 元',
    preferences.tendency.trim() ? `小计划：${preferences.tendency.trim()}` : '',
  ].filter(Boolean);
  return parts.join('。');
}

function formatDecisionNavSource(source: WalletDecisionNavSource | 'none' | null) {
  if (source === 'nav_history') return '净值历史';
  if (source === 'candidate_latest_value') return '候选最新值';
  if (source === 'cash_like_unit_nav') return '现金类确认净值';
  if (source === 'manual') return '手动净值';
  return '还没拿到';
}

function formatPercent(value: number) {
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

function formatMaybePercent(value: number | null | undefined) {
  return typeof value === 'number' && Number.isFinite(value) ? formatPercent(value) : '-';
}

function formatPlainPercent(value: number | null | undefined) {
  return typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(2)}%` : '-';
}

function formatMaybeMoney(value: number | null | undefined) {
  return typeof value === 'number' && Number.isFinite(value) ? formatMoney(value) : '-';
}

function formatMaybeDateText(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed || '-';
}

function formatMaybeNumber(value: number | null | undefined, digits = 2) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '-';
}

function formatMaybeNav(value: number | null | undefined) {
  return typeof value === 'number' && Number.isFinite(value) ? formatNav(value) : '-';
}

function formatMaybeText(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed || '-';
}

function formatFundDataWarning(value: string | null | undefined) {
  const text = value?.trim();
  if (!text) return '';
  if (/HTTPSConnectionPool|SSLError|UNEXPECTED_EOF|Max retries|fund\.eastmoney|Read timed out|ConnectTimeout|ConnectionError/i.test(text)) {
    return '基金资料源这次连得不稳，白云先只做观察，不拿它当买入依据。';
  }
  if (/AKShare|No module named|小管家没连上/i.test(text)) {
    return 'AKShare 小管家这次没拿稳，白云先只做观察。';
  }
  return text.length > 90 ? `${text.slice(0, 90)}...` : text;
}

function formatDate(value: number) {
  return new Date(value).toLocaleString('zh-CN', {
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function formatEditorDate(value: number) {
  const date = new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

function parseEditorDate(value: string) {
  const match = value.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{1,2}))?$/);
  if (!match) return null;
  const [, year, month, day, hour = '0', minute = '0'] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
  if (Number.isNaN(date.getTime())) return null;
  return date.getTime();
}

function getRangeWindow(range: ExpenseRange, now = new Date()) {
  if (range === 'last30') {
    const endAt = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
    return {
      label: '近30天',
      startAt: endAt - 30 * 24 * 60 * 60 * 1000,
      endAt,
    };
  }

  const offset = range === 'lastMonth' ? -1 : 0;
  const start = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  const end = new Date(now.getFullYear(), now.getMonth() + offset + 1, 1);
  return {
    label: range === 'lastMonth' ? '上月' : '本月',
    startAt: start.getTime(),
    endAt: end.getTime(),
  };
}

function summarizeEntries(entries: ExpenseEntry[]) {
  const cents = entries.reduce((summary, entry) => {
    summary[entry.type] += Math.round(entry.amount * 100);
    return summary;
  }, { expense: 0, income: 0, refund: 0 });
  return { expense: cents.expense / 100, income: cents.income / 100,
    refund: cents.refund / 100, netExpense: (cents.expense - cents.refund) / 100 };
}

function buildCategoryTotals(entries: ExpenseEntry[], type: ExpenseEntryType): CategoryTotal[] {
  const totals = new Map<string, number>();
  entries
    .filter((entry) => entry.type === type)
    .forEach((entry) => totals.set(entry.category, (totals.get(entry.category) ?? 0) + entry.amount));

  const totalAmount = Array.from(totals.values()).reduce((sum, amount) => sum + amount, 0);
  if (!totalAmount) return [];

  return Array.from(totals.entries())
    .sort(([, left], [, right]) => right - left)
    .map(([category, amount], index) => ({
      amount,
      category,
      color: categoryColors[index % categoryColors.length],
      percent: amount / totalAmount,
    }));
}

function polarToCartesian(center: number, radius: number, angleInDegrees: number) {
  const angleInRadians = ((angleInDegrees - 90) * Math.PI) / 180;
  return {
    x: center + radius * Math.cos(angleInRadians),
    y: center + radius * Math.sin(angleInRadians),
  };
}

function describeDonutSegment(center: number, outerRadius: number, innerRadius: number, startAngle: number, endAngle: number) {
  const outerStart = polarToCartesian(center, outerRadius, endAngle);
  const outerEnd = polarToCartesian(center, outerRadius, startAngle);
  const innerStart = polarToCartesian(center, innerRadius, startAngle);
  const innerEnd = polarToCartesian(center, innerRadius, endAngle);
  const largeArcFlag = endAngle - startAngle <= 180 ? '0' : '1';

  return [
    `M ${outerStart.x} ${outerStart.y}`,
    `A ${outerRadius} ${outerRadius} 0 ${largeArcFlag} 0 ${outerEnd.x} ${outerEnd.y}`,
    `L ${innerStart.x} ${innerStart.y}`,
    `A ${innerRadius} ${innerRadius} 0 ${largeArcFlag} 1 ${innerEnd.x} ${innerEnd.y}`,
    'Z',
  ].join(' ');
}

function DonutChart({ data }: { data: CategoryTotal[] }) {
  const size = 132;
  const center = size / 2;
  const outerRadius = 58;
  const innerRadius = 40;
  let startAngle = 0;

  if (!data.length) {
    return (
      <View style={styles.emptyChart}>
        <View style={styles.emptyRing} />
        <Text style={styles.emptyChartText}>还没有数据</Text>
      </View>
    );
  }

  return (
    <Svg height={size} width={size}>
      {data.map((item) => {
        const sweep = Math.max(0.5, item.percent * 360);
        const endAngle = Math.min(359.99, startAngle + sweep);
        const path = describeDonutSegment(center, outerRadius, innerRadius, startAngle, endAngle);
        startAngle = endAngle;
        return (
          <Path
            key={item.category}
            d={path}
            fill={item.color}
          />
        );
      })}
    </Svg>
  );
}

function getDecisionActionLabel(action: WalletDecisionAction) {
  const labels: Record<WalletDecisionAction, string> = {
    buy: '买入',
    observe: '观察',
    hold: '继续看',
    pause: '暂停',
  };
  return labels[action];
}

function getDecisionStatusLabel(status: WalletDecisionStatus) {
  const labels: Record<WalletDecisionStatus, string> = {
    approved: '已同意',
    blocked: '已拦住',
    deferred: '以后再说',
    executed: '已记录',
    expired: '已过期',
    proposed: '等小仓鼠决定',
    rejected: '已拒绝',
  };
  return labels[status];
}

function getWalletHealthStatusLabel(status: WalletHealthStatus) {
  const labels: Record<WalletHealthStatus, string> = {
    blocked: '要先停一下',
    ok: '已就绪',
    warning: '要留意',
  };
  return labels[status];
}

function getFundPoolStatusLabel(status: FundCandidate['poolAssessment']['status']) {
  const labels: Record<FundCandidate['poolAssessment']['status'], string> = {
    blocked: '已拦住',
    eligible: '可考虑',
    observe_only: '只观察',
  };
  return labels[status];
}

function getAutoPickCandidateLabel(candidate: WalletFundSelectionTrace['poolSummaries'][number]['topCandidate']) {
  if (!candidate) return '';
  if (candidate.canBuy) return `能买一点，上限 ${formatMoney(candidate.suggestedMaxAmount)}`;
  return '这次只能观察';
}

function getAutoPickRowBadge(trace: WalletFundSelectionTrace, summary: WalletFundSelectionTrace['poolSummaries'][number]) {
  if (!summary.topCandidate) return '跳过';
  if (summary.topCandidate.code === trace.selectedCode) return '最后选中';
  return summary.topCandidate.canBuy ? '也能买' : '只观察';
}

function getAutoPickSummary(trace: WalletFundSelectionTrace) {
  const selected = trace.poolSummaries
    .map((summary) => summary.topCandidate)
    .find((candidate) => candidate?.code === trace.selectedCode);
  const preferenceNote = trace.preferenceNote ? `${trace.preferenceNote} ` : '';
  if (!selected) return `${preferenceNote}这次还没挑出能写进小卡片的基金。`;
  if (selected.canBuy) return `${preferenceNote}白云最后选它：不是只看规则分，而是因为这次能安全买一点。`;
  return `${preferenceNote}白云最后只放观察卡：这只还没过买入刹车。`;
}

function getThoughtSignalLabel(signal: FundThoughtSignalType) {
  const labels: Record<FundThoughtSignalType, string> = {
    bearish: '偏谨慎',
    blocked: '已刹车',
    bullish: '偏积极',
    neutral: '中性',
  };
  return labels[signal];
}

function formatAllowedActions(actions: WalletRiskAssessment['allowedActions']) {
  const labels: Record<WalletRiskAssessment['allowedActions'][number], string> = {
    buy: '买入',
    hold: '保持',
    observe: '观察',
    pause: '暂停',
  };
  return actions.map((action) => labels[action]).join(' / ');
}

function formatSourceTypeLabel(sourceType: FundSourceType | undefined) {
  const labels: Record<FundSourceType, string> = {
    etf: 'ETF',
    index_fund: '指数基金',
    money_fund: '货币基金',
    open_fund: '开放式基金',
    unknown: '类型未知',
  };
  return sourceType ? labels[sourceType] : '类型未知';
}

function hasProfileDetail(profile: FundProfile | null) {
  return Boolean(
    profile && (
      profile.manager ||
      profile.company ||
      profile.inceptionDate ||
      profile.latestScale ||
      profile.ratingInfo ||
      profile.managerInfo ||
      profile.companyInfo ||
      profile.feeInfo ||
      profile.scaleInfo
    ),
  );
}

function formatFeeTableStatus(items: Array<Record<string, unknown>> | undefined) {
  return items?.length ? `${items.length}项` : '暂缺';
}

function valueFromCandidateExtra(candidate: FundCandidate, key: string) {
  const value = candidate.extra[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function textFromCandidateExtra(candidate: FundCandidate, key: string) {
  const value = candidate.extra[key];
  return typeof value === 'string' ? value : '';
}

function watchlistReturn(candidate: FundCandidate, key: keyof Pick<FundCandidate['performance'], 'return1m' | 'return3m' | 'return1y'>) {
  return candidate.performance[key] ?? candidate[key] ?? null;
}

function watchlistMinPurchase(candidate: FundCandidate, profile?: FundProfile | null) {
  return profile?.minPurchaseAmount ?? valueFromCandidateExtra(candidate, 'minPurchaseAmount');
}

function watchlistLatestValue(candidate: FundCandidate, profile?: FundProfile | null) {
  return profile?.latestValue ?? candidate.latestValue;
}

function watchlistFeeRate(candidate: FundCandidate, profile?: FundProfile | null) {
  return profile?.feeRate ?? candidate.feeRate;
}

function watchlistPurchaseStatus(candidate: FundCandidate, profile?: FundProfile | null) {
  return profile?.purchaseStatus || candidate.purchaseStatus || '暂缺';
}

function watchlistManager(candidate: FundCandidate, profile?: FundProfile | null) {
  return profile?.manager ?? textFromCandidateExtra(candidate, 'manager');
}

function watchlistCompany(candidate: FundCandidate, profile?: FundProfile | null) {
  return profile?.company ?? textFromCandidateExtra(candidate, 'company');
}

function watchlistProfileCompleteness(candidate: FundCandidate, profile?: FundProfile | null) {
  const fields = [
    Boolean(watchlistPurchaseStatus(candidate, profile) && watchlistPurchaseStatus(candidate, profile) !== '暂缺'),
    watchlistMinPurchase(candidate, profile) !== null,
    watchlistFeeRate(candidate, profile) !== null,
    watchlistLatestValue(candidate, profile) !== null,
    Boolean(watchlistManager(candidate, profile)),
    Boolean(watchlistCompany(candidate, profile)),
    Boolean(profile?.inceptionDate ?? textFromCandidateExtra(candidate, 'inceptionDate')),
    Boolean(profile?.ratingInfo || profile?.rating || profile?.scaleInfo || profile?.latestScale),
  ];
  const filled = fields.filter(Boolean).length;
  return `${filled}/${fields.length}`;
}

function watchlistRatingOrScale(profile?: FundProfile | null) {
  if (profile?.ratingInfo?.ratingSummary) return profile.ratingInfo.ratingSummary;
  if (profile?.rating) return profile.rating;
  return formatMaybeMoney(profile?.latestScale);
}

function watchlistDetailMessage(candidate: FundCandidate, profile?: FundProfile | null) {
  if (!profile) return '完整资料暂缺，先显示候选池里已经拿到的字段。';
  if (!hasProfileDetail(profile)) return '完整资料拿到一部分，增强资料暂缺。';
  return '完整资料已补进来。';
}

function buildWatchlistComparisonRows(items: WalletWatchlistItem[], profiles: Record<string, FundProfile | null>) {
  return [
    { label: '规则分', values: items.map((item) => ({ code: item.candidate.code, value: formatMaybeNumber(item.displayScore, 1) })) },
    { label: '池子状态', values: items.map((item) => ({ code: item.candidate.code, value: getFundPoolStatusLabel(item.candidate.poolAssessment.status) })) },
    { label: '近1月', values: items.map((item) => ({ code: item.candidate.code, value: formatMaybePercent(watchlistReturn(item.candidate, 'return1m')) })) },
    { label: '近3月', values: items.map((item) => ({ code: item.candidate.code, value: formatMaybePercent(watchlistReturn(item.candidate, 'return3m')) })) },
    { label: '近1年', values: items.map((item) => ({ code: item.candidate.code, value: formatMaybePercent(watchlistReturn(item.candidate, 'return1y')) })) },
    { label: '最大回撤', values: items.map((item) => ({ code: item.candidate.code, value: formatMaybePercent(item.candidate.performance.maxDrawdown1y) })) },
    { label: '波动率', values: items.map((item) => ({ code: item.candidate.code, value: formatPlainPercent(item.candidate.performance.volatility1y) })) },
    { label: '手续费', values: items.map((item) => ({ code: item.candidate.code, value: formatPlainPercent(watchlistFeeRate(item.candidate, profiles[item.candidate.code])) })) },
    { label: '申购状态', values: items.map((item) => ({ code: item.candidate.code, value: watchlistPurchaseStatus(item.candidate, profiles[item.candidate.code]) })) },
    { label: '起购金额', values: items.map((item) => ({ code: item.candidate.code, value: formatMaybeMoney(watchlistMinPurchase(item.candidate, profiles[item.candidate.code])) })) },
    { label: '风险标签', values: items.map((item) => ({ code: item.candidate.code, value: `${item.riskLabels.length} 个` })) },
    { label: '资料完整度', values: items.map((item) => ({ code: item.candidate.code, value: watchlistProfileCompleteness(item.candidate, profiles[item.candidate.code]) })) },
  ];
}

export function ExpenseScreen({ navigate }: { navigate: Navigate }) {
  const insets = useSafeAreaInsets();
  const { financeReasoningConnection, financeReasoningKey } = useAiConfigPreferences();
  const financeReasoningReady = Boolean(financeReasoningConnection && financeReasoningKey.trim());
  const [entries, setEntries] = useState<ExpenseEntry[]>([]);
  const [refundOriginalStates, setRefundOriginalStates] = useState<Record<string, string>>({});
  const [range, setRange] = useState<ExpenseRange>('month');
  const [chartType, setChartType] = useState<ExpenseEntryType>('expense');
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState('饮食');
  const [note, setNote] = useState('');
  const [occurredAtText, setOccurredAtText] = useState(formatEditorDate(Date.now()));
  const [type, setType] = useState<ExpenseEntryType>('expense');
  const [editingEntry, setEditingEntry] = useState<ExpenseEntry | null>(null);
  const [activeExpenseTab, setActiveExpenseTab] = useState<ExpenseTab>('ledger');
  const [wallet, setWallet] = useState<AiWallet | null>(null);
  const [walletPreferences, setWalletPreferences] = useState<WalletPreferenceConfig | null>(null);
  const [walletPreferenceFormOpen, setWalletPreferenceFormOpen] = useState(false);
  const [walletPreferenceForm, setWalletPreferenceForm] = useState<WalletPreferenceForm>(() => createWalletPreferenceForm(null, null));
  const [walletPreferenceMessage, setWalletPreferenceMessage] = useState('');
  const [walletDecisions, setWalletDecisions] = useState<WalletDecision[]>([]);
  const [walletHoldings, setWalletHoldings] = useState<WalletHolding[]>([]);
  const [walletTransactions, setWalletTransactions] = useState<WalletTransaction[]>([]);
  const [walletSnapshots, setWalletSnapshots] = useState<WalletSnapshot[]>([]);
  const [walletLoading, setWalletLoading] = useState(false);
  const [walletError, setWalletError] = useState('');
  const [walletReview, setWalletReview] = useState<WalletValuationReview | null>(null);
  const [walletWatchlist, setWalletWatchlist] = useState<WalletWatchlistResult | null>(null);
  const [expandedWatchlistGroups, setExpandedWatchlistGroups] = useState<FundPoolCategory[]>([]);
  const [expandedWatchlistItemCodes, setExpandedWatchlistItemCodes] = useState<string[]>([]);
  const [watchlistCompareCodes, setWatchlistCompareCodes] = useState<string[]>([]);
  const [watchlistProfileByCode, setWatchlistProfileByCode] = useState<Record<string, FundProfile | null>>({});
  const [watchlistProfileLoadingCode, setWatchlistProfileLoadingCode] = useState<string | null>(null);
  const [watchlistProfileMessages, setWatchlistProfileMessages] = useState<Record<string, string>>({});
  const [walletDecisionReviews, setWalletDecisionReviews] = useState<WalletDecisionReview[]>([]);
  const [walletDecisionNavInputs, setWalletDecisionNavInputs] = useState<Record<string, string>>({});
  const [walletDecisionNavMeta, setWalletDecisionNavMeta] = useState<Record<string, WalletDecisionNavMeta>>({});
  const [walletDecisionNavLoadingId, setWalletDecisionNavLoadingId] = useState<string | null>(null);
  const [fundSearchQuery, setFundSearchQuery] = useState('');
  const [fundSearchResults, setFundSearchResults] = useState<FundSearchItem[]>([]);
  const [fundSearchCandidate, setFundSearchCandidate] = useState<FundCandidate | null>(null);
  const [fundSearchProfile, setFundSearchProfile] = useState<FundProfile | null>(null);
  const [fundSearchLoading, setFundSearchLoading] = useState(false);
  const [fundProfileLoading, setFundProfileLoading] = useState(false);
  const [fundSearchMessage, setFundSearchMessage] = useState('');
  const [fundProfileMessage, setFundProfileMessage] = useState('');
  const [walletAutoPickTrace, setWalletAutoPickTrace] = useState<WalletFundSelectionTrace | null>(null);
  const [walletDecisionMessage, setWalletDecisionMessage] = useState('');
  const [walletFocusDecisionId, setWalletFocusDecisionId] = useState<string | null>(null);
  const [expandedWalletDecisionIds, setExpandedWalletDecisionIds] = useState<string[]>([]);
  const [walletDecisionThoughtContexts, setWalletDecisionThoughtContexts] = useState<Record<string, WalletDecisionThoughtContext>>({});
  const [walletDecisionThoughtLoadingId, setWalletDecisionThoughtLoadingId] = useState<string | null>(null);
  const [walletDecisionThoughtMessages, setWalletDecisionThoughtMessages] = useState<Record<string, string>>({});
  const [manualHoldingFormOpen, setManualHoldingFormOpen] = useState(false);
  const [manualHoldingForm, setManualHoldingForm] = useState<WalletManualHoldingForm>(() => createEmptyManualHoldingForm());
  const [manualHoldingMessage, setManualHoldingMessage] = useState('');
  const [walletObservationLoading, setWalletObservationLoading] = useState(false);
  const [walletObservationMessage, setWalletObservationMessage] = useState('');
  const [lastWalletAutoRefreshAt, setLastWalletAutoRefreshAt] = useState<number | null>(null);

  const rangeWindow = useMemo(() => getRangeWindow(range), [range]);
  const summary = useMemo(() => summarizeEntries(entries), [entries]);
  const categoryTotals = useMemo(() => buildCategoryTotals(entries, chartType), [entries, chartType]);
  const categoryChoices = type === 'income' ? incomeCategories : expenseCategories;
  const chartTotal = categoryTotals.reduce((sum, item) => sum + item.amount, 0);
  const pendingWalletDecisions = walletDecisions.filter((decision) => decision.status === 'proposed');
  const walletHistory = walletDecisions.filter((decision) => decision.status !== 'proposed');
  const visibleWalletHistory = walletHistory.slice(0, WALLET_HISTORY_PREVIEW_LIMIT);
  const hiddenWalletHistoryCount = Math.max(0, walletHistory.length - visibleWalletHistory.length);
  const walletMarketValue = walletHoldings.reduce((sum, holding) => sum + holding.marketValue, 0);
  const walletFloatingProfit = walletHoldings.reduce((sum, holding) => sum + holding.floatingProfit, 0);
  const walletFloatingProfitPct = wallet?.investedAmount ? (walletFloatingProfit / wallet.investedAmount) * 100 : 0;
  const latestWalletSnapshot = walletSnapshots[0];
  const walletLearningSummary = useMemo(
    () => buildWalletLearningSummary(walletDecisionReviews, walletDecisions),
    [walletDecisionReviews, walletDecisions],
  );
  const walletHealthReport = useMemo(
    () => buildWalletHealthReport({
      decisions: walletDecisions,
      holdings: walletHoldings,
      reviews: walletDecisionReviews,
      snapshots: walletSnapshots,
      transactions: walletTransactions,
      wallet,
    }),
    [wallet, walletDecisions, walletHoldings, walletTransactions, walletSnapshots, walletDecisionReviews],
  );
  const walletObservationReport = useMemo(
    () => buildWalletObservationReminderReport({
      decisions: walletDecisions,
      decisionReviews: walletDecisionReviews,
      holdings: walletHoldings,
      lastAutoRefreshAt: lastWalletAutoRefreshAt,
      snapshots: walletSnapshots,
      wallet,
      watchlist: walletWatchlist,
    }),
    [wallet, walletDecisions, walletDecisionReviews, walletHoldings, walletSnapshots, walletWatchlist, lastWalletAutoRefreshAt],
  );

  const watchlistItemsByCode = useMemo(() => {
    const next = new Map<string, WalletWatchlistItem>();
    walletWatchlist?.groups.forEach((group) => {
      group.items.forEach((item) => {
        if (!next.has(item.candidate.code)) next.set(item.candidate.code, item);
      });
    });
    return next;
  }, [walletWatchlist]);
  const watchlistCompareItems = useMemo(
    () => watchlistCompareCodes
      .map((code) => watchlistItemsByCode.get(code))
      .filter((item): item is WalletWatchlistItem => Boolean(item)),
    [watchlistCompareCodes, watchlistItemsByCode],
  );
  const watchlistComparisonRows = useMemo(
    () => buildWatchlistComparisonRows(watchlistCompareItems, watchlistProfileByCode),
    [watchlistCompareItems, watchlistProfileByCode],
  );

  const refresh = async (
    dataEpoch = captureBackupRestoreDataEpoch(),
  ) => {
    const loaded = await runBackupRestoreDataEpochCommit(
      dataEpoch,
      async () => {
        const entries = await loadExpenseEntriesBetween(rangeWindow.startAt, rangeWindow.endAt);
        const states = await Promise.all(entries.filter((entry) => entry.type === 'refund')
          .map(async (entry) => [entry.id, await loadExpenseRefundOriginalState(entry)] as const));
        return { entries, states: Object.fromEntries(states) };
      },
    );
    if (!loaded.committed || !canCommitBackupRestoreDataEpoch(dataEpoch)) return null;
    setEntries(loaded.value.entries);
    setRefundOriginalStates(loaded.value.states);
    return true;
  };

  const refreshWalletState = async (
    dataEpoch = captureBackupRestoreDataEpoch(),
  ) => {
    setWalletLoading(true);
    try {
      const loaded = await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
        const nextWallet = await loadOrCreateDefaultWallet({ initialBudget: 100 });
        const [
          nextDecisions,
          nextHoldings,
          nextTransactions,
          nextSnapshots,
          nextDecisionReviews,
          nextPreferences,
        ] = await Promise.all([
          loadWalletDecisions(nextWallet.id),
          loadWalletHoldings(nextWallet.id),
          loadWalletTransactions(nextWallet.id),
          loadWalletSnapshots(nextWallet.id),
          loadWalletDecisionReviews(nextWallet.id),
          loadOrCreateWalletPreferences(nextWallet.id),
        ]);
        return {
          nextDecisionReviews,
          nextDecisions,
          nextHoldings,
          nextPreferences,
          nextSnapshots,
          nextTransactions,
          nextWallet,
        };
      });
      if (!loaded.committed || !canCommitBackupRestoreDataEpoch(dataEpoch)) return null;
      const {
        nextDecisionReviews,
        nextDecisions,
        nextHoldings,
        nextPreferences,
        nextSnapshots,
        nextTransactions,
        nextWallet,
      } = loaded.value;
      setWalletError('');
      setWallet(nextWallet);
      setWalletPreferences(nextPreferences);
      if (!walletPreferenceFormOpen) {
        setWalletPreferenceForm(createWalletPreferenceForm(nextWallet, nextPreferences));
      }
      setWalletDecisions(nextDecisions);
      setWalletHoldings(nextHoldings);
      setWalletTransactions(nextTransactions);
      setWalletSnapshots(nextSnapshots);
      setWalletDecisionReviews(nextDecisionReviews);
      return true;
    } catch {
      if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return null;
      setWalletError('小金库账本刚刚没翻开，白云小姐等会儿再试一次><');
      return false;
    } finally {
      setWalletLoading(false);
    }
  };

  const refreshWalletValuationState = async () => {
    const dataEpoch = captureBackupRestoreDataEpoch();
    setWalletLoading(true);
    try {
      const initial = await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
        const currentWallet = wallet ?? await loadOrCreateDefaultWallet({ initialBudget: 100 });
        const currentHoldings = walletHoldings.length ? walletHoldings : await loadWalletHoldings(currentWallet.id);
        return { currentHoldings, currentWallet };
      });
      if (!initial.committed || !canCommitBackupRestoreDataEpoch(dataEpoch)) return null;
      setWalletError('');
      const { currentHoldings, currentWallet } = initial.value;
      const result = await refreshWalletValuations({ dataEpoch, holdings: currentHoldings, wallet: currentWallet });
      if (!result.committed || !canCommitBackupRestoreDataEpoch(dataEpoch)) return null;
      const refreshed = await refreshWalletState(dataEpoch);
      if (refreshed !== true) return refreshed;
      if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return null;
      setWalletReview(result.review);
      if (!result.ok && currentHoldings.length) {
        setWalletError('今天数据没拿稳，白云小姐先保留旧估值><');
      }
      return true;
    } catch {
      if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return null;
      setWalletError('今天数据没拿稳，白云小姐先保留旧估值><');
      return false;
    } finally {
      setWalletLoading(false);
    }
  };

  const refreshWalletWatchlistState = async () => {
    setWalletLoading(true);
    setWalletError('');
    try {
      const result = await refreshWalletWatchlist();
      setWalletWatchlist(result);
      if (!result.ok) {
        setWalletError(walletWatchlistCopy.error);
      }
    } catch {
      setWalletWatchlist({
        groups: [],
        ok: false,
        stale: false,
        updatedAt: Date.now(),
        warnings: [walletWatchlistCopy.error],
      });
      setWalletError(walletWatchlistCopy.error);
    } finally {
      setWalletLoading(false);
    }
  };


  const toggleWatchlistGroup = (groupId: FundPoolCategory) => {
    setExpandedWatchlistGroups((previous) => toggleArrayValue(previous, groupId));
  };

  const loadWatchlistProfile = async (candidate: FundCandidate) => {
    if (Object.prototype.hasOwnProperty.call(watchlistProfileByCode, candidate.code)) return;
    setWatchlistProfileLoadingCode(candidate.code);
    setWatchlistProfileMessages((previous) => ({ ...previous, [candidate.code]: '' }));
    try {
      const response = await fetchFundProfile(candidate.code);
      if (response.ok && response.data) {
        setWatchlistProfileByCode((previous) => ({ ...previous, [candidate.code]: response.data }));
        setWatchlistProfileMessages((previous) => ({
          ...previous,
          [candidate.code]: response.stale ? '完整资料有点旧，只做观察参考。' : '完整资料已补上。',
        }));
        return;
      }
      setWatchlistProfileByCode((previous) => ({ ...previous, [candidate.code]: null }));
      setWatchlistProfileMessages((previous) => ({
        ...previous,
        [candidate.code]: response.warnings[0] ? formatFundDataWarning(response.warnings[0]) : '完整资料暂缺。',
      }));
    } catch {
      setWatchlistProfileByCode((previous) => ({ ...previous, [candidate.code]: null }));
      setWatchlistProfileMessages((previous) => ({ ...previous, [candidate.code]: '完整资料暂缺。' }));
    } finally {
      setWatchlistProfileLoadingCode((current) => (current === candidate.code ? null : current));
    }
  };

  const toggleWatchlistItemDetail = (candidate: FundCandidate) => {
    const expanded = expandedWatchlistItemCodes.includes(candidate.code);
    setExpandedWatchlistItemCodes((previous) => toggleArrayValue(previous, candidate.code));
    if (!expanded) {
      void loadWatchlistProfile(candidate);
    }
  };

  const toggleWatchlistCompare = (candidate: FundCandidate) => {
    setWatchlistCompareCodes((previous) => {
      if (previous.includes(candidate.code)) return previous.filter((code) => code !== candidate.code);
      if (previous.length >= 3) {
        Alert.alert('对比池满啦', '最多先放 3 只基金一起比较。');
        return previous;
      }
      void loadWatchlistProfile(candidate);
      return [...previous, candidate.code];
    });
  };

  const clearWatchlistCompare = () => {
    setWatchlistCompareCodes([]);
  };

  const openWalletPreferenceForm = () => {
    setWalletPreferenceForm(createWalletPreferenceForm(wallet, walletPreferences));
    setWalletPreferenceMessage('');
    setWalletPreferenceFormOpen(true);
  };

  const closeWalletPreferenceForm = () => {
    setWalletPreferenceForm(createWalletPreferenceForm(wallet, walletPreferences));
    setWalletPreferenceMessage('');
    setWalletPreferenceFormOpen(false);
  };

  const updateWalletPreferenceForm = <K extends keyof WalletPreferenceForm>(key: K, value: WalletPreferenceForm[K]) => {
    setWalletPreferenceForm((previous) => ({ ...previous, [key]: value }));
    setWalletPreferenceMessage('');
  };

  const toggleWalletPreferredPool = (value: WalletPreferredPool) => {
    setWalletPreferenceForm((previous) => ({
      ...previous,
      preferredPools: toggleArrayValue(previous.preferredPools, value),
    }));
    setWalletPreferenceMessage('');
  };

  const toggleWalletAvoidType = (value: WalletAvoidType) => {
    setWalletPreferenceForm((previous) => ({
      ...previous,
      avoidTypes: toggleArrayValue(previous.avoidTypes, value),
    }));
    setWalletPreferenceMessage('');
  };

  const saveWalletPreferencePlan = async () => {
    const budget = parsePositiveInput(walletPreferenceForm.budget);
    const comfortSingleAmount = parsePositiveInput(walletPreferenceForm.comfortSingleAmount);
    if (!budget) {
      Alert.alert('预算还没写好', '总预算要填一个大于 0 的数字。');
      return;
    }
    const dataEpoch = captureBackupRestoreDataEpoch();
    setWalletLoading(true);
    setWalletPreferenceMessage('');
    try {
      const initial = await runBackupRestoreDataEpochCommit(
        dataEpoch,
        () => loadOrCreateDefaultWallet({ initialBudget: 100 }),
      );
      if (!initial.committed || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      const currentWallet = initial.value;
      if (budget + 0.0001 < currentWallet.investedAmount) {
        const message = `总预算不能低于已经投入的 ${formatMoney(currentWallet.investedAmount)}。`;
        setWalletPreferenceMessage(message);
        Alert.alert('预算太小啦', message);
        return;
      }
      const saved = await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
        if (Math.abs(budget - currentWallet.totalBudget) >= 0.005) {
          await updateWalletBudget(currentWallet.id, budget);
        }
        if (walletPreferenceForm.riskProfile !== currentWallet.riskProfile) {
          await updateWalletRiskProfile(currentWallet.id, walletPreferenceForm.riskProfile);
        }
        return saveWalletPreferences(currentWallet.id, {
          avoidTypes: walletPreferenceForm.avoidTypes,
          comfortSingleAmount,
          enabled: walletPreferenceForm.enabled,
          preferredPools: walletPreferenceForm.preferredPools,
          tendency: walletPreferenceForm.tendency.trim(),
        });
      });
      if (!saved.committed || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      const refreshed = await refreshWalletState(dataEpoch);
      if (refreshed !== true || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      setWalletPreferenceMessage('小钱钱计划收好啦。');
      setWalletPreferenceFormOpen(false);
    } catch (error) {
      if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      const message = error instanceof Error && error.message === 'wallet-budget-below-invested'
        ? '总预算不能低于已经投入的小钱钱。'
        : '小钱钱计划刚刚没收稳，等一下再试试。';
      setWalletPreferenceMessage(message);
      Alert.alert('先暂停一下', message);
    } finally {
      setWalletLoading(false);
    }
  };

  const updateManualHoldingForm = (key: keyof WalletManualHoldingForm, value: string) => {
    setManualHoldingForm((previous) => ({ ...previous, [key]: value }));
    setManualHoldingMessage('');
  };

  const openManualHoldingForm = () => {
    const latestNav = fundSearchProfile?.latestValue ?? fundSearchCandidate?.latestValue ?? null;
    setManualHoldingForm({
      avgCostNav: '',
      fundCode: fundSearchCandidate?.code ?? '',
      fundName: fundSearchProfile?.name ?? fundSearchCandidate?.name ?? '',
      fundType: fundSearchProfile?.type || fundSearchCandidate?.type || '',
      latestNav: typeof latestNav === 'number' && Number.isFinite(latestNav) && latestNav > 0 ? formatNav(latestNav) : '',
      shares: '',
      totalCost: '',
      warnDownPct: '-3',
      warnUpPct: '15',
    });
    setManualHoldingMessage(fundSearchCandidate ? '已带入刚刚选中的基金资料。' : '可以把外部平台已经买过的基金搬进小金库。');
    setManualHoldingFormOpen(true);
  };

  const closeManualHoldingForm = () => {
    setManualHoldingFormOpen(false);
    setManualHoldingMessage('');
    setManualHoldingForm(createEmptyManualHoldingForm());
  };

  const saveManualHolding = async () => {
    const fundCode = manualHoldingForm.fundCode.trim();
    const fundName = manualHoldingForm.fundName.trim();
    const shares = parsePositiveInput(manualHoldingForm.shares);
    const avgCostNav = parsePositiveInput(manualHoldingForm.avgCostNav);
    const totalCost = parsePositiveInput(manualHoldingForm.totalCost);
    const latestNav = parsePositiveInput(manualHoldingForm.latestNav);
    const warnDownPct = parseOptionalSignedInput(manualHoldingForm.warnDownPct);
    const warnUpPct = parseOptionalSignedInput(manualHoldingForm.warnUpPct);
    if (!fundCode || !fundName) {
      Alert.alert('资料还不够', '基金代码和基金名称都要填一下。');
      return;
    }
    if (!latestNav) {
      Alert.alert('净值还不对', '最新净值需要填一个大于 0 的数字。');
      return;
    }
    const knownCostPieces = [shares, avgCostNav, totalCost].filter((value) => typeof value === 'number').length;
    if (knownCostPieces < 2) {
      Alert.alert('成本还算不出来', '份额、平均成本净值、总成本里至少填两个，白云小姐才能帮你补第三个。');
      return;
    }
    const dataEpoch = captureBackupRestoreDataEpoch();
    setWalletLoading(true);
    try {
      const imported = await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
        const currentWallet = await loadOrCreateDefaultWallet({ initialBudget: 100 });
        return importManualWalletHolding({
          avgCostNav,
          fundCode,
          fundName,
          fundType: manualHoldingForm.fundType.trim() || '基金',
          latestNav,
          shares,
          totalCost,
          walletId: currentWallet.id,
          warnDownPct,
          warnUpPct,
        });
      });
      if (!imported.committed || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      const refreshed = await refreshWalletState(dataEpoch);
      if (refreshed !== true || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      setManualHoldingMessage('已经记进小金库啦。');
      setManualHoldingFormOpen(false);
      setManualHoldingForm(createEmptyManualHoldingForm());
    } catch (error) {
      if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      const message = error instanceof Error && error.message === 'wallet-cash-not-enough'
        ? '这笔超过小金库剩余现金啦，可以先调高预算，或者录入更小金额。'
        : '这笔持仓刚刚没记稳，先检查一下数字再试试。';
      setManualHoldingMessage(message);
      Alert.alert('先暂停一下', message);
    } finally {
      setWalletLoading(false);
    }
  };

  const refreshWalletDecisionReviewState = async () => {
    const dataEpoch = captureBackupRestoreDataEpoch();
    setWalletLoading(true);
    try {
      const initial = await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
        const currentWallet = await loadOrCreateDefaultWallet({ initialBudget: 100 });
        return { currentWallet };
      });
      if (!initial.committed || !canCommitBackupRestoreDataEpoch(dataEpoch)) return null;
      setWalletError('');
      const { currentWallet } = initial.value;
      const result = await refreshWalletDecisionReviews(currentWallet.id, { dataEpoch });
      if (!result.committed || !canCommitBackupRestoreDataEpoch(dataEpoch)) return null;
      const refreshed = await refreshWalletState(dataEpoch);
      if (refreshed !== true) return refreshed;
      if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return null;
      setWalletDecisionReviews(result.reviews);
      if (!result.ok && result.warnings.length) {
        setWalletError(result.warnings[0]);
      }
      return true;
    } catch {
      if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return null;
      setWalletError('复盘数据没拿稳，白云小姐先不乱算收益><');
      return false;
    } finally {
      setWalletLoading(false);
    }
  };

  const runWalletObservationCheck = async (automatic = false) => {
    if (walletObservationLoading) return;
    if (automatic && !walletObservationReport.shouldAutoRefresh) return;
    setWalletObservationLoading(true);
    setWalletObservationMessage('');
    const warnings: string[] = [];
    let refreshedCount = 0;
    try {
      if (!walletObservationReport.isLegalWorkday) {
        setWalletObservationMessage('\u4eca\u5929\u4e0d\u662f\u9002\u5408\u770b\u57fa\u91d1\u7684\u4ea4\u6613\u65e5\uff0c\u767d\u4e91\u5c0f\u59d0\u53ea\u770b\u72b6\u6001\u5c31\u597d\u3002');
        return;
      }
      const actions = walletObservationReport.items.map((item) => item.action);
      const attemptedRefresh = actions.some((action) => action === 'refresh_watchlist' || action === 'refresh_valuation' || action === 'refresh_reviews');
      if (actions.includes('refresh_watchlist')) {
        try {
          await refreshWalletWatchlistState();
          refreshedCount += 1;
        } catch {
          warnings.push('\u89c2\u5bdf\u6c60\u8fd8\u6ca1\u5237\u65b0\u7a33\u3002');
        }
      }
      if (actions.includes('refresh_valuation')) {
        try {
          const valuationRefreshed = await refreshWalletValuationState();
          if (valuationRefreshed === null) return;
          if (valuationRefreshed) {
            refreshedCount += 1;
          }
        } catch {
          warnings.push('\u6301\u4ed3\u4f30\u503c\u8fd8\u6ca1\u5237\u65b0\u7a33\u3002');
        }
      }
      if (actions.includes('refresh_reviews')) {
        try {
          const reviewsRefreshed = await refreshWalletDecisionReviewState();
          if (reviewsRefreshed === null) return;
          if (reviewsRefreshed) {
            refreshedCount += 1;
          }
        } catch {
          warnings.push('\u51b3\u5b9a\u590d\u76d8\u8fd8\u6ca1\u5237\u65b0\u7a33\u3002');
        }
      }
      const message = refreshedCount
        ? "\u767d\u4e91\u5c0f\u59d0\u8f7b\u8f7b\u770b\u8fc7 " + refreshedCount + " \u9879\u5566\u3002" + (warnings.length ? "\u6709\u4e00\u70b9\u6570\u636e\u6ca1\u62ff\u7a33\u3002" : "")
        : "\u767d\u4e91\u5c0f\u59d0\u770b\u4e86\u4e00\u773c\uff0c\u4eca\u5929\u6682\u65f6\u6ca1\u6709\u5fc5\u987b\u5237\u65b0\u7684\u9879\u76ee\u3002";
      setWalletObservationMessage(message);
      if (attemptedRefresh) {
        setLastWalletAutoRefreshAt(Date.now());
      }
      if (refreshedCount > 0 && !automatic) {
        queueWalletPageNotice('\u767d\u4e91\u5c0f\u59d0\u521a\u521a\u8f7b\u8f7b\u770b\u4e86\u4e00\u773c\u5c0f\u91d1\u5e93\uff0c\u9875\u9762\u91cc\u5df2\u7ecf\u66f4\u65b0\u5566\u3002');
      }
    } finally {
      setWalletObservationLoading(false);
    }
  };

  const loadFundSearchProfile = async (code: string) => {
    setFundProfileLoading(true);
    setFundProfileMessage('');
    setFundSearchProfile(null);
    try {
      const response = await fetchFundProfile(code);
      if (response.ok && response.data) {
        setFundSearchProfile(response.data);
        setFundProfileMessage(response.stale ? '完整资料有点旧，只做观察参考。' : '完整资料也拿到啦。');
        return response.data;
      }
      setFundProfileMessage(response.warnings[0] ?? '基础候选已拿到，完整资料还没拿全。');
      return null;
    } catch {
      setFundProfileMessage('基础候选已拿到，完整资料还没拿全。');
      return null;
    } finally {
      setFundProfileLoading(false);
    }
  };

  const searchWalletFunds = async () => {
    const query = fundSearchQuery.trim();
    if (!query) {
      setFundSearchMessage('先写基金代码或名字噢。');
      setFundSearchResults([]);
      return;
    }
    setFundSearchLoading(true);
    setFundSearchMessage('');
    setFundProfileMessage('');
    setFundSearchCandidate(null);
    setFundSearchProfile(null);
    try {
      const response = await searchFunds(query, 8);
      const results = response.data ?? [];
      setFundSearchResults(results);
      if (results.length) {
        setFundSearchMessage(response.stale ? '找到了，但数据有点旧，先只拿来观察。' : `找到 ${results.length} 只，点一只给白云小姐看。`);
        return;
      }

      if (/^\d{6}$/.test(query)) {
        const candidateResponse = await fetchFundCandidate(query);
        if (candidateResponse.ok && candidateResponse.data) {
          setFundSearchCandidate(candidateResponse.data);
          setFundSearchMessage(candidateResponse.stale ? '查到了这只，但数据有点旧，先只拿来观察。' : '查到这只啦，可以让白云小姐分析。');
          await loadFundSearchProfile(candidateResponse.data.code);
          return;
        }
        setFundSearchMessage(candidateResponse.warnings[0] ?? '这只基金刚刚没查稳。');
        return;
      }

      setFundSearchMessage(response.warnings[0] ?? '没有找到匹配的基金。');
    } catch {
      setFundSearchMessage('今天基金数据桥没连上，白云小姐先不乱查><');
    } finally {
      setFundSearchLoading(false);
    }
  };

  const selectWalletFundSearchResult = async (item: FundSearchItem) => {
    setFundSearchLoading(true);
    setFundSearchMessage('');
    setFundProfileMessage('');
    try {
      const response = await fetchFundCandidate(item.code);
      if (response.ok && response.data) {
        setFundSearchCandidate(response.data);
        setFundSearchMessage(response.stale ? '选好啦，不过数据有点旧，后面只会谨慎观察。' : '选好啦，可以让白云小姐分析这只。');
        await loadFundSearchProfile(response.data.code);
        return;
      }
      setFundSearchMessage(response.warnings[0] ?? '这只基金资料刚刚没拿稳。');
    } catch {
      setFundSearchMessage('这只基金资料刚刚没拿稳。');
    } finally {
      setFundSearchLoading(false);
    }
  };

  const cacheGeneratedDecisionThought = (decisionId: string, review: WalletFundDecisionReview) => {
    setWalletDecisionThoughtContexts((previous) => ({
      ...previous,
      [decisionId]: {
        candidate: review.candidate,
        loadedAt: Date.now(),
        riskAssessment: review.riskAssessment,
        selectionTrace: review.selectionTrace,
        thoughtAnalysis: review.thoughtAnalysis,
        warnings: review.generatedDecision.rejectReasons.concat(review.riskAssessment.warnings),
      },
    }));
    setWalletDecisionThoughtMessages((previous) => ({ ...previous, [decisionId]: '' }));
  };

  const loadWalletDecisionThoughtContext = async (decision: WalletDecision) => {
    setWalletDecisionThoughtLoadingId(decision.id);
    setWalletDecisionThoughtMessages((previous) => ({ ...previous, [decision.id]: '' }));
    try {
      const candidateResponse = await fetchFundCandidate(decision.fundCode);
      if (!candidateResponse.ok || !candidateResponse.data) {
        setWalletDecisionThoughtMessages((previous) => ({
          ...previous,
          [decision.id]: candidateResponse.warnings[0] ?? '这次脑回路没拿稳。',
        }));
        return;
      }
      const candidate = candidateResponse.data;

      const thoughtResponse = await analyzeFundCandidate(candidate);
      if (!thoughtResponse.ok || !thoughtResponse.data) {
        setWalletDecisionThoughtMessages((previous) => ({
          ...previous,
          [decision.id]: thoughtResponse.warnings[0] ?? '这次脑回路没拿稳。',
        }));
        return;
      }
      const thoughtAnalysis = thoughtResponse.data;

      const currentWallet = wallet ?? await loadOrCreateDefaultWallet({ initialBudget: 100 });
      const riskAssessment = assessWalletRisk({
        candidate,
        holdings: wallet ? walletHoldings : await loadWalletHoldings(currentWallet.id),
        thoughtAnalysis,
        transactions: wallet ? walletTransactions : await loadWalletTransactions(currentWallet.id),
        wallet: currentWallet,
      });
      setWalletDecisionThoughtContexts((previous) => ({
        ...previous,
        [decision.id]: {
          candidate,
          loadedAt: Date.now(),
          riskAssessment,
          thoughtAnalysis,
          warnings: [...candidateResponse.warnings, ...thoughtResponse.warnings, ...riskAssessment.warnings],
        },
      }));
    } catch {
      setWalletDecisionThoughtMessages((previous) => ({
        ...previous,
        [decision.id]: '这次脑回路没拿稳。',
      }));
    } finally {
      setWalletDecisionThoughtLoadingId(null);
    }
  };

  const toggleWalletDecisionThought = async (decision: WalletDecision) => {
    const isExpanded = expandedWalletDecisionIds.includes(decision.id);
    if (isExpanded) {
      setExpandedWalletDecisionIds((previous) => previous.filter((id) => id !== decision.id));
      return;
    }
    setExpandedWalletDecisionIds((previous) => Array.from(new Set([...previous, decision.id])));
    if (!walletDecisionThoughtContexts[decision.id]) {
      await loadWalletDecisionThoughtContext(decision);
    }
  };

  const latestValueFromReview = (review: WalletFundDecisionReview) => {
    if (review.draft.action === 'buy' && (review.candidate.sourceType === 'money_fund' || review.candidate.poolAssessment.category === 'cash_parking')) {
      return 1;
    }
    const latestValue = review.candidate.latestValue;
    return typeof latestValue === 'number' && Number.isFinite(latestValue) && latestValue > 0
      ? latestValue
      : null;
  };

  const draftWithSuggestedNav = (review: WalletFundDecisionReview) => {
    const suggestedNav = latestValueFromReview(review);
    return {
      ...review.draft,
      suggestedNav,
      suggestedNavAt: suggestedNav ? Date.now() : null,
      suggestedNavSource: suggestedNav
        ? (review.candidate.sourceType === 'money_fund' || review.candidate.poolAssessment.category === 'cash_parking'
          ? 'cash_like_unit_nav' as const
          : 'candidate_latest_value' as const)
        : null,
    };
  };

  const seedDecisionNavInput = (decision: WalletDecision, message?: string) => {
    const suggestedNav = decision.suggestedNav;
    if (decision.action !== 'buy' || !suggestedNav) return;
    setWalletDecisionNavInputs((previous) => ({
      ...previous,
      [decision.id]: formatNav(suggestedNav),
    }));
    setWalletDecisionNavMeta((previous) => ({
      ...previous,
      [decision.id]: {
        manual: false,
        message: message ?? `建议净值来自${formatDecisionNavSource(decision.suggestedNavSource)}。`,
        resolvedAt: decision.suggestedNavAt,
        source: decision.suggestedNavSource ?? 'candidate_latest_value',
      },
    }));
  };

  const updateDecisionNavInput = (decisionId: string, value: string) => {
    setWalletDecisionNavInputs((previous) => ({ ...previous, [decisionId]: value }));
    setWalletDecisionNavMeta((previous) => ({
      ...previous,
      [decisionId]: {
        manual: true,
        // 工程占位文案，最终语气留给小仓鼠审核。
        message: '小仓鼠手动改过确认净值。',
        resolvedAt: Date.now(),
        source: 'manual',
      },
    }));
  };

  const applyNavResolutionToCard = (decisionId: string, result: WalletBuyNavResolution) => {
    setWalletDecisionNavMeta((previous) => ({
      ...previous,
      [decisionId]: {
        manual: false,
        // 工程占位文案，最终语气留给小仓鼠审核。
        message: result.ok
          ? `刚刚按${formatDecisionNavSource(result.source)}更新了确认净值。`
          : '今天净值没拿稳，白云小姐先不硬买。',
        resolvedAt: result.resolvedAt,
        source: result.source,
      },
    }));
    const nav = result.nav;
    if (result.ok && nav) {
      setWalletDecisionNavInputs((previous) => ({
        ...previous,
        [decisionId]: formatNav(nav),
      }));
    }
  };

  const refreshDecisionNav = async (decision: WalletDecision) => {
    setWalletDecisionNavLoadingId(decision.id);
    try {
      const result = await resolveWalletBuyNav(decision);
      applyNavResolutionToCard(decision.id, result);
      return result;
    } finally {
      setWalletDecisionNavLoadingId(null);
    }
  };

  const queueWalletPageNotice = (text: string) => {
    enqueueWalletChatNotice(text);
  };

  const handleWalletOpenRequest = async (request: WalletOpenRequest) => {
    setActiveExpenseTab('wallet');
    if (request.decisionId) {
      setWalletFocusDecisionId(request.decisionId);
      setExpandedWalletDecisionIds((previous) => Array.from(new Set([...previous, request.decisionId as string])));
    }
    if (!request.fundCode) return;

    setFundSearchQuery(request.fundCode);
    setFundSearchResults([]);
    setFundSearchLoading(true);
    setFundSearchMessage('');
    setFundProfileMessage('');
    try {
      const response = await fetchFundCandidate(request.fundCode);
      if (response.ok && response.data) {
        setFundSearchCandidate(response.data);
        setFundSearchMessage(request.fundName ? `从聊天带来 ${request.fundName}，资料先放这里。` : '从聊天带来的基金，资料先放这里。');
        await loadFundSearchProfile(response.data.code);
        return;
      }
      setFundSearchMessage(response.warnings[0] ?? '聊天里那只基金刚刚没查稳。');
    } catch {
      setFundSearchMessage('聊天里那只基金刚刚没查稳。');
    } finally {
      setFundSearchLoading(false);
    }
  };

  const openChatForWalletFund = (item: { code?: string; fundCode?: string; fundName?: string; id?: string; name?: string }) => {
    const fundCode = item.fundCode ?? item.code;
    const fundName = item.fundName ?? item.name;
    const label = fundName ? `「${fundName}」` : fundCode ? `「${fundCode}」` : '这张小金库卡片';
    queueWalletPageNotice('我把' + label + '带到聊天这边啦，小仓鼠可以继续问我。');
    navigate('chat');
  };
  const analyzeSelectedWalletFund = async () => {
    const dataEpoch = captureBackupRestoreDataEpoch();
    if (!fundSearchCandidate) {
      setFundSearchMessage('先选一只基金，再让白云小姐分析噢。');
      return;
    }
    setFundSearchLoading(true);
    try {
      const initial = await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
        const currentWallet = await loadOrCreateDefaultWallet({ initialBudget: 100 });
        const [currentPreferences, currentHoldings, currentTransactions] = await Promise.all([
          loadOrCreateWalletPreferences(currentWallet.id),
          loadWalletHoldings(currentWallet.id),
          loadWalletTransactions(currentWallet.id),
        ]);
        return { currentHoldings, currentPreferences, currentTransactions, currentWallet };
      });
      if (!initial.committed || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      setFundSearchMessage('');
      const {
        currentHoldings,
        currentPreferences,
        currentTransactions,
        currentWallet,
      } = initial.value;
      const result = await buildWalletFundDecisionFromText({
        apiKey: financeReasoningReady ? financeReasoningKey : undefined,
        connection: financeReasoningReady ? financeReasoningConnection : undefined,
        holdings: currentHoldings,
        text: fundSearchCandidate.code,
        transactions: currentTransactions,
        wallet: currentWallet,
        walletPreferences: currentPreferences ?? undefined,
      });
      if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      if (result.kind !== 'decision_ready' || !result.review.generatedDecision.valid) {
        setFundSearchMessage(result.notice || '这只基金今天没分析稳，白云小姐先不写决定卡。');
        return;
      }

      const created = await runBackupRestoreDataEpochCommit(dataEpoch, () => (
        createWalletDecision(currentWallet.id, draftWithSuggestedNav(result.review))
      ));
      if (!created.committed || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      const decision = created.value;
      const refreshed = await refreshWalletState(dataEpoch);
      if (refreshed !== true || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      cacheGeneratedDecisionThought(decision.id, result.review);
      seedDecisionNavInput(decision, '这张卡先用了候选基金的最新值。');
      setFundSearchCandidate(result.review.candidate);
      setFundSearchMessage('白云小姐写好一张待确认小卡片啦。');
      queueWalletPageNotice('我给小仓鼠放了一张 ' + decision.fundName + ' 的小金库卡片。');
    } catch {
      if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      setFundSearchMessage('这只基金今天没分析稳，白云小姐先不写决定卡。');
    } finally {
      setFundSearchLoading(false);
    }
  };

  useEffect(() => {
    setWatchlistCompareCodes((previous) => previous.filter((code) => watchlistItemsByCode.has(code)));
  }, [watchlistItemsByCode]);

  useEffect(() => {
    void refresh();
  }, [rangeWindow.startAt, rangeWindow.endAt]);

  useEffect(() => {
    const request = consumeWalletTabRequest();
    if (request) {
      void handleWalletOpenRequest(request);
    }
  }, []);

  useEffect(() => {
    if (activeExpenseTab === 'wallet') {
      void refreshWalletState();
    }
  }, [activeExpenseTab]);

  useEffect(() => {
    if (activeExpenseTab === 'wallet' && walletObservationReport.shouldAutoRefresh && !walletObservationLoading) {
      void runWalletObservationCheck(true);
    }
  }, [activeExpenseTab, walletObservationReport.shouldAutoRefresh, walletObservationLoading]);

  useEffect(() => {
    walletDecisions.forEach((decision) => {
      if (decision.status === 'proposed' && decision.action === 'buy' && decision.suggestedNav && !walletDecisionNavInputs[decision.id]) {
        seedDecisionNavInput(decision);
      }
    });
  }, [walletDecisions, walletDecisionNavInputs]);

  useEffect(() => {
    if (!editingEntry && !categoryChoices.includes(category)) {
      setCategory(categoryChoices[0]);
    }
  }, [category, categoryChoices, editingEntry]);

  const resetEditor = () => {
    setAmount('');
    setCategory(type === 'income' ? '工资' : '饮食');
    setNote('');
    setOccurredAtText(formatEditorDate(Date.now()));
    setType('expense');
    setEditingEntry(null);
  };

  const beginEdit = (entry: ExpenseEntry) => {
    setEditingEntry(entry);
    setAmount(String(entry.amount));
    setType(entry.type);
    setCategory(entry.category);
    setNote(entry.note);
    setOccurredAtText(formatEditorDate(entry.occurredAt));
  };

  const saveEntry = async () => {
    const parsedAmount = Number(amount.replace(/[^\d.]/g, ''));
    const parsedOccurredAt = parseEditorDate(occurredAtText);
    if (!Number.isFinite(parsedAmount) || (parsedAmount <= 0
      && !(parsedAmount === 0 && editingEntry?.amount === 0))) {
      Alert.alert('金额还不对', '小仓鼠先填一个有效金额。');
      return;
    }
    if (!parsedOccurredAt) {
      Alert.alert('时间还不对', '时间可以写成 2026-06-04 21:30 这样。');
      return;
    }

    const draft: ExpenseDraft = {
      amount: parsedAmount,
      category: editingEntry && category === editingEntry.category ? editingEntry.category
        : category.trim() || (type === 'income' ? '其他收入' : '其他'),
      note: editingEntry && note === editingEntry.note ? editingEntry.note
        : note.trim() || (type === 'income' ? '一笔收入' : type === 'refund' ? '一笔退款' : '一笔支出'),
      occurredAt: editingEntry && occurredAtText === formatEditorDate(editingEntry.occurredAt)
        ? editingEntry.occurredAt : parsedOccurredAt,
      source: editingEntry?.source ?? 'manual',
      type,
      originalExpenseId: editingEntry?.originalExpenseId ?? null,
    };
    const dataEpoch = captureBackupRestoreDataEpoch();
    const saved = await runBackupRestoreDataEpochCommit(
      dataEpoch,
      async () => {
        const originalExpected = draft.originalExpenseId
          ? await loadExpenseEntryById(draft.originalExpenseId) ?? undefined : undefined;
        return applyExpenseMutation({
          action: editingEntry ? 'update' : type === 'refund' ? 'refund' : 'create',
          id: editingEntry?.id ?? `expense-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
          draft, expected: editingEntry ?? undefined, originalExpected, executionAt: Date.now(),
        });
      },
    );
    if (!saved.committed || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
    if (saved.value.status !== 'saved') {
      Alert.alert('账本未保存', saved.value.status === 'conflict'
        ? '记录已变化，请重新打开核对。' : '保存结果尚未确认，请先核对账本。');
      return;
    }
    const refreshed = await refresh(dataEpoch);
    if (refreshed !== true || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
    resetEditor();
  };

  const confirmDelete = (entry: ExpenseEntry) => {
    const dataEpoch = captureBackupRestoreDataEpoch();
    Alert.alert('删除这条账本记录？', `${entry.note} · ${formatMoney(entry.amount)}`, [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: () => {
          void runBackupRestoreDataEpochCommit(
            dataEpoch,
            () => applyExpenseMutation({ action: 'delete', id: entry.id, expected: entry, executionAt: Date.now() }),
          ).then(async (deleted) => {
            if (!deleted.committed || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
            if (deleted.value.status !== 'saved') {
              Alert.alert('记录未删除', '请重新打开核对当前记录。');
              return;
            }
            await refresh(dataEpoch);
          });
        },
      },
    ]);
  };

  const createTestWalletDecision = async () => {
    const dataEpoch = captureBackupRestoreDataEpoch();
    try {
      const created = await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
        const currentWallet = wallet ?? await loadOrCreateDefaultWallet({ initialBudget: 100 });
        return createWalletDecision(currentWallet.id, {
          action: 'buy',
          amount: 10,
          confidence: 72,
          fundCode: '000001',
          fundName: '白云测试稳稳基金',
          fundType: '测试基金',
          reasoning: '我先用 10 元做一张测试决定卡，看看小金库确认流程是不是乖乖跑通。',
          riskWarning: '这只是本地测试记录，不是真实购买，也不是收益承诺噢。',
          source: 'baiyun',
          suggestedNav: 1,
          suggestedNavAt: Date.now(),
          suggestedNavSource: 'manual',
          whyNotMore: '现在还没接真实行情，我只拿一点点小金额试流程，不多买。',
        });
      });
      if (!created.committed || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      const decision = created.value;
      const refreshed = await refreshWalletState(dataEpoch);
      if (refreshed !== true || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      seedDecisionNavInput(decision, '调试卡默认净值是 1.0000。');
    } catch {
      if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      Alert.alert('决定卡没写好', '白云小姐刚刚手滑了，等一下再给小仓鼠写一张><');
    }
  };

  const clearDebugWalletDecisions = async () => {
    Alert.alert('清理测试历史', '只会清掉没执行过的「白云测试稳稳基金」卡片，真实基金记录不会动。', [
      { text: '先不清', style: 'cancel' },
      {
        text: '清理',
        style: 'destructive',
        onPress: () => {
          const dataEpoch = captureBackupRestoreDataEpoch();
          void runBackupRestoreDataEpochCommit(dataEpoch, async () => {
            const currentWallet = await loadOrCreateDefaultWallet({ initialBudget: 100 });
            return deleteWalletDebugDecisions(currentWallet.id);
          })
            .then(async (deleted) => {
              if (!deleted.committed || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
              const refreshed = await refreshWalletState(dataEpoch);
              if (refreshed !== true || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
              const count = deleted.value;
              setWalletDecisionMessage(count ? `清掉 ${count} 张测试小卡片啦。` : '没有需要清理的测试小卡片。');
            })
            .catch(() => {
              if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return;
              setWalletError('测试历史刚刚没清稳，白云小姐等会儿再试><');
            });
        },
      },
    ]);
  };

  const createRealWalletDecision = async () => {
    const dataEpoch = captureBackupRestoreDataEpoch();
    setWalletLoading(true);
    try {
      const initial = await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
        const currentWallet = await loadOrCreateDefaultWallet({ initialBudget: 100 });
        const [currentPreferences, currentHoldings, currentTransactions] = await Promise.all([
          loadOrCreateWalletPreferences(currentWallet.id),
          loadWalletHoldings(currentWallet.id),
          loadWalletTransactions(currentWallet.id),
        ]);
        return { currentHoldings, currentPreferences, currentTransactions, currentWallet };
      });
      if (!initial.committed || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      setWalletError('');
      setWalletDecisionMessage('');
      setWalletAutoPickTrace(null);
      const {
        currentHoldings,
        currentPreferences,
        currentTransactions,
        currentWallet,
      } = initial.value;
      const result = await buildWalletFundDecisionFromPools({
        apiKey: financeReasoningReady ? financeReasoningKey : undefined,
        connection: financeReasoningReady ? financeReasoningConnection : undefined,
        holdings: currentHoldings,
        transactions: currentTransactions,
        wallet: currentWallet,
        walletPreferences: currentPreferences ?? undefined,
      });
      if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      if (result.kind !== 'decision_ready') {
        setWalletAutoPickTrace(result.selectionTrace ?? null);
        setWalletDecisionMessage(result.notice || '今天基金数据没拿稳，白云小姐先不乱写决定卡><');
        setWalletError(result.notice || '今天基金数据没拿稳，白云小姐先不乱写决定卡><');
        return;
      }
      if (!result.review.generatedDecision.valid) {
        setWalletAutoPickTrace(result.review.selectionTrace ?? null);
        setWalletDecisionMessage(result.notice || '今天基金数据没拿稳，白云小姐先不乱写决定卡><');
        setWalletError(result.notice || '今天基金数据没拿稳，白云小姐先不乱写决定卡><');
        return;
      }

      const created = await runBackupRestoreDataEpochCommit(dataEpoch, () => (
        createWalletDecision(currentWallet.id, draftWithSuggestedNav(result.review))
      ));
      if (!created.committed || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      const decision = created.value;
      const refreshed = await refreshWalletState(dataEpoch);
      if (refreshed !== true || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      cacheGeneratedDecisionThought(decision.id, result.review);
      seedDecisionNavInput(decision, '这张卡先用了候选基金的最新值。');
      setWalletAutoPickTrace(result.review.selectionTrace ?? null);
      setWalletDecisionMessage(result.notice);
      queueWalletPageNotice('我刚刚看完真实候选，放了一张 ' + decision.fundName + ' 的小金库卡片。');
    } catch {
      if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      setWalletDecisionMessage('今天基金数据没拿稳，白云小姐先不乱写决定卡><');
      setWalletError('今天基金数据没拿稳，白云小姐先不乱写决定卡><');
    } finally {
      setWalletLoading(false);
    }
  };

  const approveDecision = async (decisionId: string) => {
    const dataEpoch = captureBackupRestoreDataEpoch();
    let decision: WalletDecision | null = null;
    try {
      const initial = await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
        const currentWallet = await loadOrCreateDefaultWallet({ initialBudget: 100 });
        const currentDecisions = await loadWalletDecisions(currentWallet.id, 200);
        return currentDecisions.find((item) => item.id === decisionId) ?? null;
      });
      if (!initial.committed || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      decision = initial.value;
    } catch {
      if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      Alert.alert('先暂停一下', '这张决定卡刚刚没找到，白云小姐先不动小钱钱。');
      return;
    }
    if (!decision) {
      Alert.alert('先暂停一下', '这张决定卡刚刚没找到，白云小姐先不动小钱钱。');
      return;
    }
    if (decision.action !== 'buy') {
      try {
        const approved = await runBackupRestoreDataEpochCommit(dataEpoch, () => (
          approveWalletDecision({ decisionId })
        ));
        if (!approved.committed || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
        const refreshed = await refreshWalletState(dataEpoch);
        if (refreshed !== true || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
        queueWalletPageNotice('小金库里 ' + decision.fundName + ' 的观察卡已经记下来了。');
      } catch {
        if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return;
        Alert.alert('先暂停一下', '这张决定卡刚刚没能记录进去，白云小姐先不动小钱钱。');
      }
      return;
    }
    setWalletDecisionNavLoadingId(decisionId);
    try {
      const result = await resolveWalletBuyNav(decision);
      if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      const manualNav = parseNavInput(walletDecisionNavInputs[decision.id] ?? '');
      const manual = walletDecisionNavMeta[decision.id]?.manual === true;
      const nav = result.ok && result.nav ? result.nav : manual ? manualNav : null;
      if (!nav) {
        Alert.alert('净值还没拿稳', '今天净值没拿稳，白云小姐先不硬买。');
        return;
      }
      const approved = await runBackupRestoreDataEpochCommit(dataEpoch, () => (
        approveWalletBuyDecision({ decisionId, nav })
      ));
      if (!approved.committed || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      const refreshed = await refreshWalletState(dataEpoch);
      if (refreshed !== true || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      applyNavResolutionToCard(decision.id, result);
      if (!result.ok && manual) {
        setWalletDecisionNavMeta((previous) => ({
          ...previous,
          [decision.id]: {
            manual: true,
            message: '按小仓鼠手动确认的净值记入本地模拟账。',
            resolvedAt: Date.now(),
            source: 'manual',
          },
        }));
      }
      queueWalletPageNotice('小金库已经按确认净值记下 ' + decision.fundName + ' 这一笔啦。');
    } catch (error) {
      if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      const message = error instanceof Error && error.message === 'wallet-cash-not-enough'
        ? '小金库现金不够啦，白云小姐不会硬买。'
        : '这张决定卡刚刚没能记录进去，白云小姐先不动小钱钱。';
      Alert.alert('先暂停一下', message);
    } finally {
      setWalletDecisionNavLoadingId(null);
    }
  };

  const rejectDecision = async (decisionId: string) => {
    const dataEpoch = captureBackupRestoreDataEpoch();
    const decision = walletDecisions.find((item) => item.id === decisionId);
    const updated = await runBackupRestoreDataEpochCommit(
      dataEpoch,
      () => updateWalletDecisionStatus(decisionId, 'rejected'),
    );
    if (!updated.committed || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
    const refreshed = await refreshWalletState(dataEpoch);
    if (refreshed !== true || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
    if (decision) queueWalletPageNotice('小仓鼠刚刚没有选择 ' + decision.fundName + '，我已经记住这次不买啦。');
    setWalletFocusDecisionId((current) => (current === decisionId ? null : current));
  };

  const deferDecision = async (decisionId: string) => {
    const dataEpoch = captureBackupRestoreDataEpoch();
    const decision = walletDecisions.find((item) => item.id === decisionId);
    const updated = await runBackupRestoreDataEpochCommit(
      dataEpoch,
      () => updateWalletDecisionStatus(decisionId, 'deferred'),
    );
    if (!updated.committed || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
    const refreshed = await refreshWalletState(dataEpoch);
    if (refreshed !== true || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
    if (decision) queueWalletPageNotice(decision.fundName + ' 这张小卡片先放到以后再说。');
    setWalletFocusDecisionId((current) => (current === decisionId ? null : current));
  };

  return (
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <Pressable onPress={() => navigate('home')} style={styles.backButton}>
          <Text style={styles.backText}>‹</Text>
        </Pressable>
        <View style={styles.headerCopy}>
          <Text style={styles.title}>小账本</Text>
          <Text style={styles.subtitle}>把日常花销轻轻记下来</Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.mainTabRow}>
          {([
            { label: '账本', value: 'ledger' },
            { label: '小金库', value: 'wallet' },
          ] as Array<{ label: string; value: ExpenseTab }>).map((item) => (
            <Pressable
              key={item.value}
              onPress={() => setActiveExpenseTab(item.value)}
              style={[styles.mainTabButton, activeExpenseTab === item.value && styles.mainTabButtonActive]}
            >
              <Text style={[styles.mainTabText, activeExpenseTab === item.value && styles.mainTabTextActive]}>{item.label}</Text>
            </Pressable>
          ))}
        </View>

        {activeExpenseTab === 'wallet' ? (
          <View style={styles.walletBoundaryCard}>
            <View style={styles.walletBoundaryHeader}>
              <Text style={styles.walletBoundaryEyebrow}>☁️ 白云的小钱钱约定</Text>
              <Text style={styles.walletBoundaryBadge}>你点头才算数 ✨</Text>
            </View>
            <Text style={styles.walletBoundaryTitle}>{walletProductName}正在铺小软垫</Text>
            <Text style={styles.walletBoundarySummary}>{walletSafetySummary}</Text>
            <View style={styles.walletBoundaryList}>
              {walletSafetyBoundaries.map((item) => (
                <View key={item} style={styles.walletBoundaryItem}>
                  <View style={styles.walletBoundaryDot} />
                  <Text style={styles.walletBoundaryText}>{item}</Text>
                </View>
              ))}
            </View>
          </View>
        ) : null}

        {activeExpenseTab === 'ledger' ? (
          <>
        <View style={styles.rangeRow}>
          {rangeOptions.map((item) => (
            <Pressable
              key={item.value}
              onPress={() => setRange(item.value)}
              style={[styles.rangeButton, range === item.value && styles.rangeButtonActive]}
            >
              <Text style={[styles.rangeText, range === item.value && styles.rangeTextActive]}>{item.label}</Text>
            </Pressable>
          ))}
        </View>

        <View style={styles.summaryCard}>
          <Text style={styles.summaryLabel}>{rangeWindow.label}</Text>
          <View style={styles.summaryRow}>
            <View>
              <Text style={styles.summaryName}>支出</Text>
              <Text style={styles.expenseAmount}>{formatMoney(summary.expense)}</Text>
            </View>
            <View>
              <Text style={styles.summaryName}>收入</Text>
              <Text style={styles.incomeAmount}>{formatMoney(summary.income)}</Text>
            </View>
          </View>
          <View style={styles.summaryRow}>
            <View><Text style={styles.summaryName}>退款</Text><Text style={styles.incomeAmount}>{formatMoney(summary.refund)}</Text></View>
            <View><Text style={styles.summaryName}>净支出</Text><Text style={styles.expenseAmount}>{formatMoney(summary.netExpense)}</Text></View>
          </View>
          <Text style={styles.balanceText}>结余 {formatMoney(summary.income - summary.netExpense)}</Text>
        </View>

        <View style={styles.reportCard}>
          <View style={styles.reportHeader}>
            <View>
              <Text style={styles.sectionTitle}>分类占比</Text>
              <Text style={styles.reportHint}>{chartType === 'expense' ? '看看钱花去了哪里' : '看看钱从哪里来'}</Text>
            </View>
            <View style={styles.chartTypeRow}>
              {(['expense', 'income'] as ExpenseEntryType[]).map((item) => (
                <Pressable
                  key={item}
                  onPress={() => setChartType(item)}
                  style={[styles.chartTypeButton, chartType === item && styles.chartTypeButtonActive]}
                >
                  <Text style={[styles.chartTypeText, chartType === item && styles.chartTypeTextActive]}>
                    {item === 'expense' ? '支出' : '收入'}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>

          <View style={styles.chartRow}>
            <View style={styles.chartWrap}>
              <DonutChart data={categoryTotals} />
              {categoryTotals.length ? (
                <View style={styles.chartCenter}>
                  <Text style={styles.chartCenterLabel}>{chartType === 'expense' ? '支出' : '收入'}</Text>
                  <Text style={styles.chartCenterAmount}>{formatMoney(chartTotal)}</Text>
                </View>
              ) : null}
            </View>
            <View style={styles.categoryList}>
              {categoryTotals.length ? categoryTotals.map((item) => (
                <View key={item.category} style={styles.categoryTotalRow}>
                  <View style={[styles.categoryDot, { backgroundColor: item.color }]} />
                  <View style={styles.categoryTotalCopy}>
                    <Text style={styles.categoryTotalName}>{item.category}</Text>
                    <Text style={styles.categoryPercent}>{Math.round(item.percent * 100)}%</Text>
                  </View>
                  <Text style={styles.categoryTotalAmount}>{formatMoney(item.amount)}</Text>
                </View>
              )) : (
                <Text style={styles.emptyText}>
                  {chartType === 'expense' ? '这个范围还没有支出记录。' : '这个范围还没有收入记录。'}
                </Text>
              )}
            </View>
          </View>
        </View>

        <View style={styles.editor}>
          <View style={styles.editorHeading}>
            <Text style={styles.sectionTitle}>{editingEntry ? '修改这一笔' : '手动记一笔'}</Text>
            {editingEntry ? (
              <Pressable onPress={resetEditor}>
                <Text style={styles.cancelEditText}>取消编辑</Text>
              </Pressable>
            ) : null}
          </View>
          <View style={styles.typeRow}>
            {(['expense', 'income', 'refund'] as ExpenseEntryType[]).map((item) => (
              <Pressable
                key={item}
                onPress={() => setType(item)}
                style={[styles.typeButton, type === item && styles.typeButtonActive]}
              >
                <Text style={[styles.typeText, type === item && styles.typeTextActive]}>
                  {item === 'expense' ? '支出' : item === 'refund' ? '退款' : '收入'}
                </Text>
              </Pressable>
            ))}
          </View>
          <TextInput
            keyboardType="decimal-pad"
            onChangeText={setAmount}
            placeholder="金额，例如 5"
            style={styles.input}
            value={amount}
          />
          <TextInput
            onChangeText={setNote}
            placeholder={type === 'income' ? '说明，例如 工资到账' : type === 'refund' ? '说明，例如 商品退款' : '说明，例如 冰淇淋'}
            style={styles.input}
            value={note}
          />
          <TextInput
            onChangeText={setOccurredAtText}
            placeholder="发生时间，例如 2026-06-04 21:30"
            style={styles.input}
            value={occurredAtText}
          />
          <View style={styles.categoryGrid}>
            {categoryChoices.map((item) => (
              <Pressable
                key={item}
                onPress={() => setCategory(item)}
                style={[styles.categoryChip, category === item && styles.categoryChipActive]}
              >
                <Text style={[styles.categoryText, category === item && styles.categoryTextActive]}>{item}</Text>
              </Pressable>
            ))}
          </View>
          <Pressable onPress={() => void saveEntry()} style={styles.saveButton}>
            <Text style={styles.saveText}>{editingEntry ? '保存修改' : '记下来'}</Text>
          </Pressable>
        </View>

        <View style={styles.listCard}>
          <Text style={styles.sectionTitle}>{rangeWindow.label}记录</Text>
          {entries.length ? entries.map((entry) => (
            <Pressable
              key={entry.id}
              onLongPress={() => confirmDelete(entry)}
              onPress={() => beginEdit(entry)}
              style={styles.entryRow}
            >
              <View style={styles.entryCopy}>
                <Text style={styles.entryNote}>{entry.note}</Text>
                <Text style={styles.entryMeta}>
                  {entry.category} · {formatDate(entry.occurredAt)} · {entry.source === 'chat' ? '聊天记入' : '手动记入'}
                  {entry.type === 'refund' ? ` · 退款 · ${refundOriginalStates[entry.id] === 'deleted'
                    ? '原账已删除' : refundOriginalStates[entry.id] === 'missing'
                      ? '原账暂缺' : refundOriginalStates[entry.id] === 'inconsistent'
                        ? '关联需核对' : entry.originalExpenseId ? '已关联原账' : '独立退款'}` : ''}
                </Text>
              </View>
              <Text style={entry.type !== 'expense' ? styles.entryIncome : styles.entryExpense}>
                {entry.type !== 'expense' ? '+' : '-'}{formatMoney(entry.amount)}
              </Text>
            </Pressable>
          )) : (
            <Text style={styles.emptyText}>这个范围还没有账本记录。可以在这里手动记，也可以在聊天里说“我花了五块钱买冰淇淋”。</Text>
          )}
        </View>
          </>
        ) : (
          <>
            <View style={styles.walletAccountCard}>
              <View style={styles.walletSectionHeader}>
                <View>
                  <Text style={styles.sectionTitle}>{wallet?.name ?? '白云小金库'}</Text>
                  <Text style={styles.walletHint}>先跑通本地小账本，不接真实行情噢</Text>
                </View>
                <Pressable onPress={() => void refreshWalletValuationState()} style={styles.walletGhostButton}>
                  <Text style={styles.walletGhostButtonText}>{walletLoading ? '翻账本中' : '刷新估值'}</Text>
                </Pressable>
              </View>
              {walletError ? <Text style={styles.walletErrorText}>{walletError}</Text> : null}
              <View style={styles.walletMetricGrid}>
                <View style={styles.walletMetricItem}>
                  <Text style={styles.walletMetricLabel}>总预算</Text>
                  <Text style={styles.walletMetricValue}>{formatMoney(wallet?.totalBudget ?? 0)}</Text>
                </View>
                <View style={styles.walletMetricItem}>
                  <Text style={styles.walletMetricLabel}>剩余现金</Text>
                  <Text style={styles.walletMetricValue}>{formatMoney(wallet?.cashBalance ?? 0)}</Text>
                </View>
                <View style={styles.walletMetricItem}>
                  <Text style={styles.walletMetricLabel}>已投入</Text>
                  <Text style={styles.walletMetricValue}>{formatMoney(wallet?.investedAmount ?? 0)}</Text>
                </View>
                <View style={styles.walletMetricItem}>
                  <Text style={styles.walletMetricLabel}>当前估值</Text>
                  <Text style={styles.walletMetricValue}>{formatMoney(walletMarketValue)}</Text>
                </View>
              </View>
              <Text style={[styles.walletProfitText, walletFloatingProfit >= 0 ? styles.walletProfitPositive : styles.walletProfitNegative]}>
                浮盈亏 {walletFloatingProfit >= 0 ? '+' : ''}{formatMoney(walletFloatingProfit)}（{formatPercent(walletFloatingProfitPct)}）
              </Text>
              {latestWalletSnapshot ? (
                <Text style={styles.walletHint}>最近快照：{formatDate(latestWalletSnapshot.snapshotAt)}</Text>
              ) : null}
            </View>

            <View style={styles.walletCard}>
              <View style={styles.walletSectionHeader}>
                <View style={styles.entryCopy}>
                  <Text style={styles.sectionTitle}>{'\u767d\u4e91\u4eca\u65e5\u5c0f\u63d0\u9192'}</Text>
                  <Text style={styles.walletHint}>
                    {walletObservationReport.dateKey} · {walletObservationReport.isLegalWorkday ? "\u9002\u5408\u770b\u57fa\u91d1" : "\u5148\u8f7b\u8f7b\u89c2\u5bdf"}
                  </Text>
                </View>
                <Pressable
                  disabled={walletObservationLoading}
                  onPress={() => void runWalletObservationCheck(false)}
                  style={styles.walletGhostButton}
                >
                  <Text style={styles.walletGhostButtonText}>{walletObservationLoading ? "\u770b\u7740\u5462" : "\u767d\u4e91\u8f7b\u8f7b\u770b\u4e00\u773c"}</Text>
                </Pressable>
              </View>
              <Text style={styles.walletBodyText}>{walletObservationReport.summary}</Text>
              <View style={styles.watchlistTagRow}>
                <Text style={styles.watchlistTag}>{walletObservationReport.isLegalWorkday ? "\u4ea4\u6613\u65e5\u53e3\u5f84" : "\u975e\u4ea4\u6613\u63d0\u9192"}</Text>
                <Text style={styles.watchlistTag}>{walletObservationReport.calendarSource === "schedule_calendar_rules" ? "\u65e5\u7a0b\u65e5\u5386" : "\u666e\u901a\u5de5\u4f5c\u65e5"}</Text>
                <Text style={styles.watchlistTag}>{walletObservationReport.shouldAutoRefresh ? "\u53ef\u8f7b\u5237" : "\u4e0d\u7528\u6025"}</Text>
              </View>
              {walletObservationReport.items.map((item) => (
                <View key={item.id} style={styles.fundDetailSection}>
                  <View style={styles.watchlistItemHeader}>
                    <Text style={styles.fundDetailTitle}>{item.label}</Text>
                    <Text style={styles.watchlistTag}>{item.status === "ok" ? "\u7a33\u7a33" : item.status === "due" ? "\u5f85\u770b" : "\u63d0\u9192"}</Text>
                  </View>
                  <Text style={styles.walletHint}>{item.detail}</Text>
                </View>
              ))}
              {walletObservationMessage ? <Text style={styles.walletHint}>{walletObservationMessage}</Text> : null}
              {walletObservationReport.warnings.map((warning) => (
                <Text key={warning} style={styles.walletHint}>{warning}</Text>
              ))}
            </View>

            <View style={styles.walletCard}>
              <View style={styles.walletSectionHeader}>
                <View style={styles.entryCopy}>
                  <Text style={styles.sectionTitle}>小钱钱计划</Text>
                  <Text style={styles.walletHint}>只影响白云小姐怎么挑候选，不会放松风险刹车。</Text>
                </View>
                <Pressable
                  onPress={walletPreferenceFormOpen ? closeWalletPreferenceForm : openWalletPreferenceForm}
                  style={styles.walletGhostButton}
                >
                  <Text style={styles.walletGhostButtonText}>{walletPreferenceFormOpen ? '收起' : '调整'}</Text>
                </Pressable>
              </View>
              <View style={styles.watchlistTagRow}>
                <Text style={styles.watchlistTag}>预算 {formatMoney(wallet?.totalBudget ?? 100)}</Text>
                <Text style={styles.watchlistTag}>偏好 {formatWalletRiskProfileLabel(wallet?.riskProfile)}</Text>
                <Text style={styles.watchlistTag}>
                  单笔 {walletPreferences?.comfortSingleAmount ? formatMoney(walletPreferences.comfortSingleAmount) : '默认 10 元'}
                </Text>
              </View>
              <Text style={styles.walletBodyText}>{formatWalletPreferenceSummary(walletPreferences)}</Text>
              {walletPreferenceMessage ? <Text style={styles.walletHint}>{walletPreferenceMessage}</Text> : null}
              {walletPreferenceFormOpen ? (
                <View style={styles.walletPreferencePanel}>
                  <View style={styles.walletSectionHeader}>
                    <View style={styles.entryCopy}>
                      <Text style={styles.fundDetailTitle}>自动挑候选</Text>
                      <Text style={styles.walletHint}>关掉后，白云小姐不会自动写真实基金决定卡。</Text>
                    </View>
                    <Pressable
                      onPress={() => updateWalletPreferenceForm('enabled', !walletPreferenceForm.enabled)}
                      style={[styles.categoryChip, walletPreferenceForm.enabled ? styles.categoryChipActive : null]}
                    >
                      <Text style={walletPreferenceForm.enabled ? styles.categoryTextActive : styles.categoryText}>
                        {walletPreferenceForm.enabled ? '开着' : '关着'}
                      </Text>
                    </Pressable>
                  </View>
                  <View style={styles.fundDetailGrid}>
                    <View style={styles.fundDetailItem}>
                      <Text style={styles.fundDetailLabel}>总预算</Text>
                      <TextInput
                        keyboardType="decimal-pad"
                        onChangeText={(value) => updateWalletPreferenceForm('budget', value)}
                        placeholder="例如 100"
                        style={styles.input}
                        value={walletPreferenceForm.budget}
                      />
                    </View>
                    <View style={styles.fundDetailItem}>
                      <Text style={styles.fundDetailLabel}>舒服单笔金额</Text>
                      <TextInput
                        keyboardType="decimal-pad"
                        onChangeText={(value) => updateWalletPreferenceForm('comfortSingleAmount', value)}
                        placeholder="默认 10"
                        style={styles.input}
                        value={walletPreferenceForm.comfortSingleAmount}
                      />
                    </View>
                  </View>
                  <View style={styles.fundDetailSection}>
                    <Text style={styles.fundDetailTitle}>风险偏好</Text>
                    <View style={styles.categoryGrid}>
                      {walletRiskProfileOptions.map((option) => (
                        <Pressable
                          key={option.value}
                          onPress={() => updateWalletPreferenceForm('riskProfile', option.value)}
                          style={[styles.categoryChip, walletPreferenceForm.riskProfile === option.value ? styles.categoryChipActive : null]}
                        >
                          <Text style={walletPreferenceForm.riskProfile === option.value ? styles.categoryTextActive : styles.categoryText}>
                            {option.label}
                          </Text>
                        </Pressable>
                      ))}
                    </View>
                  </View>
                  <View style={styles.fundDetailSection}>
                    <Text style={styles.fundDetailTitle}>更想看的池子</Text>
                    <View style={styles.categoryGrid}>
                      {walletPreferredPoolOptions.map((option) => (
                        <Pressable
                          key={option.value}
                          onPress={() => toggleWalletPreferredPool(option.value)}
                          style={[styles.categoryChip, walletPreferenceForm.preferredPools.includes(option.value) ? styles.categoryChipActive : null]}
                        >
                          <Text style={walletPreferenceForm.preferredPools.includes(option.value) ? styles.categoryTextActive : styles.categoryText}>
                            {option.label}
                          </Text>
                        </Pressable>
                      ))}
                    </View>
                  </View>
                  <View style={styles.fundDetailSection}>
                    <Text style={styles.fundDetailTitle}>暂时不想碰</Text>
                    <View style={styles.categoryGrid}>
                      {walletAvoidTypeOptions.map((option) => (
                        <Pressable
                          key={option.value}
                          onPress={() => toggleWalletAvoidType(option.value)}
                          style={[styles.categoryChip, walletPreferenceForm.avoidTypes.includes(option.value) ? styles.categoryChipActive : null]}
                        >
                          <Text style={walletPreferenceForm.avoidTypes.includes(option.value) ? styles.categoryTextActive : styles.categoryText}>
                            {option.label}
                          </Text>
                        </Pressable>
                      ))}
                    </View>
                  </View>
                  <View style={styles.fundDetailSection}>
                    <Text style={styles.fundDetailTitle}>最近的小钱钱计划</Text>
                    <TextInput
                      multiline
                      onChangeText={(value) => updateWalletPreferenceForm('tendency', value)}
                      placeholder="例如：最近先稳一点，少看主题基金"
                      style={[styles.input, styles.walletPlanTextArea]}
                      value={walletPreferenceForm.tendency}
                    />
                  </View>
                  <View style={styles.decisionActionRow}>
                    <Pressable onPress={closeWalletPreferenceForm} style={styles.walletDismissButton}>
                      <Text style={styles.walletDismissButtonText}>先不改</Text>
                    </Pressable>
                    <Pressable onPress={() => void saveWalletPreferencePlan()} style={styles.walletSaveButton}>
                      <Text style={styles.walletSaveButtonText}>{walletLoading ? '保存中' : '保存计划'}</Text>
                    </Pressable>
                  </View>
                </View>
              ) : null}
            </View>

            <View style={styles.walletCard}>
              <Text style={styles.sectionTitle}>今日复盘</Text>
              {walletReview ? (
                <>
                  <Text style={styles.walletBodyText}>{walletReview.summary}</Text>
                  <Text style={styles.walletBodyText}>{walletReview.profitText}</Text>
                  {walletReview.riskNotes.map((note) => (
                    <Text key={note} style={styles.walletBodyText}>提醒：{note}</Text>
                  ))}
                  {walletReview.dataNotes.map((note) => (
                    <Text key={note} style={styles.walletHint}>{note}</Text>
                  ))}
                  <Text style={styles.walletHint}>复盘时间：{formatDate(walletReview.generatedAt)}</Text>
                </>
              ) : (
                <Text style={styles.emptyText}>点一下“刷新估值”，白云小姐就会看一眼持仓，写一小段今天的复盘。</Text>
              )}
            </View>

            <View style={styles.walletCard}>
              <View>
                <View style={styles.walletInlineTitleRow}>
                  <Text style={styles.sectionTitle}>{walletWatchlistCopy.title}</Text>
                  <Pressable onPress={() => void refreshWalletWatchlistState()} style={styles.walletInlineButton}>
                    <Text numberOfLines={1} style={styles.walletInlineButtonText}>
                      {walletLoading ? '整理中' : '刷新'}
                    </Text>
                  </Pressable>
                </View>
                <Text style={styles.walletHint}>只整理观察名单，不生成买入决定。</Text>
              </View>
              {walletWatchlist?.stale ? <Text style={styles.walletHint}>{walletWatchlistCopy.stale}</Text> : null}
              {walletWatchlist?.groups.some((group) => group.items.length) ? (
                <>
                  {watchlistCompareCodes.length ? (
                    <View style={styles.watchlistComparePanel}>
                      <View style={styles.watchlistItemHeader}>
                        <Text style={styles.fundDetailTitle}>基金对比</Text>
                        <Pressable onPress={clearWatchlistCompare} style={styles.walletInlineButton}>
                          <Text numberOfLines={1} style={styles.walletInlineButtonText}>清空</Text>
                        </Pressable>
                      </View>
                      <View style={styles.watchlistTagRow}>
                        {watchlistCompareItems.map((item) => (
                          <Text key={`compare-chip-${item.candidate.code}`} style={styles.watchlistTag}>{item.candidate.name}</Text>
                        ))}
                      </View>
                      {watchlistCompareItems.length < 2 ? (
                        <Text style={styles.walletHint}>再选一只基金，白云小姐就能把它们并排给小仓鼠看。</Text>
                      ) : (
                        <View style={styles.watchlistCompareRows}>
                          {watchlistComparisonRows.map((row) => (
                            <View key={row.label} style={styles.watchlistCompareRow}>
                              <Text style={styles.watchlistCompareLabel}>{row.label}</Text>
                              <View style={styles.watchlistCompareValues}>
                                {row.values.map((value) => (
                                  <Text key={`${row.label}-${value.code}`} numberOfLines={2} style={styles.watchlistCompareValue}>{value.value}</Text>
                                ))}
                              </View>
                            </View>
                          ))}
                        </View>
                      )}
                    </View>
                  ) : null}
                  {walletWatchlist.groups.map((group) => {
                    const isGroupExpanded = expandedWatchlistGroups.includes(group.id);
                    const visibleItems = isGroupExpanded ? group.items.slice(0, 5) : group.items.slice(0, 2);
                    return (
                      <View key={group.id} style={styles.watchlistGroup}>
                        <View style={styles.watchlistGroupHeader}>
                          <View style={styles.entryCopy}>
                            <Text style={styles.watchlistGroupTitle}>{group.title}</Text>
                            <Text style={styles.walletHint}>整理出 {group.items.length} 只</Text>
                          </View>
                          <Pressable onPress={() => toggleWatchlistGroup(group.id)} style={styles.walletInlineButton}>
                            <Text numberOfLines={1} style={styles.walletInlineButtonText}>{isGroupExpanded ? '收起' : '展开'}</Text>
                          </Pressable>
                        </View>
                        {visibleItems.length ? visibleItems.map((item) => {
                          const detailExpanded = expandedWatchlistItemCodes.includes(item.candidate.code);
                          const compareSelected = watchlistCompareCodes.includes(item.candidate.code);
                          const profile = watchlistProfileByCode[item.candidate.code];
                          const profileMessage = watchlistProfileMessages[item.candidate.code];
                          const profileLoading = watchlistProfileLoadingCode === item.candidate.code;
                          return (
                            <View key={item.candidate.code} style={styles.watchlistItem}>
                              <View style={styles.entryCopy}>
                                <View style={styles.watchlistItemHeader}>
                                  <Text style={styles.entryNote}>{item.candidate.name}</Text>
                                  <Text style={styles.watchlistBadge}>{item.observeOnly ? walletWatchlistCopy.onlyObserve : '观察'}</Text>
                                </View>
                                <Text style={styles.entryMeta}>
                                  {item.candidate.code} · {item.heatLabel} · 规则分 {item.displayScore !== null ? item.displayScore.toFixed(1) : '-'}
                                </Text>
                                <Text style={styles.entryMeta}>{item.metricLine}</Text>
                                <Text style={styles.walletBodyText}>{item.reason}</Text>
                                {item.riskLabels.length ? (
                                  <View style={styles.watchlistTagRow}>
                                    {item.riskLabels.map((label) => (
                                      <Text key={`${item.candidate.code}-${label}`} style={styles.watchlistTag}>{label}</Text>
                                    ))}
                                  </View>
                                ) : null}
                                <View style={styles.watchlistActionRow}>
                                  <Pressable onPress={() => toggleWatchlistItemDetail(item.candidate)} style={styles.walletGhostButton}>
                                    <Text style={styles.walletGhostButtonText}>{detailExpanded ? '收起详情' : '详情'}</Text>
                                  </Pressable>
                                  <Pressable onPress={() => toggleWatchlistCompare(item.candidate)} style={compareSelected ? styles.walletNeutralButton : styles.walletDismissButton}>
                                    <Text style={compareSelected ? styles.walletNeutralButtonText : styles.walletDismissButtonText}>
                                      {compareSelected ? '移出对比' : '加入对比'}
                                    </Text>
                                  </Pressable>
                                </View>
                                {detailExpanded ? (
                                  <View style={styles.watchlistDetailPanel}>
                                    <Text style={styles.walletHint}>{profileLoading ? '完整资料读取中...' : (profileMessage || watchlistDetailMessage(item.candidate, profile))}</Text>
                                    <View style={styles.fundDetailGrid}>
                                      <View style={styles.fundDetailItem}>
                                        <Text style={styles.fundDetailLabel}>申购状态</Text>
                                        <Text style={styles.fundDetailValue}>{watchlistPurchaseStatus(item.candidate, profile)}</Text>
                                      </View>
                                      <View style={styles.fundDetailItem}>
                                        <Text style={styles.fundDetailLabel}>起购金额</Text>
                                        <Text style={styles.fundDetailValue}>{formatMaybeMoney(watchlistMinPurchase(item.candidate, profile))}</Text>
                                      </View>
                                      <View style={styles.fundDetailItem}>
                                        <Text style={styles.fundDetailLabel}>手续费</Text>
                                        <Text style={styles.fundDetailValue}>{formatPlainPercent(watchlistFeeRate(item.candidate, profile))}</Text>
                                      </View>
                                      <View style={styles.fundDetailItem}>
                                        <Text style={styles.fundDetailLabel}>最新净值/价格</Text>
                                        <Text style={styles.fundDetailValue}>{formatMaybeNav(watchlistLatestValue(item.candidate, profile))}</Text>
                                      </View>
                                      <View style={styles.fundDetailItem}>
                                        <Text style={styles.fundDetailLabel}>净值日期</Text>
                                        <Text style={styles.fundDetailValue}>{formatMaybeDateText(profile?.latestValueDate)}</Text>
                                      </View>
                                      <View style={styles.fundDetailItem}>
                                        <Text style={styles.fundDetailLabel}>近1月</Text>
                                        <Text style={styles.fundDetailValue}>{formatMaybePercent(watchlistReturn(item.candidate, 'return1m'))}</Text>
                                      </View>
                                      <View style={styles.fundDetailItem}>
                                        <Text style={styles.fundDetailLabel}>近3月</Text>
                                        <Text style={styles.fundDetailValue}>{formatMaybePercent(watchlistReturn(item.candidate, 'return3m'))}</Text>
                                      </View>
                                      <View style={styles.fundDetailItem}>
                                        <Text style={styles.fundDetailLabel}>近1年</Text>
                                        <Text style={styles.fundDetailValue}>{formatMaybePercent(watchlistReturn(item.candidate, 'return1y'))}</Text>
                                      </View>
                                      <View style={styles.fundDetailItem}>
                                        <Text style={styles.fundDetailLabel}>最大回撤</Text>
                                        <Text style={styles.fundDetailValue}>{formatMaybePercent(item.candidate.performance.maxDrawdown1y)}</Text>
                                      </View>
                                      <View style={styles.fundDetailItem}>
                                        <Text style={styles.fundDetailLabel}>波动率</Text>
                                        <Text style={styles.fundDetailValue}>{formatPlainPercent(item.candidate.performance.volatility1y)}</Text>
                                      </View>
                                      <View style={styles.fundDetailItem}>
                                        <Text style={styles.fundDetailLabel}>基金经理</Text>
                                        <Text style={styles.fundDetailValue}>{formatMaybeText(watchlistManager(item.candidate, profile))}</Text>
                                      </View>
                                      <View style={styles.fundDetailItem}>
                                        <Text style={styles.fundDetailLabel}>基金公司</Text>
                                        <Text style={styles.fundDetailValue}>{formatMaybeText(watchlistCompany(item.candidate, profile))}</Text>
                                      </View>
                                      <View style={styles.fundDetailItem}>
                                        <Text style={styles.fundDetailLabel}>跟踪标的</Text>
                                        <Text style={styles.fundDetailValue}>{formatMaybeText(profile?.trackingTarget)}</Text>
                                      </View>
                                      <View style={styles.fundDetailItem}>
                                        <Text style={styles.fundDetailLabel}>跟踪方式</Text>
                                        <Text style={styles.fundDetailValue}>{formatMaybeText(profile?.trackingMethod)}</Text>
                                      </View>
                                      <View style={styles.fundDetailItem}>
                                        <Text style={styles.fundDetailLabel}>评级/规模</Text>
                                        <Text style={styles.fundDetailValue}>{watchlistRatingOrScale(profile)}</Text>
                                      </View>
                                      <View style={styles.fundDetailItem}>
                                        <Text style={styles.fundDetailLabel}>资料完整度</Text>
                                        <Text style={styles.fundDetailValue}>{watchlistProfileCompleteness(item.candidate, profile)}</Text>
                                      </View>
                                    </View>
                                  </View>
                                ) : null}
                              </View>
                            </View>
                          );
                        }) : (
                          <Text style={styles.walletHint}>这一组今天还没整理出可看的名单。</Text>
                        )}
                      </View>
                    );
                  })}
                </>
              ) : (
                <Text style={styles.emptyText}>{walletWatchlist?.warnings[0] ?? walletWatchlistCopy.empty}</Text>
              )}
              {walletWatchlist?.warnings.length ? (
                <Text style={styles.walletHint}>观察池提醒：{walletWatchlist.warnings[0]}</Text>
              ) : null}
              {walletWatchlist ? <Text style={styles.walletHint}>整理时间：{formatDate(walletWatchlist.updatedAt)}</Text> : null}
            </View>

            <View style={styles.walletCard}>
              <View>
                <View style={styles.walletInlineTitleRow}>
                  <Text style={styles.sectionTitle}>找一只基金</Text>
                  <Pressable onPress={() => void searchWalletFunds()} style={styles.walletInlineButton}>
                    <Text numberOfLines={1} style={styles.walletInlineButtonText}>{fundSearchLoading ? '查找中' : '找基金'}</Text>
                  </Pressable>
                </View>
                <Text style={styles.walletHint}>先查真实资料，再交给白云小姐分析。</Text>
              </View>
              <TextInput
                onChangeText={setFundSearchQuery}
                placeholder="输入基金代码或名字，比如 000001"
                style={styles.input}
                value={fundSearchQuery}
              />
              {fundSearchMessage ? <Text style={styles.walletHint}>{fundSearchMessage}</Text> : null}
              {fundSearchResults.length ? (
                <View style={styles.fundSearchResultList}>
                  {fundSearchResults.map((item) => (
                    <Pressable
                      key={item.code}
                      onPress={() => void selectWalletFundSearchResult(item)}
                      style={styles.walletListRow}
                    >
                      <View style={styles.entryCopy}>
                        <Text style={styles.entryNote}>{item.name}</Text>
                        <Text style={styles.entryMeta}>
                          {item.code} · {item.type || '基金'} · {item.pinyinShort || '-'}
                        </Text>
                      </View>
                      <Text style={styles.walletGhostButtonText}>选这只</Text>
                    </Pressable>
                  ))}
                </View>
              ) : null}
              {fundSearchCandidate ? (
                <View style={styles.decisionCard}>
                  <View style={styles.decisionHeader}>
                    <View style={styles.entryCopy}>
                      <Text style={styles.decisionTitle}>{fundSearchProfile?.name ?? fundSearchCandidate.name}</Text>
                      <Text style={styles.entryMeta}>
                        {fundSearchCandidate.code} · {fundSearchProfile?.type || fundSearchCandidate.type || '基金'} · {formatSourceTypeLabel(fundSearchProfile?.sourceType ?? fundSearchCandidate.sourceType)}
                      </Text>
                    </View>
                    <Text style={styles.watchlistBadge}>{getFundPoolStatusLabel(fundSearchCandidate.poolAssessment.status)}</Text>
                  </View>
                  <View style={styles.watchlistTagRow}>
                    <Text style={styles.watchlistTag}>{fundSearchProfile?.purchaseStatus || fundSearchCandidate.purchaseStatus || '申购状态暂缺'}</Text>
                    <Text style={styles.watchlistTag}>规则分 {formatMaybeNumber(fundSearchCandidate.score.finalScore, 1)}</Text>
                    {fundProfileLoading ? <Text style={styles.watchlistTag}>资料读取中</Text> : null}
                  </View>
                  {fundProfileMessage ? <Text style={styles.walletHint}>{fundProfileMessage}</Text> : null}

                  <View style={styles.fundDetailSection}>
                    <Text style={styles.fundDetailTitle}>基础资料</Text>
                    <View style={styles.fundDetailGrid}>
                      <View style={styles.fundDetailItem}>
                        <Text style={styles.fundDetailLabel}>基金公司</Text>
                        <Text style={styles.fundDetailValue}>{formatMaybeText(fundSearchProfile?.company ?? String(fundSearchCandidate.extra.company ?? ''))}</Text>
                      </View>
                      <View style={styles.fundDetailItem}>
                        <Text style={styles.fundDetailLabel}>基金经理</Text>
                        <Text style={styles.fundDetailValue}>{formatMaybeText(fundSearchProfile?.manager ?? String(fundSearchCandidate.extra.manager ?? ''))}</Text>
                      </View>
                      <View style={styles.fundDetailItem}>
                        <Text style={styles.fundDetailLabel}>成立日期</Text>
                        <Text style={styles.fundDetailValue}>{formatMaybeDateText(fundSearchProfile?.inceptionDate ?? String(fundSearchCandidate.extra.inceptionDate ?? ''))}</Text>
                      </View>
                      <View style={styles.fundDetailItem}>
                        <Text style={styles.fundDetailLabel}>基金规模</Text>
                        <Text style={styles.fundDetailValue}>{formatMaybeMoney(fundSearchProfile?.latestScale)}</Text>
                      </View>
                      <View style={styles.fundDetailItem}>
                        <Text style={styles.fundDetailLabel}>跟踪标的</Text>
                        <Text style={styles.fundDetailValue}>{formatMaybeText(fundSearchProfile?.trackingTarget)}</Text>
                      </View>
                      <View style={styles.fundDetailItem}>
                        <Text style={styles.fundDetailLabel}>跟踪方式</Text>
                        <Text style={styles.fundDetailValue}>{formatMaybeText(fundSearchProfile?.trackingMethod)}</Text>
                      </View>
                    </View>
                  </View>

                  <View style={styles.fundDetailSection}>
                    <Text style={styles.fundDetailTitle}>交易资料</Text>
                    <View style={styles.fundDetailGrid}>
                      <View style={styles.fundDetailItem}>
                        <Text style={styles.fundDetailLabel}>申购状态</Text>
                        <Text style={styles.fundDetailValue}>{formatMaybeText(fundSearchProfile?.purchaseStatus ?? fundSearchCandidate.purchaseStatus)}</Text>
                      </View>
                      <View style={styles.fundDetailItem}>
                        <Text style={styles.fundDetailLabel}>赎回状态</Text>
                        <Text style={styles.fundDetailValue}>{formatMaybeText(fundSearchProfile?.redeemStatus ?? String(fundSearchCandidate.extra.redeemStatus ?? ''))}</Text>
                      </View>
                      <View style={styles.fundDetailItem}>
                        <Text style={styles.fundDetailLabel}>起购金额</Text>
                        <Text style={styles.fundDetailValue}>{formatMaybeMoney(fundSearchProfile?.minPurchaseAmount ?? Number(fundSearchCandidate.extra.minPurchaseAmount))}</Text>
                      </View>
                      <View style={styles.fundDetailItem}>
                        <Text style={styles.fundDetailLabel}>日限额</Text>
                        <Text style={styles.fundDetailValue}>{formatMaybeMoney(fundSearchProfile?.dailyLimit ?? Number(fundSearchCandidate.extra.dailyLimit))}</Text>
                      </View>
                      <View style={styles.fundDetailItem}>
                        <Text style={styles.fundDetailLabel}>手续费</Text>
                        <Text style={styles.fundDetailValue}>{formatPlainPercent(fundSearchProfile?.feeRate ?? fundSearchCandidate.feeRate)}</Text>
                      </View>
                      <View style={styles.fundDetailItem}>
                        <Text style={styles.fundDetailLabel}>净值日期</Text>
                        <Text style={styles.fundDetailValue}>{formatMaybeDateText(fundSearchProfile?.latestValueDate)}</Text>
                      </View>
                    </View>
                  </View>

                  <View style={styles.fundDetailSection}>
                    <Text style={styles.fundDetailTitle}>表现与风险</Text>
                    <View style={styles.fundDetailGrid}>
                      <View style={styles.fundDetailItem}>
                        <Text style={styles.fundDetailLabel}>最新净值</Text>
                        <Text style={styles.fundDetailValue}>{formatMaybeNav(fundSearchProfile?.latestValue ?? fundSearchCandidate.latestValue)}</Text>
                      </View>
                      <View style={styles.fundDetailItem}>
                        <Text style={styles.fundDetailLabel}>近1周</Text>
                        <Text style={styles.fundDetailValue}>{formatMaybePercent(fundSearchCandidate.performance.return1w ?? fundSearchCandidate.return1w)}</Text>
                      </View>
                      <View style={styles.fundDetailItem}>
                        <Text style={styles.fundDetailLabel}>近1月</Text>
                        <Text style={styles.fundDetailValue}>{formatMaybePercent(fundSearchCandidate.performance.return1m ?? fundSearchCandidate.return1m)}</Text>
                      </View>
                      <View style={styles.fundDetailItem}>
                        <Text style={styles.fundDetailLabel}>近3月</Text>
                        <Text style={styles.fundDetailValue}>{formatMaybePercent(fundSearchCandidate.performance.return3m ?? fundSearchCandidate.return3m)}</Text>
                      </View>
                      <View style={styles.fundDetailItem}>
                        <Text style={styles.fundDetailLabel}>近6月</Text>
                        <Text style={styles.fundDetailValue}>{formatMaybePercent(fundSearchCandidate.performance.return6m ?? fundSearchCandidate.return6m)}</Text>
                      </View>
                      <View style={styles.fundDetailItem}>
                        <Text style={styles.fundDetailLabel}>近1年</Text>
                        <Text style={styles.fundDetailValue}>{formatMaybePercent(fundSearchCandidate.performance.return1y ?? fundSearchCandidate.return1y)}</Text>
                      </View>
                      <View style={styles.fundDetailItem}>
                        <Text style={styles.fundDetailLabel}>最大回撤</Text>
                        <Text style={styles.fundDetailValue}>{formatMaybePercent(fundSearchCandidate.performance.maxDrawdown1y)}</Text>
                      </View>
                      <View style={styles.fundDetailItem}>
                        <Text style={styles.fundDetailLabel}>波动率</Text>
                        <Text style={styles.fundDetailValue}>{formatPlainPercent(fundSearchCandidate.performance.volatility1y)}</Text>
                      </View>
                    </View>
                  </View>

                  <View style={styles.fundDetailSection}>
                    <Text style={styles.fundDetailTitle}>经理公司评级</Text>
                    {hasProfileDetail(fundSearchProfile) ? (
                      <View style={styles.fundDetailGrid}>
                        <View style={styles.fundDetailItem}>
                          <Text style={styles.fundDetailLabel}>评级摘要</Text>
                          <Text style={styles.fundDetailValue}>{formatMaybeText(fundSearchProfile?.ratingInfo?.ratingSummary ?? fundSearchProfile?.rating)}</Text>
                        </View>
                        <View style={styles.fundDetailItem}>
                          <Text style={styles.fundDetailLabel}>五星家数</Text>
                          <Text style={styles.fundDetailValue}>{formatMaybeNumber(fundSearchProfile?.ratingInfo?.fiveStarCount, 0)}</Text>
                        </View>
                        <View style={styles.fundDetailItem}>
                          <Text style={styles.fundDetailLabel}>经理从业</Text>
                          <Text style={styles.fundDetailValue}>{formatMaybeText(fundSearchProfile?.managerInfo?.careerTime)}</Text>
                        </View>
                        <View style={styles.fundDetailItem}>
                          <Text style={styles.fundDetailLabel}>经理规模</Text>
                          <Text style={styles.fundDetailValue}>{formatMaybeMoney(fundSearchProfile?.managerInfo?.currentAssetScale)}</Text>
                        </View>
                        <View style={styles.fundDetailItem}>
                          <Text style={styles.fundDetailLabel}>公司规模</Text>
                          <Text style={styles.fundDetailValue}>{formatMaybeMoney(fundSearchProfile?.companyInfo?.totalAum)}</Text>
                        </View>
                        <View style={styles.fundDetailItem}>
                          <Text style={styles.fundDetailLabel}>基金/经理数</Text>
                          <Text style={styles.fundDetailValue}>
                            {formatMaybeNumber(fundSearchProfile?.companyInfo?.fundCount, 0)} / {formatMaybeNumber(fundSearchProfile?.companyInfo?.managerCount, 0)}
                          </Text>
                        </View>
                      </View>
                    ) : (
                      <Text style={styles.walletHint}>增强资料暂缺。</Text>
                    )}
                  </View>

                  <View style={styles.fundDetailSection}>
                    <Text style={styles.fundDetailTitle}>费率详情</Text>
                    <View style={styles.watchlistTagRow}>
                      <Text style={styles.watchlistTag}>交易状态 {formatFeeTableStatus(fundSearchProfile?.feeInfo?.tradeStatus)}</Text>
                      <Text style={styles.watchlistTag}>申赎金额 {formatFeeTableStatus(fundSearchProfile?.feeInfo?.purchaseAmountRule)}</Text>
                      <Text style={styles.watchlistTag}>运作费用 {formatFeeTableStatus(fundSearchProfile?.feeInfo?.operationFees)}</Text>
                      <Text style={styles.watchlistTag}>申购费 {formatFeeTableStatus(fundSearchProfile?.feeInfo?.frontPurchaseFees)}</Text>
                      <Text style={styles.watchlistTag}>赎回费 {formatFeeTableStatus(fundSearchProfile?.feeInfo?.redemptionFees)}</Text>
                    </View>
                    {fundSearchProfile?.feeInfo?.warnings.length ? (
                      <Text style={styles.walletHint}>费率提醒：{fundSearchProfile.feeInfo.warnings[0]}</Text>
                    ) : null}
                  </View>

                  <View style={styles.decisionActionRow}>
                    <Pressable onPress={() => openChatForWalletFund(fundSearchCandidate)} style={styles.walletGhostButton}>
                      <Text style={styles.walletGhostButtonText}>去聊天问问白云小姐</Text>
                    </Pressable>
                    <Pressable onPress={() => void analyzeSelectedWalletFund()} style={styles.walletPrimaryButton}>
                      <Text style={styles.walletPrimaryButtonText}>
                        {fundSearchLoading ? '白云在看' : '让白云小姐分析这只'}
                      </Text>
                    </Pressable>
                  </View>
                </View>
              ) : null}
            </View>

            <View style={styles.walletCard}>
              <View>
                <View style={styles.walletInlineTitleRow}>
                  <Text style={styles.sectionTitle}>待确认决定卡</Text>
                  <Pressable onPress={() => void createRealWalletDecision()} style={styles.walletInlineButton}>
                    <Text numberOfLines={1} style={styles.walletInlineButtonText}>
                      {walletLoading ? '白云在看' : '看看'}
                    </Text>
                  </Pressable>
                </View>
                <Text style={styles.walletHint}>从真实候选里挑一个，小仓鼠点头才作数。</Text>
              </View>
              {walletDecisionMessage ? <Text style={styles.walletHint}>{walletDecisionMessage}</Text> : null}
              {walletAutoPickTrace ? (
                <View style={styles.walletAutoPickPanel}>
                  <View style={styles.watchlistItemHeader}>
                    <Text style={styles.fundDetailTitle}>白云这次挑中</Text>
                    <Text style={styles.watchlistBadge}>{walletAutoPickTrace.selectedName}</Text>
                  </View>
                  <Text style={styles.walletBodyText}>{getAutoPickSummary(walletAutoPickTrace)}</Text>
                  {walletAutoPickTrace.poolSummaries.map((summary) => (
                    <View key={summary.candidateType} style={styles.walletAutoPickRow}>
                      <View style={styles.entryCopy}>
                        <Text style={styles.entryNote}>{summary.label}</Text>
                        <Text style={styles.entryMeta}>
                          看过 {summary.checkedCount} 只
                          {summary.topCandidate
                            ? ` · 本池挑出 ${summary.topCandidate.name} · ${getAutoPickCandidateLabel(summary.topCandidate)} · 规则分 ${formatMaybeNumber(summary.topCandidate.finalScore, 1)}`
                            : ''}
                        </Text>
                        {!summary.topCandidate && summary.skipReason ? (
                          <Text style={styles.walletAutoPickReason}>{formatFundDataWarning(summary.skipReason)}</Text>
                        ) : null}
                      </View>
                      <Text numberOfLines={1} style={styles.walletAutoPickTag}>
                        {getAutoPickRowBadge(walletAutoPickTrace, summary)}
                      </Text>
                    </View>
                  ))}
                  {walletAutoPickTrace.warnings.length ? (
                    <Text style={styles.walletHint}>候选提醒：{formatFundDataWarning(walletAutoPickTrace.warnings[0])}</Text>
                  ) : null}
                  <Text style={styles.walletHint}>挑选时间：{formatDate(walletAutoPickTrace.createdAt)}</Text>
                </View>
              ) : null}
              {pendingWalletDecisions.length ? pendingWalletDecisions.map((decision) => {
                const isThoughtExpanded = expandedWalletDecisionIds.includes(decision.id);
                const navInput = walletDecisionNavInputs[decision.id] ?? (decision.suggestedNav ? formatNav(decision.suggestedNav) : '');
                const navMeta = walletDecisionNavMeta[decision.id];
                const navLoading = walletDecisionNavLoadingId === decision.id;
                const thoughtContext = walletDecisionThoughtContexts[decision.id];
                const thoughtMessage = walletDecisionThoughtMessages[decision.id];
                return (
                <View key={decision.id} style={[styles.decisionCard, walletFocusDecisionId === decision.id ? styles.decisionCardFocused : null]}>
                  <View style={styles.decisionHeader}>
                    <View style={styles.entryCopy}>
                      <Text style={styles.decisionTitle}>{decision.fundName}</Text>
                      <Text style={styles.entryMeta}>{decision.fundCode} · {decision.fundType || '基金'} · {getDecisionActionLabel(decision.action)}</Text>
                    </View>
                    <Text style={styles.decisionAmount}>{formatMoney(decision.amount)}</Text>
                  </View>
                  <Text style={styles.walletBodyText}>我为什么想这样试：{decision.reasoning}</Text>
                  <Text style={styles.walletBodyText}>风险小铃铛：{decision.riskWarning}</Text>
                  <Text style={styles.walletBodyText}>为什么不多买：{decision.whyNotMore}</Text>
                  {decision.action === 'buy' ? (
                    <View style={styles.walletNavPanel}>
                      <View style={styles.walletInlineTitleRow}>
                        <Text style={styles.fundDetailTitle}>确认买入净值</Text>
                        <Pressable onPress={() => void refreshDecisionNav(decision)} style={styles.walletInlineButton}>
                          <Text numberOfLines={1} style={styles.walletInlineButtonText}>
                            {navLoading ? '读取中' : '刷新'}
                          </Text>
                        </Pressable>
                      </View>
                      <TextInput
                        keyboardType="decimal-pad"
                        onChangeText={(value) => updateDecisionNavInput(decision.id, value)}
                        placeholder="例如 1.0000"
                        style={styles.input}
                        value={navInput}
                      />
                      <Text style={styles.walletHint}>
                        来源：{formatDecisionNavSource(navMeta?.source ?? decision.suggestedNavSource)}
                        {navMeta?.manual ? ' · 手动确认' : ''}
                        {navMeta?.message ? ` · ${navMeta.message}` : ''}
                      </Text>
                    </View>
                  ) : null}
                  <View style={styles.decisionActionRow}>
                    <Pressable onPress={() => openChatForWalletFund(decision)} style={styles.walletGhostButton}>
                      <Text style={styles.walletGhostButtonText}>去聊天问问白云小姐</Text>
                    </Pressable>
                    <Pressable onPress={() => void toggleWalletDecisionThought(decision)} style={styles.walletGhostButton}>
                      <Text style={styles.walletGhostButtonText}>
                        {isThoughtExpanded ? '收起来' : '看看白云怎么想'}
                      </Text>
                    </Pressable>
                  </View>
                  {isThoughtExpanded ? (
                    <View style={styles.walletThoughtPanel}>
                      {thoughtContext ? (
                        <>
                          {thoughtContext.selectionTrace ? (
                            <View style={styles.walletThoughtBlock}>
                              <Text style={styles.fundDetailTitle}>白云小姐刚刚看过</Text>
                              <Text style={styles.entryMeta}>
                                最后停在 {thoughtContext.selectionTrace.selectedName}，一共看过 {thoughtContext.selectionTrace.poolSummaries.reduce((sum, item) => sum + item.checkedCount, 0)} 只候选。
                              </Text>
                            </View>
                          ) : null}
                          <View style={styles.walletThoughtBlock}>
                            <View style={styles.watchlistItemHeader}>
                              <Text style={styles.fundDetailTitle}>脑回路总结</Text>
                              <Text style={styles.watchlistBadge}>{getThoughtSignalLabel(thoughtContext.thoughtAnalysis.overallSignal)}</Text>
                            </View>
                            <Text style={styles.walletBodyText}>{thoughtContext.thoughtAnalysis.summary}</Text>
                            <View style={styles.watchlistTagRow}>
                              <Text style={styles.watchlistTag}>信心 {formatMaybeNumber(thoughtContext.thoughtAnalysis.overallConfidence, 0)}</Text>
                              <Text style={styles.watchlistTag}>可选动作 {formatAllowedActions(thoughtContext.riskAssessment.allowedActions)}</Text>
                              <Text style={styles.watchlistTag}>上限 {formatMoney(thoughtContext.riskAssessment.suggestedMaxAmount)}</Text>
                            </View>
                            {thoughtContext.riskAssessment.reasonCodes.length ? (
                              <Text style={styles.walletHint}>风险刹车原因：{thoughtContext.riskAssessment.reasonCodes.slice(0, 3).join(' / ')}</Text>
                            ) : null}
                          </View>
                          {thoughtContext.thoughtAnalysis.thoughtSignals.map((signal) => (
                            <View key={signal.thoughtId} style={styles.walletThoughtSignal}>
                              <View style={styles.watchlistItemHeader}>
                                <Text style={styles.entryNote}>{signal.label}</Text>
                                <Text style={styles.watchlistBadge}>{getThoughtSignalLabel(signal.signal)}</Text>
                              </View>
                              <Text style={styles.entryMeta}>信心 {formatMaybeNumber(signal.confidence, 0)} · 分数 {formatMaybeNumber(signal.score, 1)}</Text>
                              <Text style={styles.walletBodyText}>{signal.reasoning}</Text>
                              {signal.suggestedLimitNote ? <Text style={styles.walletHint}>{signal.suggestedLimitNote}</Text> : null}
                              {signal.warnings.length ? <Text style={styles.walletHint}>提醒：{signal.warnings[0]}</Text> : null}
                              {signal.blockReasons.length ? <Text style={styles.walletErrorText}>刹车：{signal.blockReasons[0]}</Text> : null}
                            </View>
                          ))}
                          {thoughtContext.warnings.length ? (
                            <Text style={styles.walletHint}>脑回路提醒：{thoughtContext.warnings[0]}</Text>
                          ) : null}
                          <Text style={styles.walletHint}>读取时间：{formatDate(thoughtContext.loadedAt)}</Text>
                        </>
                      ) : (
                        <Text style={styles.walletHint}>
                          {walletDecisionThoughtLoadingId === decision.id ? '白云小姐正在把脑回路摊开看。' : (thoughtMessage || '这次脑回路没拿稳。')}
                        </Text>
                      )}
                    </View>
                  ) : null}
                  <View style={styles.decisionActionRow}>
                    <Pressable onPress={() => void deferDecision(decision.id)} style={styles.walletNeutralButton}>
                      <Text style={styles.walletNeutralButtonText}>以后再说</Text>
                    </Pressable>
                    <Pressable onPress={() => void rejectDecision(decision.id)} style={styles.walletDismissButton}>
                      <Text style={styles.walletDismissButtonText}>不买啦</Text>
                    </Pressable>
                    <Pressable onPress={() => void approveDecision(decision.id)} style={styles.walletSaveButton}>
                      <Text style={styles.walletSaveButtonText}>同意记录</Text>
                    </Pressable>
                  </View>
                </View>
                );
              }) : (
                <Text style={styles.emptyText}>
                  {walletDecisionMessage || '现在没有等决定的小卡片……'}
                </Text>
              )}
              <View style={styles.walletDebugPanel}>
                <Text style={styles.walletHint}>调试工具：只用来检查本地确认流程，日常小金库会优先看真实候选。</Text>
                <Pressable onPress={() => void createTestWalletDecision()} style={styles.walletGhostButton}>
                  <Text style={styles.walletGhostButtonText}>调试：生成测试卡</Text>
                </Pressable>
                <Pressable onPress={() => void clearDebugWalletDecisions()} style={styles.walletGhostButton}>
                  <Text style={styles.walletGhostButtonText}>调试：清理测试历史</Text>
                </Pressable>
              </View>
            </View>

            <View style={styles.walletCard}>
              <View style={styles.walletSectionHeader}>
                <View style={styles.entryCopy}>
                  <Text style={styles.sectionTitle}>当前持仓</Text>
                  <Text style={styles.walletHint}>可以把外部平台已经买过的基金手动搬进来。</Text>
                </View>
                <Pressable onPress={openManualHoldingForm} style={styles.walletGhostButton}>
                  <Text style={styles.walletGhostButtonText}>我已经买了</Text>
                </Pressable>
              </View>
              {manualHoldingMessage ? <Text style={styles.walletHint}>{manualHoldingMessage}</Text> : null}
              {manualHoldingFormOpen ? (
                <View style={styles.decisionCard}>
                  <View style={styles.decisionHeader}>
                    <View style={styles.entryCopy}>
                      <Text style={styles.decisionTitle}>帮我记一只真实持仓</Text>
                      <Text style={styles.entryMeta}>会占用小金库预算，只做本地记录，不是真实下单。</Text>
                    </View>
                  </View>
                  <Text style={styles.walletHint}>基金代码</Text>
                  <TextInput
                    onChangeText={(value) => updateManualHoldingForm('fundCode', value)}
                    placeholder="例如 002234"
                    style={styles.input}
                    value={manualHoldingForm.fundCode}
                  />
                  <Text style={styles.walletHint}>基金名称</Text>
                  <TextInput
                    onChangeText={(value) => updateManualHoldingForm('fundName', value)}
                    placeholder="例如 泰信天天收益货币B"
                    style={styles.input}
                    value={manualHoldingForm.fundName}
                  />
                  <Text style={styles.walletHint}>基金类型</Text>
                  <TextInput
                    onChangeText={(value) => updateManualHoldingForm('fundType', value)}
                    placeholder="例如 money / bond / index"
                    style={styles.input}
                    value={manualHoldingForm.fundType}
                  />
                  <View style={styles.fundDetailGrid}>
                    <View style={styles.fundDetailItem}>
                      <Text style={styles.fundDetailLabel}>持有份额</Text>
                      <TextInput
                        keyboardType="decimal-pad"
                        onChangeText={(value) => updateManualHoldingForm('shares', value)}
                        placeholder="例如 10.0000"
                        style={styles.input}
                        value={manualHoldingForm.shares}
                      />
                    </View>
                    <View style={styles.fundDetailItem}>
                      <Text style={styles.fundDetailLabel}>平均成本净值</Text>
                      <TextInput
                        keyboardType="decimal-pad"
                        onChangeText={(value) => updateManualHoldingForm('avgCostNav', value)}
                        placeholder="例如 1.0000"
                        style={styles.input}
                        value={manualHoldingForm.avgCostNav}
                      />
                    </View>
                    <View style={styles.fundDetailItem}>
                      <Text style={styles.fundDetailLabel}>总成本</Text>
                      <TextInput
                        keyboardType="decimal-pad"
                        onChangeText={(value) => updateManualHoldingForm('totalCost', value)}
                        placeholder="例如 10.00"
                        style={styles.input}
                        value={manualHoldingForm.totalCost}
                      />
                    </View>
                    <View style={styles.fundDetailItem}>
                      <Text style={styles.fundDetailLabel}>最新净值</Text>
                      <TextInput
                        keyboardType="decimal-pad"
                        onChangeText={(value) => updateManualHoldingForm('latestNav', value)}
                        placeholder="例如 1.0000"
                        style={styles.input}
                        value={manualHoldingForm.latestNav}
                      />
                    </View>
                    <View style={styles.fundDetailItem}>
                      <Text style={styles.fundDetailLabel}>下跌提醒线</Text>
                      <TextInput
                        onChangeText={(value) => updateManualHoldingForm('warnDownPct', value)}
                        placeholder="例如 -3"
                        style={styles.input}
                        value={manualHoldingForm.warnDownPct}
                      />
                    </View>
                    <View style={styles.fundDetailItem}>
                      <Text style={styles.fundDetailLabel}>上涨复盘线</Text>
                      <TextInput
                        keyboardType="decimal-pad"
                        onChangeText={(value) => updateManualHoldingForm('warnUpPct', value)}
                        placeholder="例如 15"
                        style={styles.input}
                        value={manualHoldingForm.warnUpPct}
                      />
                    </View>
                  </View>
                  <Text style={styles.walletHint}>份额、平均成本净值、总成本里至少填两个，白云小姐会帮你补第三个。</Text>
                  <View style={styles.decisionActionRow}>
                    <Pressable onPress={closeManualHoldingForm} style={styles.walletNeutralButton}>
                      <Text style={styles.walletNeutralButtonText}>先不记</Text>
                    </Pressable>
                    <Pressable onPress={() => void saveManualHolding()} style={styles.walletSaveButton}>
                      <Text style={styles.walletSaveButtonText}>{walletLoading ? '记录中' : '保存持仓'}</Text>
                    </Pressable>
                  </View>
                </View>
              ) : null}
              {walletHoldings.length ? walletHoldings.map((holding) => (
                <View key={holding.id} style={styles.walletListRow}>
                  <View style={styles.entryCopy}>
                    <Text style={styles.entryNote}>{holding.fundName}</Text>
                    <Text style={styles.entryMeta}>
                      {holding.fundCode} · 份额 {holding.shares.toFixed(4)} · 净值 {formatNav(holding.latestNav)}
                    </Text>
                    <Text style={styles.entryMeta}>
                      预警线 {holding.warnDownPct ?? '-'}% / +{holding.warnUpPct ?? '-'}%
                    </Text>
                  </View>
                  <View style={styles.walletRowNumbers}>
                    <Text style={styles.walletRowStrong}>{formatMoney(holding.marketValue)}</Text>
                    <Text style={holding.floatingProfit >= 0 ? styles.walletProfitPositive : styles.walletProfitNegative}>
                      {holding.floatingProfit >= 0 ? '+' : ''}{formatMoney(holding.floatingProfit)}
                    </Text>
                  </View>
                </View>
              )) : (
                <Text style={styles.emptyText}>还没有持仓。可以同意一张买入卡，也可以把外部平台已经买过的基金手动搬进来。</Text>
              )}
            </View>

            <View style={styles.walletCard}>
              <Text style={styles.sectionTitle}>历史记录</Text>
              {walletHistory.length ? visibleWalletHistory.map((decision) => (
                <View key={decision.id} style={styles.walletListRow}>
                  <View style={styles.entryCopy}>
                    <Text style={styles.entryNote}>{decision.fundName}</Text>
                    <Text style={styles.entryMeta}>
                      {formatDate(decision.createdAt)} · {getDecisionActionLabel(decision.action)} · {getDecisionStatusLabel(decision.status)}
                    </Text>
                  </View>
                  <Text style={styles.walletRowStrong}>{formatMoney(decision.amount)}</Text>
                </View>
              )) : (
                <Text style={styles.emptyText}>历史还空空的。拒绝、暂缓或同意后的决定都会在这里排队。</Text>
              )}
              {hiddenWalletHistoryCount ? (
                <Text style={styles.walletHint}>还有 {hiddenWalletHistoryCount} 条历史先收起来啦。</Text>
              ) : null}
              {walletTransactions.length ? (
                <Text style={styles.walletHint}>交易记录：已经有 {walletTransactions.length} 条本地模拟记录。</Text>
              ) : null}
            </View>

            <View style={styles.walletCard}>
              <View style={styles.walletSectionHeader}>
                <View>
                  <Text style={styles.sectionTitle}>复盘学习</Text>
                  <Text style={styles.walletHint}>只回看过去的决定，不生成买卖建议。</Text>
                </View>
                <Pressable onPress={() => void refreshWalletDecisionReviewState()} style={styles.walletGhostButton}>
                  <Text style={styles.walletGhostButtonText}>{walletLoading ? '复盘中' : '更新复盘'}</Text>
                </Pressable>
              </View>
              <Text style={styles.walletBodyText}>{walletLearningSummary.summary}</Text>
              <View style={styles.walletMetricGrid}>
                <View style={styles.walletMetricItem}>
                  <Text style={styles.walletMetricLabel}>已复盘</Text>
                  <Text style={styles.walletMetricValue}>{walletLearningSummary.reviewedCount}</Text>
                </View>
                <View style={styles.walletMetricItem}>
                  <Text style={styles.walletMetricLabel}>等待复盘</Text>
                  <Text style={styles.walletMetricValue}>{walletLearningSummary.pendingCount}</Text>
                </View>
                <View style={styles.walletMetricItem}>
                  <Text style={styles.walletMetricLabel}>7天平均</Text>
                  <Text style={styles.walletMetricValue}>{formatMaybePercent(walletLearningSummary.averageReturn7dPct)}</Text>
                </View>
                <View style={styles.walletMetricItem}>
                  <Text style={styles.walletMetricLabel}>30天平均</Text>
                  <Text style={styles.walletMetricValue}>{formatMaybePercent(walletLearningSummary.averageReturn30dPct)}</Text>
                </View>
              </View>
              {walletLearningSummary.bestReview ? (
                <Text style={styles.walletBodyText}>
                  这次比较乖：{walletLearningSummary.bestReview.fundName}，目前复盘表现 {formatMaybePercent(walletLearningSummary.bestReview.return30dPct ?? walletLearningSummary.bestReview.return7dPct)}。
                </Text>
              ) : null}
              {walletLearningSummary.reflectionReview ? (
                <Text style={styles.walletBodyText}>
                  需要多看一眼：{walletLearningSummary.reflectionReview.fundName}，最大浮亏 {formatMaybePercent(walletLearningSummary.reflectionReview.maxDrawdownPct)}。
                </Text>
              ) : null}
              {walletLearningSummary.notes.map((note) => (
                <Text key={note} style={styles.walletHint}>{note}</Text>
              ))}
              {walletLearningSummary.warnings.map((warning) => (
                <Text key={warning} style={styles.walletErrorText}>{warning}</Text>
              ))}
            </View>

            <View style={styles.walletCard}>
              <View style={styles.walletSectionHeader}>
                <View>
                  <Text style={styles.sectionTitle}>完整形态检查</Text>
                  <Text style={styles.walletHint}>只做体检，不写决定卡，也不动小钱钱。</Text>
                </View>
                <Text style={styles.watchlistBadge}>{getWalletHealthStatusLabel(walletHealthReport.overallStatus)}</Text>
              </View>
              <Text style={styles.walletBodyText}>
                已就绪 {walletHealthReport.completedCapabilities.length} 项，提醒 {walletHealthReport.missingCapabilities.length} 项。
              </Text>
              {[...walletHealthReport.completedCapabilities, ...walletHealthReport.missingCapabilities].map((item) => (
                <View key={item.id} style={styles.walletListRow}>
                  <View style={styles.entryCopy}>
                    <Text style={styles.entryNote}>{item.label}</Text>
                    <Text style={styles.entryMeta}>{item.detail}</Text>
                  </View>
                  <Text style={item.status === 'ok' ? styles.walletProfitPositive : styles.walletProfitNegative}>
                    {getWalletHealthStatusLabel(item.status)}
                  </Text>
                </View>
              ))}
              <View style={styles.watchlistTagRow}>
                {walletHealthReport.safeBoundaries.map((boundary) => (
                  <Text key={boundary} style={styles.watchlistTag}>{boundary}</Text>
                ))}
              </View>
              {walletHealthReport.warnings.length ? (
                <Text style={styles.walletHint}>体检提醒：{walletHealthReport.warnings[0]}</Text>
              ) : (
                <Text style={styles.walletHint}>白云小姐的小金库路线已经收束成完整安全形态啦。</Text>
              )}
              <Text style={styles.walletHint}>检查时间：{formatDate(walletHealthReport.lastCheckedAt)}</Text>
            </View>
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#FFF8F2' },
  header: { alignItems: 'center', flexDirection: 'row', paddingHorizontal: 18, paddingBottom: 12 },
  backButton: { alignItems: 'center', height: 44, justifyContent: 'center', width: 44 },
  backText: { color: colors.ink, fontSize: 38, lineHeight: 40 },
  headerCopy: { flex: 1 },
  title: { color: colors.ink, fontSize: 25, fontWeight: '800', lineHeight: 31 },
  subtitle: { color: colors.muted, fontSize: 13, fontWeight: '600', lineHeight: 18 },
  content: { gap: 14, paddingHorizontal: 20, paddingBottom: 34 },
  mainTabRow: { backgroundColor: '#FFFFFF', borderRadius: 18, flexDirection: 'row', gap: 6, padding: 5 },
  mainTabButton: { alignItems: 'center', borderRadius: 14, flex: 1, paddingVertical: 9 },
  mainTabButtonActive: { backgroundColor: colors.primary },
  mainTabText: { color: colors.muted, fontSize: 14, fontWeight: '800' },
  mainTabTextActive: { color: '#FFFFFF' },
  walletBoundaryCard: {
    backgroundColor: '#FFFFFF',
    borderColor: '#F4D8CA',
    borderRadius: 24,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 10,
    padding: 16,
  },
  walletBoundaryHeader: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', gap: 10 },
  walletBoundaryEyebrow: { color: '#A97960', fontSize: 12, fontWeight: '700', lineHeight: 17 },
  walletBoundaryBadge: {
    backgroundColor: '#EAF5FF',
    borderRadius: 999,
    color: '#4B7898',
    fontSize: 11,
    fontWeight: '700',
    lineHeight: 16,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  walletBoundaryTitle: { color: colors.ink, fontSize: 19, fontWeight: '700', lineHeight: 25 },
  walletBoundarySummary: { color: '#7D6D65', fontSize: 14, fontWeight: '600', lineHeight: 21 },
  walletBoundaryList: { gap: 8 },
  walletBoundaryItem: { alignItems: 'flex-start', flexDirection: 'row', gap: 8 },
  walletBoundaryDot: { backgroundColor: '#F1A58D', borderRadius: 4, height: 8, marginTop: 7, width: 8 },
  walletBoundaryText: { color: colors.muted, flex: 1, fontSize: 13, fontWeight: '500', lineHeight: 20 },
  walletAccountCard: { backgroundColor: '#FFFFFF', borderRadius: 26, gap: 12, padding: 18 },
  walletCard: { backgroundColor: '#FFFFFF', borderRadius: 24, gap: 12, padding: 16 },
  walletSectionHeader: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  walletHint: { color: colors.muted, fontSize: 12, fontWeight: '500', lineHeight: 18, marginTop: 2 },
  walletErrorText: { color: '#D97867', fontSize: 13, fontWeight: '600', lineHeight: 19 },
  walletMetricGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  walletMetricItem: { backgroundColor: '#FFF8F4', borderRadius: 16, flexBasis: '47%', flexGrow: 1, padding: 12 },
  walletMetricLabel: { color: colors.muted, fontSize: 12, fontWeight: '600', lineHeight: 17 },
  walletMetricValue: { color: colors.ink, fontSize: 17, fontWeight: '700', lineHeight: 23, marginTop: 4 },
  walletProfitText: { fontSize: 14, fontWeight: '700', lineHeight: 20 },
  walletProfitPositive: { color: '#D97867', fontSize: 13, fontWeight: '700', lineHeight: 19 },
  walletProfitNegative: { color: '#609E74', fontSize: 13, fontWeight: '700', lineHeight: 19 },
  walletDebugPanel: { borderTopColor: '#F0DDD5', borderTopWidth: StyleSheet.hairlineWidth, gap: 9, paddingTop: 12 },
  walletPreferencePanel: { backgroundColor: '#FFF8F4', borderRadius: 18, gap: 12, padding: 12 },
  walletPlanTextArea: { minHeight: 84, paddingTop: 10, textAlignVertical: 'top' },
  walletGhostButton: { backgroundColor: '#FFF1EA', borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7 },
  walletGhostButtonText: { color: '#A97960', fontSize: 12, fontWeight: '700' },
  walletInlineTitleRow: { alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  walletInlineButton: { backgroundColor: '#FFF1EA', borderRadius: 999, maxWidth: 96, paddingHorizontal: 12, paddingVertical: 6 },
  walletInlineButtonText: { color: '#A97960', fontSize: 12, fontWeight: '700', lineHeight: 16 },
  walletPrimaryButton: { backgroundColor: colors.primary, borderRadius: 999, paddingHorizontal: 13, paddingVertical: 8 },
  walletPrimaryButtonText: { color: '#FFFFFF', fontSize: 12, fontWeight: '700' },
  walletAutoPickPanel: { backgroundColor: '#FFF8F4', borderRadius: 18, gap: 9, padding: 12 },
  walletAutoPickRow: { alignItems: 'flex-start', borderTopColor: '#F0DDD5', borderTopWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 10, paddingTop: 9 },
  walletAutoPickReason: { color: colors.muted, fontSize: 12, fontWeight: '500', lineHeight: 18, marginTop: 4 },
  walletAutoPickTag: {
    backgroundColor: '#FFFFFF',
    borderColor: '#F4D8CA',
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    color: colors.muted,
    flexShrink: 0,
    fontSize: 11,
    fontWeight: '600',
    lineHeight: 16,
    maxWidth: 68,
    paddingHorizontal: 8,
    paddingVertical: 3,
    textAlign: 'center',
  },
  walletNavPanel: { backgroundColor: '#FFFFFF', borderColor: '#F4D8CA', borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, gap: 8, padding: 10 },
  walletThoughtPanel: { backgroundColor: '#FFFFFF', borderColor: '#F4D8CA', borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, gap: 10, padding: 12 },
  walletThoughtBlock: { gap: 7 },
  walletThoughtSignal: { backgroundColor: '#FFF8F4', borderRadius: 14, gap: 6, padding: 10 },
  fundSearchResultList: { gap: 2 },
  fundDetailSection: { gap: 8 },
  fundDetailTitle: { color: '#A97960', fontSize: 13, fontWeight: '700', lineHeight: 18 },
  fundDetailGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  fundDetailItem: { backgroundColor: '#FFFFFF', borderColor: '#F4D8CA', borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, flexBasis: '47%', flexGrow: 1, padding: 10 },
  fundDetailLabel: { color: colors.muted, fontSize: 11, fontWeight: '600', lineHeight: 16 },
  fundDetailValue: { color: colors.ink, fontSize: 13, fontWeight: '600', lineHeight: 18, marginTop: 3 },
  watchlistBadge: {
    backgroundColor: '#EAF5FF',
    borderRadius: 999,
    color: '#4B7898',
    fontSize: 11,
    fontWeight: '700',
    lineHeight: 16,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  watchlistGroup: { gap: 8 },
  watchlistGroupHeader: { alignItems: 'center', flexDirection: 'row', gap: 10, justifyContent: 'space-between' },
  watchlistGroupTitle: { color: '#A97960', fontSize: 13, fontWeight: '700', lineHeight: 18 },
  watchlistItem: { backgroundColor: '#FFF8F4', borderRadius: 16, padding: 12 },
  watchlistItemHeader: { alignItems: 'center', flexDirection: 'row', gap: 8, justifyContent: 'space-between' },
  watchlistActionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'flex-end', marginTop: 8 },
  watchlistDetailPanel: { backgroundColor: '#FFFFFF', borderColor: '#F4D8CA', borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, gap: 8, marginTop: 8, padding: 10 },
  watchlistComparePanel: { backgroundColor: '#FFF8F4', borderColor: '#FFE0D7', borderRadius: 18, borderWidth: 1, gap: 10, padding: 12 },
  watchlistCompareRows: { gap: 7 },
  watchlistCompareRow: { borderTopColor: '#F0DDD5', borderTopWidth: StyleSheet.hairlineWidth, gap: 6, paddingTop: 7 },
  watchlistCompareLabel: { color: '#A97960', fontSize: 12, fontWeight: '700', lineHeight: 17 },
  watchlistCompareValues: { flexDirection: 'row', gap: 6 },
  watchlistCompareValue: { backgroundColor: '#FFFFFF', borderRadius: 10, color: colors.ink, flex: 1, fontSize: 11, fontWeight: '600', lineHeight: 16, minHeight: 34, padding: 6, textAlign: 'center' },
  watchlistTag: {
    backgroundColor: '#FFFFFF',
    borderColor: '#F4D8CA',
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    color: colors.muted,
    fontSize: 11,
    fontWeight: '600',
    lineHeight: 16,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  watchlistTagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 2 },
  decisionCard: { backgroundColor: '#FFF8F4', borderColor: '#FFE0D7', borderRadius: 18, borderWidth: 1, gap: 9, padding: 13 },
  decisionCardFocused: { borderColor: '#F79A88', borderWidth: 2 },
  decisionHeader: { alignItems: 'flex-start', flexDirection: 'row', gap: 10, justifyContent: 'space-between' },
  decisionTitle: { color: colors.ink, fontSize: 16, fontWeight: '700', lineHeight: 22 },
  decisionAmount: { color: '#D97867', fontSize: 17, fontWeight: '700', lineHeight: 23 },
  walletBodyText: { color: '#756A62', fontSize: 13, fontWeight: '500', lineHeight: 20 },
  decisionActionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'flex-end' },
  walletNeutralButton: { backgroundColor: '#EAF5FF', borderRadius: 13, paddingHorizontal: 11, paddingVertical: 8 },
  walletNeutralButtonText: { color: '#4B7898', fontSize: 12, fontWeight: '700' },
  walletDismissButton: { backgroundColor: '#FFF1EA', borderRadius: 13, paddingHorizontal: 11, paddingVertical: 8 },
  walletDismissButtonText: { color: '#A97960', fontSize: 12, fontWeight: '700' },
  walletSaveButton: { backgroundColor: colors.primary, borderRadius: 13, paddingHorizontal: 11, paddingVertical: 8 },
  walletSaveButtonText: { color: '#FFFFFF', fontSize: 12, fontWeight: '700' },
  walletListRow: { borderBottomColor: '#F0DDD5', borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 12, paddingVertical: 12 },
  walletRowNumbers: { alignItems: 'flex-end', justifyContent: 'center' },
  walletRowStrong: { color: colors.ink, fontSize: 14, fontWeight: '700', lineHeight: 20, textAlign: 'right' },
  rangeRow: { backgroundColor: '#FFFFFF', borderRadius: 18, flexDirection: 'row', gap: 6, padding: 5 },
  rangeButton: { alignItems: 'center', borderRadius: 14, flex: 1, paddingVertical: 8 },
  rangeButtonActive: { backgroundColor: '#B2D9FF' },
  rangeText: { color: colors.muted, fontSize: 13, fontWeight: '800' },
  rangeTextActive: { color: '#35678C' },
  summaryCard: { backgroundColor: '#FFFFFF', borderRadius: 26, padding: 20 },
  summaryLabel: { color: colors.muted, fontSize: 13, fontWeight: '700' },
  summaryRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 12 },
  summaryName: { color: colors.muted, fontSize: 13, fontWeight: '700', lineHeight: 18 },
  expenseAmount: { color: '#D97867', fontSize: 25, fontWeight: '800', lineHeight: 32 },
  incomeAmount: { color: '#609E74', fontSize: 25, fontWeight: '800', lineHeight: 32, textAlign: 'right' },
  balanceText: { color: '#7D8A9A', fontSize: 12, fontWeight: '700', marginTop: 10, textAlign: 'right' },
  reportCard: { backgroundColor: '#FFFFFF', borderRadius: 24, padding: 16 },
  reportHeader: { alignItems: 'flex-start', flexDirection: 'row', justifyContent: 'space-between', gap: 10, marginBottom: 10 },
  sectionTitle: { color: colors.ink, fontSize: 18, fontWeight: '700', lineHeight: 24 },
  reportHint: { color: colors.muted, fontSize: 12, fontWeight: '600', lineHeight: 17, marginTop: 2 },
  chartTypeRow: { backgroundColor: '#FFF1EA', borderRadius: 14, flexDirection: 'row', padding: 3 },
  chartTypeButton: { borderRadius: 11, paddingHorizontal: 10, paddingVertical: 6 },
  chartTypeButtonActive: { backgroundColor: colors.primary },
  chartTypeText: { color: colors.muted, fontSize: 12, fontWeight: '800' },
  chartTypeTextActive: { color: '#FFFFFF' },
  chartRow: { flexDirection: 'row', gap: 12 },
  chartWrap: { alignItems: 'center', justifyContent: 'center', width: 132 },
  chartCenter: { alignItems: 'center', position: 'absolute' },
  chartCenterLabel: { color: colors.muted, fontSize: 11, fontWeight: '800' },
  chartCenterAmount: { color: colors.ink, fontSize: 13, fontWeight: '800', marginTop: 2 },
  emptyChart: { alignItems: 'center', justifyContent: 'center' },
  emptyRing: { borderColor: '#F3E4DD', borderRadius: 58, borderWidth: 18, height: 116, width: 116 },
  emptyChartText: { color: colors.muted, fontSize: 12, fontWeight: '700', position: 'absolute' },
  categoryList: { flex: 1, gap: 8, justifyContent: 'center' },
  categoryTotalRow: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  categoryDot: { borderRadius: 5, height: 10, width: 10 },
  categoryTotalCopy: { flex: 1 },
  categoryTotalName: { color: colors.ink, fontSize: 13, fontWeight: '800', lineHeight: 18 },
  categoryPercent: { color: colors.muted, fontSize: 11, fontWeight: '700', lineHeight: 15 },
  categoryTotalAmount: { color: colors.ink, fontSize: 12, fontWeight: '800' },
  editor: { backgroundColor: '#FFFFFF', borderRadius: 24, gap: 10, padding: 16 },
  editorHeading: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  cancelEditText: { color: '#D97867', fontSize: 12, fontWeight: '800' },
  typeRow: { backgroundColor: '#FFF1EA', borderRadius: 17, flexDirection: 'row', padding: 4 },
  typeButton: { alignItems: 'center', borderRadius: 14, flex: 1, paddingVertical: 8 },
  typeButtonActive: { backgroundColor: colors.primary },
  typeText: { color: colors.muted, fontSize: 14, fontWeight: '800' },
  typeTextActive: { color: '#FFFFFF' },
  input: {
    backgroundColor: '#FFF8F4',
    borderColor: '#FFE0D7',
    borderRadius: 14,
    borderWidth: 1,
    color: colors.ink,
    fontSize: 15,
    minHeight: 46,
    paddingHorizontal: 12,
  },
  categoryGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  categoryChip: { backgroundColor: '#FFF1EA', borderRadius: 14, paddingHorizontal: 12, paddingVertical: 7 },
  categoryChipActive: { backgroundColor: '#B2D9FF' },
  categoryText: { color: colors.muted, fontSize: 13, fontWeight: '700' },
  categoryTextActive: { color: '#35678C' },
  saveButton: { alignItems: 'center', backgroundColor: colors.primary, borderRadius: 15, minHeight: 45, justifyContent: 'center' },
  saveText: { color: '#FFFFFF', fontSize: 15, fontWeight: '800' },
  listCard: { backgroundColor: 'rgba(255,255,255,0.78)', borderRadius: 24, padding: 16 },
  entryRow: { borderBottomColor: '#F0DDD5', borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 10, paddingVertical: 12 },
  entryCopy: { flex: 1 },
  entryNote: { color: colors.ink, fontSize: 16, fontWeight: '700', lineHeight: 22 },
  entryMeta: { color: colors.muted, fontSize: 12, fontWeight: '500', lineHeight: 18, marginTop: 3 },
  entryExpense: { color: '#D97867', fontSize: 16, fontWeight: '800', lineHeight: 22 },
  entryIncome: { color: '#609E74', fontSize: 16, fontWeight: '800', lineHeight: 22 },
  emptyText: { color: colors.muted, fontSize: 14, fontWeight: '500', lineHeight: 22, paddingVertical: 16 },
});
