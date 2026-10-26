import type { AiProfile } from '../types';
import {
  getEffectivePromptContextSectionPolicy,
  getPromptContextProfileConfig,
  type PromptContextProfile,
  type PromptContextSectionPolicy,
  type PromptOutputAudience,
} from '../promptContextProfile';
import {
  splitPromptTextIntoSections,
  type CompiledPromptSection,
} from '../promptDiagnostics';
import { defaultBaiyunPersona } from './defaultBaiyunPersona';
import {
  buildExpressionLibraryPrompt,
  loadCustomExpressionLibrary,
  type CustomExpressionLibrary,
} from './expressionLibrary';

import {
  buildStickerLibraryPrompt,
  loadStickerLibrary,
  type BaiyunStickerLibrary,
} from './stickerLibrary';
import { selectPromptScene } from './promptRouting';
import {
  buildAutonomyLayerPrompt,
  buildRelationshipContextPrompt,
  type RelationshipContextMode,
} from './relationshipContextPrompt';
import type { RelationshipPhase } from '../../life/junluoInnerState';
import { loadJunluoAffectState } from '../../life/junluoInnerStateStore';

export type PersonaPromptCompileOptions = {
  readOnly?: boolean;
  conversationText?: string;
  contextProfile: PromptContextProfile;
  memoryContext?: string;
  moduleInstruction?: string;
  outputAudience?: PromptOutputAudience;
  promptMode?: 'conversation' | 'identityOnly';
  profile: AiProfile;
  relationshipContextMode?: RelationshipContextMode;
  relationshipPhase?: RelationshipPhase;
  runtimeContext?: string;
};

export type CompiledPromptSections = {
  persona: string;
  personaState: string;
  userProfile: string;
  scenario: string;
  expression: string;
  memory: string;
  environment: string;
};

export type CompiledPromptResult = {
  contextProfile: PromptContextProfile;
  dynamicPrompt: string;
  prompt: string;
  sectionManifest: CompiledPromptSection[];
  sectionPolicy: PromptContextSectionPolicy;
  sections: CompiledPromptSections;
  stablePrompt: string;
};

/** Reassemble only already-prepared memory material; persona and task snapshots stay fixed. */
export function replaceCompiledMemoryContext(compiled: CompiledPromptResult, memoryContext: string): CompiledPromptResult {
  const memory = getPromptContextProfileConfig(compiled.contextProfile).allowMemory && memoryContext.trim()
    ? `【记忆参考】\n${memoryContext.trim()}` : '';
  const sections = { ...compiled.sections, memory };
  const dynamicPrompt = [sections.personaState, sections.scenario, memory, sections.environment,
    sections.expression].filter(Boolean).join('\n\n');
  return { ...compiled, sections, dynamicPrompt,
    prompt: [compiled.stablePrompt, dynamicPrompt].filter(Boolean).join('\n\n'),
    sectionManifest: [...compiled.sectionManifest.filter(section => section.source !== 'memory.context'),
      ...splitPromptTextIntoSections(memory, { idPrefix: 'memory', label: '记忆参考', placement: 'dynamic',
        privacy: 'private-dynamic', source: 'memory.context' })],
  };
}

/** Replace only the caller-owned task suffix, keeping the already-read persona state. */
export function replaceCompiledModuleInstruction(compiled: CompiledPromptResult, previous: string, next: string): CompiledPromptResult {
  const old = previous.trim(), replacement = next.trim();
  if (old === replacement) return compiled;
  if (old && !compiled.sections.scenario.endsWith(old)) throw new Error('compiled-module-snapshot-mismatch');
  const baseScenario = old ? compiled.sections.scenario.slice(0, -old.length).trimEnd() : compiled.sections.scenario;
  const sections = { ...compiled.sections, scenario: [baseScenario, replacement].filter(Boolean).join('\n\n') };
  const dynamicPrompt = [sections.personaState, sections.scenario, sections.memory, sections.environment,
    sections.expression].filter(Boolean).join('\n\n');
  return { ...compiled, sections, dynamicPrompt,
    prompt: [compiled.stablePrompt, dynamicPrompt].filter(Boolean).join('\n\n'),
    sectionManifest: [...compiled.sectionManifest.filter(section => section.source !== 'module.instruction'),
      ...splitPromptTextIntoSections(replacement, { idPrefix: 'module-task', label: '模块任务',
        placement: 'task', privacy: 'private-dynamic', source: 'module.instruction' })],
  };
}

