import { THEATER_LOCAL_STORAGE_PREFIX } from './theaterLocalState';

export type TheaterDraftStorage = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
};

export type TheaterDraftSnapshot = Readonly<{
  text: string;
  loading: boolean;
  readError: boolean;
  saveError: boolean;
}>;

export type TheaterDraftTicket = Readonly<{
  storyId: string;
  branchId: string;
  text: string;
  revision: number;
  source: TheaterBranchDraft;
}>;

export class TheaterBranchDraft {
  private snapshot: TheaterDraftSnapshot = { text: '', loading: true, readError: false, saveError: false };
  private readonly listeners = new Set<() => void>();
  private loaded = false;
  private revision = 0;
  private savedRevision = 0;
  private reading: Promise<void> | null = null;
  private writing: Promise<void> | null = null;
  private retired = false;

  constructor(
    readonly storyId: string,
    readonly branchId: string,
    private readonly storage: TheaterDraftStorage,
    private readonly key: string,
  ) {}

  getSnapshot = (): TheaterDraftSnapshot => this.snapshot;
  isRetired = () => this.retired;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private publish(patch: Partial<TheaterDraftSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  load = (): Promise<void> => {
    if (this.loaded) return Promise.resolve();
    if (this.reading) return this.reading;
    this.publish({ loading: true, readError: false });
    this.reading = this.read().finally(() => { this.reading = null; });
    return this.reading;
  };

  private async read() {
    try {
      const text = await this.storage.getItem(this.key);
      if (this.retired) return;
      this.loaded = true;
      this.publish({ text: text ?? '', loading: false, readError: false });
    } catch {
      this.publish({ loading: false, readError: true });
    }
  }

  // The view disables editing until load succeeds; never turn a failed read into an empty draft write.
  change = (text: string): void => {
    if (!this.loaded || this.retired) return;
    this.revision += 1;
    this.publish({ text });
    void this.persist();
  };

  private persist(): Promise<void> {
    if (this.writing) return this.writing;
    this.writing = this.writeLatest().finally(() => { this.writing = null; });
    return this.writing;
  }

  private async writeLatest() {
    while (!this.retired && this.savedRevision !== this.revision) {
      const revision = this.revision;
      const text = this.snapshot.text;
      try {
        if (text === '') await this.storage.removeItem(this.key);
        else await this.storage.setItem(this.key, text);
        this.savedRevision = revision;
        if (this.snapshot.saveError) this.publish({ saveError: false });
      } catch {
        this.publish({ saveError: true });
        // Retry is user-driven. Do not keep retrying a failing device store in the background.
        return;
      }
    }
  }

  retry = async (): Promise<void> => {
    if (this.retired) return;
    if (!this.loaded) return this.load();
    if (this.writing) await this.writing;
    await this.persist();
  };

  capture = (): TheaterDraftTicket | null => {
    if (!this.loaded || this.retired) return null;
    return { storyId: this.storyId, branchId: this.branchId, text: this.snapshot.text, revision: this.revision, source: this };
  };

  // Call only after the you line is committed. Failure or cancellation must not acknowledge a ticket.
  acknowledgeSaved = (ticket: TheaterDraftTicket): void => {
    if (ticket.source !== this || ticket.storyId !== this.storyId || ticket.branchId !== this.branchId) return;
    if (ticket.revision !== this.revision || ticket.text !== this.snapshot.text) return;
    this.change('');
  };

  // The story transaction has already deleted this exact branch. Drain writes
  // before removing its local draft, so an old composer cannot resurrect it.
  remove = async (): Promise<void> => {
    this.retired = true;
    this.publish({ loading: true });
    if (this.writing) await this.writing;
    await this.storage.removeItem(this.key);
    this.publish({ text: '', loading: true, readError: false, saveError: false });
  };
}

export class TheaterDraftSession {
  private readonly branches = new Map<string, TheaterBranchDraft>();

  constructor(private readonly storage: TheaterDraftStorage) {}

  releaseRemovedBranches() {
    // Restore may reintroduce an id whose previous deletion cleanup failed.
    // Forget only retired handles; do not erase surviving local input.
    for (const [key, branch] of this.branches) if (branch.isRetired()) this.branches.delete(key);
  }

  forBranch(storyId: string, branchId: string): TheaterBranchDraft {
    // A JSON tuple preserves arbitrary IDs without separator or escaping collisions.
    const identity = JSON.stringify([storyId, branchId]);
    let branch = this.branches.get(identity);
    if (!branch) {
      branch = new TheaterBranchDraft(storyId, branchId, this.storage, `${THEATER_LOCAL_STORAGE_PREFIX}draft.${identity}`);
      this.branches.set(identity, branch);
    }
    return branch;
  }

  async removeBranches(storyId: string, branchIds: string[]) {
    // Include unloaded drafts as well as mounted composers; ids come from the
    // committed deletion result, never from whichever branch is now selected.
    for (const branchId of branchIds) {
      const branch = this.forBranch(storyId, branchId);
      await branch.remove();
      const key = JSON.stringify([storyId, branchId]);
      if (this.branches.get(key) === branch) this.branches.delete(key);
    }
  }
}
