import { loadTheaterStories, writeTheaterStoryTransaction, type TheaterStoryDatabase } from './theaterStoryStore';
import type { TheaterStory } from './theaterStoryTypes';

export type TheaterHistoryEntry = {
  story: TheaterStory;
  branches: { id: string; name: string }[];
  hasDialogue: boolean;
};

// Uses the owner's existing story database, never opens or migrates one.
export function createTheaterHistoryRepository(database: TheaterStoryDatabase, now: () => number = Date.now) {
  return {
    load(): Promise<TheaterHistoryEntry[]> {
      return writeTheaterStoryTransaction(database, async (tx) => {
        const stories = await loadTheaterStories(tx);
        const branches = await tx.getAllAsync<{ id: string; conversationId: string; name: string }>(
          'SELECT id, conversation_id AS conversationId, name FROM theater_branches ORDER BY created_at, id',
        );
        const dialogue = await tx.getAllAsync<{ conversationId: string }>(`SELECT DISTINCT p.conversation_id AS conversationId
          FROM theater_branch_positions p JOIN theater_text_versions v ON v.id = p.version_id
          WHERE v.kind = 'dialogue'`);
        const started = new Set(dialogue.map((row) => row.conversationId));
        return stories.map((story) => ({ story, hasDialogue: started.has(story.id),
          branches: branches.filter((branch) => branch.conversationId === story.id)
            .map(({ id, name }) => ({ id, name })) }));
      });
    },
    setPinned(storyId: string, pinned: boolean): Promise<TheaterStory> {
      return writeTheaterStoryTransaction(database, async (tx) => {
        const story = (await loadTheaterStories(tx)).find((item) => item.id === storyId);
        if (!story) throw new Error('theater-history-story-not-found');
        if (!!story.isPinned === pinned) return story;
        const updatedAt = Math.max(now(), story.updatedAt + 1);
        await tx.runAsync(`UPDATE theater_conversations SET is_pinned = ?, updated_at = ?,
          legacy_sync_open = 0 WHERE id = ?`, Number(pinned), updatedAt, storyId);
        return { ...story, isPinned: pinned, updatedAt };
      });
    },
  };
}

export type TheaterHistoryRepository = ReturnType<typeof createTheaterHistoryRepository>;
