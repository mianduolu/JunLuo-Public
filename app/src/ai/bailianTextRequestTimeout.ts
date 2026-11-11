const BAILIAN_TEXT_WAIT_MS = 310_000;

export function bailianTextRequestTimeoutMs(baseUrl: string, existingMs: number, preparationMs = 0): number {
  let endpoint: URL;
  try { endpoint = new URL(baseUrl.trim()); }
  catch { return existingMs; }
  const host = endpoint.hostname.toLowerCase();
  const official = host === 'dashscope.aliyuncs.com' || host === 'dashscope-intl.aliyuncs.com'
    || host === 'token-plan.cn-beijing.maas.aliyuncs.com'
    || /^[a-z0-9-]+\.(?:cn-beijing|ap-southeast-1|us-east-1|eu-central-1|ap-northeast-1|cn-hongkong)\.maas\.aliyuncs\.com$/.test(host);
  return endpoint.protocol === 'https:' && official ? Math.max(existingMs, BAILIAN_TEXT_WAIT_MS + preparationMs) : existingMs;
}
