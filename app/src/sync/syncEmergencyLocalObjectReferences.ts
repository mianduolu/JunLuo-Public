type StoredRecord = Record<string, unknown>;
type ObjectReplacement = { objectId: string; keyId: string; localUri: string };

const OBJECT_ID = /^[A-Za-z0-9_-]{43}$/;
const MANAGED_URI = /^file:\/\/\/(?:[^?#]*\/)?junluo-sync-objects-v1\/objects\/([A-Za-z0-9_-]{43})$/;
const MESSAGE_PREFIX = 'junluo.chat.sessionMessage.';
const LEGACY_MESSAGES_PREFIX = 'junluo.chat.sessionMessages.';
const CHAPTER_KEY = /^junluo\.reading\.chapter\.[A-Za-z0-9][A-Za-z0-9_-]*\.\d+\.v1$/;
const STORAGE_KEYS = new Set([
  'junluo.chat.primaryMessages',
  'junluo.chat.sessions',
  'junluo.sync.reading.objects.v1',
  'junluo.reading.library.v1',
  'junluo.sync.togetherWalked.life.v1',
  'junluo.togetherWalked.entries.v1',
  'junluo.togetherWalked.draft.v1',
  'junluo.sync.tools.workspace.files.v1',
  'junluo.tools.files.imports.v1',
  'junluo.persona.stickerLibrary.v1',
  'junluo.sync.appearance.fonts.v1',
  'junluo.sync.appearance.background.v1',
  'junluo.backgroundSettings',
]);

export function isEmergencyObjectReferenceStorageKey(key: string): boolean {
  return STORAGE_KEYS.has(key)
    || (key.startsWith(MESSAGE_PREFIX) && key.length > MESSAGE_PREFIX.length)
    || (key.startsWith(LEGACY_MESSAGES_PREFIX) && key.length > LEGACY_MESSAGES_PREFIX.length)
    || CHAPTER_KEY.test(key);
}

function record(value: unknown): StoredRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as StoredRecord : undefined;
}

function eachRecord(value: unknown, visit: (entry: StoredRecord) => void) {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const item = record(entry);
      if (item) visit(item);
    }
  }
}

// Deliberately visit known media fields, never prose or arbitrary nested JSON.
function visitReferences(
  key: string,
  value: unknown,
  id: (owner: StoredRecord, field: string, keyOwner?: StoredRecord) => void,
  uri: (owner: StoredRecord, field: string) => void,
) {
  const root = record(value);
  const message = (entry: StoredRecord) => {
    const voice = record(entry.voice);
    if (voice) uri(voice, 'uri');
    eachRecord(entry.images, image => uri(image, 'uri'));
    const sticker = record(entry.sticker);
    if (sticker) uri(sticker, 'uri');
  };
  if (key.startsWith(MESSAGE_PREFIX)) {
    if (root) message(root);
  } else if (key === 'junluo.chat.primaryMessages' || key.startsWith(LEGACY_MESSAGES_PREFIX)) {
    eachRecord(value, message);
  } else if (key === 'junluo.chat.sessions') {
    eachRecord(value, session => eachRecord(session.messages, message));
  } else if (key === 'junluo.sync.reading.objects.v1') {
    eachRecord(root?.records, entry => {
      id(entry, 'objectId', entry);
      uri(entry, 'localUri');
    });
  } else if (key === 'junluo.reading.library.v1') {
    eachRecord(Array.isArray(value) ? value : root?.books, book => {
      uri(book, 'fileUri');
      uri(book, 'coverUri');
    });
  } else if (CHAPTER_KEY.test(key)) {
    eachRecord(root?.images, image => uri(image, 'uri'));
  } else if (key === 'junluo.sync.togetherWalked.life.v1') {
    eachRecord(root?.objects, entry => {
      id(entry, 'objectId', entry);
      uri(entry, 'localUri');
    });
  } else if (key === 'junluo.togetherWalked.entries.v1') {
    eachRecord(value, entry => uri(entry, 'imageUri'));
  } else if (key === 'junluo.togetherWalked.draft.v1') {
    if (root) uri(root, 'imageUri');
  } else if (key === 'junluo.sync.tools.workspace.files.v1') {
    eachRecord(root?.records, entry => {
      const object = record(entry.object);
      if (object) id(object, 'objectId', entry);
      uri(entry, 'localUri');
    });
  } else if (key === 'junluo.tools.files.imports.v1') {
    eachRecord(value, entry => uri(entry, 'uri'));
  } else if (key === 'junluo.persona.stickerLibrary.v1') {
    eachRecord(root?.stickers, sticker => {
      id(sticker, 'objectId');
      uri(sticker, 'uri');
    });
  } else if (key === 'junluo.sync.appearance.fonts.v1') {
    eachRecord(root?.records, font => {
      id(font, 'objectId');
      uri(font, 'localUri');
    });
  } else if (key === 'junluo.sync.appearance.background.v1') {
    if (root) id(root, 'selectedObjectId');
    eachRecord(root?.objects, object => {
      id(object, 'objectId');
      uri(object, 'localUri');
    });
  } else if (key === 'junluo.backgroundSettings' && root) {
    uri(root, 'imageUri');
  }
}

export function collectEmergencyLocalObjectIds(key: string, raw: string): readonly string[] {
  if (!isEmergencyObjectReferenceStorageKey(key)) return [];
  const ids = new Set<string>();
  visitReferences(key, JSON.parse(raw), (owner, field) => {
    const value = owner[field];
    if (typeof value === 'string' && OBJECT_ID.test(value)) ids.add(value);
  }, (owner, field) => {
    const value = owner[field];
    const match = typeof value === 'string' ? MANAGED_URI.exec(value) : null;
    if (match) ids.add(match[1]);
  });
  return [...ids];
}

export function rebindEmergencyLocalObjectReferences(
  key: string,
  raw: string,
  replacements: ReadonlyMap<string, ObjectReplacement>,
): string {
  if (!isEmergencyObjectReferenceStorageKey(key)) return raw;
  const value: unknown = JSON.parse(raw);
  let changed = false;
  const write = (owner: StoredRecord, field: string, next: string) => {
    if (owner[field] !== next) {
      owner[field] = next;
      changed = true;
    }
  };
  visitReferences(key, value, (owner, field, keyOwner) => {
    const previous = owner[field];
    if (typeof previous !== 'string' || !OBJECT_ID.test(previous)) return;
    const replacement = replacements.get(previous);
    if (!replacement) return;
    write(owner, field, replacement.objectId);
    if (keyOwner) write(keyOwner, 'keyId', replacement.keyId);
  }, (owner, field) => {
    const previous = owner[field];
    const match = typeof previous === 'string' ? MANAGED_URI.exec(previous) : null;
    const replacement = match ? replacements.get(match[1]) : undefined;
    if (replacement) write(owner, field, replacement.localUri);
  });
  return changed ? JSON.stringify(value) : raw;
}
