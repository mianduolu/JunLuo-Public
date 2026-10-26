import {
  assertSyncUuidV4,
} from './syncDeviceContract';

const ADAPTER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

function assertAdapterId(adapterId: string) {
  if (
    adapterId.length < 1
    || adapterId.length > 80
    || !ADAPTER_ID_PATTERN.test(adapterId)
  ) {
    throw new Error('bootstrap adapterId 格式无效。');
  }
}

function assertBootstrapVersion(version: number) {
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error('bootstrap version 必须是正安全整数。');
  }
}

export function syncBootstrapOperationId(input: {
  adapterId: string;
  version: number;
  sourceDeviceId: string;
}) {
  assertAdapterId(input.adapterId);
  assertBootstrapVersion(input.version);
  assertSyncUuidV4(input.sourceDeviceId, 'bootstrap sourceDeviceId');
  return `bootstrap:v${input.version}:${input.adapterId}:${input.sourceDeviceId}`;
}
