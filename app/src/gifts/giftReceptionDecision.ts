import * as FileSystem from 'expo-file-system/legacy';
import { loadAiConfigPreferencesSnapshot } from '../ai/AiConfigPreferences';
import { compilePersonaPromptResult } from '../ai/persona/promptCompiler';
import { SUBJECTIVE_IDENTITY_PROTOCOL } from '../ai/subjectiveMessages';
import { requestGiftReceptionChoice } from '../ai/giftOriginalUnderstandingRequest';
import { canCommitBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { giftOriginalUri } from './giftFiles';
import { loadGiftView } from './giftStore';
import type { GiftReceptionDecision, GiftWorkToken } from './giftTypes';

/** Approved verbatim: docs/礼物柜第五章接收选择审稿.md, 2026-10-16. */
export const GIFT_RECEPTION_PROMPT = `【留意礼物】
I 收到 you 送来的一份礼物，此刻看见的是它的包装。

I 依着此刻的关系和自己的心意，选择现在打开、稍后再看，或不收下。

选择稍后时，I 决定过多少分钟再来看看；到了那时，I 仍可以重新选择。

I 用 JSON 记录这次选择：
{"choice":"open","reconsiderAfterMinutes":null}

choice 用 open 表示现在打开、later 表示稍后再看、decline 表示不收下。
选择 later 时，reconsiderAfterMinutes 填一个大于零的整数分钟；其余选择填 null。`;

export function parseGiftReceptionDecision(text: string): GiftReceptionDecision {
  let value: unknown;
  try { value = JSON.parse(text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, '$1')); }
  catch { throw Error('gift-invalid-reception-response'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('gift-invalid-reception-response');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 2 || !Object.hasOwn(record, 'choice') || !Object.hasOwn(record, 'reconsiderAfterMinutes')
    || !['open', 'later', 'decline'].includes(record.choice as string)) throw Error('gift-invalid-reception-response');
  if (record.choice === 'later' ? !Number.isSafeInteger(record.reconsiderAfterMinutes)
      || (record.reconsiderAfterMinutes as number) <= 0
      || !Number.isFinite(new Date(Date.now() + (record.reconsiderAfterMinutes as number) * 60_000).getTime())
    : record.reconsiderAfterMinutes !== null) throw Error('gift-invalid-reception-response');
  return { choice: record.choice as GiftReceptionDecision['choice'], reconsiderAfterMinutes: record.reconsiderAfterMinutes as number | null };
}

async function packaging(token: GiftWorkToken) {
  if (!canCommitBackupRestoreDataEpoch(token.dataEpoch)) throw Error('gift-stale-data-epoch');
  const view = await loadGiftView(token.id, 'I');
  if (!canCommitBackupRestoreDataEpoch(token.dataEpoch)) throw Error('gift-stale-data-epoch');
  if (!view || view.gift.revision !== token.revision) throw Error('gift-stale-version');
  if (view.revealed || view.gift.sender !== 'you' || view.gift.receptionStatus === 'declined'
    || (view.gift.receptionNextAt != null && view.gift.receptionNextAt > Date.now())) throw Error('gift-reception-not-due');
  return view.gift;
}

async function readCover(token: GiftWorkToken, cover: Awaited<ReturnType<typeof packaging>>['cover']) {
  if (!cover || !/^image\/(?:png|jpe?g|gif|webp)$/i.test(cover.mimeType)) return null;
  let base64: string | null = null;
  try {
    const uri = giftOriginalUri(cover), info = await FileSystem.getInfoAsync(uri);
    if (info.exists && !info.isDirectory && info.size > 0) {
      const data = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
      if (data.length === Math.ceil(info.size / 3) * 4 && /^[A-Za-z0-9+/]+={0,2}$/.test(data)) base64 = data;
    }
  } catch { /* An unreadable cover uses the approved title-only path. */ }
  await packaging(token);
  return base64 ? `data:${cover.mimeType};base64,${base64}` : null;
}

function attentionMaterial(gift: Awaited<ReturnType<typeof packaging>>, coverProvided: boolean) {
  const previousChoice = gift.receptionStatus === 'deferred' && gift.receptionDecidedAt != null && gift.receptionNextAt != null
    ? { subject: 'I', choice: 'later', decidedAt: new Date(gift.receptionDecidedAt).toISOString(),
      reconsiderAt: new Date(gift.receptionNextAt).toISOString() } : null;
  return `【包装记录】\n${JSON.stringify({ sender: gift.sender, title: gift.title, coverProvided }, null, 2)}\n\n`
    + `【本次留意】\n${JSON.stringify({ now: new Date().toISOString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      occasion: previousChoice ? 'reconsideration' : 'new_delivery', previousChoice }, null, 2)}`;
}

/** No interior, memory recall or invented dialogue enters this decision. */
export async function prepareGiftReceptionDecision(sourceToken: GiftWorkToken) {
  const token = { ...sourceToken }, gift = await packaging(token);
  const config = await loadAiConfigPreferencesSnapshot({ readOnly: true, maxAgeMs: 0 });
  const visionReady = config.visionConnection?.baseUrl.trim() && config.visionConnection.model.trim() && config.visionKey.trim();
  const cover = visionReady ? await readCover(token, gift.cover) : null;
  const connection = cover ? config.visionConnection : config.chatConnection;
  const apiKey = cover ? config.visionKey : config.chatKey;
  if (!connection?.baseUrl.trim() || !connection.model.trim() || !apiKey.trim()) throw Error('gift-reception-connection-unavailable');
  const compiled = await compilePersonaPromptResult({ readOnly: true, profile: config.profile,
    contextProfile: 'chat-full', outputAudience: 'private_visible_text', conversationText: gift.title });
  const systemMessages: string[] = [];
  const assemble = (current: typeof gift) => systemMessages.splice(0, systemMessages.length,
    [SUBJECTIVE_IDENTITY_PROTOCOL, compiled.stablePrompt].filter(Boolean).join('\n\n'),
    ...(compiled.dynamicPrompt ? [compiled.dynamicPrompt] : []),
    `${GIFT_RECEPTION_PROMPT}\n\n${attentionMaterial(current, cover !== null)}`);
  assemble(gift);
  return { connection, async request(beforeRequest: (assertReady?: () => Promise<void>) => Promise<void>, onResult?: (decision: GiftReceptionDecision) => void) {
    const raw = await requestGiftReceptionChoice({ apiKey, connection, systemMessages,
      ...(cover ? { material: { role: 'you' as const, content: [{ type: 'text' as const, text: '礼物包装封面' },
        { type: 'image_url' as const, image_url: { url: cover } }] } } : {}),
      beforeRequest: async () => {
        let checked = false;
        const assertReady = async () => {
          const latest = await loadAiConfigPreferencesSnapshot({ readOnly: true, maxAgeMs: 0 });
          if (JSON.stringify(cover ? latest.visionConnection : latest.chatConnection) !== JSON.stringify(connection)
            || (cover ? latest.visionKey : latest.chatKey) !== apiKey
            || JSON.stringify(latest.profile) !== JSON.stringify(config.profile)) throw Error('gift-understanding-config-changed');
          assemble(await packaging(token));
          checked = true;
        };
        await beforeRequest(assertReady);
        if (!checked) await assertReady();
      },
    });
    const decision = parseGiftReceptionDecision(raw);
    onResult?.(decision);
    await packaging(token);
    return decision;
  } };
}
