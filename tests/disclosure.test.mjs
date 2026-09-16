// The data-handling disclosure is a compliance surface, not decoration.
//
// Chrome Web Store policy requires disclosure of how an extension handles user data "even
// when data is processed or stored locally on a user's device and is not transmitted", and
// says the disclosure "must not be located only in a privacy policy, terms of service, or
// similar document". These tests hold the two properties that make the notice real: it is
// rendered in the interface, and policy cannot suppress it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

globalThis.chrome = {
  storage: {
    managed: { get: (_k, cb) => cb({}) },
    sync: { get: (_k, cb) => cb({}) },
    local: { get: (_k, cb) => cb({}), set: (_v, cb) => cb(), remove: (_k, cb) => cb() },
    onChanged: { addListener: () => {} },
  },
  runtime: { onMessage: { addListener: () => {} }, getURL: (p) => p },
};

const { DISCLOSURE, DEFAULTS, defaultStrings } = await import('../src/config.js');

test('the disclosure is not a config key, so policy cannot blank it', () => {
  assert.ok(!('disclosure' in DEFAULTS), 'not in DEFAULTS');
  const schema = JSON.parse(read('schema.json'));
  assert.ok(!('disclosure' in schema.properties), 'not in the policy schema');

  // Nor reachable through the per-state copy overrides, which admins can rewrite freely.
  for (const branded of [true, false]) {
    for (const copy of Object.values(defaultStrings(branded))) {
      const blob = JSON.stringify(copy);
      assert.ok(!blob.includes(DISCLOSURE.records), 'not reachable via strings overrides');
    }
  }
});

test('both notices say something, rather than being empty strings that satisfy a grep', () => {
  for (const part of ['handles', 'records']) {
    assert.equal(typeof DISCLOSURE[part], 'string');
    assert.ok(DISCLOSURE[part].length > 40, `${part} is a real sentence`);
  }
  // The recording notice must name what is recorded and say it stays put.
  assert.match(DISCLOSURE.records, /ts\.net/, 'names the scope of what is recorded');
  assert.match(DISCLOSURE.records, /not sent anywhere/, 'states it is not transmitted');
  assert.match(DISCLOSURE.handles, /stores none of them/, 'baseline stores nothing');
});

test('the guidance page shows the recording notice only while recording is on', () => {
  const help = read('src/help.js');
  assert.match(help, /disclosure\.textContent = config\.recordUnwatchedHosts \? DISCLOSURE\.records : ''/);
  assert.match(help, /disclosure\.hidden = !config\.recordUnwatchedHosts/);
  assert.ok(read('src/help.html').includes('id="disclosure"'), 'the element exists');
  // Default config records nothing, so the line must start hidden.
  assert.equal(DEFAULTS.recordUnwatchedHosts, false);
});

test('the options page always discloses, on every install', () => {
  const options = read('src/options.js');
  assert.match(options, /el\('disclosureHandles'\)\.textContent = DISCLOSURE\.handles/);
  // No condition guards the baseline line: it is unconditional by design.
  assert.ok(
    !/disclosureHandles'\)\.hidden/.test(options),
    'the baseline notice is never hidden'
  );
  assert.match(options, /el\('disclosureRecords'\)\.hidden = !config\.recordUnwatchedHosts/);
});

test('the privacy policy separates handling, storing and transmitting', () => {
  const privacy = read('docs/privacy.md');
  // The old file opened by claiming it collected nothing, which was false under Google's
  // definition of handling. That exact overclaim must not come back.
  assert.ok(!/collects nothing/i.test(privacy), 'no blanket "collects nothing" claim');
  for (const heading of ['## What it handles', '## What it stores', '## What it transmits']) {
    assert.ok(privacy.includes(heading), `has ${heading}`);
  }
});

test('the listing records the Web browsing activity disclosure', () => {
  const listing = read('docs/store-listing.md');
  assert.match(listing, /Tick \*\*Web browsing activity\*\*/);
  assert.match(listing, /must not be located only in a privacy policy/);
});
