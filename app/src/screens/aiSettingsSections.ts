import type { ScreenName } from '../types/navigation';

// Six direct Settings entries, not another navigation hub.
export const aiSettingsSections = [
  { route: 'ai-settings', title: '模型连接', description: '连接、模型分工与参数', accent: '#FFA997' },
  { route: 'ai-diagnostics', title: '答卷诊断与维护', description: '回复经过、坏卷与维护操作', accent: '#98CCC8' },
  { route: 'phone-manager', title: '本机小管家', description: '手机权限、使用记录与名单', accent: '#EDC180' },
  { route: 'memory-settings', title: '记忆设置', description: '主动记忆、检索与重排', accent: '#A8BCE2' },
  { route: 'proactive-settings', title: '主动联系与生活', description: '主动消息、后台调用与生活开关', accent: '#AED1AE' },
  { route: 'relationship-settings', title: '相处与表情', description: '相处设定、关于我与表情包', accent: '#D3B4CC' },
] as const satisfies ReadonlyArray<{ route: ScreenName; title: string; description: string; accent: string }>;

export type AiSettingsSection = typeof aiSettingsSections[number]['route'];

export function isAiSettingsSection(screen: ScreenName): screen is AiSettingsSection {
  return aiSettingsSections.some(section => section.route === screen);
}
