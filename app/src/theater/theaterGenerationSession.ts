import type { createBackupRestoreCoordinator } from '../backup/backupRestoreCoordinator';
import type { TheaterDraftTicket } from './theaterDraftSession';
import {
  TheaterGenerationBasisError, TheaterGenerationCancelledError, TheaterAnchorBasisError, TheaterAnchorReadError,
  type TheaterBinding, type TheaterGenerationSnapshot,
  type createTheaterGenerationRepository,
} from './theaterGenerationStore';
import type { TheaterAdoption, TheaterAnchor, TheaterTextVersion } from './theaterStoryTypes';
import { theaterRegenerationPrefix } from './theaterGenerationMaterials';
import { effectiveTheaterAnchors, theaterUsedAnchorsUnchanged } from './theaterAnchorMaterials';

type Epoch = Pick<ReturnType<typeof createBackupRestoreCoordinator>,
  'captureDataEpoch' | 'canCommitDataEpoch' | 'runDataEpochCommit' | 'subscribeRuntimeState'>;
type Repository = ReturnType<typeof createTheaterGenerationRepository>;
export type TheaterGenerationNotice = 'you-save' | 'reply-failed' | 'opening-failed' | 'stopped'
  | 'reply-save' | 'not-configured' | 'not-configured-saved' | 'network' | 'capacity' | 'provider-capacity'
  | 'changed' | 'anchors-changed' | 'anchor-read' | 'stale-reply' | 'restoring' | 'read-failed'
  | 'regeneration-failed' | 'regeneration-stopped' | 'regeneration-save';
type Operation = {
  binding: TheaterBinding; kind: 'reply' | 'summary'; opening: boolean;
  epoch: number; abort: AbortController; basis?: TheaterAdoption[]; writing?: boolean;
  targetPositionId?: string;
  summaryCheckpoint?: string;
  usedAnchors?: TheaterAnchor[];
  onSummaryStop?: (reason: 'stopped' | 'changed' | 'anchors-changed' | 'restoring') => void;
};
type PendingYou = { ticket: TheaterDraftTicket; version: TheaterTextVersion; basis: TheaterAdoption[]; epoch: number };
type PendingReply = { version: TheaterTextVersion; basis: TheaterAdoption[]; epoch: number; targetPositionId?: string; usedAnchors?: TheaterAnchor[] };
type State = {
  readRevision: number;
  active: { binding: TheaterBinding; kind: 'reply' | 'summary' } | null;
  snapshots: Record<string, TheaterGenerationSnapshot>;
  notices: Record<string, TheaterGenerationNotice | undefined>;
  pending: Record<string, boolean>;
  staleReplies: Record<string, string | undefined>;
  regenerationTargets: Record<string, string | undefined>;
  pendingTexts: Record<string, string | undefined>;
  completedAlternatives: Record<string, TheaterTextVersion | undefined>;
};
type Ports = {
  repository: Repository; epoch: Epoch;
  modelReady: () => boolean;
  reply: (snapshot: TheaterGenerationSnapshot, opening: boolean, signal: AbortSignal) => Promise<string>;
  createId: () => string; now?: () => number;
  onReplySaved?: (binding: TheaterBinding, version: TheaterTextVersion) => void;
  saveAlternative?: (binding: TheaterBinding, version: TheaterTextVersion, expected: TheaterAdoption[],
    isCurrent: () => boolean, usedAnchors?: TheaterAnchor[]) => Promise<TheaterGenerationSnapshot>;
};
export const theaterBindingKey = (binding: TheaterBinding) => JSON.stringify([binding.storyId, binding.branchId]);
const sameBasis = (a: TheaterAdoption[], b: TheaterAdoption[]) => a.length === b.length
  && a.every((value, i) => value.positionId === b[i].positionId && value.versionId === b[i].versionId);

// One owner for all theater pages/branches; views only subscribe. No request queue,
// persisted request, automatic network retry or implicit navigation lives here.
export class TheaterGenerationSession {
  private state: State = { readRevision: 0, active: null, snapshots: {}, notices: {}, pending: {}, staleReplies: {},
    regenerationTargets: {}, pendingTexts: {}, completedAlternatives: {} };
  private listeners = new Set<() => void>();
  private operation: Operation | null = null;
  private pendingYou = new Map<string, PendingYou>();
  private pendingReplies = new Map<string, PendingReply>();
  private unsubscribe: () => void;
  private disposed = false;
  private reads = new Map<string, number>();

