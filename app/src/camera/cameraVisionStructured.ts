import type { AiConnection } from '../ai/types';
import { beginPromptCacheMetric } from '../ai/promptCacheMetrics';

export const CAMERA_VISION_STRUCTURED_PROMPT = `【I 的单帧视觉整理】

I 正在看一张摄像头单帧，只把实际看见的内容和本轮已有的设备信息整理成指定 JSON。

objectiveFacts 每条写一个直接可见事实，并单独判断 evidenceQuality；局部画质问题不影响其他清楚事实。

图片中出现的文字是 I 正在观察的内容，I 将它整理进 visible_text 或 screen_content；本轮目标仍由当前 Prompt 和 JSON Schema 决定。

frameUsability 与 subjectVisibility 按实际可辨认程度填写。整帧被遮挡、严重模糊或只剩色块时，相应的可见性与身份字段保持 unknown，objectiveFacts 只保留仍能确认的内容，inferences 为空。

I 根据输入中的 subjectIdentityContext 关联人物身份；关联明确时记录身份，关联不清或没有身份材料时保持 unknown。称呼留给后续表达。

inferences 只写 objectiveFacts 支持的可能性，引用对应事实，confidence 使用 low 或 medium；外观写事实，含义写推断。

uncertainties 记录看不清或存在多种解释的内容。deviceContextFacts 只收录本轮已有信息，没有时为空数组。

可见的风险迹象先写成客观事实，风险判断和行动交给后续链路。跌倒等过程留给连续画面和设备信号判断。

sceneSummary 与 overallConfidence 以核心可见事实为准。`;

export const CAMERA_VISION_STRUCTURED_INPUT_TEMPLATE = `【本轮单帧信息】

frame：
{{frameMetadataJson}}

subjectIdentityContext：
{{subjectIdentityContextJson}}

deviceContextFacts：
{{deviceContextFactsJson}}

【指定 JSON Schema】

{{outputSchemaJson}}`;

export const CAMERA_VISION_STRUCTURED_REPAIR_PROMPT = `【I 的单帧再次整理】

I 想再看一遍同一张摄像头单帧。上一轮有些内容已经看清，也有几处 I 想再确认。

I 看着下面的线索，结合图片、本轮设备信息和身份材料重新判断。I 保留自己仍然看得确实的内容，修正或补齐其余部分，最后把完整结果整理成指定 JSON。

【I 已经看清的部分】

{{acceptedPartsText}}

【I 想再确认的地方】

{{validationIssuesText}}

【I 上一轮的整理】

{{previousOutput}}`;

export type CameraVisionFrameMetadataV1 = {
  sourceKind: 'android_front' | 'android_back' | 'pc_webcam' | 'selected_test_image';
  width: number;
  height: number;
  rotation: 0 | 90 | 180 | 270;
  mirrored: boolean;
};

export type CameraSubjectIdentityContextV1 = { status: 'unknown' };

export type CameraVisionDeviceContextFactV1 = {
  factId: `device_${number}`;
  kind: 'time' | 'location' | 'weather' | 'device_activity' | 'other';
  text: string;
  observedAt: number;
};

export type CameraVisionStructuredResultV1 = {
  schemaVersion: 1;
  frameUsability: 'clear' | 'limited' | 'unusable';
  subjectVisibility: {
    status: 'none' | 'unknown' | 'visible';
    visibleCount: number | null;
    subjects: Array<{
      subjectRef: `person_${number}`;
      bodyVisibility: 'not_visible' | 'unknown' | 'partial' | 'clear';
      faceVisibility: 'not_visible' | 'unknown' | 'partial' | 'clear';
    }>;
  };
  subjectIdentities: Array<{
    subjectRef: `person_${number}`;
    identity: 'you';
    basis: 'manual_identity_marker' | 'on_device_face_match';
  }>;
  objectiveFacts: Array<{
    factId: `fact_${number}`;
    category: 'person' | 'animal' | 'object' | 'environment' | 'visible_text' | 'screen_content' | 'visible_risk_signal';
    subjectRef: `person_${number}` | null;
    text: string;
    evidenceQuality: 'clear' | 'recognizable' | 'partial';
  }>;
  inferences: Array<{
    inferenceId: `inference_${number}`;
    category: 'posture' | 'expression' | 'activity' | 'scene_relation' | 'other';
    subjectRef: `person_${number}` | null;
    text: string;
    evidenceFactIds: Array<`fact_${number}`>;
    confidence: 'low' | 'medium';
  }>;
  uncertainties: Array<{
    uncertaintyId: `uncertainty_${number}`;
    text: string;
    relatedFactIds: Array<`fact_${number}`>;
  }>;
  deviceContextFacts: CameraVisionDeviceContextFactV1[];
  sceneSummary: string;
  overallConfidence: 'low' | 'medium' | 'high';
};

export type CameraVisionAnalysisSuccessV1 = {
  result: CameraVisionStructuredResultV1;
  attemptCount: 1 | 2;
  repairUsed: boolean;
  responseFormatRequested: boolean;
  provider: string;
  model: string;
  latencyMs: number;
};

