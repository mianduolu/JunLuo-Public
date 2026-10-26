import type { FundCandidate, FundThoughtAnalysis } from '../backend/backendClient';
import type { WalletDecisionAction } from './walletStore';
import type { WalletRiskAssessment } from './walletRiskRules';

export type WalletAiDecisionRejectReason =
  | 'ai_unavailable'
  | 'json_parse_failed'
  | 'invalid_shape'
  | 'action_not_allowed'
  | 'amount_invalid'
  | 'amount_over_limit'
  | 'buy_amount_too_small'
  | 'fund_code_mismatch'
  | 'confidence_too_low_for_buy'
  | 'reasoning_required'
  | 'risk_warning_required'
  | 'why_not_more_required'
  | 'blocked_promise_phrase';

export type WalletAiDecisionOutput = {
  action: WalletDecisionAction;
  amount: number;
  confidence: number;
  fundCode: string;
  reasoning: string;
  rejectIf: string[];
  riskWarning: string;
  valid: true;
  whyNotMore: string;
  whyThisAmount: string;
  whyThisFund: string;
};

export type WalletAiDecisionParseInput = {
  candidate: FundCandidate;
  rawText: string;
  riskAssessment: WalletRiskAssessment;
  thoughtAnalysis: FundThoughtAnalysis;
};

export type WalletAiDecisionParseResult = {
  decision: WalletAiDecisionOutput | null;
  ok: boolean;
  rawText?: string;
  rejectReasons: WalletAiDecisionRejectReason[];
};

type WalletDecisionAiResponse = {
  action?: unknown;
  amount?: unknown;
  confidence?: unknown;
  fundCode?: unknown;
  reasoning?: unknown;
  rejectIf?: unknown;
  riskWarning?: unknown;
  valid?: unknown;
  whyNotMore?: unknown;
  whyThisAmount?: unknown;
  whyThisFund?: unknown;
};

const BLOCKED_PROMISE_PATTERN = /稳赚|必涨|保本|无风险|一定赚钱|赶紧买|闭眼买|梭哈/;

export function stripWalletAiCodeFence(text: string) {
  return text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

function compactText(value: unknown, maxLength: number) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, maxLength) : '';
}

function parseAction(value: unknown): WalletDecisionAction | null {
  return value === 'buy' || value === 'observe' || value === 'hold' || value === 'pause' ? value : null;
}

function parseRejectIf(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => compactText(item, 120)).filter(Boolean);
}

function containsBlockedPromise(...texts: string[]) {
  return texts.some((text) => BLOCKED_PROMISE_PATTERN.test(text));
}

function failed(rawText: string, rejectReasons: WalletAiDecisionRejectReason[]): WalletAiDecisionParseResult {
  return { decision: null, ok: false, rawText, rejectReasons };
}

export function buildWalletAiDecisionPrompt({
  candidate,
  riskAssessment,
  thoughtAnalysis,
}: Omit<WalletAiDecisionParseInput, 'rawText'>) {
  return `【AI 小金库决定卡】
当前任务：以 I（白云小姐）的视角，把基金候选、风险规则和小金库分析整理成一张待确认决定卡。

只返回严格 JSON。

输出格式：
{"valid":true,"action":"buy|observe|hold|pause","fundCode":"基金代码","amount":0,"confidence":80,"reasoning":"","riskWarning":"","whyThisFund":"","whyThisAmount":"","whyNotMore":"","rejectIf":[]}

小金库定位：
小金库是 I 和小仓鼠的小额观察账本。
I 可以分析、提醒和记录。
小仓鼠确认前，不算真实买入。

字段口吻：
reasoning、riskWarning、whyThisFund、whyThisAmount、whyNotMore 使用“我 / 你 / 小仓鼠 / 白云小姐”的自然私聊视角。
语气认真、短、清楚，不吓鼠。

决策方式：
- action 从 allowedActions 里选择。
- fundCode 使用候选基金代码。
- amount 在 maxAmount 以内；observe、hold、pause 时 amount 写 0。
- confidence 表示这张卡片的参考信心，不表示收益概率。
- whyThisFund 写为什么这只基金值得观察或暂时处理。
- whyThisAmount 写为什么是这个金额或为什么金额为 0。
- whyNotMore 写为什么现在只用这个力度。
- riskWarning 写小仓鼠需要知道的风险点。
- rejectIf 写哪些条件出现时这张卡片应收回。

硬边界：
- allowedActions 没有 buy 时，action 不能写 buy。
- confidence 低于 65 时，action 不能写 buy。
- amount 不能超过 maxAmount。
- fundCode 必须等于候选基金代码。
- 不承诺收益，不催促购买，不说自动下单。
- 不使用催促、怂恿的语气。

输入：
${JSON.stringify({
    allowedActions: riskAssessment.allowedActions,
    candidate: {
      code: candidate.code,
      name: candidate.name,
      score: candidate.score,
      sourceType: candidate.sourceType,
      type: candidate.type,
    },
    maxAmount: riskAssessment.suggestedMaxAmount,
    risk: {
      fundRiskLevel: riskAssessment.fundRiskLevel,
      reasonCodes: riskAssessment.reasonCodes,
      reasonParams: riskAssessment.reasonParams,
    },
    thoughts: thoughtAnalysis.thoughtSignals.map((signal) => ({
      blockReasons: signal.blockReasons,
      confidence: signal.confidence,
      label: signal.label,
      reasoning: signal.reasoning,
      signal: signal.signal,
      thoughtId: signal.thoughtId,
      warnings: signal.warnings,
    })),
  })}

`;
}

