import {
  base64UrlToBytes,
  canonicalizeJsonV1,
  deriveSyncVaultKeysV1,
  equalBytesConstantTimeV1,
} from './syncCrypto';
import type {
  SyncDevicePublicIdentityV1,
} from './syncDeviceContract';
import type {
  SyncObjectJob,
} from './syncObjectJobStore';
import {
  decideSyncObjectDownload,
  type SyncObjectNetworkClass,
} from './syncObjectPolicy';
import {
  assertSyncObjectIdMatchesManifestV1,
  openSyncObjectChunkV1,
  openSyncObjectManifestV1,
  sealSyncObjectChunkV1,
  sealSyncObjectManifestV1,
  type SealedSyncObjectChunkV1,
  type SealedSyncObjectManifestV1,
  type SyncObjectManifestPlaintextV1,
} from './syncObjectProtocol';
import {
  assertBase64Url,
} from './syncProtocol';
import {
  SyncRelayHttpError,
  type SyncRelayActiveEnrollmentV1,
} from './syncRelayClient';

const objectErrorMessage = (error: unknown) => {
  if (error instanceof Error) return error.message;
  if (
    typeof error === 'object'
    && error !== null
    && 'message' in error
    && typeof (error as { message?: unknown }).message === 'string'
  ) {
    return (error as { message: string }).message;
  }
  return typeof error === 'string' ? error : '';
};

const isObjectWriteConflict = (error: unknown) => (
  (error instanceof SyncRelayHttpError && error.status === 409)
  || (
    typeof error === 'object'
    && error !== null
    && 'status' in error
    && (error as { status?: unknown }).status === 409
  )
  || objectErrorMessage(error).startsWith('君落同步中继返回 409：')
);

const sameManifest = (
  left: SyncObjectManifestPlaintextV1,
  right: SyncObjectManifestPlaintextV1,
) => canonicalizeJsonV1(left) === canonicalizeJsonV1(right);

function throwObjectReuseVerificationFailure(
  part: 'manifest' | 'chunk',
  conflict: unknown,
  verificationError: unknown,
): never {
  const conflictMessage = objectErrorMessage(conflict)
    || '中继返回 object 写入冲突';
  const verificationMessage = objectErrorMessage(verificationError)
    || '未知验证错误';
  const failure = new Error(
    `${conflictMessage}；object ${part} 安全复用验证失败：`
    + verificationMessage,
  ) as Error & { cause?: unknown };
  failure.cause = conflict;
  throw failure;
}

export const MAX_ANDROID_OBJECT_TRANSFERS_PER_RUN = 16;

export interface AndroidSyncObjectRelayPort {
  listDevices(
    enrollment: SyncRelayActiveEnrollmentV1,
  ): Promise<SyncDevicePublicIdentityV1[]>;
  putObjectManifest(
    enrollment: SyncRelayActiveEnrollmentV1,
    manifest: SealedSyncObjectManifestV1,
  ): Promise<unknown>;
  getObjectManifest(
    enrollment: SyncRelayActiveEnrollmentV1,
    objectId: string,
  ): Promise<SealedSyncObjectManifestV1>;
  putObjectChunk(
    enrollment: SyncRelayActiveEnrollmentV1,
    chunk: SealedSyncObjectChunkV1,
  ): Promise<unknown>;
  getObjectChunk(
    enrollment: SyncRelayActiveEnrollmentV1,
    objectId: string,
    chunkIndex: number,
  ): Promise<SealedSyncObjectChunkV1>;
}

export interface AndroidSyncObjectJobPort {
  load(objectId: string): Promise<SyncObjectJob | null>;
  listRunnable(
    direction: SyncObjectJob['direction'],
    limit: number,
    input?: { includeSourceMissing?: boolean },
  ): Promise<SyncObjectJob[]>;
  startUpload(
    objectId: string,
    startedAt: number,
  ): Promise<SyncObjectJob>;
  startDownload(input: {
    objectId: string;
    keyId: string;
    totalChunks: number;
    completedChunks: number;
    stagingUri: string;
    startedAt: number;
  }): Promise<SyncObjectJob>;
  updateProgress(input: {
    objectId: string;
    direction: SyncObjectJob['direction'];
    completedChunks: number;
    updatedAt: number;
  }): Promise<void>;
  markVerified(input: {
    objectId: string;
    direction: SyncObjectJob['direction'];
    localUri: string;
    verifiedAt: number;
  }): Promise<void>;
  markFailed(input: {
    objectId: string;
    direction: SyncObjectJob['direction'];
    errorCode: string;
    failedAt: number;
  }): Promise<void>;
}

