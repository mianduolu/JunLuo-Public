import { executeToolCall } from './toolExecution';
import type { JunLuoToolIntentRoute } from './toolIntentRouter';
import type { JunLuoUsePackageData } from './builtin/systemTools';
import type { JunLuoToolCall, JunLuoToolResult } from './toolTypes';

export type JunLuoToolPackageActivation = {
  packageId: string;
  reason: string;
  result: JunLuoToolResult<JunLuoUsePackageData>;
};

function unique(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

export function inferToolPackageIdsFromRoute(route: JunLuoToolIntentRoute) {
  if (route.unsupported || !route.shouldUseTool) return [];
  return unique(route.candidateTools.map((toolId) => toolId.split('.')[0] ?? ''));
}

export function inferToolPackageIdsFromResults(results: JunLuoToolResult[]) {
  return unique(results
    .filter((result) => result.toolId !== 'system.use_package')
    .map((result) => result.toolId.split('.')[0] ?? ''));
}

export async function activateToolPackage(
  packageId: string,
  reason: string,
): Promise<JunLuoToolPackageActivation> {
  const call: JunLuoToolCall = {
    callId: `tool-package-${packageId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    toolId: 'system.use_package',
    input: { packageId, reason },
    requestedBy: 'chat',
    createdAt: Date.now(),
  };
  const result = await executeToolCall(call, { bypassPermission: true }) as JunLuoToolResult<JunLuoUsePackageData>;
  return { packageId, reason, result };
}

export async function activateToolPackages(
  packageIds: string[],
  reason: string,
): Promise<JunLuoToolPackageActivation[]> {
  const activations: JunLuoToolPackageActivation[] = [];
  for (const packageId of unique(packageIds)) {
    activations.push(await activateToolPackage(packageId, reason));
  }
  return activations;
}
