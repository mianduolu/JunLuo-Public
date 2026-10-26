import { createToolError } from '../tools/toolErrors';
import { createToolErrorResult, createToolSuccessResult } from '../tools/toolResult';
import type { JunLuoToolCall, JunLuoToolResult } from '../tools/toolTypes';
import { createGiftPreparationSession, GiftPreparationError, type GiftPreparationAttachment, type GiftPreparationCheckpoint, type GiftPreparationView } from './giftPreparationSession';
import { resolveGiftPreparationTime } from './giftPreparationTime';
import { GIFT_TOOL_RESULT_LIMIT, isGiftToolId } from './giftToolContract';
import type { GiftRecord, GiftView } from './giftTypes';

export type GiftToolCheckpoint = { session: GiftPreparationCheckpoint; giftIds: string[]; fileIds: string[];
  keepIds: Array<{ giftId: string; attachmentIds: string[] }> };
type Row = Record<string, unknown>;
const row = (value: unknown): Row => { if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('gift-invalid-arguments'); return value as Row; };
const keys = (value: Row, allowed: readonly string[]) => { if (Object.keys(value).some(key => !allowed.includes(key))) throw Error('gift-invalid-arguments'); };
const optional = (value: unknown): string | undefined => { if (value == null || value === '') return undefined; if (typeof value !== 'string') throw Error('gift-invalid-arguments'); return value; };
const required = (value: unknown): string => { if (typeof value !== 'string' || !value.trim()) throw Error('gift-invalid-arguments'); return value; };
const iso = (value: number | null | undefined) => value == null ? null : new Date(value).toISOString();
const prefix = (text: string, size: number) => { let end = Math.min(text.length, Math.max(0, size)); if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--; return text.slice(0, end); };
function summary(view: GiftView) {
  const gift = view.gift;
  return { id: gift.id, sender: gift.sender, title: gift.title, deliveryStatus: gift.deliveryStatus, receptionStatus: gift.receptionStatus,
    revealed: view.revealed, updatedAt: iso(gift.updatedAt), scheduledAt: 'scheduledAt' in gift ? iso(gift.scheduledAt) : null,
    scheduledTimeZone: 'scheduledTimeZone' in gift ? gift.scheduledTimeZone : null, deliveredAt: iso(gift.deliveredAt), openedAt: 'openedAt' in gift ? iso(gift.openedAt) : null };
}
function selected(view: GiftView | undefined) {
  return !view ? null : { ...summary(view), ...(view.revealed ? { note: view.gift.note, coverFileId: view.gift.cover?.id ?? null,
    attachments: view.gift.attachments.map(item => ({ attachmentId: item.id, kind: item.kind,
      ...(item.kind === 'url' ? { url: item.url } : { fileId: item.id, name: item.original.originalName, mimeType: item.original.mimeType, byteSize: item.original.byteSize }) })) } : {}) };
}
function receipt(gift: GiftRecord, action: string) {
  return { action, giftId: gift.id, sender: gift.sender, title: gift.title, deliveryStatus: gift.deliveryStatus, receptionStatus: gift.receptionStatus,
    attachmentIds: gift.attachments.map(item => item.id), updatedAt: iso(gift.updatedAt), scheduledAt: iso(gift.scheduledAt),
    scheduledTimeZone: gift.scheduledTimeZone, deliveredAt: iso(gift.deliveredAt), openedAt: iso(gift.openedAt) };
}
function viewFacts(source: GiftPreparationView, giftId: string | undefined, query: string | undefined, offset: number) {
  const search = query?.trim().toLocaleLowerCase();
  const gifts = source.gifts.filter(view => !search || [view.gift.id, view.gift.title,
    ...(view.revealed ? [view.gift.note, ...view.gift.attachments.map(item => item.kind === 'url' ? item.url : item.original.originalName)] : [])]
    .some(value => value.toLocaleLowerCase().includes(search)));
  const matchingIds = new Set(gifts.flatMap(view => view.revealed ? view.gift.attachments.map(item => item.id) : []));
  const files = source.files.filter(file => !search || file.name.toLocaleLowerCase().includes(search) || file.fileId.toLocaleLowerCase().includes(search) || matchingIds.has(file.fileId));
  const chosen = giftId ? source.gifts.find(view => view.gift.id === giftId) : undefined;
  const detail = selected(chosen);
  const base = { action: 'view', now: new Date().toISOString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    gifts: [] as ReturnType<typeof summary>[], files: [] as GiftPreparationView['files'], totalGifts: gifts.length, totalFiles: files.length,
    nextOffset: null as number | null, selectedGift: detail, htmlSources: source.htmlSources };
  const render = (allowance: number) => {
    let left = allowance;
    const originalNote = detail && 'note' in detail ? detail.note : undefined;
    const note = typeof originalNote === 'string' ? prefix(originalNote, left) : undefined;
    if (note !== undefined) left -= note.length;
    return { ...base, selectedGift: detail ? { ...detail, ...(note === undefined ? {} : { note: note.length === originalNote!.length ? note
      : { content: note, through: note.length, total: originalNote!.length, complete: false } }) } : null,
      htmlSources: source.htmlSources.map(item => { const content = prefix(item.content, left); left -= content.length;
        return { ...item, content, through: content.length, complete: content.length === item.total }; }) };
  };
  const entries = [...gifts.map(gift => ({ gift })), ...files.map(file => ({ file }))];
  let cursor = Math.min(offset, entries.length);
  if (JSON.stringify(render(0)).length > GIFT_TOOL_RESULT_LIMIT) throw Error('gift-tool-result-too-large');
  while (cursor < entries.length && base.gifts.length + base.files.length < 6) {
    const entry = entries[cursor];
    if ('gift' in entry) base.gifts.push(summary(entry.gift)); else base.files.push(entry.file);
    base.nextOffset = cursor + 1 < entries.length ? cursor + 1 : null;
    if (JSON.stringify(render(0)).length > GIFT_TOOL_RESULT_LIMIT) {
      if ('gift' in entry) base.gifts.pop(); else base.files.pop();
      base.nextOffset = cursor; break;
    }
    cursor++;
  }
  if (cursor === entries.length) base.nextOffset = null;
  else base.nextOffset = cursor;
  if (cursor === offset && cursor < entries.length) throw Error('gift-tool-result-too-large');
  let low = 0, high = 12000, best = 0;
  while (low <= high) { const middle = Math.floor((low + high) / 2);
    if (JSON.stringify(render(middle)).length <= GIFT_TOOL_RESULT_LIMIT) { best = middle; low = middle + 1; } else high = middle - 1; }
  return { data: render(best), chosen };
}

