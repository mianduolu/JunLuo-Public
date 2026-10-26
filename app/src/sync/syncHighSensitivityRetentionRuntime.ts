import {
  type AndroidSyncDomainConsumer,
} from './syncAndroidDomainConsumer';
import { expoSyncRandomUuidV1 } from './syncCryptoExpo';
import type {
  SyncDevicePublicIdentityV1,
} from './syncDeviceContract';
import {
  buildHighSensitivityRetentionDeleteMutation,
  HIGH_SENSITIVITY_RETENTION_SCAN_LIMIT,
  type HighSensitivityRetentionKind,
  planHighSensitivityRetention,
} from './syncHighSensitivityRetention';
import { createSyncMutationEnvelope } from './syncMutationEnvelope';
import {
  enqueueSyncMutationAndAdvanceHeads,
  listCurrentSingleHeadMutationsForRetention,
  loadHighSensitivityRetentionScanState,
  saveHighSensitivityRetentionScanState,
  syncMutationStatePort,
} from './syncMutationStateStore';

const TARGETS = [
  { domain: 'body-signal', entityType: 'reading' },
  { domain: 'body-signal', entityType: 'care-summary' },
  { domain: 'activity', entityType: 'activity-reading' },
  { domain: 'activity', entityType: 'formal-observation' },
  { domain: 'nearby-world', entityType: 'location-observation' },
  { domain: 'nearby-world', entityType: 'movement-event' },
  { domain: 'tools', entityType: 'visit' },
  { domain: 'tools', entityType: 'audit-event' },
] as const;

const MAX_SCANNED_PER_RUN = 128;
const MAX_SCAN_PAGE_SIZE = 16;
const COMPLETED_RESCAN_INTERVAL_MS = 24 * 60 * 60 * 1_000;

function emptyCounts(): Record<HighSensitivityRetentionKind, number> {
  return {
    'body-signal-reading-3d': 0,
    'body-signal-summary-7d': 0,
    'activity-reading-3d': 0,
    'activity-summary-7d': 0,
    'nearby-location-observation-3d': 0,
    'nearby-movement-event-7d': 0,
    'tools-workspace-visit-3d': 0,
    'tools-audit-event-7d': 0,
  };
}

export type AndroidHighSensitivityRetentionResult = {
  tombstones: number;
  scanned: number;
  counts: Record<HighSensitivityRetentionKind, number>;
  hasMore: boolean;
};

export async function runAndroidHighSensitivityRetention(input: {
  identity: SyncDevicePublicIdentityV1;
  domains: AndroidSyncDomainConsumer;
  now: number;
  maxScanned?: number;
  shouldContinue?: () => boolean;
}): Promise<AndroidHighSensitivityRetentionResult> {
  const maxScanned = input.maxScanned ?? MAX_SCANNED_PER_RUN;
  if (
    !Number.isSafeInteger(maxScanned)
    || maxScanned < 1
    || maxScanned > 512
  ) {
    throw new Error('高敏留存每轮扫描上限必须为 1..512。');
  }
  const shouldContinue = input.shouldContinue ?? (() => true);
  const counts = emptyCounts();
  let tombstones = 0;
  let hasMore = false;
  let scanned = 0;
  const saved = await loadHighSensitivityRetentionScanState();
  let targetIndex = saved?.cursor.targetIndex ?? 0;
  let after = saved && targetIndex < TARGETS.length
    && saved.cursor.createdAt > 0
    ? {
        createdAt: saved.cursor.createdAt,
        entityId: saved.cursor.entityId,
      }
    : undefined;

  if (
    targetIndex === TARGETS.length
    && saved
    && input.now - saved.updatedAt < COMPLETED_RESCAN_INTERVAL_MS
  ) {
    return { tombstones, scanned, counts, hasMore: false };
  }
  if (targetIndex === TARGETS.length) {
    targetIndex = 0;
    after = undefined;
  }

  const persist = () => saveHighSensitivityRetentionScanState({
    cursor: targetIndex === TARGETS.length
      ? { targetIndex, createdAt: 0, entityId: '' }
      : {
          targetIndex,
          createdAt: after?.createdAt ?? 0,
          entityId: after?.entityId ?? '',
        },
    updatedAt: input.now,
  });

  scanTargets:
  while (targetIndex < TARGETS.length) {
    if (scanned >= maxScanned || !shouldContinue()) {
      hasMore = true;
      break;
    }
    const target = TARGETS[targetIndex]!;
    const pageLimit = Math.min(
      HIGH_SENSITIVITY_RETENTION_SCAN_LIMIT,
      MAX_SCAN_PAGE_SIZE,
      maxScanned - scanned,
    );
    const currents = await listCurrentSingleHeadMutationsForRetention({
      ...target,
      limit: pageLimit,
      after,
    });
    if (currents.length === 0) {
      targetIndex += 1;
      after = undefined;
      await persist();
      continue;
    }

    let processed = 0;
    for (const current of currents) {
      if (scanned >= maxScanned || !shouldContinue()) {
        hasMore = true;
        break;
      }
      const plan = planHighSensitivityRetention(current, input.now);
      if (plan) {
        const envelope = await createSyncMutationEnvelope({
          identity: input.identity,
          entity: current.entity,
          state: syncMutationStatePort,
          randomUuid: expoSyncRandomUuidV1,
          now: () => input.now,
        });
        if (
          envelope.parentRevisionIds.length !== 1
          || envelope.parentRevisionIds[0] !== current.revision.id
        ) {
          hasMore = true;
          break scanTargets;
        }
        const tombstone = buildHighSensitivityRetentionDeleteMutation({
          plan,
          envelope,
          deletedAt: input.now,
        });
        await input.domains.validateIncomingMutation(tombstone);
        await input.domains.materializeCurrentMutation(tombstone);
        await enqueueSyncMutationAndAdvanceHeads(tombstone);
        counts[plan.kind] += 1;
        tombstones += 1;
      }
      after = {
        createdAt: current.createdAt,
        entityId: current.entity.id,
      };
      processed += 1;
      scanned += 1;
    }
    if (processed > 0) await persist();
    if (processed < currents.length) {
      hasMore = true;
      break;
    }
    if (currents.length < pageLimit) {
      targetIndex += 1;
      after = undefined;
      await persist();
    }
  }
  if (targetIndex < TARGETS.length) hasMore = true;
  return { tombstones, scanned, counts, hasMore };
}
