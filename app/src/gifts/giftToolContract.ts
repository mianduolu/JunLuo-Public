import type { JunLuoToolDefinition, JunLuoToolResult } from '../tools/toolTypes';

export const GIFT_TOOL_IDS = ['gift.view', 'gift.prepare', 'gift.deliver', 'gift.supplement'] as const;
export const isGiftToolId = (value: string) => (GIFT_TOOL_IDS as readonly string[]).includes(value);
export const GIFT_PACKAGE_DESCRIPTION = 'I 在这里查看礼物，准备想送给 you 的东西，再决定什么时候送出。';
export const GIFT_TOOL_RESULT_LIMIT = 8000;
export const GIFT_TOOL_DEFINITIONS: Pick<JunLuoToolDefinition, 'id' | 'name' | 'description' | 'inputSchema'>[] = [
  { id: 'gift.view', name: '查看礼物', description: 'I 看看礼物柜和自己准备中的礼物，也可以再看一份礼物的具体记录。',
    inputSchema: { type: 'object', properties: {
      giftId: { type: 'string', description: '想查看的礼物编号；留空时查看目录。' },
      query: { type: 'string', description: '想找的礼物名字或其中的文字；留空时按最近更新时间查看。' },
      offset: { type: 'number', description: '接着目录中 nextOffset 的位置查看；第一次留空。' },
    }, additionalProperties: false } },
  { id: 'gift.prepare', name: '准备礼物', description: 'I 想给 you 准备礼物，就在这里保存。可以先记想法，也可以放入已有文件、网页链接，或写一份自己的小网页。',
    inputSchema: { type: 'object', properties: {
      giftId: { type: 'string', description: '继续准备时填写已经查看过的 I 的礼物编号；新准备一份时留空。' },
      title: { type: 'string', description: 'I 给这份礼物起的名字。' },
      note: { type: 'string', description: 'I 放在礼物里的留言。' },
      cover: { type: 'object', description: '这次想怎样放包装封面；留空时保留原封面。', properties: {
        action: { type: 'string', enum: ['keep', 'file', 'clear'], description: 'keep 保留原封面；file 选择图片；clear 去掉封面。' },
        fileId: { type: 'string', description: '选择图片时填写真实可选图片的文件编号。' },
      }, required: ['action'], additionalProperties: false },
      attachments: { type: 'array', description: '这次保存的全部内容，按 I 想放的顺序排列；只有想法时可以为空。', items: {
        type: 'object', properties: {
          kind: { type: 'string', enum: ['keep', 'file', 'url', 'html'], description: 'keep 保留这份礼物已有内容；file 选择已有文件；url 保存网页链接；html 写一个小网页。' },
          attachmentId: { type: 'string', description: 'kind 为 keep 时，填写这份礼物中要保留的内容编号。' },
          fileId: { type: 'string', description: 'kind 为 file 时，填写可选文件目录里的真实编号。' },
          url: { type: 'string', description: 'kind 为 url 时，填写网页的 http 或 https 链接。' },
          name: { type: 'string', description: 'kind 为 html 时，给小网页起一个 .html 文件名。' },
          html: { type: 'string', description: 'kind 为 html 时，填写自己创作的单文件 HTML 全文，样式、脚本和素材都放在文件中。有游玩或阅读进度时，用 await window.junluoGift.loadState() 取回 {state,summary,storage} 并恢复，用 await window.junluoGift.saveState(state,summary) 保存当前状态和简短进展。' },
        }, required: ['kind'], additionalProperties: false,
      } },
    }, required: ['title', 'note', 'attachments'], additionalProperties: false } },
  { id: 'gift.deliver', name: '送出礼物', description: 'I 准备好了，就把自己的礼物送给 you，也可以选一个时候再送。想改准备好的时间时，I 先取消原安排。',
    inputSchema: { type: 'object', properties: {
      giftId: { type: 'string', description: '已经查看或在这次准备好的 I 的礼物编号。' },
      mode: { type: 'string', enum: ['now', 'schedule', 'cancel'], description: 'now 现在送出；schedule 安排送出时间；cancel 取消这份礼物的待送安排。' },
      date: { type: 'string', description: 'schedule 时填写本地日期，格式 YYYY-MM-DD。' },
      time: { type: 'string', description: 'schedule 时填写本地时间，格式 HH:mm。' },
    }, required: ['giftId', 'mode'], additionalProperties: false } },
  { id: 'gift.supplement', name: '补充礼物', description: 'I 想给自己送出并已被打开的礼物添些内容，就把新附件放在这里。原件与赠送留言继续保留。',
    inputSchema: { type: 'object', properties: {
      giftId: { type: 'string', description: '已经查看过的、由 I 送出并已被打开的礼物编号。' },
      attachments: { type: 'array', minItems: 1, description: '这次新增的内容，按 I 想放的顺序排列。', items: {
        type: 'object', properties: {
          kind: { type: 'string', enum: ['file', 'url', 'html'], description: 'file 选择已有文件；url 保存网页链接；html 写一个小网页。' },
          fileId: { type: 'string', description: 'kind 为 file 时，填写可选文件目录里的真实编号。' },
          url: { type: 'string', description: 'kind 为 url 时，填写网页的 http 或 https 链接。' },
          name: { type: 'string', description: 'kind 为 html 时，给小网页起一个 .html 文件名。' },
          html: { type: 'string', description: 'kind 为 html 时，填写自己创作的单文件 HTML 全文，样式、脚本和素材都放在文件中。有游玩或阅读进度时，用 await window.junluoGift.loadState() 取回 {state,summary,storage} 并恢复，用 await window.junluoGift.saveState(state,summary) 保存当前状态和简短进展。' },
        }, required: ['kind'], additionalProperties: false,
      } },
    }, required: ['giftId', 'attachments'], additionalProperties: false } },
];

