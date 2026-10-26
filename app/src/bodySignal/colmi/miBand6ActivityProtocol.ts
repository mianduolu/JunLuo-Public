import type { MiBand6ActivityBatch } from '../miBand6ActivityTypes';

export const MI_BAND_6_ACTIVITY_SERVICE = '0000fee0-0000-1000-8000-00805f9b34fb';
export const MI_BAND_6_ACTIVITY_CONTROL = '00000004-0000-3512-2118-0009af100700';
export const MI_BAND_6_ACTIVITY_DATA = '00000005-0000-3512-2118-0009af100700';
// Complete real stream and both-owner acceptance are recorded in the capability ledger.
export const MI_BAND_6_ACTIVITY_VERIFIED = true;
export const ACTIVITY_MINUTE_MS = 60_000;
export const ACTIVITY_TIMEOUT_MS = 90_000;
export const ACTIVITY_IDLE_MS = 15_000;
export const ACTIVITY_MAX_BYTES = 128 * 1024;
export const ACTIVITY_MAX_PACKETS = 8192;
export const ACTIVITY_MAX_RECORDS = 16384;

function assertEpoch(value: number): void {
  const year = new Date(value).getUTCFullYear();
  if (!Number.isSafeInteger(value) || year < 2000 || year > 2099) throw new Error('activity_invalid_clock');
}

export function createMiBand6ActivityRequest(since: number): number[] {
  assertEpoch(Date.now());
  assertEpoch(since);
  const date = new Date(since);
  const offset = -date.getTimezoneOffset() / 15;
  if (!Number.isSafeInteger(since) || since <= 0 || since % ACTIVITY_MINUTE_MS !== 0
    || date.getFullYear() < 2000 || date.getFullYear() > 2099
    || !Number.isInteger(offset) || offset < -48 || offset > 56) throw new Error('activity_invalid_time');
  return [1, 1, date.getFullYear() & 255, date.getFullYear() >> 8, date.getMonth() + 1,
    date.getDate(), date.getHours(), date.getMinutes(), 0, offset & 255];
}

export function miBand6ActivityFetchCommand(): number[] { return [2]; }

function assertBytes(value: readonly number[]): void {
  if (!value.length || Array.from(value).some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw new Error('activity_invalid_packet');
  }
}

export function parseMiBand6ActivityAnchor(value: readonly number[]): number {
  if (value.length !== 8) throw new Error('activity_invalid_time');
  assertBytes(value);
  const [lo, hi, month, day, hour, minute, second, rawOffset] = value;
  const year = lo + hi * 256;
  const offset = rawOffset > 127 ? rawOffset - 256 : rawOffset;
  if (year < 2000 || year > 2099 || offset < -48 || offset > 56 || second !== 0) throw new Error('activity_invalid_time');
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  const date = new Date(wall);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day
    || date.getUTCHours() !== hour || date.getUTCMinutes() !== minute) throw new Error('activity_invalid_time');
  return wall - offset * 15 * ACTIVITY_MINUTE_MS;
}

export class MiBand6ActivityAssembler {
  private readonly payload = new Uint8Array(ACTIVITY_MAX_BYTES);
  private length = 0;
  private packets = 0;
  private counter = -1;
  private previous: readonly number[] = [];
  private anchor?: number;
  private reportedSize = 0;
  private finished = false;
  private progressAt: number;
  private lastObservedAt: number;
  private lastElapsedMs = 0;
  private metadata: number[] = [];
  private completion: number[] = [];

  getEvidence() {
    return { metadata: this.metadata.slice(), firstRecords: Array.from(this.payload.slice(0, Math.min(16, this.length))),
      completion: this.completion.slice() };
  }

  constructor(readonly requestedSinceAt: number, readonly requestedAt: number) {
    assertEpoch(requestedAt);
    createMiBand6ActivityRequest(requestedSinceAt);
    if (requestedSinceAt > requestedAt) throw new Error('activity_invalid_time');
    this.progressAt = 0;
    this.lastObservedAt = requestedAt;
  }

  checkTime(now: number, elapsedMs = now - this.requestedAt): void {
    assertEpoch(now);
    if (now < this.lastObservedAt) throw new Error('activity_clock_reversed');
    this.lastObservedAt = now;
    if (!Number.isFinite(elapsedMs) || elapsedMs < this.lastElapsedMs) throw new Error('activity_invalid_elapsed');
    this.lastElapsedMs = elapsedMs;
    if (elapsedMs >= ACTIVITY_TIMEOUT_MS) throw new Error('activity_timeout');
    if (elapsedMs - this.progressAt >= ACTIVITY_IDLE_MS) throw new Error('activity_idle_timeout');
  }

