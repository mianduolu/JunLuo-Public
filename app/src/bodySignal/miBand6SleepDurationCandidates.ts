import { f32, median3, recordAt, SleepInterval, SleepRecord, unsupported } from './miBand6SleepDurationInput';

// 0x353d8, only the verified non-legacy state; evidence is not a stage label.
export function candidateMinute(records: SleepRecord[], index: number, threshold = .1): boolean {
  const row = recordAt(records, index);
  let evidence = recordAt(records, index < 1857 ? index + 3 : index)[5] & 63;
  if (index >= 1080 && index <= 1260) evidence = Math.trunc(evidence * 1.3);
  const required = Math.trunc(f32(Math.max(f32(threshold), f32(.08)) * 63));
  return evidence >= required && row[0] !== 126 && ![3, 6].includes(row[0] & 15) && row[2] < 10;
}

function shortIntervalOk(records: SleepRecord[], start: number, end: number): boolean {
  const longest = [0, 0, 0], runs = [0, 0, 0], limits = [37, 50, 25];
  for (let i = start + 8; i <= end; i++) {
    let value = records[i][5] & 63;
    if (records[i][1] <= 10) value = Math.trunc(f32((10 - records[i][1]) * f32(.96) + value));
    for (let lane = 0; lane < 3; lane++) {
      runs[lane] = value > limits[lane] ? runs[lane] + 1 : 0;
      longest[lane] = Math.max(longest[lane], runs[lane]);
    }
  }
  const difference = end - start, special = start <= 360 && end >= 60;
  const strict = difference < 59 && special;
  if (difference < 19 && special) return false;
  if (f32(longest[0] / (difference + 1)) <= f32(strict ? .52 : .35)) return false;
  return !longest[2] || f32(longest[1] / longest[2]) > f32(strict ? .375 : .28);
}

function hrIntervalOk(records: SleepRecord[], start: number, end: number): boolean {
  let zeroActivity = 0, changes = 0, absoluteChange = 0, state = 0;
  let first = 0, b = 0, c = 0, previous = 0;
  for (let i = start + 5; i < end - 4; i++) {
    const row = records[i], hr = row[3];
    zeroActivity += Number(row[1] === 0);
    if (hr < 31 || hr > 199) continue;
    if (!state) { state = 1; first = previous = hr; b = c = 0; continue; }
    let filtered: number;
    if (state === 1) { b = hr; filtered = (first + hr) >> 1; state = 2; }
    else { filtered = median3(b, c, hr); b = c; c = hr; state = 3; }
    changes++; absoluteChange += Math.abs(filtered - previous); previous = filtered;
  }
  const span = end - start - 9;
  if (changes <= span * .7) return true;
  if (span <= 0) unsupported();
  return !(f32(absoluteChange / changes) > f32(span < 71 ? 3.5 : 4.5)
    && f32(zeroActivity / span) > f32(span < 71 ? .8 : .9));
}

// 0x33a6c: f0=0, ed=1, pass=0, initially empty candidate table.
export function candidateRanges(records: SleepRecord[], lower: number, upper: number): SleepInterval[] {
  const row = (i: number) => recordAt(records, i);
  const evidence = (i: number) => row(i)[5] & 63;
  const result: SleepInterval[] = [];
  let run = 0, active = false;
  for (let index = lower; index < upper; index++) {
    const current = candidateMinute(records, index);
    if (!active) { run += Number(current); active = current; continue; }
    if (index !== upper - 1 && current) { run++; continue; }
    let start = index - run;
    if ((row(start - 1)[0] & 15) === 3) {
      let chosen = start, minimum = evidence(start);
      for (let probe = start + 1; probe < start + 11; probe++) {
        const value = evidence(probe);
        if (value < minimum && value < 47) { chosen = probe; minimum = value; }
      }
      run = Math.max(index - chosen, 0); start = index - run;
    }
    const previous = start - 1;
    if ((row(previous)[0] & 15) === 3) {
      let preceding = 0;
      while ((row(previous - preceding)[0] & 15) === 3) preceding++;
      if (preceding >= 11 && run > 0 && run <= 59
        && row(previous)[1] + row(previous + 1)[1] + row(previous + 2)[1] <= 44) {
        let activity = 0;
        for (let j = previous; j < previous + run; j++) activity += row(j)[1];
        if (Math.floor(activity / run) < 3 && index !== upper - 1) run = 0;
      }
    }
    if (!run) { active = false; continue; }
    const edge = start === 0 || (current && index > upper - 18), length = run;
    run = 0; active = false;
    if (length < 18 && !edge) continue;
    let strong = 0, moderate = 0;
    for (let j = start; j < index; j++) { strong += Number(evidence(j) > 44); moderate += Number(evidence(j) > 31); }
    if (length < 60) { if (f32(strong / length) <= f32(.06)) continue; }
    else if (f32(moderate / length) <= f32(.15) || f32(strong / (moderate + strong)) <= f32(.1)) continue;
    let end = edge ? index : index - 1;
    if (evidence(start) < 8) {
      let amount = 0, value: number;
      do { value = evidence(start + amount + 1); amount++; } while (value < 8 && amount < 30);
      start += amount;
    }
    if (evidence(end) < 18) {
      let amount = 0, value: number;
      do { value = evidence(end - amount - 1); amount++; } while (value < 18 && amount < 30);
      end -= amount;
    }
    if (result.length >= 20) continue;
    if (end < start) unsupported();
    const difference = end - start;
    if (difference + 1 < 18 && !edge) continue;
    if (difference < 70 && !shortIntervalOk(records, start, end)) continue;
    if (difference < 150 && !hrIntervalOk(records, start, end)) continue;
    result.push([start, end]);
  }
  return result;
}
