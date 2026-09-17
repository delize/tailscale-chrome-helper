// Regression tests for the adversarial review findings. Each one failed before the fix.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let MANAGED = {};
// Captured so the navigation guard can be driven rather than grepped: it is the exact bug
// class a source assertion cannot see, since the old check read a property that was always
// undefined and therefore never fired.
const LISTENERS = {};
const UPDATES = [];
globalThis.chrome = {
  storage: {
    managed: { get: (_k, cb) => cb(MANAGED) },
    sync: { get: (_k, cb) => cb({}) },
    local: { get: (_k, cb) => cb({}), set: (_v, cb) => cb(), remove: (_k, cb) => cb() },
    onChanged: { addListener: () => {} },
  },
  runtime: {
    onMessage: { addListener: () => {} },
    // Absolute, because showHelpPage builds a URL from it.
    getURL: (p) => 'chrome-extension://aaaabbbbccccddddeeeeffffgggghhhh/' + p,
  },
  webNavigation: {
    onErrorOccurred: { addListener: (fn) => (LISTENERS.onErrorOccurred = fn) },
    onBeforeNavigate: { addListener: (fn) => (LISTENERS.onBeforeNavigate = fn) },
  },
  tabs: {
    get: async () => ({}),
    update: async (tabId, props) => UPDATES.push({ tabId, ...props }),
    onRemoved: { addListener: (fn) => (LISTENERS.onRemoved = fn) },
  },
};

const { matchesWatched, invalidateConfig } = await import('../src/config.js');
const { suggestOnTailnet, classify } = await import('../src/background.js');
const { mergeHit, MAX_AGE_MS, STORAGE_VERSION } = await import('../src/hostlog.js');

// The page's validator, mirrored. Kept in step by the source assertions below.
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
function cleanHostParam(value) {
  if (typeof value !== 'string') return '';
  const host = value.trim().toLowerCase().replace(/\.$/, '');
  if (host.length > 253) return '';
  if (host.split('.').some((l) => l.length > 63)) return '';
  return HOSTNAME.test(host) ? host : '';
}

test('an over-long hostname is rejected, never truncated into a different one', () => {
  // Truncating produced a DIFFERENT valid hostname at an offset the attacker chose, so
  // padding the name pushed the admin's tailnet past the cut and left evil.com behind.
  const pad = 'a'.repeat(60) + '.' + 'b'.repeat(50);
  const suggestion = suggestOnTailnet(`https://${pad}.evil.com.zzz.ts.net/`, ['corp.ts.net']);
  const cleaned = cleanHostParam(suggestion);
  assert.ok(!cleaned.endsWith('evil.com'), 'must not yield an attacker-controlled host');

  const tooLong = 'x'.repeat(300) + '.corp.ts.net';
  assert.equal(cleanHostParam(tooLong), '', 'over-length is rejected outright');
  assert.equal(cleanHostParam('a'.repeat(64) + '.corp.ts.net'), '', 'over-long label rejected');
});

test('a suggestion is only trusted when it sits on a watched suffix', () => {
  // Shape was never the property that mattered. Provenance is: every legitimate
  // suggestion is built by pasting the admin's own tailnet on the end.
  const admin = ['corp.ts.net'];
  const good = cleanHostParam(suggestOnTailnet('https://dash.other.ts.net/', admin));
  assert.ok(matchesWatched(`https://${good}/`, admin), 'a real suggestion passes');

  for (const forged of ['dash.evil.com', 'dash.attacker.ts.net', 'corp.ts.net.evil.com']) {
    assert.ok(
      !matchesWatched(`https://${forged}/`, admin),
      `${forged} must not pass provenance`
    );
  }
});

