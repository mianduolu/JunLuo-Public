import {
  copyTheaterSetupDraft, emptyTheaterSetupDraft, isTheaterSetupDirty,
  theaterSetupDraftFromStory, validateTheaterSetupDraft,
  type TheaterSetupDraft, type TheaterSetupErrors,
} from './theaterSetupDraft';
import type { TheaterSetupRepository } from './theaterSetupStore';
import type { TheaterStory } from './theaterStoryTypes';

type Editor = { storyId: string | null; draft: TheaterSetupDraft; baseline: TheaterSetupDraft; copied: boolean; wasDraft: boolean };
type Snapshot = {
  stories: TheaterStory[]; editor: Editor | null;
  rename: { storyId: string; title: string } | null;
  loading: boolean; loadError: boolean; saving: boolean;
  errors: TheaterSetupErrors; notice: string;
  dialog: 'leave-new' | 'leave-existing' | 'save-error' | null;
};

// A single editor session, kept by the future theater page owner across tab/full-
// screen changes. It contains no local persistence or generation responsibilities.
export class TheaterSetupSession {
  private state: Snapshot = {
    stories: [], editor: null, rename: null, loading: false, loadError: false,
    saving: false, errors: {}, notice: '', dialog: null,
  };
  private listeners = new Set<() => void>();
  private pendingLeave: (() => void) | null = null;
  private retrySave: (() => Promise<void>) | null = null;
  private loadSequence = 0;

  constructor(private repository: TheaterSetupRepository, private openStory: (story: TheaterStory) => void) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<Snapshot>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private remember(story: TheaterStory) {
    this.update({ stories: [story, ...this.state.stories.filter((item) => item.id !== story.id)] });
  }
  async refresh() {
    const sequence = ++this.loadSequence;
    this.update({ loading: true, loadError: false });
    try {
      const stories = await this.repository.load();
      if (sequence === this.loadSequence) this.update({ stories, loading: false });
    } catch {
      if (sequence === this.loadSequence) this.update({ loading: false, loadError: true });
    }
    // Deliberately does not reset an open editor, switch tabs or open a story.
  }
  private edit(draft: TheaterSetupDraft, storyId: string | null, copied: boolean, wasDraft: boolean) {
    this.update({ editor: { draft, baseline: { ...draft }, storyId, copied, wasDraft }, errors: {}, notice: '', rename: null });
  }
  newStory() { this.requestLeave(() => this.edit(emptyTheaterSetupDraft(), null, false, true)); }
  editStory(story: TheaterStory) {
    this.requestLeave(() => this.edit(theaterSetupDraftFromStory(story), story.id, false, story.isDraft));
  }
  copyStory(story: TheaterStory) {
    this.requestLeave(() => {
      const savedSource = this.state.stories.find((item) => item.id === story.id) ?? story;
      this.edit(copyTheaterSetupDraft(savedSource), null, true, true);
    });
  }
  selectStory(story: TheaterStory) {
    if (story.isDraft) this.editStory(story);
    else this.requestLeave(() => { this.update({ editor: null }); this.openStory(story); });
  }
  change(field: keyof TheaterSetupDraft, value: string) {
    const editor = this.state.editor;
    if (!editor || this.state.saving || this.state.dialog) return;
    this.update({ editor: { ...editor, draft: { ...editor.draft, [field]: value } }, errors: {}, notice: '' });
  }
  requestLeave(action: () => void) {
    if (this.state.saving || this.state.dialog) return;
    const editor = this.state.editor;
    if (editor && (editor.copied || isTheaterSetupDirty(editor.draft, editor.baseline))) {
      this.pendingLeave = action;
      this.update({ dialog: editor.storyId ? 'leave-existing' : 'leave-new' });
    } else { this.pendingLeave = null; action(); }
  }
  history() { this.requestLeave(() => this.update({ editor: null, notice: '', errors: {} })); }
  continueEditing() { this.pendingLeave = null; this.retrySave = null; this.update({ dialog: null }); }
  discardAndLeave() {
    const action = this.pendingLeave;
    this.pendingLeave = null;
    this.update({ dialog: null, editor: null, errors: {} });
    action?.();
  }
  async saveAndLeave() {
    this.update({ dialog: null });
    await this.save(this.state.editor?.storyId ? !!this.state.editor.wasDraft : true);
  }
  async save(asDraft: boolean, after?: () => void) {
    const editor = this.state.editor;
    if (!editor || this.state.saving) return;
    const destination = after ?? this.pendingLeave;
    const errors = validateTheaterSetupDraft(editor.draft);
    this.update({ errors });
    if (Object.keys(errors).length) return;
    this.update({ saving: true, dialog: null, notice: '' });
    let saved: TheaterStory;
    try {
      saved = await this.repository.save(editor.draft, editor.storyId, asDraft);
    } catch {
      this.retrySave = () => this.save(asDraft, destination ?? undefined);
      this.update({ saving: false, dialog: 'save-error' });
      return;
    }
    // Invalidate any list read started before this write committed.
    ++this.loadSequence;
    this.retrySave = null;
    this.pendingLeave = null;
    this.remember(saved);
    this.update({ saving: false, loading: false, loadError: false, editor: null,
      notice: asDraft ? '草稿已保存' : '设定已保存' });
    if (destination) destination();
    else if (!asDraft) this.openStory(saved);
  }
  beginRename(story: TheaterStory) {
    if (!this.state.saving) this.requestLeave(() => this.update({ editor: null, rename: { storyId: story.id, title: story.title }, notice: '' }));
  }
  changeName(title: string) {
    if (!this.state.saving && this.state.rename) this.update({ rename: { ...this.state.rename, title } });
  }
  cancelRename() { if (!this.state.saving) this.update({ rename: null }); }
  async saveName() {
    const rename = this.state.rename;
    if (!rename || this.state.saving) return;
    this.update({ saving: true, dialog: null });
    let saved: TheaterStory;
    try { saved = await this.repository.rename(rename.storyId, rename.title); }
    catch {
      this.retrySave = () => this.saveName();
      this.update({ saving: false, dialog: 'save-error' });
      return;
    }
    ++this.loadSequence;
    this.retrySave = null;
    this.remember(saved);
    this.update({ saving: false, loading: false, loadError: false, rename: null });
  }
  async retry() { const retry = this.retrySave; this.update({ dialog: null }); await retry?.(); }
}
