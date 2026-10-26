import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import { canCommitBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { loadChatSessionMessage } from './chatStorage';
import { isPokeInteraction, pokeInteractionRevision, type PokeInteraction } from './chatPokeExperience';
import { loadPendingPokeExperiences, removePokeExperiences } from './sleepInteraction';

type PokeRef = { id: string; createdAt: number; revision: string };

export function pokeMaterialRefs(messages: readonly SubjectiveMessage[], facts: readonly PokeInteraction[]) {
  const all = new Map(facts.map(fact => [fact.id, fact]));
  const replied = new Set<string>();
  for (const message of messages) if (message.role === 'I' && message.deliveryStatus !== 'failed'
    && isPokeInteraction(message.pokeInteraction)) {
    all.set(message.pokeInteraction.id, message.pokeInteraction); replied.add(message.pokeInteraction.id);
  }
  return [...all.values()].map(fact => ({ kind: 'poke' as const, id: fact.id,
    createdAt: fact.pokedAt, revision: `${replied.has(fact.id) ? 'reply' : 'fact'}:${pokeInteractionRevision(fact)}` }));
}

export const hasReadPokeReply = (read: Record<string, string> | undefined, id: string) => read?.[id]?.startsWith('reply:') === true;

/** A failed input may ride a real batch, but never creates an opportunity of its own. */
export async function loadUnreadPokeFacts(input: {
  sessionId?: string; through: number; activatedAt: number; read?: Record<string, string>;
  refs?: readonly PokeRef[]; dataEpoch: number | null;
}): Promise<PokeInteraction[]> {
  if (!input.sessionId) return [];
  const pending = await loadPendingPokeExperiences();
  const facts: PokeInteraction[] = [];
  const delivered: string[] = [];
  for (const fact of pending) {
    if (fact.targetSessionId !== input.sessionId) continue;
    if (fact.replyMessageIds?.length) {
      const replies = await Promise.all(fact.replyMessageIds.map(id => loadChatSessionMessage(input.sessionId!, id)));
      if (replies.some(message => message?.role === 'I' && message.deliveryStatus !== 'failed'
        && message.pokeInteraction?.id === fact.id)) { delivered.push(fact.id); continue; }
    }
    if (fact.pokedAt > input.activatedAt && fact.pokedAt <= input.through
      && input.read?.[fact.id] === undefined && (!input.refs || input.refs.some(ref => ref.id === fact.id))) facts.push(fact);
  }
  if (delivered.length) await removePokeExperiences(delivered,
    () => canCommitBackupRestoreDataEpoch(input.dataEpoch));
  return facts.sort((a, b) => a.pokedAt - b.pokedAt || a.id.localeCompare(b.id));
}

export async function pokeMaterialSourcesMatch(refs: readonly PokeRef[], messages: readonly SubjectiveMessage[], sessionId?: string) {
  if (!refs.length) return true;
  const byId = new Map(pokeMaterialRefs(messages, []).map(ref => [ref.id, ref.revision]));
  if (refs.some(ref => !byId.has(ref.id))) for (const fact of await loadPendingPokeExperiences())
    if (!byId.has(fact.id) && fact.targetSessionId === sessionId) byId.set(fact.id, `fact:${pokeInteractionRevision(fact)}`);
  return refs.every(ref => byId.get(ref.id) === ref.revision);
}

export async function pruneReadPokeFacts(wants: Record<string, string> | undefined,
  affect: Record<string, string> | undefined, dataEpoch: number | null) {
  if (!wants || !affect) return;
  const ids = (await loadPendingPokeExperiences()).filter(fact =>
    wants[fact.id] !== undefined && affect[fact.id] !== undefined).map(fact => fact.id);
  if (ids.length) await removePokeExperiences(ids, () => canCommitBackupRestoreDataEpoch(dataEpoch));
}
