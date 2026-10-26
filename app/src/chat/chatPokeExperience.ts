import { getTheaterBackstageContext, type TheaterBackstageMessageSource } from '../ai/subjectiveMessages';

/** A real input event, never a synthetic you message or an extra model task. */
export type PokeInteraction = {
  id: string;
  pokedAt: number;
  sourceSessionId: string | null;
  anchorId: string;
  wokeAt?: number;
  sleepMessageIds?: string[];
  replyToMessageIds?: string[];
};

export type PendingPokeExperience = PokeInteraction & {
  targetSessionId: string | null;
  replyMessageIds?: string[];
};

export function createPokeInteraction(anchorId: string, sourceSessionId: string | null, pokedAt = Date.now()): PokeInteraction {
  return { id: `poke:${pokedAt}:${Math.random().toString(36).slice(2)}`, pokedAt, sourceSessionId, anchorId };
}

export function isPokeInteraction(value: unknown): value is PokeInteraction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as PokeInteraction;
  return typeof v.id === 'string' && !!v.id.trim()
    && typeof v.pokedAt === 'number' && Number.isFinite(v.pokedAt) && v.pokedAt >= 0
    && (v.sourceSessionId === null || typeof v.sourceSessionId === 'string')
    && typeof v.anchorId === 'string'
    && (v.wokeAt === undefined || (Number.isFinite(v.wokeAt) && v.wokeAt >= v.pokedAt))
    && [v.sleepMessageIds, v.replyToMessageIds].every(ids => ids === undefined || (Array.isArray(ids)
      && ids.every(id => typeof id === 'string' && !!id)));
}

export function pokeInteractionRevision(poke: PokeInteraction): string {
  const text = JSON.stringify([poke.id, poke.pokedAt, poke.sourceSessionId, poke.anchorId,
    poke.wokeAt ?? null, poke.sleepMessageIds ?? [], poke.replyToMessageIds ?? []]);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

/** Preserve the legacy revision for messages without interaction or story metadata. */
export function chatExperienceRevisionValue(message: {
  role: 'I' | 'you'; content: string; pokeInteraction?: PokeInteraction;
  theaterBackstage?: TheaterBackstageMessageSource;
}) {
  const value = message.pokeInteraction
    ? [message.role, message.content, pokeInteractionRevision(message.pokeInteraction)]
    : [message.role, message.content];
  const source = getTheaterBackstageContext(message) ? message.theaterBackstage : undefined;
  return source ? [...value, [source.batchId, source.replyId, source.storyId,
    source.branchId, source.mode, source.useNumber]] : value;
}
