// Issue #8. `offline` used to be inferred from a single failed request to a single host,
// so a network that blocked only the connectivity endpoint was indistinguishable from an
// unplugged cable. The user was told to check their wifi when their wifi was fine and
// Tailscale was the actual problem.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Each case decides what every URL does, so the two endpoints can fail independently.
let ROUTES = {};
let REQUESTS = [];

globalThis.fetch = async (url, options = {}) => {
  REQUESTS.push({ url: String(url), mode: options.mode });
  const route = ROUTES[String(url)];
  if (!route) throw new TypeError('Failed to fetch');
  if (route === 'throw') throw new TypeError('Failed to fetch');
  return route;
};

const ONLINE_204 = { ok: true, status: 204, type: 'basic', text: async () => '' };
const OPAQUE = { ok: false, status: 0, type: 'opaque', text: async () => '' };
const REDIRECT = { ok: false, status: 302, type: 'opaqueredirect', text: async () => '' };
const QUAD100 = { ok: true, status: 200, type: 'basic', text: async () => 'Tailscale is running' };

// Node 24 ships a real, getter-only navigator, so it has to be redefined rather than
// assigned. The extension reads navigator.onLine in a service worker, where it exists.
const NAV = { onLine: true };
Object.defineProperty(globalThis, 'navigator', { value: NAV, configurable: true, writable: true });
globalThis.chrome = {
  storage: {
    managed: { get: (_k, cb) => cb({}) },
    sync: { get: (_k, cb) => cb({}) },
    local: { get: (_k, cb) => cb({}), set: (_v, cb) => cb(), remove: (_k, cb) => cb() },
    session: { get: (_k, cb) => cb({}), set: (_v, cb) => cb() },
    onChanged: { addListener: () => {} },
  },
  runtime: { onMessage: { addListener: () => {} }, getURL: (p) => 'chrome-extension://x/' + p },
  webNavigation: {
    onErrorOccurred: { addListener: () => {} },
    onBeforeNavigate: { addListener: () => {} },
  },
  tabs: { get: async () => ({}), update: async () => {}, onRemoved: { addListener: () => {} } },
};

const { classify } = await import('../src/background.js');
const { DEFAULTS } = await import('../src/config.js');

const QUAD = 'http://100.100.100.100/';
const CONTROL = DEFAULTS.controlUrl;
const FALLBACK = DEFAULTS.controlUrlFallback;

function setup(routes) {
  ROUTES = routes;
  REQUESTS = [];
  NAV.onLine = true;
  return { ...DEFAULTS };
}

test('the endpoint being blocked is not the device being offline', async () => {
  // Tailscale down, control endpoint blocked by a filter, the internet otherwise fine.
  const config = setup({ [QUAD]: 'throw', [CONTROL]: 'throw', [FALLBACK]: OPAQUE });

  const state = await classify(config, 'net::ERR_NAME_NOT_RESOLVED');

  assert.equal(state, 'tailscaleOff', 'the real problem is Tailscale, not the network');
  assert.ok(
    REQUESTS.some((r) => r.url === FALLBACK),
    'the second opinion was actually sought'
  );
});

test('both endpoints failing is still offline', async () => {
  const config = setup({ [QUAD]: 'throw', [CONTROL]: 'throw', [FALLBACK]: 'throw' });
  assert.equal(await classify(config, 'net::ERR_NAME_NOT_RESOLVED'), 'offline');
});

test('the fallback is not contacted when the first endpoint answers', async () => {
  const config = setup({ [QUAD]: 'throw', [CONTROL]: ONLINE_204, [FALLBACK]: OPAQUE });

  assert.equal(await classify(config, 'net::ERR_NAME_NOT_RESOLVED'), 'tailscaleOff');
  assert.ok(
    !REQUESTS.some((r) => r.url === FALLBACK),
    'no second request when the first one succeeded'
  );
});

test('navigator.onLine false short-circuits both probes', async () => {
  const config = setup({ [QUAD]: 'throw', [CONTROL]: ONLINE_204, [FALLBACK]: OPAQUE });
  NAV.onLine = false;

  assert.equal(await classify(config, 'net::ERR_NAME_NOT_RESOLVED'), 'offline');
  assert.ok(
    !REQUESTS.some((r) => r.url === CONTROL || r.url === FALLBACK),
    'no point probing when the browser says there is no route'
  );
});

test('navigator.onLine true decides nothing on its own', async () => {
  // onLine is true on a machine sitting on a wifi network with no upstream, which is why
  // it may only rule offline in, never out.
  const config = setup({ [QUAD]: 'throw', [CONTROL]: 'throw', [FALLBACK]: 'throw' });
  NAV.onLine = true;
  assert.equal(await classify(config, 'net::ERR_NAME_NOT_RESOLVED'), 'offline');
});

test('a captive portal is still a captive portal, not a fallback case', async () => {
  const config = setup({ [QUAD]: 'throw', [CONTROL]: REDIRECT, [FALLBACK]: OPAQUE });
  assert.equal(await classify(config, 'net::ERR_NAME_NOT_RESOLVED'), 'captivePortal');
});

test('Tailscale being up wins before any connectivity probe runs', async () => {
  const config = setup({ [QUAD]: QUAD100, [CONTROL]: 'throw', [FALLBACK]: 'throw' });

  assert.equal(await classify(config, 'net::ERR_CONNECTION_REFUSED'), 'appDown');
  assert.ok(!REQUESTS.some((r) => r.url === CONTROL), 'connectivity is irrelevant here');
});

test('the fallback is fetched no-cors, so it needs no host permission', async () => {
  const config = setup({ [QUAD]: 'throw', [CONTROL]: 'throw', [FALLBACK]: OPAQUE });
  await classify(config, 'net::ERR_NAME_NOT_RESOLVED');

  const call = REQUESTS.find((r) => r.url === FALLBACK);
  assert.equal(call.mode, 'no-cors');
});

test('the two default endpoints are run by different operators', async () => {
  // A network that blocks one Google endpoint usually blocks the rest, so pairing two
  // Google hosts would make the second opinion worthless.
  const host = (u) => new URL(u).hostname.split('.').slice(-2).join('.');
  assert.notEqual(host(DEFAULTS.controlUrl), host(DEFAULTS.controlUrlFallback));
});
