import type { createBackupRestoreCoordinator } from '../backup/backupRestoreCoordinator';
import { theaterBindingKey as key } from './theaterGenerationSession';
import { TheaterGenerationBasisError, type TheaterBinding, type TheaterGenerationSnapshot } from './theaterGenerationStore';
import { sameTheaterAnchor, TheaterAnchorConflictError, type createTheaterAnchorRepository, type TheaterAnchorSnapshot } from './theaterAnchorStore';
import { effectiveTheaterAnchors, theaterUsedAnchorsUnchanged } from './theaterAnchorMaterials';
import type { TheaterAdoption, TheaterAnchor } from './theaterStoryTypes';

type Epoch = Pick<ReturnType<typeof createBackupRestoreCoordinator>, 'captureDataEpoch' | 'canCommitDataEpoch' | 'runDataEpochCommit' | 'subscribeRuntimeState'>;
type Evidence = { adoptions: TheaterAdoption[]; anchors: TheaterAnchor[] };
export type TheaterAnchorCandidate = { id: string; content: string; positionId: string | null; sourceVersionId: string | null;
  review: boolean; unavailable: boolean; error: string | null; evidence: Evidence; epoch: number };
export type TheaterAnchorDraft = {
  binding: TheaterBinding; content: string; positionId: string | null; sourceVersionId: string | null;
  originalContent: string; originalPosition: string | null; expected: TheaterAnchor | null; source: TheaterAnchor['source'];
  candidateId?: string; evidence?: Evidence; review: boolean; unavailable: boolean; missing: boolean;
  conflict: boolean; error: string | null; epoch: number; saved?: TheaterAnchor; receipt?: TheaterAnchor; reviewedAnchor?: TheaterAnchor;
};
type State = { binding: TheaterBinding | null; visible: boolean; page: 'list' | 'editor' | 'positions' | 'source';
  choice: string | null; busy: boolean; confirmation: { kind: 'discard'; next: () => void } | { kind: 'unpin'; anchor: TheaterAnchor } | null;
  snapshots: Record<string, TheaterAnchorSnapshot | undefined>; drafts: Record<string, TheaterAnchorDraft | undefined>;
  candidates: Record<string, TheaterAnchorCandidate[]>; notices: Record<string, string | undefined> };
export const anchorText = {
  read: '没能读取剧情锚点，请重试。', empty: '先写下第一句台词，再来添加剧情锚点吧。',
  saving: '没能保存这条锚点，可以重试保存；若需要重启，请先复制留存。',
  stale: '这条锚点对应的台词已修改，请核对后再使用。',
  missingPosition: '原来选的台词已经不在了，请重新选择发生位置。',
  deleted: '原来的剧场或走向已删除，这份草稿不能保存，可以复制留存。',
  restored: '备份恢复后，这份草稿不再对应当前记录，可以复制留存。',
  conflict: '这条锚点已有新的修改，请重新查看。', unpinned: '这条锚点已取消固定，可以保存为新锚点。',
  unpinUnknown: '没能确认取消固定的结果，请重新查看。',
  candidateChanged: '这条候选的依据已变化，请核对后再固定。',
  stopped: '这次生成使用的剧情锚点已改变，已停止生成。',
  incomplete: '候选锚点未能完整读取，可以手动补充。',
} as const;
const equalPrefix = (basis: TheaterAdoption[], snapshot: TheaterAnchorSnapshot) => basis.every((v, i) =>
  v.positionId === snapshot.adoptions[i]?.positionId && v.versionId === snapshot.adoptions[i]?.versionId);
const materialSnapshot = (snapshot: TheaterAnchorSnapshot): TheaterGenerationSnapshot => ({ ...snapshot, checkpoint: null });
const evidenceValid = (e: Evidence, s: TheaterAnchorSnapshot) => equalPrefix(e.adoptions, s)
  && theaterUsedAnchorsUnchanged(e.anchors, materialSnapshot(s));
const evidenceOf = (s: TheaterGenerationSnapshot): Evidence => ({ adoptions: s.adoptions.map(v => ({ ...v })),
  anchors: effectiveTheaterAnchors(s).map(v => ({ ...v })) });

