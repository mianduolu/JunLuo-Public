import type { createBackupRestoreCoordinator } from '../backup/backupRestoreCoordinator';
import { TheaterGenerationBasisError, TheaterAnchorReadError, type TheaterBinding, type TheaterGenerationSnapshot } from './theaterGenerationStore';
import { theaterBindingKey, type TheaterGenerationSession } from './theaterGenerationSession';
import { theaterCheckpointCoverage, theaterSummaryStatus, type TheaterSummarySnapshot, type createTheaterSummaryRepository } from './theaterSummaryStore';
import type { TheaterAdoption, TheaterCheckpoint } from './theaterStoryTypes';
import { parseTheaterSummaryResult } from './theaterSummaryResult';
import { anchorText, type TheaterAnchorSession } from './theaterAnchorSession';

type Epoch = Pick<ReturnType<typeof createBackupRestoreCoordinator>,
  'captureDataEpoch' | 'canCommitDataEpoch' | 'runDataEpochCommit' | 'subscribeRuntimeState'>;
type Page = 'current' | 'history' | 'preview' | 'editor' | 'positions' | 'source';
export type TheaterSummaryDraft = {
  binding: TheaterBinding; content: string; coveredPositionId: string | null; basis: TheaterAdoption[];
  original: string; originalCovered: string | null; generated: boolean; sourceId: string | null;
  review: boolean; reviewed: boolean; missingSource: boolean; unavailable: boolean; epoch: number;
  error: string | null; savedNode?: TheaterCheckpoint;
};
type Confirmation = { kind: 'discard'; next: () => void } | { kind: 'regenerate'; count: number; hasDraft: boolean; next: () => void } | { kind: 'delete'; binding: TheaterBinding;
  id: string; expectedActiveId: string | null; expectedStaleId: string | null; active: boolean };
type State = {
  binding: TheaterBinding | null; visible: boolean; page: Page; previewId: string | null;
  choice: string | null; confirmation: Confirmation | null; busy: boolean;
  snapshots: Record<string, TheaterSummarySnapshot | undefined>;
  drafts: Record<string, TheaterSummaryDraft | undefined>;
  notices: Record<string, string | undefined>; loading: Record<string, boolean | undefined>;
};
export const summaryText = {
  read: '没能读取小抄，请重试。', empty: '先写下第一句台词，再来整理小抄吧。',
  blank: '小抄不能留空。想移除它，请使用「删除小抄」。',
  saving: '小抄还没保存成功，可以重试保存，若需要重启时请先复制留存。',
  changed: '剧情又有变化，请重新查看后再保存。',
  missingPosition: '原来选的台词已经不在了，请重新选择整理到哪一句。',
  deleted: '原来的剧场或走向已删除，这份草稿不能保存，可以复制留存。',
  restored: '备份恢复后，这份草稿不再对应当前记录，可以复制留存。',
  busy: '有一场小剧场正在生成，完成或停止后才能开始下一次。',
  editingBlocked: '正在整理小抄，停止后可以手动编辑。',
  failed: '这次没能整理出小抄，已保存的小抄不会改变。',
  stopped: '已停止整理，已保存的小抄不会改变。',
  sourceChanged: '这次整理使用的小抄已改变，已停止整理。',
  plotChanged: '这次生成依据的剧情已改变，已停止生成。',
  restoring: '正在恢复备份，这次生成已停止。',
  notConfigured: '还没设置聊天模型，可以先手动写小抄。',
  capacity: '这次要带的内容太多，超过了当前设置的容量。台词没有删减。',
  providerCapacity: '模型没能装下这次的内容。台词没有删减。',
  deleteUnknown: '没能确认删除结果，请重新查看。',
} as const;
const key = theaterBindingKey;
const equalBasis = (a: TheaterAdoption[], b: TheaterAdoption[]) => a.length === b.length
  && a.every((v, i) => v.positionId === b[i].positionId && v.versionId === b[i].versionId);
