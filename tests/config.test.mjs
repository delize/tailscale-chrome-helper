// Exercises the parts that decide what an administrator's policy actually does, which is
// where a mistake would be both silent and tenant-visible.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// config.js talks to chrome.storage, so the stub is installed before it is imported.
let MANAGED = {};
let SYNC = {};
globalThis.chrome = {
  storage: {
    managed: { get: (_k, cb) => cb(MANAGED) },
    sync: { get: (_k, cb) => cb(SYNC) },
    onChanged: { addListener: () => {} },
  },
  runtime: {},
};

const { loadConfig, invalidateConfig, matchesWatched, applyTokens, DEFAULTS } = await import(
  '../src/config.js'
);

async function resolve(managed = {}, sync = {}) {
  MANAGED = managed;
  SYNC = sync;
  invalidateConfig();
  return loadConfig({ force: true });
}

test('managed beats sync beats defaults', async () => {
  const { config, managedKeys } = await resolve(
    { companyName: 'Acme' },
    { companyName: 'Ignored', tailnetName: 'FromUser' }
  );
  assert.equal(config.companyName, 'Acme');
  assert.equal(config.tailnetName, 'FromUser');
  assert.equal(config.supportLabel, DEFAULTS.supportLabel);
  assert.ok(managedKeys.has('companyName'));
  assert.ok(!managedKeys.has('tailnetName'));
});

test('a managed value that fails validation falls through rather than locking the key', async () => {
  const { config, managedKeys } = await resolve(
    { supportUrl: 'javascript:alert(1)' },
    { supportUrl: 'https://help.example.com/' }
  );
  assert.equal(config.supportUrl, 'https://help.example.com/');
  assert.ok(!managedKeys.has('supportUrl'), 'a rejected policy value must not lock the field');
});

test('links are restricted to safe schemes', async () => {
  for (const bad of ['javascript:alert(1)', 'data:text/html,<script>', 'http://plain.example.com/', 'file:///etc/passwd']) {
    const { config } = await resolve({ supportUrl: bad });
    assert.equal(config.supportUrl, DEFAULTS.supportUrl, `${bad} must be rejected`);
  }
  for (const good of ['https://help.example.com/', 'mailto:it@example.com', 'slack://channel?id=C1']) {
    const { config } = await resolve({ supportUrl: good });
    assert.notEqual(config.supportUrl, DEFAULTS.supportUrl, `${good} must be accepted`);
  }
});

test('logos must be inline data, never a remote fetch', async () => {
  const remote = await resolve({ logoDataUrl: 'https://cdn.example.com/logo.png' });
  assert.equal(remote.config.logoDataUrl, '');
  const inline = await resolve({ logoDataUrl: 'data:image/png;base64,iVBORw0KGgo=' });
  assert.equal(inline.config.logoDataUrl, 'data:image/png;base64,iVBORw0KGgo=');
});

test('watched suffixes reject junk and anything too broad to be meant', async () => {
  const { config } = await resolve({
    watchedSuffixes: ['ACME.TS.NET', 'acme.ts.net', '.leading.ts.net.', 'localhost', 'co.uk', 42, ''],
  });
  assert.deepEqual(config.watchedSuffixes, ['acme.ts.net', 'leading.ts.net']);
});

test('an entirely invalid suffix list keeps the default rather than watching nothing', async () => {
  const { config } = await resolve({ watchedSuffixes: ['localhost', 'co.uk'] });
  assert.deepEqual(config.watchedSuffixes, DEFAULTS.watchedSuffixes);
});

test('numeric settings are clamped to sane bounds', async () => {
  const low = await resolve({ probeTimeoutMs: 1, askItAfterAttempts: 0 });
  assert.equal(low.config.probeTimeoutMs, 200);
  assert.equal(low.config.askItAfterAttempts, 1);
  const high = await resolve({ pollIntervalMs: 9999999 });
  assert.equal(high.config.pollIntervalMs, 60000);
  const junk = await resolve({ probeTimeoutMs: 'soon' });
  assert.equal(junk.config.probeTimeoutMs, DEFAULTS.probeTimeoutMs);
});

test('copy overrides keep known states and drop everything else', async () => {
  const { config } = await resolve({
    strings: {
      tailscaleOff: { headline: 'Custom', steps: ['one', 'two'], bogus: 'x' },
      notAState: { headline: 'nope' },
    },
  });
  assert.equal(config.strings.tailscaleOff.headline, 'Custom');
  assert.deepEqual(config.strings.tailscaleOff.steps, ['one', 'two']);
  assert.ok(!('bogus' in config.strings.tailscaleOff));
  assert.ok(!('notAState' in config.strings));
});

test('host matching covers the suffix and its subdomains but not lookalikes', () => {
  const suffixes = ['acme.ts.net'];
  assert.ok(matchesWatched('https://acme.ts.net/', suffixes));
  assert.ok(matchesWatched('https://back-office.acme.ts.net/path', suffixes));
  assert.ok(!matchesWatched('https://other.ts.net/', suffixes));
  // The guard that matters: a suffix must not match a domain that merely ends in the text.
  assert.ok(!matchesWatched('https://evilacme.ts.net/', suffixes));
  assert.ok(!matchesWatched('not a url', suffixes));
});

test('tokens substitute known keys and leave unknown ones alone', () => {
  assert.equal(applyTokens('{company} network', { company: 'Acme' }), 'Acme network');
  assert.equal(applyTokens('{nope} here', { company: 'Acme' }), '{nope} here');
  assert.equal(applyTokens(undefined, {}), '');
});
