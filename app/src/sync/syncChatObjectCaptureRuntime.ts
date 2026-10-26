import type {
  SubjectiveMessage,
} from '../ai/subjectiveMessages';
import {
  base64UrlToBytes,
  deriveSyncVaultKeysV1,
} from './syncCrypto';
import {
  expoSyncRandomUuidV1,
} from './syncCryptoExpo';
import type {
  SyncDevicePublicIdentityV1,
  SyncDeviceSecretsV1,
} from './syncDeviceContract';
import {
  captureSyncContentObject,
} from './syncContentObjectCapture';
import type {
  ChatStorageChange,
} from './syncChatStorageDerivation';
import {
  scheduleSyncObjectUpload,
} from './syncObjectJobStore';
import {
  syncObjectExpoFilePort,
} from './syncObjectExpoFilePort';

const CHAT_SESSION_MESSAGE_PREFIX = 'junluo.chat.sessionMessage.';

function parseMessage(raw: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('聊天附件所在消息不是有效 JSON。');
  }
  if (
    !parsed
    || typeof parsed !== 'object'
    || Array.isArray(parsed)
    || typeof (parsed as { id?: unknown }).id !== 'string'
  ) {
    throw new Error('聊天附件所在消息缺少稳定 ID。');
  }
  return parsed as SubjectiveMessage;
}

function attachmentSources(message: SubjectiveMessage) {
  const sources: { lookupKey: string; uri: string }[] = [];
  if (message.voice?.uri) {
    sources.push({
      lookupKey: `${message.id}:voice`,
      uri: message.voice.uri,
    });
  }
  for (const image of message.images ?? []) {
    if (image.uri) sources.push({ lookupKey: image.id, uri: image.uri });
  }
  if (message.sticker?.uri) {
    sources.push({
      lookupKey: message.sticker.id,
      uri: message.sticker.uri,
    });
  }
  return sources;
}

export async function captureChatObjectsForStorageChanges(input: {
  changes: readonly ChatStorageChange[];
  identity: SyncDevicePublicIdentityV1;
  secrets: SyncDeviceSecretsV1;
  now: number;
}) {
  const vaultRootSecret = base64UrlToBytes(
    input.secrets.vaultRootSecret,
    'sync vaultRootSecret',
    32,
  );
  let vaultKeys: ReturnType<typeof deriveSyncVaultKeysV1> | undefined;
  const objectIds: Record<string, string> = {};
  const capturedByUri = new Map<string, string>();
  for (const change of input.changes) {
    if (
      change.kind !== 'set'
      || !change.key.startsWith(CHAT_SESSION_MESSAGE_PREFIX)
    ) {
      continue;
    }
    const message = parseMessage(change.value);
    for (const source of attachmentSources(message)) {
      const capturedObjectId = capturedByUri.get(source.uri);
      if (capturedObjectId) {
        objectIds[source.lookupKey] = capturedObjectId;
        continue;
      }
      vaultKeys ??= deriveSyncVaultKeysV1(vaultRootSecret);
      const captured = await captureSyncContentObject({
        sourceUri: source.uri,
        stagingToken: expoSyncRandomUuidV1(),
        keyId: input.identity.keyId,
        objectIdKey: vaultKeys.objectIdKey,
        files: syncObjectExpoFilePort,
        jobs: {
          scheduleUpload: scheduleSyncObjectUpload,
        },
        now: input.now,
      });
      capturedByUri.set(source.uri, captured.objectId);
      objectIds[source.lookupKey] = captured.objectId;
    }
  }
  return objectIds;
}
