import { loadTheaterAdoptions, loadTheaterBranches, loadTheaterCheckpoints,
  loadTheaterStories, loadTheaterTextVersions } from './theaterStoryStore';
import { theaterCoCreationSources, theaterCoCreationRevision, renderTheaterCoCreationMaterial,
  renderLatestTheaterCoCreationFact, theaterMaterialLength, THEATER_CREATION_BUDGET, fullTheaterCoCreationSelection,
  type TheaterCoCreationSelection, type TheaterCoCreationSource } from './theaterCoCreationMaterial';
import type { CandidateReference, SharedExperienceCandidate, SharedExperienceProgress } from '../ai/assistantSharedExperienceMaterial';

// Only a local presentation signal; source records and existing shared progress remain authoritative.
let capacityBlocked: { id: string; revision: string } | null = null;
const listeners = new Set<() => void>();
export const subscribeTheaterCoCreation = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function markTheaterCoCreationCapacityBlocked(candidate: CandidateReference) {
  capacityBlocked = { id: candidate.refs[0].id, revision: candidate.refs[0].revision };
  for (const listener of listeners) listener();
}
export const theaterNeedsCapacitySelection = (source: TheaterCoCreationSource) => capacityBlocked?.id === source.positionId
  && capacityBlocked.revision === theaterCoCreationRevision(source);
export function clearTheaterCapacitySelection(positionId: string) {
  if (capacityBlocked?.id === positionId) capacityBlocked = null;
  for (const listener of listeners) listener();
}

export async function loadTheaterCoCreationSources(storyId?: string): Promise<TheaterCoCreationSource[]> {
  const db = await (await import('./theaterStore')).getTheaterDatabase();
  if (!await (await import('../sync/syncTheaterStorySqlite')).hasTheaterStorySchema(db)) return [];
  const columns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(theater_text_versions)');
  if (!columns.some(column => column.name === 'co_creation_json')) return [];
  const stories = (await loadTheaterStories(db)).filter(story => !storyId || story.id === storyId);
  return (await Promise.all(stories.map(async story => {
    const [versions, branches] = await Promise.all([
      loadTheaterTextVersions(db, story.id), loadTheaterBranches(db, story.id),
    ]);
    return { story, versions, branches: await Promise.all(branches.map(async branch => {
      const [adoptions, checkpoints] = await Promise.all([
        loadTheaterAdoptions(db, branch.id), loadTheaterCheckpoints(db, branch.id),
      ]);
      return { branch, adoptions, checkpoints };
    })) };
  }))).flatMap(theaterCoCreationSources);
}
export function theaterExperienceCandidate(source: TheaterCoCreationSource, selection?: TheaterCoCreationSelection): SharedExperienceCandidate | null {
  if (!source.messages.length) return null;
  const revision = theaterCoCreationRevision(source);
  const material = renderTheaterCoCreationMaterial(source, selection);
  if (material === null) return null;
  return { kind: 'theater', ownerId: source.storyId, fromAt: source.at, throughAt: source.at,
    refs: [{ kind: 'theater-unit', id: source.positionId, ownerId: source.storyId, createdAt: source.at, revision }],
    theaterSelection: selection ?? fullTheaterCoCreationSelection(source, source.at), material };
}
export function selectTheaterExperienceCandidates(sources: TheaterCoCreationSource[], progress: SharedExperienceProgress,
  now: number, includeOversize = false) {
  const candidates: SharedExperienceCandidate[] = [];
  const owners = new Set<string>();
  for (const source of [...sources].sort((a, b) => a.at - b.at || a.positionId.localeCompare(b.positionId))) {
    // coCreation exists only on newly completed originals, never retrofilled migration rows.
    // Do not lose the first creation merely because the shared bookmark starts after its save.
    if (source.at > now || progress.processed[`theater-unit:${source.positionId}`] !== undefined) continue;
    if (owners.has(source.storyId) || !source.messages.length) continue;
    owners.add(source.storyId);
    const selection = progress.theaterSelections?.[source.positionId];
    // A changed saved choice must be explicitly reviewed, never silently revert to the full text.
    const candidate = theaterExperienceCandidate(source, selection);
    if (!candidate) continue;
    if (!includeOversize && (theaterMaterialLength(candidate.material) > THEATER_CREATION_BUDGET
      || theaterNeedsCapacitySelection(source))) continue;
    if (!candidates.some(item => item.ownerId === source.storyId)) candidates.push(candidate);
  }
  return candidates;
}
export async function loadTheaterExperienceCandidates(progress: SharedExperienceProgress, now: number) {
  return selectTheaterExperienceCandidates(await loadTheaterCoCreationSources(), progress, now);
}
export async function reloadTheaterExperienceCandidate(candidate: CandidateReference, current = false) {
  const source = (await loadTheaterCoCreationSources(candidate.ownerId)).find(s => s.positionId === candidate.refs[0]?.id);
  if (!source) return null;
  const rebuilt = theaterExperienceCandidate(source, current ? undefined : candidate.theaterSelection);
  return rebuilt && (current || rebuilt.refs[0].revision === candidate.refs[0].revision) ? rebuilt : null;
}
export async function loadLatestTheaterCoCreationFact(now = Date.now()) {
  return renderLatestTheaterCoCreationFact(await loadTheaterCoCreationSources(), now);
}
