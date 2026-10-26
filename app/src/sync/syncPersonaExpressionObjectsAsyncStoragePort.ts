import RawAsyncStorage from '@react-native-async-storage/async-storage';

import {
  assertPersonaExpressionObjectsRecord,
  parseExpressionFieldEntityId,
  type PersonaExpressionFieldRecord,
  type PersonaStickerMetadataRecord,
} from './syncPersonaExpressionObjects';
import type {
  PersonaExpressionObjectsBusinessPort,
} from './syncPersonaExpressionObjectsApply';
import {
  PERSONA_EXPRESSION_OBJECT_KEYS,
  parsePersonaExpressionLibraryStorage,
  parsePersonaStickerLibraryStorage,
  serializePersonaExpressionLibraryStorage,
  serializePersonaStickerLibraryStorage,
} from './syncPersonaExpressionObjectsStorageDerivation';
import {
  loadSyncObjectJob,
} from './syncObjectJobStore';
import {
  materializePersonaStickerObjectFile,
} from './syncPersonaStickerMaterialization';

let personaExpressionObjectsApplyQueue = Promise.resolve();

function enqueuePersonaExpressionObjectsApply<T>(
  callback: () => Promise<T>,
) {
  const current = personaExpressionObjectsApplyQueue
    .catch(() => undefined)
    .then(callback);
  personaExpressionObjectsApplyQueue = current.then(
    () => undefined,
    () => undefined,
  );
  return current;
}

async function loadExpressionLibrary() {
  const raw = await RawAsyncStorage.getItem(
    PERSONA_EXPRESSION_OBJECT_KEYS.expressionLibrary,
  );
  return raw
    ? parsePersonaExpressionLibraryStorage(raw)
    : { categories: {}, updatedAt: 0 };
}

async function loadStickerLibrary() {
  const raw = await RawAsyncStorage.getItem(
    PERSONA_EXPRESSION_OBJECT_KEYS.stickerLibrary,
  );
  return raw
    ? parsePersonaStickerLibraryStorage(raw)
    : { stickers: [], updatedAt: 0 };
}

async function saveExpressionLibrary(
  library: Awaited<ReturnType<typeof loadExpressionLibrary>>,
) {
  await RawAsyncStorage.setItem(
    PERSONA_EXPRESSION_OBJECT_KEYS.expressionLibrary,
    serializePersonaExpressionLibraryStorage(library),
  );
  await RawAsyncStorage.removeItem(
    PERSONA_EXPRESSION_OBJECT_KEYS.legacyExpressionLibrary,
  );
}

async function materializedStickerUri(
  sticker: PersonaStickerMetadataRecord,
  existing?: { objectId?: string; uri?: string },
) {
  if (
    existing?.objectId === sticker.objectId
    && existing.uri
    && /^file:\/\//.test(existing.uri)
  ) {
    return existing.uri;
  }
  const job = await loadSyncObjectJob(sticker.objectId);
  if (
    job?.state !== 'verified'
    || !job.localUri
    || !/^file:\/\//.test(job.localUri)
  ) {
    return undefined;
  }
  return materializePersonaStickerObjectFile({
    sourceUri: job.localUri,
    sticker,
  });
}

async function upsertExpressionField(
  input: Parameters<
    PersonaExpressionObjectsBusinessPort['upsertRecord']
  >[0],
) {
  assertPersonaExpressionObjectsRecord(
    input.kind,
    input.entityId,
    input.value,
  );
  const record = input.value as PersonaExpressionFieldRecord;
  const library = await loadExpressionLibrary();
  const current = library.categories[record.moodId] ?? {
    emojiText: '',
    kaomojiText: '',
  };
  library.categories[record.moodId] = {
    ...current,
    [record.field]: record.text,
  };
  library.updatedAt = Math.max(
    library.updatedAt,
    input.revision.createdAt,
  );
  await saveExpressionLibrary(library);
}

