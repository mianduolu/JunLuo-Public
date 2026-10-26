import { loadMemoryCurrentStates, loadMemoryCurrentState, currentStateVersion, type MemoryCurrentState } from '../memory/memoryCurrentStateStore';
import { loadCurrentStateMaterial, formatCurrentStateMaterial, type CurrentStateMaterial } from '../memory/memoryCurrentStateContext';
import { contactCurrentStateVersion, type ContactSource, type UnifiedContactState } from './unifiedContact';
import { contactFocusSourceKeys, type ContactMaterialEntry } from './unifiedContactMaterials';
import { loadMemorySourceMessage } from '../memory/memorySourceReader';
import { isFocusMemorySource } from '../focus/focusMemorySource';
import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import { loadChatSessionMessagePage } from '../chat/chatStorage';

function entryFor(material: CurrentStateMaterial): ContactMaterialEntry {
  return { id: material.state.id, version: contactCurrentStateVersion(material.version, material.sourceVersion),
    focusSources: contactFocusSourceKeys(material.sourceParts),
    kind: 'current_state', occurredAt: material.state.knownAt, text: formatCurrentStateMaterial(material),
    formatToBudget: maxChars => formatCurrentStateMaterial(material, { maxChars, requireSourceLabel: true }) };
}

export async function loadContactCurrentState(ref: ContactSource,
  writing?: { sessionId: string; messages: readonly SubjectiveMessage[] }): Promise<ContactMaterialEntry | null> {
  if (ref.kind !== 'current_state') return null;
  const state = await loadMemoryCurrentState(ref.id);
  if (!state || state.status !== 'active') return null;
  const material = await loadCurrentStateMaterial(state, writing ? async (sessionId, messageId) => {
    if (sessionId === writing.sessionId) return writing.messages.find(message => message.id === messageId) ?? null;
    if (isFocusMemorySource(sessionId) || sessionId.startsWith('post-source:')) return loadMemorySourceMessage(sessionId, messageId, { waitForPendingWrites: false });
    // beforeAppend already owns the global chat writer. Reuse its existing
    // lock-aware page reader for a fixed reference in a historical session.
    let beforeIndex: number | undefined;
    do {
      const page = await loadChatSessionMessagePage(sessionId, { limit: 100, beforeIndex, waitForPendingWrites: false });
      const message = page.messages.find(item => item.id === messageId);
      if (message) return message;
      if (!page.startIndex || beforeIndex !== undefined && page.startIndex >= beforeIndex) return null;
      beforeIndex = page.startIndex;
    } while (true);
  } : undefined);
  if (!material) return null;
  const version = contactCurrentStateVersion(material.version, material.sourceVersion);
  if (version !== ref.version) return null;
  return entryFor(material);
}

export async function prepareContactCurrentStates(state: UnifiedContactState): Promise<ContactMaterialEntry[]> {
  const previous = state.lastOrdinaryCurrentStateOffer?.currentState;
  const states: MemoryCurrentState[] = [];
  for (;;) {
    const page = await loadMemoryCurrentStates({ currentOnly: true, limit: 100, offset: states.length });
    states.push(...page);
    if (page.length < 100) break;
  }
  const savedAt = state.lastOrdinaryCurrentStateOffer?.savedAt;
  const old = states.filter(item => savedAt === undefined || item.updatedAt <= savedAt).sort((a, b) => a.id.localeCompare(b.id));
  const afterPrevious = previous ? old.findIndex(item => item.id.localeCompare(previous.id) > 0) : 0;
  const start = Math.max(0, afterPrevious);
  const ordered = [...states.filter(item => savedAt !== undefined && item.updatedAt > savedAt)
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)), ...old.slice(start), ...old.slice(0, start)];
  const entries: ContactMaterialEntry[] = [];
  for (const item of ordered) {
    // A confirmed revision is new progress. Shared words or shared source messages
    // alone do not establish that a later utterance concerns this same matter.
    if (previous?.id === item.id && previous.version === currentStateVersion(item)) continue;
    const material = await loadCurrentStateMaterial(item);
    if (!material) continue;
    entries.push({ ...entryFor(material), currentStateOrder: entries.length,
      newRevision: savedAt === undefined || item.updatedAt > savedAt });
  }
  return entries;
}