test('classify can reach nameNotFound, and the page actually sends the error', async () => {
  // The parameter existed and the only caller never passed it, so the state was dead.
  const upConfig = { probeTimeoutMs: 50, controlUrl: 'http://example.invalid/' };
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => 'Tailscale' });

  assert.equal(await classify(upConfig, 'net::ERR_NAME_NOT_RESOLVED'), 'nameNotFound');
  assert.equal(await classify(upConfig, 'net::ERR_CONNECTION_RESET'), 'appDown');
  assert.equal(await classify(upConfig, undefined), 'appDown', 'no error means no name verdict');

  // Guard the wiring itself: the fix was lost once to an edit that silently did not apply.
  const help = readFileSync(new URL('../src/help.js', import.meta.url), 'utf8');
  assert.match(
    help,
    /type: 'classify',\s*\n\s*error: tokens\.error/,
    'help.js must send the error with the classify message'
  );
});

test('wrongTailnet does not poll, so it cannot repaint or auto-navigate', () => {
  // Polling answered with an ordinary verdict, repainted the page, hid both buttons, then
  // navigated to the very host it was warning about.
  const help = readFileSync(new URL('../src/help.js', import.meta.url), 'utf8');
  assert.match(help, /if \(state === 'wrongTailnet'\) return;/, 'tick bails on the state');
  const tickAt = help.indexOf('async function tick()');
  const guardAt = help.indexOf("if (state === 'wrongTailnet') return;", tickAt);
  const redirectAt = help.indexOf('location.replace(target.href)', tickAt);
  assert.ok(guardAt > -1 && guardAt < redirectAt, 'the guard precedes the auto-redirect');
});

test('host counts age out and refuse to downgrade a newer record', () => {
  const now = 1_000_000_000_000;
  let store = mergeHit(null, 'a.corp.ts.net', now - MAX_AGE_MS - 1);
  store = mergeHit(store, 'b.corp.ts.net', now);
  assert.ok(!store.hosts['a.corp.ts.net'], 'an entry past the age limit is dropped');
  assert.ok(store.hosts['b.corp.ts.net'], 'a fresh entry survives');

  const future = { version: STORAGE_VERSION + 1, hosts: { 'c.corp.ts.net': { count: 9 } } };
  const result = mergeHit(future, 'd.corp.ts.net', now);
  assert.equal(result.version, STORAGE_VERSION + 1, 'a newer shape is left alone');
  assert.ok(!result.hosts['d.corp.ts.net'], 'and is not written into');
});

test('the parseTarget widening applies only to wrongTailnet', () => {
  // The comment justified it by that state while the code applied it everywhere.
  const help = readFileSync(new URL('../src/help.js', import.meta.url), 'utf8');
  const widenAt = help.indexOf("matchesWatched(url.href, ['ts.net'])");
  const gateAt = help.indexOf("params.get('state') !== 'wrongTailnet'");
  assert.ok(gateAt > -1, 'the widening is gated on the state');
  assert.ok(gateAt < widenAt, 'and the gate comes first');
});