export interface AndroidSyncObjectFileStore {
  managedObjectExists?(objectId: string): Promise<boolean>;
  verifiedObjectUri(
    objectId: string,
    objectIdKey: Uint8Array,
  ): Promise<string | null>;
  scanUpload(input: {
    objectId: string;
    localUri: string;
    objectIdKey: Uint8Array;
  }): Promise<SyncObjectManifestPlaintextV1>;
  readUploadChunk(input: {
    localUri: string;
    manifest: SyncObjectManifestPlaintextV1;
    chunkIndex: number;
  }): Promise<Uint8Array>;
  sealUploadChunk?(input: {
    localUri: string;
    manifest: SyncObjectManifestPlaintextV1;
    chunkIndex: number;
    identity: {
      vaultId: string;
      sourceDeviceId: string;
      keyId: string;
      objectEncryptionKey: Uint8Array;
      signingPrivateKey: Uint8Array;
    };
  }): Promise<SealedSyncObjectChunkV1>;
  prepareDownload(input: {
    sealedManifest: SealedSyncObjectManifestV1;
    manifest: SyncObjectManifestPlaintextV1;
  }): Promise<{
    stagingUri: string;
    completedChunks: number;
  }>;
  hasVerifiedDownloadChunk(
    manifest: SyncObjectManifestPlaintextV1,
    chunkIndex: number,
  ): Promise<boolean>;
  saveVerifiedDownloadChunk(input: {
    manifest: SyncObjectManifestPlaintextV1;
    chunkIndex: number;
    plaintext: Uint8Array;
  }): Promise<void>;
  completedDownloadChunks(
    manifest: SyncObjectManifestPlaintextV1,
  ): Promise<number>;
  assembleVerifiedObject(
    manifest: SyncObjectManifestPlaintextV1,
    objectIdKey: Uint8Array,
  ): Promise<string>;
}

export interface AndroidSyncObjectDeviceDirectoryPort {
  save(identity: SyncDevicePublicIdentityV1): Promise<void>;
  resolveSigningPublicKey(input: {
    vaultId: string;
    deviceId: string;
    keyId: string;
  }): Promise<string>;
}

export class AndroidSyncObjectTransferRuntime {
  private readonly objectEncryptionKey: Uint8Array;
  private readonly objectIdKey: Uint8Array;
  private readonly sealIdentity;

  constructor(
    private readonly relay: AndroidSyncObjectRelayPort,
    private readonly jobs: AndroidSyncObjectJobPort,
    private readonly files: AndroidSyncObjectFileStore,
    private readonly devices: AndroidSyncObjectDeviceDirectoryPort,
    private readonly enrollment: SyncRelayActiveEnrollmentV1,
    private readonly now: () => number = Date.now,
    private readonly metadataStore?: {
      record(input: {
        objectId: string;
        ciphertextBytes: number;
        updatedAt: number;
      }): Promise<void>;
    },
  ) {
    if (
      enrollment.publicIdentity.state !== 'active'
      || enrollment.publicIdentity.revokedAt !== null
    ) {
      throw new Error('对象传输只能使用 active Android 设备。');
    }
    const keys = deriveSyncVaultKeysV1(base64UrlToBytes(
      enrollment.secrets.vaultRootSecret,
      'vaultRootSecret',
      32,
    ));
    this.objectEncryptionKey = keys.objectEncryptionKey;
    this.objectIdKey = keys.objectIdKey;
    this.sealIdentity = {
      vaultId: enrollment.publicIdentity.vaultId,
      sourceDeviceId: enrollment.publicIdentity.deviceId,
      keyId: enrollment.publicIdentity.keyId,
      objectEncryptionKey: keys.objectEncryptionKey,
      signingPrivateKey: base64UrlToBytes(
        enrollment.secrets.signingPrivateKey,
        'signingPrivateKey',
        32,
      ),
    };
  }