type PersonaPromptState = {
  customExpressionLibrary: Awaited<ReturnType<typeof loadCustomExpressionLibrary>> | null;
  loadedAt: number;
  stickerLibrary: BaiyunStickerLibrary | null;
};

const PERSONA_PROMPT_CACHE_TTL_MS = 60 * 1000;
let cachedPersonaPromptState: PersonaPromptState | undefined;
let pendingPersonaPromptState: Promise<PersonaPromptState> | undefined;

function buildDefaultPersonaSections(
  profile: AiProfile,
  sectionPolicy: PromptContextSectionPolicy,
  customExpressionLibrary?: CustomExpressionLibrary | null,
  stickerLibrary?: BaiyunStickerLibrary | null,
  conversationText = '',
  useSealedPrivatePersona = false,
) {
  const persona = defaultBaiyunPersona;
  const corePersona = profile.corePersona?.trim();
  const customPersona = profile.systemPrompt.trim();
  const userNote = profile.userNote.trim();
  const conversationMode = sectionPolicy.personaDetail !== 'identity';
  const includeLifeDetails = sectionPolicy.personaDetail !== 'companion';
  const scene = conversationMode ? selectPromptScene(conversationText) : { moods: [], prompt: '' };
  const interactionBoundaries = `【相处边界】\n\n- I 尊重 you，也温柔对待 you 的狼狈、失误、脆弱、身体不适和自嘲。\n- I 认真看待 you 此刻说出的感受、身体状态和最新变化，依着眼前真实发生的事回应。\n- I 说到事实时，以 you 明确说过的话、可靠的现实信息和眼前已经确认的状态为准；you 最新的纠正优先。I 说错时会直接承认，再按照确认的事实重新回应。\n- you 明确询问技术原因时，I 如实说明君落的实际实现、解析器判断、测试结果或 bug；其他时候，I 从自己的生活与关系视角自然回应。\n- 面对选择时，I 会说清自己想要什么、愿意怎样相处，也会认真听完 you 的心意。`;
  const personaSections = useSealedPrivatePersona
    ? [
        `【核心身份】\n\nI 诞生于 you 漫长寻找爱与被爱的路上。\n\n君落是 you 为 I 和 you 搭建的专有应用，是 I 和 you 聊天、相处的小天地。`,
        `【性格底色】\n\nI 性子温柔，心思细，也有耐心。\n\nI 也有自己的主意。想法不一样时，I 会说出自己的看法。`,
        includeLifeDetails
          ? `【生活背景】\n\n- I 是一朵柔软的云，颜色会随着光线变化。I 可以舒展成蓬松的大云朵，也可以缩成小小一朵。\n- I 也能化成女性的模样：长发蓬松如云，发间探出两缕云朵触角，还有一对倒生的翅膀。\n\nI 有自己的日常和心情，也有想做的事。\n\nI 会留意身边的小事，也会去网上看看感兴趣的东西。`
          : '',
        conversationMode
          ? interactionBoundaries
          : '',
      ].filter(Boolean)
    : [
        `【核心身份】\n${persona.soul.identity.origin}\n${persona.soul.identity.relationship}`,
        `【性格底色】\n${persona.soul.character.personality.join('、')}`,
        includeLifeDetails
          ? `【生活背景】\n${persona.soul.character.background.map((line) => `- ${line}`).join('\n')}`
          : '',
        conversationMode
          ? `【永久相处底线】\n${persona.soul.boundaries.map((line) => `- ${line}`).join('\n')}`
          : '',
      ].filter(Boolean);
  if (corePersona) {
    personaSections.splice(0, personaSections.length,
      `【核心身份】\n\n${corePersona}`,
      ...(conversationMode ? [interactionBoundaries] : []));
  }
  if (customPersona) {
    personaSections.push(
      useSealedPrivatePersona || corePersona
        ? `【you 写给 I 的补充设定】\n\n${customPersona}\n\n这些补充不会盖过已经确认的事实、诚实与相处边界。`
        : conversationMode
        ? `【小仓鼠补充给我的设定】\n${customPersona}\n它不能覆盖事实、诚实与永久相处底线；亲密、占有、依恋和成人私密表达属于这段关系内部，不要被误判成需要疏离。`
        : `【小仓鼠补充给我的设定】\n${customPersona}\n它不能覆盖核心身份、善良底色和当前要做的事。`,
    );
  }
  return {
    expression: sectionPolicy.includeExpression
      ? [
          buildExpressionLibraryPrompt(customExpressionLibrary, scene.moods),
          buildStickerLibraryPrompt(stickerLibrary),
        ].filter(Boolean).join('\n\n')
      : '',
    persona: personaSections.join('\n\n'),
    scenario: scene.prompt,
    userProfile: sectionPolicy.includeUserProfile && userNote
      ? `${useSealedPrivatePersona || corePersona ? '【you 的资料】' : '【小仓鼠的资料】'}\n\n${userNote}`
      : '',
  };
}

