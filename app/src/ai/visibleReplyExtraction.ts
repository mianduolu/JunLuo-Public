import { unwrapParenthesizedReplyEnvelope } from './replyTransportFormatting';
import {
  parseResponseEvidenceWire,
  type ResponseEvidenceCandidate,
  type ResponseEvidenceWireRejectionCode,
  type ResponseEvidenceWireStatus,
} from './responseEvidenceWire';

export type VisibleReplySource = 'direct_content' | 'reasoning_marked_visible';

/** Exact direct JSON only; ordinary empty-message extraction remains unchanged. */
export function isExplicitPhoneEmergencySilence(raw: string): boolean {
  return /^[ \t\r\n]*\{[ \t\r\n]*"messages"[ \t\r\n]*:[ \t\r\n]*\[[ \t\r\n]*\][ \t\r\n]*\}[ \t\r\n]*$/u.test(raw);
}

export type VisibleReplyStatus = 'visible' | 'model_empty' | 'structure_invalid';

export type VisibleReplyExpectedStructure = 'default' | 'single_root_json';

export type VisibleReplyFailureReason =
  | 'no_safe_visible_candidate'
  | 'hidden_state_only'
  | 'messages_empty'
  | 'messages_malformed';

export type VisibleReplyStructureVariant =
  | 'state_messages'
  | 'legacy_internal'
  | 'legacy_message'
  | 'approved_incomplete_messages'
  | 'json_messages'
  | 'fixed_messages_prefix'
  | 'safe_direct_plain_text'
  | 'plain_text';

export type VisibleReplyExtractionResult = {
  source: VisibleReplySource;
  status: VisibleReplyStatus;
  messages: string[];
  structureVariant: VisibleReplyStructureVariant | null;
  raw: string;
  hiddenPayload?: string;
  hiddenTag?: 'state' | 'internal';
  hadOutsideText?: boolean;
  failureReason?: VisibleReplyFailureReason;
  responseEvidenceCandidates?: ResponseEvidenceCandidate[];
  responseEvidenceDiagnostic?: VisibleReplyResponseEvidenceDiagnostic;
};

export type ResponseEvidenceTailRejectionCode =
  | 'ticket_unclosed'
  | 'ticket_duplicate'
  | 'ticket_nested'
  | 'ticket_misplaced'
  | 'ticket_trailing_content';

export type VisibleReplyResponseEvidenceDiagnostic = {
  status: ResponseEvidenceWireStatus;
  rawSignalCount: number;
  returnedCount: number;
  acceptedCount: number;
  discardedCount: number;
  rejectionCodes: Array<ResponseEvidenceWireRejectionCode | ResponseEvidenceTailRejectionCode>;
};

