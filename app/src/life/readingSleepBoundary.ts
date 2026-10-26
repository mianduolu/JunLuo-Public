import { listAssistantLifeDays, loadAssistantLifeDay } from '../ai/assistantLifeTimeline';
import { loadReadingLibraryStrict } from '../reading/readingStore';

/** Read saved sleep facts, including a night which ended before this delayed check. */
export async function findReadingSleepBoundary(now: number): Promise<number | undefined> {
  const activities = (await loadReadingLibraryStrict()).flatMap(book =>
    book.iReading?.activity?.status === 'reading' ? [book.iReading.activity] : []);
  if (!activities.length) return undefined;
  const after = Math.min(...activities.map(activity => activity.checkpointAt));
  let earliest: number | undefined;
  for (const key of await listAssistantLifeDays(Number.MAX_SAFE_INTEGER)) {
    // Cross-day plans keep their original key; do not restrict this to yesterday.
    const plan = (await loadAssistantLifeDay(key))?.nightSleepPlan;
    const times = [plan?.actualSleepAt, ...(plan?.events ?? [])
      .filter(event => event.kind === 'sleep' || event.kind === 'sleep_return').map(event => event.at)];
    for (const at of times) if (at !== undefined && at > after && at <= now) earliest = Math.min(earliest ?? Infinity, at);
  }
  return earliest;
}
