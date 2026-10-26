import type { MusicSong } from '../ai/subjectiveMessages';
import { executeToolCall } from '../tools/toolExecution';
import { registerBuiltinTools } from '../tools/builtin/registerBuiltinTools';
import { getToolDefinition, listToolPackages } from '../tools/toolRegistry';
import { resolveToolPermissionForCall } from '../tools/toolPermissions';
import { loadToolPermissionSettings } from '../tools/toolPermissionStore';

export async function canUseChatReminder() {
  registerBuiltinTools();
  await loadToolPermissionSettings({ strict: true });
  const tool = getToolDefinition('reminder.propose_reminders');
  return !!tool && !!listToolPackages().find(pack => pack.id === 'reminder')?.defaultEnabled
    && (await resolveToolPermissionForCall(tool, { requestedBy: 'chat', input: {} })).permission !== 'deny';
}

export async function canUseChatReminderMusic() {
  registerBuiltinTools();
  if (!await canUseChatReminder()) return false;
  for (const id of ['reminder', 'alarm', 'music']) if (!listToolPackages().find(pack => pack.id === id)?.defaultEnabled) return false;
  for (const id of ['alarm.create', 'music.play']) {
    const tool = getToolDefinition(id);
    if (!tool || (await resolveToolPermissionForCall(tool, { requestedBy: 'chat', input: {} })).permission === 'deny') return false;
  }
  return true;
}
/** The original search capability resolves a real song; creating a reminder never plays it. */
export async function resolveReminderSong(song: { title: string; artist: string }, callId: string,
  isCurrent: () => Promise<boolean>): Promise<MusicSong> {
  if (!await isCurrent() || !await canUseChatReminderMusic()) throw new Error('PERMISSION_DENIED');
  const result = await executeToolCall({ callId: `reminder-song:${callId}`, toolId: 'music.search_candidates',
    input: { keyword: `${song.title} ${song.artist}` }, requestedBy: 'chat', createdAt: Date.now() });
  if (!await isCurrent()) throw new Error('REMINDER_SOURCE_CHANGED');
  const resolved = (result.data as { song?: MusicSong } | undefined)?.song;
  if (!result.ok || !resolved?.id || !resolved.name) throw new Error('MUSIC_UNRESOLVED');
  return resolved;
}
