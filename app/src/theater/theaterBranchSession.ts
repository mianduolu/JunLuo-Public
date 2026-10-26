import type { createBackupRestoreCoordinator } from '../backup/backupRestoreCoordinator';
import { TheaterGenerationBasisError, type TheaterBinding } from './theaterGenerationStore';
import { theaterBindingKey, type TheaterGenerationSession } from './theaterGenerationSession';
import type { TheaterDraftSession } from './theaterDraftSession';
import type { createTheaterBranchRepository } from './theaterBranchStore';
import type { TheaterAdoption, TheaterTextVersion } from './theaterStoryTypes';
import type { TheaterReadingSession } from './theaterReadingSession';

type Repository = ReturnType<typeof createTheaterBranchRepository>;
type Detail = Awaited<ReturnType<Repository['load']>>;
type Command = Parameters<Repository['execute']>[2];
type Epoch = Pick<ReturnType<typeof createBackupRestoreCoordinator>,
  'captureDataEpoch' | 'canCommitDataEpoch' | 'runDataEpochCommit' | 'subscribeRuntimeState'>;
type Target = { binding: TheaterBinding; expected: TheaterAdoption[] };
type Menu = Target & { version: TheaterTextVersion; index: number };
type Editor = Target & { kind: 'message' | 'name'; original: string; value: string;
  version?: TheaterTextVersion; fork: boolean; error?: string; unavailable?: boolean };
type Confirmation = Target & { title: string; body: string; confirmLabel: '删除' | '移除' | '新开' | '放弃修改';
  command?: Command; choices?: { id: string; label: string; content: string }[]; selected?: string };
type State = {
  storyId: string | null; binding: TheaterBinding | null; detail: Detail | null;
  busy: boolean; loading: boolean; branchSheet: boolean; menu: Menu | null; editor: Editor | null;
  confirmation: Confirmation | null; notice: string | null; retryLabel: string | null;
  previews: Record<string, string | undefined>;
};
const changedText = '内容已发生变化，请重新查看后再操作。';
export function theaterForkName(content: string) {
  const chars = Array.from(content.trim().replace(/\s+/gu, ' '));
  return `从「${chars.slice(0, 20).join('')}${chars.length > 20 ? '…' : ''}」开始`;
}