// Saved anchors stay in the original story DB. Editors and model suggestions are
// feature-owned, per-origin memory only; neither is a second persistence channel.
export class TheaterAnchorSession {
  private state: State = { binding: null, visible: false, page: 'list', choice: null, busy: false, confirmation: null,
    snapshots: {}, drafts: {}, candidates: {}, notices: {} };
  private listeners = new Set<() => void>();
  private reads = new Map<string, number>();
  private disposed = false;
  private unsubscribe: () => void;
  constructor(private ports: { repository: ReturnType<typeof createTheaterAnchorRepository>; epoch: Epoch;
    createId: () => string; now?: () => number; onChanged: (binding: TheaterBinding) => Promise<void> }) {
    this.unsubscribe = ports.epoch.subscribeRuntimeState(s => {
      if (s.status === 'ready') return;
      this.reads.clear();
      const drafts = { ...this.state.drafts }, candidates = { ...this.state.candidates };
      for (const id of Object.keys(drafts)) if (drafts[id]) drafts[id] = { ...drafts[id]!, unavailable: true, saved: undefined, error: anchorText.restored };
      for (const id of Object.keys(candidates)) candidates[id] = candidates[id].map(v => ({ ...v, unavailable: true, error: anchorText.restored }));
      this.update({ snapshots: {}, drafts, candidates, busy: false, confirmation: null });
    });
  }
  getSnapshot = () => this.state;
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  private update(patch: Partial<State>) { if (!this.disposed) { this.state = { ...this.state, ...patch }; this.listeners.forEach(f => f()); } }
  private guard(epoch: number) { return !this.disposed && this.ports.epoch.canCommitDataEpoch(epoch); }
  private notice(binding: TheaterBinding, text?: string) { this.update({ notices: { ...this.state.notices, [key(binding)]: text } }); }
  private put(d: TheaterAnchorDraft) { this.update({ drafts: { ...this.state.drafts, [key(d.binding)]: d } }); }
  private current() { return this.state.binding ? this.state.drafts[key(this.state.binding)] : undefined; }
  private dirty(d: TheaterAnchorDraft) { return !!d.candidateId || d.content !== d.originalContent || d.positionId !== d.originalPosition || !!d.saved; }
  private afterDiscard(next: () => void) {
    const d = this.current();
    const discard = () => { if (d) this.update({ drafts: { ...this.state.drafts, [key(d.binding)]: undefined } }); next(); };
    if (d && this.dirty(d)) this.update({ confirmation: { kind: 'discard', next: discard } }); else discard();
  }
  resolveEditor(binding: TheaterBinding, next: () => void) {
    if (this.state.busy) return;
    if (this.state.binding && key(this.state.binding) === key(binding) && this.current()) this.afterDiscard(() => {
      this.update({ visible: false }); next();
    });
    else next();
  }
  private reconcile(binding: TheaterBinding, snapshot: TheaterAnchorSnapshot | null) {
    const id = key(binding), candidates = this.state.candidates[id] ?? [];
    this.update({ candidates: { ...this.state.candidates, [id]: candidates.map(v => v.unavailable ? v : !snapshot
      ? { ...v, unavailable: true, error: anchorText.deleted }
      : !evidenceValid(v.evidence, snapshot) ? { ...v, review: true, error: anchorText.candidateChanged } : v) } });
    const d = this.state.drafts[id]; if (!d || d.unavailable) return;
    if (!snapshot) { this.put({ ...d, unavailable: true, saved: undefined, error: anchorText.deleted }); return; }
    const adopted = snapshot.adoptions.find(v => v.positionId === d.positionId);
    const attempt = d.saved ?? d.receipt;
    const latest = snapshot.anchors.find(v => v.id === (d.expected?.id ?? attempt?.id));
    // A receipt failure may have committed. Keep its exact retry record until
    // save() asks the repository to recognize it; do not relabel it a conflict.
    if (latest && attempt && sameTheaterAnchor(latest, attempt)) {
      this.put({ ...d, expected: latest, receipt: undefined }); return;
    }
    if (d.expected && !latest) {
      this.put({ ...d, expected: null, missing: true, saved: undefined,
        error: adopted ? anchorText.unpinned : anchorText.missingPosition });
    } else if (latest && (!d.expected || !sameTheaterAnchor(latest, d.expected))) {
      this.put({ ...d, conflict: true, saved: undefined, error: anchorText.conflict });
    }
    const current = this.state.drafts[id]!;
    if (!adopted && d.positionId) this.put({ ...current, saved: undefined, error: anchorText.missingPosition });
    else if ((adopted && adopted.versionId !== d.sourceVersionId) || (d.evidence && !evidenceValid(d.evidence, snapshot))) {
      this.put({ ...current, review: true, saved: undefined, error: d.candidateId ? anchorText.candidateChanged : anchorText.stale });
    }
  }
  async refresh(binding: TheaterBinding) {
    const epoch = this.ports.epoch.captureDataEpoch(); if (epoch === null || this.disposed) return null;
    const id = key(binding), seq = (this.reads.get(id) ?? 0) + 1; this.reads.set(id, seq);
    try {
      const snapshot = await this.ports.repository.load(binding);
      if (!this.guard(epoch) || this.reads.get(id) !== seq) return null;
      this.update({ snapshots: { ...this.state.snapshots, [id]: snapshot ?? undefined } });
      this.notice(binding, snapshot ? undefined : anchorText.deleted); this.reconcile(binding, snapshot); return snapshot;
    } catch {
      if (this.guard(epoch) && this.reads.get(id) === seq) {
        this.update({ snapshots: { ...this.state.snapshots, [id]: undefined } }); this.notice(binding, anchorText.read);
      }
      return null;
    }
  }
  async open(binding: TheaterBinding, focusId?: string) {
    if (this.state.busy) return;
    const enter = () => { this.update({ binding: { ...binding }, visible: true, page: 'list', confirmation: null, choice: focusId ?? null }); void this.refresh(binding); };
    if (this.state.visible && this.current()) this.afterDiscard(enter); else enter();
  }
  close() {
    if (this.state.busy) return;
    if (this.state.confirmation) { this.update({ confirmation: null }); return; }
    if (this.state.page === 'positions' || this.state.page === 'source') { this.update({ page: 'editor' }); return; }
    const next = () => this.update({ visible: false, confirmation: null });
    if (this.state.page === 'editor') this.afterDiscard(next); else next();
  }
  async edit(binding: TheaterBinding, input: { anchorId?: string; positionId?: string; candidateId?: string } = {}) {
    if (this.state.busy) return;
    const previous = this.state.binding;
    const snapshot = await this.refresh(binding); if (!snapshot || this.state.binding !== previous) return;
    if (!snapshot.versions.some(v => v.kind === 'dialogue')) { this.notice(binding, anchorText.empty); return; }
    const anchor = input.anchorId ? snapshot.anchors.find(v => v.id === input.anchorId) : undefined;
    const candidate = input.candidateId ? this.state.candidates[key(binding)]?.find(v => v.id === input.candidateId) : undefined;
    if ((input.anchorId && !anchor) || (input.candidateId && !candidate)) return;
    const version = snapshot.versions.find(v => v.positionId === input.positionId && v.kind === 'dialogue');
    const epoch = this.ports.epoch.captureDataEpoch(); if (epoch === null) return;
    const positionId = anchor?.positionId ?? candidate?.positionId ?? version?.positionId ?? null;
    const content = anchor?.content ?? candidate?.content ?? version?.content ?? '';
    const review = anchor ? !effectiveTheaterAnchors(materialSnapshot(snapshot)).some(v => v.id === anchor.id) : candidate?.review ?? false;
    const enter = () => {
      this.put({ binding: { ...binding }, content, positionId, sourceVersionId: anchor?.sourceVersionId ?? candidate?.sourceVersionId ?? version?.id ?? null,
        originalContent: anchor ? content : '', originalPosition: positionId, expected: anchor ?? null,
        source: anchor?.source ?? (candidate ? 'summary' : version ? 'message' : 'manual'), candidateId: candidate?.id,
        evidence: candidate?.evidence, review, unavailable: candidate?.unavailable ?? false, missing: false,
        conflict: false, error: candidate?.error ?? (review ? anchorText.stale : null), epoch: candidate?.epoch ?? epoch });
      this.update({ binding: { ...binding }, visible: true, page: 'editor', confirmation: null });
    };
    if (this.state.visible && this.current()) this.afterDiscard(enter); else enter();
  }
  change(content: string) { const d = this.current(); if (d && !d.unavailable && !this.state.busy)
    this.put({ ...d, content, receipt: d.saved ?? d.receipt, saved: undefined }); }
  async choosePosition() {
    const d = this.current(); if (!d || d.unavailable || this.state.busy) return;
    if (await this.refresh(d.binding)) this.update({ page: 'positions', choice: d.positionId });
  }
  selectPosition(id: string) { if (!this.state.busy) this.update({ choice: id }); }
  confirmPosition() {
    const d = this.current(), s = d && this.state.snapshots[key(d.binding)];
    const v = s?.versions.find(v => v.positionId === this.state.choice && v.kind === 'dialogue');
    if (!d || !v || d.unavailable || this.state.busy) return;
    this.put({ ...d, positionId: v.positionId, sourceVersionId: v.id, receipt: d.saved ?? d.receipt, saved: undefined, error: d.review ? d.error : null });
    this.update({ page: 'editor' });
  }
  async viewSource() {
    const d = this.current(); if (!d || d.unavailable || this.state.busy) return;
    if (await this.refresh(d.binding)) this.update({ page: 'source' });
  }
  async reviewConflict() {
    const d = this.current(); if (!d || this.state.busy || d.unavailable) return;
    const s = await this.refresh(d.binding); if (!s) return;
    const latest = d.expected && s.anchors.find(v => v.id === d.expected!.id);
    const current = this.current(); if (!current || current.unavailable) return;
    this.put({ ...current, expected: latest ?? null, conflict: false, missing: !latest,
      review: true, reviewedAnchor: latest || undefined, saved: undefined, error: latest ? null : anchorText.unpinned });
  }
  async save(reviewed = false) {
    let d = this.current(); if (!d || d.unavailable || d.conflict || this.state.busy || !d.content.trim() || !d.positionId) return;
    const reviewBasis = (s: TheaterAnchorSnapshot | undefined, draft: TheaterAnchorDraft) => JSON.stringify(s && {
      source: s.adoptions.find(v => v.positionId === draft.positionId),
      prefix: draft.evidence ? s.adoptions.slice(0, draft.evidence.adoptions.length) : undefined,
      anchors: draft.evidence?.anchors.map(v => s.anchors.find(current => current.id === v.id) ?? null),
    });
    const seen = reviewBasis(this.state.snapshots[key(d.binding)], d);
    this.update({ busy: true });
    try {
      const s = await this.refresh(d.binding); d = this.current();
      if (!s || !d || d.unavailable || d.conflict || (d.review && !reviewed)) return;
      const version = s.versions.find(v => v.positionId === d!.positionId && v.kind === 'dialogue');
      if (!version) return;
      if (reviewed && seen !== reviewBasis(s, d)) {
        this.put({ ...d, review: true, saved: undefined, error: d.candidateId ? anchorText.candidateChanged : anchorText.stale }); return;
      }
      // The explicit reviewed save binds the displayed draft to current evidence.
      if (reviewed && !d.saved) d = { ...d, sourceVersionId: version.id,
        evidence: d.candidateId ? { adoptions: s.adoptions.slice(0, d.evidence?.adoptions.length),
          anchors: effectiveTheaterAnchors(materialSnapshot(s)).filter(v => d!.evidence?.anchors.some(old => old.id === v.id)) } : undefined };
      if (version.id !== d.sourceVersionId) return;
      const now = Math.max((this.ports.now ?? Date.now)(), (d.expected?.updatedAt ?? -1) + 1);
      const node = d.saved ?? { id: d.expected?.id ?? this.ports.createId(), conversationId: d.binding.storyId,
        branchId: d.binding.branchId, positionId: d.positionId!, sourceVersionId: version.id,
        source: d.source, content: d.content, confirmed: true, createdAt: d.expected?.createdAt ?? now, updatedAt: now };
      const saving = { ...d, saved: node }; this.put(saving);
      try {
        const result = await this.ports.epoch.runDataEpochCommit(d.epoch, () => this.ports.repository.save(saving.binding,
          node, saving.expected, () => this.guard(saving.epoch) && this.state.drafts[key(saving.binding)] === saving, saving.evidence));
        if (!result.committed || !this.guard(saving.epoch)) return;
        if (saving.candidateId) this.ignore(saving.binding, saving.candidateId);
        this.update({ snapshots: { ...this.state.snapshots, [key(saving.binding)]: result.value },
          drafts: { ...this.state.drafts, [key(saving.binding)]: undefined }, page: 'list' });
        this.notice(saving.binding); await this.ports.onChanged(saving.binding);
      } catch (error) {
        if (!this.guard(saving.epoch)) return;
        if (error instanceof TheaterGenerationBasisError) { await this.refresh(saving.binding); }
        else this.put({ ...saving, error: anchorText.saving });
      }
    } finally { this.update({ busy: false }); }
  }
  receive(binding: TheaterBinding, snapshot: TheaterGenerationSnapshot,
    candidates: { content: string; positionId: string | null; sourceVersionId: string | null }[], epoch: number) {
    if (!this.guard(epoch)) return;
    const evidence = evidenceOf(snapshot);
    this.update({ candidates: { ...this.state.candidates, [key(binding)]: candidates.map(v => ({ ...v,
      id: this.ports.createId(), evidence, epoch, review: false, unavailable: false, error: null })) } });
  }
  count(binding: TheaterBinding) { return this.state.candidates[key(binding)]?.length ?? 0; }
  discardCandidates(binding: TheaterBinding) { this.update({ candidates: { ...this.state.candidates, [key(binding)]: [] } }); }
  ignore(binding: TheaterBinding, id: string) { this.update({ candidates: { ...this.state.candidates,
    [key(binding)]: (this.state.candidates[key(binding)] ?? []).filter(v => v.id !== id) } }); }
  async fix(binding: TheaterBinding, id: string) {
    const candidate = this.state.candidates[key(binding)]?.find(v => v.id === id);
    if (!candidate || candidate.unavailable) return;
    await this.edit(binding, { candidateId: id });
    const d = this.current(); if (d?.candidateId === id && !d.review && d.positionId) await this.save();
  }
  requestUnpin(anchor: TheaterAnchor) { if (!this.state.busy) this.update({ confirmation: { kind: 'unpin', anchor } }); }
  cancelConfirmation() { if (!this.state.busy) this.update({ confirmation: null }); }
  async confirm() {
    const c = this.state.confirmation; if (!c || this.state.busy) return;
    if (c.kind === 'discard') { this.update({ confirmation: null }); c.next(); return; }
    const binding = { storyId: c.anchor.conversationId, branchId: c.anchor.branchId };
    const epoch = this.ports.epoch.captureDataEpoch(); if (epoch === null) return;
    this.update({ busy: true });
    try {
      const r = await this.ports.epoch.runDataEpochCommit(epoch, () => this.ports.repository.remove(binding, c.anchor, () => this.guard(epoch)));
      if (r.committed && this.guard(epoch)) {
        this.update({ confirmation: null, snapshots: { ...this.state.snapshots, [key(binding)]: r.value } });
        this.reconcile(binding, r.value);
        await this.ports.onChanged(binding);
      }
    } catch (error) { if (this.guard(epoch)) {
      this.update({ confirmation: null });
      if (error instanceof TheaterAnchorConflictError) { await this.refresh(binding); this.notice(binding, anchorText.conflict); }
      else this.notice(binding, anchorText.unpinUnknown);
    } }
    finally { this.update({ busy: false }); }
  }
  dispose() { this.disposed = true; this.unsubscribe(); this.listeners.clear(); }
}
