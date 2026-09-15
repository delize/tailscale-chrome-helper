// Watches navigations that fail in a way that looks like "Tailscale is off" and replaces
// Chrome's error page with guidance that explains how to connect.
//
// Detection needs no host permissions. The webNavigation permission alone delivers
// onErrorOccurred for every host, which is what lets the watched domain list live in
// administrator policy instead of being baked into the manifest.

import { loadConfig, watchConfig, matchesWatched } from './config.js';

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

// After showing the guidance page for a tab and URL, refuse to show it again briefly.
// Pressing Back re-runs the same failing navigation instantly, and without this the tab
// bounces straight forward again. In memory on purpose: a worker restart forgets it,
// which at worst shows one extra guidance page and never misses one.
const recentlyShown = new Map();

function wasJustShown(tabId, url, suppressMs) {
  const key = tabId + '|' + url;
  const seenAt = recentlyShown.get(key);
  const now = Date.now();
  if (seenAt && now - seenAt < suppressMs) return true;
  recentlyShown.set(key, now);
  // Keep the map from growing without bound across a long browser session.
  if (recentlyShown.size > 100) {
    for (const [k, t] of recentlyShown) {
      if (now - t > suppressMs) recentlyShown.delete(k);
    }
  }
  return false;
}

async function fetchWithTimeout(url, timeoutMs, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { cache: 'no-store', signal: controller.signal, ...options });
  } finally {
    clearTimeout(timer);
  }
}

// Content-verified. A captive portal can answer plain HTTP for any address, so a bare
// 200 from 100.100.100.100 proves nothing. The real Quad100 page identifies itself.
async function tailscaleIsUp(config) {
  try {
    const res = await fetchWithTimeout(PROBE_URL, config.probeTimeoutMs);
    if (!res.ok) return false;
    const text = await res.text();
    return text.includes('Tailscale');
  } catch {
    return false;
  }
}

// 'online' means the public internet answered normally. 'captive' means something
// intercepted the request with a redirect, so a portal sign-in is pending. 'offline'
// means nothing answered at all.
async function classifyInternet(config) {
  try {
    const res = await fetchWithTimeout(config.controlUrl, config.probeTimeoutMs, {
      mode: 'no-cors',
      redirect: 'manual',
    });
    return res.type === 'opaqueredirect' ? 'captive' : 'online';
  } catch {
    return 'offline';
  }
}

export async function classify(config) {
  if (await tailscaleIsUp(config)) return 'appDown';
  const internet = await classifyInternet(config);
  if (internet === 'captive') return 'captivePortal';
  if (internet === 'offline') return 'offline';
  return 'tailscaleOff';
}

function showHelpPage(tabId, targetUrl, extraParams) {
  const helpUrl = new URL(chrome.runtime.getURL('src/help.html'));
  helpUrl.searchParams.set('target', targetUrl);
  for (const [key, value] of Object.entries(extraParams)) {
    if (value !== undefined && value !== null) helpUrl.searchParams.set(key, String(value));
  }
  chrome.tabs.update(tabId, { url: helpUrl.toString() });
}

chrome.webNavigation.onErrorOccurred.addListener(async (details) => {
  if (details.tabId < 0 || details.frameId !== 0) return;
  // Ignore prerender and other non-visible navigations.
  if (details.documentLifecycle && details.documentLifecycle !== 'active') return;
  if (!NETWORK_ERRORS.has(details.error)) return;

  const { config } = await loadConfig();
  if (!config.enabled) return;
  if (!matchesWatched(details.url, config.watchedSuffixes)) return;
  if (wasJustShown(details.tabId, details.url, config.suppressMs)) return;

  const state = await classify(config);
  showHelpPage(details.tabId, details.url, { error: details.error, state });
});

// The guidance page asks the worker to probe rather than fetching Quad100 itself, so the
// check works regardless of page-level cross-origin rules.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message) return;
  if (message.type === 'probe-tailscale') {
    loadConfig()
      .then(({ config }) => tailscaleIsUp(config))
      .then(sendResponse);
    return true;
  }
  if (message.type === 'classify') {
    loadConfig()
      .then(({ config }) => classify(config))
      .then(sendResponse);
    return true;
  }
});

watchConfig();
