import {
  advanceEmergencyCutoverJournal,
  type EmergencySyncWorldCutoverJournalV1,
} from './syncEmergencyWorldRebuild';

export type EmergencyWorldCutoverPorts = Readonly<{
  closeConnections(): Promise<void>;
  moveOldDatabaseToRollback(): Promise<void>;
  activateStagedDatabase(): Promise<void>;
  activatePendingSecret(): Promise<void>;
  verifyActivatedWorld(): Promise<void>;
  completeCutover(): Promise<void>;
  saveJournal(journal: EmergencySyncWorldCutoverJournalV1): Promise<void>;
  now(): number;
}>;

export async function resumeEmergencyWorldCutover(
  initial: EmergencySyncWorldCutoverJournalV1,
  ports: EmergencyWorldCutoverPorts,
) {
  let journal = initial;
  const advance = async (
    stage: EmergencySyncWorldCutoverJournalV1['stage'],
  ) => {
    journal = advanceEmergencyCutoverJournal(
      journal,
      stage,
      ports.now(),
    );
    await ports.saveJournal(journal);
  };
  if (journal.stage === 'prepared') {
    await ports.closeConnections();
    await advance('connections-closed');
  }
  if (journal.stage === 'connections-closed') {
    await ports.moveOldDatabaseToRollback();
    await advance('old-database-moved');
  }
  if (journal.stage === 'old-database-moved') {
    await ports.activateStagedDatabase();
    await advance('new-database-activated');
  }
  if (journal.stage === 'new-database-activated') {
    await ports.activatePendingSecret();
    await advance('new-secret-activated');
  }
  if (journal.stage === 'new-secret-activated') {
    await ports.verifyActivatedWorld();
    await advance('verified');
  }
  if (journal.stage === 'verified') {
    await ports.completeCutover();
  }
  return journal;
}
