import type { AiConnection } from '../ai/types';
import {
  analyzeFundCandidate,
  fetchFundCandidate,
  fetchFundCandidates,
  searchFunds,
  type FundApiResponse,
  type FundCandidate,
  type FundCandidateType,
  type FundThoughtAnalysis,
} from '../backend/backendClient';
import { generateWalletDecisionDraft, type WalletGeneratedDecision } from './walletDecisionGenerator';
import {
  applyFundDataSafetyToRisk,
  assessFundApiSafety,
  buildDataSafetyNotice,
} from './walletFundDataSafety';
import { assessWalletRisk, type WalletRiskAssessment, type WalletRiskReasonCode } from './walletRiskRules';
import {
  loadOrCreateDefaultWallet,
  loadOrCreateWalletPreferences,
  loadWalletHoldings,
  loadWalletTransactions,
  type AiWallet,
  type WalletAvoidType,
  type WalletDecisionDraft,
  type WalletHolding,
  type WalletPreferenceConfig,
  type WalletPreferredPool,
  type WalletTransaction,
} from './walletStore';

type AutoCandidateType = Exclude<FundCandidateType, 'etf'>;

export type WalletFundDecisionPipelineInput = {
  apiKey?: string;
  connection?: AiConnection;
  holdings?: WalletHolding[];
  includeEtf?: boolean;
  text?: string;
  transactions?: WalletTransaction[];
  wallet?: AiWallet;
  walletPreferences?: WalletPreferenceConfig;
};

export type WalletFundSelectionCandidateSummary = {
  canBuy: boolean;
  code: string;
  finalScore: number | null;
  name: string;
  status: FundCandidate['poolAssessment']['status'];
  suggestedMaxAmount: number;
  type: string;
};

export type WalletFundSelectionPoolSummary = {
  candidateType: AutoCandidateType;
  checkedCount: number;
  label: string;
  skipReason?: string;
  topCandidate?: WalletFundSelectionCandidateSummary;
};

export type WalletFundSelectionTrace = {
  createdAt: number;
  poolSummaries: WalletFundSelectionPoolSummary[];
  selectedCode: string;
  preferenceNote?: string;
  selectedName: string;
  warnings: string[];
};

export type WalletFundDecisionReview = {
  candidate: FundCandidate;
  createdAt: number;
  draft: WalletDecisionDraft;
  generatedDecision: WalletGeneratedDecision;
  reviewId: string;
  riskAssessment: WalletRiskAssessment;
  selectionTrace?: WalletFundSelectionTrace;
  thoughtAnalysis: FundThoughtAnalysis;
};

export type WalletFundDecisionPipelineResult =
  | { kind: 'decision_ready'; notice: string; review: WalletFundDecisionReview; warnings: string[] }
  | { kind: 'unavailable'; notice: string; selectionTrace?: WalletFundSelectionTrace; warnings: string[] };

const FUND_CODE_PATTERN = /\b\d{6}\b/;
const autoCandidateTypes: AutoCandidateType[] = ['money', 'bond', 'index'];
const autoCandidateLabels: Record<AutoCandidateType, string> = {
  bond: '债券稳健池',
  index: '宽基指数池',
  money: '现金池',
};
const avoidKeywords: Record<Exclude<WalletAvoidType, 'watchlist' | 'etf'>, string[]> = {
  commodity: ['商品', '黄金', '白银', '原油', '有色', '煤炭'],
  industry: ['半导体', '通信', '医药', '军工', '新能源', '芯片', '消费', '酒', '银行', '证券'],
  qdii: ['QDII', '海外', '全球', '美国', '纳斯达克', '标普', '恒生', '港股'],
};

