import {
  bytesToBase64Url,
  canonicalizeJsonBytesV1,
  sha256BytesV1,
} from '../sync/syncCrypto';

function digest(label: string, parts: readonly string[]) {
  return bytesToBase64Url(sha256BytesV1(new TextEncoder().encode(
    `${label}\n${parts.join('\n')}`,
  )));
}

export function createToolAgentHostCallId(turnId: string, providerCallId: string) {
  return digest('junluo.tool-agent.host-call.v1', [turnId, providerCallId]);
}

export function createToolAgentInputHash(input: Record<string, unknown>) {
  return bytesToBase64Url(sha256BytesV1(canonicalizeJsonBytesV1(input)));
}

