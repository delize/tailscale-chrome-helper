// One navigation identity, shared by the moved-on guard and the suppressor.
//
// They disagreed before: the guard compared hostnames, the suppressor compared whole URLs.
// Chrome's https-to-http fallback therefore read as one navigation to one mechanism and
// two to the other, and every symptom of that gap was a separate bug. These cases pin the
// boundary between "the browser retrying" and "the user going somewhere else".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { navKey, sameNavigation } from '../src/navigation.js';

test('the browser retrying the same address is one navigation', () => {
  // The case sameHost() was added for, and the only case it was meant to cover.
  assert.ok(sameNavigation('https://a.ts.net/x', 'http://a.ts.net/x'), 'https upgrade or fallback');
  assert.ok(sameNavigation('https://a.ts.net./x', 'https://a.ts.net/x'), 'a trailing dot is the same host');
  assert.ok(sameNavigation('https://A.TS.NET/x', 'https://a.ts.net/x'), 'host case is not significant');
});

test('going somewhere else is a different navigation', () => {
  // sameHost() compared hostname only, so it called all three of these the same
  // navigation and dragged the user back to a page they had left.
  assert.ok(!sameNavigation('https://a.ts.net/x', 'https://a.ts.net/y'), 'a different path');
  assert.ok(!sameNavigation('https://a.ts.net/x?q=1', 'https://a.ts.net/x?q=2'), 'a different query');
  assert.ok(!sameNavigation('https://a.ts.net/x', 'https://b.ts.net/x'), 'a different host');
  assert.ok(!sameNavigation('https://a.ts.net:8443/x', 'https://a.ts.net/x'), 'a different port');
});

test('only real page navigations have an identity', () => {
  // Chrome commits its own error page inside the window the guard reads, and counting it
  // cancelled the takeover the guard exists to protect.
  for (const u of [
    'chrome-error://chromewebdata/',
    'about:blank',
    'chrome-extension://abcdefghijklmnopabcdefghijklmnop/src/help.html',
    'file:///etc/passwd',
    'not a url',
    '',
  ]) {
    assert.equal(navKey(u), null, `${JSON.stringify(u)} is not the user navigating`);
  }
  assert.equal(navKey(undefined), null);
  assert.equal(navKey(null), null);
});

test('a key is stable and comparable as a plain string', () => {
  // Both callers store and compare it directly, so it has to be a primitive.
  assert.equal(navKey('https://a.ts.net/x?q=1'), 'a.ts.net/x?q=1');
  assert.equal(typeof navKey('https://a.ts.net/'), 'string');
});