const TOOL_PROTOCOL_PATTERN = /<\/?[|｜]{1,2}DSML[|｜]{1,2}\s*(?:toolcalls|calls|invoke|parameter)\b|<\/?\s*(?:tool_?calls?\b|(?:function|parameter)(?=\s*(?:=|>|name\s*=|$)))|["\\]+(?:tool_calls|function_call)["\\]+\s*:\s*[\[{]/iu;
const STRUCTURAL_TAG_PATTERN = new RegExp(`<\\/?(?:state|internal|messages?)>|<\\/?responseEvidence(?:\\s|>|$)|${TOOL_PROTOCOL_PATTERN.source}`, 'iu');
const INTERNAL_WIRE_PROPERTY_PATTERN = /(?:^|[\s,{\[])["'“]?(?:semantic|signals|state|internal|messages|kind|confidence|evidence|target|temporality|careUrgency|uncertain|continuityResolutions|eventUpdates|careUpdates|shareResponses|notebookAction|innerReaction|memoryMentions|sleepAt)["'”]?\s*[:：]/iu;
const RETIRED_TECHNICAL_ENUM_PATTERN = /(?:^|[\s,'"{\[])presence_request(?:$|[\s,'"}\]])/iu;
const ZERO_WIDTH_PATTERN = /[\u200B-\u200D\u2060\uFEFF]/gu;
const RESPONSE_EVIDENCE_OPEN_TAG = '<responseEvidence>';
const RESPONSE_EVIDENCE_CLOSE_TAG = '</responseEvidence>';

function normalizeVisibleReplyCharacters(raw: string) {
  return raw
    .replace(/^\uFEFF/u, '')
    .replace(ZERO_WIDTH_PATTERN, '')
    .trim();
}

export function containsToolProtocolMarkup(raw: string) {
  return TOOL_PROTOCOL_PATTERN.test(normalizeVisibleReplyCharacters(
    raw.replace(/\\u([\da-f]{4})/giu, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))),
  ));
}

// Normalize JSON punctuation only outside values; quoted prose stays unchanged.
function normalizeJsonTypography(raw: string) {
  let normalized = '';
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (char !== '"' && char !== '“') {
      normalized += char === '：' ? ':' : char === '，' ? ',' : char;
      continue;
    }
    const start = index;
    let depth = 1;
    let text = '';
    let closed = false;
    while (++index < raw.length) {
      const next = raw[index];
      if (char === '"') {
        if (next === '\\') { index += 1; continue; }
        if (next === '"') { closed = true; break; }
      } else {
        if (next === '“') depth += 1;
        if (next === '”' && --depth === 0) { closed = true; break; }
        text += next;
      }
    }
    if (!closed) return undefined;
    normalized += char === '"' ? raw.slice(start, index + 1) : JSON.stringify(text);
  }
  return normalized;
}

function extractTypographicMessages(raw: string) {
  const match = /(?:^|\n)[ \t]*(\{\s*“messages”\s*[:：])/u.exec(raw);
  if (!match) return undefined;
  const start = match.index + match[0].indexOf('{');
  const normalized = normalizeJsonTypography(raw.slice(start));
  if (!normalized) return undefined;
  try {
    const parsed = JSON.parse(normalized) as { messages?: unknown };
    const messages = Array.isArray(parsed?.messages) ? normalizeMessages(parsed.messages) : undefined;
    if (!messages) return undefined;
    const prefix = raw.slice(0, start).trim();
    if (!prefix) return { messages, hadOutsideText: false };
    const visiblePrefix = extractSafeDirectPlainText({ raw: prefix, forbiddenStandaloneTokens: [] });
    if (visiblePrefix.status !== 'visible') return undefined;
    const paragraphs = prefix.split(/\n\s*\n/u).map((part) => part.trim()).filter(Boolean);
    return { messages: [...new Set([...paragraphs, ...messages])], hadOutsideText: true };
  } catch {
    return undefined;
  }
}

export function normalizeVisibleReplyRaw(raw: string) {
  const trimmed = normalizeVisibleReplyCharacters(raw);
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu);
  return unwrapParenthesizedReplyEnvelope((fenced?.[1] ?? trimmed).trim());
}

function findJsonContainerEnd(raw: string, start: number) {
  const first = raw[start];
  if (first !== '{' && first !== '[') return undefined;

  const expectedClosings: string[] = [];
  let escaped = false;
  let inString = false;
  for (let index = start; index < raw.length; index += 1) {
    const character = raw[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === '{') {
      expectedClosings.push('}');
      continue;
    }
    if (character === '[') {
      expectedClosings.push(']');
      continue;
    }
    if (character !== '}' && character !== ']') continue;
    if (expectedClosings.pop() !== character) return undefined;
    if (expectedClosings.length === 0) return index + 1;
  }
  return undefined;
}

function skipWhitespace(raw: string, start: number) {
  let index = start;
  while (index < raw.length && /\s/u.test(raw[index])) index += 1;
  return index;
}

/** Select a saved-reminder reply without adopting the model's extra card. */
export function extractReminderFeedbackReplyRoot(raw: string): string | undefined {
  const text = raw.trim();
  const firstEnd = findJsonContainerEnd(text, 0);
  if (text[0] !== '{' || firstEnd === undefined) return undefined;
  const secondStart = skipWhitespace(text, firstEnd);
  const secondEnd = findJsonContainerEnd(text, secondStart);
  if (text[secondStart] !== '{' || secondEnd === undefined
    || skipWhitespace(text, secondEnd) !== text.length) return undefined;
  const firstRoot = text.slice(0, firstEnd);
  try {
    const first = JSON.parse(firstRoot) as { messages?: unknown };
    const second = JSON.parse(text.slice(secondStart, secondEnd)) as Record<string, unknown>;
    if (Object.keys(second).length !== 1
      || !Object.prototype.hasOwnProperty.call(second, 'reminderPlanCard')) return undefined;
    return Array.isArray(first.messages) && normalizeMessages(first.messages) ? firstRoot : undefined;
  } catch {
    return undefined;
  }
}

function foldAsciiCodeUnit(codeUnit: number) {
  return codeUnit >= 0x41 && codeUnit <= 0x5A ? codeUnit + 0x20 : codeUnit;
}

function startsWithAsciiCaseInsensitive(raw: string, token: string, start = 0) {
  if (start < 0 || start + token.length > raw.length) return false;
  for (let offset = 0; offset < token.length; offset += 1) {
    if (
      foldAsciiCodeUnit(raw.charCodeAt(start + offset))
      !== foldAsciiCodeUnit(token.charCodeAt(offset))
    ) return false;
  }
  return true;
}

function indexOfAsciiCaseInsensitive(raw: string, token: string, fromIndex = 0) {
  const lastStart = raw.length - token.length;
  for (let start = Math.max(0, fromIndex); start <= lastStart; start += 1) {
    if (startsWithAsciiCaseInsensitive(raw, token, start)) return start;
  }
  return -1;
}

function findStrictTaggedEnvelopeEnd(raw: string) {
  const hiddenOpening = raw.match(/^<(state|internal)>/iu);
  if (!hiddenOpening) return undefined;

  const hiddenTag = hiddenOpening[1].toLowerCase();
  const hiddenClosing = `</${hiddenTag}>`;
  const messagesOpening = '<messages>';
  const messagesClosing = '</messages>';
  let hiddenCloseStart = indexOfAsciiCaseInsensitive(raw, hiddenClosing, hiddenOpening[0].length);
  while (hiddenCloseStart >= 0) {
    const afterHidden = skipWhitespace(raw, hiddenCloseStart + hiddenClosing.length);
    if (startsWithAsciiCaseInsensitive(raw, messagesOpening, afterHidden)) {
      const payloadStart = skipWhitespace(raw, afterHidden + messagesOpening.length);
      const payloadEnd = findJsonContainerEnd(raw, payloadStart);
      if (payloadEnd !== undefined) {
        const closingStart = skipWhitespace(raw, payloadEnd);
        if (startsWithAsciiCaseInsensitive(raw, messagesClosing, closingStart)) {
          return closingStart + messagesClosing.length;
        }
      }
    }
    hiddenCloseStart = indexOfAsciiCaseInsensitive(
      raw,
      hiddenClosing,
      hiddenCloseStart + hiddenClosing.length,
    );
  }
  return undefined;
}

function findStrictEnvelopeEnd(raw: string) {
  const start = skipWhitespace(raw, 0);
  if (raw[start] === '{' || raw[start] === '[') {
    return findJsonContainerEnd(raw, start);
  }
  return findStrictTaggedEnvelopeEnd(raw.slice(start));
}

function readRawSignalCountFromRecord(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 0;
  const semantic = (value as { semantic?: unknown }).semantic;
  if (!semantic || typeof semantic !== 'object' || Array.isArray(semantic)) return 0;
  const signals = (semantic as { signals?: unknown }).signals;
  return Array.isArray(signals) ? signals.length : 0;
}

function readRawSignalCount(cleanEnvelopeRaw: string) {
  try {
    return readRawSignalCountFromRecord(JSON.parse(cleanEnvelopeRaw) as unknown);
  } catch {
    const exactEnvelope = cleanEnvelopeRaw.match(
      /^<(state|internal)>\s*([\s\S]*?)\s*<\/\1>\s*<messages>[\s\S]*<\/messages>$/iu,
    );
    if (!exactEnvelope) return 0;
    try {
      return readRawSignalCountFromRecord(JSON.parse(exactEnvelope[2]) as unknown);
    } catch {
      return 0;
    }
  }
}

function invalidResponseEvidenceDiagnostic(input: {
  rawSignalCount: number;
  rejectionCode: ResponseEvidenceTailRejectionCode;
}): VisibleReplyResponseEvidenceDiagnostic {
  return {
    status: 'invalid',
    rawSignalCount: input.rawSignalCount,
    returnedCount: 0,
    acceptedCount: 0,
    discardedCount: 0,
    rejectionCodes: [input.rejectionCode],
  };
}

function separateResponseEvidenceTail(raw: string) {
  const normalized = normalizeVisibleReplyCharacters(raw);
  const envelopeEnd = findStrictEnvelopeEnd(normalized);
  if (envelopeEnd === undefined) return undefined;

  const cleanEnvelopeRaw = normalized.slice(0, envelopeEnd).trim();
  const tail = normalized.slice(envelopeEnd).trim();
  const rawSignalCount = readRawSignalCount(cleanEnvelopeRaw);
  if (!tail) {
    const parsed = parseResponseEvidenceWire({ raw: undefined, rawSignalCount });
    return {
      cleanEnvelopeRaw,
      responseEvidenceCandidates: parsed.items,
      responseEvidenceDiagnostic: {
        status: parsed.status,
        rawSignalCount,
        ...parsed.diagnostic,
      },
    };
  }

  const openToken = '<responseEvidence';
  const closeToken = '</responseEvidence';
  if (!startsWithAsciiCaseInsensitive(tail, openToken)
    && !startsWithAsciiCaseInsensitive(tail, closeToken)) return undefined;

  const reject = (rejectionCode: ResponseEvidenceTailRejectionCode) => ({
    cleanEnvelopeRaw,
    responseEvidenceCandidates: [] as ResponseEvidenceCandidate[],
    responseEvidenceDiagnostic: invalidResponseEvidenceDiagnostic({ rawSignalCount, rejectionCode }),
  });
  if (startsWithAsciiCaseInsensitive(tail, closeToken)) return reject('ticket_misplaced');
  if (!startsWithAsciiCaseInsensitive(tail, RESPONSE_EVIDENCE_OPEN_TAG)) {
    return reject('ticket_misplaced');
  }

  const closeStart = indexOfAsciiCaseInsensitive(
    tail,
    RESPONSE_EVIDENCE_CLOSE_TAG,
    RESPONSE_EVIDENCE_OPEN_TAG.length,
  );
  if (closeStart < 0) return reject('ticket_unclosed');
  const payload = tail.slice(RESPONSE_EVIDENCE_OPEN_TAG.length, closeStart);
  if (indexOfAsciiCaseInsensitive(payload, openToken) >= 0
    || indexOfAsciiCaseInsensitive(payload, closeToken) >= 0) return reject('ticket_nested');

  const afterClose = tail.slice(closeStart + RESPONSE_EVIDENCE_CLOSE_TAG.length).trim();
  if (afterClose) {
    return reject(
      startsWithAsciiCaseInsensitive(afterClose, openToken)
        || startsWithAsciiCaseInsensitive(afterClose, closeToken)
        ? 'ticket_duplicate'
        : 'ticket_trailing_content',
    );
  }

  const parsed = parseResponseEvidenceWire({ raw: payload, rawSignalCount });
  return {
    cleanEnvelopeRaw,
    responseEvidenceCandidates: parsed.items,
    responseEvidenceDiagnostic: {
      status: parsed.status,
      rawSignalCount,
      ...parsed.diagnostic,
    },
  };
}

export function extractWholeLegacyMessageBlocks(content: string) {
  const normalized = normalizeVisibleReplyRaw(content);
  if (!normalized) return undefined;

  const messages: string[] = [];
  const wrapperPattern = /<message>\s*([\s\S]*?)\s*<\/message>/giu;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = wrapperPattern.exec(normalized))) {
    const start = match.index ?? 0;
    if (normalized.slice(cursor, start).trim()) return undefined;
    const visible = normalizeVisibleReplyRaw(match[1] ?? '');
    if (!visible || STRUCTURAL_TAG_PATTERN.test(visible)) return undefined;
    messages.push(visible);
    cursor = start + match[0].length;
  }

  if (!messages.length || normalized.slice(cursor).trim()) return undefined;
  return messages;
}

function normalizeMessages(messages: unknown[]): string[] | undefined {
  if (!messages.length || messages.some((message) => typeof message !== 'string')) return undefined;
  const expanded = (messages as string[]).flatMap((message) => (
    extractWholeLegacyMessageBlocks(message) ?? [normalizeVisibleReplyRaw(message)]
  ));
  if (
    !expanded.length
    || expanded.some((message) => (
      !message
      || STRUCTURAL_TAG_PATTERN.test(message)
    ))
  ) return undefined;
  return expanded;
}

function parseStrictMessagesArray(payload: string) {
  const normalized = normalizeVisibleReplyCharacters(payload);
  if (!normalized || /^```/u.test(normalized)) return undefined;
  try {
    const parsed = JSON.parse(normalized) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    return normalizeMessages(parsed);
  } catch {
    return undefined;
  }
}

function extractFixedMessagesPrefix(raw: string) {
  const match = raw.match(/^\{\s*"messages"\s*:\s*/u);
  if (!match) return undefined;
  const arrayStart = match[0].length;
  if (raw[arrayStart] !== '[') return undefined;
  const arrayEnd = findJsonContainerEnd(raw, arrayStart);
  if (arrayEnd === undefined) return undefined;
  const messages = parseStrictMessagesArray(raw.slice(arrayStart, arrayEnd));
  if (!messages) return undefined;

  const next = skipWhitespace(raw, arrayEnd);
  if (next === raw.length) return { messages };
  if (raw[next] !== ',' && raw[next] !== '}') return undefined;

  const rootEnd = findJsonContainerEnd(raw, 0);
  if (rootEnd !== undefined && skipWhitespace(raw, rootEnd) < raw.length) return undefined;
  return { messages };
}

// Literal string quote recovery is opt-in at the ordinary Qwen transport boundary.
// Delimiters are hard boundaries: do not backtrack and swallow a machine field.
function readQuoteEscapedString(raw: string, start: number) {
  if (raw[start] !== '"') return undefined;
  let encoded = '"';
  let literalQuotes = 0;
  for (let index = start + 1; index < raw.length; index += 1) {
    const char = raw[index];
    if (char === '\\') {
      encoded += raw.slice(index, index + 2);
      index += 1;
    } else if (char !== '"') {
      encoded += char;
    } else {
      const next = raw[skipWhitespace(raw, index + 1)];
      if (next === ':' || next === '{' || next === '[' || next === '"') return undefined;
      if (next === ',' || next === ']' || next === '}') {
        if (literalQuotes % 2 !== 0) return undefined;
        encoded += '"';
        try {
          return { end: index + 1, encoded, value: JSON.parse(encoded) as string, literalQuotes };
        } catch {
          return undefined;
        }
      }
      literalQuotes += 1;
      encoded += '\\"';
    }
  }
  return undefined;
}

function extractQuoteEscapedMessages(raw: string, repairArraySeparator = false) {
  const prefix = /^\{\s*"messages"\s*:\s*\[\s*/u.exec(raw);
  if (!prefix) return undefined;
  if (repairArraySeparator) {
    const start = prefix[0].indexOf('['), end = findJsonContainerEnd(raw, start);
    if (end === undefined || !parseStrictMessagesArray(raw.slice(start, end))) return undefined;
    const extra = skipWhitespace(raw, end);
    if (raw[extra] !== '"' || raw[skipWhitespace(raw, extra + 1)] !== ',') return undefined;
    const validation = raw.slice(0, extra) + raw.slice(extra + 1), rootEnd = findJsonContainerEnd(validation, 0);
    if (rootEnd === undefined) return undefined;
    try { JSON.parse(validation.slice(0, rootEnd)); } catch { return undefined; }
  }
  let cursor = prefix[0].length;
  const values: string[] = [];
  let repairedQuotes = 0;
  while (raw[cursor] === '"') {
    const quoted = readQuoteEscapedString(raw, cursor);
    if (!quoted) return undefined;
    values.push(quoted.value);
    repairedQuotes += quoted.literalQuotes;
    cursor = skipWhitespace(raw, quoted.end);
    if (raw[cursor] === ']') break;
    if (raw[cursor] !== ',') return undefined;
    cursor = skipWhitespace(raw, cursor + 1);
    if (raw[cursor] !== '"') return undefined;
  }
  if ((!repairArraySeparator && !repairedQuotes) || (repairArraySeparator && repairedQuotes !== 0)
    || !values.length || raw[cursor] !== ']') return undefined;
  const messages = normalizeMessages(values);
  if (!messages || (!repairArraySeparator && messages.some(message => INTERNAL_WIRE_PROPERTY_PATTERN.test(message)))) return undefined;
  cursor = skipWhitespace(raw, cursor + 1);
  if (repairArraySeparator) cursor = skipWhitespace(raw, cursor + 1);

  // Validate a complete, single root in a throwaway copy. Only quote-repair mode
  // may repair innerReaction quotes; validation never authorizes machine fields.
  let validation = '{"messages":[]';
  const keys = new Set(['messages']);
  const allowedKeys = new Set(['careUpdates', 'shareResponses', 'innerReaction', 'memoryMentions', 'presenceUpdate']);
  while (raw[cursor] === ',') {
    cursor = skipWhitespace(raw, cursor + 1);
    const key = /^"([A-Za-z]+)"\s*:\s*/u.exec(raw.slice(cursor));
    if (!key || !allowedKeys.has(key[1]) || keys.has(key[1])) return undefined;
    keys.add(key[1]);
    validation += `,${JSON.stringify(key[1])}:`;
    cursor += key[0].length;
    if (raw[cursor] === '"') {
      const quoted = readQuoteEscapedString(raw, cursor);
      if (!quoted || ((repairArraySeparator || key[1] !== 'innerReaction') && quoted.literalQuotes)) return undefined;
      validation += quoted.encoded;
      cursor = quoted.end;
    } else {
      const end = findJsonContainerEnd(raw, cursor);
      if (end !== undefined) {
        const field = raw.slice(cursor, end);
        try { JSON.parse(field); } catch { return undefined; }
        validation += field;
        cursor = end;
      } else {
        const scalar = /^(?:null|true|false|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)(?=\s*[,}])/u.exec(raw.slice(cursor));
        if (!scalar) return undefined;
        validation += scalar[0];
        cursor += scalar[0].length;
      }
    }
    cursor = skipWhitespace(raw, cursor);
  }
  if (raw[cursor] !== '}') return undefined;
  const outside = raw.slice(cursor + 1).trim();
  if (outside && (!repairArraySeparator || /[{}\[\]]/u.test(outside) || containsToolProtocolMarkup(outside)
    || extractSafeDirectPlainText({ raw: outside, forbiddenStandaloneTokens: [] }).status !== 'visible')) return undefined;
  try { JSON.parse(validation + '}'); } catch { return undefined; }
  return { messages };
}

function extractFirstRepeatedMessagesEnvelope(raw: string) {
  let cursor = 0;
  let first: string | undefined;
  let count = 0;
  while (cursor < raw.length) {
    if (raw[cursor] !== '{') return undefined;
    const end = findJsonContainerEnd(raw, cursor);
    if (end === undefined) return undefined;
    const candidate = raw.slice(cursor, end);
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      if (Object.keys(parsed)[0] !== 'messages') return undefined;
    } catch {
      return undefined;
    }
    first ??= candidate;
    count += 1;
    cursor = skipWhitespace(raw, end);
  }
  return count > 1 ? first : undefined;
}

function hasEmbeddedJsonContainer(raw: string) {
  for (let index = 1; index < raw.length; index += 1) {
    if (raw[index] !== '{' && raw[index] !== '[') continue;
    try {
      const parsed = JSON.parse(raw.slice(index).trim()) as unknown;
      if (parsed && typeof parsed === 'object') return true;
    } catch {
      // Only a complete JSON container mixed with leading prose is rejected here.
    }
  }
  return false;
}

function hasForbiddenTokenJsonFragment(raw: string, tokens: readonly string[]) {
  const lower = raw.toLowerCase();
  const jsonPunctuation = /["',:{}\[\]]/u;
  return tokens.some((token) => {
    const normalizedToken = token.toLowerCase();
    let index = lower.indexOf(normalizedToken);
    while (index >= 0) {
      const end = index + normalizedToken.length;
      if (
        (index === 0 && end === raw.length)
        || jsonPunctuation.test(raw[index - 1] ?? '')
        || jsonPunctuation.test(raw[end] ?? '')
      ) return true;
      index = lower.indexOf(normalizedToken, end);
    }
    return false;
  });
}

export function extractSafeDirectPlainText(input: {
  forbiddenStandaloneTokens: readonly string[];
  raw: string;
}): VisibleReplyExtractionResult {
  const normalized = normalizeVisibleReplyCharacters(input.raw);
  if (
    !normalized
    || normalized.startsWith('{')
    || normalized.startsWith('[')
    || /^```/u.test(normalized)
    || STRUCTURAL_TAG_PATTERN.test(normalized)
    || INTERNAL_WIRE_PROPERTY_PATTERN.test(normalized)
    || RETIRED_TECHNICAL_ENUM_PATTERN.test(normalized)
    || hasEmbeddedJsonContainer(normalized)
  ) {
    return result({
      source: 'direct_content',
      status: normalized ? 'structure_invalid' : 'model_empty',
      raw: normalized,
      failureReason: normalized ? 'messages_malformed' : 'no_safe_visible_candidate',
    });
  }

  if (hasForbiddenTokenJsonFragment(normalized, input.forbiddenStandaloneTokens)) {
    return result({
      source: 'direct_content',
      status: 'structure_invalid',
      raw: normalized,
      failureReason: 'messages_malformed',
    });
  }

  const messages = normalizeMessages([normalized]);
  return messages
    ? result({
        source: 'direct_content',
        status: 'visible',
        messages,
        raw: normalized,
        structureVariant: 'safe_direct_plain_text',
      })
    : result({
        source: 'direct_content',
        status: 'structure_invalid',
        raw: normalized,
        failureReason: 'messages_malformed',
      });
}

function parseMessagesPayload(payload: string, allowPlainText: boolean) {
  const normalized = normalizeVisibleReplyRaw(payload);
  if (!normalized) return undefined;
  try {
    const parsed = JSON.parse(normalized) as unknown;
    if (Array.isArray(parsed)) {
      const messages = normalizeMessages(parsed);
      return messages ? { messages, legacy: false } : undefined;
    }
    if (typeof parsed === 'string') {
      const messages = normalizeMessages([parsed]);
      return messages ? { messages, legacy: false } : undefined;
    }
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { messages?: unknown }).messages)) {
      const messages = normalizeMessages((parsed as { messages: unknown[] }).messages);
      return messages ? { messages, legacy: false } : undefined;
    }
  } catch {
    const legacyMessages = extractWholeLegacyMessageBlocks(normalized);
    if (legacyMessages?.length) {
      return { messages: legacyMessages, legacy: true };
    }
    if (STRUCTURAL_TAG_PATTERN.test(normalized)) return undefined;
    if (!allowPlainText) return undefined;
    const messages = normalizeMessages([normalized]);
    return messages ? { messages, legacy: false } : undefined;
  }
  return undefined;
}