  private async vaultKeysForKeyId(keyId: string) {
    if (keyId !== this.enrollment.publicIdentity.keyId) {
      throw new Error(
        'Android 收到非当前 keyId 的对象；请重建新世界。',
      );
    }
    return deriveSyncVaultKeysV1(base64UrlToBytes(
      this.enrollment.secrets.vaultRootSecret,
      'vaultRootSecret',
      32,
    ));
  }

  private async refreshDeviceDirectory() {
    await this.devices.save(this.enrollment.publicIdentity);
    const identities = await this.relay.listDevices(this.enrollment);
    for (const identity of identities) {
      await this.devices.save(identity);
    }
  }

  private async signingPublicKey(input: {
    sourceDeviceId: string;
    keyId: string;
  }) {
    return base64UrlToBytes(
      await this.devices.resolveSigningPublicKey({
        vaultId: this.enrollment.publicIdentity.vaultId,
        deviceId: input.sourceDeviceId,
        keyId: input.keyId,
      }),
      'object signingPublicKey',
      32,
    );
  }

  private async confirmExistingManifest(
    manifest: SyncObjectManifestPlaintextV1,
    conflict: unknown,
  ) {
    if (!isObjectWriteConflict(conflict)) throw conflict;
    try {
      const sealed = await this.relay.getObjectManifest(
        this.enrollment,
        manifest.objectId,
      );
      const keys = await this.vaultKeysForKeyId(sealed.keyId);
      const existing = openSyncObjectManifestV1(sealed, {
        objectEncryptionKey: keys.objectEncryptionKey,
        signingPublicKey: await this.signingPublicKey(sealed),
      });
      assertSyncObjectIdMatchesManifestV1(existing, keys.objectIdKey);
      if (!sameManifest(existing, manifest)) {
        throw new Error('中继已有 object manifest 的明文内容不同。');
      }
    } catch (verificationError) {
      throwObjectReuseVerificationFailure(
        'manifest',
        conflict,
        verificationError,
      );
    }
  }

  private async confirmExistingChunk(input: {
    manifest: SyncObjectManifestPlaintextV1;
    chunkIndex: number;
    plaintext: Uint8Array;
    conflict: unknown;
  }) {
    if (!isObjectWriteConflict(input.conflict)) throw input.conflict;
    try {
      const sealed = await this.relay.getObjectChunk(
        this.enrollment,
        input.manifest.objectId,
        input.chunkIndex,
      );
      const keys = await this.vaultKeysForKeyId(sealed.keyId);
      const existing = openSyncObjectChunkV1({
        manifest: input.manifest,
        sealed,
        identity: {
          objectEncryptionKey: keys.objectEncryptionKey,
          signingPublicKey: await this.signingPublicKey(sealed),
        },
      });
      if (!equalBytesConstantTimeV1(existing, input.plaintext)) {
        throw new Error('中继已有 object chunk 的明文内容不同。');
      }
    } catch (verificationError) {
      throwObjectReuseVerificationFailure(
        'chunk',
        input.conflict,
        verificationError,
      );
    }
  }

