export type BackupSecretRestorePort = {
  deleteItem(key: string): Promise<void>;
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
};

function normalizeSecrets(secrets: Record<string, string> | undefined) {
  return Object.entries(secrets ?? {}).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0,
  );
}

export async function replaceBackupSecretsSafely(
  port: BackupSecretRestorePort,
  currentKeys: readonly string[],
  restoredKeys: readonly string[],
  restoredSecrets: Record<string, string> | undefined,
) {
  const recognizedKeys = new Set([...currentKeys, ...restoredKeys]);
  const restoredEntries = normalizeSecrets(restoredSecrets);
  for (const [key] of restoredEntries) {
    if (!recognizedKeys.has(key)) {
      throw new Error(`备份包含未登记的秘密条目：${key}`);
    }
  }

  for (const [key, value] of restoredEntries) {
    await port.setItem(key, value);
  }
  for (const [key, expected] of restoredEntries) {
    if (await port.getItem(key) !== expected) {
      throw new Error(`秘密条目写入后核验失败：${key}`);
    }
  }

  const restoredKeySet = new Set(restoredEntries.map(([key]) => key));
  const obsoleteKeys = Array.from(recognizedKeys).filter((key) => !restoredKeySet.has(key));
  for (const key of obsoleteKeys) {
    await port.deleteItem(key);
  }

  return {
    restoredCount: restoredEntries.length,
    removedCount: obsoleteKeys.length,
  };
}
