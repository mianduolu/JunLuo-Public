import type { ShiyingEntryV1 } from './shiyingContract';
import type { ShiyingLifeDateGroup } from './shiyingStore';

export type ShiyingDeliveryGroup = {
  lifeDate: string;
  entries: ShiyingEntryV1[];
};

export type ShiyingArchiveRow =
  | { key: 'delivery-intro'; kind: 'delivery_intro' }
  | { key: string; kind: 'delivery_date'; lifeDate: string; count: number }
  | { key: string; kind: 'entry'; placement: 'delivery' | 'archive'; entry: ShiyingEntryV1 }
  | { key: 'pickup-toolbar'; kind: 'pickup_toolbar' }
  | { key: 'archive-title'; kind: 'archive_title' }
  | { key: string; kind: 'archive_date'; group: ShiyingLifeDateGroup; expanded: boolean }
  | { key: string; kind: 'archive_loading'; lifeDate: string }
  | { key: 'archive-empty'; kind: 'archive_empty' }
  | { key: 'archive-load-more'; kind: 'archive_load_more' };

function compareStableText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function sortShiyingEntriesWithinLifeDate(
  entries: readonly ShiyingEntryV1[],
) {
  return entries.slice().sort((left, right) => (
    left.eventStartedAt - right.eventStartedAt
    || left.eventEndedAt - right.eventEndedAt
    || compareStableText(left.id, right.id)
  ));
}

export function groupShiyingDeliveryEntries(
  entries: readonly ShiyingEntryV1[],
): ShiyingDeliveryGroup[] {
  const grouped = new Map<string, ShiyingEntryV1[]>();
  for (const entry of entries) {
    if (entry.status !== 'active') continue;
    const current = grouped.get(entry.lifeDate) ?? [];
    current.push(entry);
    grouped.set(entry.lifeDate, current);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => compareStableText(right, left))
    .map(([lifeDate, groupedEntries]) => ({
      lifeDate,
      entries: sortShiyingEntriesWithinLifeDate(groupedEntries),
    }));
}

export function excludeShiyingDeliveryFromArchiveGroups(
  groups: readonly ShiyingLifeDateGroup[],
  deliveryEntries: readonly ShiyingEntryV1[],
) {
  const deliveryCounts = new Map<string, number>();
  for (const entry of deliveryEntries) {
    if (entry.status !== 'active') continue;
    deliveryCounts.set(entry.lifeDate, (deliveryCounts.get(entry.lifeDate) ?? 0) + 1);
  }
  return groups.flatMap((group) => {
    const activeCount = group.activeCount - (deliveryCounts.get(group.lifeDate) ?? 0);
    return activeCount > 0 ? [{ ...group, activeCount }] : [];
  });
}

export function addShiyingEntriesToLifeDateGroups(
  groups: readonly ShiyingLifeDateGroup[],
  entries: readonly ShiyingEntryV1[],
) {
  const next = new Map(groups.map((group) => [group.lifeDate, group.activeCount]));
  for (const entry of entries) {
    if (entry.status !== 'active') continue;
    next.set(entry.lifeDate, (next.get(entry.lifeDate) ?? 0) + 1);
  }
  return [...next.entries()]
    .map(([lifeDate, activeCount]) => ({ lifeDate, activeCount }))
    .sort((left, right) => compareStableText(right.lifeDate, left.lifeDate));
}

export function removeShiyingEntryFromLifeDateGroups(
  groups: readonly ShiyingLifeDateGroup[],
  entry: Pick<ShiyingEntryV1, 'lifeDate'>,
) {
  return groups.flatMap((group) => {
    if (group.lifeDate !== entry.lifeDate) return [group];
    return group.activeCount > 1 ? [{ ...group, activeCount: group.activeCount - 1 }] : [];
  });
}

export function toggleShiyingExpandedLifeDate(
  currentLifeDate: string | null,
  selectedLifeDate: string,
) {
  return currentLifeDate === selectedLifeDate ? null : selectedLifeDate;
}

export function formatShiyingLifeDateLabel(lifeDate: string, currentYear: number) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(lifeDate);
  if (!match) return lifeDate;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return year === currentYear ? `${month}月${day}日` : `${year}年${month}月${day}日`;
}

export function buildShiyingArchiveRows(input: {
  deliveryGroups: readonly ShiyingDeliveryGroup[];
  archiveGroups: readonly ShiyingLifeDateGroup[];
  expandedLifeDate: string | null;
  expandedEntries: readonly ShiyingEntryV1[];
  loadingArchive: boolean;
  loadingExpandedLifeDate: string | null;
  hasMoreArchiveGroups: boolean;
}) {
  const rows: ShiyingArchiveRow[] = [];
  const deliveryEntryIds = new Set(
    input.deliveryGroups.flatMap((group) => group.entries.map((entry) => entry.id)),
  );
  if (input.deliveryGroups.length) {
    rows.push({ key: 'delivery-intro', kind: 'delivery_intro' });
    for (const group of input.deliveryGroups) {
      rows.push({
        key: `delivery-date:${group.lifeDate}`,
        kind: 'delivery_date',
        lifeDate: group.lifeDate,
        count: group.entries.length,
      });
      for (const entry of group.entries) {
        rows.push({
          key: `delivery-entry:${entry.id}`,
          kind: 'entry',
          placement: 'delivery',
          entry,
        });
      }
    }
  }
  rows.push({ key: 'pickup-toolbar', kind: 'pickup_toolbar' });
  rows.push({ key: 'archive-title', kind: 'archive_title' });

  if (input.loadingArchive) {
    rows.push({ key: 'archive-loading:initial', kind: 'archive_loading', lifeDate: '' });
    return rows;
  }
  if (!input.archiveGroups.length) {
    rows.push({ key: 'archive-empty', kind: 'archive_empty' });
  }
  for (const group of input.archiveGroups) {
    const expanded = input.expandedLifeDate === group.lifeDate;
    rows.push({
      key: `archive-date:${group.lifeDate}`,
      kind: 'archive_date',
      group,
      expanded,
    });
    if (!expanded) continue;
    if (input.loadingExpandedLifeDate === group.lifeDate) {
      rows.push({
        key: `archive-loading:${group.lifeDate}`,
        kind: 'archive_loading',
        lifeDate: group.lifeDate,
      });
    } else {
      for (const entry of sortShiyingEntriesWithinLifeDate(input.expandedEntries)) {
        if (deliveryEntryIds.has(entry.id)) continue;
        rows.push({
          key: `archive-entry:${entry.id}`,
          kind: 'entry',
          placement: 'archive',
          entry,
        });
      }
    }
  }
  if (input.hasMoreArchiveGroups) {
    rows.push({ key: 'archive-load-more', kind: 'archive_load_more' });
  }
  return rows;
}