async function upsertSticker(
  input: Parameters<
    PersonaExpressionObjectsBusinessPort['upsertRecord']
  >[0],
) {
  assertPersonaExpressionObjectsRecord(
    input.kind,
    input.entityId,
    input.value,
  );
  const sticker = input.value as PersonaStickerMetadataRecord;
  const library = await loadStickerLibrary();
  const existing = library.stickers.find(
    (item) => item.id === sticker.id,
  );
  const uri = await materializedStickerUri(sticker, existing);
  const nextSticker = {
    ...sticker,
    ...(uri ? { uri } : {}),
  };
  const index = library.stickers.findIndex(
    (item) => item.id === sticker.id,
  );
  if (index < 0) {
    library.stickers.push(nextSticker);
  } else {
    library.stickers[index] = nextSticker;
  }
  library.stickers = library.stickers.slice(-240);
  library.updatedAt = Math.max(
    library.updatedAt,
    input.revision.createdAt,
  );
  await RawAsyncStorage.setItem(
    PERSONA_EXPRESSION_OBJECT_KEYS.stickerLibrary,
    serializePersonaStickerLibraryStorage(library),
  );
}

async function upsertRecord(
  input: Parameters<
    PersonaExpressionObjectsBusinessPort['upsertRecord']
  >[0],
) {
  if (
    input.entityType === 'expression'
    && input.kind === 'expression-field'
  ) {
    await upsertExpressionField(input);
    return;
  }
  if (
    input.entityType === 'sticker'
    && input.kind === 'sticker-metadata'
  ) {
    await upsertSticker(input);
    return;
  }
  throw new Error('persona.expression-objects apply entity/kind 不匹配。');
}

async function tombstone(
  input: Parameters<
    PersonaExpressionObjectsBusinessPort['tombstone']
  >[0],
) {
  if (input.entityType === 'expression') {
    const { moodId, field } = parseExpressionFieldEntityId(input.entityId);
    const library = await loadExpressionLibrary();
    const current = library.categories[moodId];
    if (current) {
      const next = {
        ...current,
        [field]: '',
      };
      if (!next.emojiText && !next.kaomojiText) {
        delete library.categories[moodId];
      } else {
        library.categories[moodId] = next;
      }
    }
    library.updatedAt = Math.max(
      library.updatedAt,
      input.revision.createdAt,
    );
    await saveExpressionLibrary(library);
    return;
  }
  const library = await loadStickerLibrary();
  library.stickers = library.stickers.filter(
    (item) => item.id !== input.entityId,
  );
  library.updatedAt = Math.max(
    library.updatedAt,
    input.revision.createdAt,
  );
  await RawAsyncStorage.setItem(
    PERSONA_EXPRESSION_OBJECT_KEYS.stickerLibrary,
    serializePersonaStickerLibraryStorage(library),
  );
}

export async function materializePersonaStickerObject(input: {
  objectId: string;
  localUri: string;
}) {
  return enqueuePersonaExpressionObjectsApply(async () => {
    const library = await loadStickerLibrary();
    let matched = false;
    let changed = false;
    for (const sticker of library.stickers) {
      if (sticker.objectId !== input.objectId) continue;
      matched = true;
      const uri = await materializePersonaStickerObjectFile({
        sourceUri: input.localUri,
        sticker: sticker as PersonaStickerMetadataRecord,
      });
      if (sticker.uri !== uri) {
        sticker.uri = uri;
        changed = true;
      }
    }
    if (changed) {
      await RawAsyncStorage.setItem(
        PERSONA_EXPRESSION_OBJECT_KEYS.stickerLibrary,
        serializePersonaStickerLibraryStorage(library),
      );
    }
    return {
      handled: matched,
      pending: !matched,
      changed,
    };
  });
}

export const personaExpressionObjectsAsyncStorageBusinessPort:
PersonaExpressionObjectsBusinessPort = {
  upsertRecord: (input) => enqueuePersonaExpressionObjectsApply(
    () => upsertRecord(input),
  ),
  tombstone: (input) => enqueuePersonaExpressionObjectsApply(
    () => tombstone(input),
  ),
};
