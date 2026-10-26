import type { JunLuoToolInputPreviewValue } from './toolAuditTypes';

const MAX_INPUT_PREVIEW_FIELDS = 12;
const MAX_STRING_PREVIEW_LENGTH = 120;
const MAX_AUDIT_TEXT_LENGTH = 240;
const MAX_AUDIT_SCAN_LENGTH = MAX_AUDIT_TEXT_LENGTH * 4;
const REDACTED_PREVIEW = '[redacted]';

const SENSITIVE_FIELD_NAMES = new Set([
  'authorization',
  'api_key',
  'access_token',
  'refresh_token',
  'token',
  'secret',
  'client_secret',
  'private_key',
  'password',
  'passwd',
  'cookie',
  'credential',
  'credentials',
]);

const PRIVATE_TEXT_FIELD_NAMES = new Set([
  'body',
  'body_text',
  'content',
  'text',
  'message',
  'prompt',
  'query',
  'note',
  'notes',
]);

const URL_FIELD_NAMES = new Set(['url', 'uri', 'endpoint', 'href']);

function normalizeFieldName(value: string) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-z0-9]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function matchesFieldName(fieldName: string, names: Set<string>) {
  const normalized = normalizeFieldName(fieldName);
  const compact = normalized.replaceAll('_', '');
  return [...names].some((name) => {
    const compactName = name.replaceAll('_', '');
    return normalized === name
      || normalized.endsWith(`_${name}`)
      || compact === compactName
      || compact.endsWith(compactName);
  });
}

function sanitizeAuditUrl(value: string) {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    // Keep a conservative fallback for URL-like values that the runtime parser rejects.
  }
  const queryIndex = value.indexOf('?');
  const fragmentIndex = value.indexOf('#');
  const indexes = [queryIndex, fragmentIndex].filter((index) => index >= 0);
  const withoutQuery = indexes.length ? value.slice(0, Math.min(...indexes)) : value;
  return withoutQuery.replace(
    /^([a-z][a-z0-9+.-]*:\/\/)(?:[^/\s]*@)(.*)$/i,
    '$1$2',
  );
}

export function sanitizeToolAuditText(value: string) {
  return value
    .slice(0, MAX_AUDIT_SCAN_LENGTH)
    .replace(
      /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>，。；、！？：…）】》」』]+/gi,
      (url) => sanitizeAuditUrl(url),
    )
    .replace(
      /(^|[^a-z0-9_])((?:"|')?(?:authorization|cookie)(?:"|')?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n]*)/gi,
      '$1$2[redacted]',
    )
    .replace(
      /\bBearer\s+(?:\[redacted\]|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[a-z0-9._~+\/=:-]+)/gi,
      'Bearer [redacted]',
    )
    .replace(/\bsk-[a-z0-9_-]{8,}\b/gi, REDACTED_PREVIEW)
    .replace(
      /\b(?:AIza[a-z0-9_-]{20,}|gh[pousr]_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,})\b/gi,
      REDACTED_PREVIEW,
    )
    .replace(
      /((?:"|')?(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|private[_ -]?key|token|secret|password|passwd)(?:"|')?\s*[:=]\s*)(?:\[redacted\]|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}\]]+)/gi,
      '$1[redacted]',
    )
    .slice(0, MAX_AUDIT_TEXT_LENGTH);
}

export function sanitizeToolAuditFieldName(value: string) {
  return sanitizeToolAuditText(value).slice(0, 64) || '[field]';
}

export function previewToolInputValue(value: unknown, fieldName = ''): JunLuoToolInputPreviewValue {
  if (value === null) return null;
  if (typeof value === 'string') {
    if (matchesFieldName(fieldName, SENSITIVE_FIELD_NAMES)) return REDACTED_PREVIEW;
    if (
      matchesFieldName(fieldName, URL_FIELD_NAMES)
      || /^[a-z][a-z0-9+.-]*:\/\//i.test(value)
    ) {
      return sanitizeToolAuditText(sanitizeAuditUrl(value))
        .slice(0, MAX_STRING_PREVIEW_LENGTH);
    }
    if (matchesFieldName(fieldName, PRIVATE_TEXT_FIELD_NAMES)) {
      return `[private text: ${value.length} chars]`;
    }
    return sanitizeToolAuditText(value).slice(0, MAX_STRING_PREVIEW_LENGTH);
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) return { type: 'array', length: value.length };
  if (value && typeof value === 'object') {
    return {
      type: 'object',
      keys: Object.keys(value)
        .slice(0, MAX_INPUT_PREVIEW_FIELDS)
        .map(sanitizeToolAuditFieldName),
    };
  }
  return { type: 'unknown' };
}

export function buildToolInputPreview(input: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(input)
      .slice(0, MAX_INPUT_PREVIEW_FIELDS)
      .map(([key, value]) => [
        sanitizeToolAuditFieldName(key),
        previewToolInputValue(value, key),
      ]),
  );
}
