export const TOOL_WORKSPACE_FILE_FOLDER = 'tool-file-cache' as const;
export const TOOL_WORKSPACE_FILE_STORAGE_KEY =
  'junluo.tools.files.imports.v1' as const;

function safePart(value: unknown, maximum: number) {
  if (typeof value !== 'string') return '';
  const cleaned = value
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .slice(0, maximum);
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : '';
}

export function isSafeToolWorkspaceBackupFileName(value: string) {
  return value.length >= 1
    && value.length <= 800
    && !/[\/\\\u0000-\u001f\u007f]/.test(value)
    && value !== '.'
    && value !== '..';
}

export function rewriteRestoredToolWorkspaceFileUris(
  storage: Record<string, string>,
  documentDirectory: string,
) {
  const raw = storage[TOOL_WORKSPACE_FILE_STORAGE_KEY];
  if (!raw) return storage;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return storage;
  }
  if (!Array.isArray(parsed)) return storage;
  const rewritten = parsed.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return entry;
    }
    const record = entry as Record<string, unknown>;
    const cacheId = safePart(record.cacheId, 256);
    const name = safePart(record.name, 512);
    if (!cacheId || !name) return entry;
    const fileName = `${cacheId}-${name}`;
    if (!isSafeToolWorkspaceBackupFileName(fileName)) return entry;
    return {
      ...record,
      uri: `${documentDirectory}${TOOL_WORKSPACE_FILE_FOLDER}/${fileName}`,
      externalFileId: undefined,
      externalPath: undefined,
    };
  });
  return {
    ...storage,
    [TOOL_WORKSPACE_FILE_STORAGE_KEY]: JSON.stringify(rewritten),
  };
}
