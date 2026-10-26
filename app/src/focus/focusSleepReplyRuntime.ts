import type { ActiveFocusSession, FocusLogEntry } from './focusStore';
import type { PreparedJunluoFocusChatTurn } from './focusChatProtocol';
import type { captureBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { isFocusSleeping } from './focusSleepReplies';
import { makeFocusSleepReplyReceipts, selectFocusSleepReplySources } from './focusSleepReplyPolicy';
import { formatFocusGenerationFailure, type FocusGenerationFailure } from './focusGenerationFailure';

type Log = Omit<FocusLogEntry, 'sessionId'>;
type Epoch = ReturnType<typeof captureBackupRestoreDataEpoch>;
type Reply = { contents: string[]; rawEnvelope: string; prepared: PreparedJunluoFocusChatTurn | null; cancelled?: boolean; failure?: FocusGenerationFailure };
type Delivery = { session: ActiveFocusSession; epoch: Epoch; sources: Log[]; reply: Reply; logs: Log[] };

// A page-local delivery worker; the raw sources and successful receipt live in the original journal.
export function createFocusSleepReplyRuntime(deps: {
  getSession: () => ActiveFocusSession | null;
  readSession: () => Promise<ActiveFocusSession | null>;
  isVisible: () => boolean;
  isBusy: () => boolean;
  wait: () => Promise<boolean>;
  cancelWait: () => void;
  captureEpoch: () => Epoch;
  canCommit: (epoch: Epoch) => boolean;
  sleeping?: () => Promise<boolean>;
  generate: (session: ActiveFocusSession, sources: Log[], epoch: Epoch) => Promise<Reply>;
  makeLog: (role: 'I' | 'system', content: string, elapsed: number, trigger: string) => Log;
  failureText: string;
  save: (logs: Log[], session: ActiveFocusSession, epoch: Epoch) => Promise<boolean>;
  commit: (delivery: Delivery) => Promise<void>;
  started: () => Promise<void>;
  finished: (saved: boolean, epoch: Epoch) => Promise<void>;
}) {
  const sleeping = deps.sleeping ?? isFocusSleeping;
  const attempted = new Set<string>();
  let startedAt = 0;
  let sessionEpoch: Epoch = null;
  let busy = false;
  let waiting = false;
  let visibilityRevision = 0;
  let delivery: Delivery | undefined;
  let claimed: string[] = [];
  const externalClaims = new Set<string>();
  const enterSession = (nextStartedAt: number, epoch: Epoch) => {
    if (nextStartedAt === startedAt && epoch === sessionEpoch) return;
    startedAt = nextStartedAt;
    sessionEpoch = epoch;
    attempted.clear();
    delivery = undefined;
    claimed = [];
    externalClaims.clear();
  };
  const current = (session: ActiveFocusSession, epoch: Epoch) => (
    deps.canCommit(epoch) && deps.getSession()?.startedAt === session.startedAt
  );
  const persist = async (pending: Delivery) => {
    if (!current(pending.session, pending.epoch)) { delivery = undefined; return false; }
    if (!deps.isVisible()) return false;
    const saved = await deps.save(pending.logs, pending.session, pending.epoch);
    if (!saved || !current(pending.session, pending.epoch)) return false;
    delivery = undefined;
    if (pending.reply.contents.length) await deps.commit(pending).catch(error => {
      console.warn('[focus] sleep reply auxiliary save unavailable', error);
    });
    return true;
  };
  const tick = async () => {
    if (busy || !deps.isVisible() || deps.isBusy()) return;
    const session = deps.getSession();
    const epoch = deps.captureEpoch();
    if (!session || epoch === null) return;
    enterSession(session.startedAt, epoch);
    busy = true;
    const visibility = visibilityRevision;
    let occupied = false;
    let savedReply = false;
    try {
      if (delivery) {
        claimed = delivery.sources.map(log => log.id);
        const pending = delivery;
        savedReply = await persist(pending) && pending.reply.contents.length > 0;
        return;
      }
      const initial = await deps.readSession();
      if (!initial || initial.startedAt !== startedAt || !current(session, epoch)
        || !deps.isVisible() || deps.isBusy() || await sleeping()) return;
      if (!current(session, epoch) || !deps.isVisible() || deps.isBusy() || externalClaims.size) return;
      const first = selectFocusSleepReplySources(initial.logs);
      if (first.blocked || !first.pending.length || attempted.has(JSON.stringify(first.pending.map(log => log.id)))) return;
      waiting = true;
      const ready = await deps.wait();
      waiting = false;
      if (!ready || visibility !== visibilityRevision || !current(session, epoch) || !deps.isVisible() || deps.isBusy()) return;
      // The three-second window may contain new progress. Only snapshot after that window.
      const snapshot = await deps.readSession();
      if (!snapshot || snapshot.startedAt !== startedAt || !current(session, epoch)
        || !deps.isVisible() || deps.isBusy() || await sleeping()) return;
      if (!current(session, epoch) || !deps.isVisible() || deps.isBusy() || externalClaims.size) return;
      const selected = selectFocusSleepReplySources(snapshot.logs);
      const key = JSON.stringify(selected.pending.map(log => log.id));
      if (selected.blocked || !selected.pending.length || attempted.has(key)) return;
      claimed = selected.pending.map(log => log.id);
      await deps.started();
      occupied = true;
      if (!current(session, epoch) || !deps.isVisible() || await sleeping()) return;
      attempted.add(key);
      const reply = await deps.generate(snapshot, selected.pending, epoch);
      if (reply.cancelled) { attempted.delete(key); return; }
      if (!current(session, epoch)) return;
      const elapsed = deps.getSession()!.elapsedSeconds;
      const replyLogs = reply.contents.length
        ? reply.contents.map(content => deps.makeLog('I', content, elapsed, 'focus-sleep-reply'))
        : [deps.makeLog('system', formatFocusGenerationFailure(reply.failure, deps.failureText), elapsed, 'focus-sleep-reply-failed')];
      const logs = reply.contents.length
        ? [...replyLogs, ...makeFocusSleepReplyReceipts(selected.pending, replyLogs)] : replyLogs;
      delivery = { session: snapshot, epoch, sources: selected.pending, reply, logs };
      // Keep an already generated answer through local save failure or a hidden page.
      savedReply = await persist(delivery) && reply.contents.length > 0;
    } catch (error) {
      console.warn('[focus] sleep reply unavailable', error);
    } finally {
      if (!delivery) claimed = [];
      waiting = false;
      busy = false;
      if (occupied) await deps.finished(savedReply, epoch).catch(() => undefined);
    }
  };
  return {
    tick,
    claimedSourceIds: () => {
      const session = deps.getSession(), epoch = deps.captureEpoch();
      if (session && epoch !== null) enterSession(session.startedAt, epoch);
      return [...new Set([...claimed, ...externalClaims])];
    },
    claimSources: (sources: Log[]) => {
      const session = deps.getSession();
      if (!session) return false;
      enterSession(session.startedAt, deps.captureEpoch());
      if (claimed.length || externalClaims.size || delivery) return false;
      for (const source of sources) externalClaims.add(source.id);
      return true;
    },
    releaseSources: (sources: Log[], expectedStartedAt: number, epoch: Epoch) => {
      if (startedAt !== expectedStartedAt || epoch !== sessionEpoch) return;
      for (const source of sources) externalClaims.delete(source.id);
    },
    noteAttempt: (sources: Log[]) => {
      const session = deps.getSession();
      if (!session) return;
      enterSession(session.startedAt, deps.captureEpoch());
      attempted.add(JSON.stringify(sources.map(log => log.id)));
    },
    deliver: async (pending: Delivery) => {
      if (!current(pending.session, pending.epoch)) return false;
      enterSession(pending.session.startedAt, pending.epoch);
      if (delivery) throw new Error('Focus sleep reply delivery is already pending');
      delivery = pending;
      claimed = pending.sources.map(log => log.id);
      const saved = await persist(pending);
      if (!delivery) claimed = [];
      return saved;
    },
    suspend: () => { visibilityRevision += 1; if (waiting && !deps.isBusy()) deps.cancelWait(); },
    retry: () => { attempted.clear(); return tick(); },
  };
}
