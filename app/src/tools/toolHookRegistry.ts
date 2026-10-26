import { JunLuoToolRegistryError } from './toolErrors';
import type {
  JunLuoToolHookDiagnostic,
  JunLuoToolHookRegistration,
  JunLuoToolHookType,
  JunLuoToolLifecycleEvent,
} from './toolHookTypes';

const lifecycleHooksById = new Map<string, JunLuoToolHookRegistration>();
const hookDiagnostics: JunLuoToolHookDiagnostic[] = [];
const MAX_HOOK_DIAGNOSTICS = 50;

function assertNonEmptyHookId(id: string) {
  if (!id.trim()) {
    throw new JunLuoToolRegistryError('INVALID_TOOL_DEFINITION', '工具 hook ID 不能为空');
  }
}

function recordHookDiagnostic(diagnostic: JunLuoToolHookDiagnostic) {
  hookDiagnostics.unshift(diagnostic);
  if (hookDiagnostics.length > MAX_HOOK_DIAGNOSTICS) {
    hookDiagnostics.length = MAX_HOOK_DIAGNOSTICS;
  }
}

export function assertToolHookTypeEnabled(hookType: JunLuoToolHookType) {
  if (hookType !== 'tool_lifecycle') {
    throw new JunLuoToolRegistryError(
      'INVALID_TOOL_DEFINITION',
      `工具 hook 暂未开放注册：${hookType}`,
      { hookType },
    );
  }
}

export function registerToolLifecycleHook(registration: JunLuoToolHookRegistration) {
  assertNonEmptyHookId(registration.id);
  assertToolHookTypeEnabled(registration.hookType);
  if (lifecycleHooksById.has(registration.id)) {
    throw new JunLuoToolRegistryError(
      'DUPLICATE_TOOL_ID',
      `工具 hook ID 已存在：${registration.id}`,
      { hookId: registration.id, hookType: registration.hookType },
    );
  }
  lifecycleHooksById.set(registration.id, registration);
}

export function unregisterToolLifecycleHook(hookId: string) {
  lifecycleHooksById.delete(hookId);
}

export function listToolLifecycleHooks() {
  return Array.from(lifecycleHooksById.values());
}

export function listToolHookDiagnostics() {
  return [...hookDiagnostics];
}

export function clearToolHooksForTests() {
  lifecycleHooksById.clear();
  hookDiagnostics.length = 0;
}

export async function emitToolLifecycleEvent(event: JunLuoToolLifecycleEvent) {
  const hooks = listToolLifecycleHooks();
  for (const hook of hooks) {
    try {
      await hook.handler(event);
    } catch (error) {
      recordHookDiagnostic({
        hookId: hook.id,
        hookType: hook.hookType,
        eventType: event.eventType,
        message: error instanceof Error ? error.message : String(error),
        createdAt: Date.now(),
      });
    }
  }
}
