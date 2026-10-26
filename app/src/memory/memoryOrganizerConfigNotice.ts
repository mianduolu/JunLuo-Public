export const MEMORY_ORGANIZER_CONFIG_TITLE = '需要先配置记忆整理模型';

export const MEMORY_ORGANIZER_CONFIG_MESSAGE =
  '请到 AI 设置的“连接抽屉”，选择一个连接设为“用于整理”，并确认这条连接已经保存 API Key。';

export function hasMemoryOrganizerConfig(input: { connection?: unknown; key?: string }) {
  return !!input.connection && !!input.key?.trim();
}
