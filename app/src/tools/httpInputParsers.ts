export type HttpIntentRoute = {
  candidateTools: string[];
  reason: 'http_named_service_health' | 'http_named_service_status' | 'http_arbitrary_unsupported';
  unsupported?: boolean;
};

const BACKEND_HEALTH_PATTERN =
  /(?:君落)?(?:后端|API|api|服务|接口).{0,18}(?:通不通|连得上|能用吗|健康|检查|正常吗)|(?:健康检查).{0,12}(?:君落后端|后端|API|api|服务)/i;
const BACKEND_STATUS_PATTERN =
  /(?:君落)?(?:后端|API|api|服务|接口).{0,18}(?:状态|status|运行情况|现在怎么样)/i;
const ARBITRARY_HTTP_PATTERN =
  /(?:GET|POST|PUT|PATCH|DELETE)\s+https?:\/\/|(?:请求|调一下|调用|访问).{0,16}(?:API|api|接口|URL|url|https?:\/\/)|(?:带|携带).{0,12}(?:token|Cookie|cookie|Authorization).{0,24}(?:请求|接口|API|api)|(?:上传).{0,20}(?:到|给).{0,10}https?:\/\//i;

export function routeHttpIntent(text: string): HttpIntentRoute | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (BACKEND_STATUS_PATTERN.test(trimmed)) {
    return { candidateTools: ['http.call_named_service'], reason: 'http_named_service_status' };
  }
  if (BACKEND_HEALTH_PATTERN.test(trimmed)) {
    return { candidateTools: ['http.call_named_service'], reason: 'http_named_service_health' };
  }
  if (ARBITRARY_HTTP_PATTERN.test(trimmed)) {
    return { candidateTools: [], reason: 'http_arbitrary_unsupported', unsupported: true };
  }
  return null;
}

export function parseHttpNamedServiceInputFromText(text: string): Record<string, unknown> {
  return BACKEND_STATUS_PATTERN.test(text)
    ? { serviceId: 'junluo_backend.status' }
    : { serviceId: 'junluo_backend.health' };
}
