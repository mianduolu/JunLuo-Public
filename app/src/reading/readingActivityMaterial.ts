import { fingerprintPromptText } from '../ai/promptCacheMetrics';
import { loadFocusActivityFacts } from '../focus/focusReadingRuntime';
import { loadCurrentReadingActivity, buildDailyReadingCurrentMaterial } from './readingDailyRuntime';
import { loadReadingLibraryStrict } from './readingStore';
import { formatReadingTime } from './readingDailyPolicy';

export type ReadingActivityRef = { id: string; revision: string };
type Fact = ReadingActivityRef & { text: string; at: number; current?: boolean };
const ref = (id: string, value: unknown) => ({ id, revision: fingerprintPromptText(JSON.stringify(value)) });

async function loadFacts(now: number): Promise<Fact[]> {
  const [books, current, focus] = await Promise.all([
    loadReadingLibraryStrict(), loadCurrentReadingActivity(now), loadFocusActivityFacts(now),
  ]);
  const facts: Fact[] = books.flatMap(book => (book.iReading?.events ?? []).filter(event => event.at <= now).map(event => ({
    ...ref(`reading:${book.id}:${event.id}`, [book.title, event]), at: event.at,
    text: `${formatReadingTime(event.at)}｜读《${book.title}》｜${event.change}`,
  })));
  facts.push(...focus.records.filter(event => event.at <= now).map(event => ({
    ...ref(`focus:${event.id}`, event), at: event.at,
    text: `${formatReadingTime(event.at)}｜${event.activity}｜${event.change}`,
  })));
  if (current && current.status !== 'ended') {
    facts.push({ ...ref(`reading-current:${current.bookId}:${current.id}`, [current.operationId, current.status, current.title]),
      at: current.updatedAt, current: true, text: await buildDailyReadingCurrentMaterial(now) });
  } else if (focus.current) facts.push({ ...ref(`focus-current:${focus.current.id}`, focus.current),
    at: now, current: true, text: `I 目前的活动：${focus.current.activity}\n活动状态：${focus.current.status}` });
  return facts;
}

/** Optional background only: callers decide the request opportunity before adding these facts. */
export async function collectReadingActivityMaterial(now: number, usedRecords = 0, usedCharacters = 0) {
  const available = await loadFacts(now);
  const selected: Fact[] = [];
  const count = Math.max(0, 8 - usedRecords), capacity = Math.max(0, 1000 - usedCharacters);
  const render = (items: Fact[]) => {
    const current = items.find(item => item.current), history = items.filter(item => !item.current).sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
    const activity = [current?.id.startsWith('focus-current:') ? current.text : '', history.length
      ? `最近的活动记录：\n${history.map(item => item.text).join('\n')}` : ''].filter(Boolean).join('\n\n');
    return [current?.id.startsWith('reading-current:') ? current.text : '', activity ? `【I 的活动近况】\n\n${activity}` : ''].filter(Boolean).join('\n\n');
  };
  for (const item of available.sort((a, b) => Number(!!b.current) - Number(!!a.current) || b.at - a.at || a.id.localeCompare(b.id))) {
    if (selected.length >= count) break;
    if (selected.some(existing => existing.id === item.id)) continue;
    if (render([...selected, item]).length <= capacity) selected.push(item);
  }
  return { material: render(selected), refs: selected.map(({ id, revision }) => ({ id, revision })) };
}

export async function readingActivityRefsMatch(refs: readonly ReadingActivityRef[], now: number) {
  if (!refs.length) return true;
  const facts = await loadFacts(now);
  return refs.every(item => facts.some(fact => fact.id === item.id && fact.revision === item.revision));
}
