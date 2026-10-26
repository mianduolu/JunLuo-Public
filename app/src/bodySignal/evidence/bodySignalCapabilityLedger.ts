export type BodySignalEvidenceStatus =
  | 'verified'
  | 'awaiting_fixture'
  | 'reference_only'
  | 'forbidden';

export type BodySignalWriteAuthorization =
  | 'verified'
  | 'diagnostic_only'
  | 'reference_only'
  | 'forbidden';

export type BodySignalWriteEvidence = {
  purpose: string;
  target: string;
  evidenceId: string;
  authorization: BodySignalWriteAuthorization;
};

export type BodySignalCapabilityEvidence = {
  id: string;
  deviceFamily: string;
  capability: string;
  status: BodySignalEvidenceStatus;
  evidenceIds: readonly string[];
  fixtureHashes: readonly string[];
  verifiedDeviceCount: number;
  verifiedReconnectCount: number;
  writeEvidence?: readonly BodySignalWriteEvidence[];
  notes: string;
};

export type BodySignalProtocolReference = {
  id: string;
  repository: string;
  commit: string;
  commitDate: string;
  localPath: string;
  sourceRanges: readonly string[];
  notes: string;
};

export type BodySignalCapabilityDecision = {
  status: BodySignalEvidenceStatus;
  isVerified: boolean;
  authorizedWritePurposes: readonly string[];
  reason: string;
};

const VERIFIED_EVIDENCE_PREFIXES = [
  'fixture:',
  'true-device:',
  'regression:',
] as const;

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;

function capabilityKey(entry: Pick<BodySignalCapabilityEvidence, 'deviceFamily' | 'capability'>): string {
  return `${entry.deviceFamily}/${entry.capability}`;
}

export function validateBodySignalCapabilityLedger(
  entries: readonly BodySignalCapabilityEvidence[],
): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  const capabilityKeys = new Set<string>();

  for (const entry of entries) {
    if (ids.has(entry.id)) errors.push(`duplicate id: ${entry.id}`);
    ids.add(entry.id);

    const key = capabilityKey(entry);
    if (capabilityKeys.has(key)) errors.push(`duplicate capability: ${key}`);
    capabilityKeys.add(key);

    if (!entry.id.trim() || !entry.deviceFamily.trim() || !entry.capability.trim()) {
      errors.push(`blank identity field: ${entry.id || key}`);
    }
    if (!entry.notes.trim()) errors.push(`missing notes: ${entry.id}`);
    if (!Number.isInteger(entry.verifiedDeviceCount) || entry.verifiedDeviceCount < 0) {
      errors.push(`invalid verifiedDeviceCount: ${entry.id}`);
    }
    if (!Number.isInteger(entry.verifiedReconnectCount) || entry.verifiedReconnectCount < 0) {
      errors.push(`invalid verifiedReconnectCount: ${entry.id}`);
    }

    for (const hash of entry.fixtureHashes) {
      if (!SHA256_PATTERN.test(hash)) errors.push(`invalid fixture hash: ${entry.id}`);
    }

    if (entry.status === 'verified') {
      for (const prefix of VERIFIED_EVIDENCE_PREFIXES) {
        if (!entry.evidenceIds.some((evidenceId) => evidenceId.startsWith(prefix))) {
          errors.push(`verified entry missing ${prefix} evidence: ${entry.id}`);
        }
      }
      if (entry.fixtureHashes.length === 0) errors.push(`verified entry missing fixture hash: ${entry.id}`);
      if (entry.verifiedDeviceCount < 1) errors.push(`verified entry missing device verification: ${entry.id}`);
      if (entry.verifiedReconnectCount < 1) errors.push(`verified entry missing reconnect verification: ${entry.id}`);
    }

    for (const write of entry.writeEvidence ?? []) {
      if (!write.purpose.trim() || !write.target.trim() || !write.evidenceId.trim()) {
        errors.push(`incomplete write evidence: ${entry.id}`);
      }
      if (!entry.evidenceIds.includes(write.evidenceId)) {
        errors.push(`write evidence not linked to entry evidence: ${entry.id}/${write.purpose}`);
      }
      if (write.authorization === 'verified' && entry.status !== 'verified') {
        errors.push(`unverified entry authorizes write: ${entry.id}/${write.purpose}`);
      }
      if (
        (entry.status === 'reference_only' || entry.status === 'forbidden')
        && write.authorization === 'verified'
      ) {
        errors.push(`reference or forbidden entry authorizes write: ${entry.id}/${write.purpose}`);
      }
    }
  }

  return errors;
}

export function findBodySignalCapabilityEvidence(
  entries: readonly BodySignalCapabilityEvidence[],
  deviceFamily: string,
  capability: string,
): BodySignalCapabilityEvidence | undefined {
  return entries.find((entry) => (
    entry.deviceFamily === deviceFamily && entry.capability === capability
  ));
}

export function decideBodySignalCapability(
  entries: readonly BodySignalCapabilityEvidence[],
  deviceFamily: string,
  capability: string,
): BodySignalCapabilityDecision {
  const entry = findBodySignalCapabilityEvidence(entries, deviceFamily, capability);
  if (!entry) {
    return {
      status: 'forbidden',
      isVerified: false,
      authorizedWritePurposes: [],
      reason: '能力账本没有登记，按默认拒绝处理。',
    };
  }

  const authorizedWritePurposes = entry.status === 'verified'
    ? (entry.writeEvidence ?? [])
      .filter((write) => write.authorization === 'verified')
      .map((write) => write.purpose)
    : [];

  return {
    status: entry.status,
    isVerified: entry.status === 'verified',
    authorizedWritePurposes,
    reason: entry.notes,
  };
}

export function canAuthorizeBodySignalWrite(
  entries: readonly BodySignalCapabilityEvidence[],
  deviceFamily: string,
  capability: string,
  purpose: string,
): boolean {
  return decideBodySignalCapability(entries, deviceFamily, capability)
    .authorizedWritePurposes.includes(purpose);
}