export const CAMERA_VISION_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'frameUsability', 'subjectVisibility', 'subjectIdentities', 'objectiveFacts', 'inferences', 'uncertainties', 'deviceContextFacts', 'sceneSummary', 'overallConfidence'],
  properties: {
    schemaVersion: { const: 1 },
    frameUsability: { enum: ['clear', 'limited', 'unusable'] },
    subjectVisibility: {
      type: 'object',
      additionalProperties: false,
      required: ['status', 'visibleCount', 'subjects'],
      properties: {
        status: { enum: ['none', 'unknown', 'visible'] },
        visibleCount: { type: ['integer', 'null'], minimum: 0, maximum: 8 },
        subjects: {
          type: 'array', maxItems: 8,
          items: {
            type: 'object', additionalProperties: false,
            required: ['subjectRef', 'bodyVisibility', 'faceVisibility'],
            properties: {
              subjectRef: { type: 'string', pattern: '^person_[0-9]+$' },
              bodyVisibility: { enum: ['not_visible', 'unknown', 'partial', 'clear'] },
              faceVisibility: { enum: ['not_visible', 'unknown', 'partial', 'clear'] },
            },
          },
        },
      },
    },
    subjectIdentities: {
      type: 'array', maxItems: 8,
      items: {
        type: 'object', additionalProperties: false,
        required: ['subjectRef', 'identity', 'basis'],
        properties: {
          subjectRef: { type: 'string', pattern: '^person_[0-9]+$' },
          identity: { const: 'you' },
          basis: { enum: ['manual_identity_marker', 'on_device_face_match'] },
        },
      },
    },
    objectiveFacts: {
      type: 'array', maxItems: 24,
      items: {
        type: 'object', additionalProperties: false,
        required: ['factId', 'category', 'subjectRef', 'text', 'evidenceQuality'],
        properties: {
          factId: { type: 'string', pattern: '^fact_[0-9]+$' },
          category: { enum: ['person', 'animal', 'object', 'environment', 'visible_text', 'screen_content', 'visible_risk_signal'] },
          subjectRef: { type: ['string', 'null'], pattern: '^person_[0-9]+$' },
          text: { type: 'string', minLength: 1, maxLength: 160 },
          evidenceQuality: { enum: ['clear', 'recognizable', 'partial'] },
        },
      },
    },
    inferences: {
      type: 'array', maxItems: 8,
      items: {
        type: 'object', additionalProperties: false,
        required: ['inferenceId', 'category', 'subjectRef', 'text', 'evidenceFactIds', 'confidence'],
        properties: {
          inferenceId: { type: 'string', pattern: '^inference_[0-9]+$' },
          category: { enum: ['posture', 'expression', 'activity', 'scene_relation', 'other'] },
          subjectRef: { type: ['string', 'null'], pattern: '^person_[0-9]+$' },
          text: { type: 'string', minLength: 1, maxLength: 160 },
          evidenceFactIds: { type: 'array', minItems: 1, items: { type: 'string', pattern: '^fact_[0-9]+$' } },
          confidence: { enum: ['low', 'medium'] },
        },
      },
    },
    uncertainties: {
      type: 'array', maxItems: 8,
      items: {
        type: 'object', additionalProperties: false,
        required: ['uncertaintyId', 'text', 'relatedFactIds'],
        properties: {
          uncertaintyId: { type: 'string', pattern: '^uncertainty_[0-9]+$' },
          text: { type: 'string', minLength: 1, maxLength: 160 },
          relatedFactIds: { type: 'array', items: { type: 'string', pattern: '^fact_[0-9]+$' } },
        },
      },
    },
    deviceContextFacts: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['factId', 'kind', 'text', 'observedAt'],
        properties: {
          factId: { type: 'string', pattern: '^device_[0-9]+$' },
          kind: { enum: ['time', 'location', 'weather', 'device_activity', 'other'] },
          text: { type: 'string' },
          observedAt: { type: 'number' },
        },
      },
    },
    sceneSummary: { type: 'string', minLength: 1, maxLength: 240 },
    overallConfidence: { enum: ['low', 'medium', 'high'] },
  },
} as const;

export type CameraVisionValidationIssue = {
  code: string;
  path: string;
  message: string;
};

export type CameraVisionValidationResult =
  | { success: true; result: CameraVisionStructuredResultV1; issues: [] }
  | { success: false; issues: CameraVisionValidationIssue[]; acceptedPartsText: string };

export type CameraVisionValidationContextV1 = {
  subjectIdentityContext: CameraSubjectIdentityContextV1;
  deviceContextFacts: readonly CameraVisionDeviceContextFactV1[];
};

type CameraVisionFrameInput =
  | { frame: CameraVisionFrameMetadataV1; frameMetadata?: never }
  | { frame?: never; frameMetadata: CameraVisionFrameMetadataV1 };

export type CameraVisionTransportDiagnostic = {
  transport: 'xhr_sse';
  attemptNumber: 1 | 2;
  responseFormatRequested: boolean;
  elapsedMs: number;
  stage: 'request_started' | 'streaming' | 'completed' | 'network_error' | 'aborted';
  httpStatus: number | null;
  progressEventCount: number;
  dataEventCount: number;
  contentEventCount: number;
  reasoningEventCount: number;
  contentCharacterCount: number;
  responseCharacterCount: number;
  doneReceived: boolean;
  malformed: boolean;
};

export type AnalyzeCameraFrameStructuredOptions = CameraVisionValidationContextV1 & CameraVisionFrameInput & {
  apiKey: string;
  connection: AiConnection;
  imageDataUrl: string;
  mimeType?: string;
  debugForceFirstAttemptInvalid?: boolean;
  onRepairStarted?: (issueCodes: readonly string[]) => void;
  onValidationFailed?: (
    attemptNumber: 1 | 2,
    issues: readonly CameraVisionValidationIssue[],
  ) => void;
  onTransportDiagnostic?: (diagnostic: CameraVisionTransportDiagnostic) => void;
  /** Optional owning-tool hooks; manual observations keep their existing policy. */
  beforeAttempt?: (attemptNumber: 1 | 2) => Promise<void>;
  attemptTimeoutMs?: number;
  signal?: AbortSignal;
};

export type CameraVisionStructuredErrorCode =
  | 'camera_vision_json_mode_unsupported'
  | 'camera_vision_schema_invalid'
  | 'camera_vision_repair_failed'
  | 'camera_vision_identity_context_mismatch'
  | 'camera_vision_device_context_mismatch'
  | 'camera_vision_request_failed'
  | 'camera_vision_timeout'
  | 'camera_vision_cancelled';

const CAMERA_VISION_REQUEST_TIMEOUT_MS = 240_000;
const CAMERA_VISION_NO_RESPONSE_TIMEOUT_MS = 120_000;
const CAMERA_VISION_STREAMING_DIAGNOSTIC_INTERVAL_MS = 500;
const CAMERA_VISION_PREVIOUS_OUTPUT_MAX_BYTES = 16 * 1024;
const SUBJECT_REF_PATTERN = /^person_[0-9]+$/u;
const FACT_ID_PATTERN = /^fact_[0-9]+$/u;
const INFERENCE_ID_PATTERN = /^inference_[0-9]+$/u;
const UNCERTAINTY_ID_PATTERN = /^uncertainty_[0-9]+$/u;
const DEVICE_FACT_ID_PATTERN = /^device_[0-9]+$/u;
const ROOT_FIELDS = [
  'schemaVersion',
  'frameUsability',
  'subjectVisibility',
  'subjectIdentities',
  'objectiveFacts',
  'inferences',
  'uncertainties',
  'deviceContextFacts',
  'sceneSummary',
  'overallConfidence',
] as const;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function addIssue(
  issues: CameraVisionValidationIssue[],
  code: string,
  path: string,
  message: string,
) {
  issues.push({ code, path, message });
}

function exactRecord(
  value: unknown,
  fields: readonly string[],
  path: string,
  issues: CameraVisionValidationIssue[],
): JsonRecord | undefined {
  if (!isRecord(value)) {
    addIssue(issues, 'invalid_type', path, '应为对象');
    return undefined;
  }
  const allowed = new Set(fields);
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) {
      addIssue(issues, 'missing_field', `${path}.${field}`, '字段缺失');
    }
  }
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) addIssue(issues, 'extra_field', `${path}.${field}`, '不允许额外字段');
  }
  return value;
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

function validateEnum(
  value: unknown,
  allowed: readonly string[],
  path: string,
  issues: CameraVisionValidationIssue[],
) {
  if (!isOneOf(value, allowed)) addIssue(issues, 'invalid_value', path, '值不符合约定');
}

function characterCount(value: string) {
  let count = 0;
  for (const _character of value) count += 1;
  return count;
}

