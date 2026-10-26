import type { SQLiteDatabase } from 'expo-sqlite';
import { getMemoryDatabase } from '../memory/memoryStore';
import { currentGiftEchoGift, assertGiftEchoEpoch } from './giftEchoOriginal';
import type { GiftAttachmentActivity, GiftWorkToken } from './giftTypes';

export type GiftProgressMaterial = { attachmentId: string; subject: 'you'; savedAt: string;
  summary: string; stateProvided: boolean; state: unknown };
export type GiftPlaybackMaterial = { attachmentId: string; subject: 'you'; playedAt: string };

/** Only actual saved you activity; never sends the work's localStorage bundle. */
export async function loadGiftActivityMaterials(token: GiftWorkToken, database?: SQLiteDatabase): Promise<{
  progress: GiftProgressMaterial[]; playbacks: GiftPlaybackMaterial[];
}> {
  const db = database ?? await getMemoryDatabase(), gift = await currentGiftEchoGift(token, db);
  const rows = await db.getAllAsync<{ attachment_id: string; record_json: string }>(
    "SELECT attachment_id,record_json FROM gift_attachment_activity WHERE gift_id=? AND viewer='you'", gift.id);
  const progress: GiftProgressMaterial[] = [], playbacks: GiftPlaybackMaterial[] = [];
  for (const attachment of gift.attachments) {
    const row = rows.find(item => item.attachment_id === attachment.id);
    if (!row) continue;
    const activity = JSON.parse(row.record_json) as GiftAttachmentActivity;
    if (attachment.kind === 'html' && activity.progressUpdatedAt !== null) {
      const serialized = JSON.stringify(activity.progress.state), stateProvided = serialized !== undefined && serialized.length <= 6000;
      progress.push({ attachmentId: attachment.id, subject: 'you', savedAt: new Date(activity.progressUpdatedAt).toISOString(),
        summary: activity.progress.summary, stateProvided, state: stateProvided ? activity.progress.state : null });
    }
    if (attachment.kind === 'audio' && activity.lastPlayedAt !== null) playbacks.push({ attachmentId: attachment.id,
      subject: 'you', playedAt: new Date(activity.lastPlayedAt).toISOString() });
  }
  await currentGiftEchoGift(token, db); assertGiftEchoEpoch(token);
  return { progress, playbacks };
}
