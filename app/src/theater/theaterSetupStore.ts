import { loadTheaterStories, writeTheaterStoryTransaction, type TheaterStoryDatabase } from './theaterStoryStore';
import { resolveTheaterTitle, theaterSetupSettingsFromDraft, type TheaterSetupDraft } from './theaterSetupDraft';
import type { TheaterStory } from './theaterStoryTypes';

// Chapter 4 candidate: the owner supplies an already migrated database. No live
// opener, migration, AI request or old-message projection is installed here.
export function createTheaterSetupRepository(
  database: TheaterStoryDatabase,
  createId: () => string,
  now: () => number = Date.now,
) {
  return {
    load: () => loadTheaterStories(database),
    async save(draft: TheaterSetupDraft, storyId: string | null, asDraft: boolean): Promise<TheaterStory> {
      // Validate before opening the transaction; bad input must not create a card.
      const settings = theaterSetupSettingsFromDraft(draft);
      return writeTheaterStoryTransaction(database, async (tx) => {
        const current = storyId ? (await loadTheaterStories(tx)).find((story) => story.id === storyId) : null;
        if (storyId && !current) throw new Error('theater-setup-story-not-found');
        const timestamp = now();
        const story: TheaterStory = {
          id: current?.id ?? createId(),
          title: resolveTheaterTitle(draft.title, draft.world, timestamp),
          settings: { ...settings, legacyPersona: current?.settings.legacyPersona ?? null },
          summaryInterval: Number(draft.summaryInterval) === 0 ? null : Number(draft.summaryInterval),
          isDraft: current && !current.isDraft ? false : asDraft,
          isPinned: current?.isPinned ?? false,
          createdAt: current?.createdAt ?? timestamp,
          updatedAt: timestamp,
        };
        if (current) {
          // Do not write an old whole-story snapshot over pinning or story content.
          await tx.runAsync(`UPDATE theater_conversations SET title = ?, settings_json = ?,
            summary_interval = ?, is_draft = ?, legacy_sync_open = 0, updated_at = ? WHERE id = ?`,
          story.title, JSON.stringify(story.settings), story.summaryInterval, Number(story.isDraft), timestamp, story.id);
        } else {
          await tx.runAsync(`INSERT INTO theater_conversations
            (id, title, settings_json, summary_interval, is_draft, is_pinned, legacy_sync_open, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)`,
          story.id, story.title, JSON.stringify(story.settings), story.summaryInterval, Number(asDraft), timestamp, timestamp);
          // Creating the card and its initial branch is one transaction.
          await tx.runAsync(`INSERT INTO theater_branches
            (id, conversation_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
          createId(), story.id, '最初走向', timestamp, timestamp);
        }
        return story;
      });
    },
    async rename(storyId: string, title: string): Promise<TheaterStory> {
      return writeTheaterStoryTransaction(database, async (tx) => {
        const current = (await loadTheaterStories(tx)).find((story) => story.id === storyId);
        if (!current) throw new Error('theater-setup-story-not-found');
        const updatedAt = now();
        const resolved = resolveTheaterTitle(title, current.settings.world, updatedAt);
        await tx.runAsync(`UPDATE theater_conversations SET title = ?, updated_at = ?, legacy_sync_open = 0 WHERE id = ?`,
          resolved, updatedAt, storyId);
        return { ...current, title: resolved, updatedAt };
      });
    },
  };
}

export type TheaterSetupRepository = ReturnType<typeof createTheaterSetupRepository>;