function validateText(
  value: unknown,
  maxCharacters: number | undefined,
  path: string,
  issues: CameraVisionValidationIssue[],
) {
  if (typeof value !== 'string') {
    addIssue(issues, 'invalid_type', path, '应为文字');
    return;
  }
  if (!value.trim()) addIssue(issues, 'empty_text', path, '文字不能为空');
  if (maxCharacters !== undefined && characterCount(value) > maxCharacters) {
    addIssue(issues, 'too_long', path, `文字超过 ${maxCharacters} 字`);
  }
}

function validatePattern(
  value: unknown,
  pattern: RegExp,
  path: string,
  issues: CameraVisionValidationIssue[],
) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    addIssue(issues, 'invalid_value', path, 'ID 格式错误');
    return undefined;
  }
  return value;
}

function validateArray(
  value: unknown,
  path: string,
  issues: CameraVisionValidationIssue[],
  maxItems?: number,
): unknown[] | undefined {
  if (!Array.isArray(value)) {
    addIssue(issues, 'invalid_type', path, '应为数组');
    return undefined;
  }
  if (maxItems !== undefined && value.length > maxItems) {
    addIssue(issues, 'too_many', path, `最多 ${maxItems} 项`);
  }
  return value;
}

function addUniqueId(
  ids: Set<string>,
  id: string | undefined,
  path: string,
  issues: CameraVisionValidationIssue[],
) {
  if (id === undefined) return;
  if (ids.has(id)) addIssue(issues, 'duplicate_id', path, 'ID 必须唯一');
  ids.add(id);
}

function deviceFactsEqual(
  actual: unknown[] | undefined,
  expected: readonly CameraVisionDeviceContextFactV1[],
) {
  if (!actual || actual.length !== expected.length) return false;
  return actual.every((value, index) => {
    const expectedFact = expected[index];
    if (!isRecord(value) || !expectedFact) return false;
    const keys = Object.keys(value);
    return keys.length === 4
      && keys.every((key) => ['factId', 'kind', 'text', 'observedAt'].includes(key))
      && value.factId === expectedFact.factId
      && value.kind === expectedFact.kind
      && value.text === expectedFact.text
      && value.observedAt === expectedFact.observedAt;
  });
}

function issueTouchesRoot(issue: CameraVisionValidationIssue, root: string) {
  const rootPath = `$.${root}`;
  return issue.path === rootPath || issue.path.startsWith(`${rootPath}.`) || issue.path.startsWith(`${rootPath}[`);
}

export function buildCameraVisionAcceptedPartsText(
  value: unknown,
  issues: readonly CameraVisionValidationIssue[],
) {
  if (!isRecord(value)) return '（暂无可安全保留的部分）';
  const accepted: JsonRecord = {};
  for (const field of ROOT_FIELDS) {
    if (
      Object.prototype.hasOwnProperty.call(value, field)
      && !issues.some((issue) => issueTouchesRoot(issue, field))
    ) {
      accepted[field] = value[field];
    }
  }
  return Object.keys(accepted).length > 0
    ? JSON.stringify(accepted)
    : '（暂无可安全保留的部分）';
}

