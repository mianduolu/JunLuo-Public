import { f32, recordAt, SleepRecord, unsupported } from './miBand6SleepDurationInput';

// Inclusive intermediate coordinates. Only the verified final version-2 branch
// maps codes 4/5 to light/deep; 3/7 are deductions and 8 is unsupported staging.
export type DurationSegment = [number, number, number];
const sum = (values: readonly number[]) => values.reduce((a, b) => a + b, 0);

function runs(mask: readonly number[]): [number, number][] {
  const result: [number, number][] = [];
  let start = -1;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] && start < 0) start = i;
    else if (!mask[i] && start >= 0) { result.push([start, i]); start = -1; }
  }
  if (start >= 0) unsupported();
  return result;
}

// 0x2c468 joins gaps only when the ORIGINAL run count exceeds two.
export function filterDurationMask(mask: number[], gap: number, minimum: number): void {
  if (mask.length < 2 || mask.length > 32767 || mask.some(x => x !== 0 && x !== 1)) unsupported();
  mask[0] = mask[mask.length - 1] = 0;
  const original = runs(mask);
  if (original.length > 2) {
    for (let i = 0; i < original.length - 1; i++) {
      if (original[i + 1][0] - original[i][1] < gap) mask.fill(1, original[i][0], original[i + 1][1]);
    }
  }
  for (const [start, end] of runs(mask)) if (end - start < minimum) mask.fill(0, start, end);
}

// 0x2e6d0, observed DAT_802ef=0. Math.fround marks native binary32 operations.
export function adjustDurationCodes(probability: readonly number[], initial: readonly number[]): number[] {
  const n = probability.length;
  if (n < 2 || n > 32767 || initial.length !== n ||
      probability.some(p => !Number.isInteger(p) || p < 0 || p > 100) ||
      initial.some(c => !Number.isInteger(c) || c < 0 || c > 255)) unsupported();
  let mask = probability.map(p => Number(p > 35));
  let count = sum(mask);
  const quarter = f32(n * 0.25);
  if (count > quarter) {
    const total = sum(probability.filter(p => p > 35));
    const threshold = f32(f32(total / count) * f32(0.9)) - 0.5;
    mask = probability.map(p => Number(p > threshold));
  }
  filterDurationMask(mask, 3, 5);
  filterDurationMask(mask, 8, 6);
  count = sum(mask);
  const tailWidth = f32(n * f32(0.22));
  if (n > 100) {
    let scan = Math.floor(f32(n - tailWidth));
    while (mask[scan] === 1) { if (++scan >= n) unsupported(); }
    if (scan < n - 1) {
      const logTail = f32(Math.log(tailWidth));
      let start = 0, length = 0;
      for (let i = scan; i < n - 1; i++) {
        if (mask[i] === 1) {
          length++;
          if (mask[i + 1] !== 1) {
            const remaining = count - length;
            if (f32(remaining / n) > 0.11) {
              const score = f32((Math.log(length) / 2.70805020110221) * (Math.log(n - start) / logTail));
              if (score < 1.5) { mask.fill(0, start, i + 1); count = remaining; }
            }
            length = 0;
          }
        } else if (mask[i + 1] === 1) start = i + 1;
      }
    }
  }
  if (count > quarter) {
    let excess = f32(count - quarter);
    const segments: [number, number, number][] = [];
    for (const [start, end] of runs(mask)) {
      let mean = f32(sum(probability.slice(start, end)) / (end - start));
      if (mean < 50) { mask.fill(0, start, end); excess = f32(excess - (end - start)); mean = 0; }
      segments.push([start, end, mean]);
    }
    const refined = Array<number>(n).fill(0), smoothed = Array<number>(n).fill(0);
    let total = 0;
    const remaining = Math.trunc(f32(n * 0.25 + excess));
    for (const [start, end, mean] of segments) {
      if (mean === 0) continue;
      if (end - start < 6) unsupported();
      for (let i = start; i < end; i++) {
        smoothed[i] = f32(sum(probability.slice(Math.max(start, i - 2), Math.min(end, i + 3))) / 5);
        total = f32(total + smoothed[i]);
      }
    }
    // JS division preserves ARM's zero-divisor NaN / Infinity behavior.
    const average = f32(total / remaining);
    let earlyLimit = f32(tailWidth * 0.66);
    for (const [start, end, mean] of segments) {
      if (mean !== 0) for (let i = start; i < end; i++) if (smoothed[i] > average) refined[i] = 1;
      if (end < earlyLimit) { refined.fill(1, start, end); earlyLimit = f32(earlyLimit * 0.66); }
    }
    filterDurationMask(refined, 1, 6);
    if (sum(refined) > n * 0.15) mask = refined;
  }
  return initial.map((code, i) => code === 7 ? 7 : mask[i] ? 5 : 4);
}

