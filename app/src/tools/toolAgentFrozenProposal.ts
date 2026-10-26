import { createToolAgentInputHash } from './toolAgentHostIdentity';

export const TOOL_AGENT_FROZEN_PROPOSAL_TTL_MS = 15 * 60 * 1000;

export type JunLuoToolAgentConfirmationPresentation = {
  title: string;
  summary?: string;
  fields: Array<{
    label: string;
    value: string;
  }>;
};

export type JunLuoToolAgentFrozenProposal = {
  proposalId: string;
  turnId: string;
  providerCallId: string;
  auditId: string;
  toolId: string;
  inputHash: string;
  dataEpoch: number;
  createdAt: number;
  expiresAt: number;
  presentation: JunLuoToolAgentConfirmationPresentation;
};

export type JunLuoToolAgentFrozenProposalDecision =
  | 'confirmed'
  | 'declined'
  | 'expired'
  | 'aborted';

type FrozenRecord = {
  proposal: JunLuoToolAgentFrozenProposal;
  input: Record<string, unknown>;
  decision?: JunLuoToolAgentFrozenProposalDecision;
  listeners: Set<(decision: JunLuoToolAgentFrozenProposalDecision) => void>;
};

function createProposalId() {
  return `tool-proposal-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function clonePresentation(presentation: JunLuoToolAgentConfirmationPresentation) {
  return {
    ...presentation,
    fields: presentation.fields.map((field) => ({ ...field })),
  };
}

function cloneProposal(proposal: JunLuoToolAgentFrozenProposal) {
  return {
    ...proposal,
    presentation: clonePresentation(proposal.presentation),
  };
}

export type JunLuoToolAgentFrozenProposalStore = {
  freeze(input: {
    proposalId?: string;
    turnId: string;
    providerCallId: string;
    auditId: string;
    toolId: string;
    rawInput: Record<string, unknown>;
    dataEpoch: number;
    presentation: JunLuoToolAgentConfirmationPresentation;
    createdAt?: number;
    expiresAt?: number;
  }): JunLuoToolAgentFrozenProposal;
  decide(proposalId: string, decision: Extract<JunLuoToolAgentFrozenProposalDecision, 'confirmed' | 'declined'>): boolean;
  wait(proposalId: string, signal: AbortSignal): Promise<JunLuoToolAgentFrozenProposalDecision>;
  consumeConfirmed(input: {
    proposalId: string;
    turnId: string;
    providerCallId: string;
    auditId: string;
    toolId: string;
    inputHash: string;
    dataEpoch: number;
    now?: number;
  }): Record<string, unknown> | null;
  amend(input: {
    proposalId: string;
    toolId: string;
    rawInput: Record<string, unknown>;
    presentation: JunLuoToolAgentConfirmationPresentation;
  }): JunLuoToolAgentFrozenProposal | null;
  getInput(proposalId: string): Record<string, unknown> | null;
  get(proposalId: string): JunLuoToolAgentFrozenProposal | null;
  expireAll(): void;
};

export function createToolAgentFrozenProposalStore(
  now: () => number = Date.now,
): JunLuoToolAgentFrozenProposalStore {
  const records = new Map<string, FrozenRecord>();
  const settle = (record: FrozenRecord, decision: JunLuoToolAgentFrozenProposalDecision) => {
    if (record.decision) return false;
    record.decision = decision;
    record.listeners.forEach((listener) => listener(decision));
    record.listeners.clear();
    return true;
  };
  return {
    freeze(input) {
      const createdAt = input.createdAt ?? now();
      const expiresAt = input.expiresAt ?? createdAt + TOOL_AGENT_FROZEN_PROPOSAL_TTL_MS;
      if (expiresAt <= createdAt) throw new Error('TOOL_AGENT_PROPOSAL_EXPIRY_INVALID');
      const proposal: JunLuoToolAgentFrozenProposal = {
        proposalId: input.proposalId ?? createProposalId(),
        turnId: input.turnId,
        providerCallId: input.providerCallId,
        auditId: input.auditId,
        toolId: input.toolId,
        inputHash: createToolAgentInputHash(input.rawInput),
        dataEpoch: input.dataEpoch,
        createdAt,
        expiresAt,
        presentation: clonePresentation(input.presentation),
      };
      if (records.has(proposal.proposalId)) throw new Error('TOOL_AGENT_PROPOSAL_DUPLICATE');
      records.set(proposal.proposalId, {
        proposal,
        input: { ...input.rawInput },
        listeners: new Set(),
      });
      return cloneProposal(proposal);
    },
    decide(proposalId, decision) {
      const record = records.get(proposalId);
      if (!record) return false;
      if (record.proposal.expiresAt <= now()) return settle(record, 'expired');
      return settle(record, decision);
    },
    wait(proposalId, signal) {
      const record = records.get(proposalId);
      if (!record) return Promise.resolve('expired');
      if (record.decision) return Promise.resolve(record.decision);
      if (record.proposal.expiresAt <= now()) {
        settle(record, 'expired');
        return Promise.resolve('expired');
      }
      if (signal.aborted) return Promise.resolve('aborted');
      return new Promise((resolve) => {
        let timeout: ReturnType<typeof setTimeout>;
        const listener = (decision: JunLuoToolAgentFrozenProposalDecision) => {
          clearTimeout(timeout);
          signal.removeEventListener('abort', abort);
          resolve(decision);
        };
        const abort = () => {
          clearTimeout(timeout);
          record.listeners.delete(listener);
          resolve('aborted');
        };
        timeout = setTimeout(() => {
          record.listeners.delete(listener);
          signal.removeEventListener('abort', abort);
          settle(record, 'expired');
          resolve('expired');
        }, Math.max(0, record.proposal.expiresAt - now()));
        record.listeners.add(listener);
        signal.addEventListener('abort', abort, { once: true });
      });
    },
    consumeConfirmed(expectation) {
      const record = records.get(expectation.proposalId);
      if (!record || record.decision !== 'confirmed') return null;
      const proposal = record.proposal;
      const currentTime = expectation.now ?? now();
      const matches = proposal.turnId === expectation.turnId
        && proposal.providerCallId === expectation.providerCallId
        && proposal.auditId === expectation.auditId
        && proposal.toolId === expectation.toolId
        && proposal.inputHash === expectation.inputHash
        && proposal.dataEpoch === expectation.dataEpoch
        && proposal.expiresAt > currentTime;
      if (!matches) return null;
      records.delete(expectation.proposalId);
      return { ...record.input };
    },
    amend(input) {
      const record = records.get(input.proposalId);
      if (
        !record
        || record.decision
        || record.proposal.toolId !== input.toolId
        || record.proposal.expiresAt <= now()
      ) {
        return null;
      }
      record.input = { ...input.rawInput };
      record.proposal = {
        ...record.proposal,
        inputHash: createToolAgentInputHash(record.input),
        presentation: clonePresentation(input.presentation),
      };
      return cloneProposal(record.proposal);
    },
    getInput(proposalId) {
      const record = records.get(proposalId);
      if (!record || record.decision || record.proposal.expiresAt <= now()) return null;
      return { ...record.input };
    },
    get(proposalId) {
      const record = records.get(proposalId);
      return record ? cloneProposal(record.proposal) : null;
    },
    expireAll() {
      records.forEach((record) => settle(record, 'expired'));
      records.clear();
    },
  };
}

export const toolAgentFrozenProposalStore = createToolAgentFrozenProposalStore();

export function decideToolAgentFrozenProposal(
  proposalId: string,
  decision: Extract<JunLuoToolAgentFrozenProposalDecision, 'confirmed' | 'declined'>,
) {
  return toolAgentFrozenProposalStore.decide(proposalId, decision);
}

export function getToolAgentFrozenProposalInput(proposalId: string) {
  return toolAgentFrozenProposalStore.getInput(proposalId);
}

export function amendToolAgentFrozenProposal(input: {
  proposalId: string;
  toolId: string;
  rawInput: Record<string, unknown>;
  presentation: JunLuoToolAgentConfirmationPresentation;
}) {
  return toolAgentFrozenProposalStore.amend(input);
}
