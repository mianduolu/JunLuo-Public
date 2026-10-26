export const SERIALIZED_MESSAGE_RECORD_CACHE_MAX_ENTRIES = 64;
export const SERIALIZED_MESSAGE_RECORD_CACHE_MAX_BYTES = 2 * 1024 * 1024;

export function estimateSerializedMessageRecordBytes(serialized: string) {
  return serialized.length * 2;
}

export class SerializedMessageRecordCache {
  private readonly entries = new Map<string, { bytes: number; value: string }>();

  private totalBytes = 0;

  get size() {
    return this.entries.size;
  }

  get estimatedBytes() {
    return this.totalBytes;
  }

  get(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  has(key: string) {
    return this.get(key) !== undefined;
  }

  set(key: string, value: string) {
    this.delete(key);
    const bytes = estimateSerializedMessageRecordBytes(value);
    if (bytes > SERIALIZED_MESSAGE_RECORD_CACHE_MAX_BYTES) return this;
    this.entries.set(key, { bytes, value });
    this.totalBytes += bytes;
    while (
      this.entries.size > SERIALIZED_MESSAGE_RECORD_CACHE_MAX_ENTRIES
      || this.totalBytes > SERIALIZED_MESSAGE_RECORD_CACHE_MAX_BYTES
    ) {
      const oldestKey = this.entries.keys().next().value;
      if (typeof oldestKey !== 'string') break;
      this.delete(oldestKey);
    }
    return this;
  }

  delete(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.entries.delete(key);
    this.totalBytes -= entry.bytes;
    return true;
  }

  clear() {
    this.entries.clear();
    this.totalBytes = 0;
  }
}