test('step markers are scoped, repeatable, and never leak literal text', () => {
  const help = readFileSync(new URL('../src/help.js', import.meta.url), 'utf8');
  assert.match(help, /replaceAll\('\{continueOnly\}', ''\)/, 'duplicates are stripped');
  assert.match(help, /replaceAll\('\{suggestionOnly\}', ''\)/, 'both markers stripped');
  assert.match(help, /if \(name === 'wrongTailnet'\) \{\s*\n\s*if \(rawStep\.includes/, 'scoped');
});

test('the illustration appears only where finding the toggle is the next action', () => {
  const help = readFileSync(new URL('../src/help.js', import.meta.url), 'utf8');
  const set = help.slice(
    help.indexOf('const ILLUSTRATION_HELPS'),
    help.indexOf(']);', help.indexOf('const ILLUSTRATION_HELPS'))
  );
  assert.ok(set.includes("'tailscaleOff'"), 'the state the page exists for keeps it');
  // offline told the user to check their wifi, then filled the page with a Tailscale
  // tutorial for a symptom that clears itself once the network is back.
  assert.ok(!set.includes("'offline'"), 'offline does not show the illustration');
  assert.ok(!set.includes("'appDown'"), 'nothing in it helps when the app is the problem');
  assert.ok(!set.includes("'wrongTailnet'"), 'a naming problem is not a connection problem');

  // One decision, in one place. wrongTailnet used to repeat it, which is how offline was
  // missed: a new state had to remember to opt out of something it never opted into.
  const decisions = help.match(/el\('illustration'\)\.hidden/g) || [];
  assert.equal(decisions.length, 1, 'exactly one place decides this');
  assert.match(help, /el\('illustration'\)\.hidden = !showIllustration/);
});

// The moved-on guard, driven rather than grepped. The bug it replaces was invisible to a
// source assertion: the old code read Tab.pendingUrl || Tab.url, which Chrome leaves
// undefined without the "tabs" permission, so the check looked correct and never ran.
const TARGET = 'https://app.acme.ts.net/';
const FAILURE = {
  frameId: 0,
  documentLifecycle: 'active',
  error: 'net::ERR_NAME_NOT_RESOLVED',
  url: TARGET,
};

test('the tab is taken over when the user is still on the failed address', async () => {
  MANAGED = { watchedSuffixes: ['acme.ts.net'] };
  invalidateConfig();
  UPDATES.length = 0;

  LISTENERS.onBeforeNavigate({ tabId: 11, frameId: 0, url: TARGET });
  await LISTENERS.onErrorOccurred({ ...FAILURE, tabId: 11 });

  assert.equal(UPDATES.length, 1, 'the guidance page replaced the error page');
  assert.match(UPDATES[0].url, /help\.html/);
});

test('a tab that moved on during the config read is left alone', async () => {
  MANAGED = { watchedSuffixes: ['acme.ts.net'] };
  invalidateConfig();
  UPDATES.length = 0;

  // The user was on the failed address, then typed something else DURING the config read.
  // Ordering is the whole point: a navigation before the error is the baseline, not
  // someone leaving, and conflating the two is what made Chrome's own error-page commit
  // look like the user moving on.
  LISTENERS.onBeforeNavigate({ tabId: 22, frameId: 0, url: TARGET });
  const pending = LISTENERS.onErrorOccurred({ ...FAILURE, tabId: 22 });
  LISTENERS.onBeforeNavigate({ tabId: 22, frameId: 0, url: 'https://elsewhere.example/' });
  await pending;

  assert.equal(UPDATES.length, 0, 'no takeover: the user is somewhere else now');
});

test('a subframe navigation does not count as the user moving on', async () => {
  MANAGED = { watchedSuffixes: ['acme.ts.net'] };
  invalidateConfig();
  UPDATES.length = 0;

  LISTENERS.onBeforeNavigate({ tabId: 33, frameId: 0, url: TARGET });
  // An iframe inside the failed page is not the user going somewhere.
  LISTENERS.onBeforeNavigate({ tabId: 33, frameId: 3, url: 'https://ads.example/pixel' });
  await LISTENERS.onErrorOccurred({ ...FAILURE, tabId: 33 });

  assert.equal(UPDATES.length, 1, 'still taken over');
});

test('closing a tab does not leak its navigation record', () => {
  LISTENERS.onBeforeNavigate({ tabId: 44, frameId: 0, url: TARGET });
  LISTENERS.onRemoved(44);
  // Nothing observable to assert beyond it not throwing, but the listener must exist and
  // accept a bare tabId, which is the shape Chrome actually sends.
  assert.ok(typeof LISTENERS.onRemoved === 'function');
});

test('Chrome committing its own error page does not cancel the takeover', async () => {
  MANAGED = { watchedSuffixes: ['acme.ts.net'] };
  invalidateConfig();
  UPDATES.length = 0;

  LISTENERS.onBeforeNavigate({ tabId: 55, frameId: 0, url: TARGET });
  const pending = LISTENERS.onErrorOccurred({ ...FAILURE, tabId: 55 });
  // This is what Chrome actually does, and it lands inside the window the guard reads.
  // Counting it meant the page never appeared and the tab stayed dead until the extension
  // was reloaded, because the map has no expiry.
  LISTENERS.onBeforeNavigate({ tabId: 55, frameId: 0, url: 'chrome-error://chromewebdata/' });
  await pending;

  assert.equal(UPDATES.length, 1, 'the guidance page still replaced the error page');
});

test('an https upgrade of the same address is the browser retrying, not the user leaving', async () => {
  MANAGED = { watchedSuffixes: ['acme.ts.net'] };
  invalidateConfig();
  UPDATES.length = 0;

  LISTENERS.onBeforeNavigate({ tabId: 66, frameId: 0, url: TARGET });
  const pending = LISTENERS.onErrorOccurred({ ...FAILURE, tabId: 66 });
  LISTENERS.onBeforeNavigate({ tabId: 66, frameId: 0, url: TARGET.replace('https://', 'http://') });
  await pending;

  assert.equal(UPDATES.length, 1, 'same host, so not a departure');
});

test('an abandoned takeover does not claim the suppression slot', async () => {
  MANAGED = { watchedSuffixes: ['acme.ts.net'] };
  invalidateConfig();
  UPDATES.length = 0;

  // First attempt is abandoned because the user really did navigate away.
  LISTENERS.onBeforeNavigate({ tabId: 77, frameId: 0, url: TARGET });
  let pending = LISTENERS.onErrorOccurred({ ...FAILURE, tabId: 77 });
  LISTENERS.onBeforeNavigate({ tabId: 77, frameId: 0, url: 'https://elsewhere.example/' });
  await pending;
  assert.equal(UPDATES.length, 0, 'nothing shown, as intended');

  // Coming straight back must still work. It used to be suppressed, because asking
  // whether to suppress also claimed the slot for a page that never appeared.
  LISTENERS.onBeforeNavigate({ tabId: 77, frameId: 0, url: TARGET });
  pending = LISTENERS.onErrorOccurred({ ...FAILURE, tabId: 77 });
  await pending;

  assert.equal(UPDATES.length, 1, 'the retry is not suppressed by the abandoned attempt');
});

test('turning recording off deletes the record even across a worker restart', async () => {
  // The bug: the old code remembered "recording used to be on" in a module variable. MV3
  // kills an idle worker in about thirty seconds, so an administrator who turned the
  // setting off while it was asleep got a worker that only ever saw "off", never observed
  // the transition, and never deleted anything. privacy.md promises otherwise.
  const removed = [];
  const priorLocal = globalThis.chrome.storage.local;
  globalThis.chrome.storage.local = {
    ...priorLocal,
    remove: (key, cb) => {
      removed.push(key);
      cb && cb();
    },
  };
  try {
    // A cold worker, started with the setting already off, having never seen it on.
    MANAGED = { recordUnwatchedHosts: false };
    invalidateConfig();
    const { loadConfig } = await import('../src/config.js');
    const { clearUnwatchedHits, STORAGE_KEY } = await import('../src/hostlog.js');
    const { config } = await loadConfig({ force: true });

    assert.equal(config.recordUnwatchedHosts, false);
    await clearUnwatchedHits();
    assert.ok(removed.includes(STORAGE_KEY), 'the record is deleted without remembering anything');
  } finally {
    globalThis.chrome.storage.local = priorLocal;
  }
});

test('the worker clears the record on startup, not only on a change event', () => {
  const src = readFileSync(new URL('../src/background.js', import.meta.url), 'utf8');
  // Both paths must call it: a change event alone misses the case where the change
  // happened while the worker was dead.
  assert.match(src, /watchConfig\(\(\{ config \}\) => clearIfRecordingIsOff\(config\)\)/);
  assert.match(src, /loadConfig\(\)\.then\(\(\{ config \}\) => clearIfRecordingIsOff\(config\)\)/);
  assert.ok(!src.includes('recordingWasOn'), 'no remembered previous state');
});