function classifyMessagesPayloadFailure(payload: string): VisibleReplyFailureReason {
  const normalized = normalizeVisibleReplyRaw(payload);
  if (!normalized) return 'messages_empty';
  try {
    const parsed = JSON.parse(normalized) as unknown;
    const rawMessages = Array.isArray(parsed)
      ? parsed
      : typeof parsed === 'string'
        ? [parsed]
        : parsed && typeof parsed === 'object'
          ? (parsed as { messages?: unknown }).messages
          : undefined;
    if (
      Array.isArray(rawMessages)
      && (
        rawMessages.length === 0
        || rawMessages.every((message) => (
          typeof message === 'string' && !normalizeVisibleReplyRaw(message)
        ))
      )
    ) return 'messages_empty';
  } catch {
    // Non-empty payloads that are not an approved legacy form are malformed.
  }
  return 'messages_malformed';
}

function result(input: {
  source: VisibleReplySource;
  status: VisibleReplyStatus;
  messages?: string[];
  structureVariant?: VisibleReplyStructureVariant | null;
  raw?: string;
  hiddenPayload?: string;
  hiddenTag?: 'state' | 'internal';
  hadOutsideText?: boolean;
  failureReason?: VisibleReplyFailureReason;
}): VisibleReplyExtractionResult {
  return {
    source: input.source,
    status: input.status,
    messages: input.messages ?? [],
    structureVariant: input.structureVariant ?? null,
    raw: input.raw ?? '',
    hiddenPayload: input.hiddenPayload,
    hiddenTag: input.hiddenTag,
    hadOutsideText: input.hadOutsideText,
    failureReason: input.failureReason,
  };
}

