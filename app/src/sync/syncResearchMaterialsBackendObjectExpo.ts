import {
  Directory,
  File,
  Paths,
} from 'expo-file-system';

import {
  base64UrlToBytes,
  deriveSyncVaultKeysV1,
} from './syncCrypto';
import {
  expoSyncRandomUuidV1,
} from './syncCryptoExpo';
import {
  captureSyncContentObject,
} from './syncContentObjectCapture';
import {
  scheduleSyncObjectUpload,
} from './syncObjectJobStore';
import {
  syncObjectExpoFilePort,
} from './syncObjectExpoFilePort';
import type {
  ClaimedResearchMaterialsBackendObjectEntry,
  ResearchMaterialsBackendObjectPort,
} from './syncResearchMaterialsBackendOutbox';
import type {
  SyncRelayActiveEnrollmentV1,
} from './syncRelayClient';

const IMPORT_FOLDER = 'junluo-sync-research-import-v1';
const CHUNK_BYTES = 512 * 1024;
const STALE_IMPORT_AGE_MS = 5 * 60 * 1000;

function deleteStaleResearchImports(
  directory: Directory,
  now: number,
) {
  for (const entry of directory.list()) {
    if (!(entry instanceof File)) continue;
    const modificationTime = entry.info().modificationTime;
    if (
      modificationTime === undefined
      || modificationTime <= now - STALE_IMPORT_AGE_MS
    ) {
      entry.delete();
    }
  }
}

export async function captureResearchMaterialsBackendObject(input: {
  entry: ClaimedResearchMaterialsBackendObjectEntry;
  port: ResearchMaterialsBackendObjectPort;
  enrollment: SyncRelayActiveEnrollmentV1;
  now: number;
}) {
  const directory = new Directory(Paths.cache, IMPORT_FOLDER);
  directory.create({ idempotent: true, intermediates: true });
  deleteStaleResearchImports(directory, input.now);
  const source = new File(
    directory,
    `${input.entry.eventId}-${expoSyncRandomUuidV1()}`,
  );
  let handle: ReturnType<File['open']> | null = null;
  try {
    source.create({ overwrite: false, intermediates: true });
    handle = source.open();
    let offset = 0;
    while (offset < input.entry.payloadBytes) {
      const chunk = await input.port.readObjectChunk({
        localSequence: input.entry.localSequence,
        leaseId: input.entry.leaseId,
        offset,
        maximumBytes: CHUNK_BYTES,
      });
      if (
        chunk.localSequence !== input.entry.localSequence
        || chunk.offset !== offset
        || chunk.totalBytes !== input.entry.payloadBytes
        || chunk.payloadSha256 !== input.entry.payloadSha256
      ) {
        throw new Error('research-object-chunk-continuity-mismatch');
      }
      const bytes = base64UrlToBytes(
        chunk.data,
        'research object chunk data',
      );
      if (bytes.byteLength !== chunk.nextOffset - chunk.offset) {
        throw new Error('research-object-chunk-size-mismatch');
      }
      handle.writeBytes(bytes);
      offset = chunk.nextOffset;
      if (chunk.complete !== (offset === input.entry.payloadBytes)) {
        throw new Error('research-object-chunk-completion-mismatch');
      }
    }
    handle.close();
    handle = null;
    const vaultKeys = deriveSyncVaultKeysV1(base64UrlToBytes(
      input.enrollment.secrets.vaultRootSecret,
      'sync vaultRootSecret',
      32,
    ));
    const captured = await captureSyncContentObject({
      sourceUri: source.uri,
      stagingToken: expoSyncRandomUuidV1(),
      keyId: input.enrollment.publicIdentity.keyId,
      objectIdKey: vaultKeys.objectIdKey,
      files: syncObjectExpoFilePort,
      jobs: {
        scheduleUpload: scheduleSyncObjectUpload,
      },
      now: input.now,
    });
    return {
      objectId: captured.objectId,
      encoding: 'canonical-json-utf8' as const,
      plaintextBytes: captured.manifest.plaintextBytes,
      plaintextSha256: captured.manifest.plaintextSha256,
    };
  } finally {
    handle?.close();
    if (source.exists) source.delete();
  }
}
