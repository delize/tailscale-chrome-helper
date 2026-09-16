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

// Bounded in time as well as in size. A capacity cap alone meant a profile with a dozen
// entries kept them forever, and this is a record of where someone tried to go.
export const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

export function isTailnetHost(host) {
  return typeof host === 'string' && /^[a-z0-9.-]+\.ts\.net$/.test(host);
}

// Pure, so the merge logic is testable without a browser.
export function mergeHit(existing, host, now) {
  const record = existing && typeof existing === 'object' ? existing : {};
  // Refuse to merge into a shape written by a newer build. Spreading it and stamping the
  // current version would relabel newer data as older, which is exactly what the version
  // field exists to prevent, and an external reader has no way to detect it.
  if (typeof record.version === 'number' && record.version > STORAGE_VERSION) return record;

  const hosts = { ...(record.hosts || {}) };
  for (const [name, entry] of Object.entries(hosts)) {
    if (now - (entry?.lastSeen || 0) > MAX_AGE_MS) delete hosts[name];
  }
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

// Serialises writes. The read and the write are separated by an await, and `set` replaces
// the key wholesale, so two concurrent navigations do not merely lose an increment: the
// later writer's stale snapshot erases every host recorded since it read. Measured at
// three hosts in, one host out. MV3 guarantees a single worker, so a module-level chain is
// sufficient.
let writeQueue = Promise.resolve();

export async function recordUnwatchedHit(rawUrl) {
  let host;
  try {
    host = new URL(rawUrl).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return;
  }
  if (!isTailnetHost(host)) return;

  writeQueue = writeQueue.then(async () => {
    try {
      const current = await new Promise((resolve) => {
        chrome.storage.local.get(STORAGE_KEY, (items) =>
          resolve(chrome.runtime.lastError ? null : items?.[STORAGE_KEY])
        );
      });
      const next = mergeHit(current, host, Date.now());
      await new Promise((resolve) => chrome.storage.local.set({ [STORAGE_KEY]: next }, resolve));
    } catch {
      // Counting is a convenience. It must never interfere with showing the page, and a
      // failure must not break the chain for the next caller.
    }
  });
  return writeQueue;
}

// Called when an administrator turns recording off. Disabling a setting that collects a
// record of where someone tried to go should not leave the record behind.
export async function clearUnwatchedHits() {
  try {
    await new Promise((resolve) => chrome.storage.local.remove(STORAGE_KEY, resolve));
  } catch {
    // Nothing to do if storage is unavailable.
  }
}