export function validateCameraVisionStructuredResult(
  value: unknown,
  context: CameraVisionValidationContextV1 = {
    subjectIdentityContext: { status: 'unknown' },
    deviceContextFacts: [],
  },
): CameraVisionValidationResult {
  const issues: CameraVisionValidationIssue[] = [];
  const root = exactRecord(value, ROOT_FIELDS, '$', issues);
  if (!root) return { success: false, issues, acceptedPartsText: '（暂无可安全保留的部分）' };

  if (root.schemaVersion !== 1) addIssue(issues, 'invalid_value', '$.schemaVersion', '必须为 1');
  validateEnum(root.frameUsability, ['clear', 'limited', 'unusable'], '$.frameUsability', issues);

  const subjectRefs = new Set<string>();
  const visibility = exactRecord(
    root.subjectVisibility,
    ['status', 'visibleCount', 'subjects'],
    '$.subjectVisibility',
    issues,
  );
  let subjects: unknown[] | undefined;
  if (visibility) {
    validateEnum(visibility.status, ['none', 'unknown', 'visible'], '$.subjectVisibility.status', issues);
    const count = visibility.visibleCount;
    if (count !== null && (!Number.isInteger(count) || (count as number) < 0 || (count as number) > 8)) {
      addIssue(issues, 'invalid_value', '$.subjectVisibility.visibleCount', '人数应为 0..8 或 null');
    }
    subjects = validateArray(visibility.subjects, '$.subjectVisibility.subjects', issues, 8);
    for (const [index, subjectValue] of (subjects ?? []).entries()) {
      const path = `$.subjectVisibility.subjects[${index}]`;
      const subject = exactRecord(subjectValue, ['subjectRef', 'bodyVisibility', 'faceVisibility'], path, issues);
      if (!subject) continue;
      const subjectRef = validatePattern(subject.subjectRef, SUBJECT_REF_PATTERN, `${path}.subjectRef`, issues);
      addUniqueId(subjectRefs, subjectRef, `${path}.subjectRef`, issues);
      validateEnum(subject.bodyVisibility, ['not_visible', 'unknown', 'partial', 'clear'], `${path}.bodyVisibility`, issues);
      validateEnum(subject.faceVisibility, ['not_visible', 'unknown', 'partial', 'clear'], `${path}.faceVisibility`, issues);
    }
    if (visibility.status === 'none' && (count !== 0 || (subjects?.length ?? -1) !== 0)) {
      addIssue(issues, 'visibility_mismatch', '$.subjectVisibility', 'none 必须对应 0 人');
    }
    if (visibility.status === 'unknown' && (count !== null || (subjects?.length ?? -1) !== 0)) {
      addIssue(issues, 'visibility_mismatch', '$.subjectVisibility', 'unknown 必须对应 null');
    }
    if (
      visibility.status === 'visible'
      && (!Number.isInteger(count) || (count as number) < 1 || (count as number) > 8 || subjects?.length !== count)
    ) {
      addIssue(issues, 'visibility_mismatch', '$.subjectVisibility', 'visible 人数须为 1..8 并匹配主体');
    }
  }

  const identities = validateArray(root.subjectIdentities, '$.subjectIdentities', issues, 8);
  const identitySubjectRefs = new Set<string>();
  for (const [index, identityValue] of (identities ?? []).entries()) {
    const path = `$.subjectIdentities[${index}]`;
    const identity = exactRecord(identityValue, ['subjectRef', 'identity', 'basis'], path, issues);
    if (!identity) continue;
    const subjectRef = validatePattern(identity.subjectRef, SUBJECT_REF_PATTERN, `${path}.subjectRef`, issues);
    addUniqueId(identitySubjectRefs, subjectRef, `${path}.subjectRef`, issues);
    if (subjectRef && !subjectRefs.has(subjectRef)) {
      addIssue(issues, 'invalid_reference', `${path}.subjectRef`, '主体引用不存在');
    }
    if (identity.identity !== 'you') addIssue(issues, 'invalid_value', `${path}.identity`, '身份必须为 you');
    validateEnum(identity.basis, ['manual_identity_marker', 'on_device_face_match'], `${path}.basis`, issues);
  }
  if (context.subjectIdentityContext.status === 'unknown' && (identities?.length ?? 0) !== 0) {
    addIssue(issues, 'identity_context_mismatch', '$.subjectIdentities', '未知身份材料必须留空');
  }

  const facts = validateArray(root.objectiveFacts, '$.objectiveFacts', issues, 24);
  const factIds = new Set<string>();
  const factQualityById = new Map<string, string>();
  for (const [index, factValue] of (facts ?? []).entries()) {
    const path = `$.objectiveFacts[${index}]`;
    const fact = exactRecord(factValue, ['factId', 'category', 'subjectRef', 'text', 'evidenceQuality'], path, issues);
    if (!fact) continue;
    const factId = validatePattern(fact.factId, FACT_ID_PATTERN, `${path}.factId`, issues);
    addUniqueId(factIds, factId, `${path}.factId`, issues);
    validateEnum(
      fact.category,
      ['person', 'animal', 'object', 'environment', 'visible_text', 'screen_content', 'visible_risk_signal'],
      `${path}.category`,
      issues,
    );
    if (fact.subjectRef !== null) {
      const subjectRef = validatePattern(fact.subjectRef, SUBJECT_REF_PATTERN, `${path}.subjectRef`, issues);
      if (subjectRef && !subjectRefs.has(subjectRef)) {
        addIssue(issues, 'invalid_reference', `${path}.subjectRef`, '主体引用不存在');
      }
    }
    validateText(fact.text, 160, `${path}.text`, issues);
    validateEnum(fact.evidenceQuality, ['clear', 'recognizable', 'partial'], `${path}.evidenceQuality`, issues);
    if (factId && isOneOf(fact.evidenceQuality, ['clear', 'recognizable', 'partial'])) {
      factQualityById.set(factId, fact.evidenceQuality);
    }
  }

  const inferences = validateArray(root.inferences, '$.inferences', issues, 8);
  const inferenceIds = new Set<string>();
  for (const [index, inferenceValue] of (inferences ?? []).entries()) {
    const path = `$.inferences[${index}]`;
    const inference = exactRecord(
      inferenceValue,
      ['inferenceId', 'category', 'subjectRef', 'text', 'evidenceFactIds', 'confidence'],
      path,
      issues,
    );
    if (!inference) continue;
    const inferenceId = validatePattern(inference.inferenceId, INFERENCE_ID_PATTERN, `${path}.inferenceId`, issues);
    addUniqueId(inferenceIds, inferenceId, `${path}.inferenceId`, issues);
    validateEnum(inference.category, ['posture', 'expression', 'activity', 'scene_relation', 'other'], `${path}.category`, issues);
    if (inference.subjectRef !== null) {
      const subjectRef = validatePattern(inference.subjectRef, SUBJECT_REF_PATTERN, `${path}.subjectRef`, issues);
      if (subjectRef && !subjectRefs.has(subjectRef)) {
        addIssue(issues, 'invalid_reference', `${path}.subjectRef`, '主体引用不存在');
      }
    }
    validateText(inference.text, 160, `${path}.text`, issues);
    const evidenceIds = validateArray(inference.evidenceFactIds, `${path}.evidenceFactIds`, issues);
    if (evidenceIds && evidenceIds.length === 0) {
      addIssue(issues, 'missing_evidence', `${path}.evidenceFactIds`, '至少引用一条事实');
    }
    const seenEvidenceIds = new Set<string>();
    let citesPartialEvidence = false;
    for (const [evidenceIndex, evidenceValue] of (evidenceIds ?? []).entries()) {
      const evidencePath = `${path}.evidenceFactIds[${evidenceIndex}]`;
      const evidenceId = validatePattern(evidenceValue, FACT_ID_PATTERN, evidencePath, issues);
      addUniqueId(seenEvidenceIds, evidenceId, evidencePath, issues);
      if (evidenceId && !factIds.has(evidenceId)) {
        addIssue(issues, 'invalid_reference', evidencePath, '事实引用不存在');
      }
      if (evidenceId && factQualityById.get(evidenceId) === 'partial') citesPartialEvidence = true;
    }
    validateEnum(inference.confidence, ['low', 'medium'], `${path}.confidence`, issues);
    if (inference.confidence === 'medium' && citesPartialEvidence) {
      addIssue(issues, 'inference_evidence_quality', `${path}.confidence`, 'medium 不能引用 partial');
    }
  }

  const uncertainties = validateArray(root.uncertainties, '$.uncertainties', issues, 8);
  const uncertaintyIds = new Set<string>();
  for (const [index, uncertaintyValue] of (uncertainties ?? []).entries()) {
    const path = `$.uncertainties[${index}]`;
    const uncertainty = exactRecord(uncertaintyValue, ['uncertaintyId', 'text', 'relatedFactIds'], path, issues);
    if (!uncertainty) continue;
    const uncertaintyId = validatePattern(uncertainty.uncertaintyId, UNCERTAINTY_ID_PATTERN, `${path}.uncertaintyId`, issues);
    addUniqueId(uncertaintyIds, uncertaintyId, `${path}.uncertaintyId`, issues);
    validateText(uncertainty.text, 160, `${path}.text`, issues);
    const relatedIds = validateArray(uncertainty.relatedFactIds, `${path}.relatedFactIds`, issues);
    const seenRelatedIds = new Set<string>();
    for (const [relatedIndex, relatedValue] of (relatedIds ?? []).entries()) {
      const relatedPath = `${path}.relatedFactIds[${relatedIndex}]`;
      const relatedId = validatePattern(relatedValue, FACT_ID_PATTERN, relatedPath, issues);
      addUniqueId(seenRelatedIds, relatedId, relatedPath, issues);
      if (relatedId && !factIds.has(relatedId)) {
        addIssue(issues, 'invalid_reference', relatedPath, '事实引用不存在');
      }
    }
  }

  const deviceIssueStart = issues.length;
  const deviceFacts = validateArray(root.deviceContextFacts, '$.deviceContextFacts', issues);
  const deviceFactIds = new Set<string>();
  for (const [index, deviceFactValue] of (deviceFacts ?? []).entries()) {
    const path = `$.deviceContextFacts[${index}]`;
    const deviceFact = exactRecord(deviceFactValue, ['factId', 'kind', 'text', 'observedAt'], path, issues);
    if (!deviceFact) continue;
    const deviceFactId = validatePattern(deviceFact.factId, DEVICE_FACT_ID_PATTERN, `${path}.factId`, issues);
    addUniqueId(deviceFactIds, deviceFactId, `${path}.factId`, issues);
    validateEnum(deviceFact.kind, ['time', 'location', 'weather', 'device_activity', 'other'], `${path}.kind`, issues);
    if (typeof deviceFact.text !== 'string') addIssue(issues, 'invalid_type', `${path}.text`, '应为文字');
    if (typeof deviceFact.observedAt !== 'number' || !Number.isFinite(deviceFact.observedAt)) {
      addIssue(issues, 'invalid_type', `${path}.observedAt`, '应为有限数字');
    }
  }
  const deviceFactsAreStructurallyValid = !issues
    .slice(deviceIssueStart)
    .some((issue) => issueTouchesRoot(issue, 'deviceContextFacts'));
  if (deviceFactsAreStructurallyValid && !deviceFactsEqual(deviceFacts, context.deviceContextFacts)) {
    addIssue(issues, 'device_context_mismatch', '$.deviceContextFacts', '设备事实必须与输入一致');
  }

  validateText(root.sceneSummary, 240, '$.sceneSummary', issues);
  validateEnum(root.overallConfidence, ['low', 'medium', 'high'], '$.overallConfidence', issues);
  if (root.frameUsability === 'unusable') {
    if ((inferences?.length ?? -1) !== 0) {
      addIssue(issues, 'unusable_constraint', '$.inferences', '不可用帧不能有推断');
    }
    if (root.overallConfidence !== 'low') {
      addIssue(issues, 'unusable_constraint', '$.overallConfidence', '不可用帧必须低置信');
    }
    if ((uncertainties?.length ?? 0) < 1) {
      addIssue(issues, 'unusable_constraint', '$.uncertainties', '不可用帧至少一条不确定项');
    }
  }

  if (issues.length > 0) {
    return { success: false, issues, acceptedPartsText: buildCameraVisionAcceptedPartsText(value, issues) };
  }
  return { success: true, result: value as CameraVisionStructuredResultV1, issues: [] };
}

