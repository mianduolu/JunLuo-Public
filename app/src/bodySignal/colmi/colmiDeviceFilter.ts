export const COLMI_RING_NAME_PATTERN = /^R0\d_[0-9A-Z]{4}$/;

export const COLMI_TARGET_MODEL_NAMES = ['R02', 'R06', 'R10', 'R12'] as const;
export const COLMI_TARGET_DEVICE_NAME_KEYWORDS = [...COLMI_TARGET_MODEL_NAMES, 'Ring', 'Yawell', 'Colmi', 'R99'] as const;
export const SUPPORTED_MI_BAND_6_NAMES = ['Mi Smart Band 6', 'Xiaomi Smart Band 6', 'Mi Band 6'] as const;

export const COLMI_NEARBY_DEBUG_RSSI_THRESHOLD = -82;

export type ColmiScanConfidence = 'strong' | 'model' | 'weak' | 'nearby' | 'none';

export type ColmiScanCandidateInput = {
  id?: string | null;
  name?: string | null;
  localName?: string | null;
};

export type ColmiScanCandidateRank = {
  confidence: ColmiScanConfidence;
  displayName: string;
  isMatch: boolean;
  matchedKeyword?: string;
  score: number;
};

export function normalizeBleName(value?: string | null): string {
  return (value ?? '').trim().replace(/\s+/g, ' ');
}

function getCandidateNames(candidate: ColmiScanCandidateInput): string[] {
  const names = [candidate.name, candidate.localName]
    .map(normalizeBleName)
    .filter((name): name is string => name.length > 0);
  return Array.from(new Set(names));
}

export function rankColmiScanCandidate(candidate: ColmiScanCandidateInput | string): ColmiScanCandidateRank {
  const input = typeof candidate === 'string' ? { name: candidate } : candidate;
  const names = getCandidateNames(input);
  const displayName = names[0] ?? 'Unknown COLMI device';

  for (const name of names) {
    if (COLMI_RING_NAME_PATTERN.test(name)) {
      return { confidence: 'strong', displayName, isMatch: true, matchedKeyword: name, score: 100 };
    }
  }

  for (const supportedName of SUPPORTED_MI_BAND_6_NAMES) {
    if (names.some((name) => name.toLowerCase() === supportedName.toLowerCase())) {
      return { confidence: 'strong', displayName, isMatch: true, matchedKeyword: supportedName, score: 100 };
    }
  }

  for (const keyword of COLMI_TARGET_MODEL_NAMES) {
    if (names.some((name) => name.toUpperCase().includes(keyword))) {
      return { confidence: 'model', displayName, isMatch: true, matchedKeyword: keyword, score: 80 };
    }
  }

  for (const keyword of ['Colmi', 'Yawell', 'Ring', 'R99']) {
    if (names.some((name) => name.toLowerCase().includes(keyword.toLowerCase()))) {
      return { confidence: 'weak', displayName, isMatch: true, matchedKeyword: keyword, score: 40 };
    }
  }

  return { confidence: 'none', displayName, isMatch: false, score: 0 };
}

export function isLikelyColmiRingName(value?: string | null): boolean {
  return rankColmiScanCandidate(value ?? '').isMatch;
}

export function shouldShowNearbyBleDebugCandidate(candidate: ColmiScanCandidateInput | string, rssi?: number | null): boolean {
  if (typeof rssi !== 'number') return false;
  if (rssi < COLMI_NEARBY_DEBUG_RSSI_THRESHOLD) return false;
  return !rankColmiScanCandidate(candidate).isMatch;
}
