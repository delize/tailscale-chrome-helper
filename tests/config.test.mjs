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
  runtime: { onMessage: { addListener: () => {} }, getURL: (p) => 'chrome-extension://test/' + p },
  webNavigation: { onErrorOccurred: { addListener: () => {} } },
  tabs: { get: async () => ({}), update: async () => {} },
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

test('openAppUrl allows the app scheme but not arbitrary ones', async () => {
  for (const good of ['tailscale://connect', 'https://selfservice.acme.com/tailscale']) {
    const { config } = await resolve({ openAppUrl: good });
    assert.ok(config.openAppUrl.startsWith(good.split('://')[0]), `${good} must be accepted`);
  }
  // This value becomes an href on a privileged page, so the allowlist is explicit rather
  // than "any custom scheme".
  for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,<script>', 'mailto:x@y.z']) {
    const { config } = await resolve({ openAppUrl: bad });
    assert.equal(config.openAppUrl, DEFAULTS.openAppUrl, `${bad} must be rejected`);
  }
});

test('accentColor accepts only plain hex, because it lands in a CSS property', async () => {
  for (const good of ['#4a63d8', '#ABC', '#abcdef']) {
    const { config } = await resolve({ accentColor: good });
    assert.equal(config.accentColor, good.toLowerCase(), `${good} must be accepted`);
  }
  // Anything that could close a declaration and start another would be CSS injection on
  // a privileged page, so the pattern is deliberately narrower than CSS colour syntax.
  const bad = [
    'red',
    'rgb(1,2,3)',
    '#4a63d8; background: url(https://evil.example/x)',
    'url(javascript:alert(1))',
    '#12345',
    'var(--x)',
    '#4a63d8 !important',
    'expression(alert(1))',
  ];
  for (const v of bad) {
    const { config } = await resolve({ accentColor: v });
    assert.equal(config.accentColor, DEFAULTS.accentColor, `${v} must be rejected`);
  }
});

test('the banner is data-only and capped larger than the logo', async () => {
  const ok = 'data:image/png;base64,AAA';
  const { config } = await resolve({ bannerDataUrl: ok });
  assert.equal(config.bannerDataUrl, ok);

  const remote = await resolve({ bannerDataUrl: 'https://cdn.example/banner.png' });
  assert.equal(remote.config.bannerDataUrl, '', 'a remote banner must be rejected');

  // A banner gets a bigger allowance than a logo, but still a finite one.
  const mid = 'data:image/png;base64,' + 'A'.repeat(400 * 1024);
  assert.notEqual((await resolve({ bannerDataUrl: mid })).config.bannerDataUrl, '');
  assert.equal((await resolve({ logoDataUrl: mid })).config.logoDataUrl, '', 'logo cap is tighter');

  const huge = 'data:image/png;base64,' + 'A'.repeat(2 * 1024 * 1024);
  assert.equal((await resolve({ bannerDataUrl: huge })).config.bannerDataUrl, '');
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

test('suggestOnTailnet refuses to guess when a guess would be a guess', async () => {
  const { suggestOnTailnet } = await import('../src/background.js');
  const mine = ['acme.ts.net'];

  assert.equal(suggestOnTailnet('https://traefik.other.ts.net/', mine), 'traefik.acme.ts.net');
  assert.equal(suggestOnTailnet('https://a.b.other.ts.net/', mine), 'a.b.acme.ts.net');

  // Already ours, so there is nothing to correct.
  assert.equal(suggestOnTailnet('https://traefik.acme.ts.net/', mine), null);
  // A bare tailnet has no device label to carry over.
  assert.equal(suggestOnTailnet('https://other.ts.net/', mine), null);
  // Not a tailnet at all.
  assert.equal(suggestOnTailnet('https://example.com/', mine), null);
  assert.equal(suggestOnTailnet('not a url', mine), null);
  // Two tailnets configured: which one did they mean? Do not pick.
  assert.equal(suggestOnTailnet('https://traefik.other.ts.net/', ['a.ts.net', 'b.ts.net']), null);
  // The broad default watches everything, so nothing is foreign.
  assert.equal(suggestOnTailnet('https://traefik.other.ts.net/', ['ts.net']), null);
});

test('the target allowlist stays narrow even after widening for wrongTailnet', () => {
  // Any tailnet host is accepted, so the wrongTailnet state can name the address it is
  // about. Everything else is still refused.
  assert.ok(matchesWatched('https://dashboard.contoso.ts.net/', ['ts.net']));
  assert.ok(!matchesWatched('https://evil.example/', ['ts.net']));
  assert.ok(!matchesWatched('https://ts.net.evil.example/', ['ts.net']));
});
