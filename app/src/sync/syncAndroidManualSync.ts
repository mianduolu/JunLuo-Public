import {
  createExpoSyncCryptoPortV1,
  expoSyncRandomUuidV1,
} from './syncCryptoExpo';
import { isSupportedTheaterForkBoundaryMutation } from './syncTheaterIsolated';
import { isSupportedTheaterCoCreationProgressMutation } from './syncAssistantLifeState';
import {
  AndroidProductionSyncDomainConsumer,
  type AndroidSyncDomainConsumer,
} from './syncAndroidDomainConsumer';
import {
  enqueueAndroidExplicitSyncOperation,
} from './syncAndroidExplicitOperationQueue';
import { assertOrdinarySyncAllowed } from './syncEmergencyWorldRebuildStore';
import { assertMemoryDuplicateCleanupAllowsSync } from '../memory/memoryDuplicateCleanupState';
import {
  androidSyncLedgerSnapshot,
  applyVerifiedAndroidSyncMutation,
  inspectAndroidSyncMutationParentDependencies,
  listCurrentAndroidSyncObjectIds,
  loadAndroidManualObjectScanCursor,
  resolveEquivalentAndroidDeleteHeadConflicts,
  saveAndroidManualObjectScanCursor,
} from './syncAndroidMutationLedger';
import {
  createAndroidSyncObjectMaterializationRuntime,
} from './syncAndroidObjectMaterializationExpo';
import {
  createAndroidSyncObjectRetentionRuntime,
} from './syncAndroidObjectRetentionExpo';
import {
  createAndroidSyncObjectTransferRuntime,
} from './syncAndroidObjectTransferExpo';
import {
  getAndroidSyncReceiveFetchCursor,
  listReceivedAndroidSyncInboxChangesAfter,
  loadNextAndroidSyncRelayInboxEntry,
  retryNextAndroidTheaterSchemaQuarantine,
  storeAndroidSyncRelayPage,
} from './syncReceiveStore';
import {
  createAndroidSyncRelayClient,
  loadCurrentSyncRelayEnrollment,
} from './syncRelayClientExpo';
import {
  SyncRelayClient,
  SyncRelayHttpError,
  type SyncRelayActiveEnrollmentV1,
} from './syncRelayClient';
import {
  isRetiredCurrentActionMutation,
  type PlainMutationV1,
} from './syncProtocol';
import {
  acknowledgeSyncOutbox,
  claimSyncOutboxBatch,
  cleanupCompletedSyncTransportHistory,
  failSyncOutboxLease,
  getAppliedRelayCursor,
  loadAcknowledgedSyncSelfEchoBatch,
  loadAcknowledgedSyncOutboxMutation,
  markAcknowledgedSyncSelfEchoBatchApplied,
  markInboxChangeApplied,
  quarantineInboxChange,
  resolveSyncDeviceSigningPublicKeyAt,
  saveSyncDevicePublicIdentity,
  saveSyncDeviceFreshnessCheckpoint,
} from './syncStore';
import {
  loadSyncObjectJob,
  refreshSyncObjectRetentionClocks,
} from './syncObjectJobStore';
import {
  cleanupStaleSyncObjectExpoStaging,
} from './syncObjectExpoFilePort';
import {
  runAndroidHighSensitivityRetention,
} from './syncHighSensitivityRetentionRuntime';
import {
  ensureAndroidNewWorldLiveCursor,
} from './syncNewWorldLiveCursorExpo';
import {
  promoteAndroidNewWorldLiveChanges,
  restoreAndroidNewWorldLiveCapture,
  hasPendingAndroidNewWorldMemoryChanges,
  hasPendingAndroidNewWorldScheduleChanges,
  hasPendingAndroidNewWorldTodoChanges,
} from './syncAndroidNewWorldLiveCapture';
import { hasPendingAndroidGiftSyncChanges } from './syncGiftsRuntime';
import {
  loadAndroidSyncNetworkClass,
} from './syncAndroidNetworkClass';
import { prepareAndPromoteHighNoiseDomains } from './syncHighNoiseSummaryPromotion';
import { runAndroidFiniteDeletionMaintenance } from './syncFiniteDeletionMaintenance';
import type {
  AutomaticDataSyncBudgetV1,
  AutomaticDataSyncProgressV1,
} from './automaticDataSyncProgressCore';
import { captureBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { loadSyncEntityHeadMutations, loadSyncBaiyunPostTagHeadMutations, loadSyncRevisionMutation, enqueueSyncMutationAndAdvanceHeads, syncMutationStatePort } from './syncMutationStateStore';
import { createSyncMutationEnvelope } from './syncMutationEnvelope';

const MAX_SEND_BATCHES = 16;
const MAX_RECEIVE_PAGES = 256;
const MAX_CONSUMED_ENTRIES = 4096;
const MAX_CURRENT_OBJECTS = 64;
const MAX_MANUAL_SYNC_RUNTIME_MS = 45_000;
const MAX_AUTOMATIC_SYNC_RUNTIME_MS = 15_000;
const MAX_OBJECT_UPLOAD_CHUNKS_PER_MANUAL_SYNC = 1;
const MAX_HIGH_SENSITIVITY_RETENTION_RUNTIME_MS = 5_000;
const MAX_STAGED_DEPENDENCY_LOOKAHEAD = 4_096;
const PREFERRED_PULL_LIMIT = 100;
const FALLBACK_PULL_LIMIT = 16;
const CHANGE_RESPONSE_TOO_LARGE =
  '同步中继变更拉取响应超过字节上限。';

class AndroidSyncSendRuntime {
  private readonly crypto;

  constructor(
    private readonly relay: SyncRelayClient,
    private readonly enrollment: SyncRelayActiveEnrollmentV1,
    private readonly now: () => number,
  ) {
    this.crypto = createExpoSyncCryptoPortV1({
      vaultId: enrollment.publicIdentity.vaultId,
      deviceId: enrollment.publicIdentity.deviceId,
      keyId: enrollment.publicIdentity.keyId,
      vaultRootSecret: enrollment.secrets.vaultRootSecret,
      signingPrivateKey: enrollment.secrets.signingPrivateKey,
      resolveSigningPublicKey: async () => {
        throw new Error('Android 发件加密不读取远端公钥。');
      },
    });
  }

  async pushOneBatch() {
    const leaseId = expoSyncRandomUuidV1();
    const claimedAt = this.now();
    const batch = await claimSyncOutboxBatch({
      leaseId,
      now: claimedAt,
      limit: 16,
      leaseDurationMs: 60_000,
    });
    if (!batch.length) {
      return { state: 'idle' as const, sent: 0 };
    }
    try {
      const changes = await Promise.all(batch.map(
        ({ mutation }) => this.crypto.sealChange(
          mutation,
          expoSyncRandomUuidV1(),
        ),
      ));
      const response = await this.relay.pushChanges(
        this.enrollment,
        changes,
      );
      await acknowledgeSyncOutbox(
        leaseId,
        response.acknowledgements.map((entry) => ({
          mutationId: entry.mutationId,
          relayCursor: entry.relayCursor,
        })),
        this.now(),
      );
      return {
        state: 'sent' as const,
        sent: changes.length,
        duplicateCount: response.acknowledgements.filter(
          (entry) => entry.duplicate,
        ).length,
      };
    } catch (error) {
      await failSyncOutboxLease({
        leaseId,
        failedAt: this.now(),
        errorCode: error instanceof SyncRelayHttpError
          ? `relay.http.${error.status}`
          : 'relay.transport',
      });
      throw new Error(
        'Android outbox 推送失败；租约已释放并安排退避重试。',
        { cause: error },
      );
    }
  }
}

export class AndroidSyncReceiveRuntime {
  private deviceDirectoryPromise: Promise<number> | undefined;
  private pullLimit: number;

  constructor(
    private readonly relay: SyncRelayClient,
    private readonly enrollment: SyncRelayActiveEnrollmentV1,
    private readonly domains: AndroidSyncDomainConsumer,
    private readonly now: () => number,
    pullLimit = PREFERRED_PULL_LIMIT,
  ) {
    this.pullLimit = Math.max(
      1,
      Math.min(PREFERRED_PULL_LIMIT, Math.floor(pullLimit)),
    );
  }

  private loadDeviceDirectoryOnce() {
    if (!this.deviceDirectoryPromise) {
      const loading = this.relay.listDevices(this.enrollment)
        .then(async (devices) => {
          for (const device of devices) {
            await saveSyncDevicePublicIdentity(device);
          }
          return devices.length;
        });
      const retryable = loading.catch((error) => {
        if (this.deviceDirectoryPromise === retryable) {
          this.deviceDirectoryPromise = undefined;
        }
        throw error;
      });
      this.deviceDirectoryPromise = retryable;
    }
    return this.deviceDirectoryPromise;
  }

  private async pullPage(after: number) {
    try {
      return await this.relay.pullChanges(
        this.enrollment,
        { after, limit: this.pullLimit },
      );
    } catch (error) {
      if (
        this.pullLimit !== FALLBACK_PULL_LIMIT
        && error instanceof Error
        && error.message === CHANGE_RESPONSE_TOO_LARGE
      ) {
        this.pullLimit = FALLBACK_PULL_LIMIT;
        return this.relay.pullChanges(
          this.enrollment,
          { after, limit: this.pullLimit },
        );
      }
      throw error;
    }
  }

  async receiveOnePage() {
    const deviceCount = await this.loadDeviceDirectoryOnce();
    const after = await getAndroidSyncReceiveFetchCursor();
    const page = await this.pullPage(after);
    await storeAndroidSyncRelayPage(
      page,
      this.enrollment.publicIdentity.vaultId,
      this.now(),
    );
    return {
      requestedAfter: after,
      received: page.changes.length,
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
      deviceCount,
    };
  }

  private async openNextChange(
    entry: Extract<
      NonNullable<Awaited<ReturnType<
        typeof loadNextAndroidSyncRelayInboxEntry
      >>>,
      { kind: 'change' }
    >,
  ) {
    if (entry.change.keyId !== this.enrollment.publicIdentity.keyId) {
      throw new Error(
        'Android 收到非当前 keyId 的变更；请重建新世界。',
      );
    }
    const publicKey = await resolveSyncDeviceSigningPublicKeyAt({
      vaultId: entry.change.vaultId,
      deviceId: entry.change.sourceDeviceId,
      keyId: entry.change.keyId,
      createdAt: entry.change.createdAt,
    });
    if (!publicKey) {
      throw new Error(
        'Android 变更来源设备未登记、尚未激活或已经撤销。',
      );
    }
    const crypto = createExpoSyncCryptoPortV1({
      vaultId: this.enrollment.publicIdentity.vaultId,
      deviceId: this.enrollment.publicIdentity.deviceId,
      keyId: entry.change.keyId,
      vaultRootSecret: this.enrollment.secrets.vaultRootSecret,
      signingPrivateKey: this.enrollment.secrets.signingPrivateKey,
      resolveSigningPublicKey: async (deviceId, keyId) => {
        if (
          deviceId !== entry.change.sourceDeviceId
          || keyId !== entry.change.keyId
        ) {
          throw new Error('Android 收件签名公钥路由发生变化。');
        }
        return publicKey;
      },
    });
    return crypto.openChange(entry.change);
  }

  async verifyTheaterForkBoundaryRetry(entry: Parameters<AndroidSyncReceiveRuntime['openNextChange']>[0], detail: string) {
    const mutation = await this.openNextChange(entry);
    return detail === 'theater.isolated payload 版本或 kind 无效。'
      ? isSupportedTheaterForkBoundaryMutation(mutation)
      : isSupportedTheaterCoCreationProgressMutation(mutation, detail);
  }

  private async loadAcknowledgedSelfEcho(
    entry: Extract<
      NonNullable<Awaited<ReturnType<
        typeof loadNextAndroidSyncRelayInboxEntry
      >>>,
      { kind: 'change' }
    >,
  ) {
    if (
      entry.change.sourceDeviceId
      !== this.enrollment.publicIdentity.deviceId
    ) {
      return null;
    }
    const mutation = await loadAcknowledgedSyncOutboxMutation(
      entry.change.mutationId,
    );
    if (!mutation) return null;
    if (
      mutation.protocolVersion !== entry.change.protocolVersion
      || mutation.vaultId !== entry.change.vaultId
      || mutation.sourceDeviceId !== entry.change.sourceDeviceId
      || mutation.sourceSequence !== entry.change.sourceSequence
      || mutation.mutationId !== entry.change.mutationId
      || mutation.createdAt !== entry.change.createdAt
    ) {
      throw new Error(
        'Android 已确认自家回声与本机 outbox 身份字段不一致。',
      );
    }
    return mutation;
  }

  private async resolveStagedParentDependencies(
    mutation: PlainMutationV1,
    relayCursor: number,
  ) {
    const initial =
      await inspectAndroidSyncMutationParentDependencies(mutation);
    if (initial.missing.length === 0) return true;

    const candidates = new Map<string, PlainMutationV1>();
    const staged =
      await listReceivedAndroidSyncInboxChangesAfter({
        afterRelayCursor: relayCursor,
        limit: MAX_STAGED_DEPENDENCY_LOOKAHEAD,
      });
    for (const entry of staged) {
      let candidate: PlainMutationV1;
      try {
        candidate = await this.loadAcknowledgedSelfEcho(entry)
          ?? await this.openNextChange(entry);
      } catch {
        // Unrelated damaged future entries are handled at their own cursor.
        continue;
      }
      if (candidates.has(candidate.revision.id)) {
        throw new Error(
          'Android 暂存 inbox 包含重复 revisionId。',
        );
      }
      candidates.set(candidate.revision.id, candidate);
    }

    const visiting = new Set<string>([mutation.revision.id]);
    const applied = new Set<string>();
    const resolveRevision = async (
      revisionId: string,
    ): Promise<boolean> => {
      if (applied.has(revisionId)) return true;
      if (visiting.has(revisionId)) {
        throw new Error('Android 暂存 revision 依赖形成循环。');
      }
      const candidate = candidates.get(revisionId);
      if (!candidate) return false;
      visiting.add(revisionId);
      const dependencies =
        await inspectAndroidSyncMutationParentDependencies(
          candidate,
        );
      for (const parentId of dependencies.missing) {
        if (!(await resolveRevision(parentId))) {
          visiting.delete(revisionId);
          return false;
        }
      }
      if (!isRetiredCurrentActionMutation(candidate)) await this.domains.validateIncomingMutation(candidate);
      await applyVerifiedAndroidSyncMutation(candidate, this.now());
      visiting.delete(revisionId);
      applied.add(revisionId);
      return true;
    };

    for (const parentId of initial.missing) {
      if (!(await resolveRevision(parentId))) return false;
    }
    return true;
  }

  private async missingPostParents(mutation: PlainMutationV1) {
    let postIds: string[] = [];
    if (mutation.entity.domain === 'memory' && mutation.entity.type === 'post-comment') {
      postIds = [JSON.parse(mutation.entity.id)[0] as string];
    } else if (mutation.entity.domain === 'memory' && mutation.entity.type === 'interaction-fact'
      && mutation.entity.id === 'post-reading' && mutation.revision.operation !== 'delete') {
      const value = (mutation.payload as { value: { rounds: { postId: string }[] } }).value;
      postIds = value.rounds.map(round => round.postId);
    }
    if (!postIds.length) return [];
    const [{ getMemoryDatabase }, { memoryRecordsSqliteApplyPort }] = await Promise.all([
      import('../memory/memoryStore'), import('./syncMemoryRecordsSqliteApply'),
    ]);
    const database = await getMemoryDatabase();
    const missing: string[] = [];
    for (const postId of new Set(postIds)) {
      if (await database.getFirstAsync('SELECT post_id FROM baiyun_post_metadata WHERE post_id=?', postId)) continue;
      const heads = await memoryRecordsSqliteApplyPort.loadCurrentHeadRevisions({ entityType: 'post', entityId: postId });
      if (!heads.some(head => head.operation === 'delete')) missing.push(postId);
    }
    return missing;
  }

  // A post is an entity dependency, not a revision parent of a reading receipt
  // or comment. Materialize its verified staged heads without acknowledging a
  // later cursor; the original contiguous inbox still owns transport progress.
  private async resolveStagedPostParents(mutation: PlainMutationV1, relayCursor: number) {
    const missing = await this.missingPostParents(mutation);
    if (!missing.length) return true;
    const wanted = new Set(missing);
    const staged = await listReceivedAndroidSyncInboxChangesAfter({
      afterRelayCursor: relayCursor, limit: MAX_STAGED_DEPENDENCY_LOOKAHEAD,
    });
    for (const entry of staged) {
      let candidate: PlainMutationV1;
      try { candidate = await this.loadAcknowledgedSelfEcho(entry) ?? await this.openNextChange(entry); }
      catch { continue; /* Invalid future mail remains at its own cursor. */ }
      if (candidate.entity.domain !== 'memory' || candidate.entity.type !== 'post' || !wanted.has(candidate.entity.id)) continue;
      await this.domains.validateIncomingMutation(candidate);
      if (!await this.resolveStagedParentDependencies(candidate, relayCursor)) continue;
      await applyVerifiedAndroidSyncMutation(candidate, this.now());
    }
    for (const postId of missing) {
      const heads = await loadSyncEntityHeadMutations({ domain: 'memory', type: 'post', id: postId });
      if (heads.length) await this.materializeBaiyunPostHeads(heads[0]);
    }
    return (await this.missingPostParents(mutation)).length === 0;
  }

  private async materializeBaiyunPostHeads(mutation: PlainMutationV1) {
    const { isBaiyunPostHeadEntity, reconcileBaiyunPostHeads } = await import('./syncBaiyunPostHeadReconciliation');
    const postMemoryShadow = mutation.entity.domain === 'memory' && mutation.entity.type === 'memory'
      && (await loadSyncEntityHeadMutations({ domain: 'memory', type: 'post', id: mutation.entity.id })).length > 0;
    if (!isBaiyunPostHeadEntity(mutation.entity) && !postMemoryShadow) return false;
    const captureMerge = async (selection: import('./syncBaiyunPostHeadReconciliation').BaiyunPostHeadSelection, parents: string[]) => {
        const envelope = await createSyncMutationEnvelope({ identity: this.enrollment.publicIdentity,
          entity: selection.template.entity, state: syncMutationStatePort, randomUuid: expoSyncRandomUuidV1, now: this.now });
        if (JSON.stringify([...parents].sort()) !== JSON.stringify(envelope.parentRevisionIds)) {
          throw new Error('Post sync heads changed; retry against current heads.');
        }
        const merged: PlainMutationV1 = { ...selection.template,
          mutationId: envelope.mutationId, vaultId: envelope.vaultId,
          sourceDeviceId: envelope.sourceDeviceId, sourceSequence: envelope.sourceSequence,
          createdAt: envelope.createdAt, payload: selection.payload, objectRefs: selection.objectRefs,
          revision: { id: envelope.revisionId, parents: envelope.parentRevisionIds,
            operation: selection.operation, schemaVersion: selection.schemaVersion } };
        await this.domains.validateIncomingMutation(merged);
        await enqueueSyncMutationAndAdvanceHeads(merged);
        return merged;
    };
    if (mutation.entity.type === 'post-tag') {
      const { reconcileBaiyunPostTagLibrary } = await import('./syncBaiyunPostTagCoordination');
      await reconcileBaiyunPostTagLibrary({ loadHeads: loadSyncBaiyunPostTagHeadMutations,
        loadRevision: loadSyncRevisionMutation, capture: captureMerge,
        materialize: selected => this.domains.materializeCurrentMutation(selected) });
      await (await import('./syncBaiyunPostTagProjection')).reconcileAndroidBaiyunPostTagReferences();
      return true;
    }
    const selected = await reconcileBaiyunPostHeads({
      entity: mutation.entity, postMemoryShadow, loadHeads: () => loadSyncEntityHeadMutations(mutation.entity),
      loadRevision: loadSyncRevisionMutation, captureMerge,
      collapseHeads: async (id, heads) => (await import('./syncMutationStateStore')).collapseSyncEntityHeads(mutation.entity, id, heads, this.now()),
      materialize: selectedMutation => this.domains.materializeCurrentMutation(selectedMutation),
    });
    if (mutation.entity.type === 'post' && selected) {
      await (await import('./syncBaiyunPostTagProjection')).reconcileAndroidBaiyunPostTagReferences(mutation.entity.id);
      const shadows = await loadSyncEntityHeadMutations({ domain: 'memory', type: 'memory', id: mutation.entity.id });
      if (shadows.length) await this.materializeBaiyunPostHeads(shadows[0]);
    }
    return selected !== null;
  }

  async consumeNext() {
    const dataEpoch = captureBackupRestoreDataEpoch();
    const entry = await loadNextAndroidSyncRelayInboxEntry();
    if (!entry) return null;

    let mutation;
    try {
      mutation = await this.loadAcknowledgedSelfEcho(entry)
        ?? await this.openNextChange(entry);
    } catch (error) {
      await quarantineInboxChange({
        mutationId: entry.change.mutationId,
        relayCursor: entry.relayCursor,
        errorCode: 'crypto.invalid-incoming-change',
        detail: error instanceof Error ? error.message : String(error),
        createdAt: this.now(),
      });
      throw new Error(
        `relay cursor ${entry.relayCursor} 密文校验失败，已隔离且未推进游标。`,
        { cause: error },
      );
    }

    if (mutation.entity.domain === 'memory' && ['post', 'post-comment', 'post-tag'].includes(mutation.entity.type)) {
      // Local SQLite capture may still be waiting for promotion when mail
      // arrives. Let those original versions join the central heads first.
      const { runMemoryRecordsOutboxPromotionRuntime } = await import('./syncMemoryRecordsRuntime');
      const promotion = await runMemoryRecordsOutboxPromotionRuntime({ now: this.now() });
      if (promotion.report.failed.length) {
        throw new Error(`relay cursor ${entry.relayCursor} 本机动态尚未完成接线，已保留 inbox 且未推进游标，可安全重试。`);
      }
    }

    if (mutation.entity.domain === 'schedule') {
      const { runScheduleSemanticOutboxPromotionRuntime } = await import('./syncScheduleSemanticRuntime');
      const promotion = await runScheduleSemanticOutboxPromotionRuntime({ now: this.now(), limit: 100 });
      if (promotion.report.failed.length) {
        throw new Error(`relay cursor ${entry.relayCursor} 本机日程尚未完成接线，已保留 inbox 且未推进游标，可安全重试。`);
      }
    }

    let ledger;
    try {
      if (!isRetiredCurrentActionMutation(mutation)) await this.domains.validateIncomingMutation(mutation);
      const dependenciesReady =
        await this.resolveStagedParentDependencies(
          mutation,
          entry.relayCursor,
        );
      if (!dependenciesReady) {
        return {
          kind: 'change' as const,
          dependencyWaiting: true as const,
          relayCursor: entry.relayCursor,
          objectRefs: [] as string[],
        };
      }
      ledger = await applyVerifiedAndroidSyncMutation(
        mutation,
        this.now(),
      );
    } catch (error) {
      await quarantineInboxChange({
        mutationId: mutation.mutationId,
        relayCursor: entry.relayCursor,
        errorCode: 'domain.invalid-or-unresolved-mutation',
        detail: error instanceof Error ? error.message : String(error),
        createdAt: this.now(),
      });
      throw new Error(
        `relay cursor ${entry.relayCursor} 领域消费失败，已隔离且未推进游标。`,
        { cause: error },
      );
    }

    try {
      if (!await this.resolveStagedPostParents(mutation, entry.relayCursor)) {
        return { kind: 'change' as const, dependencyWaiting: true as const,
          relayCursor: entry.relayCursor, objectRefs: [] as string[] };
      }
    } catch (error) {
      throw new Error(`relay cursor ${entry.relayCursor} 正文依赖物化失败，已保留 inbox 且未推进游标，可安全重试。`, { cause: error });
    }

    let wishMaterialized = false;
    if (mutation.entity.domain === 'wish-pool' && mutation.entity.type === 'wish') {
      const { reconcileWishPoolLifeHeads } = await import('./syncWishPoolLifeAsyncStoragePort');
      const { buildWishPoolLifeRecordMutation } = await import('./syncWishPoolLife');
      wishMaterialized = await reconcileWishPoolLifeHeads({
        wishId: mutation.entity.id,
        dataEpoch,
        loadHeads: () => loadSyncEntityHeadMutations(mutation.entity),
        loadParents: async () => (await Promise.all(mutation.revision.parents.map(loadSyncRevisionMutation)))
          .filter((parent): parent is PlainMutationV1 => !!parent),
        captureMerge: async (record, parents) => {
          const envelope = await createSyncMutationEnvelope({ identity: this.enrollment.publicIdentity,
            entity: mutation.entity, state: syncMutationStatePort, randomUuid: expoSyncRandomUuidV1, now: this.now });
          if (JSON.stringify([...parents].sort()) !== JSON.stringify(envelope.parentRevisionIds)) {
            throw new Error('Wish sync heads changed; retry against current heads.');
          }
          const merged = buildWishPoolLifeRecordMutation({ envelope, entityType: 'wish', entityId: mutation.entity.id,
            kind: 'wish', value: record as unknown as import('./syncProtocol').JsonValue });
          await enqueueSyncMutationAndAdvanceHeads(merged);
          return merged;
        },
      });
    }
    let postMaterialized: boolean;
    try { postMaterialized = await this.materializeBaiyunPostHeads(mutation); }
    catch (error) {
      throw new Error(`relay cursor ${entry.relayCursor} 动态版本物化失败，已保留 inbox 且未推进游标，可安全重试。`, { cause: error });
    }
    let reviewMaterialized = false;
    try {
      const { reconcileSharedPostReviewSignedHeads } = await import('./syncBaiyunPostReviews');
      reviewMaterialized = await reconcileSharedPostReviewSignedHeads({ entity: mutation.entity,
        loadHeads: () => loadSyncEntityHeadMutations(mutation.entity), loadRevision: loadSyncRevisionMutation,
        // The production consumer invokes the original phone owner handler even
        // when the business mutation was already applied before a crash.
        materialize: selected => this.domains.materializeCurrentMutation(selected),
      }) !== null;
    } catch (error) {
      throw new Error(`relay cursor ${entry.relayCursor} 审核版本物化失败，已保留 inbox 且未推进游标，可安全重试。`, { cause: error });
    }
    let giftMaterialized = false;
    let giftObjectRefs: string[] = [];
    if (mutation.entity.domain === 'gifts') {
      try {
        const { selectGiftSyncHead } = await import('./syncGiftsLife');
        const selected = selectGiftSyncHead(await loadSyncEntityHeadMutations(mutation.entity));
        // A conflict remains whole branches; a real deletion takes effect even
        // while the central ledger retains a concurrent edit for inspection.
        giftMaterialized = true;
        if (selected) {
          await this.domains.materializeCurrentMutation(selected);
          giftObjectRefs = [...selected.objectRefs];
        }
      } catch (error) {
        throw new Error(`relay cursor ${entry.relayCursor} 礼物版本物化失败，已保留 inbox 且未推进游标，可重试。`, { cause: error });
      }
    }
    const requiresLocalMaterialization = !giftMaterialized && !wishMaterialized && !postMaterialized && !reviewMaterialized && ledger.current
      && mutation.sourceDeviceId
        !== this.enrollment.publicIdentity.deviceId;
    if (requiresLocalMaterialization) {
      try {
        await this.domains.materializeCurrentMutation(mutation);
      } catch (error) {
        throw new Error(
          `relay cursor ${entry.relayCursor} 业务物化失败，`
          + '已保留 inbox 且未推进游标，可安全重试。',
          { cause: error },
        );
      }
    }
    await markInboxChangeApplied(
      mutation.mutationId,
      entry.relayCursor,
      this.now(),
    );
    return {
      kind: 'change' as const,
      relayCursor: entry.relayCursor,
      mutationId: mutation.mutationId,
      adapterId: ledger.adapterId,
      status: ledger.status,
      objectRefs: giftMaterialized ? giftObjectRefs : postMaterialized
        ? (await loadSyncEntityHeadMutations(mutation.entity)).flatMap(head => head.objectRefs)
        : requiresLocalMaterialization ? [...mutation.objectRefs] : [],
    };
  }

  async consumeAcknowledgedSelfEchoBatch(limit: number) {
    const entries = await loadAcknowledgedSyncSelfEchoBatch({
      sourceDeviceId: this.enrollment.publicIdentity.deviceId,
      limit,
    });
    if (!entries.length) return 0;
    let validatedCount = 0;
    for (const entry of entries) {
      try {
        // Owner execution may have crashed after storing the request. Route an
        // action echo through ordinary consumeNext instead of the ack fast path.
        if (entry.mutation.entity.domain === 'memory' && entry.mutation.entity.type === 'post-review-action') break;
        if (entry.mutation.entity.domain === 'memory' && entry.mutation.entity.type === 'memory'
          && (await loadSyncEntityHeadMutations(entry.mutation.entity)).length > 1
          && (await loadSyncEntityHeadMutations({ domain: 'memory', type: 'post', id: entry.mutation.entity.id })).length) break;
        if (!isRetiredCurrentActionMutation(entry.mutation)) await this.domains.validateIncomingMutation(entry.mutation);
        validatedCount += 1;
      } catch {
        break;
      }
    }
    if (validatedCount === 0) return 0;
    return markAcknowledgedSyncSelfEchoBatchApplied(
      entries.slice(0, validatedCount),
      this.now(),
    );
  }
}

export type AndroidManualSyncResult = {
  state: 'complete' | 'work-remaining';
  canContinue: boolean;
  startedAt: number;
  completedAt: number;
  sentBatches: number;
  sentMutations: number;
  duplicateMutations: number;
  receivedPages: number;
  receivedEntries: number;
  consumedEntries: number;
  uploadedObjects: number;
  downloadedObjects: number;
  materializedObjects: number;
  evictedObjects: number;
  cleanedTemporaryFiles: number;
  cleanedTemporaryDirectories: number;
  prunedTransportOutbox: number;
  prunedTransportInbox: number;
  prunedHighSensitivityRecords: number;
  automaticSyncEnabled: false;
  sync: Awaited<ReturnType<typeof androidSyncLedgerSnapshot>>;
};

export type AndroidSyncRunOptions = {
  mode?: 'manual' | 'automatic';
  allowObjectTransfer?: boolean;
  suppressOptionalPromotions?: boolean;
  automaticBudget?: AutomaticDataSyncBudgetV1;
  onAutomaticProgress?: (
    phase: AutomaticDataSyncProgressV1['phase'],
    counts: { sent: number; received: number; materialized: number },
  ) => void;
};

let androidManualSyncInFlight:
  Promise<AndroidManualSyncResult> | null = null;

export class AndroidManualSyncController {
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly baseUrl: string,
    private readonly now: () => number = Date.now,
  ) {}

  private mutate<T>(operation: () => Promise<T>) {
    const next = this.mutationQueue.then(operation);
    this.mutationQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async runUntilSettled(input: {
    shouldContinue?: () => boolean;
    onProgress?: (result: AndroidManualSyncResult) => void;
  } = {}) {
    let total: AndroidManualSyncResult | undefined;
    do {
      const result = await this.runOnce();
      const previous = total;
      total = { ...result, startedAt: previous?.startedAt ?? result.startedAt };
      if (previous) {
        for (const key of [
          'sentBatches', 'sentMutations', 'duplicateMutations',
          'receivedPages', 'receivedEntries', 'consumedEntries',
          'uploadedObjects', 'downloadedObjects', 'materializedObjects',
          'evictedObjects', 'cleanedTemporaryFiles', 'cleanedTemporaryDirectories',
          'prunedTransportOutbox', 'prunedTransportInbox',
          'prunedHighSensitivityRecords',
        ] as const) {
          total[key] += previous[key];
        }
      }
      input.onProgress?.(total);
      if (!result.canContinue) break;
    } while (input.shouldContinue?.() !== false);
    return total;
  }

  runOnce(input: AndroidSyncRunOptions = {}) {
    if (androidManualSyncInFlight) return androidManualSyncInFlight;
    const mode = input.mode ?? 'manual';
    if (mode !== 'manual' && mode !== 'automatic') {
      throw new Error('Android 同步运行模式无效。');
    }
    const automatic = mode === 'automatic';
    const allowObjectTransfer = input.allowObjectTransfer ?? !automatic;
    if (typeof allowObjectTransfer !== 'boolean') {
      throw new Error('Android 对象传输条件无效。');
    }
    const automaticBudget = input.automaticBudget;
    const runtimeLimitMs = automatic
      ? automaticBudget?.runtimeLimitMs ?? MAX_AUTOMATIC_SYNC_RUNTIME_MS
      : MAX_MANUAL_SYNC_RUNTIME_MS;
    const runMaintenance = !automatic;
    const maxSendBatches = automatic
      ? automaticBudget?.maxSendBatches ?? 1
      : MAX_SEND_BATCHES;
    const maxReceivePages = automatic
      ? automaticBudget?.maxReceivePages ?? 1
      : MAX_RECEIVE_PAGES;
    const maxConsumedEntries = automatic
      ? automaticBudget?.maxConsumedEntries ?? 16
      : MAX_CONSUMED_ENTRIES;
    const dataEpoch = captureBackupRestoreDataEpoch();
    const operation = this.mutate(() => enqueueAndroidExplicitSyncOperation(
      async (): Promise<AndroidManualSyncResult> => {
      await assertOrdinarySyncAllowed();
      await assertMemoryDuplicateCleanupAllowsSync();
      const enrollment = await loadCurrentSyncRelayEnrollment();
      if (!enrollment) {
        throw new Error('Android 当前没有 active 设备身份，不能执行同步。');
      }
      await import('./syncChatStorageBridge').then(
        ({ flushPendingChatStorageSyncCapture }) => (
          flushPendingChatStorageSyncCapture()
        ),
      );
      const startedAt = this.now();
      await ensureAndroidNewWorldLiveCursor({
        baseUrl: this.baseUrl,
        now: this.now,
      });
      await restoreAndroidNewWorldLiveCapture();
      const equivalentDeleteRepair = runMaintenance
        ? await resolveEquivalentAndroidDeleteHeadConflicts(startedAt)
        : { collapsedEntities: 0, resolvedConflicts: 0, hasMore: false };
      let runtimeBudgetExhausted = false;
      const hasRuntimeBudget = () => {
        const available = this.now() - startedAt
          < runtimeLimitMs;
        if (!available) runtimeBudgetExhausted = true;
        return available;
      };
      const domains = new AndroidProductionSyncDomainConsumer();
      let highSensitivityRetention = {
        tombstones: 0,
        scanned: 0,
        hasMore: false,
      };
      let transportCleanup = {
        deletedOutbox: 0,
        deletedInbox: 0,
      };
      let temporaryCleanup = {
        deletedFiles: 0,
        deletedDirectories: 0,
      };
      const relay = createAndroidSyncRelayClient({
        baseUrl: this.baseUrl,
      });
      const freshness = await relay.getDeviceFreshness(enrollment);
      await saveSyncDeviceFreshnessCheckpoint({
        ...freshness,
        updatedAt: this.now(),
      });
      if (freshness.state === 'refresh-required') {
        throw new Error(
          '这台设备需要重新取得当前状态，普通同步已暂停。',
        );
      }
      const send = new AndroidSyncSendRuntime(
        relay,
        enrollment,
        this.now,
      );
      const receive = new AndroidSyncReceiveRuntime(
        relay,
        enrollment,
        domains,
        this.now,
        automatic ? 16 : 100,
      );
      if (runMaintenance) await retryNextAndroidTheaterSchemaQuarantine((entry, detail) => receive.verifyTheaterForkBoundaryRetry(entry, detail));
      let sentBatches = 0;
      let sentMutations = 0;
      let duplicateMutations = 0;
      let receivedPages = 0;
      let receivedEntries = 0;
      let consumedEntries = 0;
      let uploadedObjects = 0;
      let downloadedObjects = 0;
      let materializedObjects = 0;
      let evictedObjects = 0;
      let relayHasMore = false;
      let objectWorkRemaining = false;
      let objectProgressMade = false;
      let remoteObjectReferencesChanged = false;
      let finiteDeletionMaintenance = {
        submitted: 0,
        acknowledged: 0,
        hasMore: false,
      };
      const reportProgress = (
        phase: AutomaticDataSyncProgressV1['phase'],
      ) => {
        try {
          input.onAutomaticProgress?.(phase, {
            sent: sentMutations,
            received: receivedEntries,
            materialized: consumedEntries,
          });
        } catch {
          // Progress is observational and must never stop durable sync work.
        }
      };

      const drainInbox = async () => {
        reportProgress('materializing');
        while (
          consumedEntries < maxConsumedEntries
          && hasRuntimeBudget()
        ) {
          const selfEchoes =
            await receive.consumeAcknowledgedSelfEchoBatch(
              Math.min(
                64,
                maxConsumedEntries - consumedEntries,
              ),
            );
          if (selfEchoes > 0) {
            consumedEntries += selfEchoes;
            continue;
          }
          const consumed = await receive.consumeNext();
          if (!consumed) return 'drained' as const;
          if (
            'dependencyWaiting' in consumed
            && consumed.dependencyWaiting === true
          ) {
            return 'dependency-waiting' as const;
          }
          if (consumed.objectRefs.length > 0) {
            remoteObjectReferencesChanged = true;
          }
          consumedEntries += 1;
        }
        return (await androidSyncLedgerSnapshot()).receivedInbox === 0
          ? 'drained' as const
          : 'limit' as const;
      };

      const initialInboxState = await drainInbox();
      let latestInboxState = initialInboxState;
      if (
        initialInboxState === 'drained'
        && !input.suppressOptionalPromotions
        && hasRuntimeBudget()
      ) {
        await promoteAndroidNewWorldLiveChanges({
          limit: 16,
          now: this.now(),
        });
      }
      if (
        initialInboxState === 'drained'
        && !input.suppressOptionalPromotions
        && (await androidSyncLedgerSnapshot()).pendingOutbox === 0
        && hasRuntimeBudget()
      ) {
        await prepareAndPromoteHighNoiseDomains({
          mode,
          limit: automatic ? 16 : 200,
          now: this.now(),
        });
      }
      if (
        initialInboxState === 'drained'
        && hasRuntimeBudget()
      ) {
        reportProgress('sending');
        for (let index = 0; index < maxSendBatches; index += 1) {
          if (!hasRuntimeBudget()) break;
          const batch = await send.pushOneBatch();
          if (batch.state === 'idle') break;
          sentBatches += 1;
          sentMutations += batch.sent;
          duplicateMutations += batch.duplicateCount;
        }
      }

      if (
        initialInboxState !== 'limit'
        && hasRuntimeBudget()
      ) {
        reportProgress('receiving');
        for (let index = 0; index < maxReceivePages; index += 1) {
          if (!hasRuntimeBudget()) break;
          const page = await receive.receiveOnePage();
          receivedPages += 1;
          receivedEntries += page.received;
          relayHasMore = page.hasMore;
          latestInboxState = await drainInbox();
          if (latestInboxState === 'limit' || !page.hasMore) break;
          if (page.received === 0) {
            throw new Error(
              'Android 中继返回空页但声称仍有后续，已停止本轮同步。',
            );
          }
        }
      }

      const ordinaryBeforeObjects = await androidSyncLedgerSnapshot();
      if (
        initialInboxState === 'drained'
        && latestInboxState === 'drained'
        && ordinaryBeforeObjects.pendingOutbox === 0
        && ordinaryBeforeObjects.receivedInbox === 0
        && !relayHasMore
        && allowObjectTransfer
        && hasRuntimeBudget()
      ) {
        const objectTransfer = await createAndroidSyncObjectTransferRuntime({
          baseUrl: this.baseUrl,
        });
        const objectMaterialization =
          await createAndroidSyncObjectMaterializationRuntime({
            baseUrl: this.baseUrl,
          });
        const retention = runMaintenance
          ? await createAndroidSyncObjectRetentionRuntime()
          : null;
        reportProgress('files');
        const automaticObjectChunkBudget = automatic
          ? automaticBudget?.maximumObjectChunks ?? 2
          : null;
        const upload = await objectTransfer.uploadPendingObjects({
          shouldContinue: hasRuntimeBudget,
          retrySourceMissing: !automatic,
          maximumChunks:
            automaticObjectChunkBudget
              ?? MAX_OBJECT_UPLOAD_CHUNKS_PER_MANUAL_SYNC,
        });
        uploadedObjects += upload.uploadedObjects;
        objectProgressMade = upload.processedChunks > 0;
        objectWorkRemaining = upload.hasMore;

        const remainingAutomaticDownloadChunks = automaticObjectChunkBudget
          === null
          ? null
          : Math.max(0, automaticObjectChunkBudget - upload.processedChunks);
        let afterObjectId =
          await loadAndroidManualObjectScanCursor();
        if (
          remoteObjectReferencesChanged
          && afterObjectId !== null
        ) {
          afterObjectId = null;
          await saveAndroidManualObjectScanCursor({
            afterObjectId: null,
            updatedAt: this.now(),
          });
        }
        let visited = 0;
        let reachedObjectScanEnd = false;
        const objectNetwork = await loadAndroidSyncNetworkClass();
        while (
          visited < (automatic ? 1 : MAX_CURRENT_OBJECTS)
          && (remainingAutomaticDownloadChunks === null
            || remainingAutomaticDownloadChunks > 0)
          && hasRuntimeBudget()
        ) {
          const objectIds = await listCurrentAndroidSyncObjectIds({
            limit: Math.min(64, MAX_CURRENT_OBJECTS - visited),
            afterObjectId,
          });
          for (const objectId of objectIds) {
            if (!hasRuntimeBudget()) {
              objectWorkRemaining = true;
              break;
            }
            const downloaded = await objectMaterialization.downloadObject(
              objectId,
              {
                network: objectNetwork,
                requestedByUser: false,
                maximumChunks:
                  remainingAutomaticDownloadChunks ?? undefined,
              },
            );
            if (downloaded.state === 'downloaded') {
              downloadedObjects += downloaded.cached ? 0 : 1;
              if (
                'materialization' in downloaded
                && downloaded.materialization.state === 'materialized'
              ) {
                materializedObjects += 1;
              }
            } else {
              objectWorkRemaining = true;
            }
            afterObjectId = objectId;
            visited += 1;
            await saveAndroidManualObjectScanCursor({
              afterObjectId,
              updatedAt: this.now(),
            });
          }
          if (!hasRuntimeBudget()) break;
          if (objectIds.length === 0) {
            reachedObjectScanEnd = true;
            break;
          }
        }
        if (!hasRuntimeBudget()) {
          objectWorkRemaining = true;
        } else if (!reachedObjectScanEnd) {
          const overflow = await listCurrentAndroidSyncObjectIds({
            limit: 1,
            afterObjectId,
          });
          reachedObjectScanEnd = overflow.length === 0;
          if (!reachedObjectScanEnd) objectWorkRemaining = true;
        }
        if (reachedObjectScanEnd) {
          await saveAndroidManualObjectScanCursor({
            afterObjectId: null,
            updatedAt: this.now(),
          });
        }
        objectProgressMade ||= !reachedObjectScanEnd && visited > 0;
        if (retention && hasRuntimeBudget()) {
          await refreshSyncObjectRetentionClocks(this.now());
          const cleanup = await retention.cleanupUnreferencedObjects(16);
          evictedObjects = cleanup.length;
        } else {
          objectWorkRemaining = true;
        }
      }

      // Daily maintenance must never delay the durable inbox/outbox path.
      // It only uses whatever time remains after inbox, send, receive and files.
      if (runMaintenance && hasRuntimeBudget()) {
        const retentionDeadline = Math.min(
          startedAt + runtimeLimitMs,
          this.now() + MAX_HIGH_SENSITIVITY_RETENTION_RUNTIME_MS,
        );
        highSensitivityRetention =
          await runAndroidHighSensitivityRetention({
            identity: enrollment.publicIdentity,
            domains,
            now: startedAt,
            shouldContinue: () => (
              hasRuntimeBudget()
              && this.now() < retentionDeadline
            ),
          });
      }
      if (runMaintenance && hasRuntimeBudget()) {
        transportCleanup =
          await cleanupCompletedSyncTransportHistory(startedAt);
      }
      if (runMaintenance && hasRuntimeBudget()) {
        temporaryCleanup =
          await cleanupStaleSyncObjectExpoStaging({
            now: startedAt,
            isDownloadStagingProtected: async (
              objectId,
              stagingUri,
            ) => {
              const job = await loadSyncObjectJob(objectId);
              return job?.direction === 'download'
                && job.localUri === stagingUri;
            },
          });
      }

      const sync = await androidSyncLedgerSnapshot();
      const memoryWorkRemaining = await hasPendingAndroidNewWorldMemoryChanges();
      const scheduleWorkRemaining = await hasPendingAndroidNewWorldScheduleChanges();
      const todoWorkRemaining = await hasPendingAndroidNewWorldTodoChanges();
      const giftWorkRemaining = await hasPendingAndroidGiftSyncChanges();
      const appliedCursor = await getAppliedRelayCursor();
      const acknowledgedFreshness =
        await relay.checkpointDeviceFreshness(
          enrollment,
          appliedCursor,
        );
      await saveSyncDeviceFreshnessCheckpoint({
        ...acknowledgedFreshness,
        updatedAt: this.now(),
      });
      if (
        acknowledgedFreshness.state === 'incremental'
        && sync.pendingOutbox === 0
        && sync.receivedInbox === 0
        && sync.pendingConflicts === 0
        && sync.quarantined === 0
        && sync.objectJobs === 0
        && !relayHasMore
        && !objectWorkRemaining
        && !memoryWorkRemaining
        && !scheduleWorkRemaining
        && !todoWorkRemaining
        && !giftWorkRemaining
        && hasRuntimeBudget()
      ) {
        finiteDeletionMaintenance =
          await runAndroidFiniteDeletionMaintenance({
            relay,
            enrollment,
            now: this.now(),
            shouldContinue: hasRuntimeBudget,
          });
      }
      const workRemaining = runtimeBudgetExhausted
        || memoryWorkRemaining
        || scheduleWorkRemaining
        || todoWorkRemaining
        || giftWorkRemaining
        || relayHasMore
        || equivalentDeleteRepair.hasMore
        || highSensitivityRetention.hasMore
        || finiteDeletionMaintenance.hasMore
        || objectWorkRemaining
        || sync.pendingOutbox > 0
        || sync.receivedInbox > 0
        || sync.pendingConflicts > 0
        || sync.quarantined > 0
        || sync.objectJobs > 0;
      return {
        state: workRemaining ? 'work-remaining' : 'complete',
        canContinue: workRemaining
          && sync.pendingConflicts === 0
          && sync.quarantined === 0
          && (
            sentMutations > 0 || receivedEntries > 0 || consumedEntries > 0
            || objectProgressMade || downloadedObjects > 0 || materializedObjects > 0
            || highSensitivityRetention.scanned > 0
            || finiteDeletionMaintenance.acknowledged > 0
            || equivalentDeleteRepair.resolvedConflicts > 0
          ),
        startedAt,
        completedAt: this.now(),
        sentBatches,
        sentMutations,
        duplicateMutations,
        receivedPages,
        receivedEntries,
        consumedEntries,
        uploadedObjects,
        downloadedObjects,
        materializedObjects,
        evictedObjects,
        cleanedTemporaryFiles: temporaryCleanup.deletedFiles,
        cleanedTemporaryDirectories:
          temporaryCleanup.deletedDirectories,
        prunedTransportOutbox: transportCleanup.deletedOutbox,
        prunedTransportInbox: transportCleanup.deletedInbox,
        prunedHighSensitivityRecords:
          highSensitivityRetention.tombstones,
        automaticSyncEnabled: false,
        sync,
        };
      },
    )).then(async (result) => {
      // Reconcile once after the batch releases its write lease, never per materialized row.
      if (result.consumedEntries > 0) {
        await import('../life/sleepPlanRuntime')
          .then(({ reconcileSleepPlan }) => reconcileSleepPlan(this.now(), dataEpoch))
          .catch(() => console.warn('[Sync] Sleep/contact alarm reconciliation failed.'));
      }
      return result;
    });
    androidManualSyncInFlight = operation;
    const clearInFlight = () => {
      if (androidManualSyncInFlight === operation) {
        androidManualSyncInFlight = null;
      }
    };
    operation.then(clearInFlight, clearInFlight);
    return operation;
  }
}

export function createAndroidManualSyncController(input: {
  baseUrl: string;
  now?: () => number;
}) {
  return new AndroidManualSyncController(
    input.baseUrl,
    input.now,
  );
}
