export type DreamSleepEpisode = {
  durationMinutes: number;
  endedAt?: number;
  id: string;
  isMain: boolean;
  startedAt: number;
};

export type DreamRhythmSnapshot = {
  phase: string;
  restQuality: number;
  sleepEpisode?: DreamSleepEpisode;
};

const DREAM_CHANCE = 0.4;
const DREAM_MIN_SLEEP_MINUTES = 90;
const DREAM_RECENT_SLEEP_MS = 12 * 60 * 60 * 1000;

function clamp(value: number, min = 0, max = 1, fallback = 0.5) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function isDeepNight(date: Date) {
  const hour = date.getHours();
  return hour >= 2 && hour < 5;
}

function isMorningBackfill(date: Date) {
  const hour = date.getHours();
  return hour >= 6 && hour < 11;
}

export function getEligibleDreamSleepEpisode(
  rhythmSnapshot: DreamRhythmSnapshot | null | undefined,
  now: number,
): DreamSleepEpisode | null {
  const episode = rhythmSnapshot?.sleepEpisode;
  if (!episode || !episode.isMain || episode.durationMinutes < DREAM_MIN_SLEEP_MINUTES) return null;
  if (episode.endedAt === undefined) {
    return rhythmSnapshot?.phase === 'sleeping' && isDeepNight(new Date(now)) ? episode : null;
  }
  if (!isMorningBackfill(new Date(now))) return null;
  if (episode.endedAt > now || now - episode.endedAt > DREAM_RECENT_SLEEP_MS) return null;
  return episode;
}

export function shouldAttemptDreamEpisode(lastAttemptEpisodeId: string | undefined, episode: DreamSleepEpisode) {
  return lastAttemptEpisodeId !== episode.id;
}

export function calculateDreamChance({
  episode,
  rhythmSnapshot,
}: {
  episode: DreamSleepEpisode;
  rhythmSnapshot: DreamRhythmSnapshot;
}) {
  const durationHours = episode.durationMinutes / 60;
  const durationAdjustment = clamp((durationHours - 7) * 0.02, -0.06, 0.08, 0);
  const qualityAdjustment = clamp((rhythmSnapshot.restQuality - 0.62) * 0.15, -0.05, 0.05, 0);
  return clamp(DREAM_CHANCE + durationAdjustment + qualityAdjustment, 0.20, 0.65, DREAM_CHANCE);
}
