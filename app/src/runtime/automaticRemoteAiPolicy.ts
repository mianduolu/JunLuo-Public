import AsyncStorage from '@react-native-async-storage/async-storage';
import { stopPhoneCareFollowUp } from '../proactive/phoneCareFollowUpStore';
import { changeUnifiedContactState, finishUnifiedContactAfterRestore } from '../proactive/unifiedContactStore';
import { finishContactOpportunity } from '../proactive/unifiedContact';
import { notifyMemoryProcessingWorkAvailable } from '../memory/memoryProcessingSignals';

import {
  AUTOMATIC_REMOTE_AI_POLICY_KEY,
  defaultAutomaticRemoteAiPolicy,
  normalizeAutomaticRemoteAiPolicy,
  parseAutomaticRemoteAiPolicy,
  type AutomaticRemoteAiPolicy,
} from './automaticRemoteAiPolicyCore';

export {
  AUTOMATIC_REMOTE_AI_POLICY_KEY,
  defaultAutomaticRemoteAiPolicy,
  defaultCostSavingSettings,
  getAutomaticCostRestriction,
  isAutomaticRemoteAiAllowed,
  isTechnicalRuntimeSilentScreen,
  normalizeAutomaticRemoteAiPolicy,
  normalizeCostSavingSettings,
  parseAutomaticRemoteAiPolicy,
  type AutomaticRemoteAiPolicy,
  type AutomaticAiPurpose,
  type CostSavingSettings,
  type CostSavingWindow,
} from './automaticRemoteAiPolicyCore';

export async function loadAutomaticRemoteAiPolicy(options: { strict?: boolean } = {}) {
  try {
    const raw = await AsyncStorage.getItem(AUTOMATIC_REMOTE_AI_POLICY_KEY);
    return options.strict && raw !== null
      ? normalizeAutomaticRemoteAiPolicy(JSON.parse(raw) as unknown)
      : parseAutomaticRemoteAiPolicy(raw);
  } catch (error) {
    if (options.strict) throw error;
    return defaultAutomaticRemoteAiPolicy;
  }
}

export async function saveAutomaticRemoteAiPolicy(
  policy: AutomaticRemoteAiPolicy,
) {
  const normalized = normalizeAutomaticRemoteAiPolicy(policy);
  await AsyncStorage.setItem(
    AUTOMATIC_REMOTE_AI_POLICY_KEY,
    JSON.stringify(normalized),
  );
  if (!normalized.enabled) await stopPhoneCareFollowUp('automatic_disabled');
  if (!normalized.enabled) await changeUnifiedContactState(state => finishContactOpportunity(state, Date.now(), 'automatic_disabled'));
  notifyMemoryProcessingWorkAvailable('configuration_changed');
  return normalized;
}

export function resetAutomaticRemoteAiPolicy() {
  return saveAutomaticRemoteAiPolicy(defaultAutomaticRemoteAiPolicy);
}

/** The restore caller owns the exclusive window and must not wait for normal shared commits. */
export async function resetAutomaticRemoteAiPolicyAfterRestore() {
  const normalized = normalizeAutomaticRemoteAiPolicy(defaultAutomaticRemoteAiPolicy);
  await AsyncStorage.setItem(AUTOMATIC_REMOTE_AI_POLICY_KEY, JSON.stringify(normalized));
  await stopPhoneCareFollowUp('automatic_disabled');
  await finishUnifiedContactAfterRestore();
  notifyMemoryProcessingWorkAvailable('configuration_changed');
  return normalized;
}
