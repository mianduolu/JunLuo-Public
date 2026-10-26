export const RESPONSE_EVIDENCE_MAX_ITEMS = 4;
export const RESPONSE_EVIDENCE_MAX_CODE_POINTS = 60;

export type ResponseEvidenceWireStatus =
  | 'missing'
  | 'null'
  | 'empty'
  | 'valid'
  | 'invalid';

export type ResponseEvidenceWireRejectionCode =
  | 'invalid_json'
  | 'invalid_root'
  | 'too_many_items'
  | 'invalid_item'
  | 'missing_fields'
  | 'extra_fields'
  | 'invalid_signal'
  | 'signal_out_of_range'
  | 'invalid_evidence'
  | 'empty_evidence'
  | 'evidence_too_long';

export interface ResponseEvidenceCandidate {
  signal: number;
  evidence: string;
}

export interface ResponseEvidenceWireDiagnostic {
  returnedCount: number;
  acceptedCount: number;
  discardedCount: number;
  rejectionCodes: ResponseEvidenceWireRejectionCode[];
}

export interface ResponseEvidenceWireParseResult {
  status: ResponseEvidenceWireStatus;
  items: ResponseEvidenceCandidate[];
  diagnostic: ResponseEvidenceWireDiagnostic;
}

function result(input: {
  status: ResponseEvidenceWireStatus;
  items?: ResponseEvidenceCandidate[];
  returnedCount?: number;
  rejectionCode?: ResponseEvidenceWireRejectionCode;
}): ResponseEvidenceWireParseResult {
  const items = input.items ?? [];
  const returnedCount = input.returnedCount ?? items.length;
  return {
    status: input.status,
    items,
    diagnostic: {
      returnedCount,
      acceptedCount: input.status === 'valid' ? items.length : 0,
      discardedCount: input.status === 'invalid' ? returnedCount : 0,
      rejectionCodes: input.rejectionCode ? [input.rejectionCode] : [],
    },
  };
}

function reject(
  rejectionCode: ResponseEvidenceWireRejectionCode,
  returnedCount = 0,
): ResponseEvidenceWireParseResult {
  return result({ status: 'invalid', rejectionCode, returnedCount });
}

export function parseResponseEvidenceWire(input: {
  raw: string | undefined;
  rawSignalCount: number;
}): ResponseEvidenceWireParseResult {
  if (input.raw === undefined) {
    return result({ status: 'missing' });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.raw);
  } catch {
    return reject('invalid_json');
  }

  if (parsed === null) {
    return result({ status: 'null' });
  }
  if (!Array.isArray(parsed)) {
    return reject('invalid_root');
  }
  if (parsed.length === 0) {
    return result({ status: 'empty' });
  }
  if (parsed.length > RESPONSE_EVIDENCE_MAX_ITEMS) {
    return reject('too_many_items', parsed.length);
  }

  const maxSignalIndex = Number.isInteger(input.rawSignalCount) && input.rawSignalCount > 0
    ? Math.min(input.rawSignalCount, RESPONSE_EVIDENCE_MAX_ITEMS)
    : 0;
  const items: ResponseEvidenceCandidate[] = [];

  for (const item of parsed) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return reject('invalid_item', parsed.length);
    }

    const record = item as Record<string, unknown>;
    const keys = Object.keys(record);
    if (!Object.prototype.hasOwnProperty.call(record, 'signal')
      || !Object.prototype.hasOwnProperty.call(record, 'evidence')) {
      return reject('missing_fields', parsed.length);
    }
    if (keys.some((key) => key !== 'signal' && key !== 'evidence')) {
      return reject('extra_fields', parsed.length);
    }
    if (typeof record.signal !== 'number' || !Number.isInteger(record.signal)) {
      return reject('invalid_signal', parsed.length);
    }
    if (record.signal < 1 || record.signal > maxSignalIndex) {
      return reject('signal_out_of_range', parsed.length);
    }
    if (typeof record.evidence !== 'string') {
      return reject('invalid_evidence', parsed.length);
    }
    if (!record.evidence.trim()) {
      return reject('empty_evidence', parsed.length);
    }
    if (Array.from(record.evidence).length > RESPONSE_EVIDENCE_MAX_CODE_POINTS) {
      return reject('evidence_too_long', parsed.length);
    }

    items.push({ signal: record.signal, evidence: record.evidence });
  }

  return result({ status: 'valid', items });
}