/** The caller supplies its current opportunity; this host binds only facts actually shown to I. */
export function createGiftToolTurn(input: { dataEpoch: number | null; isCurrent?: () => boolean | Promise<boolean>;
  signal?: AbortSignal; checkpoint?: GiftToolCheckpoint }) {
  const session = createGiftPreparationSession({ dataEpoch: input.dataEpoch, checkpoint: input.checkpoint?.session,
    isCurrent: async () => !input.signal?.aborted && (!input.isCurrent || await input.isCurrent()) && !input.signal?.aborted });
  const giftIds = new Set(input.checkpoint?.giftIds ?? []), fileIds = new Set(input.checkpoint?.fileIds ?? []);
  const keepIds = new Map((input.checkpoint?.keepIds ?? []).map(item => [item.giftId, new Set(item.attachmentIds)]));
  const results = new Map<string, { identity: string; result: Promise<JunLuoToolResult> }>();
  const rememberGift = (gift: GiftRecord) => { giftIds.add(gift.id); keepIds.set(gift.id, new Set(gift.attachments.map(item => item.id)));
    gift.attachments.forEach(item => { if (item.kind !== 'url') fileIds.add(item.id); }); };
  const fail = (call: JunLuoToolCall, action: string, cause: unknown, giftId?: string) => {
    const errorCode = cause instanceof Error && /^gift-[a-z-]+$/.test(cause.message) ? cause.message : 'gift-tool-failed';
    const actual = cause instanceof GiftPreparationError ? cause : undefined;
    const storedId = actual?.giftId ?? giftId;
    if (storedId && /^gift-[A-Za-z0-9-]+$/.test(storedId) && actual?.giftId) giftIds.add(storedId);
    const result = createToolErrorResult(call, createToolError(errorCode.includes('stale') || errorCode === 'gift-preparation-source-changed'
      ? 'STALE_DATA_EPOCH' : 'EXECUTION_FAILED', errorCode,
      actual?.savedGift ? { savedReceipt: receipt(actual.savedGift, action === 'schedule' && actual.savedGift.deliveryStatus !== 'scheduled' ? 'prepare' : action),
        cleanupFailed: actual.cleanupFailed } : undefined), '');
    return { ...result, data: { action, ...(storedId && /^gift-[A-Za-z0-9-]+$/.test(storedId) ? { giftId: storedId } : {}), errorCode } };
  };
  const execute = async (call: JunLuoToolCall): Promise<JunLuoToolResult> => {
    let action = call.toolId.slice('gift.'.length), giftId: string | undefined;
    try {
      if (!isGiftToolId(call.toolId) || !['chat', 'proactive', 'life_agent'].includes(call.requestedBy) || input.signal?.aborted) throw Error('gift-tool-unavailable');
      const values = row(call.input); giftId = optional(values.giftId);
      if (call.toolId === 'gift.view') {
        keys(values, ['giftId', 'query', 'offset']); const query = optional(values.query), offset = values.offset == null ? 0 : values.offset;
        if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) throw Error('gift-invalid-arguments');
        let page: ReturnType<typeof viewFacts> | undefined;
        const source = await session.view(giftId, visible => {
          page = viewFacts(visible, giftId, query, offset);
          const shown = page.data.selectedGift, attachmentIds = shown?.attachments?.map(item => item.attachmentId) ?? [];
          return { giftIds: [...page.data.gifts.filter(gift => gift.sender === 'I').map(gift => gift.id), ...(shown?.sender === 'I' ? [shown.id] : [])],
            fileIds: [...page.data.files.map(file => file.fileId), ...attachmentIds.filter(id => visible.files.some(file => file.fileId === id))] };
        });
        const data = page!.data;
        for (const gift of data.gifts) if (gift.sender === 'I') giftIds.add(gift.id);
        for (const file of data.files) fileIds.add(file.fileId);
        const shown = data.selectedGift;
        if (shown?.revealed && shown.attachments) {
          if (shown.sender === 'I') { giftIds.add(shown.id); keepIds.set(shown.id, new Set(shown.attachments.map(item => item.attachmentId))); }
          for (const item of shown.attachments) if (source.files.some(file => file.fileId === item.attachmentId)) fileIds.add(item.attachmentId);
        }
        return createToolSuccessResult(call, '', data);
      }
      if (giftId && !giftIds.has(giftId)) throw Error('gift-preparation-view-required');
      if (call.toolId === 'gift.prepare') {
        keys(values, ['giftId', 'title', 'note', 'cover', 'attachments']);
        if (typeof values.title !== 'string' || typeof values.note !== 'string' || !Array.isArray(values.attachments)) throw Error('gift-invalid-arguments');
        const attachments: GiftPreparationAttachment[] = values.attachments.map(value => {
          const item = row(value); keys(item, ['kind', 'attachmentId', 'fileId', 'url', 'name', 'html']);
          const used = item.kind === 'keep' ? ['attachmentId'] : item.kind === 'file' ? ['fileId'] : item.kind === 'url' ? ['url'] : item.kind === 'html' ? ['name', 'html'] : [];
          if (!used.length || Object.entries(item).some(([key, value]) => key !== 'kind' && value != null && !used.includes(key))) throw Error('gift-invalid-arguments');
          if (item.kind === 'keep') { const attachmentId = required(item.attachmentId);
            if (!giftId || !keepIds.get(giftId)?.has(attachmentId)) throw Error('gift-attachment-not-offered'); return { kind: 'keep', attachmentId }; }
          if (item.kind === 'file') { const fileId = required(item.fileId); if (!fileIds.has(fileId)) throw Error('gift-preparation-file-not-offered'); return { kind: 'file', fileId }; }
          if (item.kind === 'url') return { kind: 'url', url: required(item.url) };
          return { kind: 'html', name: required(item.name), html: required(item.html) };
        });
        let coverFileId: string | null | undefined;
        if (values.cover != null) {
          const cover = row(values.cover); keys(cover, ['action', 'fileId']);
          if (cover.action === 'file') { coverFileId = required(cover.fileId); if (!fileIds.has(coverFileId)) throw Error('gift-preparation-file-not-offered'); }
          else if (cover.action === 'clear' || cover.action === 'keep') {
            if (cover.fileId != null) throw Error('gift-invalid-arguments'); if (cover.action === 'clear') coverFileId = null;
          } else throw Error('gift-invalid-arguments');
        }
        const gift = await session.prepare({ giftId, title: values.title, note: values.note, attachments, coverFileId });
        const data = receipt(gift, 'prepare'); giftIds.add(gift.id);
        if (JSON.stringify(data).length > GIFT_TOOL_RESULT_LIMIT) throw new GiftPreparationError('gift-tool-result-too-large', gift.id, gift);
        rememberGift(gift); return createToolSuccessResult(call, '', data);
      }
      if (call.toolId === 'gift.supplement') {
        keys(values, ['giftId', 'attachments']); giftId = required(values.giftId);
        if (!giftIds.has(giftId)) throw Error('gift-preparation-view-required');
        if (!Array.isArray(values.attachments) || !values.attachments.length) throw Error('gift-invalid-arguments');
        const attachments = values.attachments.map(value => {
          const item = row(value); keys(item, ['kind', 'fileId', 'url', 'name', 'html']);
          const used = item.kind === 'file' ? ['fileId'] : item.kind === 'url' ? ['url'] : item.kind === 'html' ? ['name', 'html'] : [];
          if (!used.length || Object.entries(item).some(([key, value]) => key !== 'kind' && value != null && !used.includes(key))) throw Error('gift-invalid-arguments');
          if (item.kind === 'file') { const fileId = required(item.fileId);
            if (!fileIds.has(fileId)) throw Error('gift-preparation-file-not-offered'); return { kind: 'file' as const, fileId }; }
          if (item.kind === 'url') return { kind: 'url' as const, url: required(item.url) };
          return { kind: 'html' as const, name: required(item.name), html: required(item.html) };
        });
        const gift = await session.supplement({ giftId, attachments }); rememberGift(gift);
        const data = receipt(gift, 'supplement');
        if (JSON.stringify(data).length > GIFT_TOOL_RESULT_LIMIT) throw new GiftPreparationError('gift-tool-result-too-large', gift.id, gift);
        return createToolSuccessResult(call, '', data);
      }
      keys(values, ['giftId', 'mode', 'date', 'time']); giftId = required(values.giftId);
      if (!giftIds.has(giftId)) throw Error('gift-preparation-view-required');
      if (!['now', 'schedule', 'cancel'].includes(String(values.mode))) throw Error('gift-invalid-arguments');
      const mode = values.mode as 'now' | 'schedule' | 'cancel'; action = mode === 'now' ? 'deliver' : mode;
      const date = optional(values.date), time = optional(values.time);
      if (mode !== 'schedule' && (date !== undefined || time !== undefined)) throw Error('gift-invalid-arguments');
      const at = mode === 'schedule' ? resolveGiftPreparationTime(required(date), required(time)).at : undefined;
      const gift = await session.deliver({ giftId, mode, at }); rememberGift(gift);
      return createToolSuccessResult(call, '', receipt(gift, action));
    } catch (error) { return fail(call, action, error, giftId); }
  };
  const host = (call: JunLuoToolCall): Promise<JunLuoToolResult> => {
    const identity = JSON.stringify([call.toolId, call.input, call.requestedBy, call.sourceMessageId]), prior = results.get(call.callId);
    if (prior) return prior.identity === identity ? prior.result : Promise.resolve(fail(call, call.toolId.slice(5), Error('gift-tool-call-conflict')));
    const result = execute(call); results.set(call.callId, { identity, result }); return result;
  };
  return Object.assign(host, {
    checkpoint(): GiftToolCheckpoint { return { session: session.exportCheckpoint({ giftIds: [...giftIds], fileIds: [...fileIds] }),
      giftIds: [...giftIds], fileIds: [...fileIds], keepIds: [...keepIds].map(([giftId, ids]) => ({ giftId, attachmentIds: [...ids] })) }; },
    async seed(gifts: readonly { id: string; revision: number; attachmentIds?: readonly string[] }[]) {
      for (const expected of gifts) {
        let exposed: string[] = [], available: string[] = [];
        await session.view(expected.id, source => {
          const view = source.gifts.find(item => item.gift.id === expected.id);
          if (!view?.revealed || view.gift.sender !== 'I' || view.gift.revision !== expected.revision) throw Error('gift-stale-version');
          exposed = (expected.attachmentIds ?? []).filter(id => view.gift.attachments.some(item => item.id === id));
          available = exposed.filter(id => source.files.some(file => file.fileId === id));
          return { giftIds: [expected.id], fileIds: available };
        });
        giftIds.add(expected.id); keepIds.set(expected.id, new Set(exposed)); available.forEach(id => fileIds.add(id));
      }
    },
  });
}
