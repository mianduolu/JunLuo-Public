import { estimateTextTokens } from '../chat/contextCompression';
import type { OpenAiCompatibleRequestMessage } from './openAiCompatibleProvider';

export type PromptSectionPlacement = 'stable' | 'dynamic' | 'task';
export type PromptSectionPrivacy = 'stable' | 'private-dynamic';

export type CompiledPromptSection = {
  estimatedTokens: number;
  id: string;
  label: string;
  placement: PromptSectionPlacement;
  privacy: PromptSectionPrivacy;
  source: string;
  text: string;
};

export type PromptRuntimeSnapshot = {
  contextProfile: string;
  contextSource: string;
  createdAt: number;
  model?: string;
  nonSystemMessageCount: number;
  nonSystemTokens: number;
  sections: CompiledPromptSection[];
  systemTokens: number;
};

type SplitPromptTextOptions = {
  idPrefix: string;
  label: string;
  placement: PromptSectionPlacement;
  privacy: PromptSectionPrivacy;
  source: string;
};

type RuntimeSnapshotInput = {
  contextProfile: string;
  contextSource: string;
  createdAt?: number;
  messages: OpenAiCompatibleRequestMessage[];
  model?: string;
};

const PROMPT_HEADING_PATTERN = /^【([^】\r\n]+)】[^\r\n]*$/gm;
const DYNAMIC_SYSTEM_HEADING_PATTERN =
  /【(?:本轮动态参考|开口前的内部参考|我的长期状态|最近的内在余韵|记忆参考|回复前看见的现实)】/;

let latestRuntimeSnapshot: PromptRuntimeSnapshot | null = null;
const runtimeSnapshotListeners = new Set<(snapshot: PromptRuntimeSnapshot | null) => void>();

