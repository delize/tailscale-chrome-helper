// Tracks which (tab, URL) pairs have just been sent to the guidance page.
//
// Pressing Back from the guidance page re-runs the same failing navigation instantly, and
// without this the tab bounces straight forward again and the user can never leave. The
// record is in memory on purpose: a worker restart forgets it, which at worst shows one
// extra guidance page and never misses one.
//
// A deliberate retry is the case this must not catch, so the guidance page clears its own
// entry before navigating. Kept separate from the worker so that distinction is testable.

import { navKey } from './navigation.js';

export function createSuppressor({ now = () => Date.now(), maxEntries = 100 } = {}) {
  const seen = new Map();
  // Keyed on the shared navigation identity, not the raw URL. Keying on the URL meant
  // Chrome's https-to-http fallback produced two keys for one navigation, so neither
  // suppressed the other, the page fired twice, and the retry from the page the user was
  // actually shown cleared only one of the two slots. See src/navigation.js.
  const key = (tabId, url) => tabId + '|' + (navKey(url) ?? url);

  return {
    // A pure question. It used to record as well, which meant a takeover that was later
    // abandoned still claimed the slot: the page never appeared, and the retry seconds
    // later was suppressed because the first attempt had marked itself as shown. Asking
    // and claiming are now separate, and the claim belongs to whoever actually showed
    // something.
    shouldSuppress(tabId, url, suppressMs) {
      const at = seen.get(key(tabId, url));
      return at !== undefined && now() - at < suppressMs;
    },

    // Called once the guidance page is genuinely on screen.
    // No suppressMs: it was only ever a sweep hint here and never affected the record
    // written, so the same argument name meant the query window in one method and a
    // garbage-collection detail in the other. Oldest-first eviction gives the same bound.
    markShown(tabId, url) {
      const k = key(tabId, url);
      const t = now();
      seen.set(k, t);

      // Evict oldest-first so a burst of distinct failures cannot grow the map without
      // bound. Age is not consulted: an entry older than any caller's window is harmless,
      // because shouldSuppress compares against the window it is given.
      if (seen.size > maxEntries) {
        const ordered = [...seen.entries()].sort((a, b) => a[1] - b[1]);
        for (const [entry] of ordered.slice(0, seen.size - maxEntries)) seen.delete(entry);
      }
    },

    clear(tabId, url) {
      seen.delete(key(tabId, url));
    },

    size() {
      return seen.size;
    },
  };
}
