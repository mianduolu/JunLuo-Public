export type MemoryOrganizationFailureKind =
  | 'network'
  | 'http'
  | 'empty'
  | 'invalid_json'
  | 'invalid_candidate'
  | 'database'
  | 'source_changed'
  | 'unknown';

export type MemoryOrganizationFailure = {
  httpStatus?: number;
  kind: MemoryOrganizationFailureKind;
  technicalCode: string;
};

function readErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : '';
}

export function classifyMemoryOrganizationFailure(error: unknown): MemoryOrganizationFailure {
  const message = readErrorMessage(error);
  if (message === 'MEMORY_SOURCE_CHANGED') return { kind: 'source_changed', technicalCode: 'source_changed' };
  const httpMatch = /^memory-organize-http-(\d{3})$/i.exec(message);
  if (httpMatch) {
    const httpStatus = Number(httpMatch[1]);
    return {
      httpStatus,
      kind: 'http',
      technicalCode: `http_${httpStatus}`,
    };
  }
  if (message === 'memory-organize-empty') {
    return { kind: 'empty', technicalCode: 'empty_response' };
  }
  if (/memory-candidate-contract-invalid|memory-candidates-not-array|memory-understanding-.*(?:invalid|duplicate|missing)/i.test(message)) {
    return { kind: 'invalid_candidate', technicalCode: 'invalid_candidate_contract' };
  }
  if (error instanceof SyntaxError || /unexpected token|json parse|json_parse/i.test(message)) {
    return { kind: 'invalid_json', technicalCode: 'invalid_json' };
  }
  if (/network request failed|failed to fetch|network error|timed? ?out|aborterror/i.test(message)) {
    return { kind: 'network', technicalCode: 'network_unavailable' };
  }
  if (/sqlite|database|transaction|memory-ingestion|memory_ingestion/i.test(message)) {
    return { kind: 'database', technicalCode: 'local_database' };
  }
  return { kind: 'unknown', technicalCode: 'unknown' };
}

export function getMemoryOrganizationFailureNotice(failure: MemoryOrganizationFailure) {
  switch (failure.kind) {
    case 'network':
      return '整理服务这次没有连通，原消息仍可重试。';
    case 'http':
      return failure.httpStatus
        ? `整理服务暂时没有成功返回（HTTP ${failure.httpStatus}），原消息仍可重试。`
        : '整理服务暂时没有成功返回，原消息仍可重试。';
    case 'empty':
      return '整理模型这次没有返回可读取内容，原消息仍可重试。';
    case 'invalid_json':
      return '整理模型这次返回的格式无法读取，原消息仍可重试。';
    case 'invalid_candidate':
      return '整理结果缺少必要字段或真实来源，原消息仍可重试。';
    case 'database':
      return '整理结果暂时无法写入本地处理记录，原消息仍可重试。';
    default:
      return '整理没有完成，原消息仍可重试。';
  }
}