// Temporary, opt-in transport evidence for Qwen proactive and local compatibility investigations.
// The opaque body is captured at the final protocol adapter, never stored as domain messages.
export type ProactiveRequestCapture = {
  startedAt: number;
  requestBody: string;
  layout: string;
  requestKind: string;
  finishedAt?: number;
  httpStatus?: number;
  traceId?: string;
  responseJson?: string;
  bodyParseFailure?: string;
  outcome?: 'response_received' | 'http_error' | 'network_error' | 'timeout' | 'aborted';
};
type ProactiveCaptureState = { armed: boolean; capture: ProactiveRequestCapture | null };
let proactiveCaptureState: ProactiveCaptureState = { armed: false, capture: null };
const proactiveCaptureListeners = new Set<(state: ProactiveCaptureState) => void>();
function publishProactiveCapture(state: ProactiveCaptureState) {
  proactiveCaptureState = state;
  for (const listener of proactiveCaptureListeners) {
    try { listener(state); } catch { /* Observation cannot change a request. */ }
  }
}
export function getProactiveRequestCapture() { return proactiveCaptureState; }
export function subscribeProactiveRequestCapture(listener: (state: ProactiveCaptureState) => void) {
  proactiveCaptureListeners.add(listener);
  return () => { proactiveCaptureListeners.delete(listener); };
}
export function armProactiveRequestCapture() {
  publishProactiveCapture({ armed: true, capture: null });
}
export function clearProactiveRequestCapture() {
  publishProactiveCapture({ armed: false, capture: null });
}
// Display-only JSON string: ASCII survives UI XML character filtering. Decode XML,
// then JSON.parse exactly once to recover the captured string; never send this wrapper.
export function encodeProactiveCaptureExport(content: string) {
  return JSON.stringify(content).replace(/[^\x20-\x7e]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
export function beginProactiveRequestCapture(requestBody: string, layout: string, requestKind: string) {
  if (!proactiveCaptureState.armed) return undefined;
  const capture: ProactiveRequestCapture = { requestBody, layout, requestKind, startedAt: Date.now() };
  publishProactiveCapture({ armed: false, capture });
  return capture;
}
export function finishProactiveRequestCapture(
  capture: ProactiveRequestCapture,
  result: Omit<ProactiveRequestCapture, 'startedAt' | 'requestBody' | 'layout' | 'requestKind'>,
) {
  // Clearing/re-arming replaces the object; a late response cannot attach to a newer request.
  if (proactiveCaptureState.capture !== capture) return;
  publishProactiveCapture({ armed: false, capture: { ...capture, ...result, finishedAt: Date.now() } });
}

function makeSection(
  text: string,
  index: number,
  options: SplitPromptTextOptions,
  label = options.label,
): CompiledPromptSection {
  const normalized = text.trim();
  return {
    estimatedTokens: estimateTextTokens(normalized),
    id: `${options.idPrefix}.${index}`,
    label,
    placement: options.placement,
    privacy: options.privacy,
    source: options.source,
    text: normalized,
  };
}

export function splitPromptTextIntoSections(
  text: string,
  options: SplitPromptTextOptions,
): CompiledPromptSection[] {
  const normalized = text.trim();
  if (!normalized) return [];

  const matches = [...normalized.matchAll(PROMPT_HEADING_PATTERN)];
  if (!matches.length) return [makeSection(normalized, 0, options)];

  const sections: CompiledPromptSection[] = [];
  const firstHeadingAt = matches[0]?.index ?? 0;
  if (firstHeadingAt > 0) {
    sections.push(makeSection(normalized.slice(0, firstHeadingAt), sections.length, options));
  }
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const start = match.index ?? 0;
    const end = matches[index + 1]?.index ?? normalized.length;
    sections.push(
      makeSection(
        normalized.slice(start, end),
        sections.length,
        options,
        match[1]?.trim() || options.label,
      ),
    );
  }
  return sections;
}

function placementForSystemMessage(content: string, systemIndex: number): PromptSectionPlacement {
  if (systemIndex === 0) return 'stable';
  return DYNAMIC_SYSTEM_HEADING_PATTERN.test(content) ? 'dynamic' : 'task';
}

export function buildPromptRuntimeSnapshot({
  contextProfile,
  contextSource,
  createdAt = Date.now(),
  messages,
  model,
}: RuntimeSnapshotInput): PromptRuntimeSnapshot {
  let systemIndex = 0;
  const sections = messages.flatMap((message, messageIndex) => {
    if (message.role !== 'system') return [];
    const placement = placementForSystemMessage(message.content, systemIndex);
    const currentSystemIndex = systemIndex;
    systemIndex += 1;
    return splitPromptTextIntoSections(message.content, {
      idPrefix: `runtime.system-${messageIndex}`,
      label: `System ${currentSystemIndex + 1}`,
      placement,
      privacy: placement === 'stable' ? 'stable' : 'private-dynamic',
      source: contextSource,
    });
  });
  const nonSystemMessages = messages.filter((message) => message.role !== 'system');
  return {
    contextProfile,
    contextSource,
    createdAt,
    model,
    nonSystemMessageCount: nonSystemMessages.length,
    nonSystemTokens: nonSystemMessages.reduce(
      (total, message) => total + 4 + estimateTextTokens(message.content),
      0,
    ),
    sections,
    systemTokens: sections.reduce((total, section) => total + section.estimatedTokens, 0),
  };
}

export function recordPromptRuntimeSnapshot(input: RuntimeSnapshotInput) {
  latestRuntimeSnapshot = buildPromptRuntimeSnapshot(input);
  for (const listener of runtimeSnapshotListeners) listener(latestRuntimeSnapshot);
  return latestRuntimeSnapshot;
}

export function getLatestPromptRuntimeSnapshot() {
  return latestRuntimeSnapshot;
}

export function subscribePromptRuntimeSnapshot(
  listener: (snapshot: PromptRuntimeSnapshot | null) => void,
) {
  runtimeSnapshotListeners.add(listener);
  return () => {
    runtimeSnapshotListeners.delete(listener);
  };
}

export function clearPromptRuntimeSnapshotForTests() {
  latestRuntimeSnapshot = null;
  for (const listener of runtimeSnapshotListeners) listener(null);
}
