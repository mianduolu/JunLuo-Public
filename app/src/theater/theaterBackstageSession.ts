import { fullBackstageSelection, renderBackstageCard, type BackstageSelection, type BackstageSource } from './theaterBackstageMaterial';
import type { TheaterBinding } from './theaterGenerationStore';
import type { TheaterBackstageMessageSource } from '../ai/subjectiveMessages';

export const backstageText = {
  entry: '带回聊天', title: '挑选这次要聊的内容',
  description: '这次材料有点多，可以少带一些，或把要带的内容写短一点。原故事不会改变。',
  overflow: '材料还是有点多，再减少一些，或暂时不带。',
  failed: '这次没能准备好材料，可以重试。',
  storyGone: '这场小剧场已删除，本次不再携带。',
  branchGone: '这条走向已删除，本次不再携带。',
  expired: '这次的小卡已用满六次。',
};
export type BackstageMode = 'full' | 'slim';
export type BackstagePrepared = { source: BackstageSource; selection: BackstageSelection; mode: BackstageMode;
  batch?: { id: string; usedCount: number } };
export type BackstageLoad = { source: BackstageSource } | { missing: 'story' | 'branch' };
type Ports = {
  load: (binding: TheaterBinding) => Promise<BackstageLoad>;
  fits: (card: string) => Promise<boolean>;
  save: (value: BackstagePrepared, isCurrent: () => boolean) => Promise<void>;
  clear: () => Promise<void>;
  epoch: () => number | null;
  onReady: () => void;
  createId?: () => string;
};
type Stage = 'closed' | 'loading' | 'selecting' | 'overflow' | 'failed' | 'gone' | 'ready';
export type BackstageState = {
  stage: Stage; busy: boolean; binding: TheaterBinding | null;
  source: BackstageSource | null; selection: BackstageSelection | null; mode: BackstageMode;
  prepared: BackstagePrepared | null; notice: string | null;
};
const initial = (): BackstageState => ({ stage: 'closed', busy: false, binding: null,
  source: null, selection: null, mode: 'full', prepared: null, notice: null });
const sameBinding = (a: TheaterBinding, b: TheaterBinding) => a.storyId === b.storyId && a.branchId === b.branchId;