function extractVisibleReplyFromRawCore(input: {
  raw: string;
  source?: VisibleReplySource;
  allowPlainText?: boolean;
  expectedStructure?: VisibleReplyExpectedStructure;
  allowUnescapedMessageQuotes?: boolean;
}): VisibleReplyExtractionResult {
  const source = input.source ?? 'direct_content';
  const normalized = normalizeVisibleReplyRaw(input.raw);
  if (!normalized) {
    return result({
      source,
      status: 'model_empty',
      failureReason: 'no_safe_visible_candidate',
    });
  }

  if (input.expectedStructure === 'single_root_json') {
    const rawWithoutFenceNormalization = normalizeVisibleReplyCharacters(input.raw);
    if (/^```/u.test(rawWithoutFenceNormalization)) {
      const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(rawWithoutFenceNormalization);
      if (source === 'direct_content' && fence) {
        try {
          // A closed fence is transport formatting, not permission to adopt its machine fields.
          JSON.parse(fence[1]);
          const visible = extractVisibleReplyFromRawCore({ ...input, raw: fence[1] });
          if (visible.status === 'visible') {
            return { ...visible, raw: rawWithoutFenceNormalization, hadOutsideText: true };
          }
        } catch {
          // Keep incomplete or malformed fenced payloads on the original rejection path.
        }
      }
      return result({
        source,
        status: 'structure_invalid',
        raw: rawWithoutFenceNormalization,
        failureReason: 'messages_malformed',
      });
    }

    const exactEnvelope = normalized.match(
      /^<(state|internal)>\s*([\s\S]*?)\s*<\/\1>\s*<messages>\s*([\s\S]*?)\s*<\/messages>$/iu,
    );
    if (exactEnvelope) {
      const hiddenTag = exactEnvelope[1].toLowerCase() as 'state' | 'internal';
      const messages = parseStrictMessagesArray(exactEnvelope[3]);
      return messages
        ? result({
            source,
            status: 'visible',
            messages,
            raw: normalized,
            hiddenPayload: exactEnvelope[2],
            hiddenTag,
            structureVariant: hiddenTag === 'state' ? 'state_messages' : 'legacy_internal',
          })
        : result({
            source,
            status: 'structure_invalid',
            raw: normalized,
            hiddenPayload: exactEnvelope[2],
            hiddenTag,
            structureVariant: hiddenTag === 'state' ? 'state_messages' : 'legacy_internal',
            failureReason: classifyMessagesPayloadFailure(exactEnvelope[3]),
          });
    }

    try {
      const parsed = JSON.parse(normalized) as unknown;
      if (Array.isArray(parsed)) {
        const messages = normalizeMessages(parsed);
        return messages
          ? result({
              source,
              status: 'visible',
              messages,
              raw: normalized,
              structureVariant: 'json_messages',
            })
          : result({
              source,
              status: 'structure_invalid',
              raw: normalized,
              structureVariant: 'json_messages',
              failureReason: classifyMessagesPayloadFailure(normalized),
            });
      }
      if (!parsed || typeof parsed !== 'object') {
        return result({
          source,
          status: 'structure_invalid',
          raw: normalized,
          failureReason: 'messages_malformed',
        });
      }
      const rawMessages = (parsed as { messages?: unknown }).messages;
      if (!Array.isArray(rawMessages)) {
        return result({
          source,
          status: 'structure_invalid',
          raw: normalized,
          structureVariant: 'json_messages',
          failureReason: 'semantic' in parsed ? 'hidden_state_only' : 'messages_malformed',
        });
      }
      const messages = normalizeMessages(rawMessages);
      return messages
        ? result({
            source,
            status: 'visible',
            messages,
            raw: normalized,
            structureVariant: 'json_messages',
          })
        : result({
            source,
            status: 'structure_invalid',
            raw: normalized,
            structureVariant: 'json_messages',
            failureReason: classifyMessagesPayloadFailure(JSON.stringify(rawMessages)),
          });
    } catch {
      const separator = source === 'direct_content' ? extractQuoteEscapedMessages(normalized, true) : undefined;
      if (separator) {
        return result({ source, status: 'visible', messages: separator.messages,
          raw: normalized, structureVariant: 'fixed_messages_prefix' });
      }
      const quoted = input.allowUnescapedMessageQuotes && source === 'direct_content'
        ? extractQuoteEscapedMessages(normalized) : undefined;
      if (quoted) {
        return result({ source, status: 'visible', messages: quoted.messages,
          raw: normalized, structureVariant: 'fixed_messages_prefix' });
      }
      const typographic = source === 'direct_content' ? extractTypographicMessages(normalized) : undefined;
      if (typographic) {
        return result({ source, status: 'visible', ...typographic, raw: normalized, structureVariant: 'json_messages' });
      }
      const firstEnvelope = extractFirstRepeatedMessagesEnvelope(normalized);
      if (firstEnvelope) {
        return extractVisibleReplyFromRawCore({ ...input, raw: firstEnvelope });
      }
      const fixedPrefix = extractFixedMessagesPrefix(normalized);
      if (fixedPrefix) {
        return result({
          source,
          status: 'visible',
          messages: fixedPrefix.messages,
          raw: normalized,
          structureVariant: 'fixed_messages_prefix',
        });
      }
      // Some direct replies repeat their prose in a final JSON envelope.
      // Recover only its messages; retain the original raw for semantic validation.
      const objects = source === 'direct_content' ? collectTopLevelJsonObjects(normalized) : [];
      const finalObject = objects.length === 1 ? objects[0] : undefined;
      const fenceOpening = finalObject
        ? /\n```json[ \t]*\r?\n\s*$/iu.exec(normalized.slice(0, finalObject.end - finalObject.raw.length)) : null;
      const fencedFinalObject = finalObject && fenceOpening
        && /^\s*\n```[ \t]*$/u.test(normalized.slice(finalObject.end))
        && extractSafeDirectPlainText({ raw: normalized.slice(0, fenceOpening.index),
          forbiddenStandaloneTokens: [] }).status === 'visible';
      if (finalObject && finalObject.raw.length < normalized.length
        && (finalObject.end === normalized.length || fencedFinalObject)) {
        try {
          const rawMessages = JSON.parse(finalObject.raw).messages;
          const messages = Array.isArray(rawMessages) ? normalizeMessages(rawMessages) : undefined;
          if (messages) {
            return result({
              source,
              status: 'visible',
              messages,
              raw: normalized,
              structureVariant: 'json_messages',
              hadOutsideText: true,
            });
          }
        } catch {
          // An incomplete or malformed object still has no readable messages.
        }
      }
      if (source === 'direct_content' && !normalized.includes('```')) {
        const completeMessages = extractCompleteReasoningMessages(normalized);
        if (!completeMessages.conflicting && completeMessages.reply) {
          return { ...completeMessages.reply, source, raw: normalized, hadOutsideText: true };
        }
      }
      return result({
        source,
        status: 'structure_invalid',
        raw: normalized,
        failureReason: 'messages_malformed',
      });
    }
  }

  const exactEnvelope = normalized.match(
    /^<(state|internal)>\s*([\s\S]*?)\s*<\/\1>\s*<messages>\s*([\s\S]*?)\s*<\/messages>$/iu,
  );
  if (exactEnvelope) {
    const parsed = parseMessagesPayload(exactEnvelope[3], true);
    const hiddenTag = exactEnvelope[1].toLowerCase() as 'state' | 'internal';
    if (!parsed) {
      return result({
        source,
        status: 'structure_invalid',
        raw: normalized,
        hiddenPayload: exactEnvelope[2],
        hiddenTag,
        structureVariant: hiddenTag === 'state' ? 'state_messages' : 'legacy_internal',
        failureReason: classifyMessagesPayloadFailure(exactEnvelope[3]),
      });
    }
    return result({
      source,
      status: 'visible',
      messages: parsed.messages,
      raw: normalized,
      hiddenPayload: exactEnvelope[2],
      hiddenTag,
      structureVariant: parsed.legacy
        ? 'legacy_message'
        : hiddenTag === 'state'
          ? 'state_messages'
          : 'legacy_internal',
    });
  }

  const incompleteEnvelope = normalized.match(
    /^<(state|internal)>\s*([\s\S]*?)\s*<\/\1>\s*<messages>\s*([\s\S]+)$/iu,
  );
  if (incompleteEnvelope && !/<\/messages>/iu.test(incompleteEnvelope[3])) {
    const parsed = parseMessagesPayload(incompleteEnvelope[3], true);
    const hiddenTag = incompleteEnvelope[1].toLowerCase() as 'state' | 'internal';
    return parsed
      ? result({
          source,
          status: 'visible',
          messages: parsed.messages,
          raw: normalized,
          hiddenPayload: incompleteEnvelope[2],
          hiddenTag,
          structureVariant: 'approved_incomplete_messages',
        })
      : result({
          source,
          status: 'structure_invalid',
          raw: normalized,
          hiddenPayload: incompleteEnvelope[2],
          hiddenTag,
          structureVariant: 'approved_incomplete_messages',
          failureReason: classifyMessagesPayloadFailure(incompleteEnvelope[3]),
        });
  }

  const plainTrailingEnvelope = normalized.match(
    /^<(state|internal)>\s*([\s\S]*?)\s*<\/\1>\s*([\s\S]+)$/iu,
  );
  if (plainTrailingEnvelope && !STRUCTURAL_TAG_PATTERN.test(plainTrailingEnvelope[3])) {
    const parsed = parseMessagesPayload(plainTrailingEnvelope[3], true);
    const hiddenTag = plainTrailingEnvelope[1].toLowerCase() as 'state' | 'internal';
    return parsed
      ? result({
          source,
          status: 'visible',
          messages: parsed.messages,
          raw: normalized,
          hiddenPayload: plainTrailingEnvelope[2],
          hiddenTag,
          structureVariant: 'approved_incomplete_messages',
        })
      : result({
          source,
          status: 'structure_invalid',
          raw: normalized,
          hiddenPayload: plainTrailingEnvelope[2],
          hiddenTag,
          structureVariant: 'approved_incomplete_messages',
          failureReason: classifyMessagesPayloadFailure(plainTrailingEnvelope[3]),
        });
  }

  const exactMessages = normalized.match(/^<messages>\s*([\s\S]*?)\s*<\/messages>$/iu);
  if (exactMessages) {
    const parsed = parseMessagesPayload(exactMessages[1], true);
    return parsed
      ? result({
          source,
          status: 'visible',
          messages: parsed.messages,
          raw: normalized,
          structureVariant: parsed.legacy ? 'legacy_message' : 'state_messages',
        })
      : result({
          source,
          status: 'structure_invalid',
          raw: normalized,
          structureVariant: 'state_messages',
          failureReason: classifyMessagesPayloadFailure(exactMessages[1]),
        });
  }

  const incompleteMessages = normalized.match(/^<messages>\s*([\s\S]+)$/iu);
  if (incompleteMessages && !/<\/messages>/iu.test(incompleteMessages[1])) {
    const parsed = parseMessagesPayload(incompleteMessages[1], true);
    return parsed
      ? result({
          source,
          status: 'visible',
          messages: parsed.messages,
          raw: normalized,
          structureVariant: 'approved_incomplete_messages',
          failureReason: classifyMessagesPayloadFailure(incompleteMessages[1]),
        })
      : result({
          source,
          status: 'structure_invalid',
          raw: normalized,
          structureVariant: 'approved_incomplete_messages',
        });
  }

  const legacyMessages = extractWholeLegacyMessageBlocks(normalized);
  if (legacyMessages?.length) {
    return result({
      source,
      status: 'visible',
      messages: legacyMessages,
      raw: normalized,
      structureVariant: 'legacy_message',
    });
  }

  const hiddenOpenings = [...normalized.matchAll(/<(?:state|internal)>/giu)];
  for (let index = hiddenOpenings.length - 1; index >= 0; index -= 1) {
    const start = hiddenOpenings[index].index;
    if (start === undefined || start === 0 || !normalized.slice(0, start).trim()) continue;
    const candidate = extractVisibleReplyFromRaw({
      raw: normalized.slice(start),
      source,
      allowPlainText: false,
    });
    if (candidate.status === 'visible') {
      return {
        ...candidate,
        hadOutsideText: true,
        raw: source === 'direct_content' ? normalized : candidate.raw,
      };
    }
  }

  if (STRUCTURAL_TAG_PATTERN.test(normalized)) {
    const hidden = normalized.match(/^<(state|internal)>\s*([\s\S]*?)\s*<\/\1>/iu);
    const hiddenTag = hidden?.[1]?.toLowerCase() as 'state' | 'internal' | undefined;
    const hasMessagesOpening = /<messages>/iu.test(normalized);
    return result({
      source,
      status: 'structure_invalid',
      raw: normalized,
      hiddenPayload: hidden?.[2],
      hiddenTag,
      structureVariant: hiddenTag === 'internal'
        ? 'legacy_internal'
        : hiddenTag === 'state'
          ? 'state_messages'
          : null,
      failureReason: hiddenTag && !hasMessagesOpening
        ? 'hidden_state_only'
        : 'messages_malformed',
    });
  }

  try {
    const parsed = JSON.parse(normalized) as unknown;
    const rawMessages = Array.isArray(parsed)
      ? parsed
      : typeof parsed === 'string'
        ? [parsed]
        : parsed && typeof parsed === 'object'
          ? (parsed as { messages?: unknown }).messages
          : undefined;
    if (Array.isArray(rawMessages)) {
      const messages = normalizeMessages(rawMessages);
      return messages
        ? result({
            source,
            status: 'visible',
            messages,
            raw: normalized,
            structureVariant: 'json_messages',
          })
        : result({
            source,
            status: 'structure_invalid',
            raw: normalized,
            failureReason: classifyMessagesPayloadFailure(JSON.stringify(rawMessages)),
          });
    }
    return result({
      source,
      status: 'structure_invalid',
      raw: normalized,
      failureReason: 'messages_malformed',
    });
  } catch {
    if (input.allowPlainText === false) {
      return result({
        source,
        status: 'model_empty',
        failureReason: 'no_safe_visible_candidate',
      });
    }
    const messages = normalizeMessages([normalized]);
    return messages
      ? result({
          source,
          status: 'visible',
          messages,
          raw: normalized,
          structureVariant: 'plain_text',
        })
      : result({
          source,
          status: 'structure_invalid',
          raw: normalized,
          failureReason: 'messages_malformed',
        });
  }
}

