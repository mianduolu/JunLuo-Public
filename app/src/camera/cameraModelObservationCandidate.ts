import type { JunLuoToolCandidateSelection } from '../tools/toolCandidateSelector';
import { TOOL_CAPABILITY_MAX_SCHEMA_CHARACTERS } from '../tools/toolCapabilityDiscovery';
import { isBodySignalHistoryTool } from '../tools/bodySignalHistoryToolDefinition';
import { RESEARCH_CHAT_TOOL_IDS } from '../tools/researchChatTools';
import { BROWSER_OPEN_TOOL_ID } from '../tools/browserChatTool';
import { isWishToolId } from '../wishPool/wishToolContract';
import { cameraLookOnceTool } from '../tools/builtin/cameraObservationTools';
import { CAMERA_LOOK_ONCE_TOOL_ID } from './cameraModelObservationMaterials';

/** Same candidate composition for Android and Windows; no platform access or new model text. */
export function addCameraObservationCandidate(selection: JunLuoToolCandidateSelection, input: {
  entry: 'chat_reply' | 'proactive_contact'; dataEpoch: number; sessionId: string;
}): JunLuoToolCandidateSelection {
  const additionalTools = input.entry === 'chat_reply'
    ? selection.candidates.filter(({ tool }) => tool.packageId === 'proactive_contact'
      || isBodySignalHistoryTool(tool.id) || RESEARCH_CHAT_TOOL_IDS.includes(tool.id)
      || tool.id === BROWSER_OPEN_TOOL_ID || tool.id === 'camera.read_observations'
      || selection.wishPackageEntry && isWishToolId(tool.id)
      || ['schedule.query_routine', 'schedule.save_routine'].includes(tool.id)
      || selection.readingReferenceTools && ['reading.read_material', 'schedule.save_own'].includes(tool.id)) : [];
  const maxTools = input.entry === 'chat_reply' ? 15 + additionalTools.length : 14;
  if (selection.packageDiscovery && !selection.packageDiscovery.alongsideTools
    || selection.candidates.length >= maxTools) return selection;
  const tool = { ...cameraLookOnceTool, chatExposure: 'internal_only' as const, proactiveEligible: true };
  const characters = JSON.stringify({ description: tool.description, id: tool.id,
    inputSchema: tool.inputSchema, name: tool.name }).length;
  const additionalCharacters = additionalTools.reduce((sum, { tool: additional }) => sum + JSON.stringify({
    description: additional.description, id: additional.id, inputSchema: additional.inputSchema, name: additional.name,
  }).length, 0);
  if (selection.serializedCharacterCount + characters > TOOL_CAPABILITY_MAX_SCHEMA_CHARACTERS + additionalCharacters) return selection;
  const candidate = { tool, source: 'manual_activation' as const, strength: 'possible' as const,
    executionMode: 'executable' as const,
    authority: { kind: 'manual_activation' as const, dataEpoch: input.dataEpoch,
      referenceId: input.sessionId, allowedToolIds: [CAMERA_LOOK_ONCE_TOOL_ID] } };
  return { ...selection, mode: 'direct_tools', candidates: [...selection.candidates, candidate],
    executableTools: [...selection.executableTools, tool], tools: [...selection.tools, tool],
    packages: [...new Set([...selection.packages, tool.packageId])],
    reasons: [...selection.reasons, { toolId: tool.id, source: candidate.source, strength: candidate.strength }],
    serializedCharacterCount: selection.serializedCharacterCount + characters };
}
