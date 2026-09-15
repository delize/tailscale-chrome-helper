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

const { loadConfig, invalidateConfig, matchesWatched, applyTokens, defaultStrings, DEFAULTS, STATES } =
  await import('../src/config.js');

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

test('a rejected policy value keeps the default and never falls through to the user', async () => {
  const { config, managedKeys, rejected } = await resolve(
    { supportUrl: 'javascript:alert(1)' },
    { supportUrl: 'https://help.example.com/' }
  );
  // Falling through to sync here would let an admin typo hand control to the user.
  assert.equal(config.supportUrl, DEFAULTS.supportUrl);
  assert.ok(managedKeys.has('supportUrl'), 'a policy-set key stays locked even when rejected');
  assert.ok(rejected.includes('supportUrl'), 'the rejection is reported to the admin');
});

test('a typo in watchedSuffixes never widens scope beyond what the admin wrote', async () => {
  // A comma for a dot previously resolved to the ts.net default, silently watching every
  // tailnet on the internet instead of one.
  const { config, rejected } = await resolve({ watchedSuffixes: ['acme.ts,net'] });
  assert.ok(rejected.includes('watchedSuffixes'));
  assert.deepEqual(config.watchedSuffixes, DEFAULTS.watchedSuffixes);
});

test('controlUrl rejects schemes that cannot be fetched', async () => {
  for (const bad of ['mailto:it@acme.com', 'slack://x', 'javascript:alert(1)']) {
    const { config } = await resolve({ controlUrl: bad });
    assert.equal(config.controlUrl, DEFAULTS.controlUrl, `${bad} must be rejected`);
  }
  const { config } = await resolve({ controlUrl: 'http://portal.example/generate_204' });
  assert.equal(config.controlUrl, 'http://portal.example/generate_204');
});

test('logo data URIs are accepted with either delimiter and capped in size', async () => {
  const accept = [
    'data:image/png;base64,AA',
    'data:image/png,AAA',
    'data:image/svg+xml,<svg/>',
    'data:image/svg+xml;charset=utf-8,x',
  ];
  for (const v of accept) {
    const { config } = await resolve({ logoDataUrl: v });
    assert.equal(config.logoDataUrl, v, `${v} must be accepted`);
  }
  for (const v of ['data:text/html;base64,AA', 'https://cdn.example/logo.png']) {
    const { config } = await resolve({ logoDataUrl: v });
    assert.equal(config.logoDataUrl, '', `${v} must be rejected`);
  }
  const huge = 'data:image/png;base64,' + 'A'.repeat(300 * 1024);
  const { config } = await resolve({ logoDataUrl: huge });
  assert.equal(config.logoDataUrl, '', 'an oversized logo must be rejected');
});

test('suppressMs cannot be set to zero, which would disable the Back guard', async () => {
  const { config } = await resolve({ suppressMs: 0 });
  assert.equal(config.suppressMs, 1);
});

test('default copy covers every state in both branded and neutral modes', async () => {
  for (const hasCompany of [true, false]) {
    const copy = defaultStrings(hasCompany);
    for (const state of STATES) {
      assert.ok(copy[state], `${state} missing when hasCompany=${hasCompany}`);
      for (const field of ['pill', 'headline', 'lede', 'steps']) {
        assert.ok(copy[state][field], `${state}.${field} missing when hasCompany=${hasCompany}`);
      }
    }
  }
});

test('neutral copy names no company', () => {
  const neutral = defaultStrings(false);
  for (const state of STATES) {
    const blob = JSON.stringify(neutral[state]);
    assert.ok(!blob.includes('{company}'), `${state} still interpolates a company name`);
  }
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
  // A trailing root dot is a valid FQDN and must still match.
  assert.ok(matchesWatched('https://acme.ts.net./', suffixes));
  assert.ok(matchesWatched('https://back-office.acme.ts.net./', suffixes));
});

test('tokens substitute known keys and leave unknown ones alone', () => {
  assert.equal(applyTokens('{company} network', { company: 'Acme' }), 'Acme network');
  assert.equal(applyTokens('{nope} here', { company: 'Acme' }), '{nope} here');
  assert.equal(applyTokens(undefined, {}), '');
});
