import type { AiConnection } from '../types';
import { getBaiyunSemanticReviewRemaining, type BaiyunSemanticReviewBudget } from './actionBudget';
import type { BaiyunBehaviorRoutingSettings } from './actionBehaviorStore';

export type BaiyunSemanticRouteDecision = {
  route: 'ollama' | 'remote' | 'local_clear' | 'local_fallback';
  connectionId?: string;
  reason:
    | 'ollama_primary'
    | 'locally_clear'
    | 'remote_review_allowed'
    | 'remote_review_disabled'
    | 'remote_connection_missing'
    | 'remote_budget_exhausted';
};

export function decideBaiyunSemanticRoute(input: {
  requiresSemanticReview: boolean;
  primaryConnection?: Pick<AiConnection, 'id' | 'preset'>;
  remoteConnection?: Pick<AiConnection, 'id' | 'preset'>;
  settings: BaiyunBehaviorRoutingSettings;
  budget: BaiyunSemanticReviewBudget;
}): BaiyunSemanticRouteDecision {
  if (input.primaryConnection?.preset === 'ollama') {
    return {
      route: 'ollama',
      connectionId: input.primaryConnection.id,
      reason: 'ollama_primary',
    };
  }
  if (!input.requiresSemanticReview) {
    return { route: 'local_clear', reason: 'locally_clear' };
  }
  if (!input.settings.remoteSemanticReviewEnabled) {
    return { route: 'local_fallback', reason: 'remote_review_disabled' };
  }
  const primaryRemote = input.primaryConnection;
  const fallbackRemote = input.remoteConnection?.preset !== 'ollama'
    ? input.remoteConnection
    : undefined;
  const remote = primaryRemote ?? fallbackRemote;
  if (!remote) {
    return { route: 'local_fallback', reason: 'remote_connection_missing' };
  }
  if (getBaiyunSemanticReviewRemaining(input.budget) <= 0) {
    return { route: 'local_fallback', reason: 'remote_budget_exhausted' };
  }
  return {
    route: 'remote',
    connectionId: remote.id,
    reason: 'remote_review_allowed',
  };
}