// Feature-owned state: editors and preview selections survive view changes but
// do not become story records or share a buffer with the composer.
export class TheaterBranchSession {
  private state: State = { storyId: null, binding: null, detail: null, busy: false, loading: false,
    branchSheet: false, menu: null, editor: null, confirmation: null, notice: null, retryLabel: null, previews: {} };
  private listeners = new Set<() => void>();
  private recent = new Map<string, string[]>();
  private selected = new Map<string, string>();
  private sequence = 0;
  private seenAlternatives = new Set<string>();
  private retryAction: (() => Promise<void>) | null = null;
  private disposed = false;
  private unsubscribe: () => void;
  constructor(private ports: { repository: Repository; generation: TheaterGenerationSession;
    drafts: TheaterDraftSession; epoch: Epoch; createId: () => string; now?: () => number; reading?: TheaterReadingSession }) {
    this.unsubscribe = ports.epoch.subscribeRuntimeState(value => {
      if (value.status === 'ready') {
        ports.drafts.releaseRemovedBranches();
        if (this.state.storyId) void this.open(this.state.storyId); return;
      }
      this.sequence++; this.retryAction = null; this.selected.clear(); this.recent.clear();
      this.seenAlternatives.clear();
      this.update({ detail: null, binding: null, menu: null, editor: null, confirmation: null,
        branchSheet: false, previews: {}, notice: null, retryLabel: null });
    });
  }
  getSnapshot = () => this.state;
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  private update(patch: Partial<State>) { this.state = { ...this.state, ...patch }; this.listeners.forEach(fn => fn()); }
  private now() { return (this.ports.now ?? Date.now)(); }
  private markViewed(binding: TheaterBinding) {
    this.ports.reading?.select(binding);
    this.selected.set(binding.storyId, binding.branchId);
    this.recent.set(binding.storyId, [binding.branchId, ...(this.recent.get(binding.storyId)
      ?? this.ports.reading?.getSnapshot().recentByStory[binding.storyId] ?? []).filter(id => id !== binding.branchId)]);
  }
  async open(storyId: string) {
    const epoch = this.ports.epoch.captureDataEpoch();
    if (epoch === null || this.disposed) return;
    const sequence = ++this.sequence;
    this.update({ storyId, loading: true });
    try {
      await this.ports.reading?.ready;
      const readingBefore = this.ports.reading?.getSnapshot();
      const detail = await this.ports.repository.load(storyId);
      if (this.disposed || sequence !== this.sequence || !this.ports.epoch.canCommitDataEpoch(epoch)) return;
      if (!detail) { this.update({ detail: null, binding: null, loading: false }); return; }
      for (const row of detail.branches) this.ports.reading?.reconcile({ storyId, branchId: row.branch.id },
        row.adoptions.map(v => v.versionId), readingBefore?.branches[theaterBindingKey({ storyId, branchId: row.branch.id })]?.unread ?? []);
      const branch = detail.branches.find(row => row.branch.id === (this.selected.get(storyId)
        ?? this.ports.reading?.getSnapshot().selectedByStory[storyId])) ?? detail.branches[0];
      const binding = branch ? { storyId, branchId: branch.branch.id } : null;
      if (binding) this.markViewed(binding);
      this.update({ detail, binding, loading: false });
    } catch {
      if (sequence === this.sequence && this.ports.epoch.canCommitDataEpoch(epoch)) {
        this.retryAction = () => this.open(storyId);
        this.update({ loading: false, detail: null, binding: null, notice: '暂时没能读到小剧场', retryLabel: '重试' });
      }
    }
  }
  showBranches() { if (!this.state.busy) this.update({ branchSheet: true }); }
  closePanels() {
    if (this.state.busy) return;
    if (this.state.confirmation?.command) {
      this.retryAction = null; this.update({ notice: null, retryLabel: null });
    }
    this.update({ branchSheet: false, menu: null, confirmation: null });
  }
  switchBranch(branchId: string) {
    if (this.state.busy || !this.state.detail?.branches.some(row => row.branch.id === branchId)) return;
    const binding = { storyId: this.state.detail.story.id, branchId };
    this.markViewed(binding); this.update({ binding, branchSheet: false, menu: null });
  }
  private target(): Target | null {
    const binding = this.state.binding;
    const branch = this.state.detail?.branches.find(row => row.branch.id === binding?.branchId);
    return binding && branch ? { binding: { ...binding }, expected: branch.adoptions.map(v => ({ ...v })) } : null;
  }
  previewKey(positionId: string) { return JSON.stringify([this.state.binding?.storyId, this.state.binding?.branchId, positionId]); }
  versions(positionId: string) { return this.state.detail?.versions.filter(v => v.positionId === positionId && v.kind === 'dialogue') ?? []; }
  displayed(adopted: TheaterTextVersion) {
    return this.versions(adopted.positionId).find(v => v.id === this.state.previews[this.previewKey(adopted.positionId)]) ?? adopted;
  }
  revealAdopted(positionId: string) {
    const previews = { ...this.state.previews };
    delete previews[this.previewKey(positionId)];
    this.update({ previews });
  }
  showMessage(version: TheaterTextVersion, index: number) {
    const target = this.target();
    if (!target || this.state.busy) return;
    this.update({ menu: { ...target, version, index } });
  }
  selectVersion(version: TheaterTextVersion) {
    const target = this.target();
    if (!target || this.state.busy) return;
    const index = target.expected.findIndex(row => row.positionId === version.positionId);
    if (index < 0) return;
    if (index < target.expected.length - 1) {
      this.update({ previews: { ...this.state.previews, [this.previewKey(version.positionId)]: version.id } });
    } else if (target.expected[index].versionId !== version.id) {
      void this.execute(target, { type: 'adopt', versionId: version.id }, '没能切换版本，请重试。', '重试');
    }
  }
  previewGenerated(version: TheaterTextVersion) {
    if (!this.state.binding || version.conversationId !== this.state.binding.storyId || this.seenAlternatives.has(version.id)) return;
    this.seenAlternatives.add(version.id);
    this.update({ previews: { ...this.state.previews, [this.previewKey(version.positionId)]: version.id } });
  }
  beginEdit(menu = this.state.menu) {
    if (!menu || this.state.busy) return;
    this.update({ menu: null, editor: { ...menu, kind: 'message', original: menu.version.content,
      value: menu.version.content, fork: menu.index < menu.expected.length - 1 } });
  }
  beginRename(branchId: string) {
    const detail = this.state.detail, row = detail?.branches.find(row => row.branch.id === branchId);
    if (!row || !detail || this.state.busy) return;
    this.update({ branchSheet: false, editor: { binding: { storyId: detail.story.id, branchId }, expected: row.adoptions,
      kind: 'name', original: row.branch.name, value: row.branch.name, fork: false } });
  }
  changeEdit(value: string) {
    if (!this.state.editor || this.state.busy) return;
    this.retryAction = null;
    this.update({ editor: { ...this.state.editor, value, error: undefined }, notice: null, retryLabel: null });
  }
  requestCloseEditor() {
    const editor = this.state.editor;
    if (!editor || this.state.busy) return;
    if (editor.kind === 'name' || editor.original === editor.value) {
      this.retryAction = null; this.update({ editor: null, notice: null, retryLabel: null }); return;
    }
    this.update({ confirmation: { ...editor, title: '放弃这次修改？',
      body: '还没保存的修改会丢弃，原来的台词不会改变。', confirmLabel: '放弃修改' } });
  }
  private newBranch(name: string) { return { id: this.ports.createId(), name, createdAt: this.now() }; }
  async saveEditor() {
    const editor = this.state.editor;
    if (!editor || this.state.busy || !editor.value.trim() || editor.unavailable) return;
    if (editor.value === editor.original) { this.update({ editor: null }); return; }
    if (editor.kind === 'name') {
      await this.execute(editor, { type: 'rename', name: editor.value, now: this.now() }, '名称还没保存，请重试。');
    } else if (editor.version) {
      const version = { ...editor.version, id: this.ports.createId(), content: editor.value,
        origin: 'edited' as const, coCreation: undefined, createdAt: this.now(), updatedAt: this.now() };
      await this.execute(editor, { type: 'edit', version,
        ...(editor.fork ? { newBranch: this.newBranch(theaterForkName(editor.value)) } : {}) }, '修改还没保存，编辑内容还在。');
    }
  }
  async fromVersion(version: TheaterTextVersion) {
    const target = this.target();
    if (!target) return;
    await this.execute(target, { type: 'forkVersion', versionId: version.id,
      newBranch: this.newBranch(theaterForkName(version.content)) }, '新走向还没保存成功，请重试。');
  }
  shared(version: TheaterTextVersion) {
    return this.state.detail?.branches.some(row => row.branch.id !== this.state.binding?.branchId
      && row.adoptions.some(a => a.versionId === version.id)) ?? false;
  }
  destructiveLabel(menu = this.state.menu): '删除' | '删除这个版本' | '从当前走向移除' | '从这句之前继续' | undefined {
    if (!menu) return undefined;
    const adopted = menu.expected[menu.index]?.versionId === menu.version.id;
    if (!adopted) {
      const referenced = this.state.detail?.branches.some(row => row.adoptions.some(a => a.versionId === menu.version.id)
        || row.checkpoints.some(c => c.basis.some(a => a.versionId === menu.version.id))
        || row.anchors.some(a => a.sourceVersionId === menu.version.id));
      return referenced ? undefined : '删除这个版本';
    }
    if (menu.index < menu.expected.length - 1) return '从这句之前继续';
    return menu.version.subject === 'you' ? '删除' : this.shared(menu.version) ? '从当前走向移除' : '删除这个版本';
  }
  requestDeleteMessage() {
    const menu = this.state.menu, label = this.destructiveLabel();
    if (!menu || !label || this.state.busy) return;
    let dialog: Confirmation;
    if (label === '从这句之前继续') dialog = { ...menu, title: '从这句之前另开走向？',
      body: '新走向会保留这句之前的剧情，不带这句和后面的内容。原走向会完整保留。', confirmLabel: '新开',
      command: { type: 'forkBefore', positionId: menu.version.positionId, newBranch: this.newBranch(`跳过第 ${menu.index + 1} 句`) } };
    else if (menu.expected[menu.index].versionId !== menu.version.id) dialog = { ...menu, title: '删除这个版本？',
      body: '只删除正在查看的这个备选版本，当前采用的回复和其他版本会保留。', confirmLabel: '删除',
      command: { type: 'deleteVersion', versionId: menu.version.id } };
    else if (menu.version.subject === 'you') dialog = { ...menu, title: '删除这句台词？',
      body: '这句台词会从当前走向移除，未发送的草稿会保留。', confirmLabel: '删除', command: { type: 'deleteLast' } };
    else {
      const shared = this.shared(menu.version);
      const choices = this.versions(menu.version.positionId).filter(v => v.id !== menu.version.id)
        .map(v => ({ id: v.id, label: `${this.versions(v.positionId).findIndex(item => item.id === v.id) + 1}/${this.versions(v.positionId).length}`, content: v.content }));
      dialog = { ...menu, title: shared ? '从当前走向移除？' : choices.length ? '删除当前版本？' : '删除这条回复？',
        body: shared ? '这版还在其他走向里使用，只会从当前走向移除，其他走向不受影响。'
          + (choices.length ? '\n请先选择接下来采用的版本，再确认移除。' : '')
          : choices.length ? '请先选择接下来采用的版本，再确认删除。'
            : menu.index === 0 ? '删除后，这条走向会回到空白，不会自动重新开场。'
              : '删除后，前面的台词会重新等待回复，不会自动重新生成。',
        confirmLabel: shared ? '移除' : '删除', choices, command: { type: 'deleteLast' } };
    }
      if (dialog.command?.type === 'deleteLast' && !dialog.choices?.length) {
        const count = this.state.detail?.branches.find(v => v.branch.id === menu.binding.branchId)?.anchors
          .filter(v => v.positionId === menu.version.positionId).length ?? 0;
        if (count) dialog.body += `\n这句台词关联的 ${count} 条剧情锚点也会一起移除。`;
      }
      this.update({ menu: null, confirmation: dialog });
  }
  requestDeleteBranch() {
    const target = this.target(), detail = this.state.detail;
    if (!target || !detail || this.state.busy) return;
    const branch = detail.branches.find(row => row.branch.id === target.binding.branchId)!;
    const last = detail.branches.length === 1;
    this.update({ branchSheet: false, confirmation: { ...target, title: last ? '删除最后一条走向？' : '删除这条走向？',
      body: last ? `「${branch.branch.name}」是本场最后一条走向。删除后，本场的台词、回复版本、小抄、锚点和未发送草稿都会清空。剧场设定保留，并回到空白的「最初走向」。`
        : `将删除「${branch.branch.name}」及其未发送草稿，只属于这条走向的台词、回复版本、小抄和锚点也会一起删除。其他走向和剧场设定会保留。`,
      confirmLabel: '删除', command: { type: 'deleteBranch', emptyBranch: this.newBranch('最初走向'),
        expectedBranchIds: detail.branches.map(row => row.branch.id) } } });
  }
  requestDeleteStory() {
    const target = this.target(), detail = this.state.detail;
    if (!target || !detail || this.state.busy) return;
    this.update({ confirmation: { ...target, title: '删除整个小剧场？',
      body: `将删除「${detail.story.title}」的设定、全部走向、台词、回复版本、小抄、锚点和未发送草稿。其他小剧场不受影响。`,
      confirmLabel: '删除', command: { type: 'deleteStory',
        expectedBranches: detail.branches.map(row => ({ id: row.branch.id, adoptions: row.adoptions })) } } });
  }
  chooseReplacement(id: string) {
    if (!this.state.busy && this.state.confirmation?.choices?.some(v => v.id === id)) this.update({ confirmation: { ...this.state.confirmation, selected: id } });
  }
  async confirm() {
    const dialog = this.state.confirmation;
    if (!dialog || this.state.busy) return;
    if (!dialog.command) {
      this.retryAction = null; this.update({ confirmation: null, editor: null, notice: null, retryLabel: null }); return;
    }
    if (dialog.choices?.length && !dialog.selected) return;
    const command = dialog.command.type === 'deleteLast' ? { ...dialog.command, replacementVersionId: dialog.selected } : dialog.command;
    await this.execute(dialog, command, dialog.confirmLabel === '新开' ? '新走向还没保存成功，请重试。'
      : dialog.confirmLabel === '移除' ? '没能移除，请重试。' : '没能删除，请重试。', dialog.confirmLabel === '新开' ? '重试保存' : '重试');
  }
  async retry() { if (!this.state.busy) await this.retryAction?.(); }
  private async execute(target: Target, command: Command, failure: string, retryLabel = '重试保存') {
    if (this.state.busy || this.disposed) return;
    const epoch = this.ports.epoch.captureDataEpoch();
    if (epoch === null) return;
    this.update({ busy: true, notice: null, retryLabel: null });
    try {
      if (command.type === 'deleteBranch') this.ports.generation.stopBinding(target.binding);
      if (command.type === 'deleteStory') {
        const active = this.ports.generation.getSnapshot().active?.binding;
        if (active?.storyId === target.binding.storyId) this.ports.generation.stopBinding(active);
      }
      const committed = await this.ports.epoch.runDataEpochCommit(epoch, () => this.ports.repository.execute(
        target.binding, target.expected, command, () => !this.disposed && this.ports.epoch.canCommitDataEpoch(epoch)));
      if (!committed.committed || !this.ports.epoch.canCommitDataEpoch(epoch)) return;
      const result = committed.value;
      for (const row of result.detail?.branches ?? []) this.ports.reading?.reconcile(
        { storyId: target.binding.storyId, branchId: row.branch.id }, row.adoptions.map(v => v.versionId));
      this.retryAction = null;
      if (this.state.storyId === target.binding.storyId) {
        this.sequence++;
        let branchId = result.branchId;
        if (command.type === 'deleteBranch' && result.detail) {
          const rows = result.detail.branches;
          branchId = (this.recent.get(target.binding.storyId)
            ?? this.ports.reading?.getSnapshot().recentByStory[target.binding.storyId] ?? []).find(id => rows.some(row => row.branch.id === id))
            ?? rows.find(row => row.branch.forkBoundary == null)?.branch.id ?? rows[0]?.branch.id ?? null;
        }
        const binding = branchId ? { storyId: target.binding.storyId, branchId } : null;
        if (binding) this.markViewed(binding);
        this.update({ detail: result.detail, binding, loading: false, editor: null, confirmation: null, menu: null, branchSheet: false, previews: {} });
      }
      await this.ports.generation.sourceChanged(target.binding);
      if (result.branchId) await this.ports.generation.refresh({ storyId: target.binding.storyId, branchId: result.branchId });
      if (result.deletedBranchIds.length) {
        await this.ports.reading?.removeBranches(target.binding.storyId, result.deletedBranchIds);
        const cleanup = async () => {
          await this.ports.epoch.runDataEpochCommit(epoch, () => this.ports.drafts.removeBranches(target.binding.storyId, result.deletedBranchIds));
          if (this.ports.epoch.canCommitDataEpoch(epoch)) { this.retryAction = null; this.update({ notice: null, retryLabel: null }); }
        };
        try { await cleanup(); } catch {
          this.retryAction = async () => {
            if (!this.ports.epoch.canCommitDataEpoch(epoch)) return;
            try { await cleanup(); } catch { /* Keep the exact cleanup action available, never repeat deletion. */ }
          };
          this.update({ notice: '删除已完成，但未发送草稿还没清理完。', retryLabel: '重试清理' });
        }
      }
    } catch (error) {
      if (!this.ports.epoch.canCommitDataEpoch(epoch) || this.disposed) return;
      const changed = error instanceof TheaterGenerationBasisError;
      this.retryAction = changed ? async () => {
        const editor = this.state.editor;
        this.update({ confirmation: null, menu: null, notice: null, retryLabel: null });
        await this.open(target.binding.storyId);
        this.retryAction = null;
        if (editor && this.state.editor === editor) {
          const detail = this.state.detail;
          const branch = detail?.branches.find(row => row.branch.id === editor.binding.branchId);
          const index = branch?.adoptions.findIndex(a => a.positionId === editor.version?.positionId) ?? -1;
          const version = index >= 0 ? detail?.versions.find(v => v.id === branch?.adoptions[index].versionId) : undefined;
          const available = !!branch && (editor.kind === 'name' || !!version);
          this.update({ editor: { ...editor, expected: branch?.adoptions ?? editor.expected,
            original: editor.kind === 'name' ? branch?.branch.name ?? editor.original : version?.content ?? editor.original,
            version: version ?? editor.version, fork: index >= 0 && index < (branch?.adoptions.length ?? 0) - 1,
            error: available ? undefined : changedText, unavailable: !available } });
        }
      } : () => this.execute(target, command, failure, retryLabel);
      this.update({ notice: changed ? changedText : failure, retryLabel: changed ? '重新查看' : retryLabel,
        editor: this.state.editor ? { ...this.state.editor, error: changed ? changedText : failure } : null });
    } finally { this.update({ busy: false }); }
  }
  dispose() { this.disposed = true; this.sequence++; this.unsubscribe(); this.listeners.clear(); }
}
