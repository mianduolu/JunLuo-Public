import { useEffect, useState } from 'react';
import { loadPostHeartNotice, subscribePostNoticeRead } from './baiyunPostNotice';
import { subscribeBaiyunPosts } from './baiyunPostStore';

/** Tiny arrival query; no post bodies and no page refresh on read acknowledgements. */
export function usePostUnreadNotice() {
  const [unread, setUnread] = useState(false);
  useEffect(() => {
    let live = true, running = false, again = false;
    const refresh = async () => {
      if (running) { again = true; return; }
      running = true;
      try {
        do {
          again = false;
          const next = await loadPostHeartNotice();
          if (live && !again) setUnread(Boolean(next));
        } while (live && again);
      } catch { /* Keep the last known indicator on temporary IO failure. */ }
      finally { running = false; }
    };
    void refresh();
    const changed = subscribeBaiyunPosts(() => { void refresh(); });
    const read = subscribePostNoticeRead(() => { void refresh(); });
    return () => { live = false; changed(); read(); };
  }, []);
  return unread;
}
