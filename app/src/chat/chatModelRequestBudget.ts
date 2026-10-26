export type ChatModelRequestKind =
  | 'initial'
  | 'tool_continuation'
  | 'protocol_correction'
  | 'tool_fact_correction'
  | 'quality_retry';

export type ChatModelRequestBudget = {
  readonly limit: number;
  consume(kind: ChatModelRequestKind): boolean;
  getSnapshot(): {
    limit: number;
    used: number;
    remaining: number;
    requests: ChatModelRequestKind[];
  };
};

export function createChatModelRequestBudget(limit: number): ChatModelRequestBudget {
  const normalizedLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
  const requests: ChatModelRequestKind[] = [];
  return {
    limit: normalizedLimit,
    consume(kind) {
      if (requests.length >= normalizedLimit) return false;
      requests.push(kind);
      return true;
    },
    getSnapshot() {
      return {
        limit: normalizedLimit,
        used: requests.length,
        remaining: normalizedLimit - requests.length,
        requests: [...requests],
      };
    },
  };
}

