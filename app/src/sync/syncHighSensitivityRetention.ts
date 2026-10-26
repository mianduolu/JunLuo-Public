import type { ChatCoreMutationEnvelope } from './syncChatCore';
import {
  ACTIVITY_DAILY_SUMMARY_RETENTION_DAYS,
  ACTIVITY_DEFAULT_RAW_RETENTION_DAYS,
  activityObservationsDeletePayload,
  activityObservationsPayload,
  buildActivityObservationsMutation,
} from './syncActivityObservations';
import {
  BODY_SIGNAL_DAILY_SUMMARY_RETENTION_DAYS,
  BODY_SIGNAL_DEFAULT_RAW_RETENTION_DAYS,
  bodySignalHealthDeletePayload,
  bodySignalHealthPayload,
  buildBodySignalHealthMutation,
} from './syncBodySignalHealth';
import {
  assertNearbyWorldHealthMutationV1,
  buildNearbyWorldHealthDeleteMutation,
  NEARBY_WORLD_MOVEMENT_EVENT_RETENTION_MS,
  NEARBY_WORLD_PRECISE_LOCATION_RETENTION_MS,
} from './syncNearbyWorldHealth';
import type { PlainMutationV1 } from './syncProtocol';
import {
  assertToolsAuditMutationV1,
  buildToolsAuditEventDeleteMutation,
  TOOLS_AUDIT_EVENT_RETENTION_MS,
} from './syncToolsAudit';
import {
  assertToolsWorkspaceMutationV1,
  buildToolsWorkspaceDeleteMutation,
  toolsWorkspaceMutationValue,
  TOOLS_WORKSPACE_VISIT_RETENTION_MS,
  type ToolsWorkspaceVisit,
} from './syncToolsWorkspace';

export const HIGH_SENSITIVITY_RETENTION_SCAN_LIMIT = 128;

export type HighSensitivityRetentionKind =
  | 'body-signal-reading-3d'
  | 'body-signal-summary-7d'
  | 'activity-reading-3d'
  | 'activity-summary-7d'
  | 'nearby-location-observation-3d'
  | 'nearby-movement-event-7d'
  | 'tools-workspace-visit-3d'
  | 'tools-audit-event-7d';

export type HighSensitivityRetentionPlan = {
  kind: HighSensitivityRetentionKind;
  entityId: string;
  localId?: string;
  activitySummaryKind?: 'activity-day-summary' | 'activity-daily-usage';
  expiresAt: number;
};

function assertNow(now: number) {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error('高敏留存扫描时间无效。');
  }
}