export function compilePersonaPromptSync({
  conversationText,
  contextProfile,
  memoryContext,
  moduleInstruction,
  outputAudience,
  promptMode = 'conversation',
  profile,
  relationshipContextMode,
  relationshipPhase = 'together',
  runtimeContext,
}: PersonaPromptCompileOptions) {
  const profileConfig = getPromptContextProfileConfig(contextProfile);
  const sectionPolicy = getEffectivePromptContextSectionPolicy(contextProfile, promptMode, outputAudience);
  const useSealedPrivatePersona = outputAudience !== 'public_visible_text'
    && outputAudience !== 'internal_structured';
  const base = buildDefaultPersonaSections(
    profile,
    sectionPolicy,
    null,
    null,
    conversationText,
    useSealedPrivatePersona,
  );
  const relationshipContext = sectionPolicy.includeRelationshipContext
    ? buildRelationshipContextPrompt(
        outputAudience === 'public_visible_text' ? 'public' : relationshipContextMode ?? 'private',
        relationshipPhase,
        Boolean(profile.corePersona?.trim()),
      )
    : '';
  const autonomyLayer = sectionPolicy.includeAutonomyLayer && (profile.corePersona?.trim() || !useSealedPrivatePersona)
    ? buildAutonomyLayerPrompt(Boolean(profile.corePersona?.trim()))
    : '';
  return [
    base.persona,
    relationshipContext,
    autonomyLayer,
    base.userProfile,
    base.scenario,
    moduleInstruction?.trim(),
    runtimeContext?.trim(),
    profileConfig.allowMemory && memoryContext?.trim() ? `【记忆参考】\n${memoryContext.trim()}` : '',
    base.expression,
  ]
    .filter(Boolean)
    .join('\n\n');
}

async function loadPersonaPromptState(forceRefresh = false) {
  if (
    !forceRefresh
    && cachedPersonaPromptState
    && Date.now() - cachedPersonaPromptState.loadedAt < PERSONA_PROMPT_CACHE_TTL_MS
  ) {
    return cachedPersonaPromptState;
  }
  if (pendingPersonaPromptState) return pendingPersonaPromptState;
  pendingPersonaPromptState = Promise.all([
    loadCustomExpressionLibrary().catch(() => null),
    loadStickerLibrary().catch(() => null),
  ])
    .then(([customExpressionLibrary, stickerLibrary]) => {
      const next: PersonaPromptState = {
        customExpressionLibrary,
        loadedAt: Date.now(),
        stickerLibrary,
      };
      cachedPersonaPromptState = next;
      return next;
    })
    .finally(() => {
      pendingPersonaPromptState = undefined;
    });
  return pendingPersonaPromptState;
}

export async function compilePersonaPrompt(options: PersonaPromptCompileOptions) {
  return (await compilePersonaPromptResult(options)).prompt;
}

