import { f32, SleepInterval, SleepRecord, unsupported } from './miBand6SleepDurationInput';

// Verified day=1/whole=1 branch. Internal 7/0x87 codes are deduction inputs.
export function prepareSleepIntervals(records: SleepRecord[], initial: SleepInterval[]): {
  intervals: SleepInterval[]; main: number;
} {
  let intervals = initial.map(([a, b]): SleepInterval => [a, b]);
  for (let i = 0; i < intervals.length; i++) {
    const [start, end] = intervals[i];
    const mean = f32(records.slice(start, end + 1).reduce((sum, r) => sum + r[1], 0) / (end - start + 1));
    if (mean < f32(.35) && end - start > 239) intervals.splice(i, 1);
    // Deliberate native skip after compaction.
  }
  for (let i = 0; i + 1 < intervals.length;) {
    if (intervals[i + 1][0] - intervals[i][1] - 1 < 60) {
      intervals[i][1] = intervals[i + 1][1]; intervals.splice(i + 1, 1);
    } else i++;
  }
  let removed = 0;
  for (const pair of [...intervals].reverse()) {
    if (pair[0] < 1861 && pair[1] > 1799) {
      if (pair[0] < 1440) pair[1] = 1439; else removed++;
    }
  }
  if (removed) intervals.splice(-removed);
  for (let i = 0; i < intervals.length; i++)
    if (intervals[i][1] < 360) intervals = intervals.slice(i + 1);
  const matches = intervals.map(([a, b], i) => a < 841 && b >= 360 ? i : -1).filter(i => i >= 0);
  const main = matches.length ? matches[0] : -1;
  if (matches.length > 1) {
    const last = main + matches.length - 1;
    intervals[main][1] = intervals[last][1]; intervals.splice(main + 1, last - main);
  }
  for (const pair of intervals) {
    const [start, end] = pair, last = end - 18;
    if (last < start) unsupported();
    const hrFraction = f32(records.slice(start, last + 1).filter(r => r[3] >= 31 && r[3] <= 199).length / (last - start + 1));
    for (let i = start; i <= last;) {
      const activityMean = (width: number): number => {
        const begin = Math.max(0, i - width + 1);
        let sum = 0;
        for (let j = begin; j <= i; j++) sum += (records[j][0] & 15) === 3 ? 10 : records[j][1];
        return f32(sum / (i - begin + 1));
      };
      const average3 = activityMean(3), average10 = activityMean(10), begin = Math.max(0, i - 4);
      let delta = 0, evidence = 0;
      for (let j = begin; j < i; j++) {
        const a = records[j][3], b = records[j + 1][3];
        if (a >= 31 && a <= 199 && b >= 31 && b <= 199) delta += b - a;
      }
      for (let j = begin; j <= i; j++) evidence += records[j][5] & 63;
      const activity = records[i][1], hr = records[i][3];
      const hrAwake = hrFraction > f32(.8) && ((average3 > 40 && delta > 18)
        || (average3 > 10 && delta > 30) || (average3 > 18 && delta > 26)
        || (hr >= 121 && hr <= 199) || (average3 > 50 && delta > 10));
      const wasMissing = (records[i][0] & 15) === 3;
      const awake = hrAwake || (activity > 20 && f32(evidence / (i - begin + 1)) < 4)
        || average3 > 45 || activity > 80 || average10 > 22 || wasMissing;
      records[i][0] = awake ? 7 : 0;
      if (awake && wasMissing && i < last) {
        let j = i + 1;
        while (j <= last && (records[j][0] & 15) === 3) j++;
        if (j > last) { i++; continue; }
        const following = j - i - 1;
        if (following >= 5) for (let k = i; k < j; k++) records[k][0] = 0x87;
        i += following + 3; continue;
      }
      i++;
    }
    let seen = false, run = 0;
    for (let i = start; i < last; i++) {
      if ((records[i][0] & 15) === 7) {
        if (seen && run > 0 && run <= 5)
          for (let j = i - run; j < i; j++) records[j][0] = (records[j][0] & 128) | 7;
        seen = true; run = 0;
      } else if (seen) run++;
    }
    if (end - start - 17 > 15) {
      run = 0;
      for (let i = start; i < last; i++) {
        if ((records[i][0] & 15) === 0) run++;
        else {
          if (run > 0 && run < 15)
            for (let j = i - run; j < i; j++) records[j][0] = (records[j][0] & 128) | 7;
          run = 0;
        }
      }
    }
    let newStart = start;
    while (newStart < records.length && records[newStart][0] === 7) newStart++;
    if (newStart > end) unsupported();
    let runStart: number | undefined;
    const wakeRuns: SleepInterval[] = [];
    for (let i = newStart; i <= last; i++) {
      if ((records[i][0] & 15) === 7 && i !== last) { if (runStart === undefined) runStart = i; }
      else if (runStart !== undefined) { wakeRuns.push([runStart, i - runStart]); runStart = undefined; }
    }
    if (wakeRuns.length) {
      const [first, length] = wakeRuns[0];
      if (length > 20 && first - newStart < 30 && last - newStart > 240) newStart = first + length;
    }
    pair[0] = newStart;
  }
  if (main >= 0 && records.slice(intervals[main][0], intervals[main][1]).some(r => r[7] & 128)) unsupported();
  return { intervals, main };
}
