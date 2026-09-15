// Watches navigations that fail in a way that looks like "Tailscale is off" and replaces
// Chrome's error page with guidance that explains how to connect.
//
// Detection needs no host permissions. The webNavigation permission alone delivers
// onErrorOccurred for every host, which is what lets the watched domain list live in
// administrator policy instead of being baked into the manifest.

import { loadConfig, watchConfig, matchesWatched } from './config.js';
import { createSuppressor } from './suppression.js';

// Tailscale's Quad100 magic IP. It answers HTTP only while the client is connected, so
// it doubles as a connectivity probe.
const PROBE_URL = 'http://100.100.100.100/';

// Navigation failures that mean the app was never reached. The DNS entries cover the
// NXDOMAIN page users actually see when MagicDNS is off. The connection entries cover
// the case where the name resolves, because public DNS records exist once HTTPS certs
// are enabled, but the 100.x address is unreachable because Tailscale is off.
const NETWORK_ERRORS = new Set([
  'net::ERR_NAME_NOT_RESOLVED',
  'net::ERR_NAME_RESOLUTION_FAILED',
  'net::ERR_DNS_TIMED_OUT',
  'net::ERR_CONNECTION_REFUSED',
  'net::ERR_CONNECTION_TIMED_OUT',
  'net::ERR_CONNECTION_RESET',
  'net::ERR_ADDRESS_UNREACHABLE',
  'net::ERR_INTERNET_DISCONNECTED',
  'net::ERR_TIMED_OUT',
]);

// See src/suppression.js for why this exists and why it is deliberately in memory.
const suppressor = createSuppressor();

async function fetchWithTimeout(url, timeoutMs, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { cache: 'no-store', signal: controller.signal, ...options });
    return { res, done: () => clearTimeout(timer) };
  } catch (error) {
    clearTimeout(timer);
    throw error;
  }
}

// Content-verified. A captive portal can answer plain HTTP for any address, so a bare
// 200 from 100.100.100.100 proves nothing. The real Quad100 page identifies itself.
async function tailscaleIsUp(config) {
  let done = () => {};
  try {
    const probe = await fetchWithTimeout(PROBE_URL, config.probeTimeoutMs);
    done = probe.done;
    if (!probe.res.ok) return false;
    const text = await probe.res.text();
    return text.includes('Tailscale');
  } catch {
    return false;
  } finally {
    done();
  }
}

// 'online' means the public internet answered normally. 'captive' means something answered
// on the network's behalf, so a portal sign-in is pending. 'offline' means nothing
// answered at all.
//
// The probe is deliberately plaintext http. A captive portal cannot intercept an https
// request without a certificate the client will reject, so an https probe can only ever
// fail, which this code used to read as "offline" and tell a hotel guest to check their
// ethernet cable. Over http the portal answers, and that answer is the signal.
async function classifyInternet(config) {
  let done = () => {};
  try {
    const probe = await fetchWithTimeout(config.controlUrl, config.probeTimeoutMs, {
      redirect: 'manual',
    });
    done = probe.done;
    const { res } = probe;

    // The usual portal behaviour: bounce the request to a sign-in page.
    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) return 'captive';
    // The real endpoint answers 204 with no body. A portal that serves its login page
    // with a 200 instead of redirecting is caught here rather than passing as online.
    if (res.status === 204) return 'online';
    // An opaque response means no host permission for this endpoint, so the status is
    // unreadable. Something answered and did not redirect, which is the best we can say.
    if (res.type === 'opaque') return 'online';
    return 'captive';
  } catch {
    return 'offline';
  } finally {
    done();
  }
}

export async function classify(config) {
  if (await tailscaleIsUp(config)) return 'appDown';
  const internet = await classifyInternet(config);
  if (internet === 'captive') return 'captivePortal';
  if (internet === 'offline') return 'offline';
  return 'tailscaleOff';
}

// Classification takes up to two probe timeouts, so this runs seconds after the navigation
// failed. In that window the user may have typed a different URL, hit Back, or closed the
// tab, so the tab is re-checked before it is taken over and the update is never allowed to
// reject into nothing.
async function showHelpPage(tabId, targetUrl, extraParams) {
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return; // Tab closed while we were probing.
  }
  const current = tab.pendingUrl || tab.url;
  if (current && current !== targetUrl) return; // User moved on; leave them alone.

  const helpUrl = new URL(chrome.runtime.getURL('src/help.html'));
  helpUrl.searchParams.set('target', targetUrl);
  for (const [key, value] of Object.entries(extraParams)) {
    if (value !== undefined && value !== null) helpUrl.searchParams.set(key, String(value));
  }
  try {
    await chrome.tabs.update(tabId, { url: helpUrl.toString() });
  } catch {
    // The tab went away between the check and the update. Nothing to recover.
  }
}

chrome.webNavigation.onErrorOccurred.addListener(async (details) => {
  if (details.tabId < 0 || details.frameId !== 0) return;
  // Ignore prerender and other non-visible navigations.
  if (details.documentLifecycle && details.documentLifecycle !== 'active') return;
  if (!NETWORK_ERRORS.has(details.error)) return;

  const { config } = await loadConfig();
  if (!config.enabled) return;
  if (!matchesWatched(details.url, config.watchedSuffixes)) return;
  if (suppressor.shouldSuppress(details.tabId, details.url, config.suppressMs)) return;

  // Deliberately not classified here. The Quad100 probe is blackholed rather than refused
  // when Tailscale is off, so it burns its full timeout, and the portal probe adds another
  // round trip. Waiting for both left the user staring at Chrome's error page for one to
  // three seconds. The guidance page renders immediately and asks for the classification
  // itself, which it already does on every poll.
  await showHelpPage(details.tabId, details.url, { error: details.error });
});

// The guidance page asks the worker to probe rather than fetching Quad100 itself, so the
// check works regardless of page-level cross-origin rules.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message) return;
  // Every path must call sendResponse. A rejection that skipped it left the help page
  // awaiting a reply that never came, with its poll loop locked on `ticking`.
  if (message.type === 'probe-tailscale') {
    loadConfig()
      .then(({ config }) => tailscaleIsUp(config))
      .then(sendResponse, () => sendResponse(false));
    return true;
  }
  if (message.type === 'retrying') {
    // Sent by the guidance page immediately before it navigates back to the app, so a
    // retry that fails again returns to guidance instead of Chrome's error page.
    if (_sender.tab && typeof message.url === 'string') {
      suppressor.clear(_sender.tab.id, message.url);
    }
    sendResponse(true);
    return true;
  }
  if (message.type === 'classify') {
    loadConfig()
      .then(({ config }) => classify(config))
      .then(sendResponse, () => sendResponse(null));
    return true;
  }
});

watchConfig();