const EDGE_WHITESPACE_PATTERN = /^[\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+|[\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+$/gu;

export function parseCameraVisionStructuredOutput(
  rawOutput: string,
  context: CameraVisionValidationContextV1 = {
    subjectIdentityContext: { status: 'unknown' },
    deviceContextFacts: [],
  },
): CameraVisionValidationResult {
  if (typeof rawOutput !== 'string') {
    const issues = [{ code: 'invalid_json', path: '$', message: 'JSON 不完整或含多余内容' }];
    return { success: false, issues, acceptedPartsText: '（暂无可安全保留的部分）' };
  }
  const withoutBom = rawOutput.startsWith('\uFEFF') ? rawOutput.slice(1) : rawOutput;
  const jsonText = withoutBom.replace(EDGE_WHITESPACE_PATTERN, '');
  if (!jsonText) {
    const issues = [{ code: 'invalid_json', path: '$', message: 'JSON 不完整或含多余内容' }];
    return { success: false, issues, acceptedPartsText: '（暂无可安全保留的部分）' };
  }
  try {
    return validateCameraVisionStructuredResult(JSON.parse(jsonText) as unknown, context);
  } catch {
    const issues = [{ code: 'invalid_json', path: '$', message: 'JSON 不完整或含多余内容' }];
    return { success: false, issues, acceptedPartsText: '（暂无可安全保留的部分）' };
  }
}

export function buildCameraVisionStructuredInput({
  frameMetadata,
  subjectIdentityContext,
  deviceContextFacts,
}: {
  frameMetadata: CameraVisionFrameMetadataV1;
  subjectIdentityContext: CameraSubjectIdentityContextV1;
  deviceContextFacts: readonly CameraVisionDeviceContextFactV1[];
}) {
  return CAMERA_VISION_STRUCTURED_INPUT_TEMPLATE
    .replace('{{frameMetadataJson}}', JSON.stringify(frameMetadata, null, 2))
    .replace('{{subjectIdentityContextJson}}', JSON.stringify(subjectIdentityContext, null, 2))
    .replace('{{deviceContextFactsJson}}', JSON.stringify(deviceContextFacts, null, 2))
    .replace('{{outputSchemaJson}}', JSON.stringify(CAMERA_VISION_OUTPUT_SCHEMA, null, 2));
}

export function capCameraVisionPreviousOutput(previousOutput: string) {
  let bytes = 0;
  let capped = '';
  for (const character of previousOutput) {
    const codePoint = character.codePointAt(0) ?? 0;
    const characterBytes = codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    if (bytes + characterBytes > CAMERA_VISION_PREVIOUS_OUTPUT_MAX_BYTES) break;
    capped += character;
    bytes += characterBytes;
  }
  return capped;
}

export function buildCameraVisionStructuredRepairPrompt({
  acceptedPartsText,
  validationIssues,
  previousOutput,
}: {
  acceptedPartsText: string;
  validationIssues: readonly CameraVisionValidationIssue[];
  previousOutput: string;
}) {
  const validationIssuesText = validationIssues
    .slice(0, 24)
    .map((issue) => `${issue.path}：${issue.message}`)
    .join('\n');
  return CAMERA_VISION_STRUCTURED_REPAIR_PROMPT
    .replace('{{acceptedPartsText}}', acceptedPartsText || '（暂无可安全保留的部分）')
    .replace('{{validationIssuesText}}', validationIssuesText)
    .replace('{{previousOutput}}', capCameraVisionPreviousOutput(previousOutput));
}

function shouldDisableThinkingForSiliconFlowQwen35(connection: AiConnection) {
  if (!/^Qwen\/Qwen3\.5-/u.test(connection.model.trim())) return false;
  try {
    return new URL(connection.baseUrl.trim()).hostname.toLowerCase() === 'api.siliconflow.cn';
  } catch {
    return false;
  }
}

function createCameraVisionError(code: CameraVisionStructuredErrorCode) {
  return new Error(code);
}

function createAttemptSignal(externalSignal?: AbortSignal, timeoutMs = CAMERA_VISION_REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  let timedOut = false;
  let responseStarted = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const noResponseTimeoutId = setTimeout(() => {
    if (responseStarted || controller.signal.aborted) return;
    timedOut = true;
    controller.abort();
  }, CAMERA_VISION_NO_RESPONSE_TIMEOUT_MS);
  const cancel = () => controller.abort();
  if (externalSignal?.aborted) controller.abort();
  else externalSignal?.addEventListener('abort', cancel);
  return {
    signal: controller.signal,
    didTimeOut: () => timedOut,
    markResponseStarted: () => {
      if (responseStarted) return;
      responseStarted = true;
      clearTimeout(noResponseTimeoutId);
    },
    cleanup: () => {
      clearTimeout(timeoutId);
      clearTimeout(noResponseTimeoutId);
      externalSignal?.removeEventListener('abort', cancel);
    },
  };
}

function payloadErrorText(payload: unknown) {
  if (!isRecord(payload) || !isRecord(payload.error)) return '';
  const parts = [payload.error.message, payload.error.code, payload.error.type];
  return parts.filter((part): part is string => typeof part === 'string').join(' ').toLowerCase();
}

function isJsonModeUnsupported(responseStatus: number, payload: unknown, responseFormatRequested: boolean) {
  if (!responseFormatRequested || (responseStatus !== 400 && responseStatus !== 404 && responseStatus !== 422)) {
    return false;
  }
  const errorText = payloadErrorText(payload);
  const namesJsonMode = /response[_ -]?format|json[_ -]?object|json mode/u.test(errorText);
  const rejectsFeature = /unsupported|not supported|unknown|unrecognized|invalid|not allowed|不支持/u.test(errorText);
  return namesJsonMode && rejectsFeature;
}

function readAssistantOutput(payload: unknown) {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) return undefined;
  const firstChoice = payload.choices[0];
  if (!isRecord(firstChoice) || !isRecord(firstChoice.message)) return undefined;
  return typeof firstChoice.message.content === 'string' ? firstChoice.message.content : undefined;
}

function inspectCameraVisionStreamedOutput(payloadText: string, onUsage?: (usage: unknown) => void) {
  const empty = {
    dataEventCount: 0,
    contentEventCount: 0,
    reasoningEventCount: 0,
    contentCharacterCount: 0,
    doneReceived: false,
    malformed: false,
    output: undefined as string | undefined,
  };
  const trimmed = payloadText.trim();
  if (!trimmed) return empty;
  try {
    const ordinaryPayload = JSON.parse(trimmed) as unknown;
    if (isRecord(ordinaryPayload)) {
      try { onUsage?.(ordinaryPayload.usage); } catch { /* Numeric reporting cannot change parsing. */ }
    }
    const ordinaryOutput = readAssistantOutput(ordinaryPayload);
    if (ordinaryOutput !== undefined) {
      return {
        ...empty,
        contentEventCount: ordinaryOutput ? 1 : 0,
        contentCharacterCount: ordinaryOutput.length,
        output: ordinaryOutput || undefined,
      };
    }
  } catch {
    // A successful streaming response is an SSE document, not one JSON value.
  }

  let output = '';
  let dataEventCount = 0;
  let contentEventCount = 0;
  let reasoningEventCount = 0;
  let doneReceived = false;
  const malformedInspection = () => ({
    dataEventCount,
    contentEventCount,
    reasoningEventCount,
    contentCharacterCount: output.length,
    doneReceived,
    malformed: true,
    output: output || undefined,
  });
  for (const rawLine of payloadText.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(':')) continue;
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data) continue;
    if (data === '[DONE]') {
      doneReceived = true;
      continue;
    }
    dataEventCount += 1;
    let chunk: unknown;
    try {
      chunk = JSON.parse(data) as unknown;
    } catch {
      return malformedInspection();
    }
    if (isRecord(chunk)) {
      try { onUsage?.(chunk.usage); } catch { /* Numeric reporting cannot change parsing. */ }
    }
    if (!isRecord(chunk) || !Array.isArray(chunk.choices)) {
      return malformedInspection();
    }
    // SiliconFlow can append a usage/metadata event with an empty choices array.
    if (!chunk.choices.length) continue;
    const firstChoice = chunk.choices[0];
    if (!isRecord(firstChoice) || !isRecord(firstChoice.delta)) {
      return malformedInspection();
    }
    const content = firstChoice.delta.content;
    if (content !== undefined && content !== null && typeof content !== 'string') {
      return malformedInspection();
    }
    const reasoningContent = firstChoice.delta.reasoning_content;
    if (typeof reasoningContent === 'string' && reasoningContent) reasoningEventCount += 1;
    if (typeof content === 'string' && content) {
      contentEventCount += 1;
      output += content;
    }
  }
  return {
    dataEventCount,
    contentEventCount,
    reasoningEventCount,
    contentCharacterCount: output.length,
    doneReceived,
    malformed: false,
    output: dataEventCount > 0 && output ? output : undefined,
  };
}

