import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import { canCommitBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import type { ContactOpportunity } from './unifiedContact';
import { contactMessageId } from './unifiedContact';

/** The existing opportunity owns the snapshot; the original reminder rows own its receipt. */
export async function recordContactScheduleRecoveryProvided(op: ContactOpportunity, message: SubjectiveMessage) {
  const batch = op.scheduleRecovery;
  if (op.important || op.phoneEmergency || !batch?.events.length || batch.sessionId !== op.sessionId
    || !canCommitBackupRestoreDataEpoch(op.epoch) || message.role !== 'I' || message.source !== 'proactive-message'
    || message.deliveryStatus === 'failed' || !message.content.trim()) return;
  const index = op.messages.findIndex((_text, index) => contactMessageId(op, index) === message.id);
  if (index < 0 || message.content !== op.messages[index]) return;
  const { loadScheduleRecoveryBatch, acknowledgeScheduleRecoveryBatch } = await import('../schedule/scheduleReminderRecovery');
  const current = await loadScheduleRecoveryBatch(op.sessionId, [], Date.now(), true);
  const events = batch.events.filter(event => current.events.some(row => row.id === event.id
    && row.occurrenceId === event.occurrenceId && row.scheduledAt === event.scheduledAt
    && row.itemUpdatedAt === event.itemUpdatedAt && row.notifiedAt === event.notifiedAt));
  if (!events.length) return;
  await runBackupRestoreDataEpochCommit(op.epoch, () => acknowledgeScheduleRecoveryBatch({ ...batch, events }, op.sessionId));
}
