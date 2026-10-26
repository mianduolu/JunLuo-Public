import {
  loadCurrentSyncDevice,
} from './syncCurrentDevice';
import {
  CONTINUITY_LEDGER_ADAPTER_ID,
  CONTINUITY_LEDGER_BOOTSTRAP_VERSION,
} from './syncContinuityLedger';
import {
  MEMORY_RECORD_ENTITY_SPECS,
} from './syncMemoryRecords';
import {
  bootstrapMemoryRecordSpecsForIdentity,
  type MemoryRecordsBootstrapRuntimeResult,
} from './syncMemoryRecordsRuntime';
import {
  deactivateMemoryRecordsCapture,
} from './syncMemoryRecordsSqlitePort';

export type ContinuityLedgerBootstrapRuntimeResult =
  MemoryRecordsBootstrapRuntimeResult;

const CONTINUITY_LEDGER_SQLITE_SPECS = MEMORY_RECORD_ENTITY_SPECS.filter(
  (spec) => spec.bootstrapAdapterId === CONTINUITY_LEDGER_ADAPTER_ID,
);

export async function runContinuityLedgerBootstrapRuntime(
  now = Date.now(),
): Promise<ContinuityLedgerBootstrapRuntimeResult> {
  const currentDevice = await loadCurrentSyncDevice();
  if (!currentDevice) {
    await deactivateMemoryRecordsCapture(now);
    return {
      status: 'no-current-device',
      mutationCount: 0,
      captureEnabled: false,
    };
  }
  return bootstrapMemoryRecordSpecsForIdentity({
    adapterId: CONTINUITY_LEDGER_ADAPTER_ID,
    bootstrapVersion: CONTINUITY_LEDGER_BOOTSTRAP_VERSION,
    identity: currentDevice.identity,
    now,
    specs: CONTINUITY_LEDGER_SQLITE_SPECS,
  });
}
