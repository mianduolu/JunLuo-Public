import type { ModelPurposeId } from '../ai/modelPurposeRegistry';

export type MemoryModelLaneId = 'organizer' | 'reranker' | 'embedding';

export type MemoryModelBoundary = {
  id: MemoryModelLaneId;
  label: string;
  purposeId?: ModelPurposeId;
  connectionSource: string;
  interfaceKind: 'chat-completions' | 'embeddings';
  responsibilities: readonly string[];
  notResponsibilities: readonly string[];
  fallbackPolicy: string;
};

export const memoryModelBoundaries: readonly MemoryModelBoundary[] = [
  {
    id: 'organizer',
    label: '记忆整理模型',
    purposeId: 'memoryOrganizer',
    connectionSource: 'memoryOrganizerConnection / memoryOrganizerKey',
    interfaceKind: 'chat-completions',
    responsibilities: [
      '从聊天和生活材料中提取候选记忆',
      '生成阶段记忆、白云反思、行动候选和导入历史整理结果',
      '为手动新建或编辑记忆补充连续性材料',
    ],
    notResponsibilities: [
      '不负责从候选记忆中排序召回结果',
      '不负责生成 embedding 向量',
      '不负责白云主聊天回复',
    ],
    fallbackPolicy: '用户主动整理记忆时必须配置；上下文压缩可在缺失时回退聊天模型。',
  },
  {
    id: 'reranker',
    label: '记忆重排模型',
    purposeId: 'memoryReranker',
    connectionSource: 'memoryRerankerConnection / memoryRerankerKey',
    interfaceKind: 'chat-completions',
    responsibilities: [
      '本地召回已经给出候选后，从候选里挑出最适合当前对话的记忆',
      '只返回候选记忆 ID，不新建、不改写、不总结记忆',
      '在候选过多时帮助降低主聊天上下文噪音',
    ],
    notResponsibilities: [
      '不负责提取新记忆',
      '不负责长上下文摘要',
      '不负责向量检索和相似度计算',
    ],
    fallbackPolicy: '可关闭；未配置、失败或超时时自动使用本地排序。',
  },
  {
    id: 'embedding',
    label: '语义向量接口',
    connectionSource: 'memoryEmbedding settings / embedding API key',
    interfaceKind: 'embeddings',
    responsibilities: [
      '把记忆文本转成向量',
      '支持语义召回和相似度排序',
      '为记忆详情页显示单条记忆的向量索引状态',
    ],
    notResponsibilities: [
      '不生成自然语言回复',
      '不整理或改写记忆正文',
      '不承担聊天补全模型职责',
    ],
    fallbackPolicy: '可关闭；缺失时继续使用全文检索、中文匹配、钉住和关系召回。',
  },
] as const;

export const memoryModelBoundaryByLane = Object.fromEntries(
  memoryModelBoundaries.map((boundary) => [boundary.id, boundary]),
) as Record<MemoryModelLaneId, MemoryModelBoundary>;

export function getMemoryModelBoundary(id: MemoryModelLaneId) {
  return memoryModelBoundaryByLane[id];
}