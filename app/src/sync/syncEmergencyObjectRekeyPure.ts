import { readBaiyunPostImageAssets } from './syncMemoryRecords';
import type { JsonValue, PlainMutationV1 } from './syncProtocol';

// Preserve the existing full-string replacement for ordinary structured refs.
function replaceObjectIds(value: unknown, replacements: ReadonlyMap<string, string>): unknown {
  if (typeof value === 'string') return replacements.get(value) ?? value;
  if (Array.isArray(value)) return value.map(entry => replaceObjectIds(entry, replacements));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, replaceObjectIds(nested, replacements)]));
}

function replacePostImageAssetJson(raw: string, replacements: ReadonlyMap<string, string>) {
  const assets = readBaiyunPostImageAssets({ image_assets_json: raw });
  if (!assets.some(asset => asset.object_id !== null && replacements.has(asset.object_id))) return raw;
  // The contract validates a flat asset array. Replace only this property's
  // string token, preserving whitespace, number spelling and member order.
  return raw.replace(/("(?:[^"\\]|\\.)*")(\s*:\s*)("(?:[^"\\]|\\.)*"|null)/g,
    (full: string, key: string, separator: string, value: string) => {
      if (JSON.parse(key) !== 'object_id' || value === 'null') return full;
      const replacement = replacements.get(JSON.parse(value) as string);
      return replacement === undefined ? full : `${key}${separator}${JSON.stringify(replacement)}`;
    });
}

export function rekeyEmergencySyncMutationObjectIds(
  mutation: PlainMutationV1,
  replacements: ReadonlyMap<string, string>,
): PlainMutationV1 {
  if (!mutation.objectRefs.some(id => replacements.has(id) && replacements.get(id) !== id)) return mutation;
  const transformed = replaceObjectIds(mutation, replacements) as PlainMutationV1;
  if (mutation.entity.domain !== 'memory' || !['post', 'post-comment'].includes(mutation.entity.type)
    || mutation.revision.schemaVersion !== 6 || mutation.revision.operation === 'delete') return transformed;
  const payload = mutation.payload as { schemaVersion: number; record: Record<string, JsonValue> };
  const raw = payload.record.image_assets_json;
  if (typeof raw !== 'string') throw new Error('post image assets JSON missing during object rekey');
  // Post prose, descriptions and all other fields belong to the original full
  // version. Only asset object IDs and the normal objectRefs change worlds.
  return { ...transformed, payload: { ...payload, record: {
    ...payload.record, image_assets_json: replacePostImageAssetJson(raw, replacements),
  } } };
}
