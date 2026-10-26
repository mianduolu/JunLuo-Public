import type { JunLuoToolCall, JunLuoToolDefinition, JunLuoToolResult } from '../tools/toolTypes';
import { formatCameraObservationRecallMaterial } from './cameraEvidenceFusion';
import type { CameraObservationCursor, CameraObservationRecordV1 } from './cameraObservationTypes';

export const CAMERA_READ_OBSERVATIONS_TOOL_ID = 'camera.read_observations';

type BookQuery = { observationIds: string[] } | { before?: number; cursor?: CameraObservationCursor };

function parseQuery(input: Record<string, unknown>): BookQuery | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const keys = Object.keys(input);
  if (keys.length > 1 || keys.some((key) => !['before', 'cursor', 'observationIds'].includes(key))) return undefined;
  if (!keys.length) return {};
  if ('observationIds' in input) {
    if (!Array.isArray(input.observationIds) || input.observationIds.length < 1 || input.observationIds.length > 2
      || input.observationIds.some((id) => typeof id !== 'string' || !id.trim())) return undefined;
    return { observationIds: [...new Set(input.observationIds as string[])] };
  }
  if ('before' in input) {
    if (typeof input.before !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(input.before)) return undefined;
    const before = Date.parse(input.before);
    return Number.isFinite(before) ? { before } : undefined;
  }
  if (typeof input.cursor !== 'string') return undefined;
  try {
    const cursor = JSON.parse(input.cursor);
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)
      || Object.keys(cursor).length !== 2 || !Number.isSafeInteger(cursor.capturedAt)
      || cursor.capturedAt < 0 || !Number.isFinite(new Date(cursor.capturedAt).getTime())
      || typeof cursor.observationId !== 'string' || !cursor.observationId.trim()) return undefined;
    return { cursor: { capturedAt: cursor.capturedAt, observationId: cursor.observationId } };
  } catch { return undefined; }
}

async function readObservationBook(call: JunLuoToolCall): Promise<JunLuoToolResult> {
  const startedAt = Date.now();
  const base = { callId: call.callId, toolId: CAMERA_READ_OBSERVATIONS_TOOL_ID, startedAt };
  const failure = (code: 'INVALID_ARGUMENTS' | 'EXECUTION_FAILED'): JunLuoToolResult => ({
    ...base, ok: false, status: 'error', summary: '观察本暂时读取失败。',
    error: { code, message: '观察本暂时读取失败。' }, finishedAt: Date.now(),
  });
  const query = parseQuery(call.input);
  if (!query) return failure('INVALID_ARGUMENTS');
  try {
    const store = await import('./cameraObservationStore');
    if ('observationIds' in query) {
      const rows = await Promise.all(query.observationIds.map((id) => store.getCameraObservationRecord(id)));
      const records = rows.filter((row): row is CameraObservationRecordV1 => !!row);
      return {
        ...base, ok: true, status: 'success', summary: '观察记录', finishedAt: Date.now(),
        data: {
          observationIds: records.map((record) => record.observationId),
          missingObservationIds: query.observationIds.filter((_, index) => !rows[index]),
          material: formatCameraObservationRecallMaterial(records),
        },
      };
    }
    const page = await store.listCameraObservations({ ...query, limit: 5 });
    return {
      ...base, ok: true, status: 'success', summary: '观察本目录', finishedAt: Date.now(),
      data: {
        records: page.records.map((record) => ({
          observationId: record.observationId,
          capturedAt: new Date(record.capturedAt).toISOString(),
          sourceKind: record.sourceKind,
          frameUsability: record.frameUsability,
          sceneSummary: record.sceneSummary.length > 180 ? `${record.sceneSummary.slice(0, 179)}…` : record.sceneSummary,
        })),
        ...(page.nextCursor ? { nextCursor: JSON.stringify(page.nextCursor) } : {}),
      },
    };
  } catch { return failure('EXECUTION_FAILED'); }
}

export const cameraReadObservationsTool: JunLuoToolDefinition = {
  id: CAMERA_READ_OBSERVATIONS_TOOL_ID,
  packageId: 'camera',
  name: '翻观察本',
  description: 'I 可以翻看过去真实保存的摄像头观察，先按拍摄时间查看目录，再打开其中的记录，结合眼前的对话理解。',
  inputSchema: {
    type: 'object', additionalProperties: false,
    properties: {
      before: { type: 'string', description: '查看这个时间之前的观察目录，使用带时区的时间；省略时从最新记录开始。' },
      cursor: { type: 'string', description: '继续翻页时，原样使用上次目录返回的游标。' },
      observationIds: {
        type: 'array', items: { type: 'string' },
        description: '要打开的观察记录编号，最多两个；填写后直接读取这些记录。',
      },
    },
  },
  permission: 'allow', riskLevel: 'read', readOnly: true,
  chatExposure: 'candidate', proactiveEligible: true, executionScope: 'local_device',
  agentEpochMode: 'read_only_outside_lease', executor: readObservationBook,
};
