import type { AiConnection } from '../ai/types';
import { beginPromptCacheMetric } from '../ai/promptCacheMetrics';
import type { FundCandidate, FundThoughtAnalysis } from '../backend/backendClient';
import {
  buildWalletAiDecisionPrompt,
  parseWalletAiDecision,
  type WalletAiDecisionRejectReason,
} from './walletAiDecisionParser';
import { buildLocalWalletDecisionCopy } from './walletDecisionCopy';
import type { AiWallet, WalletDecisionAction, WalletDecisionDraft, WalletHolding, WalletTransaction } from './walletStore';
import type { WalletRiskAssessment } from './walletRiskRules';

export type WalletGeneratedDecisionSource = 'ai' | 'local_fallback';

export type WalletGeneratedDecision = {
  action: WalletDecisionAction;
  amount: number;
  confidence: number;
  draft: WalletDecisionDraft | null;
  rejectReasons: string[];
  riskReasonCodes: string[];
  source: WalletGeneratedDecisionSource;
  sourceSignals: string[];
  valid: boolean;
};

export type WalletDecisionGeneratorInput = {
  apiKey?: string;
  candidate: FundCandidate;
  connection?: AiConnection;
  holdings: WalletHolding[];
  preferredAmount?: number | null;
  riskAssessment: WalletRiskAssessment;
  thoughtAnalysis: FundThoughtAnalysis;
  transactions: WalletTransaction[];
  wallet: AiWallet;
};

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

function pickLocalAction(riskAssessment: WalletRiskAssessment): WalletDecisionAction {
  if (riskAssessment.allowedActions.includes('buy') && riskAssessment.suggestedMaxAmount >= 1) return 'buy';
  if (riskAssessment.allowedActions.includes('observe')) return 'observe';
  if (riskAssessment.allowedActions.includes('pause')) return 'pause';
  return 'hold';
}

function localAmount(action: WalletDecisionAction, riskAssessment: WalletRiskAssessment, preferredAmount?: number | null) {
  if (action !== 'buy') return 0;
  const comfortAmount = typeof preferredAmount === 'number' && Number.isFinite(preferredAmount) && preferredAmount > 0
    ? preferredAmount
    : 10;
  return roundMoney(Math.min(comfortAmount, riskAssessment.suggestedMaxAmount));
}

function sourceSignals(thoughtAnalysis: FundThoughtAnalysis) {
  return thoughtAnalysis.thoughtSignals.map((signal) => `${signal.thoughtId}:${signal.signal}`);
}

function dedupeRepeatedReasoning(text: string) {
  const trimmed = text.trim();
  const repeated = trimmed.match(/^(.{4,}?)\s+\1$/u);
  return repeated?.[1] ?? trimmed;
}

function buildDraft({
  action,
  amount,
  candidate,
  confidence,
  reasoning,
  riskWarning,
  whyNotMore,
}: {
  action: WalletDecisionAction;
  amount: number;
  candidate: FundCandidate;
  confidence: number;
  reasoning: string;
  riskWarning: string;
  whyNotMore: string;
}): WalletDecisionDraft {
  return {
    action,
    amount,
    confidence,
    fundCode: candidate.code,
    fundName: candidate.name,
    fundType: candidate.type,
    reasoning,
    riskWarning,
    source: 'baiyun',
    whyNotMore,
  };
}

function localDecision(input: WalletDecisionGeneratorInput, rejectReasons: string[] = []): WalletGeneratedDecision {
  const action = pickLocalAction(input.riskAssessment);
  const amount = localAmount(action, input.riskAssessment, input.preferredAmount);
  const copy = buildLocalWalletDecisionCopy({
    action,
    amount,
    fundName: input.candidate.name,
    fundRiskLevel: input.riskAssessment.fundRiskLevel,
    reasonCodes: input.riskAssessment.reasonCodes,
    reasonParams: input.riskAssessment.reasonParams,
    suggestedMaxAmount: input.riskAssessment.suggestedMaxAmount,
  });
  const draft = buildDraft({
    action,
    amount,
    candidate: input.candidate,
    confidence: 60,
    reasoning: dedupeRepeatedReasoning(copy.reasoning),
    riskWarning: copy.riskWarning,
    whyNotMore: copy.whyNotMore,
  });
  return {
    action,
    amount,
    confidence: 60,
    draft,
    rejectReasons,
    riskReasonCodes: input.riskAssessment.reasonCodes,
    source: 'local_fallback',
    sourceSignals: sourceSignals(input.thoughtAnalysis),
    valid: true,
  };
}

function buildAiGeneratedDecision(input: WalletDecisionGeneratorInput, rawText: string): WalletGeneratedDecision | null {
  const parsed = parseWalletAiDecision({
    candidate: input.candidate,
    rawText,
    riskAssessment: input.riskAssessment,
    thoughtAnalysis: input.thoughtAnalysis,
  });
  if (!parsed.ok || !parsed.decision) return null;
  const draft = buildDraft({
    action: parsed.decision.action,
    amount: parsed.decision.amount,
    candidate: input.candidate,
    confidence: parsed.decision.confidence,
    reasoning: parsed.decision.reasoning,
    riskWarning: parsed.decision.riskWarning,
    whyNotMore: parsed.decision.whyNotMore,
  });
  return {
    action: parsed.decision.action,
    amount: parsed.decision.amount,
    confidence: parsed.decision.confidence,
    draft,
    rejectReasons: [],
    riskReasonCodes: input.riskAssessment.reasonCodes,
    source: 'ai',
    sourceSignals: sourceSignals(input.thoughtAnalysis),
    valid: true,
  };
}

async function generateAiDecisionText(input: WalletDecisionGeneratorInput) {
  const apiKey = input.apiKey?.trim();
  const connection = input.connection;
  if (!apiKey || !connection?.baseUrl || !connection.model) return null;

  const body = JSON.stringify({
      messages: [
        {
          content: buildWalletAiDecisionPrompt(input),
          role: 'user',
        },
      ],
      model: connection.model.trim(),
      temperature: 0.2,
  });
  const cacheMetric = beginPromptCacheMetric({ contextProfile: 'tool-task', contextSource: 'wallet.decision', connection });
  try {
    const response = await fetch(`${connection.baseUrl.trim().replace(/\/+$/, '')}/chat/completions`, {
      body,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      method: 'POST',
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as { usage?: unknown; choices?: Array<{ message?: { content?: string } }> };
    cacheMetric.recordUsage(payload?.usage);
    const content = payload.choices?.[0]?.message?.content;
    return content || null;
  } finally { cacheMetric.finish(); }
}

export async function generateWalletDecisionDraft(input: WalletDecisionGeneratorInput): Promise<WalletGeneratedDecision> {
  const aiText = await generateAiDecisionText(input).catch(() => null);
  const aiDecision = aiText ? buildAiGeneratedDecision(input, aiText) : null;
  if (aiDecision) return aiDecision;
  const rejectReasons: WalletAiDecisionRejectReason[] = aiText
    ? parseWalletAiDecision({
      candidate: input.candidate,
      rawText: aiText,
      riskAssessment: input.riskAssessment,
      thoughtAnalysis: input.thoughtAnalysis,
    }).rejectReasons
    : ['ai_unavailable'];
  return localDecision(input, rejectReasons);
}