export function parseWalletAiDecision(input: WalletAiDecisionParseInput): WalletAiDecisionParseResult {
  const rawText = input.rawText;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripWalletAiCodeFence(rawText));
  } catch {
    return failed(rawText, ['json_parse_failed']);
  }

  if (!parsed || typeof parsed !== 'object') return failed(rawText, ['invalid_shape']);
  const candidate = parsed as WalletDecisionAiResponse;
  if (candidate.valid !== true) return failed(rawText, ['invalid_shape']);

  const action = parseAction(candidate.action);
  if (!action) return failed(rawText, ['invalid_shape']);

  const rejectReasons: WalletAiDecisionRejectReason[] = [];
  if (!input.riskAssessment.allowedActions.includes(action)) rejectReasons.push('action_not_allowed');

  const amount = typeof candidate.amount === 'number' ? candidate.amount : Number(candidate.amount ?? 0);
  if (!Number.isFinite(amount)) rejectReasons.push('amount_invalid');
  const normalizedAmount = action === 'buy' && Number.isFinite(amount) ? roundMoney(amount) : 0;
  if (action === 'buy' && normalizedAmount < 1) rejectReasons.push('buy_amount_too_small');
  if (normalizedAmount > input.riskAssessment.suggestedMaxAmount) rejectReasons.push('amount_over_limit');
  if (candidate.fundCode !== input.candidate.code) rejectReasons.push('fund_code_mismatch');

  const rawConfidence = typeof candidate.confidence === 'number' ? candidate.confidence : Number(candidate.confidence ?? 0);
  const confidence = Number.isFinite(rawConfidence) ? Math.min(100, Math.max(0, rawConfidence)) : 0;
  if (action === 'buy' && confidence < 65) rejectReasons.push('confidence_too_low_for_buy');

  const whyThisFund = compactText(candidate.whyThisFund, 160);
  const whyThisAmount = compactText(candidate.whyThisAmount, 160);
  const reasoning = compactText(candidate.reasoning, 240) || [whyThisFund, whyThisAmount].filter(Boolean).join(' ');
  const riskWarning = compactText(candidate.riskWarning, 220);
  const whyNotMore = compactText(candidate.whyNotMore, 180);
  if (!reasoning) rejectReasons.push('reasoning_required');
  if (!riskWarning) rejectReasons.push('risk_warning_required');
  if (!whyNotMore) rejectReasons.push('why_not_more_required');
  if (containsBlockedPromise(reasoning, riskWarning, whyNotMore, whyThisFund, whyThisAmount)) {
    rejectReasons.push('blocked_promise_phrase');
  }

  if (rejectReasons.length > 0) return failed(rawText, rejectReasons);
  return {
    decision: {
      action,
      amount: normalizedAmount,
      confidence,
      fundCode: input.candidate.code,
      reasoning,
      rejectIf: parseRejectIf(candidate.rejectIf),
      riskWarning,
      valid: true,
      whyNotMore,
      whyThisAmount,
      whyThisFund,
    },
    ok: true,
    rawText,
    rejectReasons: [],
  };
}