function makeReviewId() {
  return `wallet-decision-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function preferenceEnabled(preferences?: WalletPreferenceConfig | null) {
  return Boolean(preferences?.enabled);
}

function candidatePool(candidate: FundCandidate): WalletPreferredPool | null {
  const category = candidate.poolAssessment.category;
  return category === 'cash_parking' || category === 'stable' || category === 'broad_index' ? category : null;
}

function candidateSearchText(candidate: FundCandidate) {
  const extraText = Object.values(candidate.extra ?? {})
    .filter((value) => typeof value === 'string' || typeof value === 'number')
    .join(' ');
  return `${candidate.name} ${candidate.type} ${candidate.sourceType} ${candidate.poolAssessment.category} ${extraText}`.toUpperCase();
}

function candidateMatchesAvoidType(candidate: FundCandidate, avoidType: WalletAvoidType) {
  if (avoidType === 'watchlist') return candidate.poolAssessment.category === 'watchlist';
  const text = candidateSearchText(candidate);
  if (avoidType === 'etf') return candidate.sourceType === 'etf' || text.includes('ETF');
  return avoidKeywords[avoidType].some((keyword) => text.includes(keyword.toUpperCase()));
}

function isAvoidedByPreferences(candidate: FundCandidate, preferences?: WalletPreferenceConfig | null) {
  if (!preferenceEnabled(preferences) || !preferences?.avoidTypes.length) return false;
  return preferences.avoidTypes.some((avoidType) => candidateMatchesAvoidType(candidate, avoidType));
}

function preferredPoolScore(candidate: FundCandidate, preferences?: WalletPreferenceConfig | null) {
  if (!preferenceEnabled(preferences) || !preferences?.preferredPools.length) return 0;
  const pool = candidatePool(candidate);
  return pool && preferences.preferredPools.includes(pool) ? 1 : 0;
}

function buildPreferenceNote(preferences?: WalletPreferenceConfig | null) {
  if (!preferenceEnabled(preferences)) return '小钱钱计划这次关着，白云先不自动挑。';
  if (!preferences) return undefined;
  const parts: string[] = [];
  if (preferences.preferredPools.length) parts.push(`优先看 ${preferences.preferredPools.length} 个池子`);
  if (preferences.avoidTypes.length) parts.push(`避开 ${preferences.avoidTypes.length} 类基金`);
  if (preferences.comfortSingleAmount) parts.push(`舒服单笔 ${preferences.comfortSingleAmount.toFixed(2)} 元`);
  if (preferences.tendency.trim()) parts.push('记着近期小计划');
  return parts.length ? parts.join('，') : undefined;
}

function clampRiskAssessmentByPreference(assessment: WalletRiskAssessment, preferences?: WalletPreferenceConfig | null): WalletRiskAssessment {
  const comfortAmount = preferences?.comfortSingleAmount;
  if (!preferenceEnabled(preferences) || !comfortAmount || comfortAmount <= 0 || assessment.suggestedMaxAmount <= 0) return assessment;
  const suggestedMaxAmount = Math.min(assessment.suggestedMaxAmount, comfortAmount);
  return {
    ...assessment,
    remainingWalletLimit: Math.min(assessment.remainingWalletLimit, suggestedMaxAmount),
    suggestedMaxAmount,
  };
}

function warningCount(candidate: FundCandidate) {
  return candidate.score.warningReasons.length + candidate.poolAssessment.warnings.length;
}

function statusRank(candidate: FundCandidate) {
  if (candidate.poolAssessment.status === 'eligible') return 2;
  if (candidate.poolAssessment.status === 'observe_only') return 1;
  return 0;
}

function compareCandidatePreference(left: FundCandidate, right: FundCandidate, preferences?: WalletPreferenceConfig | null) {
  const preferredDiff = preferredPoolScore(right, preferences) - preferredPoolScore(left, preferences);
  if (preferredDiff !== 0) return preferredDiff;
  const scoreDiff = (right.score.finalScore ?? 0) - (left.score.finalScore ?? 0);
  if (scoreDiff !== 0) return scoreDiff;
  const statusDiff = statusRank(right) - statusRank(left);
  if (statusDiff !== 0) return statusDiff;
  return warningCount(left) - warningCount(right);
}

function bestCandidate(candidates: FundCandidate[]) {
  const scored = candidates
    .filter((candidate) => candidate.code && candidate.name && candidate.poolAssessment.status !== 'blocked')
    .sort(compareCandidatePreference);
  return scored[0] ?? candidates.find((candidate) => candidate.code && candidate.name) ?? null;
}

function preliminaryAssessment({
  candidate,
  currentHoldings,
  currentTransactions,
  currentWallet,
}: {
  candidate: FundCandidate;
  currentHoldings: WalletHolding[];
  currentTransactions: WalletTransaction[];
  currentWallet: AiWallet;
}) {
  return assessWalletRisk({
    candidate,
    holdings: currentHoldings,
    transactions: currentTransactions,
    wallet: currentWallet,
  });
}

function canBuyFromAssessment(assessment: WalletRiskAssessment) {
  return assessment.allowedActions.includes('buy') && assessment.suggestedMaxAmount >= 1;
}

function bestCandidateForWallet(
  candidates: FundCandidate[],
  inputs: {
    currentHoldings: WalletHolding[];
    currentTransactions: WalletTransaction[];
    currentWallet: AiWallet;
    walletPreferences?: WalletPreferenceConfig | null;
  },
) {
  const scored = candidates
    .filter((candidate) => candidate.code && candidate.name && candidate.poolAssessment.status !== 'blocked')
    .map((candidate) => ({
      assessment: preliminaryAssessment({ candidate, ...inputs }),
      candidate,
    }))
    .sort((left, right) => {
      const buyableDiff = Number(canBuyFromAssessment(right.assessment)) - Number(canBuyFromAssessment(left.assessment));
      if (buyableDiff !== 0) return buyableDiff;
      const preferredDiff = preferredPoolScore(right.candidate, inputs.walletPreferences) - preferredPoolScore(left.candidate, inputs.walletPreferences);
      if (preferredDiff !== 0) return preferredDiff;
      const amountDiff = right.assessment.suggestedMaxAmount - left.assessment.suggestedMaxAmount;
      if (amountDiff !== 0) return amountDiff;
      return compareCandidatePreference(left.candidate, right.candidate, inputs.walletPreferences);
    });
  return scored[0]?.candidate ?? bestCandidate(candidates);
}

function compareSelectablePreference(
  left: { candidate: FundCandidate; preliminaryRisk: WalletRiskAssessment },
  right: { candidate: FundCandidate; preliminaryRisk: WalletRiskAssessment },
  preferences?: WalletPreferenceConfig | null,
) {
  const buyableDiff = Number(canBuyFromAssessment(right.preliminaryRisk)) - Number(canBuyFromAssessment(left.preliminaryRisk));
  if (buyableDiff !== 0) return buyableDiff;
  const preferredDiff = preferredPoolScore(right.candidate, preferences) - preferredPoolScore(left.candidate, preferences);
  if (preferredDiff !== 0) return preferredDiff;
  const amountDiff = right.preliminaryRisk.suggestedMaxAmount - left.preliminaryRisk.suggestedMaxAmount;
  if (amountDiff !== 0) return amountDiff;
  return compareCandidatePreference(left.candidate, right.candidate, preferences);
}

function summarizeCandidate(candidate: FundCandidate, assessment: WalletRiskAssessment): WalletFundSelectionCandidateSummary {
  return {
    canBuy: canBuyFromAssessment(assessment),
    code: candidate.code,
    finalScore: candidate.score.finalScore,
    name: candidate.name,
    status: candidate.poolAssessment.status,
    suggestedMaxAmount: assessment.suggestedMaxAmount,
    type: candidate.type,
  };
}

function addRiskReason(
  assessment: WalletRiskAssessment,
  code: WalletRiskReasonCode,
  warning = code,
): WalletRiskAssessment {
  return {
    ...assessment,
    allowedActions: assessment.allowedActions.filter((action) => action !== 'buy'),
    reasonCodes: Array.from(new Set([...assessment.reasonCodes, code])),
    reasonParams: { ...assessment.reasonParams, [code]: assessment.reasonParams[code] ?? {} },
    suggestedMaxAmount: 0,
    warnings: Array.from(new Set([...assessment.warnings, warning])),
  };
}

export function extractFundCode(text: string) {
  return text.match(FUND_CODE_PATTERN)?.[0] ?? '';
}

export function extractFundNameQuery(text: string) {
  const withoutCode = text.replace(FUND_CODE_PATTERN, ' ');
  const compact = withoutCode
    .replace(/白云小姐|白云|小仓鼠|小金库|基金|理财|帮我|可以|能不能|能否|请|今天|现在/g, ' ')
    .replace(/看看|看一下|分析一下|分析|观察一下|观察|想买|买什么|怎么样|吗|呢|呀|噢|喔/g, ' ')
    .replace(/[，。！？、,.!?~～><^\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return compact.length >= 2 ? compact : '';
}

async function candidateFromCode(code: string) {
  const response = await fetchFundCandidate(code);
  return { candidate: response.data, response };
}

async function candidateFromName(text: string) {
  const query = extractFundNameQuery(text);
  if (!query) return null;
  const search = await searchFunds(query, 5);
  const first = search.data?.[0];
  if (!search.ok || !first) {
    return {
      candidate: null,
      response: {
        ok: search.ok,
        data: null,
        source: search.source,
        fetchedAt: search.fetchedAt,
        stale: search.stale,
        warnings: search.warnings,
      } satisfies FundApiResponse<FundCandidate>,
    };
  }
  return candidateFromCode(first.code);
}

async function candidateFromPools(text: string, includeEtf = false) {
  const types: FundCandidateType[] = ['money', 'bond', 'index'];
  if (includeEtf || /ETF/i.test(text)) types.push('etf');
  const warnings: string[] = [];
  for (const type of types) {
    const response = await fetchFundCandidates(type, 30, 'all');
    warnings.push(...response.warnings);
    const candidate = response.data ? bestCandidate(response.data) : null;
    if (candidate) {
      return {
        candidate,
        response: {
          ...response,
          data: candidate,
        } satisfies FundApiResponse<FundCandidate>,
      };
    }
  }
  return {
    candidate: null,
    response: {
      ok: false,
      data: null,
      source: 'none',
      fetchedAt: null,
      stale: false,
      warnings,
    } satisfies FundApiResponse<FundCandidate>,
  };
}

export async function resolveWalletFundCandidate(text: string, options?: { includeEtf?: boolean }) {
  const code = extractFundCode(text);
  if (code) return candidateFromCode(code);
  const named = await candidateFromName(text);
  if (named?.candidate) return named;
  return candidateFromPools(text, options?.includeEtf);
}

export function forceNoBuyForDataState(
  assessment: WalletRiskAssessment,
  candidateResponse: FundApiResponse<FundCandidate>,
) {
  const safetyState = assessFundApiSafety(candidateResponse, {
    requireData: true,
    requireLatestValue: (candidate) => (
      candidate?.sourceType === 'money_fund'
      || candidate?.poolAssessment.category === 'cash_parking'
      || (typeof candidate?.latestValue === 'number' && candidate.latestValue > 0)
    ),
    requirePurchaseStatus: (candidate) => Boolean(candidate?.purchaseStatus?.trim()),
  });
  let next = applyFundDataSafetyToRisk(assessment, safetyState);
  if (next.reasonCodes.includes('risk_data_missing')) next = addRiskReason(next, 'risk_data_missing');
  if (!next.allowedActions.length) next.allowedActions = ['observe', 'hold', 'pause'];
  return next;
}

async function loadWalletDecisionInputs({
  holdings,
  transactions,
  wallet,
  walletPreferences,
}: Pick<WalletFundDecisionPipelineInput, 'holdings' | 'transactions' | 'wallet' | 'walletPreferences'>) {
  const currentWallet = wallet ?? await loadOrCreateDefaultWallet({ initialBudget: 100 });
  const [currentHoldings, currentTransactions, currentPreferences] = await Promise.all([
    holdings ? Promise.resolve(holdings) : loadWalletHoldings(currentWallet.id),
    transactions ? Promise.resolve(transactions) : loadWalletTransactions(currentWallet.id),
    walletPreferences ? Promise.resolve(walletPreferences) : loadOrCreateWalletPreferences(currentWallet.id),
  ]);
  return { currentHoldings, currentPreferences, currentTransactions, currentWallet };
}

async function buildDecisionForCandidate({
  apiKey,
  candidate,
  connection,
  currentHoldings,
  currentTransactions,
  currentWallet,
  response,
  selectionTrace,
  walletPreferences,
}: {
  apiKey?: string;
  candidate: FundCandidate;
  connection?: AiConnection;
  currentHoldings: WalletHolding[];
  currentTransactions: WalletTransaction[];
  currentWallet: AiWallet;
  response: FundApiResponse<FundCandidate>;
  selectionTrace?: WalletFundSelectionTrace;
  walletPreferences?: WalletPreferenceConfig | null;
}): Promise<WalletFundDecisionPipelineResult> {
  const thoughtResponse = await analyzeFundCandidate(candidate);
  if (!thoughtResponse.ok || !thoughtResponse.data) {
    return {
      kind: 'unavailable',
      notice: '今天基金数据没拿稳，白云小姐先不乱写决定卡><',
      selectionTrace,
      warnings: thoughtResponse.warnings,
    };
  }

  let riskAssessment = assessWalletRisk({
    candidate,
    holdings: currentHoldings,
    thoughtAnalysis: thoughtResponse.data,
    transactions: currentTransactions,
    wallet: currentWallet,
  });
  riskAssessment = forceNoBuyForDataState(riskAssessment, response);
  riskAssessment = clampRiskAssessmentByPreference(riskAssessment, walletPreferences);

  const generatedDecision = await generateWalletDecisionDraft({
    apiKey,
    candidate,
    connection,
    holdings: currentHoldings,
    preferredAmount: walletPreferences?.comfortSingleAmount ?? null,
    riskAssessment,
    thoughtAnalysis: thoughtResponse.data,
    transactions: currentTransactions,
    wallet: currentWallet,
  });
  if (!generatedDecision.valid || !generatedDecision.draft) {
    return {
      kind: 'unavailable',
      notice: '今天基金数据没拿稳，白云小姐先不乱写决定卡><',
      selectionTrace,
      warnings: generatedDecision.rejectReasons,
    };
  }

  return {
    kind: 'decision_ready',
    notice: buildDataSafetyNotice(assessFundApiSafety(response, { requireData: true })) === '数据可用。'
      ? '白云小姐写好一张小卡片啦。'
      : '今天基金数据没拿稳，白云小姐只放观察小卡。',
    review: {
      candidate,
      createdAt: Date.now(),
      draft: generatedDecision.draft,
      generatedDecision,
      reviewId: makeReviewId(),
      riskAssessment,
      selectionTrace,
      thoughtAnalysis: thoughtResponse.data,
    },
    warnings: [...response.warnings, ...riskAssessment.warnings],
  };
}

export async function buildWalletFundDecisionFromText({
  apiKey,
  connection,
  holdings,
  includeEtf,
  text = '白云今天想买什么',
  transactions,
  wallet,
  walletPreferences,
}: WalletFundDecisionPipelineInput): Promise<WalletFundDecisionPipelineResult> {
  const { currentHoldings, currentPreferences, currentTransactions, currentWallet } = await loadWalletDecisionInputs({
    holdings,
    transactions,
    wallet,
    walletPreferences,
  });

  const { candidate, response } = await resolveWalletFundCandidate(text, { includeEtf });
  if (!candidate || !response.ok) {
    return {
      kind: 'unavailable',
      notice: '今天基金数据没拿稳，白云小姐先不乱写决定卡><',
      warnings: response.warnings,
    };
  }

  return buildDecisionForCandidate({
    apiKey,
    candidate,
    connection,
    currentHoldings,
    currentTransactions,
    currentWallet,
    response,
    walletPreferences: currentPreferences,
  });
}

export async function buildWalletFundDecisionFromPools({
  apiKey,
  connection,
  holdings,
  transactions,
  wallet,
  walletPreferences,
}: Omit<WalletFundDecisionPipelineInput, 'includeEtf' | 'text'>): Promise<WalletFundDecisionPipelineResult> {
  const { currentHoldings, currentPreferences, currentTransactions, currentWallet } = await loadWalletDecisionInputs({
    holdings,
    transactions,
    wallet,
    walletPreferences,
  });

  const warnings: string[] = [];
  const poolSummaries: WalletFundSelectionPoolSummary[] = [];
  const selectable: Array<{ candidate: FundCandidate; preliminaryRisk: WalletRiskAssessment; response: FundApiResponse<FundCandidate> }> = [];
  const preferenceNote = buildPreferenceNote(currentPreferences);

  if (!preferenceEnabled(currentPreferences)) {
    const selectionTrace: WalletFundSelectionTrace = {
      createdAt: Date.now(),
      poolSummaries: [],
      preferenceNote,
      selectedCode: '',
      selectedName: '还没挑出来',
      warnings: [],
    };
    return {
      kind: 'unavailable',
      notice: '小钱钱计划这次关着，白云小姐先不自动挑基金。',
      selectionTrace,
      warnings: [],
    };
  }

  for (const candidateType of autoCandidateTypes) {
    const response = await fetchFundCandidates(candidateType, 30, 'all');
    warnings.push(...response.warnings);
    const candidates = response.data ?? [];
    const availableCandidates = candidates.filter((candidate) => !isAvoidedByPreferences(candidate, currentPreferences));
    const topCandidate = response.ok && availableCandidates.length
      ? bestCandidateForWallet(availableCandidates, { currentHoldings, currentTransactions, currentWallet, walletPreferences: currentPreferences })
      : null;
    const topCandidateRisk = topCandidate
      ? clampRiskAssessmentByPreference(preliminaryAssessment({
        candidate: topCandidate,
        currentHoldings,
        currentTransactions,
        currentWallet,
      }), currentPreferences)
      : null;
    let skipReason: string | undefined;
    if (!response.ok) {
      skipReason = response.warnings[0] ?? '这个池子这次没有拿稳。';
    } else if (!candidates.length) {
      skipReason = '这个池子这次没有候选。';
    } else if (!availableCandidates.length) {
      skipReason = '小钱钱计划这次先避开这个池子。';
    } else if (!topCandidate) {
      skipReason = '这个池子里的候选都被规则拦住。';
    }

    poolSummaries.push({
      candidateType,
      checkedCount: candidates.length,
      label: autoCandidateLabels[candidateType],
      skipReason,
      topCandidate: topCandidate && topCandidateRisk ? summarizeCandidate(topCandidate, topCandidateRisk) : undefined,
    });

    if (topCandidate && topCandidateRisk) {
      selectable.push({
        candidate: topCandidate,
        preliminaryRisk: topCandidateRisk,
        response: {
          ...response,
          data: topCandidate,
        } satisfies FundApiResponse<FundCandidate>,
      });
    }
  }

  const selected = selectable.sort((left, right) => compareSelectablePreference(left, right, currentPreferences))[0] ?? null;

  if (!selected) {
    const selectionTrace: WalletFundSelectionTrace = {
      createdAt: Date.now(),
      poolSummaries,
      preferenceNote,
      selectedCode: '',
      selectedName: '还没挑出来',
      warnings: Array.from(new Set(warnings)),
    };
    return {
      kind: 'unavailable',
      notice: '今天基金数据没拿稳，白云小姐先不乱写决定卡><',
      selectionTrace,
      warnings: Array.from(new Set(warnings)),
    };
  }

  const selectionTrace: WalletFundSelectionTrace = {
    createdAt: Date.now(),
    poolSummaries,
    preferenceNote,
    selectedCode: selected.candidate.code,
    selectedName: selected.candidate.name,
    warnings: Array.from(new Set(warnings)),
  };

  return buildDecisionForCandidate({
    apiKey,
    candidate: selected.candidate,
    connection,
    currentHoldings,
    currentTransactions,
    currentWallet,
    response: selected.response,
    selectionTrace,
    walletPreferences: currentPreferences,
  });
}