  async uploadObject(
    objectId: string,
    input: {
      shouldContinue?: () => boolean;
      tryStartChunk?: () => boolean;
    } = {},
  ) {
    assertBase64Url(objectId, 'objectId', { exactBytes: 32 });
    const mayContinue = () => input.shouldContinue?.() !== false;
    if (!mayContinue()) {
      return {
        state: 'deferred' as const,
        objectId,
        uploadedChunks: 0,
      };
    }
    const cachedUri = await this.files.verifiedObjectUri(
      objectId,
      this.objectIdKey,
    );
    const existing = await this.jobs.load(objectId);
    if (existing?.state === 'verified' && cachedUri) {
      return {
        state: 'uploaded' as const,
        objectId,
        uploadedChunks: existing.totalChunks,
        cached: true,
      };
    }
    if (!mayContinue()) {
      return {
        state: 'deferred' as const,
        objectId,
        uploadedChunks: existing?.completedChunks ?? 0,
      };
    }

    if (
      existing
      && existing.state !== 'verified'
      && await this.files.managedObjectExists?.(objectId) === false
    ) {
      await this.jobs.markFailed({
        objectId,
        direction: 'upload',
        errorCode: 'object.source-missing',
        failedAt: this.now(),
      });
      return {
        state: 'deferred' as const,
        reason: 'source-missing' as const,
        objectId,
        uploadedChunks: existing.completedChunks,
      };
    }

    let started = false;
    try {
      const job = await this.jobs.startUpload(objectId, this.now());
      started = true;
      if (!mayContinue()) {
        return {
          state: 'deferred' as const,
          objectId,
          uploadedChunks: job.completedChunks,
        };
      }
      await this.refreshDeviceDirectory();
      if (!mayContinue()) {
        return {
          state: 'deferred' as const,
          objectId,
          uploadedChunks: job.completedChunks,
        };
      }
      const localUri = await this.files.verifiedObjectUri(
        objectId,
        this.objectIdKey,
      );
      if (!localUri || localUri !== job.localUri) {
        throw new Error('object upload job 与受管本机文件不一致。');
      }
      if (!mayContinue()) {
        return {
          state: 'deferred' as const,
          objectId,
          uploadedChunks: job.completedChunks,
        };
      }
      const manifest = await this.files.scanUpload({
        objectId,
        localUri,
        objectIdKey: this.objectIdKey,
      });
      assertSyncObjectIdMatchesManifestV1(
        manifest,
        this.objectIdKey,
      );
      if (
        job.keyId !== this.enrollment.publicIdentity.keyId
        || job.totalChunks !== manifest.chunks.length
        || job.completedChunks > job.totalChunks
      ) {
        throw new Error('object upload job 与本机 manifest 不一致。');
      }
      if (!mayContinue()) {
        return {
          state: 'deferred' as const,
          objectId,
          uploadedChunks: job.completedChunks,
        };
      }
      try {
        const sealedManifest = sealSyncObjectManifestV1(
          manifest,
          this.sealIdentity,
        );
        await this.relay.putObjectManifest(
          this.enrollment,
          sealedManifest,
        );
      } catch (error) {
        await this.confirmExistingManifest(manifest, error);
      }
      let completed = job.completedChunks;
      if (!mayContinue()) {
        return {
          state: 'deferred' as const,
          objectId,
          uploadedChunks: completed,
        };
      }
      for (
        let chunkIndex = completed;
        chunkIndex < manifest.chunks.length;
        chunkIndex += 1
      ) {
        if (!mayContinue()) {
          return {
            state: 'deferred' as const,
            objectId,
            uploadedChunks: completed,
          };
        }
        if (input.tryStartChunk && !input.tryStartChunk()) {
          return {
            state: 'deferred' as const,
            objectId,
            uploadedChunks: completed,
          };
        }
        let plaintext: Uint8Array | null = null;
        let sealedChunk: SealedSyncObjectChunkV1;
        if (this.files.sealUploadChunk) {
          sealedChunk = await this.files.sealUploadChunk({
            localUri,
            manifest,
            chunkIndex,
            identity: this.sealIdentity,
          });
        } else {
          plaintext = await this.files.readUploadChunk({
            localUri,
            manifest,
            chunkIndex,
          });
          sealedChunk = sealSyncObjectChunkV1({
            manifest,
            chunkIndex,
            plaintext,
            identity: this.sealIdentity,
          });
        }
        if (!mayContinue()) {
          return {
            state: 'deferred' as const,
            objectId,
            uploadedChunks: completed,
          };
        }
        try {
          await this.relay.putObjectChunk(
            this.enrollment,
            sealedChunk,
          );
        } catch (error) {
          const conflict = isObjectWriteConflict(error);
          if (!conflict) throw error;
          const conflictPlaintext = plaintext
            ?? await this.files.readUploadChunk({
              localUri,
              manifest,
              chunkIndex,
            });
          await this.confirmExistingChunk({
            manifest,
            chunkIndex,
            plaintext: conflictPlaintext,
            conflict: error,
          });
        }
        completed = chunkIndex + 1;
        await this.jobs.updateProgress({
          objectId,
          direction: 'upload',
          completedChunks: completed,
          updatedAt: this.now(),
        });
      }
      await this.jobs.markVerified({
        objectId,
        direction: 'upload',
        localUri,
        verifiedAt: this.now(),
      });
      return {
        state: 'uploaded' as const,
        objectId,
        uploadedChunks: completed,
        cached: false,
      };
    } catch (error) {
      if (started) {
        await this.jobs.markFailed({
          objectId,
          direction: 'upload',
          errorCode: 'object.upload-failed',
          failedAt: this.now(),
        });
      }
      throw error;
    }
  }

