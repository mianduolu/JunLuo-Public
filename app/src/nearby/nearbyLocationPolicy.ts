import type { NearbyWorldStatus } from './nearbyWorldStore';

export const FRESH_LOCATION_MS = 5 * 60 * 1000;
export type LocationEvidence = { latitude: number; longitude: number; accuracy?: number | null; timestamp: number };

export function validLocationPoint(point: LocationEvidence, now = Date.now()): boolean {
  return Number.isFinite(point.latitude) && Math.abs(point.latitude) <= 90
    && Number.isFinite(point.longitude) && Math.abs(point.longitude) <= 180
    && Number.isFinite(point.timestamp) && point.timestamp > 0 && point.timestamp <= now;
}

export function isFreshLocation(point: LocationEvidence, now = Date.now(), maxAccuracy = 100): boolean {
  return validLocationPoint(point, now) && now - point.timestamp <= FRESH_LOCATION_MS
    && typeof point.accuracy === 'number' && Number.isFinite(point.accuracy)
    && point.accuracy >= 0 && point.accuracy <= maxAccuracy;
}

export function isFreshNearbyStatus(status: NearbyWorldStatus, now = Date.now()): boolean {
  return status.coordinateSystem === 'wgs84' && isFreshLocation({
    latitude: status.latitude!, longitude: status.longitude!, accuracy: status.accuracy, timestamp: status.updatedAt!,
  }, now);
}

export function locationDistance(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) {
  const rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad;
  const dLon = (b.longitude - a.longitude) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
}

/** Caller passes only a report whose original message still exists unchanged. */
export function resolveNearbyPresence(status: NearbyWorldStatus, now = Date.now()): NearbyWorldStatus['presence'] {
  const report = status.presenceReport;
  const currentReport = report && Number.isFinite(report.sentAt) && report.sentAt <= now && now - report.sentAt <= FRESH_LOCATION_MS;
  const reliableAway = isFreshNearbyStatus(status, now) && typeof status.distanceFromHome === 'number'
    && status.distanceFromHome - (status.accuracy ?? 0) > 220;
  if (currentReport) {
    if (reliableAway && status.updatedAt! > report.sentAt) return 'outside';
    return report.state === '在家' ? 'at_home' : report.state === '在外' ? 'outside' : 'unknown';
  }
  return reliableAway ? 'outside' : 'unknown';
}

export function shouldAttemptAutomaticMap(status: NearbyWorldStatus, point: LocationEvidence, now = Date.now()) {
  if (!isFreshLocation(point, now) || status.mapQuotaPause) return false;
  const previous = status.mapAttempt;
  if (!previous) return true;
  return now - previous.at >= 10 * 60 * 1000
    && locationDistance(previous, point) - previous.accuracy - point.accuracy! >= 200;
}
