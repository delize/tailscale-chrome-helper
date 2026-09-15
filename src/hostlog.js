// Counts failed navigations to tailnet hosts that are not on a watched suffix.
//
// Deliberately narrow. Only hosts ending in .ts.net are recorded, never arbitrary
// browsing: this exists so an administrator can see that people keep trying to reach the
// wrong tailnet, not to build a log of where someone goes. The extension is told about
// every navigation failure by the webNavigation permission, and chooses to remember
// almost none of them.
//
// The stored shape is a contract. External readers, an osquery extension for example,
// parse this out of the profile's LevelDB, so the key and the record shape should not
// change without a version bump. Chrome holds a lock on that store while running, so a
// reader must copy the files before parsing and tolerate a mid-write snapshot.

export const STORAGE_KEY = 'unwatchedHosts';
export const STORAGE_VERSION = 1;

// Bounded so a long-lived profile cannot grow this without limit.
const MAX_HOSTS = 200;

export function isTailnetHost(host) {
  return typeof host === 'string' && /^[a-z0-9.-]+\.ts\.net$/.test(host);
}

// Pure, so the merge logic is testable without a browser.
export function mergeHit(existing, host, now) {
  const record = existing && typeof existing === 'object' ? { ...existing } : {};
  const hosts = { ...(record.hosts || {}) };
  const prior = hosts[host];
  hosts[host] = {
    count: (prior?.count || 0) + 1,
    firstSeen: prior?.firstSeen || now,
    lastSeen: now,
  };

  const names = Object.keys(hosts);
  if (names.length > MAX_HOSTS) {
    // Drop the least recently seen, so the record stays useful rather than merely old.
    names
      .sort((a, b) => (hosts[a].lastSeen || 0) - (hosts[b].lastSeen || 0))
      .slice(0, names.length - MAX_HOSTS)
      .forEach((name) => delete hosts[name]);
  }

  return { version: STORAGE_VERSION, hosts };
}

export async function recordUnwatchedHit(rawUrl) {
  let host;
  try {
    host = new URL(rawUrl).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return;
  }
  if (!isTailnetHost(host)) return;

  try {
    const current = await new Promise((resolve) => {
      chrome.storage.local.get(STORAGE_KEY, (items) =>
        resolve(chrome.runtime.lastError ? null : items?.[STORAGE_KEY])
      );
    });
    const next = mergeHit(current, host, Date.now());
    await new Promise((resolve) => chrome.storage.local.set({ [STORAGE_KEY]: next }, resolve));
  } catch {
    // Counting is a convenience. It must never interfere with showing the page.
  }
}