  async downloadObject(
    objectId: string,
    input: {
      network: SyncObjectNetworkClass;
      requestedByUser: boolean;
      maximumChunks?: number;
    },
  ) {
    assertBase64Url(objectId, 'objectId', { exactBytes: 32 });
    const existing = await this.jobs.load(objectId);
    const resumesStartedDownload = existing?.direction === 'download'
      && (existing.state === 'running' || existing.state === 'failed')
      && existing.localUri !== null;
    const cachedKeys = existing
      ? await this.vaultKeysForKeyId(existing.keyId)
      : {
          objectEncryptionKey: this.objectEncryptionKey,
          objectIdKey: this.objectIdKey,
        };
    const cachedUri = await this.files.verifiedObjectUri(
      objectId,
      cachedKeys.objectIdKey,
    );
    if (cachedUri) {
      return {
        state: 'downloaded' as const,
        objectId,
        localUri: cachedUri,
        cached: true,
      };
    }
    if (
      input.network !== 'offline'
      && input.network !== 'cellular'
      && input.network !== 'wifi'
    ) {
      throw new Error('对象下载网络类型无效。');
    }
    if (typeof input.requestedByUser !== 'boolean') {
      throw new Error('对象下载请求来源无效。');
    }
    if (
      input.maximumChunks !== undefined
      && (
        !Number.isSafeInteger(input.maximumChunks)
        || input.maximumChunks < 1
        || input.maximumChunks > 256
      )
    ) {
      throw new Error('对象下载 maximumChunks 必须为 1..256。');
    }
    if (input.network === 'offline') {
      return { state: 'wait-network' as const, objectId };
    }

    let started = false;
    try {
      await this.refreshDeviceDirectory();
      const sealedManifest = await this.relay.getObjectManifest(
        this.enrollment,
        objectId,
      );
      const objectKeys = await this.vaultKeysForKeyId(
        sealedManifest.keyId,
      );
      const manifest = openSyncObjectManifestV1(
        sealedManifest,
        {
          objectEncryptionKey: objectKeys.objectEncryptionKey,
          signingPublicKey: await this.signingPublicKey(
            sealedManifest,
          ),
        },
      );
      assertSyncObjectIdMatchesManifestV1(
        manifest,
        objectKeys.objectIdKey,
      );
      await this.metadataStore?.record({
        objectId,
        ciphertextBytes: sealedManifest.ciphertextBytes,
        updatedAt: this.now(),
      });
      const decision = decideSyncObjectDownload({
        ciphertextBytes: sealedManifest.ciphertextBytes,
        network: input.network,
        requestedByUser:
          input.requestedByUser || resumesStartedDownload,
      });
      if (decision !== 'download') {
        return {
          state: decision,
          objectId,
          ciphertextBytes: sealedManifest.ciphertextBytes,
        };
      }
      const prepared = await this.files.prepareDownload({
        sealedManifest,
        manifest,
      });
      await this.jobs.startDownload({
        objectId,
        keyId: sealedManifest.keyId,
        totalChunks: manifest.chunks.length,
        completedChunks: prepared.completedChunks,
        stagingUri: prepared.stagingUri,
        startedAt: this.now(),
      });
      started = true;
      let completed = prepared.completedChunks;
      let downloadedChunks = 0;
      for (const descriptor of manifest.chunks) {
        if (await this.files.hasVerifiedDownloadChunk(
          manifest,
          descriptor.chunkIndex,
        )) {
          continue;
        }
        if (
          input.maximumChunks !== undefined
          && downloadedChunks >= input.maximumChunks
        ) {
          return {
            state: 'work-remaining' as const,
            objectId,
            completedChunks: completed,
          };
        }
        const sealedChunk = await this.relay.getObjectChunk(
          this.enrollment,
          objectId,
          descriptor.chunkIndex,
        );
        const plaintext = openSyncObjectChunkV1({
          manifest,
          sealed: sealedChunk,
          identity: {
            objectEncryptionKey: objectKeys.objectEncryptionKey,
            signingPublicKey: await this.signingPublicKey(
              sealedChunk,
            ),
          },
        });
        await this.files.saveVerifiedDownloadChunk({
          manifest,
          chunkIndex: descriptor.chunkIndex,
          plaintext,
        });
        completed = await this.files.completedDownloadChunks(
          manifest,
        );
        await this.jobs.updateProgress({
          objectId,
          direction: 'download',
          completedChunks: completed,
          updatedAt: this.now(),
        });
        downloadedChunks += 1;
      }
      const localUri = await this.files.assembleVerifiedObject(
        manifest,
        objectKeys.objectIdKey,
      );
      await this.jobs.markVerified({
        objectId,
        direction: 'download',
        localUri,
        verifiedAt: this.now(),
      });
      return {
        state: 'downloaded' as const,
        objectId,
        localUri,
        cached: false,
        downloadedChunks,
      };
    } catch (error) {
      if (started) {
        await this.jobs.markFailed({
          objectId,
          direction: 'download',
          errorCode: 'object.download-failed',
          failedAt: this.now(),
        });
      }
      throw error;
    }
  }

