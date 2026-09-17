// Tracks which (tab, URL) pairs have just been sent to the guidance page.
//
// Pressing Back from the guidance page re-runs the same failing navigation instantly, and
// without this the tab bounces straight forward again and the user can never leave. The
// record is in memory on purpose: a worker restart forgets it, which at worst shows one
// extra guidance page and never misses one.
//
// A deliberate retry is the case this must not catch, so the guidance page clears its own
// entry before navigating. Kept separate from the worker so that distinction is testable.

export function createSuppressor({ now = () => Date.now(), maxEntries = 100 } = {}) {
  const seen = new Map();
  const key = (tabId, url) => tabId + '|' + url;

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
    markShown(tabId, url, suppressMs) {
      const k = key(tabId, url);
      const t = now();
      seen.set(k, t);

      if (seen.size > maxEntries) {
        // Drop anything past the window first.
        for (const [entry, stamp] of seen) {
          if (t - stamp > suppressMs) seen.delete(entry);
        }
        // If everything is still inside the window, evict oldest-first so a burst of
        // distinct failures cannot grow the map without bound.
        if (seen.size > maxEntries) {
          const ordered = [...seen.entries()].sort((a, b) => a[1] - b[1]);
          for (const [entry] of ordered.slice(0, seen.size - maxEntries)) seen.delete(entry);
        }
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
