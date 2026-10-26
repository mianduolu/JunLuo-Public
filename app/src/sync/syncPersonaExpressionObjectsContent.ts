import {
  PERSONA_EXPRESSION_OBJECT_KEYS,
  parsePersonaStickerLibraryStorage,
  serializePersonaStickerLibraryStorage,
  type PersonaExpressionObjectsStorageChange,
} from './syncPersonaExpressionObjectsStorageDerivation';

export type PersonaStickerObjectCapture = (input: {
  stickerId: string;
  sourceUri: string;
}) => Promise<string>;

export async function preparePersonaExpressionObjectsStorageChanges(input: {
  changes: readonly PersonaExpressionObjectsStorageChange[];
  captureStickerObject: PersonaStickerObjectCapture;
}) {
  const prepared: PersonaExpressionObjectsStorageChange[] = [];
  const capturedByUri = new Map<string, string>();
  for (const change of input.changes) {
    if (
      change.kind !== 'set'
      || change.key !== PERSONA_EXPRESSION_OBJECT_KEYS.stickerLibrary
    ) {
      prepared.push(change);
      continue;
    }
    const library = parsePersonaStickerLibraryStorage(change.value);
    const stickers = [];
    for (const sticker of library.stickers) {
      if (sticker.objectId) {
        stickers.push(sticker);
        continue;
      }
      if (!sticker.uri) {
        throw new Error(
          `贴纸 ${sticker.id} 没有本机文件，不能生成内容对象。`,
        );
      }
      let objectId = capturedByUri.get(sticker.uri);
      if (!objectId) {
        objectId = await input.captureStickerObject({
          stickerId: sticker.id,
          sourceUri: sticker.uri,
        });
        if (!/^[A-Za-z0-9_-]{43}$/.test(objectId)) {
          throw new Error(`贴纸 ${sticker.id} 捕获得到无效 objectId。`);
        }
        capturedByUri.set(sticker.uri, objectId);
      }
      stickers.push({ ...sticker, objectId });
    }
    prepared.push({
      kind: 'set',
      key: change.key,
      value: serializePersonaStickerLibraryStorage({
        ...library,
        stickers,
      }),
    });
  }
  return prepared;
}