export function extractVisibleReplyFromRaw(input: {
  raw: string;
  source?: VisibleReplySource;
  allowPlainText?: boolean;
  expectedStructure?: VisibleReplyExpectedStructure;
  allowUnescapedMessageQuotes?: boolean;
}): VisibleReplyExtractionResult {
  if (input.expectedStructure !== 'single_root_json') {
    return extractVisibleReplyFromRawCore(input);
  }

  const separated = separateResponseEvidenceTail(input.raw);
  const extracted = extractVisibleReplyFromRawCore({
    ...input,
    raw: separated?.cleanEnvelopeRaw ?? input.raw,
  });
  if (!separated || extracted.status !== 'visible') return extracted;
  return {
    ...extracted,
    responseEvidenceCandidates: separated.responseEvidenceCandidates,
    responseEvidenceDiagnostic: separated.responseEvidenceDiagnostic,
  };
}

function collectTopLevelJsonObjects(raw: string) {
  const candidates: Array<{ end: number; raw: string }> = [];
  let depth = 0;
  let escaped = false;
  let inString = false;
  let start = -1;
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === '{') {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (character !== '}' || depth === 0) continue;
    depth -= 1;
    if (depth === 0 && start >= 0) {
      candidates.push({ raw: raw.slice(start, index + 1), end: index + 1 });
      start = -1;
    }
  }
  return candidates;
}