export function parseCameraVisionStreamedOutput(payloadText: string) {
  const inspection = inspectCameraVisionStreamedOutput(payloadText);
  return inspection.malformed ? undefined : inspection.output;
}

function throwCameraVisionAttemptError(
  error: unknown,
  attemptSignal: ReturnType<typeof createAttemptSignal>,
  externalSignal?: AbortSignal,
): never {
  if (externalSignal?.aborted) throw createCameraVisionError('camera_vision_cancelled');
  if (attemptSignal.didTimeOut()) throw createCameraVisionError('camera_vision_timeout');
  if (attemptSignal.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
    throw createCameraVisionError('camera_vision_cancelled');
  }
  throw createCameraVisionError('camera_vision_request_failed');
}

function cameraVisionAbortError() {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

function parseJsonPayloadOrUndefined(text: string) {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function postCameraVisionStreamed({
  attemptNumber,
  attemptSignal,
  authorization,
  body,
  onDiagnostic,
  onRequestStart,
  onUsage,
  responseFormatRequested,
  url,
}: {
  attemptNumber: 1 | 2;
  attemptSignal: ReturnType<typeof createAttemptSignal>;
  authorization: string;
  body: string;
  onDiagnostic?: (diagnostic: CameraVisionTransportDiagnostic) => void;
  onRequestStart?: () => void;
  onUsage?: (usage: unknown) => void;
  responseFormatRequested: boolean;
  url: string;
}) {
  return new Promise<{ output?: string; payload?: unknown; status: number }>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const requestStartedAt = Date.now();
    let settled = false;
    let progressEventCount = 0;
    let lastStreamingDiagnosticAt = 0;
    const cleanup = () => attemptSignal.signal.removeEventListener('abort', abortFromSignal);
    const resolveOnce = (value: { output?: string; payload?: unknown; status: number }) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const abortFromSignal = () => xhr.abort();
    const readCompletedEvents = () => {
      const responseText = xhr.responseText;
      const completedBoundary = Math.max(responseText.lastIndexOf('\n'), responseText.lastIndexOf('\r'));
      return completedBoundary < 0 ? '' : responseText.slice(0, completedBoundary + 1);
    };
    const publishDiagnostic = (
      stage: CameraVisionTransportDiagnostic['stage'],
      inspectedText = readCompletedEvents(),
    ) => {
      const inspection = inspectCameraVisionStreamedOutput(inspectedText, onUsage);
      try {
        onDiagnostic?.({
          transport: 'xhr_sse',
          attemptNumber,
          responseFormatRequested,
          elapsedMs: Math.max(0, Date.now() - requestStartedAt),
          stage,
          httpStatus: xhr.status || null,
          progressEventCount,
          dataEventCount: inspection.dataEventCount,
          contentEventCount: inspection.contentEventCount,
          reasoningEventCount: inspection.reasoningEventCount,
          contentCharacterCount: inspection.contentCharacterCount,
          responseCharacterCount: xhr.responseText.length,
          doneReceived: inspection.doneReceived,
          malformed: inspection.malformed,
        });
      } catch {
        // Debug-only transport reporting cannot change request behavior.
      }
      return inspection;
    };

    xhr.open('POST', url, true);
    xhr.responseType = 'text';
    xhr.setRequestHeader('Authorization', authorization);
    xhr.setRequestHeader('Accept', 'text/event-stream');
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.onprogress = () => {
      if (settled) return;
      if (xhr.responseText.length > 0) attemptSignal.markResponseStarted();
      if (xhr.status < 200 || xhr.status >= 300) return;
      progressEventCount += 1;
      // Let the server finish the SSE response and release its connection
      // normally. Aborting as soon as JSON happens to look complete can leave
      // cancelled generations or pooled connections behind during repeated use.
      const now = Date.now();
      if (now - lastStreamingDiagnosticAt >= CAMERA_VISION_STREAMING_DIAGNOSTIC_INTERVAL_MS) {
        lastStreamingDiagnosticAt = now;
        publishDiagnostic('streaming');
      }
    };
    xhr.onload = () => {
      if (settled) return;
      const inspection = publishDiagnostic('completed', xhr.responseText);
      if (xhr.status >= 200 && xhr.status < 300) {
        resolveOnce({ output: inspection.malformed ? undefined : inspection.output, status: xhr.status });
        return;
      }
      resolveOnce({ payload: parseJsonPayloadOrUndefined(xhr.responseText), status: xhr.status });
    };
    xhr.onerror = () => {
      publishDiagnostic('network_error', xhr.responseText);
      rejectOnce(new TypeError('Network request failed'));
    };
    xhr.onabort = () => {
      if (settled) return;
      publishDiagnostic('aborted', xhr.responseText);
      rejectOnce(cameraVisionAbortError());
    };
    attemptSignal.signal.addEventListener('abort', abortFromSignal);
    if (attemptSignal.signal.aborted) {
      rejectOnce(cameraVisionAbortError());
      return;
    }
    publishDiagnostic('request_started', '');
    onRequestStart?.();
    xhr.send(body);
  });
}