  async uploadPendingObjects(input: {
    shouldContinue?: () => boolean;
    maximumChunks?: number;
    retrySourceMissing?: boolean;
  } = {}) {
    if (
      input.maximumChunks !== undefined
      && (
        !Number.isSafeInteger(input.maximumChunks)
        || input.maximumChunks < 1
        || input.maximumChunks > 256
      )
    ) {
      throw new Error('object upload maximumChunks 必须为 1..256。');
    }
    const jobs = await this.jobs.listRunnable(
      'upload',
      MAX_ANDROID_OBJECT_TRANSFERS_PER_RUN,
      { includeSourceMissing: input.retrySourceMissing !== false },
    );
    let remainingChunks = input.maximumChunks ?? Number.POSITIVE_INFINITY;
    const initialChunkBudget = remainingChunks;
    let uploadedObjects = 0;
    for (const job of jobs) {
      if (input.shouldContinue && !input.shouldContinue()) break;
      const result = await this.uploadObject(job.objectId, {
        shouldContinue: input.shouldContinue,
        tryStartChunk: () => {
          if (remainingChunks < 1) return false;
          remainingChunks -= 1;
          return true;
        },
      });
      if (result.state !== 'uploaded') break;
      uploadedObjects += 1;
    }
    return {
      uploadedObjects,
      processedChunks: Number.isFinite(initialChunkBudget)
        ? initialChunkBudget - remainingChunks
        : 0,
      hasMore: (await this.jobs.listRunnable(
        'upload',
        1,
        { includeSourceMissing: input.retrySourceMissing !== false },
      )).length > 0,
    };
  }

  async downloadPendingObjects(input: {
    network: SyncObjectNetworkClass;
    requestedByUser: boolean;
  }) {
    const jobs = await this.jobs.listRunnable(
      'download',
      MAX_ANDROID_OBJECT_TRANSFERS_PER_RUN,
    );
    let downloadedObjects = 0;
    let deferredObjects = 0;
    for (const job of jobs) {
      const result = await this.downloadObject(job.objectId, input);
      if (result.state === 'downloaded') downloadedObjects += 1;
      else deferredObjects += 1;
    }
    return {
      downloadedObjects,
      deferredObjects,
      hasMore: deferredObjects > 0
        || (await this.jobs.listRunnable('download', 1)).length > 0,
    };
  }
}
