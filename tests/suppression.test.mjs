import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSuppressor } from '../src/suppression.js';

const at = (t) => () => t;

test('a repeat within the window is suppressed, so Back does not bounce forward', () => {
  let t = 1000;
  const s = createSuppressor({ now: () => t });
  assert.equal(s.shouldSuppress(1, 'https://a.ts.net/', 8000), false, 'first show goes through');
  t = 1200;
  assert.equal(s.shouldSuppress(1, 'https://a.ts.net/', 8000), true, 'the Back bounce is caught');
});

test('an explicit retry is not suppressed once the page clears its entry', () => {
  // The bug this covers: Try again navigated, failed again, and the guard swallowed it,
  // stranding the user on Chrome's error page with no route back to guidance.
  let t = 1000;
  const s = createSuppressor({ now: () => t });
  s.shouldSuppress(1, 'https://a.ts.net/', 8000);

  t = 1500;
  s.clear(1, 'https://a.ts.net/');
  assert.equal(
    s.shouldSuppress(1, 'https://a.ts.net/', 8000),
    false,
    'a cleared entry must let the retry through'
  );
});

test('the window expires', () => {
  let t = 1000;
  const s = createSuppressor({ now: () => t });
  s.shouldSuppress(1, 'https://a.ts.net/', 8000);
  t = 9001;
  assert.equal(s.shouldSuppress(1, 'https://a.ts.net/', 8000), false);
});

test('suppression is per tab and per URL', () => {
  const s = createSuppressor({ now: at(1000) });
  s.shouldSuppress(1, 'https://a.ts.net/', 8000);
  assert.equal(s.shouldSuppress(2, 'https://a.ts.net/', 8000), false, 'another tab is unaffected');
  assert.equal(s.shouldSuppress(1, 'https://b.ts.net/', 8000), false, 'another URL is unaffected');
});

test('clearing an entry that was never recorded is harmless', () => {
  const s = createSuppressor({ now: at(1000) });
  s.clear(99, 'https://never.ts.net/');
  assert.equal(s.size(), 0);
});

test('a burst of distinct failures inside the window still cannot grow the map', () => {
  // Previously the sweep only dropped entries older than the window, so a burst wholly
  // inside it evicted nothing and the map grew unbounded.
  const s = createSuppressor({ now: at(1000), maxEntries: 10 });
  for (let i = 0; i < 500; i += 1) s.shouldSuppress(i, `https://h${i}.ts.net/`, 120000);
  assert.ok(s.size() <= 10, `map grew to ${s.size()}`);
});