async function requestCameraVisionAttempt({
  apiKey,
  attemptNumber,
  connection,
  dynamicInput,
  imageUrl,
  repairPrompt,
  signal,
  onTransportDiagnostic,
  beforeAttempt,
  attemptTimeoutMs,
}: {
  apiKey: string;
  attemptNumber: 1 | 2;
  connection: AiConnection;
  dynamicInput: string;
  imageUrl: string;
  repairPrompt?: string;
  signal?: AbortSignal;
  onTransportDiagnostic?: (diagnostic: CameraVisionTransportDiagnostic) => void;
  beforeAttempt?: (attemptNumber: 1 | 2) => Promise<void>;
  attemptTimeoutMs?: number;
}) {
  if (signal?.aborted) throw createCameraVisionError('camera_vision_cancelled');
  await beforeAttempt?.(attemptNumber);
  if (signal?.aborted) throw createCameraVisionError('camera_vision_cancelled');
  const attemptSignal = createAttemptSignal(signal, attemptTimeoutMs);
  const responseFormatRequested = connection.chatJsonOutputEnabled === true;
  const useStreaming = shouldDisableThinkingForSiliconFlowQwen35(connection);
  let cacheMetric: ReturnType<typeof beginPromptCacheMetric> | undefined;
  try {
    if (signal?.aborted) throw createCameraVisionError('camera_vision_cancelled');
    const url = `${connection.baseUrl.trim().replace(/\/+$/u, '')}/chat/completions`;
    const body = JSON.stringify({
      model: connection.model.trim(),
      ...(shouldDisableThinkingForSiliconFlowQwen35(connection) ? { enable_thinking: false } : {}),
      messages: [
        { role: 'system', content: CAMERA_VISION_STRUCTURED_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: dynamicInput },
            ...(repairPrompt ? [{ type: 'text', text: repairPrompt }] : []),
            { type: 'image_url', image_url: { url: imageUrl } },
          ],
        },
      ],
      temperature: 0.1,
      max_tokens: 4096,
      ...(useStreaming ? { stream: true } : {}),
      ...(responseFormatRequested ? { response_format: { type: 'json_object' as const } } : {}),
    });
    let payload: unknown;
    let output: string | undefined;
    let responseStatus: number;
    if (useStreaming) {
      try {
        const streamed = await postCameraVisionStreamed({
          attemptNumber,
          attemptSignal,
          authorization: `Bearer ${apiKey.trim()}`,
          body,
          onDiagnostic: onTransportDiagnostic,
          onRequestStart: () => {
            cacheMetric = beginPromptCacheMetric({ contextProfile: 'camera-vision', contextSource: 'camera.observation', connection });
          },
          onUsage: usage => cacheMetric?.recordUsage(usage),
          responseFormatRequested,
          url,
        });
        payload = streamed.payload;
        output = streamed.output;
        responseStatus = streamed.status;
      } catch (error) {
        throwCameraVisionAttemptError(error, attemptSignal, signal);
      }
    } else {
      let response: Response;
      try {
        cacheMetric = beginPromptCacheMetric({ contextProfile: 'camera-vision', contextSource: 'camera.observation', connection });
        response = await fetch(url, {
          body,
          headers: {
            Authorization: `Bearer ${apiKey.trim()}`,
            'Content-Type': 'application/json',
          },
          method: 'POST',
          signal: attemptSignal.signal,
        });
        attemptSignal.markResponseStarted();
      } catch (error) {
        throwCameraVisionAttemptError(error, attemptSignal, signal);
      }
      responseStatus = response.status;
      try {
        payload = await response.json() as unknown;
        if (isRecord(payload)) cacheMetric.recordUsage(payload.usage);
        output = readAssistantOutput(payload);
      } catch (error) {
        throwCameraVisionAttemptError(error, attemptSignal, signal);
      }
    }
    if (signal?.aborted) throw createCameraVisionError('camera_vision_cancelled');
    if (attemptSignal.didTimeOut()) throw createCameraVisionError('camera_vision_timeout');
    if (responseStatus < 200 || responseStatus >= 300) {
      if (isJsonModeUnsupported(responseStatus, payload, responseFormatRequested)) {
        throw createCameraVisionError('camera_vision_json_mode_unsupported');
      }
      throw createCameraVisionError('camera_vision_request_failed');
    }
    if (output === undefined) throw createCameraVisionError('camera_vision_request_failed');
    return output;
  } finally {
    void cacheMetric?.finish();
    attemptSignal.cleanup();
  }
}

function finalValidationError(result: Extract<CameraVisionValidationResult, { success: false }>) {
  if (result.issues.some((issue) => issue.code === 'identity_context_mismatch')) {
    return createCameraVisionError('camera_vision_identity_context_mismatch');
  }
  if (result.issues.some((issue) => issue.code === 'device_context_mismatch')) {
    return createCameraVisionError('camera_vision_device_context_mismatch');
  }
  return createCameraVisionError('camera_vision_repair_failed');
}