/** Device-local activation; request dispatch and share consumption stay with the chat owner. */
export class TheaterBackstageSession {
  private state = initial();
  private listeners = new Set<() => void>();
  private revision = 0;
  private epoch: number | null = null;
  private retryClear = false;
  private sourceDirty = false;
  private capacityEdit: { batchId: string; fits: (card: string) => Promise<boolean> } | null = null;
  private retryRecovery: (() => Promise<void>) | null = null;
  private countSaveFailed = false;
  private receiptRecovery: { batchId: string; save: () => Promise<void> } | null = null;
  constructor(private ports: Ports) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<BackstageState>) {
    if ('prepared' in patch && patch.prepared?.batch?.id !== this.state.prepared?.batch?.id) {
      this.receiptRecovery = null; this.countSaveFailed = false;
    }
    this.state = { ...this.state, ...patch }; this.listeners.forEach(listener => listener());
  }
  private current(token: number) { return token === this.revision && this.epoch !== null && this.ports.epoch() === this.epoch; }
  async open(binding: TheaterBinding, mode: BackstageMode = 'full') {
    if (this.state.busy) return;
    ++this.revision; this.epoch = this.ports.epoch();
    this.capacityEdit = null; this.retryRecovery = null;
    this.retryClear = false;
    this.update({ stage: 'loading', binding: { ...binding }, source: null, selection: null, mode, notice: null });
    await this.prepare(false);
  }
  private async read(token: number) {
    const binding = this.state.binding;
    if (!binding || !this.current(token)) return null;
    const loaded = await this.ports.load(binding);
    if (!this.current(token)) return null;
    if ('missing' in loaded) {
      const affectsActive = !this.state.prepared || sameBinding(binding, this.state.prepared.source.binding);
      this.update({ stage: 'gone', ...(affectsActive ? { prepared: null } : {}),
        notice: loaded.missing === 'story' ? backstageText.storyGone : backstageText.branchGone });
      if (!affectsActive) {
        await this.ports.save(this.state.prepared!, () => this.current(token)); return null;
      }
      this.retryClear = true;
      await this.ports.clear();
      if (this.current(token)) this.retryClear = false;
      return null;
    }
    if (!sameBinding(binding, loaded.source.binding)) throw new Error('theater-backstage-binding-mismatch');
    return loaded.source;
  }
  private reconcile(source: BackstageSource) {
    const old = this.state.source, selected = this.state.selection;
    if (!old || !selected) return fullBackstageSelection(source);
    // Preserve edits in their buffers, but never silently carry them against changed evidence.
    return { world: { ...selected.world, included: selected.world.included && source.world === old.world },
      checkpoint: { ...selected.checkpoint, included: selected.checkpoint.included
        && source.checkpoint?.id === old.checkpoint?.id && source.checkpoint?.content === old.checkpoint?.content },
      anchorIds: selected.anchorIds.filter(id => source.anchors.some(a => a.id === id
        && old.anchors.some(b => b.id === id && b.content === a.content))),
      lineIds: selected.lineIds.filter(id => source.lines.some(a => a.id === id
        && old.lines.some(b => b.id === id && b.content === a.content && b.subject === a.subject))),
    } satisfies BackstageSelection;
  }
  private async prepare(confirm: boolean) {
    if (this.state.busy || !this.state.binding) return;
    const token = ++this.revision;
    this.sourceDirty = false;
    this.update({ busy: true, notice: null });
    try {
      if (!this.current(token)) throw new Error('theater-backstage-epoch');
      const source = await this.read(token);
      if (!source) return;
      const changed = !!this.state.source && source.revision !== this.state.source.revision;
      const selection = this.reconcile(source);
      this.update({ source, selection });
      if (changed) { this.update({ stage: 'selecting' }); return; }
      const card = renderBackstageCard(source, selection, this.state.mode);
      const fits = await (this.capacityEdit?.fits ?? this.ports.fits)(card);
      if (!this.current(token)) return;
      if (!fits) { this.update({ stage: confirm ? 'overflow' : 'selecting' }); return; }
      // Capacity work may await other local inputs. Check the story again before committing.
      const latest = await this.read(token);
      if (!latest) return;
      if (latest.revision !== source.revision) {
        this.update({ selection: this.reconcile(latest), source: latest, stage: 'selecting' }); return;
      }
      const previous = this.state.prepared;
      const batch = this.capacityEdit && previous?.batch?.id === this.capacityEdit.batchId ? previous.batch
        : { id: this.ports.createId?.() ?? `backstage-${Date.now()}-${Math.random().toString(36).slice(2)}`, usedCount: 0 };
      const prepared: BackstagePrepared = { source: latest, selection, mode: this.state.mode, batch };
      if (renderBackstageCard(latest, selection, this.state.mode) !== card) {
        // Even a rename can increase request size. Retry must measure the new card.
        this.update({ source: latest, stage: 'failed', notice: backstageText.failed }); return;
      }
      await this.ports.save(prepared, () => this.current(token));
      if (!this.current(token)) return;
      this.sourceDirty = false;
      const afterSave = await this.read(token);
      if (!afterSave) return;
      if (this.sourceDirty || afterSave.revision !== latest.revision
        || renderBackstageCard(afterSave, selection, this.state.mode) !== card) {
        this.update({ prepared: previous });
        this.retryClear = !previous;
        if (previous) await this.ports.save(previous, () => this.current(token));
        else await this.ports.clear();
        if (!this.current(token)) return;
        this.retryClear = false;
        this.update({ selection: this.reconcile(afterSave), source: afterSave, stage: 'failed', notice: backstageText.failed }); return;
      }
      const activeBatch = this.state.prepared?.batch;
      if (this.capacityEdit && activeBatch && activeBatch.id === prepared.batch?.id
        && activeBatch.usedCount !== prepared.batch.usedCount) {
        prepared.batch = activeBatch;
        await this.ports.save(prepared, () => this.current(token));
        if (!this.current(token)) return;
      }
      this.countSaveFailed = false;
      this.update({ prepared, stage: 'ready', notice: null });
    } catch {
      if (token === this.revision) this.update({ stage: 'failed', notice: backstageText.failed });
    } finally { if (token === this.revision) this.update({ busy: false }); }
    // A navigation error must not turn a successful local save into a failed save.
    if (this.current(token) && this.state.stage === 'ready') {
      const wasCapacityEdit = !!this.capacityEdit; this.capacityEdit = null;
      if (!wasCapacityEdit) this.ports.onReady();
    }
  }
  confirm = () => this.prepare(true);
  retry = () => this.retryClear ? this.dismiss() : this.retryRecovery ? this.retryRecovery()
    : this.countSaveFailed ? this.commitReplySave(this.receiptRecovery).catch(() => undefined) : this.prepare(this.state.selection !== null);
  continueEditing = () => { if (!this.state.busy) this.update({ stage: 'selecting', notice: null }); };
  toggleText(key: 'world' | 'checkpoint') {
    const s = this.state.selection;
    if (!s || this.state.busy) return;
    this.update({ selection: { ...s, [key]: { ...s[key], included: !s[key].included } } });
  }
  editText(key: 'world' | 'checkpoint', text: string) {
    const s = this.state.selection;
    if (!s || this.state.busy) return;
    this.update({ selection: { ...s, [key]: { ...s[key], text } } });
  }
  toggleItem(key: 'anchorIds' | 'lineIds', id: string) {
    const s = this.state.selection, source = this.state.source;
    if (!s || !source || this.state.busy) return;
    const items = key === 'anchorIds' ? source.anchors : source.lines;
    if (!items.some(item => item.id === id)) return;
    this.update({ selection: { ...s, [key]: s[key].includes(id) ? s[key].filter(value => value !== id) : [...s[key], id] } });
  }
  cancel = () => {
    if (this.state.busy) return;
    ++this.revision;
    this.capacityEdit = null; this.retryRecovery = null;
    this.update({ stage: this.state.prepared ? 'ready' : 'closed', notice: null });
  };
  async dismiss() {
    if (this.state.busy) return;
    const token = ++this.revision;
    this.capacityEdit = null; this.retryRecovery = null; this.countSaveFailed = false;
    this.retryClear = true;
    this.update({ busy: true, prepared: null });
    try {
      await this.ports.clear();
      if (token === this.revision) { this.retryClear = false; this.update({ ...initial() }); }
    } catch { if (token === this.revision) { this.retryClear = true; this.update({ busy: false, stage: 'failed', notice: backstageText.failed }); } }
  }
  async skip() { await this.dismiss(); if (this.state.stage === 'closed') this.ports.onReady(); }
  async sourceChanged() {
    if (this.state.busy) { this.sourceDirty = true; return; }
    if (!this.state.prepared) return;
    const token = this.revision, prepared = this.state.prepared;
    let loaded: BackstageLoad;
    try { loaded = await this.ports.load(prepared.source.binding); }
    catch { return; } // A failed read is not evidence of deletion.
    if (!this.current(token) || this.state.prepared !== prepared) return;
    try {
      if ('missing' in loaded) {
        this.update({ prepared: null, stage: 'gone',
          notice: loaded.missing === 'story' ? backstageText.storyGone : backstageText.branchGone });
        this.retryClear = true;
        await this.ports.clear();
        if (this.current(token)) this.retryClear = false;
      } else if (loaded.source.revision === prepared.source.revision) {
        this.update({ prepared: { ...prepared, source: loaded.source } });
      } else {
        // Do not use stale prepared material. Retain the edit buffers for explicit review.
        this.update({ prepared: null, stage: 'closed' });
        this.retryClear = true;
        await this.ports.clear();
        if (this.current(token)) this.retryClear = false;
      }
    } catch { if (this.current(token)) this.update({ stage: 'failed', notice: backstageText.failed }); }
  }
  beginReply(): string | null {
    const batch = this.state.prepared?.batch;
    return this.epoch !== null && this.ports.epoch() === this.epoch && batch && batch.usedCount < 6 ? batch.id : null;
  }
  async carry(batchId: string, replyId: string): Promise<{ card: string; source: TheaterBackstageMessageSource } | null> {
    const prepared = this.state.prepared;
    if (!prepared?.batch || this.beginReply() !== batchId) return null;
    if (this.countSaveFailed || this.receiptRecovery) throw new Error('theater-backstage-save-incomplete');
    const loaded = await this.ports.load(prepared.source.binding);
    if (this.state.prepared?.batch?.id !== batchId || this.beginReply() !== batchId) return null;
    if (this.countSaveFailed || this.receiptRecovery) throw new Error('theater-backstage-save-incomplete');
    if ('missing' in loaded || loaded.source.revision !== prepared.source.revision) {
      await this.sourceChanged(); return null;
    }
    if (!sameBinding(loaded.source.binding, prepared.source.binding)) throw new Error('theater-backstage-binding-mismatch');
    const active = this.state.prepared!;
    const useNumber = active.batch!.usedCount + 1;
    const mode = useNumber === 1 ? 'full' : 'slim';
    this.update({ prepared: { ...active, source: loaded.source } });
    return { card: renderBackstageCard(loaded.source, active.selection, mode), source: {
      batchId, replyId, ...loaded.source.binding, mode, useNumber,
    } };
  }
  async replySaved(source: TheaterBackstageMessageSource, saveReceipt?: () => Promise<void>) {
    const prepared = this.state.prepared;
    if (!prepared?.batch || prepared.batch.id !== source.batchId || !sameBinding(prepared.source.binding, source)
      || !Number.isInteger(source.useNumber) || source.useNumber < 1 || source.useNumber > 6
      || this.epoch === null || this.ports.epoch() !== this.epoch) {
      // Saved old replies may still receive their original marker, never a newer card's count or error state.
      await saveReceipt?.(); return;
    }
    const usedCount = Math.max(prepared.batch.usedCount, Math.min(6, source.useNumber));
    this.update({ prepared: { ...prepared, batch: { ...prepared.batch, usedCount } } });
    if (saveReceipt) {
      this.receiptRecovery = { batchId: source.batchId, save: saveReceipt };
    }
    await this.commitReplySave(this.receiptRecovery);
  }
  private async persistCount() {
    const prepared = this.state.prepared;
    if (!prepared?.batch) return;
    const batchId = prepared.batch.id, epoch = this.epoch;
    await this.ports.save(prepared, () => this.state.prepared?.batch?.id === batchId && this.ports.epoch() === epoch);
  }
  private async commitReplySave(recovery: { batchId: string; save: () => Promise<void> } | null) {
    const batchId = this.state.prepared?.batch?.id, epoch = this.epoch;
    const results = await Promise.allSettled([this.persistCount(), Promise.resolve().then(() => recovery?.save())]);
    const failure = results.find(result => result.status === 'rejected');
    if (batchId && this.state.prepared?.batch?.id === batchId && this.ports.epoch() === epoch
      && this.receiptRecovery === recovery) {
      const wasFailed = this.countSaveFailed;
      this.countSaveFailed = !!failure;
      if (failure) this.update({ stage: 'failed', notice: backstageText.failed });
      else {
        this.receiptRecovery = null;
        if (wasFailed) this.update({ stage: 'ready', notice: null });
      }
    }
    if (failure?.status === 'rejected') throw failure.reason;
  }
  capacityExceeded(batchId: string, fits: (card: string) => Promise<boolean>) {
    const prepared = this.state.prepared;
    if (!prepared?.batch || this.beginReply() !== batchId || this.state.busy) return;
    ++this.revision;
    this.capacityEdit = { batchId, fits };
    this.update({ stage: 'selecting', binding: prepared.source.binding, source: prepared.source,
      selection: prepared.selection, mode: prepared.batch.usedCount === 0 ? 'full' : 'slim', notice: null });
  }
  renew = async () => { const binding = this.state.prepared?.source.binding; if (binding) await this.open(binding); };
  async hydrate(load: () => Promise<BackstagePrepared | null>) {
    const token = ++this.revision; this.epoch = this.ports.epoch();
    try {
      const prepared = await load();
      if (!this.current(token)) return;
      this.retryRecovery = null;
      if (prepared) {
        this.update({ prepared, stage: 'ready', notice: null });
        // Persist the recovered high-water mark before receipts can later be deleted.
        await this.ports.save(prepared, () => this.current(token));
      }
    } catch {
      if (!this.current(token)) return;
      this.retryRecovery = () => this.hydrate(load);
      this.update({ stage: 'failed', notice: backstageText.failed });
    }
  }
  invalidate() {
    ++this.revision; this.epoch = null; this.capacityEdit = null; this.retryRecovery = null;
    this.countSaveFailed = false; this.receiptRecovery = null; this.update(initial());
  }
}
