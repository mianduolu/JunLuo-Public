import type { PhoneRestrictionUsage } from '../backend/phoneRestrictionNative';
import type { PhoneLimitQuerySource } from '../tools/phoneLimitStatus';
import { formatPhoneUsageDuration } from '../phoneRestriction/phoneUsageFormatting';

export const PHONE_EMERGENCY_CONTACT_TASK = `【应急解锁后看看 you】

I 看看这次应急解锁和手机使用记录，决定要不要找 you 说话。

想说的话放进 messages，每一项都是可以直接发给 you 的聊天正文；暂时不说话，就填 []。

只发送这个 JSON：{"messages":[]}`;

export const PHONE_EMERGENCY_CONTACT_INTERVAL_MS = 5 * 60_000;
export type PhoneEmergencyReference = { id: string; version: string };
export type PhoneEmergencyReceipt = {
  handled?: PhoneEmergencyReference[];
  lastOpportunity?: PhoneEmergencyReference & { phase: 'active' | 'ended'; at: number;
    observedReferences?: PhoneEmergencyReference[] };
};
export type PhoneEmergencyMaterial = {
  id: string; subject: 'you'; phase: 'active' | 'ended'; from: string; until: string;
  usage: { at: string; apps: Record<string, string>; complete: false | null } | null;
};
export type PhoneEmergencySnapshot = {
  phone: { emergency: PhoneEmergencyMaterial | null; earlierEmergencies?: PhoneEmergencyMaterial[] | null; dataOmitted?: true };
  references: PhoneEmergencyReference[];
  latest: (PhoneEmergencyReference & { phase: 'active' | 'ended' }) | null;
  observedAt: number;
  pendingIds: string[] | null;
};
type Row = Record<string, unknown>;
type Event = { id: string; emergencyId: string; kind: 'emergency_started' | 'emergency_extended' | 'emergency_ended';
  occurredAt: number; until: number };
type Round = { id: string; from: number; until: number; phase: 'active' | 'ended';
  extensions: unknown[] | null; events: Event[] | null };
const object = (v: unknown): Row | null => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Row : null;
const text = (v: unknown): v is string => typeof v === 'string' && !!v.trim();
const time = (v: unknown, zero = false): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= (zero ? 0 : 1);
const compareText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