// 0x3574c retains the first code before rewriting short/edge intervals.
export function adjustDurationInterval(records: SleepRecord[], start: number, end: number, capacity = 200): DurationSegment[] {
  if (!(0 <= start && start < end && end < records.length)) unsupported();
  const section = records.slice(start, end + 1);
  const probabilities = section.map(r => ((r[6] & 127) * 0xc9964) >>> 20);
  let codes = adjustDurationCodes(probabilities, section.map(r => (r[0] & 15) === 7 ? 7 : 4));
  const firstCode = codes[0];
  if (end - start < 59) codes = codes.map(code => code === 5 ? 4 : code);
  for (let i = 0; i < codes.length && (codes[i] & 15) === 7; i++) codes[i] = 4;
  for (let i = codes.length - 1; i >= 0 && (codes[i] & 15) === 7; i--) codes[i] = 4;
  let runEnd = 0, predecessor = 0;
  for (let i = end; i >= start; i--) {
    const code = codes[i - start];
    if (runEnd === 0) runEnd = code === 5 ? i : 0;
    else if (code !== 5) { predecessor = i; break; }
  }
  const hr = recordAt(records, predecessor)[3];
  if (predecessor <= runEnd && hr >= 31 && hr <= 199) {
    const hrs = records.slice(predecessor, runEnd + 1).map(r => r[3]);
    if (Math.max(...hrs) - Math.min(...hrs) > 25 && end - predecessor > 60) {
      if (predecessor < start) unsupported();
      codes.fill(4, predecessor - start, runEnd - start + 1);
    }
  }
  const segments: DurationSegment[] = [];
  let left = start, previous = firstCode;
  for (let i = start; i <= end; i++) {
    const code = codes[i - start];
    if (code !== previous) { segments.push([left + 1080, i - 1 + 1080, previous]); left = i; previous = code; }
  }
  segments.push([left + 1080, end + 1080, previous]);
  // Check before the trailing merge: native output needs those temporary slots.
  if (segments.length > capacity) unsupported();
  if (segments.length > 1 && segments[segments.length - 1][2] === 7) {
    segments[segments.length - 2][1] = segments[segments.length - 1][1]; segments.pop();
  }
  return segments;
}

export function splitAndAdjustDuration(records: SleepRecord[], start: number, end: number, capacity = 200): DurationSegment[] {
  const segments: DurationSegment[] = [];
  let chunk = start, run = 0, highBits = 0;
  for (let i = start; i <= end; i++) {
    const kind = recordAt(records, i)[0];
    if ((kind & 15) === 7) { run++; highBits += kind >>> 7; }
    else {
      if (run >= 241) {
        segments.push(...adjustDurationInterval(records, chunk, i - run - 1, capacity - segments.length));
        // Native highBits accumulates across runs; deliberately do not reset it.
        const code = f32((highBits & 65535) / run) > f32(0.9) ? 3 : 7;
        segments.push([i - run + 1080, i - 1 + 1080, code]);
        chunk = i;
      }
      run = 0;
    }
  }
  segments.push(...adjustDurationInterval(records, chunk, end, capacity - segments.length));
  if (segments.length > capacity) unsupported();
  return segments;
}

// csRunSleepAlgo 0x32970: all intervals share 200 slots, including one code-128
// separator between intervals. Only the selected main interval is summarized.
export function mainDurationSegments(
  records: SleepRecord[], intervals: readonly (readonly [number, number])[], main: number,
): DurationSegment[] {
  if (!Number.isInteger(main) || main < 0 || main >= intervals.length) unsupported();
  let used = 0;
  let selected: DurationSegment[] = [];
  for (let i = 0; i < intervals.length; i++) {
    const [start, end] = intervals[i];
    if (i > 0) {
      if (start <= intervals[i - 1][1] + 1) unsupported();
      used++; // Shared separator is never a sleep segment.
    }
    const segments = splitAndAdjustDuration(records, start, end, 200 - used);
    used += segments.length;
    if (used > 200) unsupported();
    if (i === main) selected = segments;
  }
  return selected;
}

export function summarizeDuration(start: number, end: number, segments: DurationSegment[]): number | undefined {
  let cursor = start, deducted = 0;
  for (const [left, right, code] of segments) {
    if (left !== cursor || right < left || right > end || ![3, 4, 5, 7, 8].includes(code)) unsupported();
    if (code === 3 || code === 7) deducted += right + 1 - left;
    cursor = right + 1;
  }
  if (cursor !== end + 1) unsupported();
  const total = end + 1 - start - deducted;
  return total > 0 ? total : undefined;
}
