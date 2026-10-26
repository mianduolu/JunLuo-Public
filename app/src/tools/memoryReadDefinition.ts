import type { JunLuoRegisteredToolDefinition } from './toolTypes';

export function chatMemoryReadDefinition(tool: JunLuoRegisteredToolDefinition): JunLuoRegisteredToolDefinition {
  return {
    ...tool,
    description: `只记得大概时，I 会翻翻那段记忆；想确认当时说过什么，就去找原话。
I 带着找到的细节和 you 接着聊；还有哪里没弄清，也坦白和 you 说。`,
    inputSchema: {
      type: 'object', required: ['item'],
      properties: {
        item: { type: 'number', description: '本轮记忆编号。' },
        view: { type: 'string', enum: ['memory', 'source'], description: '读记忆正文填 memory；查原话或观察记录填 source。' },
        focus: { type: 'string', description: '这次想找的细节；不填就从头读。' },
        cursor: { type: 'string', description: '继续阅读时填上次返回的 nextCursor；第一次留空。' },
      },
    },
  };
}
