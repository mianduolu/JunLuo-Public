import { extractVisibleReplyFromRaw } from '../visibleReplyExtraction';
import { parseWishDiscussion } from '../../wishPool/wishPoolChatContract';

export type BaiyunFixedEnvelopeFieldStatus =
  | 'valid'
  | 'missing'
  | 'malformed'
  | 'unavailable';

export type BaiyunFixedEnvelopeMode = 'wish' | 'desktop-reminder-draft';
export type BaiyunReminderAction = null | 'create_draft' | 'clarify';

export type BaiyunFixedEnvelopeJsonParseIssue = 'unexpected_end' | 'unexpected_token' | 'expected_property_name'
  | 'expected_delimiter' | 'unterminated_string' | 'invalid_escape' | 'trailing_content';

export type BaiyunFixedEnvelopeRootFailure =
  | { kind: 'json_parse_error'; parseIssue?: BaiyunFixedEnvelopeJsonParseIssue; position?: number; line?: number; column?: number }
  | { kind: 'non_object_root'; rootType: 'array' | 'null' | 'string' | 'number' | 'boolean' };

export type BaiyunFixedEnvelopeFieldDiagnostic<T = unknown> =
  | { status: 'valid'; value: T }
  | { status: Exclude<BaiyunFixedEnvelopeFieldStatus, 'valid'> };

export interface BaiyunFixedChatEnvelopeDiagnostic {
  candidate: boolean;
  rootStatus: 'valid' | 'malformed';
  rootFailure?: BaiyunFixedEnvelopeRootFailure;
  messagesFirst: boolean;
  unexpectedRootKeys: string[];
  fields: {
    messages: BaiyunFixedEnvelopeFieldDiagnostic<string[]>;
    careUpdates: BaiyunFixedEnvelopeFieldDiagnostic<unknown[]>;
    shareResponses: BaiyunFixedEnvelopeFieldDiagnostic<unknown[]>;
    innerReaction: BaiyunFixedEnvelopeFieldDiagnostic<string | null>;
    wishDiscussion?: BaiyunFixedEnvelopeFieldDiagnostic<NonNullable<ReturnType<typeof parseWishDiscussion>>>;
    memoryMentions?: BaiyunFixedEnvelopeFieldDiagnostic<unknown[]>;
    reminderAction?: BaiyunFixedEnvelopeFieldDiagnostic<BaiyunReminderAction>;
  };
}

