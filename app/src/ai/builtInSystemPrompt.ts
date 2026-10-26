import type { AiProfile } from './types';
import {
  compilePersonaPrompt,
  compilePersonaPromptResult,
  compilePersonaPromptSync,
  prewarmPersonaPrompt,
  type PersonaPromptCompileOptions,
} from './persona/promptCompiler';

// Private companion persona. Remove or replace the default persona module before publishing a public build.
export const BUILT_IN_SYSTEM_PROMPT = compilePersonaPromptSync({
  contextProfile: 'chat-full',
  profile: {
    automaticExplicitFactMemories: false,
    proactiveMemorySuggestions: false,
    systemPrompt: '',
    userNote: '',
  },
});

export function buildSystemPrompt(profile: AiProfile) {
  return compilePersonaPromptSync({ contextProfile: 'chat-full', profile });
}

export async function buildCompiledSystemPrompt(options: PersonaPromptCompileOptions) {
  return compilePersonaPrompt(options);
}

export async function buildCompiledSystemPromptResult(options: PersonaPromptCompileOptions) {
  return compilePersonaPromptResult(options);
}

export { prewarmPersonaPrompt };
