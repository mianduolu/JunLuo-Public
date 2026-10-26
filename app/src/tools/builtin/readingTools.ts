import { createToolError } from '../toolErrors';
import { createToolErrorResult, createToolSuccessResult } from '../toolResult';
import type { JunLuoToolCall, JunLuoToolDefinition, JunLuoToolPackage, JunLuoToolResult } from '../toolTypes';
import type { ReadingBook } from '../../reading/readingTypes';
import { interleaveReadingItems, programmePreparationText, readingProgressText } from '../../reading/readingProgrammePolicy';

type ReadingShelfData = { subject: string; books: Array<{ bookId: string; title: string; author?: string; readingProgress: string }>;
  episodes: Array<{ episodeId: string; title: string; series: string; preparationText: string; readingProgress: string }>; nextCursor: string | null };
export function readingShelfResult(call: JunLuoToolCall, books: ReadingBook[], capacity = 11000): JunLuoToolResult<ReadingShelfData> {
  books = interleaveReadingItems(books);
  // Cursor binds the actual shelf order, not a title guessed by the model.
  const signature = books.reduce((hash, book) => {
    for (const character of JSON.stringify([book.id, book.title, book.author])) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
    return hash >>> 0;
  }, 2166136261).toString(36);
  let index = 0;
  if (call.input.cursor !== undefined) {
    const match = typeof call.input.cursor === 'string' && /^(\w+):(\d+)$/.exec(call.input.cursor);
    if (!match || match[1] !== signature || !Number.isSafeInteger(Number(match[2])) || Number(match[2]) >= books.length) {
      return createToolErrorResult(call, createToolError('INVALID_ARGUMENTS', 'reading-cursor-invalid'), '阅读清单分页位置已失效。');
    }
    index = Number(match[2]);
  }
  const items: Array<{ bookId: string; title: string; author?: string; readingProgress: string }> = [];
  const episodes: ReadingShelfData['episodes'] = [];
  const result = () => createToolSuccessResult(call, books.length ? '阅读清单已读取。' : '阅读清单里还没有内容。', {
    subject: 'I', books: items, episodes, nextCursor: index < books.length ? `${signature}:${index}` : null,
  });
  while (index < books.length && items.length + episodes.length < 10) {
    const book = books[index];
    if (book.programme) episodes.push({ episodeId: book.id, title: book.title, series: book.programme.series,
      preparationText: programmePreparationText(book), readingProgress: readingProgressText(book) });
    else items.push({ bookId: book.id, title: book.title, ...(book.author ? { author: book.author } : {}), readingProgress: readingProgressText(book) });
    index += 1;
    if (JSON.stringify(result()).length > capacity) { if (book.programme) episodes.pop(); else items.pop(); index -= 1; break; }
  }
  if (books.length && !items.length && !episodes.length) return createToolErrorResult(call,
    createToolError('EXECUTION_FAILED', 'reading-shelf-item-too-large'), '这条阅读材料信息超出本轮可返回容量。');
  return result();
}

export const readingListTool: JunLuoToolDefinition = {
  id: 'reading.list', packageId: 'reading', name: '挑点想看的',
  description: '查看书架和节目单，以及 I 已保存的阅读进度。',
  inputSchema: { type: 'object', additionalProperties: false, properties: {
    cursor: { type: 'string', description: '接着上一页查看时，填写上次返回的 nextCursor；首次查看不填。' },
  } },
  permission: 'allow', riskLevel: 'read', readOnly: true, chatExposure: 'internal_only',
  proactiveEligible: false, agentEpochMode: 'read_only_outside_lease',
  executor: async call => {
    if (call.requestedBy === 'chat') return createToolErrorResult(call, createToolError('PERMISSION_DENIED', 'reading-catalog-not-in-chat'), '');
    try { return readingShelfResult(call, await (await import('../../reading/readingStore')).loadReadingLibraryStrict()); }
    catch { return createToolErrorResult(call, createToolError('EXECUTION_FAILED', 'reading-shelf-unavailable'), '阅读清单暂时无法读取。'); }
  },
};
export const readingControlTool: JunLuoToolDefinition = {
  id: 'reading.control', packageId: 'reading', name: '安排这次阅读',
  description: '开始、暂停、继续或结束 I 这次的阅读。\n\n开始阅读时，选择一本书或一期节目，并记下这次想读多久。',
  inputSchema: { type: 'object', additionalProperties: false, required: ['action'], properties: {
    action: { type: 'string', enum: ['start', 'pause', 'resume', 'end'], description: '这次要开始、暂停、继续还是结束阅读：start、pause、resume、end。' },
    bookId: { type: 'string', description: '开始阅读时，填写从书架查到的书籍编号。' },
    episodeId: { type: 'string', description: '开始阅读节目时，填写从节目单查到的节目编号。' },
    minutes: { type: 'number', description: '开始阅读时，填写这次想读多少分钟。暂停和休息不计入。' },
  } },
  permission: 'allow', riskLevel: 'write_local', readOnly: false, chatExposure: 'candidate',
  proactiveEligible: false, executionScope: 'local_device', agentEpochMode: 'bounded_local_commits',
  executor: (call, context) => {
    if (call.requestedBy !== 'chat' || !context?.readingControl) return createToolErrorResult(call,
      createToolError('PERMISSION_DENIED', 'reading-chat-host-required'), '');
    return context.readingControl(call);
  },
};
export const readingReadMaterialTool: JunLuoToolDefinition = {
  id: 'reading.read_material', packageId: 'reading', name: '翻阅读材料',
  description: '查看 you 带进聊天的书籍正文或节目文字稿。可以从头翻看，也可以查找原文中的词句。只查看内容，不改变阅读进度。',
  inputSchema: { type: 'object', additionalProperties: false, required: ['readingId'], properties: {
    readingId: { type: 'string', description: '填写阅读卡片里的作品编号。' },
    keyword: { type: 'string', description: '查找内容时，填写原文中的词句；从头翻看时省略。' },
    cursor: { type: 'string', description: '接着上次的位置查看时，填写上次返回的 nextCursor，并省略 keyword。' },
  } },
  permission: 'allow', riskLevel: 'read', readOnly: true, chatExposure: 'candidate',
  proactiveEligible: false, executionScope: 'local_device', agentEpochMode: 'read_only_outside_lease',
  executor: (call, context) => {
    if (call.requestedBy !== 'chat' || !context?.readingMaterial) return createToolErrorResult(call,
      createToolError('PERMISSION_DENIED', 'reading-chat-reference-required'), '');
    return context.readingMaterial(call);
  },
};
export const readingToolPackage: JunLuoToolPackage = {
  id: 'reading', name: '阅读', description: [readingListTool.description, readingControlTool.description].join('\n\n'),
  category: 'life', tools: [readingListTool, readingControlTool, readingReadMaterialTool], defaultEnabled: true, riskLevel: 'write_local', source: 'builtin',
};
