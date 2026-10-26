import type { JunLuoToolCall, JunLuoToolResult } from '../tools/toolTypes';
import type { ReadingBook, ReadingChapter } from './readingTypes';

export type ReadingMaterialPorts = {
  loadBook(id: string): Promise<ReadingBook | null>;
  loadChapter(id: string, index: number): Promise<ReadingChapter | null>;
  isCurrent(): Promise<boolean>;
  dataEpoch?: number;
};
type Position = { chapterIndex: number; paragraphIndex: number; offset: number };
type Cursor = { readingId: string; source: string; scope: string; position: Position; keyword?: string;
  anchor: { chapterIndex: number; source: string }; matched: boolean; inMatch: boolean };
type Fragment = { chapterIndex: number; paragraphIndex: number; startOffset: number; endOffset: number; text: string };
type Data = { state: string; fragments: Fragment[]; nextCursor?: string; scannedCharacters?: number };

const MAX_RESULT = 6000;
const MAX_CHAPTERS = 10;
const MAX_SCAN = 100000;
const MISSING_CHAPTER = Symbol('missing-local-chapter');
const runtimeCursorScope = `${Date.now()}:${Math.random()}`;

function hash(value: string): string {
  let first = 2166136261;
  let second = 5381;
  for (let index = 0; index < value.length; index += 1) {
    first = Math.imul(first ^ value.charCodeAt(index), 16777619);
    second = Math.imul(second, 33) ^ value.charCodeAt(index);
  }
  return `${value.length}:${first >>> 0}:${second >>> 0}`;
}
function bookSource(book: ReadingBook): string {
  return hash(JSON.stringify([book.id, book.title, book.author, book.fileType, book.fileUri,
    book.importedAt, book.totalChapters, book.contentType, book.programme?.sourceUrl,
    book.programme?.sourceVersion, book.programme?.preparedAt, book.programme?.transcriptUrl, book.materialSourceRevision]));
}
function chapterSource(chapter: ReadingChapter): string {
  return hash(JSON.stringify([chapter.bookId, chapter.index, chapter.sourceRevision, chapter.title,
    chapter.textContent, chapter.paragraphs, chapter.contentBlocks, chapter.images?.map(image => [image.id, image.contentVersion])]));
}
function asciiLower(text: string) { return text.replace(/[A-Z]/g, value => value.toLowerCase()); }
function validChapter(chapter: ReadingChapter, id: string, index: number) {
  return chapter.bookId === id && chapter.index === index && Array.isArray(chapter.paragraphs)
    && chapter.paragraphs.every(paragraph => typeof paragraph === 'string');
}
// A position is not authorization: every call still needs the current chat's real reference.
// Stateless cursors also let a later, authorized chat continue without a second storage domain.
function parseCursor(value: string): Cursor | undefined {
  try {
    if (value.length > MAX_RESULT) return;
    const v = JSON.parse(value) as Cursor;
    if (!v || typeof v !== 'object' || Array.isArray(v)
      || Object.keys(v).some(key => !['readingId', 'source', 'scope', 'position', 'keyword', 'anchor', 'matched', 'inMatch'].includes(key))
      || typeof v.readingId !== 'string' || typeof v.source !== 'string' || typeof v.scope !== 'string'
      || !v.position || Object.keys(v.position).sort().join(',') !== 'chapterIndex,offset,paragraphIndex'
      || Object.values(v.position).some(n => !Number.isSafeInteger(n) || n < 0)
      || !v.anchor || Object.keys(v.anchor).sort().join(',') !== 'chapterIndex,source'
      || !Number.isSafeInteger(v.anchor.chapterIndex) || v.anchor.chapterIndex < 0 || typeof v.anchor.source !== 'string'
      || typeof v.matched !== 'boolean' || typeof v.inMatch !== 'boolean'
      || v.keyword !== undefined && (typeof v.keyword !== 'string' || !v.keyword.length || v.keyword.length > MAX_SCAN)) return;
    return v;
  } catch { return; }
}