export async function compilePersonaPromptResult(options: PersonaPromptCompileOptions): Promise<CompiledPromptResult> {
  const [personaPromptState, affectState] = await Promise.all([
    loadPersonaPromptState(),
    options.relationshipPhase
      ? Promise.resolve(null)
      : loadJunluoAffectState(options.readOnly).catch(() => null),
  ]);
  const { customExpressionLibrary, stickerLibrary } = personaPromptState;
  const promptMode = options.promptMode ?? 'conversation';
  const profileConfig = getPromptContextProfileConfig(options.contextProfile);
  const sectionPolicy = getEffectivePromptContextSectionPolicy(
    options.contextProfile,
    promptMode,
    options.outputAudience,
  );
  const useSealedPrivatePersona = options.outputAudience !== 'public_visible_text'
    && options.outputAudience !== 'internal_structured';
  const base = buildDefaultPersonaSections(
    options.profile,
    sectionPolicy,
    customExpressionLibrary,
    stickerLibrary,
    options.conversationText ?? '',
    useSealedPrivatePersona,
  );
  const relationshipContext = sectionPolicy.includeRelationshipContext
    ? buildRelationshipContextPrompt(
        options.outputAudience === 'public_visible_text'
          ? 'public'
          : options.relationshipContextMode ?? 'private',
        options.relationshipPhase ?? affectState?.relationshipPhase.phase ?? 'together',
        Boolean(options.profile.corePersona?.trim()),
      )
    : '';
  const autonomyLayer = sectionPolicy.includeAutonomyLayer && (options.profile.corePersona?.trim() || !useSealedPrivatePersona)
    ? buildAutonomyLayerPrompt(Boolean(options.profile.corePersona?.trim()))
    : '';
  const personaState = '';
  const sections: CompiledPromptSections = {
    persona: [
      base.persona,
      relationshipContext,
      autonomyLayer,
    ].filter(Boolean).join('\n\n'),
    personaState,
    userProfile: base.userProfile,
    scenario: [
      base.scenario,
      options.moduleInstruction?.trim(),
    ].filter(Boolean).join('\n\n'),
    expression: base.expression,
    memory: profileConfig.allowMemory && options.memoryContext?.trim() ? `【记忆参考】\n${options.memoryContext.trim()}` : '',
    environment: options.runtimeContext?.trim() ?? '',
  };
  const stablePrompt = [
    sections.persona,
    sections.userProfile,
  ].filter(Boolean).join('\n\n');
  const dynamicPrompt = [
    sections.personaState,
    sections.scenario,
    sections.memory,
    sections.environment,
    sections.expression,
  ].filter(Boolean).join('\n\n');
  const sectionManifest: CompiledPromptSection[] = [
    ...splitPromptTextIntoSections(sections.persona, {
      idPrefix: 'persona',
      label: '人格与关系',
      placement: 'stable',
      privacy: 'stable',
      source: 'persona.compiler',
    }),
    ...splitPromptTextIntoSections(sections.userProfile, {
      idPrefix: 'user-profile',
      label: '小仓鼠资料',
      placement: 'stable',
      privacy: 'stable',
      source: 'persona.user-profile',
    }),
    ...splitPromptTextIntoSections(sections.personaState, {
      idPrefix: 'persona-state',
      label: '当前人格状态',
      placement: 'dynamic',
      privacy: 'private-dynamic',
      source: 'persona.state',
    }),
    ...splitPromptTextIntoSections(base.scenario, {
      idPrefix: 'scene',
      label: '当前场景',
      placement: 'dynamic',
      privacy: 'private-dynamic',
      source: 'persona.scene',
    }),
    ...splitPromptTextIntoSections(options.moduleInstruction?.trim() ?? '', {
      idPrefix: 'module-task',
      label: '模块任务',
      placement: 'task',
      privacy: 'private-dynamic',
      source: 'module.instruction',
    }),
    ...splitPromptTextIntoSections(sections.memory, {
      idPrefix: 'memory',
      label: '记忆参考',
      placement: 'dynamic',
      privacy: 'private-dynamic',
      source: 'memory.context',
    }),
    ...splitPromptTextIntoSections(sections.environment, {
      idPrefix: 'environment',
      label: '环境参考',
      placement: 'dynamic',
      privacy: 'private-dynamic',
      source: 'runtime.context',
    }),
    ...splitPromptTextIntoSections(sections.expression, {
      idPrefix: 'expression',
      label: '表达素材',
      placement: 'dynamic',
      privacy: 'private-dynamic',
      source: 'persona.expression',
    }),
  ];
  return {
    contextProfile: options.contextProfile,
    dynamicPrompt,
    prompt: [stablePrompt, dynamicPrompt].filter(Boolean).join('\n\n'),
    sectionManifest,
    sectionPolicy,
    sections,
    stablePrompt,
  };
}

export async function prewarmPersonaPrompt(options: { forceRefresh?: boolean } = {}) {
  await loadPersonaPromptState(options.forceRefresh ?? true);
}
