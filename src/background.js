// Watches navigations that fail in a way that looks like "Tailscale is off" and replaces
// Chrome's error page with guidance that explains how to connect.
//
// Detection needs no host permissions. The webNavigation permission alone delivers
// onErrorOccurred for every host, which is what lets the watched domain list live in
// administrator policy instead of being baked into the manifest.

import { loadConfig, watchConfig, matchesWatched } from './config.js';
import { createSuppressor } from './suppression.js';
import { recordUnwatchedHit, clearUnwatchedHits, isTailnetHost } from './hostlog.js';

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
// Does anything at all answer at this address? no-cors, so it needs no host permission:
// the question is only whether something responded, and an opaque response answers it.
// Used as a second opinion, never as the primary signal, because it cannot tell an ordinary
// reply from a captive portal's.
async function somethingAnswers(url, timeoutMs) {
  if (!url) return false;
  let done = () => {};
  try {
    const probe = await fetchWithTimeout(url, timeoutMs, { mode: 'no-cors' });
    done = probe.done;
    return true;
  } catch {
    return false;
  } finally {
    done();
  }
}

async function classifyInternet(config) {
  // A reliable negative and nothing more. navigator.onLine === false means there is no
  // route off this machine, which is worth trusting and worth short-circuiting two probe
  // timeouts for. onLine === true means almost nothing, so it can rule offline in but
  // never out, and the probes below still have to run.
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'offline';

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
    // One failed request to one host is not evidence of no network. A firewall or a DNS
    // filter that blocks only this endpoint produced exactly this failure, and the user was
    // then told their device was offline and sent to check a cable that was fine. Their
    // real state is tailscaleOff, which is what a second opinion now recovers.
    if (await somethingAnswers(config.controlUrlFallback, config.probeTimeoutMs)) {
      // Something answered elsewhere, so there is a network. Whether this one is a portal
      // cannot be told from an opaque response, and claiming a portal that is not there
      // sends the user hunting for a sign-in page. Online is the honest reading.
      return 'online';
    }
    return 'offline';
  } finally {
    done();
  }
}

// Chrome's own error says which kind of failure this was, and once Tailscale is up the
// distinction matters: a name that does not resolve is a different problem from an app
// that does not answer, and the fixes have nothing in common.
const NAME_ERRORS = new Set([
  'net::ERR_NAME_NOT_RESOLVED',
  'net::ERR_NAME_RESOLUTION_FAILED',
  'net::ERR_DNS_TIMED_OUT',
]);

// A tailnet host that is not ours. Carry the device label over to the configured tailnet
// and offer that instead. Returns null rather than guessing whenever the guess would be a
// guess: already ours, no device label, more than one tailnet, or a broad ts.net config.
export function suggestOnTailnet(rawUrl, suffixes) {
  let host;
  try {
    host = new URL(rawUrl).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return null;
  }
  if (!host.endsWith('.ts.net')) return null;
  if (suffixes.some((suffix) => host === suffix || host.endsWith('.' + suffix))) return null;
  const tailnets = suffixes.filter((x) => x.endsWith('.ts.net') && x.split('.').length === 3);
  if (tailnets.length !== 1) return null;
  const labels = host.slice(0, -'.ts.net'.length).split('.');
  if (labels.length < 2) return null;
  return labels.slice(0, -1).join('.') + '.' + tailnets[0];
}

// Hosts the user chose to continue to anyway. chrome.storage.session, not a module-level
// Set: MV3 kills an idle worker after about thirty seconds, so in-memory state meant the
// user was re-interposed on a host they had explicitly said they meant, often within a
// minute. Session storage is memory-backed and cleared on browser restart, which is the
// lifetime the docs promise.
const DISMISSED_KEY = 'dismissedHosts';

async function isDismissed(host) {
  try {
    const items = await chrome.storage.session.get(DISMISSED_KEY);
    return Array.isArray(items?.[DISMISSED_KEY]) && items[DISMISSED_KEY].includes(host);
  } catch {
    return false;
  }
}

async function rememberDismissal(host) {
  try {
    const items = await chrome.storage.session.get(DISMISSED_KEY);
    const list = Array.isArray(items?.[DISMISSED_KEY]) ? items[DISMISSED_KEY] : [];
    if (list.includes(host)) return;
    // Bounded, so a crafted or looping caller cannot grow it without limit.
    const next = [...list, host].slice(-100);
    await chrome.storage.session.set({ [DISMISSED_KEY]: next });
  } catch {
    // A dismissal that cannot be stored is a re-prompt, not a failure worth surfacing.
  }
}