// Pure Intl conversion, using the native phone zone for each individual instant.
function localInstant(value: number, zone: string): string | null {
  if (!time(value) || value > 8_640_000_000_000_000) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit',
      day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(value);
    const p = Object.fromEntries(parts.map(part => [part.type, part.value]));
    const wall = new Date(0);
    wall.setUTCFullYear(Number(p.year), Number(p.month) - 1, Number(p.day));
    wall.setUTCHours(Number(p.hour), Number(p.minute), Number(p.second), 0);
    const offset = (wall.getTime() - Math.floor(value / 1000) * 1000) / 60_000;
    if (!Number.isInteger(offset) || Math.abs(offset) > 24 * 60 || p.year.length !== 4) return null;
    const absolute = Math.abs(offset);
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${offset < 0 ? '-' : '+'}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`;
  } catch { return null; }
}

function eventsFrom(value: unknown, at: number): Event[] | null {
  if (!Array.isArray(value)) return null;
  const result: Event[] = [];
  for (const raw of value) {
    const v = object(raw);
    if (!v || !text(v.id) || !text(v.emergencyId)
      || !['emergency_started', 'emergency_extended', 'emergency_ended'].includes(String(v.kind))
      || !time(v.occurredAt) || !time(v.observedAt) || v.occurredAt > v.observedAt || v.observedAt > at
      || !time(v.until) || (v.kind === 'emergency_ended' ? v.actor !== null || v.occurredAt !== v.until : v.actor !== 'you' || v.until <= v.occurredAt)) return null;
    const event = { id: v.id, emergencyId: v.emergencyId, kind: v.kind as Event['kind'], occurredAt: v.occurredAt, until: v.until };
    const duplicate = result.find(item => item.id === event.id);
    if (duplicate && JSON.stringify(duplicate) !== JSON.stringify(event)) return null;
    if (!duplicate) result.push(event);
  }
  return result.sort((a, b) => a.occurredAt - b.occurredAt || a.until - b.until || compareText(a.id, b.id));
}

function latestRound(value: unknown, events: Event[] | null, at: number): Round | null {
  const v = object(value);
  if (!v || !text(v.id) || !time(v.startedAt) || !time(v.until) || v.startedAt > at || v.until <= v.startedAt) return null;
  const extensions = Array.isArray(v.extensions) && v.extensions.every(raw => {
    const item = object(raw);
    return item && text(item.id) && time(item.occurredAt) && item.occurredAt >= (v.startedAt as number)
      && item.occurredAt <= at && time(item.until) && item.until > item.occurredAt && item.until <= (v.until as number);
  }) ? v.extensions.map(raw => {
    const item = raw as Row; return [item.id, item.occurredAt, item.until];
  }).sort((a, b) => Number(a[1]) - Number(b[1]) || compareText(String(a[0]), String(b[0]))) : null;
  return { id: v.id, from: v.startedAt, until: v.until, phase: at < v.until ? 'active' : 'ended', extensions,
    events: events?.filter(event => event.emergencyId === v.id) ?? null };
}

function earlierRound(id: string, events: Event[], at: number): Round | null {
  const starts = events.filter(event => event.kind === 'emergency_started');
  if (starts.length !== 1) return null;
  const start = starts[0];
  let until = start.until;
  let ended = false;
  for (const event of events.filter(event => event.kind !== 'emergency_started')) {
    if (event.occurredAt < start.occurredAt || ended) return null;
    if (event.kind === 'emergency_extended') {
      if (event.occurredAt >= until || event.until <= until) return null;
      until = event.until;
    } else {
      if (event.until !== until) return null;
      ended = true;
    }
  }
  if (until > at) return null;
  return { id, from: start.occurredAt, until, phase: 'ended', extensions: null, events };
}

function roundUsage(round: Round, usage: PhoneRestrictionUsage | null, at: number, zone: string,
  names: Readonly<Record<string, string>> | null): { material: PhoneEmergencyMaterial['usage']; evidence: unknown } {
  const value = usage?.emergencyUsage;
  if (!usage || usage.schemaVersion !== 1 || usage.subject !== 'you' || usage.restorePaused !== false
    || typeof usage.collectorRunning !== 'boolean' || !time(usage.observedAt) || usage.observedAt > at
    || !value || value.emergencyId !== round.id || value.from !== round.from || value.until !== round.until
    || !time(value.observedUntil) || value.observedUntil < round.from || value.observedUntil > Math.min(round.until, at)
    || value.observedUntil > usage.observedAt || value.logsAvailable !== true || typeof value.logsTruncated !== 'boolean'
    || !Array.isArray(value.byApp) || !value.byApp.every(app => app && text(app.packageName) && time(app.usedMs, true)
      && app.usedMs <= value.observedUntil - round.from)
    || new Set(value.byApp.map(app => app.packageName)).size !== value.byApp.length) return { material: null, evidence: null };
  const cutoff = localInstant(value.observedUntil, zone);
  if (!cutoff) return { material: null, evidence: null };
  const rows = [...value.byApp].sort((a, b) => compareText(a.packageName, b.packageName));
  const apps = Object.fromEntries(rows.filter(app => app.usedMs > 0).map(app => {
    const title = names?.[app.packageName];
    return [app.packageName, `${text(title) && title !== app.packageName ? `${title}：` : ''}${formatPhoneUsageDuration(app.usedMs)}`];
  }));
  return { material: { at: cutoff, apps, complete: value.logsTruncated ? false : null },
    evidence: [value.logsTruncated, rows.map(app => [app.packageName, app.usedMs])] };
}

function project(round: Round, zone: string, usage: ReturnType<typeof roundUsage>): { material: PhoneEmergencyMaterial; reference: PhoneEmergencyReference } | null {
  const from = localInstant(round.from, zone), until = localInstant(round.until, zone);
  if (!from || !until) return null;
  return { material: { id: round.id, subject: 'you', phase: round.phase, from, until, usage: usage.material },
    reference: { id: round.id, version: JSON.stringify({ from: round.from, until: round.until, phase: round.phase,
      extensions: round.extensions, events: round.events, usage: usage.evidence }) } };
}

export function buildPhoneEmergencySnapshot(query: PhoneLimitQuerySource | null, usage: PhoneRestrictionUsage | null,
  names: Readonly<Record<string, string>> | null, receipt: PhoneEmergencyReceipt = {}): PhoneEmergencySnapshot {
  const observedAt = time(query?.observedAt) ? query.observedAt : 0;
  const unknown: PhoneEmergencySnapshot = { phone: { emergency: null, earlierEmergencies: null }, references: [], latest: null, observedAt, pendingIds: null };
  if (!query || query.schemaVersion !== 1 || !observedAt || !text(query.timeZoneId) || !localInstant(observedAt, query.timeZoneId)) return unknown;
  const state = object(query.state);
  if (!state || state.schemaVersion !== 1) return unknown;
  const events = eventsFrom(state.pendingEvents, observedAt);
  const round = latestRound(state.emergency, events, observedAt);
  if (!round) return state.emergency === null && events?.length === 0
    ? { phone: { emergency: null }, references: [], latest: null, observedAt, pendingIds: [] } : unknown;
  const current = project(round, query.timeZoneId, roundUsage(round, usage, observedAt, query.timeZoneId, names));
  if (!current) return unknown;
  const handled = new Map(receipt.handled?.map(ref => [ref.id, ref.version]) ?? []);
  const earlier = [...new Set(events?.map(event => event.emergencyId) ?? [])].filter(id => id !== round.id).flatMap(id => {
    const old = earlierRound(id, events!.filter(event => event.emergencyId === id), observedAt);
    const item = old && project(old, query.timeZoneId, { material: null, evidence: null });
    return item && handled.get(item.reference.id) !== item.reference.version ? [item] : [];
  });
  return { phone: { emergency: current.material, ...(events === null ? { earlierEmergencies: null }
    : earlier.length ? { earlierEmergencies: earlier.map(item => item.material) } : {}) },
    references: [current.reference, ...earlier.map(item => item.reference)],
    latest: { ...current.reference, phase: round.phase }, observedAt,
    pendingIds: events === null ? null : [...new Set([round.id, ...events.map(event => event.emergencyId)])] };
}

function newEvidence(before: string, after: string): boolean {
  try {
    const old = object(JSON.parse(before)), current = object(JSON.parse(after));
    if (!old || !current) return before !== after;
    return ['from', 'until', 'phase', 'extensions', 'events', 'usage'].some(key => current[key] !== null
      && JSON.stringify(current[key]) !== JSON.stringify(old[key]));
  } catch { return before !== after; }
}

export function decidePhoneEmergencyContact(snapshot: PhoneEmergencySnapshot, receipt: PhoneEmergencyReceipt,
  now: number): { due: boolean; nextAt: number | null } {
  const latest = snapshot.latest;
  if (!latest || !time(now) || snapshot.phone.dataOmitted || !snapshot.references.some(ref =>
    !receipt.handled?.some(handled => handled.id === ref.id && handled.version === ref.version))) return { due: false, nextAt: null };
  const last = receipt.lastOpportunity;
  if (!last || last.id !== latest.id || last.phase === 'active' && latest.phase === 'ended') {
    const evidence = JSON.parse(latest.version) as { from: number; until: number };
    const nextAt = latest.phase === 'ended' ? evidence.until : evidence.from;
    return { due: now >= nextAt, nextAt };
  }
  const observed = last.observedReferences ?? [{ id: last.id, version: last.version }];
  if (!snapshot.references.some(ref => {
    const before = observed.find(item => item.id === ref.id);
    return !before || newEvidence(before.version, ref.version);
  })) return { due: false, nextAt: null };
  const nextAt = last.at + PHONE_EMERGENCY_CONTACT_INTERVAL_MS;
  return { due: now >= nextAt, nextAt };
}

// Only actual transmitted references are acknowledged; the caller owns valid-return proof.
export function recordPhoneEmergencyHandled(receipt: PhoneEmergencyReceipt, sentReferences: readonly PhoneEmergencyReference[],
  pendingIds: readonly string[] | null): PhoneEmergencyReceipt {
  const pending = pendingIds === null ? null : new Set(pendingIds);
  const handled = new Map((receipt.handled ?? []).filter(ref => !pending || pending.has(ref.id)).map(ref => [ref.id, ref]));
  for (const ref of sentReferences) if (!pending || pending.has(ref.id)) handled.set(ref.id, { ...ref });
  return { ...receipt, handled: [...handled.values()] };
}

export function formatPhoneEmergencyToBudget(snapshot: PhoneEmergencySnapshot, maxCharacters: number): {
  text: string; phone: PhoneEmergencySnapshot['phone']; references: PhoneEmergencyReference[];
} {
  const text = JSON.stringify({ phone: snapshot.phone });
  if (text.length <= maxCharacters) return { text, phone: snapshot.phone, references: snapshot.references };
  const phone: PhoneEmergencySnapshot['phone'] = { emergency: null, dataOmitted: true };
  return { text: JSON.stringify({ phone }), phone, references: [] };
}
