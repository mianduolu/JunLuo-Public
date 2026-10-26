import { loadCurrentStateReadSnapshot, type MemoryReadPart, type CurrentStateSourceReader } from './memoryReadMaterials';
import { currentStateVersion, loadActiveMemoryCurrentStates, type MemoryCurrentState } from './memoryCurrentStateStore';
import { memorySourceStatusLabel } from './memorySourceStatus';
import { isObservationMemorySource } from './memorySourceReader';
import { prepareObservationFragment } from './memoryObservationIngestion';

export type CurrentStateMaterial = {
  state: MemoryCurrentState; version: string; sourceVersion: string; sourceParts: MemoryReadPart[]; context: string;
};
const compact = (value: string, limit: number) => limit <= 0 ? '' : value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
function compactEnds(value: string, limit: number) {
  if (limit <= 0) return '';
  if (value.length <= limit) return value;
  const endLength = Math.floor((limit - 1) / 2);
  const start = value.slice(0, limit - 1 - endLength).replace(/[\uD800-\uDBFF]$/, '');
  const end = endLength ? value.slice(-endLength).replace(/^[\uDC00-\uDFFF]/, '') : '';
  return `${start}…${end}`;
}
const time = (at?: number) => at === undefined ? '未记录' : new Date(at).toLocaleString('zh-CN', { hour12: false });

export function formatCurrentStateMaterial(material: CurrentStateMaterial, options: { number?: number; maxChars?: number; sourceChars?: number; requireSourceLabel?: boolean } = {}) {
  const state = material.state;
  const maxChars = Math.max(0, options.maxChars ?? 1000);
  const head = `${options.number ? `- [记忆 ${options.number}] ` : ''}近况：${compact(state.title, 120)}\n上次已知情况：`;
  const tail = `\n得知时间：${time(state.knownAt)}\n依据：`;
  if (maxChars < head.length + tail.length + 2) return '';
  const sourceBudget = Math.max(0, Math.min(options.sourceChars ?? 400, maxChars - head.length - tail.length - 80));
  let sourceText = '';
  if (material.sourceParts.some(part => isObservationMemorySource(part.sessionId ?? ''))) {
    const lines: string[] = [];
    let remaining = sourceBudget;
    for (let index = 0; index < material.sourceParts.length; index++) {
      const part = material.sourceParts[index];
      const reserved = material.sourceParts.slice(index + 1)
        .filter(next => isObservationMemorySource(next.sessionId ?? ''))
        .reduce((length, next) => length + (next.sourceLabel?.length ?? 0) + 1, 0);
      const available = Math.max(0, remaining - reserved - (lines.length ? 1 : 0));
      if (!available) continue;
      let line: string;
      if (isObservationMemorySource(part.sessionId ?? '')) {
        const label = part.sourceLabel ?? '';
        const contentBudget = Math.max(0, available - label.length - 1);
        const content = part.observationRecord
          ? prepareObservationFragment(part.observationRecord, 0, contentBudget)?.content ?? ''
          : part.content.length <= contentBudget ? part.content : '';
        line = label + (content ? `\n${content}` : '');
        if (line.length > available) continue;
      } else {
        line = compact(`${part.context ? `${part.context}\n` : ''}[${part.sourceLabel}｜${part.role}｜${time(part.createdAt)}｜${part.sessionId}｜${part.messageId}｜${part.relation}] ${part.content}`, available);
      }
      if (!line) continue;
      remaining -= line.length + (lines.length ? 1 : 0);
      lines.push(line);
    }
    sourceText = lines.join('\n');
  } else if (material.sourceParts.length) {
    const lines: string[] = [];
    let remaining = sourceBudget;
    // Only the supplied excerpt changes order; stored sources and their versions stay intact.
    const newestFirst = [...material.sourceParts].sort((a, b) => (b.createdAt ?? -Infinity) - (a.createdAt ?? -Infinity));
    for (const part of newestFirst) {
      const prefix = `${part.context ? `${part.context}\n` : ''}[${part.sourceLabel}｜${part.role}｜${time(part.createdAt)}｜${part.sessionId}｜${part.messageId}｜${part.relation}] `;
      const available = remaining - (lines.length ? 1 : 0);
      if (available < prefix.length + (part.content ? 1 : 0)) break;
      const line = prefix + compactEnds(part.content, available - prefix.length);
      remaining -= line.length + (lines.length ? 1 : 0);
      lines.push(line);
    }
    sourceText = lines.join('\n');
  } else if (sourceBudget >= memorySourceStatusLabel.missing.length) {
    sourceText = memorySourceStatusLabel.missing;
  }
  if (options.requireSourceLabel) {
    const labels = material.sourceParts.length ? material.sourceParts.map(part => part.sourceLabel) : [memorySourceStatusLabel.missing];
    if (!labels.some(label => !!label && sourceText.includes(label))) return '';
  }
  return `${head}${compactEnds(state.content, Math.max(0, maxChars - head.length - tail.length - sourceText.length))}${tail}${sourceText}`;
}

export async function loadCurrentStateMaterial(state: MemoryCurrentState, readMessage?: CurrentStateSourceReader,
  options: { postComparison?: boolean } = {}): Promise<CurrentStateMaterial | null> {
  const source = await loadCurrentStateReadSnapshot(state.id, 'source', undefined, readMessage, options);
  if (typeof source === 'string' || currentStateVersion(source.reference.currentState) !== currentStateVersion(state)) return null;
  const material: CurrentStateMaterial = { state, version: currentStateVersion(state), sourceVersion: source.version, sourceParts: source.parts, context: '' };
  material.context = formatCurrentStateMaterial(material);
  return material;
}

export type CurrentStateContextResult = { context: string; items: MemoryCurrentState[] };
export async function buildCurrentStateContext(options: { limit?: number; now?: number; readOnly?: boolean; items?: MemoryCurrentState[] } = {}): Promise<CurrentStateContextResult> {
  const candidates = options.items ?? await loadActiveMemoryCurrentStates({ ...options, currentOnly: true, limit: options.limit ?? 1 });
  const materials = (await Promise.all(candidates.slice(0, options.limit ?? 1).map(state => loadCurrentStateMaterial(state)))).filter((item): item is CurrentStateMaterial => !!item);
  return { context: materials.map(item => item.context).join('\n\n'), items: materials.map(item => item.state) };
}
