export const BODY_SIGNAL_HISTORY_TOOL_IDS = [
  'body_signal.get_steps_history',
  'body_signal.get_sleep_history',
] as const;

export const BODY_SIGNAL_HISTORY_USE_DESCRIPTION = 'I 想在多了解 you 的身体近况时，可以翻翻已存记录。';
export const BODY_SIGNAL_STEPS_HISTORY_DESCRIPTION = '查看 you 近七天的已记录步数和记录情况。';
export const BODY_SIGNAL_SLEEP_HISTORY_DESCRIPTION = '查看 you 近七天的主要睡眠时长。';

export function isBodySignalHistoryTool(toolId: string) {
  return BODY_SIGNAL_HISTORY_TOOL_IDS.some(id => id === toolId);
}

/** Apply the approved shared line once to the actual request, never to the registry. */
export function withBodySignalHistoryToolDescription<T extends { id: string; description: string }>(
  tools: readonly T[],
): T[] {
  let first = true;
  return tools.map(tool => {
    if (!isBodySignalHistoryTool(tool.id)) return tool;
    const description = tool.id === 'body_signal.get_steps_history'
      ? BODY_SIGNAL_STEPS_HISTORY_DESCRIPTION : BODY_SIGNAL_SLEEP_HISTORY_DESCRIPTION;
    const next = first ? `${BODY_SIGNAL_HISTORY_USE_DESCRIPTION}\n${description}` : description;
    first = false;
    return { ...tool, description: next };
  });
}