function prefix(snapshot: TheaterGenerationSnapshot, position: string | null) {
  const end = snapshot.adoptions.findIndex(v => v.positionId === position);
  if (end < 0 || snapshot.versions[end]?.kind !== 'dialogue') return null;
  return snapshot.adoptions.slice(0, end + 1).filter((_, i) => snapshot.versions[i]?.kind === 'dialogue').map(v => ({ ...v }));
}
const lastPosition = (snapshot: TheaterGenerationSnapshot) => snapshot.adoptions
  .filter((_, i) => snapshot.versions[i]?.kind === 'dialogue').at(-1)?.positionId ?? null;

// One feature-owned editor per branch, in memory only. No request queue or draft repository.
export class TheaterSummarySession {
  private state: State = { binding: null, visible: false, page: 'current', previewId: null, choice: null,
    confirmation: null, busy: false, snapshots: {}, drafts: {}, notices: {}, loading: {} };
  private listeners = new Set<() => void>();
  private reads = new Map<string, number>();
  private disposed = false;
  private unsubscribe: () => void;
  private running: { binding: TheaterBinding; checkpointId: string | null; signal: AbortSignal } | null = null;
  constructor(private ports: { repository: ReturnType<typeof createTheaterSummaryRepository>; epoch: Epoch;
    generation: TheaterGenerationSession; modelReady: () => boolean;
    preflight: (snapshot: TheaterGenerationSnapshot) => void;
    generate: (snapshot: TheaterGenerationSnapshot, signal: AbortSignal) => Promise<string>;
    anchors?: TheaterAnchorSession;
    createId: () => string; now?: () => number }) {
    this.unsubscribe = ports.epoch.subscribeRuntimeState(state => {
      if (state.status === 'ready') return;
      this.reads.clear();
      const drafts = { ...this.state.drafts };
      for (const id of Object.keys(drafts)) if (drafts[id]) drafts[id] = { ...drafts[id]!, unavailable: true,
        error: summaryText.restored, savedNode: undefined };
      this.update({ snapshots: {}, loading: {}, drafts, confirmation: null, busy: false });
    });
  }
  getSnapshot = () => this.state;
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  private update(patch: Partial<State>) { if (!this.disposed) { this.state = { ...this.state, ...patch }; this.listeners.forEach(fn => fn()); } }
  private notice(binding: TheaterBinding, text?: string) { this.update({ notices: { ...this.state.notices, [key(binding)]: text } }); }
  private draft(binding: TheaterBinding, value?: TheaterSummaryDraft) { this.update({ drafts: { ...this.state.drafts, [key(binding)]: value } }); }
  private current() { return this.state.binding ? this.state.drafts[key(this.state.binding)] : undefined; }
  private dirty(draft: TheaterSummaryDraft) { return draft.generated || draft.content !== draft.original
    || draft.coveredPositionId !== draft.originalCovered; }
  private guard(epoch: number) { return !this.disposed && this.ports.epoch.canCommitDataEpoch(epoch); }
  private afterDiscard(binding: TheaterBinding, next: () => void) {
    const draft = this.state.drafts[key(binding)];
    if (draft && this.dirty(draft)) this.update({ confirmation: { kind: 'discard', next: () => { this.draft(binding); next(); } } });
    else { this.draft(binding); next(); }
  }
  async refresh(binding: TheaterBinding): Promise<TheaterSummarySnapshot | null> {
    const epoch = this.ports.epoch.captureDataEpoch();
    if (epoch === null || this.disposed) return null;
    const id = key(binding), sequence = (this.reads.get(id) ?? 0) + 1;
    this.reads.set(id, sequence); this.update({ loading: { ...this.state.loading, [id]: true } });
    try {
      const snapshot = await this.ports.repository.load(binding);
      if (!this.guard(epoch) || sequence !== this.reads.get(id)) return null;
      this.update({ snapshots: { ...this.state.snapshots, [id]: snapshot }, loading: { ...this.state.loading, [id]: false } });
      if (this.state.notices[id] === summaryText.read || this.state.notices[id] === anchorText.read || this.state.notices[id] === summaryText.deleteUnknown) this.notice(binding);
      this.reconcileDraft(snapshot);
      return snapshot;
    } catch (error) {
      if (!this.guard(epoch) || sequence !== this.reads.get(id)) return null;
      this.update({ snapshots: { ...this.state.snapshots, [id]: undefined }, loading: { ...this.state.loading, [id]: false } });
      const draft = this.state.drafts[id];
      if (error instanceof TheaterGenerationBasisError && draft) this.draft(binding, { ...draft, unavailable: true,
        error: summaryText.deleted, savedNode: undefined });
      this.notice(binding, error instanceof TheaterAnchorReadError ? anchorText.read : error instanceof TheaterGenerationBasisError ? summaryText.deleted : summaryText.read);
      return null;
    }
  }
  private reconcileDraft(snapshot: TheaterSummarySnapshot) {
    const binding = { storyId: snapshot.story.id, branchId: snapshot.branch.id }, draft = this.state.drafts[key(binding)];
    if (!draft || draft.unavailable) return;
    const basis = prefix(snapshot, draft.coveredPositionId);
    const missingSource = !!draft.sourceId && !snapshot.checkpoints.some(v => v.id === draft.sourceId);
    if (!basis || !equalBasis(basis, draft.basis)) this.draft(binding, { ...draft, review: true, reviewed: false,
      missingSource, savedNode: undefined, error: basis ? summaryText.changed : summaryText.missingPosition });
    else if (missingSource !== draft.missingSource) this.draft(binding, { ...draft, missingSource });
  }
  async open(binding: TheaterBinding) {
    if (this.state.busy) return;
    const enter = () => { this.update({ binding: { ...binding }, visible: true, page: 'current', previewId: null }); void this.refresh(binding); };
    if (this.state.visible && this.state.binding && key(this.state.binding) !== key(binding) && this.current()) {
      this.afterDiscard(this.state.binding, enter);
    } else enter();
  }
  close() {
    if (this.state.busy) return;
    if (this.state.confirmation) { this.update({ confirmation: null }); return; }
    if (this.state.page === 'positions' || this.state.page === 'source') { this.update({ page: 'editor' }); return; }
    const next = () => this.update({ visible: false, confirmation: null });
    if (this.state.binding && this.state.page === 'editor') this.afterDiscard(this.state.binding, next); else next();
  }
  show(page: 'current' | 'history') { if (!this.state.busy) this.update({ page, previewId: null }); }
  preview(id: string) { if (!this.state.busy) this.update({ previewId: id, page: 'preview' }); }
  viewDraft() { if (this.current() && !this.state.busy) this.update({ page: 'editor' }); }
  async edit(sourceId?: string) {
    const binding = this.state.binding;
    if (!binding || this.state.busy) return;
    const page = this.state.page;
    const stillHere = () => this.state.visible && this.state.binding === binding && this.state.page === page;
    const editingBlocked = () => {
      const operation = this.ports.generation.getSnapshot().active;
      return operation?.kind === 'summary' && key(operation.binding) === key(binding);
    };
    const active = this.ports.generation.getSnapshot().active;
    if (active?.kind === 'summary' && key(active.binding) === key(binding)) { this.notice(binding, summaryText.editingBlocked); return; }
    const snapshot = await this.refresh(binding);
    if (!snapshot || !stillHere()) return;
    if (editingBlocked()) { this.notice(binding, summaryText.editingBlocked); return; }
    const source = sourceId ? snapshot.checkpoints.find(v => v.id === sourceId) : null;
    if (sourceId && !source) { this.notice(binding, summaryText.read); return; }
    this.afterDiscard(binding, () => {
      if (!stillHere()) return;
      if (editingBlocked()) { this.notice(binding, summaryText.editingBlocked); return; }
      const epoch = this.ports.epoch.captureDataEpoch(); if (epoch === null) return;
      const position = source ? source.coveredPositionId : lastPosition(snapshot);
      const review = !!source && (source.id === snapshot.branch.staleCheckpointId
        || theaterCheckpointCoverage(snapshot, source) === null);
      this.draft(binding, { binding: { ...binding }, content: source?.content ?? '', original: source?.content ?? '',
        coveredPositionId: position, originalCovered: position, basis: source?.basis.map(v => ({ ...v })) ?? prefix(snapshot, position) ?? [],
        generated: false, sourceId: source?.id ?? null, review, reviewed: !review, missingSource: false,
        unavailable: false, error: null, epoch });
      this.notice(binding); this.update({ page: 'editor', confirmation: null });
    });
  }
  change(content: string) {
    const draft = this.current(); if (!draft || this.state.busy || draft.unavailable) return;
    this.draft(draft.binding, { ...draft, content, savedNode: undefined,
      error: draft.review && !draft.reviewed ? draft.error : null });
  }
  async choosePosition() {
    const draft = this.current(); if (!draft || this.state.busy || draft.unavailable) return;
    const binding = this.state.binding;
    if (await this.refresh(draft.binding) && this.state.visible && this.state.binding === binding && this.state.page === 'editor') {
      this.update({ page: 'positions', choice: draft.coveredPositionId });
    }
  }
  selectPosition(id: string) { if (!this.state.busy) this.update({ choice: id }); }
  confirmPosition() {
    const draft = this.current(), snapshot = draft && this.state.snapshots[key(draft.binding)];
    if (!draft || !snapshot || this.state.busy || draft.unavailable) return;
    const basis = prefix(snapshot, this.state.choice); if (!basis) return;
    // The picker displays actual text. It changes the bookmark only, never the body.
    this.draft(draft.binding, { ...draft, coveredPositionId: this.state.choice, basis,
      reviewed: true, savedNode: undefined, error: null });
    this.update({ page: 'editor' });
  }
  async review() {
    const draft = this.current(); if (!draft || this.state.busy || draft.unavailable) return;
    const binding = this.state.binding;
    const snapshot = await this.refresh(draft.binding);
    if (!snapshot || !this.state.visible || this.state.binding !== binding || this.state.page !== 'editor') return;
    const current = this.state.drafts[key(draft.binding)]; if (!current || current.unavailable) return;
    const basis = prefix(snapshot, current.coveredPositionId);
    this.draft(draft.binding, { ...current, basis: basis ?? current.basis, reviewed: !!basis,
      savedNode: undefined, error: basis ? null : summaryText.missingPosition });
    this.update({ page: 'source' });
  }
  async save() {
    let draft = this.current();
    if (!draft || this.state.busy || draft.unavailable) return;
    if (!draft.content.trim()) { this.draft(draft.binding, { ...draft, error: summaryText.blank }); return; }
    this.update({ busy: true });
    try {
    const snapshot = await this.refresh(draft.binding); draft = this.current();
    if (!snapshot || !draft || draft.unavailable) return;
    if (!lastPosition(snapshot)) { this.draft(draft.binding, { ...draft, error: summaryText.empty }); return; }
    if (!prefix(snapshot, draft.coveredPositionId) || (draft.review && !draft.reviewed)) return;
    const stamp = (this.ports.now ?? Date.now)();
    const node: TheaterCheckpoint = draft.savedNode ?? { id: this.ports.createId(), conversationId: draft.binding.storyId,
      branchId: draft.binding.branchId, content: draft.content, coveredPositionId: draft.coveredPositionId,
      basis: draft.basis, status: 'saved', createdAt: stamp, updatedAt: stamp };
    draft = { ...draft, savedNode: node }; this.draft(draft.binding, draft);
    const saving = draft;
    try {
      const result = await this.ports.epoch.runDataEpochCommit(saving.epoch, () => this.ports.repository.save(saving.binding,
        node, () => this.guard(saving.epoch) && this.state.drafts[key(saving.binding)] === saving));
      if (!result.committed || !this.guard(saving.epoch)) return;
      this.draft(saving.binding); this.update({ snapshots: { ...this.state.snapshots, [key(saving.binding)]: result.value }, page: 'current' });
      this.notice(saving.binding); await this.ports.generation.refresh(saving.binding);
    } catch (error) {
      if (this.guard(saving.epoch)) {
        if (error instanceof TheaterGenerationBasisError) { await this.refresh(saving.binding);
          const latest = this.state.drafts[key(saving.binding)];
          if (latest && !latest.unavailable) this.draft(saving.binding, { ...latest, review: true, reviewed: false,
            savedNode: undefined, error: summaryText.changed });
        } else this.draft(saving.binding, { ...saving, error: summaryText.saving });
      }
    }
    } finally { this.update({ busy: false }); }
  }
  async requestGenerate(binding = this.state.binding) {
    if (!binding || this.state.busy) return;
    if (this.ports.generation.getSnapshot().active) { this.notice(binding, summaryText.busy); return; }
    const viewBinding = this.state.binding, page = this.state.page;
    const fromVisibleEditor = this.state.visible && viewBinding && key(viewBinding) === key(binding);
    const snapshot = await this.refresh(binding); if (!snapshot) return;
    if (fromVisibleEditor && (!this.state.visible || this.state.binding !== viewBinding || this.state.page !== page)) return;
    if (!lastPosition(snapshot)) { this.notice(binding, summaryText.empty); return; }
    if (!this.ports.modelReady()) { this.notice(binding, summaryText.notConfigured); return; }
    try { this.ports.preflight(snapshot); } catch (error) { this.generationFailure(binding, error); return; }
    const prepare = () => {
      const count = this.ports.anchors?.count(binding) ?? 0;
      if (count) this.update({ confirmation: { kind: 'regenerate', count,
        hasDraft: !!this.state.drafts[key(binding)] && this.dirty(this.state.drafts[key(binding)]!), next: () => {
          this.draft(binding); this.ports.anchors?.discardCandidates(binding); void this.generate(binding);
        } } });
      else this.afterDiscard(binding, () => { this.update({ confirmation: null }); void this.generate(binding); });
    };
    if (this.ports.anchors) this.ports.anchors.resolveEditor(binding, prepare); else prepare();
  }
  private generationFailure(binding: TheaterBinding, error: unknown) {
    const failure = error as { code?: string; stage?: string } | null;
    this.notice(binding, error instanceof TheaterGenerationBasisError ? summaryText.plotChanged : failure?.code === 'theater_capacity'
      ? failure.stage === 'provider' ? summaryText.providerCapacity : summaryText.capacity : summaryText.failed);
  }
  private async generate(binding: TheaterBinding) {
    if (this.ports.generation.getSnapshot().active) { this.notice(binding, summaryText.busy); return; }
    const epoch = this.ports.epoch.captureDataEpoch(); if (epoch === null) return;
    let basis: TheaterGenerationSnapshot | null = null;
    let request: typeof this.running = null;
    this.notice(binding);
    try {
      const text = await this.ports.generation.runSummary(binding, async (snapshot, signal) => {
        basis = snapshot;
        request = { binding, checkpointId: snapshot.checkpoint?.id ?? null, signal };
        this.running = request;
        const text = await this.ports.generate(snapshot, signal);
        if (!signal.aborted) {
          const latest = await this.ports.repository.load(binding);
          if (!signal.aborted && this.running === request
            && JSON.stringify(latest.checkpoint) !== JSON.stringify(snapshot.checkpoint)) {
            this.stop(); this.notice(binding, summaryText.sourceChanged);
          }
        }
        return text;
      }, reason => this.notice(binding, reason === 'restoring' ? summaryText.restoring
        : reason === 'anchors-changed' ? anchorText.stopped : reason === 'changed' ? summaryText.plotChanged : summaryText.stopped));
      if (text === null || !basis || !this.guard(epoch)) return;
      if (!text.trim()) { this.notice(binding, summaryText.failed); return; }
      const snapshot: TheaterGenerationSnapshot = basis;
      const parsed = parseTheaterSummaryResult(text, snapshot);
      const position = lastPosition(snapshot);
      this.draft(binding, { binding: { ...binding }, content: parsed.summary, original: '', originalCovered: position,
        coveredPositionId: position, basis: prefix(snapshot, position) ?? [], generated: true,
        sourceId: snapshot.checkpoint?.id ?? null, review: false, reviewed: true, missingSource: false,
        unavailable: false, error: null, epoch });
      this.ports.anchors?.receive(binding, snapshot, parsed.candidates, epoch);
      if (parsed.incompleteCandidates) this.notice(binding, anchorText.incomplete);
      if (this.state.visible && this.state.binding && key(this.state.binding) === key(binding)) this.update({ page: 'editor' });
    } catch (error) { if (this.guard(epoch) && !(request as typeof this.running)?.signal.aborted) this.generationFailure(binding, error); }
    finally { if (this.running === request) this.running = null; }
  }
  stop() {
    if (this.ports.generation.getSnapshot().active?.kind === 'summary') this.ports.generation.stop();
  }
  async sourceChanged(binding: TheaterBinding) {
    await this.ports.anchors?.refresh(binding);
    const running = this.running;
    const snapshot = await this.refresh(binding);
    if (running && this.running === running && key(running.binding) === key(binding)) {
      if (!snapshot && this.state.notices[key(binding)] !== summaryText.deleted) return;
      if (!snapshot || snapshot.checkpoint?.id !== (running.checkpointId ?? undefined)) {
        this.stop(); this.notice(binding, snapshot ? summaryText.sourceChanged : summaryText.plotChanged);
      } else await this.ports.generation.sourceChanged(binding);
    }
  }
  async requestDelete(id: string) {
    const binding = this.state.binding; if (!binding || this.state.busy) return;
    const page = this.state.page;
    const snapshot = await this.refresh(binding);
    if (!snapshot || !snapshot.checkpoints.some(v => v.id === id) || !this.state.visible
      || this.state.binding !== binding || this.state.page !== page) return;
    this.update({ confirmation: { kind: 'delete', binding: { ...binding }, id,
      expectedActiveId: snapshot.branch.activeCheckpointId, expectedStaleId: snapshot.branch.staleCheckpointId ?? null,
      active: snapshot.branch.activeCheckpointId === id } });
  }
  cancelConfirmation() { if (!this.state.busy) this.update({ confirmation: null }); }
  async confirm() {
    const confirmation = this.state.confirmation; if (!confirmation || this.state.busy) return;
    if (confirmation.kind === 'discard' || confirmation.kind === 'regenerate') { this.update({ confirmation: null }); confirmation.next(); return; }
    const epoch = this.ports.epoch.captureDataEpoch(); if (epoch === null) return;
    this.update({ busy: true });
    try {
      const result = await this.ports.epoch.runDataEpochCommit(epoch, () => this.ports.repository.remove(confirmation.binding,
        confirmation.id, confirmation.expectedActiveId, () => this.guard(epoch), confirmation.expectedStaleId));
      if (!result.committed || !this.guard(epoch)) return;
      this.update({ snapshots: { ...this.state.snapshots, [key(confirmation.binding)]: result.value },
        confirmation: null, previewId: null, page: 'history' });
      this.reconcileDraft(result.value); this.notice(confirmation.binding);
      await this.sourceChanged(confirmation.binding); await this.ports.generation.refresh(confirmation.binding);
    } catch {
      if (this.guard(epoch)) { this.update({ confirmation: null }); this.notice(confirmation.binding, summaryText.deleteUnknown); }
    } finally { this.update({ busy: false }); }
  }
  status(binding: TheaterBinding) { const snapshot = this.state.snapshots[key(binding)]; return snapshot ? theaterSummaryStatus(snapshot) : null; }
  dispose() { this.stop(); this.disposed = true; this.unsubscribe(); this.listeners.clear(); }
}