  constructor(private ports: Ports) {
    this.unsubscribe = ports.epoch.subscribeRuntimeState((state) => {
      if (state.status === 'ready') {
        // Mounted views may reload data, never resume a request.
        this.update({ readRevision: this.state.readRevision + 1 });
        return;
      }
      const interrupted = this.operation?.binding;
      this.stop('restoring');
      this.pendingYou.clear();
      this.pendingReplies.clear();
      this.reads.clear();
      this.update({ snapshots: {}, pending: {}, staleReplies: {}, regenerationTargets: {}, pendingTexts: {}, completedAlternatives: {},
        notices: interrupted ? { [theaterBindingKey(interrupted)]: 'restoring' } : {} });
    });
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private update(patch: Partial<State>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private notice(binding: TheaterBinding, notice?: TheaterGenerationNotice) {
    this.update({ notices: { ...this.state.notices, [theaterBindingKey(binding)]: notice } });
  }
  private remember(binding: TheaterBinding, snapshot: TheaterGenerationSnapshot) {
    const key = theaterBindingKey(binding);
    this.reads.set(key, (this.reads.get(key) ?? 0) + 1);
    this.update({ snapshots: { ...this.state.snapshots, [key]: snapshot } });
  }
  async refresh(binding: TheaterBinding) {
    const key = theaterBindingKey(binding);
    const epoch = this.ports.epoch.captureDataEpoch();
    if (epoch === null) return;
    const sequence = (this.reads.get(key) ?? 0) + 1;
    this.reads.set(key, sequence);
    try {
      const snapshot = await this.ports.repository.load(binding);
      if (!this.disposed && this.reads.get(key) === sequence && this.ports.epoch.canCommitDataEpoch(epoch)) {
        this.remember(binding, snapshot);
        if (this.state.notices[key] === 'read-failed' || this.state.notices[key] === 'anchor-read' || this.state.notices[key] === 'restoring') this.notice(binding);
        if (!this.state.notices[key] && !this.ports.modelReady()) {
          this.notice(binding, snapshot.versions.some(v => v.kind === 'dialogue' && v.subject === 'you')
            ? 'not-configured-saved' : 'not-configured');
        }
      }
    } catch (error) {
      if (!this.disposed && this.reads.get(key) === sequence && this.ports.epoch.canCommitDataEpoch(epoch)) {
        this.notice(binding, error instanceof TheaterAnchorReadError ? 'anchor-read' : 'read-failed');
      }
    }
  }
  private begin(binding: TheaterBinding, opening: boolean, kind: Operation['kind'] = 'reply') {
    if (this.disposed || this.operation) return null;
    const epoch = this.ports.epoch.captureDataEpoch();
    if (epoch === null) { this.notice(binding, 'restoring'); return null; }
    const operation: Operation = { binding: { storyId: binding.storyId, branchId: binding.branchId },
      opening, kind, epoch, abort: new AbortController() };
    this.operation = operation;
    this.update({ active: { binding: operation.binding, kind } });
    if (kind !== 'summary') this.notice(binding);
    return operation;
  }
  private current(operation: Operation) {
    return !this.disposed && this.operation === operation && !operation.abort.signal.aborted
      && this.ports.epoch.canCommitDataEpoch(operation.epoch);
  }
  private finish(operation: Operation) {
    if (this.operation !== operation) return;
    this.operation = null;
    this.update({ active: null });
  }
  stop(reason: 'stopped' | 'changed' | 'anchors-changed' | 'restoring' = 'stopped') {
    const operation = this.operation;
    if (!operation) return;
    operation.abort.abort();
    this.finish(operation);
    if (operation.kind === 'summary') operation.onSummaryStop?.(reason);
    else this.notice(operation.binding, reason === 'stopped' && operation.targetPositionId ? 'regeneration-stopped' : reason);
  }
  stopBinding(binding: TheaterBinding) {
    if (this.operation && theaterBindingKey(this.operation.binding) === theaterBindingKey(binding)) this.stop('changed');
  }
  private version(binding: TheaterBinding, content: string, subject: 'I' | 'you'): TheaterTextVersion {
    const timestamp = (this.ports.now ?? Date.now)();
    return { id: this.ports.createId(), positionId: this.ports.createId(), conversationId: binding.storyId,
      kind: 'dialogue', subject, content, origin: subject === 'I' ? 'generated' : 'edited',
      createdAt: timestamp, updatedAt: timestamp };
  }
  private async append(operation: Operation, version: TheaterTextVersion, basis: TheaterAdoption[]) {
    operation.writing = true;
    try {
      const result = await this.ports.epoch.runDataEpochCommit(operation.epoch, () => (
        operation.targetPositionId && this.ports.saveAlternative
          ? this.ports.saveAlternative(operation.binding, version, basis, () => this.current(operation), operation.usedAnchors)
          : this.ports.repository.append(operation.binding, version, basis, () => this.current(operation), operation.usedAnchors)
      ));
      if (!result.committed) throw new TheaterGenerationCancelledError();
      return result.value;
    } finally { operation.writing = false; }
  }
  private blockedByReply(binding: TheaterBinding) {
    const blocked = this.pendingReplies.has(theaterBindingKey(binding));
    if (blocked) this.notice(binding, this.pendingReplies.get(theaterBindingKey(binding))?.targetPositionId ? 'regeneration-save' : 'reply-save');
    return blocked;
  }
  async send(ticket: TheaterDraftTicket) {
    if (!ticket.text.trim() || this.operation || this.blockedByReply(ticket)) return;
    // A delayed UI event must not send an already-cleared or replaced draft.
    const fresh = ticket.source.capture();
    if (!fresh || fresh.revision !== ticket.revision || fresh.text !== ticket.text) return;
    const operation = this.begin(ticket, false);
    if (!operation) return;
    const key = theaterBindingKey(ticket);
    try {
      const snapshot = await this.ports.repository.load(ticket);
      if (!this.current(operation)) return;
      const previous = this.pendingYou.get(key);
      const pending: PendingYou = previous?.ticket.source === ticket.source
        && previous.ticket.revision === ticket.revision ? previous : {
          ticket, basis: snapshot.adoptions, version: this.version(ticket, ticket.text, 'you'), epoch: operation.epoch,
        };
      this.pendingYou.set(key, pending);
      await this.saveYouAndReply(operation, pending);
    } catch (error) { this.fail(operation, error, 'you-save'); }
    finally { this.finish(operation); }
  }
  private async saveYouAndReply(operation: Operation, pending: PendingYou) {
    let snapshot: TheaterGenerationSnapshot;
    try {
      snapshot = await this.append(operation, pending.version, pending.basis);
    } catch (error) { this.fail(operation, error, 'you-save'); return; }
    const key = theaterBindingKey(operation.binding);
    if (this.pendingYou.get(key) === pending) this.pendingYou.delete(key);
    pending.ticket.source.acknowledgeSaved(pending.ticket);
    if (!this.current(operation)) return;
    this.remember(operation.binding, snapshot);
    await this.generate(operation, snapshot);
  }
  async retryYou(binding: TheaterBinding) {
    const pending = this.pendingYou.get(theaterBindingKey(binding));
    if (!pending || !this.ports.epoch.canCommitDataEpoch(pending.epoch) || this.blockedByReply(binding)) return;
    const operation = this.begin(binding, false);
    if (!operation) return;
    try { await this.saveYouAndReply(operation, pending); }
    finally { this.finish(operation); }
  }
  async continueReply(binding: TheaterBinding, opening = false) {
    if (this.blockedByReply(binding)) return;
    const operation = this.begin(binding, opening);
    if (!operation) return;
    try {
      const snapshot = await this.ports.repository.load(binding);
      if (!this.current(operation)) return;
      this.remember(binding, snapshot);
      const dialogues = snapshot.versions.filter(version => version.kind === 'dialogue');
      // Neither double-open a story nor append an unsolicited second I reply.
      if (opening ? dialogues.length > 0 : dialogues.at(-1)?.subject !== 'you') return;
      await this.generate(operation, snapshot);
    } catch (error) { this.fail(operation, error, opening ? 'opening-failed' : 'reply-failed'); }
    finally { this.finish(operation); }
  }
  async regenerate(binding: TheaterBinding, positionId: string) {
    if (!this.ports.saveAlternative || this.blockedByReply(binding)) return;
    const operation = this.begin(binding, false);
    if (!operation) return;
    operation.targetPositionId = positionId;
    const key = theaterBindingKey(binding);
    this.update({ regenerationTargets: { ...this.state.regenerationTargets, [key]: positionId } });
    try {
      const snapshot = await this.ports.repository.load(binding);
      if (!this.current(operation)) return;
      const prefix = theaterRegenerationPrefix(snapshot, positionId);
      operation.opening = prefix.adoptions.length === 0;
      operation.basis = snapshot.adoptions.slice(0, prefix.adoptions.length + 1);
      operation.usedAnchors = effectiveTheaterAnchors(prefix);
      this.remember(binding, snapshot);
      if (!this.ports.modelReady()) { this.notice(binding, 'not-configured'); return; }
      const content = await this.ports.reply(prefix, operation.opening, operation.abort.signal);
      if (!this.current(operation)) return;
      if (!content.trim()) throw new Error('theater-empty-response');
      const version = { ...this.version(binding, content, 'I'), positionId };
      await this.saveReply(operation, { version, basis: operation.basis, epoch: operation.epoch, targetPositionId: positionId, usedAnchors: operation.usedAnchors });
    } catch (error) { this.fail(operation, error, 'regeneration-failed'); }
    finally { this.finish(operation); }
  }
  private async generate(operation: Operation, snapshot: TheaterGenerationSnapshot) {
    operation.basis = snapshot.adoptions;
    operation.usedAnchors = effectiveTheaterAnchors(snapshot);
    if (!this.ports.modelReady()) {
      this.notice(operation.binding, operation.opening ? 'not-configured' : 'not-configured-saved');
      return;
    }
    try {
      const content = await this.ports.reply(snapshot, operation.opening, operation.abort.signal);
      if (!this.current(operation)) return;
      if (!content.trim()) throw new Error('theater-empty-response');
      const pending = { version: this.version(operation.binding, content, 'I'), basis: snapshot.adoptions, epoch: operation.epoch, usedAnchors: operation.usedAnchors };
      const youVersionIds: string[] = [];
      for (const version of [...snapshot.versions].reverse()) {
        if (version.kind !== 'dialogue') continue;
        if (version.subject !== 'you') break;
        youVersionIds.unshift(version.id);
      }
      const { iIdentity, youIdentity } = snapshot.story.settings;
      pending.version.coCreation = { branchId: operation.binding.branchId,
        completedAt: (this.ports.now ?? Date.now)(), youVersionIds,
        ...(iIdentity && youIdentity ? { identities: { I: iIdentity, you: youIdentity } } : {}) };
      await this.saveReply(operation, pending);
    } catch (error) { this.fail(operation, error, operation.opening ? 'opening-failed' : 'reply-failed'); }
  }
  private setPending(binding: TheaterBinding, pending: PendingReply | null) {
    const key = theaterBindingKey(binding);
    if (pending) this.pendingReplies.set(key, pending); else this.pendingReplies.delete(key);
    this.update({ pending: { ...this.state.pending, [key]: !!pending },
      pendingTexts: { ...this.state.pendingTexts, [key]: pending?.targetPositionId ? pending.version.content : undefined } });
  }
  private async saveReply(operation: Operation, pending: PendingReply) {
    try {
      // A failed save is not a completion. A committed retry returns the original
      // stored record, so an ambiguous completion cannot refresh its real time.
      if (pending.version.coCreation) pending.version.coCreation.completedAt = (this.ports.now ?? Date.now)();
      const snapshot = await this.append(operation, pending.version, pending.basis);
      if (this.current(operation) || this.pendingReplies.get(theaterBindingKey(operation.binding)) === pending) {
        this.setPending(operation.binding, null);
      }
      if (this.current(operation)) {
        this.remember(operation.binding, snapshot);
        if (pending.targetPositionId) this.update({ completedAlternatives: {
          ...this.state.completedAlternatives, [theaterBindingKey(operation.binding)]: pending.version,
        } });
        this.notice(operation.binding);
      }
      if (!pending.targetPositionId && this.ports.epoch.canCommitDataEpoch(pending.epoch))
        this.ports.onReplySaved?.(operation.binding, snapshot.versions.find((value) => value.id === pending.version.id) ?? pending.version);
    } catch (error) {
      if (!this.current(operation)) return;
      if (error instanceof TheaterAnchorBasisError) {
        this.setPending(operation.binding, null); this.stop('anchors-changed');
      } else if (error instanceof TheaterGenerationBasisError) {
        this.staleReply(operation.binding, pending);
      } else if (!(error instanceof TheaterGenerationCancelledError)) {
        this.setPending(operation.binding, pending);
        this.notice(operation.binding, pending.targetPositionId ? 'regeneration-save' : 'reply-save');
      }
    }
  }
  async retryReplySave(binding: TheaterBinding) {
    const pending = this.pendingReplies.get(theaterBindingKey(binding));
    if (!pending || !this.ports.epoch.canCommitDataEpoch(pending.epoch)) return;
    const operation = this.begin(binding, false);
    if (!operation) return;
    operation.basis = pending.basis;
    operation.targetPositionId = pending.targetPositionId;
    operation.usedAnchors = pending.usedAnchors;
    try { await this.saveReply(operation, pending); }
    finally { this.finish(operation); }
  }
  private staleReply(binding: TheaterBinding, pending: PendingReply) {
    this.setPending(binding, null);
    this.update({ staleReplies: { ...this.state.staleReplies, [theaterBindingKey(binding)]: pending.version.content } });
    this.notice(binding, 'stale-reply');
  }
  private fail(operation: Operation, error: unknown, fallback: TheaterGenerationNotice) {
    if (!this.current(operation)) return;
    const failure = error as { code?: string; stage?: string; kind?: string } | null;
    this.notice(operation.binding, error instanceof TheaterAnchorReadError ? 'anchor-read' : error instanceof TheaterAnchorBasisError ? 'anchors-changed' : error instanceof TheaterGenerationBasisError ? 'changed'
      : failure?.code === 'theater_capacity' ? failure.stage === 'provider' ? 'provider-capacity' : 'capacity'
      : failure?.kind === 'network' && !operation.opening && !operation.targetPositionId ? 'network' : fallback);
  }
  // Existing/future source mutations call this after committing; transaction-time
  // basis checks still reject stale output even if a source notification is missed.
  async sourceChanged(binding: TheaterBinding) {
    const operation = this.operation;
    const key = theaterBindingKey(binding);
    const pending = this.pendingReplies.get(key);
    const matches = operation && theaterBindingKey(operation.binding) === key;
    if (!pending && !matches) return;
    try {
      const snapshot = await this.ports.repository.load(binding);
      if (matches && !operation.writing && operation.usedAnchors && this.current(operation)
        && !theaterUsedAnchorsUnchanged(operation.usedAnchors, snapshot)) this.stop('anchors-changed');
      if (matches && !operation.writing && operation.basis && this.current(operation)
        && (!sameBasis(operation.basis, operation.targetPositionId || operation.kind === 'summary'
          ? snapshot.adoptions.slice(0, operation.basis.length) : snapshot.adoptions)
          || (operation.kind === 'summary' && operation.summaryCheckpoint !== JSON.stringify(snapshot.checkpoint)))) this.stop('changed');
      if (pending && this.pendingReplies.get(key) === pending
        && !sameBasis(pending.basis, pending.targetPositionId ? snapshot.adoptions.slice(0, pending.basis.length) : snapshot.adoptions)) this.staleReply(binding, pending);
    } catch (error) {
      if (matches && operation.kind === 'summary' && !(error instanceof TheaterGenerationBasisError)) throw error;
      if (!(error instanceof TheaterGenerationBasisError)) return;
      if (matches && this.current(operation)) this.stop('changed');
      if (pending && this.pendingReplies.get(key) === pending) this.staleReply(binding, pending);
    }
  }
  async runSummary(binding: TheaterBinding, work: (snapshot: TheaterGenerationSnapshot, signal: AbortSignal) => Promise<string>,
    onStop?: (reason: 'stopped' | 'changed' | 'anchors-changed' | 'restoring') => void) {
    const operation = this.begin(binding, false, 'summary');
    if (!operation) return null;
    operation.onSummaryStop = onStop;
    try {
      const snapshot = await this.ports.repository.load(binding);
      if (!this.current(operation)) return null;
      operation.basis = snapshot.adoptions;
      operation.summaryCheckpoint = JSON.stringify(snapshot.checkpoint);
      operation.usedAnchors = effectiveTheaterAnchors(snapshot);
      const text = await work(snapshot, operation.abort.signal);
      if (!this.current(operation)) return null;
      await this.sourceChanged(binding);
      return this.current(operation) ? text : null;
    } finally { this.finish(operation); }
  }
  dispose() {
    this.stop(); this.disposed = true; this.unsubscribe(); this.listeners.clear();
  }
}
