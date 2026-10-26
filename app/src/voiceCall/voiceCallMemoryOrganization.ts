import type { MemoryDraftWithSourceIds } from '../memory/memoryOrganizer';
import { takeWeeklySentencePrefix } from '../memory/memoryWeeklyMaterialText';
import { stableMemoryHash } from '../memory/memoryAtomicity';
import type { VoiceCallRecord } from './voiceCallRecord';
import { buildVoiceCallMaterialMessage, getVoiceCallMemoryMessages, renderVoiceCallMaterial,
  voiceCallTurnSourceHash, type VoiceCallMaterialBinding, type VoiceCallMemoryMessage } from './voiceCallMemorySource';

export { isVoiceCallMemoryOrganizationState } from './voiceCallRecordFormat';

export type VoiceCallMemoryOrganizationMessage = VoiceCallMemoryMessage;
export type VoiceCallMemorySegment = {
  batchId: string; bindings: VoiceCallMaterialBinding[];
  mode?: 'automatic' | 'manual';
  selectionWorkId?: string; sourceStale?: boolean;
  summary?: string; summaryValid: boolean;
  candidateStatus: 'failed' | 'cached' | 'registered' | 'waiting';
  candidates?: MemoryDraftWithSourceIds[]; failureReason?: string;
};
export type VoiceCallMemoryOrganizationState = {
  version: 1; status: 'unstarted' | 'running' | 'failed' | 'remaining' | 'complete' | 'waiting';
  segments: VoiceCallMemorySegment[]; failureReason?: string;
};
export function buildVoiceCallMemoryOrganizationMessages(record: VoiceCallRecord): VoiceCallMemoryOrganizationMessage[] {
  return getVoiceCallMemoryMessages(record);
}

const directions = { incoming: 'I 主动拨出', outgoing: 'you 主动拨入', test: '测试接通' };
const endings = { 'app-left': 'App 离开', 'assistant-ended': 'I 结束', 'duration-limit': '达到通话时长上限',
  'line-disconnected': '电话线断开', 'user-hangup': 'you 挂断' };

export function prepareVoiceCallMemoryBatch(record: VoiceCallRecord, processed: readonly VoiceCallMaterialBinding[] = []) {
  const turns = record.turns.filter(turn => !!turn.text.trim());
  const bindings: VoiceCallMaterialBinding[] = [];
  const messages: VoiceCallMemoryMessage[] = [];
  const lines: string[] = [];
  const metadata = JSON.stringify({ direction: directions[record.direction], startedAt: new Date(record.startedAt).toISOString(),
    endedAt: new Date(record.endedAt).toISOString(), duration: record.durationMs, endReason: endings[record.endReason], unheardCount: record.unheardCount });
  const opening = `【本次通话材料】\n${metadata}\n`;
  let blocked = false;
  for (const turn of turns) {
    const hash = voiceCallTurnSourceHash(turn);
    let start = 0;
    const ranges = processed.filter(binding => binding.turnId === turn.turnId && binding.role === turn.role && binding.sourceHash === hash)
      .sort((a,b) => a.start - b.start);
    for (const range of ranges) { if (range.start > start) break; start = Math.max(start, range.end); }
    if (start >= turn.text.length) continue;
    if (messages.length >= 30) break;
    const full = buildVoiceCallMaterialMessage(record, turn, start);
    const clues = turn.role === 'you' ? JSON.stringify({ confidence: turn.confidence, emotionHint: turn.emotion }) : '';
    const prefixSize = renderVoiceCallMaterial({ ...full.message, content: '' }, full.binding).length + (clues && clues !== '{}' ? clues.length + 1 : 0) + 1;
    const headingSize = `原话范围：片段；${bindings[0]?.messageId ?? full.binding.messageId}—${full.binding.messageId}\n`.length;
    const text = takeWeeklySentencePrefix(turn.text.slice(start), 6000 - opening.length - headingSize
      - lines.join('\n').length - (lines.length ? 1 : 0) - prefixSize);
    if (!text.trim()) { blocked = messages.length === 0; break; }
    const part = buildVoiceCallMaterialMessage(record, turn, start, start + text.length);
    const line = `${clues && clues !== '{}' ? `${clues}\n` : ''}${renderVoiceCallMaterial(part.message, part.binding)}`;
    bindings.push(part.binding); messages.push(part.message); lines.push(line);
    if (start + text.length < turn.text.length) break;
  }
  const all = [...processed, ...bindings];
  const remaining = turns.some(turn => {
    let end = 0;
    for (const binding of all.filter(item => item.turnId === turn.turnId && item.role === turn.role && item.sourceHash === voiceCallTurnSourceHash(turn))
      .sort((a,b) => a.start - b.start)) { if (binding.start > end) break; end = Math.max(end, binding.end); }
    return end < turn.text.length;
  });
  const entire = !processed.length && !remaining && bindings.length === turns.length && bindings.every(binding => binding.start === 0);
  const range = bindings.length ? `${bindings[0].messageId}—${bindings[bindings.length-1].messageId}` : '';
  const materialText = `【本次通话材料】\n${metadata}\n原话范围：${entire ? '全文' : '片段'}；${range}\n${lines.join('\n')}`;
  if (materialText.length > 6000) throw new Error('MEMORY_VOICE_MATERIAL_BUDGET');
  return { bindings, messages, materialText, remaining, blocked,
    batchId: `memory-ingestion-voice-range-${stableMemoryHash(JSON.stringify([record.callId, bindings]))}` };
}
