import type { VoiceCallMemoryUsageReceipt } from './voiceCallMemoryUsage';
import type { VoiceCallMemoryOrganizationState } from './voiceCallMemoryOrganization';

export function isVoiceCallMemoryUsageReceipt(value: unknown): value is VoiceCallMemoryUsageReceipt {
  if (!value || typeof value !== 'object') return false;
  const item = value as VoiceCallMemoryUsageReceipt;
  return item.version === 1 && typeof item.callId === 'string' && !!item.callId
    && typeof item.turnId === 'string' && !!item.turnId
    && (item.dataEpoch === null || Number.isInteger(item.dataEpoch) && item.dataEpoch >= 0)
    && item.receipt?.version === 1 && item.receipt.operationId === `voice-call:${item.callId}:${item.turnId}`
    && Array.isArray(item.receipt.references) && item.receipt.references.every(ref => !!ref
      && typeof ref.memoryId === 'string' && !!ref.memoryId && typeof ref.targetHash === 'string'
      && (ref.commentsHash === undefined || typeof ref.commentsHash === 'string')
      && (ref.sourceVersion === undefined || typeof ref.sourceVersion === 'string'))
    && Array.isArray(item.currentStates) && item.currentStates.every(ref => !!ref
      && typeof ref.currentStateId === 'string' && !!ref.currentStateId && typeof ref.version === 'string'
      && (ref.sourceVersion === undefined || typeof ref.sourceVersion === 'string'));
}

export function isVoiceCallMemoryOrganizationState(value: unknown): value is VoiceCallMemoryOrganizationState {
  if (!value || typeof value !== 'object') return false;
  const state = value as VoiceCallMemoryOrganizationState;
  return state.version === 1 && ['unstarted','running','failed','remaining','complete','waiting'].includes(state.status)
    && Array.isArray(state.segments) && state.segments.every(part => !!part && typeof part === 'object' && typeof part.batchId === 'string'
      && (part.mode === undefined || part.mode === 'automatic' || part.mode === 'manual')
      && (part.selectionWorkId === undefined || typeof part.selectionWorkId === 'string')
      && (part.sourceStale === undefined || typeof part.sourceStale === 'boolean')
      && typeof part.summaryValid === 'boolean' && (part.summary === undefined || typeof part.summary === 'string')
      && ['failed','cached','registered','waiting'].includes(part.candidateStatus)
      && Array.isArray(part.bindings) && part.bindings.every(binding => !!binding && typeof binding === 'object' && binding.version === 1
        && typeof binding.callId === 'string' && typeof binding.sessionId === 'string' && typeof binding.turnId === 'string'
        && typeof binding.messageId === 'string' && typeof binding.sourceHash === 'string'
        && typeof binding.sentHash === 'string' && ['I','you'].includes(binding.role)
        && Number.isInteger(binding.start) && Number.isInteger(binding.end) && binding.start >= 0 && binding.end > binding.start)
      && (part.candidates === undefined || Array.isArray(part.candidates) && part.candidates.every(candidate =>
        !!candidate && typeof candidate === 'object' && typeof candidate.title === 'string'
        && typeof candidate.content === 'string' && Array.isArray(candidate.sourceMessageIds))));
}
