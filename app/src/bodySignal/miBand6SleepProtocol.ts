import { Buffer } from 'buffer';
import { ACTIVITY_MAX_BYTES, ACTIVITY_MAX_PACKETS, ACTIVITY_MINUTE_MS,
  MiBand6ActivityAssembler } from './colmi/miBand6ActivityProtocol';
import type { MiBand6ActivityBatch } from './miBand6ActivityTypes';

export type MiBand6SleepWindow = 'recent24h' | 'recent7days';
export type MiBand6SleepPacket = {
  kind: 'control' | 'data'; data: string; observedAt: number; elapsedMs: number;
};
export type MiBand6SleepCapture = {
  schema: 1; requestedSinceAt: number; requestedAt: number;
  packets: MiBand6SleepPacket[]; complete: true;
};
export const SLEEP_CAPTURE_MAX_BYTES = 256 * 1024;

export function miBand6SleepSince(window: MiBand6SleepWindow, now: number): number {
  if (!['recent24h', 'recent7days'].includes(window) || !Number.isSafeInteger(now) || now <= 0) {
    throw new Error('sleep_invalid_window');
  }
  return Math.floor((now - (window === 'recent7days' ? 7 : 1) * 86400_000) / ACTIVITY_MINUTE_MS) * ACTIVITY_MINUTE_MS;
}

// Opt-in recorder. Full notifications, including immediate duplicates; no device identity or storage.
export class MiBand6SleepCaptureRecorder {
  private packets: MiBand6SleepPacket[] = [];
  private size: number;
  constructor(private since: number, private requestedAt: number) {
    this.size = Buffer.byteLength(JSON.stringify({ schema: 1, requestedSinceAt: since, requestedAt, packets: [], complete: true }), 'utf8');
  }
  record(kind: 'control' | 'data', bytes: readonly number[], observedAt: number, elapsedMs: number): void {
    const packet = { kind, data: Buffer.from(bytes).toString('base64'), observedAt, elapsedMs: Math.floor(elapsedMs) };
    this.size += Buffer.byteLength(JSON.stringify(packet), 'utf8') + (this.packets.length ? 1 : 0);
    if (this.size > SLEEP_CAPTURE_MAX_BYTES || this.packets.length >= ACTIVITY_MAX_PACKETS) {
      this.clear(); throw new Error('sleep_capture_limit');
    }
    this.packets.push(packet);
  }
  complete(): MiBand6SleepCapture {
    return { schema: 1, requestedSinceAt: this.since, requestedAt: this.requestedAt, packets: this.packets.slice(), complete: true };
  }
  clear(): void { this.packets = []; }
}

export function decodeMiBand6SleepCapture(input: unknown) {
  const json = typeof input === 'string' ? input : JSON.stringify(input);
  if (typeof json !== 'string' || Buffer.byteLength(json, 'utf8') > SLEEP_CAPTURE_MAX_BYTES) throw new Error('sleep_capture_limit');
  const capture = JSON.parse(json) as MiBand6SleepCapture;
  if (!capture || capture.schema !== 1 || capture.complete !== true || !Array.isArray(capture.packets)
    || !capture.packets.length || capture.packets.length > ACTIVITY_MAX_PACKETS) throw new Error('sleep_incomplete_capture');
  const parser = new MiBand6ActivityAssembler(capture.requestedSinceAt, capture.requestedAt);
  const bytes: number[] = [];
  let batch: MiBand6ActivityBatch | undefined;
  for (const packet of capture.packets) {
    if (batch || !packet || !['data', 'control'].includes(packet.kind) || typeof packet.data !== 'string'
      || !Number.isSafeInteger(packet.observedAt) || !Number.isSafeInteger(packet.elapsedMs) || packet.elapsedMs < 0) {
      throw new Error('sleep_invalid_capture');
    }
    const decoded = Buffer.from(packet.data, 'base64');
    if (decoded.toString('base64') !== packet.data || decoded.length > 512) throw new Error('sleep_invalid_capture');
    const raw = Array.from(decoded);
    if (packet.kind === 'data') {
      if (parser.data(raw, packet.observedAt, packet.elapsedMs)) {
        if (bytes.length + raw.length - 1 > ACTIVITY_MAX_BYTES) throw new Error('sleep_capture_limit');
        for (let i = 1; i < raw.length; i++) bytes.push(raw[i]);
      }
    } else {
      const result = parser.control(raw, packet.observedAt, packet.elapsedMs);
      if (result !== 'fetch') batch = result;
    }
  }
  if (!batch) throw new Error('sleep_incomplete_capture');
  const minutes = batch.samples.map((_, index) => ({
    startedAt: batch.startedAt + index * ACTIVITY_MINUTE_MS,
    raw: bytes.slice(index * 8, index * 8 + 8),
  }));
  const rawOffset = parser.getEvidence().metadata[14];
  return { capture, verified: false as const, complete: true as const,
    startedAt: batch.startedAt, endedAt: batch.startedAt + minutes.length * ACTIVITY_MINUTE_MS,
    observedAt: batch.observedAt, gap: batch.startedAt > capture.requestedSinceAt,
    timezoneOffsetMinutes: (rawOffset > 127 ? rawOffset - 256 : rawOffset) * 15,
    minutes };
}