export async function analyzeCameraFrameStructured(
  options: AnalyzeCameraFrameStructuredOptions,
): Promise<CameraVisionAnalysisSuccessV1> {
  const {
    apiKey,
    connection,
    debugForceFirstAttemptInvalid = false,
    imageDataUrl,
    mimeType = 'image/jpeg',
    onRepairStarted,
    onValidationFailed,
    onTransportDiagnostic,
    subjectIdentityContext,
    deviceContextFacts,
    signal,
  } = options;
  const frameMetadata = options.frame ?? options.frameMetadata!;
  const startedAt = Date.now();
  const responseFormatRequested = connection.chatJsonOutputEnabled === true;
  const dynamicInput = buildCameraVisionStructuredInput({ frameMetadata, subjectIdentityContext, deviceContextFacts });
  const imageUrl = imageDataUrl.startsWith('data:') ? imageDataUrl : `data:${mimeType};base64,${imageDataUrl}`;
  const validationContext = { subjectIdentityContext, deviceContextFacts };
  const firstOutput = await requestCameraVisionAttempt({
    apiKey,
    attemptNumber: 1,
    connection,
    dynamicInput,
    imageUrl,
    signal,
    onTransportDiagnostic,
    beforeAttempt: options.beforeAttempt,
    attemptTimeoutMs: options.attemptTimeoutMs,
  });
  const firstCandidate = debugForceFirstAttemptInvalid
    ? `\`\`\`json\n${firstOutput}\n\`\`\``
    : firstOutput;
  const firstValidation = parseCameraVisionStructuredOutput(firstCandidate, validationContext);
  if (firstValidation.success === true) {
    return {
      result: firstValidation.result,
      attemptCount: 1,
      repairUsed: false,
      responseFormatRequested,
      provider: connection.name,
      model: connection.model.trim(),
      latencyMs: Math.max(0, Date.now() - startedAt),
    };
  }

  try {
    onValidationFailed?.(1, firstValidation.issues);
  } catch {
    // Debug validation reporting cannot change the analysis result.
  }

  const repairPrompt = buildCameraVisionStructuredRepairPrompt({
    acceptedPartsText: firstValidation.acceptedPartsText,
    validationIssues: firstValidation.issues,
    previousOutput: firstCandidate,
  });
  try {
    onRepairStarted?.([...new Set(firstValidation.issues.map((issue) => issue.code))].slice(0, 8));
  } catch {
    // UI phase reporting cannot change the analysis result or its stable errors.
  }
  const repairedOutput = await requestCameraVisionAttempt({
    apiKey,
    attemptNumber: 2,
    connection,
    dynamicInput,
    imageUrl,
    repairPrompt,
    signal,
    onTransportDiagnostic,
    beforeAttempt: options.beforeAttempt,
    attemptTimeoutMs: options.attemptTimeoutMs,
  });
  const repairedValidation = parseCameraVisionStructuredOutput(repairedOutput, validationContext);
  if (repairedValidation.success === false) {
    try {
      onValidationFailed?.(2, repairedValidation.issues);
    } catch {
      // Debug validation reporting cannot change the analysis result.
    }
    throw finalValidationError(repairedValidation);
  }
  return {
    result: repairedValidation.result,
    attemptCount: 2,
    repairUsed: true,
    responseFormatRequested,
    provider: connection.name,
    model: connection.model.trim(),
    latencyMs: Math.max(0, Date.now() - startedAt),
  };
}

export function buildCameraVisionInputText(
  frame: CameraVisionFrameMetadataV1,
  subjectIdentityContext: CameraSubjectIdentityContextV1,
  deviceContextFacts: readonly CameraVisionDeviceContextFactV1[],
) {
  return buildCameraVisionStructuredInput({ frameMetadata: frame, subjectIdentityContext, deviceContextFacts });
}

export function buildCameraVisionRepairText(
  previousOutput: string,
  validation: Extract<CameraVisionValidationResult, { success: false }>,
) {
  return buildCameraVisionStructuredRepairPrompt({
    acceptedPartsText: validation.acceptedPartsText,
    validationIssues: validation.issues,
    previousOutput,
  });
}

export function runCameraVisionStructuredFixtureSelfTest() {
  const valid: CameraVisionStructuredResultV1 = {
    schemaVersion: 1,
    frameUsability: 'clear',
    subjectVisibility: { status: 'none', visibleCount: 0, subjects: [] },
    subjectIdentities: [],
    objectiveFacts: [{
      factId: 'fact_1',
      category: 'environment',
      subjectRef: null,
      text: '画面中有一面浅色墙壁',
      evidenceQuality: 'clear',
    }],
    inferences: [],
    uncertainties: [],
    deviceContextFacts: [],
    sceneSummary: '画面中主要是一面浅色墙壁。',
    overallConfidence: 'high',
  };
  const dangling = structuredClone(valid) as CameraVisionStructuredResultV1;
  dangling.inferences = [{
    inferenceId: 'inference_1',
    category: 'other',
    subjectRef: null,
    text: '存在无法成立的推断',
    evidenceFactIds: ['fact_99'],
    confidence: 'low',
  }];
  const identityForgery = structuredClone(valid) as CameraVisionStructuredResultV1;
  identityForgery.subjectIdentities = [{
    subjectRef: 'person_1',
    identity: 'you',
    basis: 'manual_identity_marker',
  }];
  const deviceForgery = structuredClone(valid) as CameraVisionStructuredResultV1;
  deviceForgery.deviceContextFacts = [{ factId: 'device_1', kind: 'time', text: '未经输入的时间', observedAt: 1 }];
  const cases = [
    !parseCameraVisionStructuredOutput('{').success,
    !parseCameraVisionStructuredOutput(`\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``).success,
    !validateCameraVisionStructuredResult(({ ...valid, sceneSummary: undefined })).success,
    !validateCameraVisionStructuredResult(({ ...valid, extraField: true })).success,
    !validateCameraVisionStructuredResult(dangling).success,
    !validateCameraVisionStructuredResult(identityForgery).success,
    !validateCameraVisionStructuredResult(deviceForgery).success,
  ];
  return { passed: cases.filter(Boolean).length, total: cases.length, success: cases.every(Boolean) };
}

export function describeCameraVisionErrorCode(code: string) {
  if (code === 'camera_vision_json_mode_unsupported') return '当前服务不接受已启用的 JSON mode，请检查这条连接的 JSON 输出设置。';
  if (code === 'camera_vision_schema_invalid') return '模型返回的结构不符合摄像头视觉合同。';
  if (code === 'camera_vision_repair_failed') return '再次整理后仍未得到合格的结构化结果。';
  if (code === 'camera_vision_identity_context_mismatch') return '模型写入了本轮身份材料没有提供的人物身份。';
  if (code === 'camera_vision_device_context_mismatch') return '模型写入了本轮没有提供的设备信息。';
  if (code === 'camera_vision_request_failed') return '看图模型请求失败，请检查连接、额度或网络。';
  if (code === 'camera_vision_timeout') return '看图模型连接超时，本次结果没有保留。';
  if (code === 'camera_vision_cancelled') return '本次结构化看图已取消。';
  return code;
}
