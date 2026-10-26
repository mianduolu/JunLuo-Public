import { getMemoryDatabase } from '../memory/memoryStore';
import { captureBackupRestoreDataEpoch, canCommitBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import type { CrossPageBlock } from '../ai/assistantCrossPageExperience';
import { loadGiftView } from './giftStore';
import { loadGiftEchoThread } from './giftEchoStore';
import { loadGiftActivityMaterials } from './giftActivityMaterials';
import type { GiftEcho, GiftRecord, GiftVersion } from './giftTypes';

type Activity = Awaited<ReturnType<typeof loadGiftActivityMaterials>>;
export type GiftCrossPageSource = {
  kind: 'gift'; id: string; revision: number;
  events: Array<{ id: string; at: number; facts: Record<string, unknown>; messages: CrossPageBlock[] }>;
};
const actualTime = (at: unknown): at is number => typeof at === 'number' && Number.isSafeInteger(at)
  && at >= 0 && Number.isFinite(new Date(at).getTime());
const opened = (gift: GiftRecord) => gift.deliveryStatus === 'delivered' && gift.receptionStatus === 'opened'
  && actualTime(gift.deliveredAt) && actualTime(gift.openedAt);
const iso = (at: number) => new Date(at).toISOString();
function assertEpoch(epoch: number | null) {
  if (!canCommitBackupRestoreDataEpoch(epoch)) throw Error('gift-stale-data-epoch');
}

/** Only saved facts and real speech become units; reading this source creates no event. */
export function buildGiftCrossPageSource(gift: GiftRecord, echoes: readonly GiftEcho[], activity: Activity): GiftCrossPageSource | null {
  if (!opened(gift)) return null;
  const openedAt = gift.openedAt!, events: GiftCrossPageSource['events'] = [];
  const context = { sender: gift.sender, title: gift.title, deliveredAt: iso(gift.deliveredAt!), openedAt: iso(openedAt) };
  const add = (id: string, at: number, facts: Record<string, unknown>, messages: CrossPageBlock[] = []) => {
    if (actualTime(at) && at >= openedAt) events.push({ id: `${gift.id}:${id}`, at, facts: { ...context, ...facts }, messages });
  };
  add('opened', openedAt, { event: 'opened' });
  for (const echo of echoes) {
    if (echo.giftId !== gift.id || echo.giftRevision !== gift.revision || !actualTime(echo.createdAt)
      || echo.createdAt < openedAt || !['I', 'you'].includes(echo.subject) || !echo.content.trim()) continue;
    const attachment = gift.attachments.find(item => item.id === echo.attachmentId);
    if (echo.subject === 'I' && ['understanding', 'reply'].includes(echo.origin) && actualTime(echo.readAt)
      && echo.readAt <= echo.createdAt && attachment && attachment.kind !== 'url' && attachment.original.id === echo.originalId) {
      add(`read:${echo.id}`, echo.readAt, { event: 'internal_original_read', subject: 'I', echoId: echo.id,
        attachmentId: attachment.id, originalId: attachment.original.id, readAt: iso(echo.readAt),
        kind: echo.origin === 'understanding' ? 'first' : 'revisit' });
    }
    add(`echo:${echo.id}`, echo.createdAt, { event: 'echo', echoId: echo.id, subject: echo.subject, at: iso(echo.createdAt) },
      [{ role: echo.subject, at: echo.createdAt, text: echo.content }]);
  }
  for (const playback of activity.playbacks) {
    const at = Date.parse(playback.playedAt);
    if (playback.subject === 'you' && gift.attachments.some(item => item.id === playback.attachmentId && item.kind === 'audio'))
      add(`playback:${playback.attachmentId}:${playback.playedAt}`, at, { event: 'you_playback', ...playback });
  }
  for (const progress of activity.progress) {
    const at = Date.parse(progress.savedAt);
    if (progress.subject === 'you' && gift.attachments.some(item => item.id === progress.attachmentId && item.kind === 'html'))
      add(`progress:${progress.attachmentId}:${progress.savedAt}`, at, { event: 'web_progress', ...progress });
  }
  // Stable ties retain the actual echo sequence (and opening before same-time speech).
  events.sort((a, b) => a.at - b.at);
  return { kind: 'gift', id: gift.id, revision: gift.revision, events };
}

/** Query identities before reading contents, so unopened/preparation data never enters this source. */
export async function loadGiftCrossPageSources(ownerId?: string): Promise<GiftCrossPageSource[]> {
  const epoch = captureBackupRestoreDataEpoch(); assertEpoch(epoch);
  const database = await getMemoryDatabase();
  const versions = await database.getAllAsync<GiftVersion>(`SELECT id,revision FROM gift_records
    WHERE json_extract(record_json,'$.deliveryStatus')='delivered'
      AND json_extract(record_json,'$.receptionStatus')='opened' AND json_extract(record_json,'$.openedAt') IS NOT NULL
      ${ownerId === undefined ? '' : 'AND id=?'} ORDER BY id`, ...(ownerId === undefined ? [] : [ownerId]));
  assertEpoch(epoch);
  const sources: GiftCrossPageSource[] = [];
  for (const version of versions) {
    const view = await loadGiftView(version.id, 'I'); assertEpoch(epoch);
    if (!view?.revealed || view.gift.revision !== version.revision || !opened(view.gift)) continue;
    const token = { ...version, dataEpoch: epoch };
    const thread = await loadGiftEchoThread(version, 'I'); assertEpoch(epoch);
    if (thread.token.dataEpoch !== epoch) throw Error('gift-stale-data-epoch');
    const activity = await loadGiftActivityMaterials(token, database);
    const latest = await loadGiftView(version.id, 'I'); assertEpoch(epoch);
    if (!latest?.revealed || latest.gift.revision !== version.revision || !opened(latest.gift)) continue;
    const source = buildGiftCrossPageSource(latest.gift, thread.messages, activity);
    if (source) sources.push(source);
  }
  assertEpoch(epoch);
  return sources;
}
