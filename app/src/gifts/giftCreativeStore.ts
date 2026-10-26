import { canCommitBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import { getMemoryDatabase } from '../memory/memoryStore';
import { createGiftCreativeOpportunityState, type GiftCreativeOpportunityState } from './giftCreativeOpportunity';
import type { GiftCreationResponse } from '../ai/giftCreationRequest';
import type { GiftToolCheckpoint } from './giftToolTurn';
import type { JunLuoToolAgentContinuationMessage } from '../tools/toolAgentMessages';

export type GiftCreativeRun = {
  key: string; sourceStamp: string; configStamp: string; historyStamp: string;
  checkpoint: GiftToolCheckpoint; continuation: JunLuoToolAgentContinuationMessage[];
  requestCount: number; callCount: number; requesting: boolean;
  response: GiftCreationResponse | null; responseIndex: number; executing: string | null;
  changed: boolean;
};
export type GiftCreativeState = { revision: number; opportunity: GiftCreativeOpportunityState;
  run: GiftCreativeRun | null; retryAt: number };
type Row = { revision: number; state_json: string };
function parse(row: Row): GiftCreativeState {
  const value = JSON.parse(row.state_json) as GiftCreativeState;
  if (value.revision !== row.revision || !Number.isSafeInteger(value.revision) || value.revision < 1
    || value.opportunity?.version !== 1 || !Number.isFinite(value.retryAt)
    || value.run && (typeof value.run.key !== 'string' || !Array.isArray(value.run.continuation)
      || !Number.isSafeInteger(value.run.requestCount) || value.run.requestCount < 0 || value.run.requestCount > 3
      || !Number.isSafeInteger(value.run.callCount) || value.run.callCount < 0 || value.run.callCount > 4
      || typeof value.run.requesting !== 'boolean')) throw Error('gift-creative-invalid-state');
  return value;
}
export async function loadGiftCreativeState(epoch: number | null): Promise<GiftCreativeState> {
  const row = await (await getMemoryDatabase()).getFirstAsync<Row>('SELECT * FROM gift_creation_run WHERE singleton=1');
  if (!canCommitBackupRestoreDataEpoch(epoch)) throw Error('gift-stale-data-epoch');
  return row ? parse(row) : { revision: 0, opportunity: createGiftCreativeOpportunityState(), run: null, retryAt: 0 };
}
/** The one existing SQLite row is both the opportunity receipt and unfinished paid work. */
export async function saveGiftCreativeState(epoch: number | null, previous: GiftCreativeState,
  changes: Omit<GiftCreativeState, 'revision'>): Promise<GiftCreativeState> {
  const value = JSON.parse(JSON.stringify({ ...changes, revision: previous.revision + 1 })) as GiftCreativeState;
  const lease = await runBackupRestoreDataEpochCommit(epoch, async () => {
    const database = await getMemoryDatabase();
    await database.withExclusiveTransactionAsync(async transaction => {
      if (!canCommitBackupRestoreDataEpoch(epoch)) throw Error('gift-stale-data-epoch');
      const result = previous.revision === 0
        ? await transaction.runAsync('INSERT OR IGNORE INTO gift_creation_run(singleton,revision,state_json) VALUES(1,?,?)', value.revision, JSON.stringify(value))
        : await transaction.runAsync('UPDATE gift_creation_run SET revision=?,state_json=? WHERE singleton=1 AND revision=?', value.revision, JSON.stringify(value), previous.revision);
      if (result.changes !== 1) throw Error('gift-creative-stale-state');
      if (!canCommitBackupRestoreDataEpoch(epoch)) throw Error('gift-stale-data-epoch');
    });
    return value;
  });
  if (!lease.committed) throw Error('gift-stale-data-epoch');
  return lease.value;
}
