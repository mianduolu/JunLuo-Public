import { fullTheaterCoCreationSelection, renderTheaterCoCreationMaterial, theaterCoCreationRevision,
  theaterCoCreationSentences, theaterMaterialLength, THEATER_CREATION_BUDGET,
  type TheaterCoCreationSource, type TheaterCoCreationSelection } from './theaterCoCreationMaterial';
import type { SharedExperienceProgress } from '../ai/assistantSharedExperienceMaterial';

export const theaterCoCreationText = {
  title: '精简本次材料', long: '材料有点长，请精简本次携带的内容。',
  scope: '只影响本次携带的内容，不会修改故事或小抄。',
  empty: '请至少保留一句本次新台词。', changed: '所选内容已变化，请重新选择。',
  failed: '这次选择没能保存，可以重试。', gone: '这份材料的原内容已删除，无法继续整理。',
};
type Ports = {
  load: (storyId: string) => Promise<TheaterCoCreationSource[]>;
  progress: () => Promise<SharedExperienceProgress | null>;
  save: (source: TheaterCoCreationSource, selection: TheaterCoCreationSelection, epoch: number | null) => Promise<void>;
  needsSelection: (source: TheaterCoCreationSource) => boolean;
  epoch: () => number | null;
  now?: () => number;
};
type State = {
  pending: TheaterCoCreationSource | null; source: TheaterCoCreationSource | null;
  selection: TheaterCoCreationSelection | null; visible: boolean; busy: boolean;
  notice: keyof Pick<typeof theaterCoCreationText, 'empty' | 'changed' | 'failed' | 'gone'> | null;
};
export class TheaterCoCreationSelectionSession {
  private state: State = { pending: null, source: null, selection: null, visible: false, busy: false, notice: null };
  private listeners = new Set<() => void>();
  private epoch: number | null = null;
  private revision = 0;
  private editRevision = 0;
  constructor(private ports: Ports) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<State>) { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener(); }
  async refresh(storyId: string) {
    const token = ++this.revision;
    const [sources, progress] = await Promise.all([this.ports.load(storyId), this.ports.progress()]);
    if (token !== this.revision) return;
    const source = sources.filter(s => s.messages.length && s.at <= (this.ports.now?.() ?? Date.now())
      && progress?.processed[`theater-unit:${s.positionId}`] === undefined)
      .sort((a, b) => a.at - b.at || a.positionId.localeCompare(b.positionId))[0];
    const choice = source && progress?.theaterSelections?.[source.positionId];
    const material = source && renderTheaterCoCreationMaterial(source, choice);
    this.update({ pending: source && (!material || theaterMaterialLength(material) > THEATER_CREATION_BUDGET
      || this.ports.needsSelection(source)) ? source : null });
  }
  async open(source = this.state.pending) {
    if (!source || this.state.busy) return;
    const token = ++this.editRevision;
    this.epoch = this.ports.epoch();
    const progress = await this.ports.progress();
    if (token !== this.editRevision || this.epoch === null || this.ports.epoch() !== this.epoch) return;
    const saved = progress?.theaterSelections?.[source.positionId];
    this.update({ source, visible: true, notice: null, selection: saved?.revision === theaterCoCreationRevision(source)
      ? saved : fullTheaterCoCreationSelection(source, this.ports.now?.() ?? Date.now()) });
  }
  close() { if (!this.state.busy) { this.editRevision++; this.update({ visible: false, notice: null }); } }
  invalidate() { this.revision++; this.editRevision++; this.update({ pending: null, source: null, selection: null, visible: false, busy: false, notice: null }); }
  toggleParagraph(index: number) {
    if (this.state.busy || !this.state.selection) return;
    const selected = this.state.selection.checkpointParagraphs;
    this.update({ notice: null, selection: { ...this.state.selection, checkpointParagraphs: selected.includes(index)
      ? selected.filter(i => i !== index) : [...selected, index].sort((a, b) => a - b) } });
  }
  toggleLine(index: number) {
    if (this.state.busy || !this.state.selection || !this.state.source) return;
    const sentences = theaterCoCreationSentences(this.state.source), line = sentences[index];
    if (!line) return;
    const key = (v: { versionId: string; start: number }) => `${v.versionId}:${v.start}`;
    const selected = new Set(this.state.selection.lines.map(key));
    if (selected.has(key(line))) selected.delete(key(line)); else selected.add(key(line));
    this.update({ notice: null, selection: { ...this.state.selection,
      lines: sentences.filter(v => selected.has(key(v))).map(({ versionId, start, end }) => ({ versionId, start, end })) } });
  }
  material() { return this.state.source && this.state.selection
    ? renderTheaterCoCreationMaterial(this.state.source, this.state.selection, true) : null; }
  async reselect() {
    if (!this.state.source || this.state.busy) return;
    const previous = this.state.source, token = ++this.editRevision;
    const source = (await this.ports.load(previous.storyId)).find(s => s.positionId === previous.positionId);
    if (token !== this.editRevision || this.ports.epoch() !== this.epoch) return;
    if (!source || source.branchId !== previous.branchId) { this.update({ notice: 'gone' }); return; }
    this.update({ source, selection: fullTheaterCoCreationSelection(source, this.ports.now?.() ?? Date.now()), notice: null });
  }
  async confirm() {
    const { source, selection } = this.state;
    if (!source || !selection || this.state.busy) return;
    if (!selection.lines.length) { this.update({ notice: 'empty' }); return; }
    const material = this.material();
    if (!material || theaterMaterialLength(material) > THEATER_CREATION_BUDGET) return;
    this.update({ busy: true, notice: null });
    const token = this.editRevision;
    try {
      const current = (await this.ports.load(source.storyId)).find(s => s.positionId === source.positionId);
      if (token !== this.editRevision) return;
      if (!current || current.branchId !== source.branchId) { this.update({ notice: 'gone' }); return; }
      if (theaterCoCreationRevision(current) !== selection.revision) { this.update({ notice: 'changed' }); return; }
      if (this.ports.epoch() !== this.epoch) { this.invalidate(); return; }
      await this.ports.save(current, { ...selection, updatedAt: this.ports.now?.() ?? Date.now() }, this.epoch);
      if (token !== this.editRevision || this.ports.epoch() !== this.epoch) return;
      this.update({ pending: null, visible: false });
    } catch { if (token === this.editRevision) this.update({ notice: 'failed' }); }
    finally { if (token === this.editRevision) this.update({ busy: false }); }
  }
}