export async function classify(config, error) {
  if (await tailscaleIsUp(config)) {
    return NAME_ERRORS.has(error) ? 'nameNotFound' : 'appDown';
  }
  const internet = await classifyInternet(config);
  if (internet === 'captive') return 'captivePortal';
  if (internet === 'offline') return 'offline';
  return 'tailscaleOff';
}

// Classification takes up to two probe timeouts, so this runs seconds after the navigation
// failed. In that window the user may have typed a different URL, hit Back, or closed the
// tab, so the tab is re-checked before it is taken over and the update is never allowed to
// reject into nothing.
// The last top-level navigation seen per tab.
//
// This exists because the obvious check does not work. Tab.url and Tab.pendingUrl are, per
// Chrome's docs, "only present if the extension has the 'tabs' permission or has host
// permissions for the page", and this extension holds neither for a tailnet host. So
// reading them returned undefined, the moved-on check could never fire, and the comment
// claiming the tab was re-checked was describing something that had never run.
//
// webNavigation reports every navigation with no host permission at all, which is the same
// property the rest of this worker is built on, so the information is available. It just
// has to be remembered rather than asked for.
//
// Module state is right here, unlike the dismissal set. This is only consulted a few
// storage reads after the navigation failed, well inside the worker's lifetime, and an
// empty map after a restart fails open exactly as the old code did.
const lastNavigation = new Map();

chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId === 0) lastNavigation.set(details.tabId, details.url);
});

chrome.tabs.onRemoved.addListener((tabId) => lastNavigation.delete(tabId));

async function showHelpPage(tabId, targetUrl, extraParams) {
  // The user typed something else while we were reading config. Leave them alone.
  const current = lastNavigation.get(tabId);
  if (current !== undefined && current !== targetUrl) return;

  try {
    await chrome.tabs.get(tabId);
  } catch {
    return; // Tab closed while we were probing.
  }

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

  const watched = matchesWatched(details.url, config.watchedSuffixes);
  let suggestion = null;
  if (!watched) {
    // One of two settings that act outside the configured domains, the other being the
    // counter below. Opt-in, and silent for anyone who has not turned it on.
    if (!config.suggestCorrectTailnet) return;
    suggestion = suggestOnTailnet(details.url, config.watchedSuffixes);
    if (!suggestion) return;
    try {
      if (await isDismissed(new URL(details.url).hostname.toLowerCase())) return;
    } catch {
      return;
    }
  }

  if (suppressor.shouldSuppress(details.tabId, details.url, config.suppressMs)) return;

  // After the suppressor, so a Back-button bounce is not counted as a second attempt. The
  // number is a fleet signal an administrator acts on, so inflating it matters. Still
  // independent of suggestCorrectTailnet: this runs whether or not that is on.
  if (!watched && config.recordUnwatchedHosts) await recordUnwatchedHit(details.url);

  if (suggestion) {
    // No probing. The correction is worth offering either way, and the copy does not
    // claim the address is unreachable: a shared device keeps its original tailnet name
    // and is reachable across tailnets once Tailscale is connected.
    await showHelpPage(details.tabId, details.url, {
      error: details.error,
      state: 'wrongTailnet',
      suggestion,
    });
    return;
  }

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
  if (message.type === 'dismiss-suggestion') {
    // The user said they meant that address. Stop interposing for it this session.
    // Validated like any other input: only a real tailnet host can be dismissed, so this
    // cannot be used to suppress guidance for arbitrary domains.
    const host = typeof message.host === 'string' ? message.host.toLowerCase() : '';
    if (_sender.id === chrome.runtime.id && isTailnetHost(host)) {
      rememberDismissal(host).then(() => sendResponse(true), () => sendResponse(false));
      return true;
    }
    sendResponse(false);
    return true;
  }
  if (message.type === 'classify') {
    loadConfig()
      .then(({ config }) => classify(config, message.error))
      .then(sendResponse, () => sendResponse(null));
    return true;
  }
});

// Disabling a setting that records where someone tried to go should delete what it
// recorded, not merely stop appending to it.
let recordingWasOn = null;
watchConfig(({ config }) => {
  if (recordingWasOn === true && config.recordUnwatchedHosts === false) clearUnwatchedHits();
  recordingWasOn = config.recordUnwatchedHosts;
});
loadConfig().then(({ config }) => {
  recordingWasOn = config.recordUnwatchedHosts;
});
