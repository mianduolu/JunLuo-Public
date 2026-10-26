import type { BaiyunActionIntentId } from './actionIntent';

export const BAIYUN_CHAT_FIXED_ACTION_IDS = [
  'affection',
  'affirm_bond',
  'retain',
  'repair',
  'desire',
  'soothe',
  'care_check',
  'guide',
  'protect',
  'share',
  'explore',
  'play',
  'confide',
  'collaborate',
] as const satisfies readonly BaiyunActionIntentId[];

export type BaiyunChatFixedActionId = typeof BAIYUN_CHAT_FIXED_ACTION_IDS[number];

export type BaiyunChatFixedActionRejectionCode =
  | 'model_omitted'
  | 'invalid_shape'
  | 'unknown_action';

export type BaiyunChatFixedActionParseResult =
  | {
      status: 'valid';
      action: BaiyunChatFixedActionId | null;
      diagnostic: { rejectionCodes: [] };
    }
  | {
      status: 'unresolved';
      action: null;
      reason: 'action_missing' | 'invalid_action_shape' | 'unknown_action';
      diagnostic: { rejectionCodes: BaiyunChatFixedActionRejectionCode[] };
    };

const FIXED_ACTION_IDS = new Set<string>(BAIYUN_CHAT_FIXED_ACTION_IDS);

export function parseBaiyunChatFixedAction(value: unknown): BaiyunChatFixedActionParseResult {
  if (value === undefined) {
    return {
      status: 'unresolved',
      action: null,
      reason: 'action_missing',
      diagnostic: { rejectionCodes: ['model_omitted'] },
    };
  }
  if (value === null) {
    return { status: 'valid', action: null, diagnostic: { rejectionCodes: [] } };
  }
  if (typeof value !== 'string') {
    return {
      status: 'unresolved',
      action: null,
      reason: 'invalid_action_shape',
      diagnostic: { rejectionCodes: ['invalid_shape'] },
    };
  }
  const normalizedAction = value.trim().toLowerCase();
  if (!FIXED_ACTION_IDS.has(normalizedAction)) {
    return {
      status: 'unresolved',
      action: null,
      reason: 'unknown_action',
      diagnostic: { rejectionCodes: ['unknown_action'] },
    };
  }
  return {
    status: 'valid',
    action: normalizedAction as BaiyunChatFixedActionId,
    diagnostic: { rejectionCodes: [] },
  };
}