const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : undefined;
const fields = (value: unknown, keys: readonly string[]) => {
  const row = object(value); return row ? Object.fromEntries(keys.filter(key => row[key] !== undefined).map(key => [key, row[key]])) : {};
};
const metadata = ['id', 'sender', 'title', 'deliveryStatus', 'receptionStatus', 'revealed', 'updatedAt', 'scheduledAt', 'scheduledTimeZone', 'deliveredAt', 'openedAt'];
const fileKeys = ['fileId', 'kind', 'name', 'mimeType', 'byteSize'];
function range(value: unknown) { return typeof value === 'string' ? value : fields(value, ['content', 'through', 'total', 'complete']); }
const safeGiftId = (value: unknown) => typeof value === 'string' && value.length <= 200 && /^gift-[A-Za-z0-9-]+$/.test(value) ? value : undefined;
const safeCode = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(value) ? value : 'gift-tool-failed';

/** The model receives the approved operation facts, without tool wrappers or device-only source bindings. */
export function serializeGiftToolResult(result: JunLuoToolResult): string {
  if (!isGiftToolId(result.toolId)) return '';
  const data = object(result.data), fallbackAction = result.toolId.slice('gift.'.length);
  const action = ['view', 'prepare', 'deliver', 'schedule', 'cancel', 'supplement'].includes(String(data?.action)) ? String(data!.action) : fallbackAction;
  const giftId = safeGiftId(data?.giftId);
  if (!result.ok || data?.errorCode !== undefined || !data) return JSON.stringify({ action,
    ...(giftId ? { giftId } : {}), errorCode: safeCode(data?.errorCode ?? result.error?.code) });
  let projected: Record<string, unknown>;
  if (action === 'view') {
    const selected = object(data.selectedGift);
    projected = { action, ...fields(data, ['now', 'timeZone', 'totalGifts', 'totalFiles', 'nextOffset']),
      gifts: Array.isArray(data.gifts) ? data.gifts.map(item => fields(item, metadata)) : [],
      files: Array.isArray(data.files) ? data.files.map(item => fields(item, fileKeys)) : [],
      selectedGift: selected ? { ...fields(selected, metadata), ...(selected.revealed === true ? {
        note: range(selected.note), ...fields(selected, ['coverFileId']),
        attachments: Array.isArray(selected.attachments) ? selected.attachments.map(item => fields(item,
          ['attachmentId', 'kind', 'url', 'fileId', 'name', 'mimeType', 'byteSize'])) : [],
      } : {}) } : null,
      htmlSources: Array.isArray(data.htmlSources) ? data.htmlSources.map(item => fields(item,
        ['attachmentId', 'originalId', 'content', 'through', 'total', 'complete'])) : [] };
  } else projected = { action, ...fields(data, ['giftId', 'sender', 'title', 'deliveryStatus', 'receptionStatus', 'attachmentIds',
    'updatedAt', 'scheduledAt', 'scheduledTimeZone', 'deliveredAt', 'openedAt']) };
  const text = JSON.stringify(projected);
  return text.length <= GIFT_TOOL_RESULT_LIMIT ? text : JSON.stringify({ action, ...(giftId ? { giftId } : {}), errorCode: 'gift-tool-result-too-large' });
}

/** The human card is technical status only; private preparation remains inside the actual tool exchange. */
export function projectGiftToolCardResult(result: JunLuoToolResult): JunLuoToolResult {
  if (!isGiftToolId(result.toolId)) return result;
  const data = object(result.data), giftId = safeGiftId(data?.giftId);
  const action = ['view', 'prepare', 'deliver', 'schedule', 'cancel', 'supplement'].includes(String(data?.action)) ? String(data!.action) : result.toolId.slice('gift.'.length);
  const status = result.error?.code === 'TOOL_OUTCOME_UNKNOWN' ? 'outcome_unknown' : result.status;
  const facts = { action, ...(giftId ? { giftId } : {}), status };
  return { ...result, summary: JSON.stringify(facts), data: facts,
    ...(result.error ? { error: { code: result.error.code, message: safeCode(result.error.code) } } : {}) };
}
