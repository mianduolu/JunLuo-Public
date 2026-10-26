export type WeatherMapNearbyPendingInput = {
  actionId: string;
  sourceSessionId: string;
  sourceMessageId: string;
  primaryToolId: string;
  fallbackToolIds: string[];
  requiredInputKeys: readonly ['place'];
  dataEpoch: number;
  createdAt: number;
  expiresAt: number;
};

export type WeatherMapNearbyPendingInputResolution =
  | { kind: 'none' }
  | { kind: 'cancel'; actionId: string }
  | { kind: 'ambiguous'; actionIds: string[] }
  | { kind: 'place'; actionId: string; place: string };

const CANCEL_PATTERN = /^(?:算了|不用了|取消)[！!。.]?$/u;
const AMBIGUOUS_PLACE_PATTERN = /^(?:那里|那边|这里|这边|附近|随便|都行|都可以|你看着办)[！!。.]?$/u;
const PLACE_PATTERN = /^[\p{Script=Han}A-Za-z0-9·（）()\-]{2,32}$/u;

export function resolveWeatherMapNearbyPendingInput(
  pendingInputs: readonly WeatherMapNearbyPendingInput[],
  youText: string,
  input: {
    dataEpoch: number;
    now?: number;
  },
): WeatherMapNearbyPendingInputResolution {
  const now = input.now ?? Date.now();
  const valid = pendingInputs.filter((pending) => (
    pending.dataEpoch === input.dataEpoch
    && pending.expiresAt > now
  ));
  if (!valid.length) return { kind: 'none' };
  const trimmed = youText.trim();
  if (CANCEL_PATTERN.test(trimmed)) {
    return valid.length === 1
      ? { kind: 'cancel', actionId: valid[0].actionId }
      : { kind: 'ambiguous', actionIds: valid.map((pending) => pending.actionId) };
  }
  if (valid.length !== 1 || AMBIGUOUS_PLACE_PATTERN.test(trimmed) || !PLACE_PATTERN.test(trimmed)) {
    return { kind: 'ambiguous', actionIds: valid.map((pending) => pending.actionId) };
  }
  return { kind: 'place', actionId: valid[0].actionId, place: trimmed };
}