/** Recover only explicit, complete reply arrays; never adopt the surrounding reasoning or actions. */
function extractCompleteReasoningMessages(raw: string): {
  reply?: VisibleReplyExtractionResult; conflicting: boolean; incompleteContainer: boolean;
} {
  if (STRUCTURAL_TAG_PATTERN.test(raw)) return { conflicting: false, incompleteContainer: false };
  let cursor = 0;
  let incompleteContainer = false;
  let unreadableReplyContainer = false;
  let selected: string[] | undefined;
  let selectedKey: string | undefined;
  while (cursor < raw.length) {
    // Skip quoted examples and whole outer containers, including arrays. Nested objects are not reply roots.
    if (raw[cursor] === '"') {
      let closed = false;
      while (++cursor < raw.length) {
        if (raw[cursor] === '\\') cursor += 1;
        else if (raw[cursor] === '"') { cursor += 1; closed = true; break; }
      }
      if (!closed) { incompleteContainer = true; break; }
      continue;
    }
    if (raw[cursor] !== '{' && raw[cursor] !== '[') { cursor += 1; continue; }
    const end = findJsonContainerEnd(raw, cursor);
    if (end === undefined) { incompleteContainer = true; break; }
    const candidateRaw = raw.slice(cursor, end);
    cursor = end;
    let parsed: unknown;
    try { parsed = JSON.parse(candidateRaw) as unknown; }
    catch {
      if (/^\{\s*"messages"\s*:/u.test(candidateRaw)) unreadableReplyContainer = true;
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || !Object.prototype.hasOwnProperty.call(parsed, 'messages')) continue;
    const values = (parsed as { messages?: unknown }).messages;
    const messages = Array.isArray(values) ? normalizeMessages(values) : undefined;
    if (!messages) continue;
    const key = JSON.stringify(messages);
    if (selectedKey !== undefined && selectedKey !== key) return { conflicting: true, incompleteContainer };
    selected = messages;
    selectedKey = key;
  }
  return { conflicting: false, incompleteContainer, reply: selected && !unreadableReplyContainer ? result({
    source: 'reasoning_marked_visible', status: 'visible', messages: selected,
    raw: JSON.stringify({ messages: selected }), structureVariant: 'json_messages', hadOutsideText: true,
  }) : undefined };
}

function extractVisibleReplyFromReasoning(
  raw: string,
  expectedStructure: VisibleReplyExpectedStructure,
): VisibleReplyExtractionResult {
  const normalized = expectedStructure === 'single_root_json'
    ? normalizeVisibleReplyCharacters(raw)
    : normalizeVisibleReplyRaw(raw);
  if (!normalized) {
    return result({
      source: 'reasoning_marked_visible',
      status: 'model_empty',
      failureReason: 'no_safe_visible_candidate',
    });
  }

  const completeMessages = extractCompleteReasoningMessages(normalized);
  if (completeMessages.conflicting) {
    return result({ source: 'reasoning_marked_visible', status: 'structure_invalid', failureReason: 'messages_malformed' });
  }
  const whole = extractVisibleReplyFromRaw({
    raw: normalized,
    source: 'reasoning_marked_visible',
    allowPlainText: false,
    expectedStructure,
  });
  if (whole.status === 'visible') return whole;
  if (completeMessages.incompleteContainer) {
    return completeMessages.reply
      ?? result({ source: 'reasoning_marked_visible', status: 'structure_invalid', failureReason: 'messages_malformed' });
  }

  let invalidCandidate = whole.status === 'structure_invalid' ? whole : undefined;
  if (expectedStructure === 'single_root_json') {
    const lineStarts = [0];
    for (let index = 0; index < normalized.length; index += 1) {
      if (normalized[index] === '\n') lineStarts.push(index + 1);
    }
    for (let index = lineStarts.length - 1; index >= 1; index -= 1) {
      const candidateRaw = normalized.slice(lineStarts[index]).trim();
      if (!candidateRaw) continue;
      const candidate = extractVisibleReplyFromRaw({
        raw: candidateRaw,
        source: 'reasoning_marked_visible',
        allowPlainText: false,
        expectedStructure,
      });
      if (candidate.status === 'visible') return candidate;
      if (candidate.status === 'structure_invalid') invalidCandidate = candidate;
    }
    if (completeMessages.reply) return completeMessages.reply;
    return invalidCandidate
      ?? result({
        source: 'reasoning_marked_visible',
        status: 'model_empty',
        failureReason: 'no_safe_visible_candidate',
      });
  }
  const hiddenOpenings = [...normalized.matchAll(/<(?:state|internal)>/giu)];
  for (let index = hiddenOpenings.length - 1; index >= 0; index -= 1) {
    const start = hiddenOpenings[index].index;
    if (start === undefined) continue;
    const candidate = extractVisibleReplyFromRaw({
      raw: normalized.slice(start),
      source: 'reasoning_marked_visible',
      allowPlainText: false,
    });
    if (candidate.status === 'visible') return candidate;
    if (candidate.status === 'structure_invalid') invalidCandidate = candidate;
  }

  const messagesOpenings = [...normalized.matchAll(/<messages>/giu)];
  for (let index = messagesOpenings.length - 1; index >= 0; index -= 1) {
    const start = messagesOpenings[index].index;
    if (start === undefined) continue;
    const candidate = extractVisibleReplyFromRaw({
      raw: normalized.slice(start),
      source: 'reasoning_marked_visible',
      allowPlainText: false,
    });
    if (candidate.status === 'visible') return candidate;
    if (candidate.status === 'structure_invalid') invalidCandidate = candidate;
  }

  const legacyOpenings = [...normalized.matchAll(/<message>/giu)];
  for (const opening of legacyOpenings) {
    const start = opening.index;
    if (start === undefined) continue;
    const candidate = extractVisibleReplyFromRaw({
      raw: normalized.slice(start),
      source: 'reasoning_marked_visible',
      allowPlainText: false,
    });
    if (candidate.status === 'visible') return candidate;
    if (candidate.status === 'structure_invalid') invalidCandidate = candidate;
  }

  const jsonCandidates = collectTopLevelJsonObjects(normalized);
  for (let index = jsonCandidates.length - 1; index >= 0; index -= 1) {
    const jsonCandidate = jsonCandidates[index];
    if (normalized.slice(jsonCandidate.end).trim()) continue;
    const candidate = extractVisibleReplyFromRaw({
      raw: jsonCandidate.raw,
      source: 'reasoning_marked_visible',
      allowPlainText: false,
    });
    if (candidate.status === 'visible') return candidate;
    if (candidate.status === 'structure_invalid') invalidCandidate = candidate;
  }

  if (completeMessages.reply) return completeMessages.reply;
  return invalidCandidate
    ?? result({
      source: 'reasoning_marked_visible',
      status: 'model_empty',
      failureReason: 'no_safe_visible_candidate',
    });
}

export function extractVisibleReply(input: {
  directContent: string;
  reasoningContent?: string;
  allowReasoningRecovery?: boolean;
  expectedStructure?: VisibleReplyExpectedStructure;
}) {
  const expectedStructure = input.expectedStructure ?? 'default';
  const direct = extractVisibleReplyFromRaw({
    raw: input.directContent,
    expectedStructure,
  });
  if (direct.status === 'visible') return direct;

  const reasoning = input.allowReasoningRecovery
    ? extractVisibleReplyFromReasoning(input.reasoningContent ?? '', expectedStructure)
    : result({
      source: 'reasoning_marked_visible',
      status: 'model_empty',
      failureReason: 'no_safe_visible_candidate',
    });
  if (reasoning.status === 'visible') return reasoning;
  if (direct.status === 'structure_invalid') return direct;
  if (reasoning.status === 'structure_invalid') return reasoning;
  return direct;
}