/** Reads only local text through caller-provided ports. Authorization remains the turn host's responsibility. */
export async function readReadingMaterial(call: JunLuoToolCall, ports: ReadingMaterialPorts): Promise<JunLuoToolResult> {
  const startedAt = Date.now();
  const result = (data: Data): JunLuoToolResult => ({ callId: call.callId, toolId: call.toolId,
    ok: true, status: 'success', summary: '', data, startedAt, finishedAt: Date.now() });
  const fail = (reason: string, code: 'INVALID_ARGUMENTS' | 'READ_FAILED' | 'STALE_DATA_EPOCH' = 'READ_FAILED'): JunLuoToolResult => ({
    callId: call.callId, toolId: call.toolId, ok: false, status: 'error', summary: '',
    error: { code, message: `reading-material-${reason}` }, startedAt, finishedAt: Date.now(),
  });
  const { readingId, keyword, cursor } = call.input;
  if (typeof readingId !== 'string' || !readingId.trim()
    || (keyword !== undefined && (typeof keyword !== 'string' || !keyword.length || keyword.length > MAX_SCAN))
    || (cursor !== undefined && (typeof cursor !== 'string' || !cursor))
    || (keyword !== undefined && cursor !== undefined)) return fail('invalid-arguments', 'INVALID_ARGUMENTS');
  try {
    if (!await ports.isCurrent()) return fail('stale-host', 'STALE_DATA_EPOCH');
    const book = await ports.loadBook(readingId);
    if (!book) return fail('deleted');
    if (book.id !== readingId) return fail('source-changed');
    if (book.contentType === 'programme' && book.programme?.preparation !== 'ready') return fail('unprepared');
    if (!Number.isInteger(book.totalChapters) || book.totalChapters < 1) return fail('unprepared');
    const source = bookSource(book);
    const scope = `${runtimeCursorScope}:${ports.dataEpoch ?? 0}`;
    const saved = typeof cursor === 'string' ? parseCursor(cursor) : undefined;
    if (cursor && (!saved || saved.readingId !== readingId)) return fail('invalid-cursor', 'INVALID_ARGUMENTS');
    if (saved && saved.scope !== scope) return fail('stale-host', 'STALE_DATA_EPOCH');
    if (saved && saved.source !== source) return fail('source-changed');
    if (saved && (saved.position.chapterIndex >= book.totalChapters || saved.anchor.chapterIndex >= book.totalChapters)) return fail('invalid-cursor', 'INVALID_ARGUMENTS');
    const needle = saved?.keyword ?? (typeof keyword === 'string' ? keyword : undefined);
    let position: Position = saved ? { ...saved.position } : { chapterIndex: 0, paragraphIndex: 0, offset: 0 };
    let anchor = saved?.anchor;
    let matched = saved?.matched ?? false;
    let inMatch = saved?.inMatch ?? false;
    let scannedCharacters = 0;
    let inspectedChapters = 0;
    const loaded = new Map<number, ReadingChapter>();
    const loadedSources = new Map<number, string>();
    const load = async (index: number) => {
      if (loaded.has(index)) return loaded.get(index)!;
      const chapter = await ports.loadChapter(readingId, index);
      if (!chapter) throw MISSING_CHAPTER;
      if (!validChapter(chapter, readingId, index)) throw new Error('invalid-source');
      loaded.set(index, chapter);
      loadedSources.set(index, chapterSource(chapter));
      return chapter;
    };
    if (saved) {
      const prior = await load(saved.anchor.chapterIndex);
      if (chapterSource(prior) !== saved.anchor.source) return fail('source-changed');
      if (saved.anchor.chapterIndex !== position.chapterIndex) inspectedChapters = 1;
    }
    const fragments: Fragment[] = [];
    const cursorPlaceholder = JSON.stringify({ readingId, source, scope, keyword: needle,
      position: { chapterIndex: Number.MAX_SAFE_INTEGER, paragraphIndex: Number.MAX_SAFE_INTEGER, offset: Number.MAX_SAFE_INTEGER },
      anchor: { chapterIndex: Number.MAX_SAFE_INTEGER, source: '0'.repeat(80) }, matched: false, inMatch: false });
    const fits = (values: Fragment[]) => JSON.stringify(result({ state: 'ready', fragments: values,
      nextCursor: cursorPlaceholder, scannedCharacters: MAX_SCAN })).length <= MAX_RESULT;
    const fragment = (text: string, length: number): Fragment => ({ chapterIndex: position.chapterIndex,
      paragraphIndex: position.paragraphIndex, startOffset: position.offset, endOffset: position.offset + length,
      text: text.slice(position.offset, position.offset + length) });
    let exhausted = false;
    while (position.chapterIndex < book.totalChapters) {
      if (inspectedChapters >= MAX_CHAPTERS) { exhausted = true; break; }
      const chapter = await load(position.chapterIndex);
      if (position.paragraphIndex > chapter.paragraphs.length
        || position.offset > (chapter.paragraphs[position.paragraphIndex]?.length ?? 0)) return fail('invalid-cursor', 'INVALID_ARGUMENTS');
      inspectedChapters += 1;
      anchor = { chapterIndex: position.chapterIndex, source: chapterSource(chapter) };
      while (position.paragraphIndex < chapter.paragraphs.length) {
        const text = chapter.paragraphs[position.paragraphIndex];
        if (position.offset >= text.length) { position.paragraphIndex += 1; position.offset = 0; continue; }
        if (needle && !inMatch) {
          const available = MAX_SCAN - scannedCharacters;
          if (available < Math.min(needle.length, text.length - position.offset)) { exhausted = true; break; }
          const end = Math.min(text.length, position.offset + available);
          const inspected = text.slice(position.offset, end);
          const match = asciiLower(inspected).indexOf(asciiLower(needle));
          scannedCharacters += inspected.length;
          if (match < 0) {
            if (end === text.length) { position.paragraphIndex += 1; position.offset = 0; }
            else { position.offset = end - needle.length + 1; exhausted = true; break; }
            continue;
          }
          position.offset += match;
          matched = true;
          inMatch = true;
        }
        const whole = fragment(text, text.length - position.offset);
        if (fits([...fragments, whole])) {
          fragments.push(whole);
          position.paragraphIndex += 1; position.offset = 0;
          inMatch = false;
        } else if (fragments.length) { exhausted = true; break; }
        else {
          let low = 0; let high = text.length - position.offset;
          while (low < high) {
            const mid = Math.ceil((low + high) / 2);
            if (fits([fragment(text, mid)])) low = mid; else high = mid - 1;
          }
          if (low && /[\uD800-\uDBFF]/.test(text[position.offset + low - 1])) low -= 1;
          if (!low) return fail('result-too-large');
          fragments.push(fragment(text, low)); position.offset += low; exhausted = true;
        }
        // A search returns one original match at a time. Its cursor continues search after that excerpt.
        if (needle || exhausted) { exhausted = true; break; }
      }
      if (position.paragraphIndex >= chapter.paragraphs.length) {
        position = { chapterIndex: position.chapterIndex + 1, paragraphIndex: 0, offset: 0 };
      }
      if (exhausted) break;
    }
    if (!await ports.isCurrent()) return fail('stale-host', 'STALE_DATA_EPOCH');
    const latest = await ports.loadBook(readingId);
    if (!latest) return fail('deleted');
    if (bookSource(latest) !== source) return fail('source-changed');
    // Verify every body used for this result without advancing any reading state.
    for (const index of loaded.keys()) {
      const latestChapter = await ports.loadChapter(readingId, index);
      if (!latestChapter) return fail('deleted');
      if (!validChapter(latestChapter, readingId, index) || chapterSource(latestChapter) !== loadedSources.get(index)) return fail('source-changed');
    }
    if (!await ports.isCurrent()) return fail('stale-host', 'STALE_DATA_EPOCH');
    const hasMore = position.chapterIndex < book.totalChapters;
    const nextCursor = hasMore && anchor ? JSON.stringify({ readingId, source, scope, position, keyword: needle, anchor, matched, inMatch }) : undefined;
    const state = fragments.length ? 'ready' : needle ? hasMore ? 'search_incomplete' : matched ? 'end' : 'not_matched' : hasMore ? 'ready' : 'end';
    const output = result({ state, fragments, ...(nextCursor ? { nextCursor } : {}), ...(needle ? { scannedCharacters } : {}) });
    return JSON.stringify(output).length <= MAX_RESULT ? output : fail('result-too-large');
  } catch (error) {
    return fail(error === MISSING_CHAPTER ? 'unprepared' : 'read-failed');
  }
}