  control(value: readonly number[], now: number, elapsedMs = now - this.requestedAt): 'fetch' | MiBand6ActivityBatch {
    this.checkTime(now, elapsedMs);
    assertBytes(value);
    if (++this.packets > ACTIVITY_MAX_PACKETS) throw new Error('activity_packet_limit');
    if (value[1] === 1) this.metadata = value.slice(0, 15);
    if (value[1] === 2) this.completion = value.slice(0, 7);
    if (this.finished || value[0] !== 16 || value[2] !== 1) throw new Error('activity_control_rejected');
    if (value[1] === 1) {
      if (this.anchor !== undefined || value.length !== 15) throw new Error('activity_metadata_unsupported');
      const anchor = parseMiBand6ActivityAnchor(value.slice(7));
      if (anchor < this.requestedSinceAt || anchor > now) throw new Error('activity_time_out_of_range');
      this.anchor = anchor;
      this.reportedSize = value[3] + value[4] * 256 + value[5] * 65536 + value[6] * 16777216;
      if (this.reportedSize > ACTIVITY_MAX_RECORDS) throw new Error('activity_record_limit');
      this.progressAt = elapsedMs;
      if (this.reportedSize === 0) return this.complete(now);
      return 'fetch';
    }
    if (value[1] !== 2 || value.length !== 3 || this.anchor === undefined) throw new Error('activity_completion_unsupported');
    if (this.reportedSize > 0 && this.length === 0) throw new Error('activity_incomplete_batch');
    return this.complete(now);
  }

  data(value: readonly number[], now: number, elapsedMs = now - this.requestedAt): boolean {
    this.checkTime(now, elapsedMs);
    assertBytes(value);
    if (this.finished || this.anchor === undefined || value.length < 2) throw new Error('activity_unexpected_data');
    if (++this.packets > ACTIVITY_MAX_PACKETS) throw new Error('activity_packet_limit');
    if (value[0] === this.counter && value.length === this.previous.length
      && value.every((byte, index) => byte === this.previous[index])) return false;
    if (value[0] !== ((this.counter + 1) & 255)) throw new Error('activity_sequence_error');
    if (this.length + value.length - 1 > ACTIVITY_MAX_BYTES) throw new Error('activity_byte_limit');
    this.payload.set(value.slice(1), this.length);
    this.length += value.length - 1;
    if (this.length >= 8 && this.anchor + (Math.floor(this.length / 8) - 1) * ACTIVITY_MINUTE_MS > now) {
      throw new Error('activity_time_out_of_range');
    }
    this.counter = value[0];
    this.previous = value.slice();
    this.progressAt = elapsedMs;
    return true;
  }

  private complete(now: number): MiBand6ActivityBatch {
    if (this.anchor === undefined || this.length % 8 !== 0) throw new Error('activity_incomplete_batch');
    const count = this.length / 8;
    if (count > ACTIVITY_MAX_RECORDS) throw new Error('activity_record_limit');
    // Count raw minutes before excluding the still-open current minute.
    if (count !== this.reportedSize) throw new Error('activity_length_mismatch');
    if (count && this.anchor + (count - 1) * ACTIVITY_MINUTE_MS > now) throw new Error('activity_time_out_of_range');
    const samples: Array<[number, number]> = [];
    for (let index = 0; index < count; index++) {
      if (this.anchor + (index + 1) * ACTIVITY_MINUTE_MS > now) break;
      samples.push([this.payload[index * 8 + 2], this.payload[index * 8 + 1]]);
    }
    this.finished = true;
    return { requestedSinceAt: this.requestedSinceAt, startedAt: this.anchor, observedAt: now,
      samples, reportedSize: this.reportedSize, byteCount: this.length, packetCount: this.packets };
  }
}

export function miBand6ActivityError(code: string): string {
  const messages: Record<string, string> = {
    activity_evidence_required: '活动历史尚待真机取证，正式保存和自动同步暂未开放。',
    activity_update_required: '当前安装包还不支持活动历史，请更新安装包。',
    activity_not_ready: '请等手环连接并认证完成。',
    activity_profile_missing: '没有找到这台手环的设备档案，记录会等待补录。',
    activity_unsupported: '当前设备没有经过识别的活动历史通道。',
    activity_busy: '通道正在使用，请稍后再同步活动记录。',
    activity_cooldown: '刚刚尝试过，稍后再同步。',
    activity_cancelled: '活动同步已让位于心率测量或断开操作。',
    activity_connection_blocked: '本次连接的活动同步已停止；下次正常连接后再试。',
    activity_cleanup_failed: '活动通道未能及时结束，连接已释放。',
    activity_time_out_of_range: '手环历史日期不在请求范围内，请检查手环时间。',
    activity_invalid_time: '手环历史时间无效，请检查手环时间。',
    activity_queue_full: '还有记录等待保存，暂不继续读取历史。',
    activity_timeout: '本次同步已达到时限，未完成部分没有保存。',
    activity_idle_timeout: '手环暂未继续返回记录，未完成部分没有保存。',
    activity_length_mismatch: '收到的活动记录数量与手环声明不一致，本批没有保存。',
  };
  return messages[code] ?? '活动记录尚未通过完整校验，本批没有保存。';
}
