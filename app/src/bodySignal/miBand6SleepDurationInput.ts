// Scalar 27A input rules. Internal records: kind/activity/steps/HR/extra[0..3].
// No repaired record is evidence of original transport coverage.
export type SleepRecord = number[];
export type SleepInterval = [number, number]; // inclusive end
export const f32 = Math.fround;
export function unsupported(): never { throw new Error('sleep_duration_unsupported'); }
export function recordAt(records: SleepRecord[], i: number): SleepRecord {
  if (i < 0 || i >= records.length) return unsupported();
  return records[i];
}
export const median3 = (a: number, b: number, c: number): number =>
  Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));

export function decodeSleepRecord(raw: readonly number[]): SleepRecord {
  const kind = raw[0] === 126 ? 126 : (raw[0] & 15) === 6 ? 6 : raw[0];
  const activity = raw[0] !== 126 && (raw[0] & 15) === 10 && !raw.slice(4).some(Boolean)
    ? 20 : raw[1];
  return [kind, activity, raw[2], raw[3], ...raw.slice(4)];
}

export function requireSleepVersion2(records: SleepRecord[]): void {
  let run = 0;
  for (let i = 1080; i < 2518; i++) {
    const row = records[i];
    if (row[0] === 126 || row[0] === 254 || row.slice(4).some(Boolean)) continue;
    if (row[0] === 0 || records[i + 1][0] === 126) run = 0;
    else if ((++run & 65535) >= 2) unsupported();
  }
}

// 0x351e4; successful match only changes kind bytes, never HR or evidence.
export function excludeLowInformationRun(records: SleepRecord[], start: number, end: number): boolean {
  if (end - start < 180) return false;
  let activity = 0, valid = 0, changes = 0, previous = 0, maximum = 0, minimum = 150;
  for (let i = start; i <= end; i++) {
    const r = recordAt(records, i), hr = r[3];
    if (r[1] >= 6 && r[1] < 60 && r[0] !== 10) activity++;
    if (hr >= 31 && hr < 150) {
      valid++; changes += Number(hr !== previous); previous = hr;
      maximum = Math.max(maximum, hr); minimum = Math.min(minimum, hr);
    }
  }
  const length = end - start + 1, activityRatio = f32(activity / length);
  const hrRatio = valid && f32(changes / valid) >= f32(.1) && maximum - minimum > 3
    ? f32(valid / length) : 0;
  const excluded = (hrRatio < f32(.1) && activityRatio < f32(.04))
    || (hrRatio < f32(.5) && activityRatio < f32(.004));
  if (excluded) for (let i = start; i <= end; i++) records[i][0] = 3;
  return excluded;
}

export function prepareSleepRecords(original: SleepRecord[]): {
  records: SleepRecord[]; lower: number; upper: number;
} {
  const records = original.map(r => [...r]);
  let missingRun = 0;
  for (let i = 0; i < records.length; i++) {
    const row = records[i];
    if (!row.some(Boolean) || row[0] === 126) {
      row[0] = 126; missingRun++; continue;
    }
    if (row[0] === 6) row[0] = 3;
    if (missingRun > 0 && missingRun < 5) {
      const futurePresent = i > 1858 || (records[i + 1][0] !== 126
        && (records[i + 1][5] & 60) > 11
        && records.slice(i + 2, Math.min(i + 10, 1860)).every(r => r[0] !== 126));
      const start = i - missingRun;
      if (futurePresent && start < 1850) {
        if (start === 0) unsupported();
        const count = (records[start + 1][5] & 63) ? 2 : 5;
        for (let j = start; j < start + count; j++) {
          records[j][5] = records[start - 1][5]; records[j][0] = 0;
        }
      }
    }
    missingRun = 0;
  }
  for (const row of records) if (row[0] === 126) row[0] = 3;
  const lower = records.findIndex(r => r[0] !== 126 && r[0] !== 3);
  if (lower < 0) unsupported();
  let upper = records.length;
  while (records[upper - 1][0] === 126 || records[upper - 1][0] === 3) upper--;
  if (records.some(r => r[5] > 191 && r[6] === 0 && r[7] === 0)) unsupported();
  let extra = 0, bit6 = 0, bit7 = 0;
  for (const r of records.slice(lower, upper)) {
    if (r.slice(4).some(Boolean)) {
      extra |= r[4] & 1; bit6 |= Number(r[6] >= 128); bit7 |= Number(r[7] >= 128);
    }
  }
  if (extra !== 1 || bit6 !== 1 || bit7 !== 0) unsupported();
  let seenMissing = false, run = 0;
  for (let i = 0; i < 1859; i++) {
    if ((records[i][0] & 15) === 3) {
      if (seenMissing && run > 0 && run <= 5)
        for (let j = i - run; j < i; j++) records[j][0] = (records[j][0] & 128) | 3;
      seenMissing = true; run = 0;
    } else if (seenMissing) run++;
  }
  let lastLow = lower + 10;
  run = 0;
  for (let i = lower + 10; i < upper - 9; i++) {
    let score = records[i <= 1856 ? i + 3 : i][5] & 63;
    if (i >= 1080 && i <= 1260) score = Math.trunc(score * 1.3);
    if (score < 25) lastLow = i;
    if ((records[i][0] & 15) === 3) { run++; continue; }
    if (run > 0 && run < 10) {
      let restore = run < 5 && i - (run + lastLow) > 10;
      if (!restore) {
        let valid = 0, changes = 0, previous = 0;
        for (let j = i - run; j < i; j++) {
          const hr = records[j][3];
          if (hr >= 31 && hr < 150) { valid++; changes += Number(hr !== previous); previous = hr; }
        }
        const ratio = f32(changes / run) >= f32(.1) ? f32(valid / run) : 0;
        restore = ratio > f32(.1);
      }
      if (restore) for (let j = i - run; j < i; j++) records[j][0] = 0;
    }
    run = 0;
  }
  run = 0;
  for (let i = lower; i < upper; i++) {
    const count = Math.min(3, i + 1);
    let activity = 0;
    for (let j = i - count + 1; j <= i; j++)
      activity += (records[j][0] & 15) === 3 ? 10 : records[j][1];
    if (f32(activity / count) < f32(3.5) && (records[i][0] & 15) !== 3 && (records[i][5] & 63) !== 0) run++;
    else { if (run > 180) excludeLowInformationRun(records, i - run, i - 1); run = 0; }
  }
  // The startup median deliberately includes a zero third slot.
  const first = records[lower][3];
  let previous = 0, latest = 0, state = 1;
  for (let i = lower + 1; i < upper; i++) {
    const current = records[i][3];
    if (state === 1) {
      records[i][3] = (current + first) >> 1; previous = current; state = 2;
    } else {
      records[i][3] = median3(previous, latest, current);
      previous = latest; latest = current;
    }
  }
  return { records, lower, upper };
}