function recordOf(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function timestamp(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : null;
}

function expiredPlan(input: HighSensitivityRetentionPlan, now: number) {
  return input.expiresAt <= now ? input : null;
}

function retentionMs(days: number) {
  return days * 24 * 60 * 60 * 1_000;
}

function dateKeyExpiresAt(value: unknown, days: number) {
  if (typeof value !== 'string') return null;
  const start = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(start) ? start + retentionMs(days) : null;
}

export function planHighSensitivityRetention(
  mutation: PlainMutationV1,
  now: number,
): HighSensitivityRetentionPlan | null {
  assertNow(now);
  if (mutation.revision.operation === 'delete') return null;

  if (
    mutation.entity.domain === 'body-signal'
    && mutation.entity.type === 'reading'
  ) {
    const payload = bodySignalHealthPayload(mutation);
    if (payload.kind !== 'body-signal-reading' || !('record' in payload)) {
      return null;
    }
    return expiredPlan({
      kind: 'body-signal-reading-3d',
      entityId: mutation.entity.id,
      expiresAt: Math.min(
        payload.record.retentionUntil,
        payload.record.measuredAt
          + retentionMs(BODY_SIGNAL_DEFAULT_RAW_RETENTION_DAYS),
      ),
    }, now);
  }

  if (
    mutation.entity.domain === 'body-signal'
    && mutation.entity.type === 'care-summary'
  ) {
    const payload = bodySignalHealthPayload(mutation);
    if (payload.kind !== 'body-signal-care-summary' || !('record' in payload)) {
      return null;
    }
    const expiresAt = dateKeyExpiresAt(
      payload.record.dateKey,
      BODY_SIGNAL_DAILY_SUMMARY_RETENTION_DAYS,
    );
    return expiresAt === null ? null : expiredPlan({
      kind: 'body-signal-summary-7d',
      entityId: mutation.entity.id,
      expiresAt,
    }, now);
  }

  if (
    mutation.entity.domain === 'activity'
    && mutation.entity.type === 'activity-reading'
  ) {
    const payload = activityObservationsPayload(mutation);
    if (payload.kind !== 'activity-reading' || !('record' in payload)) {
      return null;
    }
    return expiredPlan({
      kind: 'activity-reading-3d',
      entityId: mutation.entity.id,
      expiresAt: Math.min(
        payload.record.retentionUntil,
        payload.record.createdAt
          + retentionMs(ACTIVITY_DEFAULT_RAW_RETENTION_DAYS),
      ),
    }, now);
  }

  if (
    mutation.entity.domain === 'activity'
    && mutation.entity.type === 'formal-observation'
  ) {
    const payload = activityObservationsPayload(mutation);
    if (
      !('record' in payload)
      || (
        payload.kind !== 'activity-day-summary'
        && payload.kind !== 'activity-daily-usage'
      )
    ) {
      return null;
    }
    const expiresAt = dateKeyExpiresAt(
      payload.record.dateKey,
      ACTIVITY_DAILY_SUMMARY_RETENTION_DAYS,
    );
    return expiresAt === null ? null : expiredPlan({
      kind: 'activity-summary-7d',
      entityId: mutation.entity.id,
      activitySummaryKind: payload.kind,
      expiresAt,
    }, now);
  }

  if (
    mutation.entity.domain === 'nearby-world'
    && mutation.entity.type === 'location-observation'
  ) {
    assertNearbyWorldHealthMutationV1(mutation);
    const payload = recordOf(mutation.payload);
    const value = recordOf(payload?.value);
    const retainedUntil = timestamp(value?.retainedUntil);
    const observedAt = timestamp(value?.observedAt);
    if (
      payload?.kind !== 'nearby-location-observation'
      || retainedUntil === null
      || observedAt === null
    ) {
      return null;
    }
    return expiredPlan({
      kind: 'nearby-location-observation-3d',
      entityId: mutation.entity.id,
      expiresAt: Math.min(
        retainedUntil,
        observedAt + NEARBY_WORLD_PRECISE_LOCATION_RETENTION_MS,
      ),
    }, now);
  }

  if (
    mutation.entity.domain === 'nearby-world'
    && mutation.entity.type === 'movement-event'
  ) {
    assertNearbyWorldHealthMutationV1(mutation);
    const payload = recordOf(mutation.payload);
    const value = recordOf(payload?.value);
    const observedAt = timestamp(value?.observedAt);
    if (payload?.kind !== 'nearby-movement-event' || observedAt === null) {
      return null;
    }
    return expiredPlan({
      kind: 'nearby-movement-event-7d',
      entityId: mutation.entity.id,
      expiresAt: observedAt + NEARBY_WORLD_MOVEMENT_EVENT_RETENTION_MS,
    }, now);
  }

  if (
    mutation.entity.domain === 'tools'
    && mutation.entity.type === 'visit'
  ) {
    assertToolsWorkspaceMutationV1(mutation);
    const decoded = toolsWorkspaceMutationValue(mutation);
    if (decoded.kind !== 'visit' || !decoded.value) return null;
    const visit = decoded.value as ToolsWorkspaceVisit;
    const activityAt = timestamp(visit.readAt ?? visit.openedAt);
    if (activityAt === null) return null;
    return expiredPlan({
      kind: 'tools-workspace-visit-3d',
      entityId: mutation.entity.id,
      localId: visit.recordId,
      expiresAt: activityAt + TOOLS_WORKSPACE_VISIT_RETENTION_MS,
    }, now);
  }

  if (
    mutation.entity.domain === 'tools'
    && mutation.entity.type === 'audit-event'
  ) {
    assertToolsAuditMutationV1(mutation);
    const payload = recordOf(mutation.payload);
    const value = recordOf(payload?.value);
    const terminal = ['permission_denied', 'success', 'error', 'cancelled']
      .includes(String(value?.status ?? ''));
    const activityAt = terminal
      ? timestamp(value?.finishedAt ?? value?.createdAt)
      : null;
    if (payload?.kind !== 'audit-event' || activityAt === null) return null;
    return expiredPlan({
      kind: 'tools-audit-event-7d',
      entityId: mutation.entity.id,
      expiresAt: activityAt + TOOLS_AUDIT_EVENT_RETENTION_MS,
    }, now);
  }

  return null;
}

export function buildHighSensitivityRetentionDeleteMutation(input: {
  plan: HighSensitivityRetentionPlan;
  envelope: ChatCoreMutationEnvelope;
  deletedAt: number;
}) {
  assertNow(input.deletedAt);
  if (input.plan.entityId.length < 1 || input.plan.entityId.length > 256) {
    throw new Error('高敏留存实体 ID 无效。');
  }
  if (input.plan.kind === 'body-signal-reading-3d') {
    return buildBodySignalHealthMutation({
      envelope: input.envelope,
      entityType: 'reading',
      entityId: input.plan.entityId,
      operation: 'delete',
      payload: bodySignalHealthDeletePayload({
        kind: 'body-signal-reading',
        entityId: input.plan.entityId,
        deletedAt: input.deletedAt,
      }),
    });
  }
  if (input.plan.kind === 'body-signal-summary-7d') {
    return buildBodySignalHealthMutation({
      envelope: input.envelope,
      entityType: 'care-summary',
      entityId: input.plan.entityId,
      operation: 'delete',
      payload: bodySignalHealthDeletePayload({
        kind: 'body-signal-care-summary',
        entityId: input.plan.entityId,
        deletedAt: input.deletedAt,
      }),
    });
  }
  if (input.plan.kind === 'activity-reading-3d') {
    return buildActivityObservationsMutation({
      envelope: input.envelope,
      entityType: 'activity-reading',
      entityId: input.plan.entityId,
      operation: 'delete',
      payload: activityObservationsDeletePayload({
        kind: 'activity-reading',
        entityId: input.plan.entityId,
        deletedAt: input.deletedAt,
      }),
    });
  }
  if (input.plan.kind === 'activity-summary-7d') {
    if (!input.plan.activitySummaryKind) {
      throw new Error('活动日汇总留存墓碑缺少记录类型。');
    }
    return buildActivityObservationsMutation({
      envelope: input.envelope,
      entityType: 'formal-observation',
      entityId: input.plan.entityId,
      operation: 'delete',
      payload: activityObservationsDeletePayload({
        kind: input.plan.activitySummaryKind,
        entityId: input.plan.entityId,
        deletedAt: input.deletedAt,
      }),
    });
  }
  if (input.plan.kind === 'nearby-location-observation-3d') {
    return buildNearbyWorldHealthDeleteMutation({
      envelope: input.envelope,
      entityId: input.plan.entityId,
      deletedAt: input.deletedAt,
    });
  }
  if (input.plan.kind === 'nearby-movement-event-7d') {
    return buildNearbyWorldHealthDeleteMutation({
      envelope: input.envelope,
      entityId: input.plan.entityId,
      deletedAt: input.deletedAt,
      kind: 'nearby-movement-event',
    });
  }
  if (input.plan.kind === 'tools-workspace-visit-3d') {
    if (!input.plan.localId) {
      throw new Error('浏览访问留存墓碑缺少本机 recordId。');
    }
    return buildToolsWorkspaceDeleteMutation({
      envelope: input.envelope,
      kind: 'visit',
      localId: input.plan.localId,
      deletedAt: input.deletedAt,
    });
  }
  return buildToolsAuditEventDeleteMutation({
    envelope: input.envelope,
    callId: input.plan.entityId,
    deletedAt: input.deletedAt,
  });
}
