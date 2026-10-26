export type TogetherWalkedLocation = {
  latitude?: number;
  longitude?: number;
  accuracy?: number;
  label?: string;
};

export type TogetherWalkedEntry = {
  id: string;
  title: string;
  note: string;
  imageUri?: string;
  location?: TogetherWalkedLocation;
  journeyId?: string;
  createdAt: number;
  updatedAt: number;
  memoryId?: string;
};

export type TogetherWalkedJourney = {
  id: string;
  title: string;
  description: string;
  createdAt: number;
  updatedAt: number;
};

export type TogetherWalkedRoutePoint = {
  entryId: string;
  title: string;
  latitude: number;
  longitude: number;
};

export type TogetherWalkedJourneySummary = {
  journey: TogetherWalkedJourney;
  entries: TogetherWalkedEntry[];
  coverImageUri?: string;
  startAt?: number;
  endAt?: number;
  latestAt: number;
  placeLabels: string[];
  routePoints: TogetherWalkedRoutePoint[];
};

export function isUsableTogetherWalkedCoordinate(latitude?: number, longitude?: number) {
  if (typeof latitude !== 'number' || typeof longitude !== 'number') return false;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return false;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return false;
  return !(latitude === 0 && longitude === 0);
}

export function normalizeTogetherWalkedLocation(value: unknown): TogetherWalkedLocation | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const location = value as Partial<TogetherWalkedLocation>;
  const label = typeof location.label === 'string' ? location.label.trim() : '';
  const latitude = typeof location.latitude === 'number' ? location.latitude : undefined;
  const longitude = typeof location.longitude === 'number' ? location.longitude : undefined;
  const hasCoordinate = isUsableTogetherWalkedCoordinate(latitude, longitude);
  if (!hasCoordinate && !label) return undefined;
  return {
    latitude: hasCoordinate ? latitude : undefined,
    longitude: hasCoordinate ? longitude : undefined,
    accuracy: typeof location.accuracy === 'number' && Number.isFinite(location.accuracy) ? location.accuracy : undefined,
    label: label || undefined,
  };
}

export function normalizeTogetherWalkedEntry(value: unknown): TogetherWalkedEntry | null {
  if (!value || typeof value !== 'object') return null;
  const entry = value as Partial<TogetherWalkedEntry>;
  if (typeof entry.id !== 'string' || typeof entry.title !== 'string') return null;
  if (typeof entry.createdAt !== 'number' || !Number.isFinite(entry.createdAt)) return null;
  if (typeof entry.updatedAt !== 'number' || !Number.isFinite(entry.updatedAt)) return null;
  const journeyId = typeof entry.journeyId === 'string' ? entry.journeyId.trim() : '';
  return {
    id: entry.id,
    title: entry.title,
    note: typeof entry.note === 'string' ? entry.note : '',
    imageUri: typeof entry.imageUri === 'string' ? entry.imageUri : undefined,
    location: normalizeTogetherWalkedLocation(entry.location),
    journeyId: journeyId || undefined,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    memoryId: typeof entry.memoryId === 'string' ? entry.memoryId : undefined,
  };
}

export function normalizeTogetherWalkedJourney(value: unknown): TogetherWalkedJourney | null {
  if (!value || typeof value !== 'object') return null;
  const journey = value as Partial<TogetherWalkedJourney>;
  if (typeof journey.id !== 'string' || typeof journey.title !== 'string' || !journey.title.trim()) return null;
  if (typeof journey.createdAt !== 'number' || !Number.isFinite(journey.createdAt)) return null;
  if (typeof journey.updatedAt !== 'number' || !Number.isFinite(journey.updatedAt)) return null;
  return {
    id: journey.id,
    title: journey.title.trim(),
    description: typeof journey.description === 'string' ? journey.description.trim() : '',
    createdAt: journey.createdAt,
    updatedAt: journey.updatedAt,
  };
}

export function sortTogetherWalkedEntries(entries: TogetherWalkedEntry[]) {
  return [...entries].sort((left, right) => right.createdAt - left.createdAt);
}

export function resolveTogetherWalkedJourneyAssignments(entries: TogetherWalkedEntry[], journeys: TogetherWalkedJourney[]) {
  const journeyIds = new Set(journeys.map((journey) => journey.id));
  return entries.map((entry) => entry.journeyId && !journeyIds.has(entry.journeyId) ? { ...entry, journeyId: undefined } : entry);
}

export function assignTogetherWalkedEntriesModel(
  entries: TogetherWalkedEntry[],
  entryIds: string[],
  journeyId: string | undefined,
  updatedAt: number,
) {
  const ids = new Set(entryIds);
  return entries.map((entry) => ids.has(entry.id) ? { ...entry, journeyId, updatedAt } : entry);
}

export function deleteTogetherWalkedJourneyModel(
  journeys: TogetherWalkedJourney[],
  entries: TogetherWalkedEntry[],
  journeyId: string,
  deleteEntries: boolean,
  updatedAt: number,
) {
  const deletedEntries = entries.filter((entry) => entry.journeyId === journeyId);
  return {
    journeys: journeys.filter((journey) => journey.id !== journeyId),
    entries: deleteEntries
      ? entries.filter((entry) => entry.journeyId !== journeyId)
      : assignTogetherWalkedEntriesModel(entries, deletedEntries.map((entry) => entry.id), undefined, updatedAt),
    deletedEntries: deleteEntries ? deletedEntries : [],
  };
}

export function buildTogetherWalkedJourneySummaries(
  journeys: TogetherWalkedJourney[],
  entries: TogetherWalkedEntry[],
): TogetherWalkedJourneySummary[] {
  const resolvedEntries = resolveTogetherWalkedJourneyAssignments(entries, journeys);
  return journeys
    .map((journey) => {
      const journeyEntries = resolvedEntries
        .filter((entry) => entry.journeyId === journey.id)
        .sort((left, right) => left.createdAt - right.createdAt);
      const placeLabels: string[] = [];
      for (const entry of journeyEntries) {
        const label = entry.location?.label?.trim();
        if (label && placeLabels[placeLabels.length - 1] !== label) placeLabels.push(label);
      }
      const routePoints = journeyEntries
        .filter((entry) => isUsableTogetherWalkedCoordinate(entry.location?.latitude, entry.location?.longitude))
        .map((entry) => ({
          entryId: entry.id,
          title: entry.title,
          latitude: entry.location!.latitude!,
          longitude: entry.location!.longitude!,
        }));
      const startAt = journeyEntries[0]?.createdAt;
      const endAt = journeyEntries[journeyEntries.length - 1]?.createdAt;
      return {
        journey,
        entries: journeyEntries,
        coverImageUri: journeyEntries.find((entry) => !!entry.imageUri)?.imageUri,
        startAt,
        endAt,
        latestAt: endAt ?? journey.updatedAt,
        placeLabels,
        routePoints,
      };
    })
    .sort((left, right) => right.latestAt - left.latestAt);
}