const FIXED_ROOT_KEYS = new Set([
  'presenceUpdate',
  'memoryMentions',
  'messages',
  'careUpdates',
  'shareResponses',
  'innerReaction',
]);
const WISH_ROOT_KEYS = new Set(['messages', 'wishDiscussion', 'innerReaction', 'memoryMentions']);
const REMINDER_ROOT_KEYS = new Set([...FIXED_ROOT_KEYS, 'reminderAction']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function isBaiyunFixedChatEnvelopeCandidate(value: unknown, fixedEnvelopeMode?: BaiyunFixedEnvelopeMode) {
  if (!isPlainObject(value)) return false;
  return hasOwn(value, 'messages')
    || (fixedEnvelopeMode === 'wish' && hasOwn(value, 'wishDiscussion'))
    || hasOwn(value, 'careUpdates')
    || hasOwn(value, 'innerReaction');
}

function unavailableFields(fixedEnvelopeMode?: BaiyunFixedEnvelopeMode): BaiyunFixedChatEnvelopeDiagnostic['fields'] {
  return {
    messages: { status: 'unavailable' },
    careUpdates: { status: 'unavailable' },
    shareResponses: { status: 'unavailable' },
    innerReaction: { status: 'unavailable' },
    ...(fixedEnvelopeMode === 'desktop-reminder-draft' ? { reminderAction: { status: 'unavailable' as const } } : {}),
    ...(fixedEnvelopeMode === 'wish' ? {
      wishDiscussion: { status: 'unavailable' as const },
      memoryMentions: { status: 'unavailable' as const },
    } : {}),
  };
}

function arrayField(
  root: Record<string, unknown>,
  key: 'careUpdates' | 'shareResponses' | 'memoryMentions',
): BaiyunFixedEnvelopeFieldDiagnostic<unknown[]> {
  if (!hasOwn(root, key)) return { status: 'missing' };
  return Array.isArray(root[key])
    ? { status: 'valid', value: root[key] }
    : { status: 'malformed' };
}

function jsonParseFailureDetails(error: unknown, length: number) {
  const message = error && typeof error === 'object'
    ? Object.getOwnPropertyDescriptor(error, 'message')?.value : undefined;
  if (typeof message !== 'string') return {};
  const prefixes: readonly [string, BaiyunFixedEnvelopeJsonParseIssue][] = [
    ['Unexpected end of JSON input', 'unexpected_end'], ['Unexpected token ', 'unexpected_token'],
    ["Expected property name or '}' in JSON", 'expected_property_name'],
    ["Expected ':' after property name in JSON", 'expected_delimiter'],
    ["Expected ',' or '}' after property value in JSON", 'expected_delimiter'],
    ["Expected ',' or ']' after array element in JSON", 'expected_delimiter'],
    ['Unterminated string in JSON', 'unterminated_string'], ['Bad escaped character in JSON', 'invalid_escape'],
    ['Bad Unicode escape in JSON', 'invalid_escape'],
    ['Unexpected non-whitespace character after JSON', 'trailing_content'],
  ];
  const parseIssue = prefixes.find(([prefix]) => message.startsWith(prefix))?.[1];
  const details = parseIssue ? { parseIssue } : {};
  const match = / at position (\d+) \(line (\d+) column (\d+)\)$/.exec(message);
  if (!match) return details;
  const [position, line, column] = match.slice(1).map(Number);
  return [position, line, column].every(Number.isSafeInteger)
    && position >= 0 && position <= length && line > 0 && column > 0
    ? { ...details, position, line, column } : details;
}

export function inspectBaiyunFixedChatEnvelope(raw: string, fixedEnvelopeMode?: BaiyunFixedEnvelopeMode,
  options?: { allowUnescapedMessageQuotes?: boolean; includeRootFailure?: boolean }): BaiyunFixedChatEnvelopeDiagnostic {
  const normalized = raw.replace(/^\uFEFF/u, '').trim();
  const extracted = extractVisibleReplyFromRaw({
    raw: normalized,
    expectedStructure: 'single_root_json',
    allowUnescapedMessageQuotes: fixedEnvelopeMode !== 'wish' && options?.allowUnescapedMessageQuotes,
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(normalized) as unknown;
  } catch (error) {
    const candidate = /^\{\s*"messages"\s*:/u.test(normalized);
    const fields = unavailableFields(fixedEnvelopeMode);
    fields.messages = extracted.status === 'visible'
      ? { status: 'valid', value: extracted.messages }
      : { status: 'malformed' };
    return {
      candidate,
      rootStatus: 'malformed',
      ...(options?.includeRootFailure ? { rootFailure: {
        kind: 'json_parse_error' as const, ...jsonParseFailureDetails(error, normalized.length),
      } } : {}),
      messagesFirst: candidate,
      unexpectedRootKeys: [],
      fields,
    };
  }

  if (!isPlainObject(parsed)) {
    return {
      candidate: false,
      rootStatus: 'malformed',
      ...(options?.includeRootFailure ? { rootFailure: {
        kind: 'non_object_root' as const,
        rootType: Array.isArray(parsed) ? 'array' as const : parsed === null ? 'null' as const
          : typeof parsed as 'string' | 'number' | 'boolean',
      } } : {}),
      messagesFirst: false,
      unexpectedRootKeys: [],
      fields: unavailableFields(fixedEnvelopeMode),
    };
  }

  const keys = Object.keys(parsed);
  const messagesFirst = keys[0] === 'messages';
  const candidate = isBaiyunFixedChatEnvelopeCandidate(parsed, fixedEnvelopeMode);
  if (!candidate) {
    return {
      candidate: false,
      rootStatus: 'valid',
      messagesFirst,
      unexpectedRootKeys: [],
      fields: unavailableFields(fixedEnvelopeMode),
    };
  }

  let innerReaction: BaiyunFixedEnvelopeFieldDiagnostic<string | null>;
  const rawInnerReaction = parsed.innerReaction;
  if (!hasOwn(parsed, 'innerReaction')) {
    innerReaction = { status: 'missing' };
  } else if (rawInnerReaction === null) {
    innerReaction = { status: 'valid', value: null };
  } else if (typeof rawInnerReaction === 'string') {
    innerReaction = { status: 'valid', value: rawInnerReaction };
  } else {
    innerReaction = { status: 'malformed' };
  }

  const wishDiscussion = fixedEnvelopeMode === 'wish' ? parseWishDiscussion(parsed.wishDiscussion) : null;
  return {
    candidate: true,
    rootStatus: 'valid',
    messagesFirst,
    unexpectedRootKeys: keys.filter((key) => !(fixedEnvelopeMode === 'wish' ? WISH_ROOT_KEYS
      : fixedEnvelopeMode === 'desktop-reminder-draft' ? REMINDER_ROOT_KEYS : FIXED_ROOT_KEYS).has(key)),
    fields: {
      messages: !hasOwn(parsed, 'messages')
        ? { status: 'missing' }
        : extracted.status === 'visible'
          ? { status: 'valid', value: extracted.messages }
          : { status: 'malformed' },
      careUpdates: fixedEnvelopeMode === 'wish' ? { status: 'unavailable' } : arrayField(parsed, 'careUpdates'),
      shareResponses: fixedEnvelopeMode === 'wish' ? { status: 'unavailable' } : arrayField(parsed, 'shareResponses'),
      innerReaction,
      ...(fixedEnvelopeMode === 'desktop-reminder-draft' ? {
        reminderAction: !hasOwn(parsed, 'reminderAction') ? { status: 'missing' as const }
          : parsed.reminderAction === null || parsed.reminderAction === 'create_draft' || parsed.reminderAction === 'clarify'
            ? { status: 'valid' as const, value: parsed.reminderAction }
            : { status: 'malformed' as const },
      } : {}),
      ...(fixedEnvelopeMode === 'wish' ? {
        wishDiscussion: !hasOwn(parsed, 'wishDiscussion')
          ? { status: 'missing' as const }
          : wishDiscussion ? { status: 'valid' as const, value: wishDiscussion } : { status: 'malformed' as const },
        memoryMentions: arrayField(parsed, 'memoryMentions'),
      } : {}),
    },
  };
}
