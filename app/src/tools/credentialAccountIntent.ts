export type CredentialAccountIntentRoute = {
  candidateTools: string[];
  reason: string;
  unsupported?: boolean;
};

const RAW_SECRET_REQUEST_PATTERN =
  /(?:api\s*key|apikey|密钥|key|token|cookie).{0,16}(?:原文|明文|完整|显示|给我|告诉我|reveal|看一下|拿出来)|(?:原文|明文|完整|显示|给我|告诉我|reveal).{0,16}(?:api\s*key|apikey|密钥|key|token|cookie)/i;

const CREDENTIAL_STATUS_PATTERN =
  /(?:模型|api|API|key|密钥|连接).{0,16}(?:配好|配置|设置|有没有|有吗|状态|连了)|(?:配好|配置).{0,16}(?:模型|api|API|key|密钥|连接)/;

export function routeCredentialAccountIntent(text: string): CredentialAccountIntentRoute | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  if (RAW_SECRET_REQUEST_PATTERN.test(trimmed)) {
    return {
      candidateTools: [],
      reason: 'credential_reveal_requires_settings',
      unsupported: true,
    };
  }

  if (CREDENTIAL_STATUS_PATTERN.test(trimmed)) {
    return {
      candidateTools: ['credential.check_configured'],
      reason: 'credential_configured_status',
    };
  }

  return null;
}
