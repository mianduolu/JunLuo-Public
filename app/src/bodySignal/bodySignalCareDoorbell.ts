import { loadPendingBodySignalCareDoorbellEvents } from './bodySignalCareStore';
import { selectBodySignalCareDoorbell, type BodySignalCareDoorbellPreparation } from './bodySignalCareDoorbellPolicy';
import { loadPriorityHeartContact, markHeartContactHandled } from './bodySignalProactiveCareRuntime';
import { loadPriorityPeriodContact, markPeriodContactHandled } from '../period/periodCareEvents';
import { runChatAuxiliaryOperation } from '../chat/chatAuxiliaryDiagnostics';

export * from './bodySignalCareDoorbellPolicy';

export async function prepareBodySignalCareDoorbell(
  now = Date.now(), runRead = runChatAuxiliaryOperation,
): Promise<BodySignalCareDoorbellPreparation> {
  const [heartRead, periodRead] = await Promise.all([
    runRead({ phase: 'read', stage: 'continuity_ledger', step: 'body_heart_read' }, async () => {
      const heart = await loadPriorityHeartContact(now);
      const selected = selectBodySignalCareDoorbell(
        heart ? (await loadPendingBodySignalCareDoorbellEvents(now)).filter((event) => event.id === heart.id) : [],
      );
      return { heart, selected };
    }),
    runRead({ phase: 'read', stage: 'continuity_ledger', step: 'body_period_read' }, () => loadPriorityPeriodContact(now)),
  ]);
  const { heart, selected } = heartRead.ok ? heartRead.value : { heart: null, selected: selectBodySignalCareDoorbell([]) };
  const period = periodRead.ok ? periodRead.value : null;
  return { ...selected, ...(period ? { periodIds: [period.id] } : {}),
    sources: [
      ...(heart && selected.eventIds.length ? [{ kind: 'heart' as const, id: heart.id, version: heart.version }] : []),
      ...(period ? [{ kind: 'period' as const, id: period.id, version: period.version }] : []),
    ],
    instruction: [selected.instruction, selected.eventIds.length ? heart?.facts : '', period?.facts].filter(Boolean).join('\n\n') };
}

async function sourceIsCurrent(source: NonNullable<BodySignalCareDoorbellPreparation['sources']>[number], now: number) {
  const live = source.kind === 'heart' ? await loadPriorityHeartContact(now) : await loadPriorityPeriodContact(now);
  return !!live && live.id === source.id && live.version === source.version && now < live.expiresAt;
}

export async function isBodySignalCareDoorbellCurrent(preparation: BodySignalCareDoorbellPreparation, now = Date.now()): Promise<boolean> {
  const ids = [...preparation.eventIds.map(id => `heart:${id}`), ...(preparation.periodIds ?? []).map(id => `period:${id}`)];
  for (const id of ids) {
    if (preparation.handledSources?.includes(id)) continue;
    const source = preparation.sources?.find(value => `${value.kind}:${value.id}` === id);
    if (!source || !await sourceIsCurrent(source, now)) return false;
  }
  return true;
}

export async function commitBodySignalCareDoorbell(
  preparation: BodySignalCareDoorbellPreparation, handledAt = Date.now(),
): Promise<void> {
  for (const source of preparation.sources ?? []) {
    const key = `${source.kind}:${source.id}`;
    if (preparation.handledSources?.includes(key) || !await sourceIsCurrent(source, handledAt)) continue;
    if (source.kind === 'heart') await markHeartContactHandled(source.id, handledAt);
    else await markPeriodContactHandled(source.id, handledAt);
    preparation.handledSources = [...(preparation.handledSources ?? []), key];
  }
}
