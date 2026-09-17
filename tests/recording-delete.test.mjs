// Turning off the local host counter must delete the record. Failing to READ policy must
// not.
//
// Both look like `recordUnwatchedHosts === false` to the worker, because an unreadable
// managed store falls back to DEFAULTS where it is false. The action taken on that reading
// is an irreversible delete of data an administrator was collecting, and Chrome's policy
// provider initialises asynchronously, so an early worker wake on a managed device
// legitimately sees empty managed storage.
//
// One subprocess per case: the worker's startup path runs at module load, and ES module
// caching means a single process can only exercise it once.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BG = new URL('../src/background.js', import.meta.url).pathname;

// `mode` decides what the managed read does. Everything else is held constant.
function harness(mode) {
  return `
const REMOVED = [];
let LOCAL = { unwatchedHosts: { version: 1, hosts: { 'a.ts.net': { count: 3, firstSeen: 1, lastSeen: 2 } } } };
const managedGet = (cb) => {
  if (${JSON.stringify(mode)} === 'throw') throw new Error('no policy on this install');
  if (${JSON.stringify(mode)} === 'lasterror') {
    globalThis.chrome.runtime.lastError = { message: 'unavailable' };
    cb({});
    globalThis.chrome.runtime.lastError = null;
    return;
  }
  if (${JSON.stringify(mode)} === 'empty') return cb({});
  if (${JSON.stringify(mode)} === 'badvalue') return cb({ recordUnwatchedHosts: 'true' });
  if (${JSON.stringify(mode)} === 'off') return cb({ recordUnwatchedHosts: false });
  if (${JSON.stringify(mode)} === 'on') return cb({ recordUnwatchedHosts: true });
  return cb({});
};
globalThis.chrome = {
  runtime: { lastError: null, onMessage: { addListener: () => {} }, getURL: (p) => 'chrome-extension://x/' + p },
  storage: {
    managed: { get: (_k, cb) => managedGet(cb) },
    sync: { get: (_k, cb) => cb({}) },
    local: {
      get: (_k, cb) => cb(LOCAL),
      set: (v, cb) => { Object.assign(LOCAL, v); cb && cb(); },
      remove: (k, cb) => { REMOVED.push(k); delete LOCAL[k]; cb && cb(); },
    },
    session: { get: (_k, cb) => cb({}), set: (_v, cb) => cb && cb() },
    onChanged: { addListener: () => {} },
  },
  webNavigation: { onErrorOccurred: { addListener: () => {} }, onBeforeNavigate: { addListener: () => {} } },
  tabs: { get: async () => ({}), update: async () => {}, onRemoved: { addListener: () => {} } },
};
await import(${JSON.stringify(BG)});
// Let the startup loadConfig().then settle.
await new Promise((r) => setTimeout(r, 30));
console.log(JSON.stringify({ removed: REMOVED.flat(), survived: Boolean(LOCAL.unwatchedHosts) }));
`;
}

function run(mode) {
  const file = join(mkdtempSync(join(tmpdir(), 'rec-')), 'case.mjs');
  writeFileSync(file, harness(mode));
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [file], (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(JSON.parse(stdout.trim().split('\n').pop()));
    });
  });
}

test('policy genuinely saying off deletes the record', async () => {
  const r = await run('off');
  assert.ok(r.removed.includes('unwatchedHosts'), 'the administrator turned it off');
  assert.equal(r.survived, false);
});

test('a managed read that throws does not delete anything', async () => {
  // config.js:read documents that managed reads throw on installs with no policy at all.
  const r = await run('throw');
  assert.deepEqual(r.removed, [], 'an unreadable policy is not an instruction to delete');
  assert.equal(r.survived, true);
});

test('a managed read reporting lastError does not delete anything', async () => {
  const r = await run('lasterror');
  assert.deepEqual(r.removed, []);
  assert.equal(r.survived, true);
});

test('policy that has not populated yet does not delete anything', async () => {
  // Chrome's policy provider initialises asynchronously, so this is a real state on a
  // managed device at browser start, not a hypothetical.
  const r = await run('empty');
  assert.deepEqual(r.removed, []);
  assert.equal(r.survived, true);
});

test('a value our cleaner rejects does not delete anything', async () => {
  // A string "true" is how a hand-written .reg or a typo'd plist arrives. The cleaner
  // rejects it and the default false is kept, which must not read as "turn it off".
  const r = await run('badvalue');
  assert.deepEqual(r.removed, []);
  assert.equal(r.survived, true);
});

test('recording being on deletes nothing, obviously', async () => {
  const r = await run('on');
  assert.deepEqual(r.removed, []);
  assert.equal(r.survived, true);
});
