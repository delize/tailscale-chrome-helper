// Shared configuration for the service worker, the guidance page and the options page.
//
// Values resolve managed > sync > defaults. Managed values come from Chrome's policy
// layer and are what an administrator sets; sync values are what an individual user set
// for themselves on an unmanaged install. The loader also reports which keys arrived
// from policy, so the options page can lock them rather than pretending they are editable.

export const DEFAULTS = {
  enabled: true,
  companyName: '',
  watchedSuffixes: ['ts.net'],
  tailnetName: '',
  emailDomain: '',
  supportUrl: '',
  supportLabel: 'Ask IT',
  tailscaleDownloadUrl: 'https://tailscale.com/download',
  connectHelpUrl: '',
  controlUrl: 'http://connectivitycheck.gstatic.com/generate_204',
  portalUrl: 'http://neverssl.com/',
  logoDataUrl: '',
  probeTimeoutMs: 1500,
  targetTimeoutMs: 4000,
  pollIntervalMs: 2500,
  suppressMs: 8000,
  askItAfterAttempts: 2,
  strings: {},
};

export const STATES = ['tailscaleOff', 'captivePortal', 'offline', 'appDown'];

// Copy used when an administrator has named the organisation.
const BRANDED = {
  tailscaleOff: {
    pill: 'Tailscale is not connected',
    headline: "This app is on {company}'s private network",
    lede: '{host} could not be reached. That usually means Tailscale is not connected on this device.',
    steps: [
      'Tailscale is almost certainly already running on this device. Look for its icon at the top right of your screen (macOS menu bar) or bottom right (Windows system tray). It is faint while disconnected, which makes it easy to miss.',
      'Click it and flip the toggle at the top of the menu, so "Not Connected" becomes "Connected". No icon at all? Press Command Space and type Tailscale (on Windows, search the Start menu), then sign in with your {company} account.',
      'Stay on this page. It checks every few seconds and takes you to the app automatically once you are connected.',
    ],
  },
  captivePortal: {
    pill: 'This network needs sign-in',
    headline: 'Sign in to this network first',
    lede: '{host} could not be reached, and something on this network is intercepting traffic. That usually means a wifi sign-in page is waiting.',
    steps: [
      'Use the button below, or open any ordinary website in a new tab. Either one makes the network show its sign-in page.',
      'Complete the sign-in, including any terms you have to accept.',
      'Come back to this tab. Once the network lets traffic through, Tailscale reconnects and you are taken to the app automatically.',
    ],
  },
  offline: {
    pill: 'No network connection',
    headline: 'This device is offline',
    lede: '{host} could not be reached, and neither is anything else. Tailscale cannot connect without a working network.',
    steps: [
      'Check wifi or your ethernet cable, and reconnect to a network you trust.',
      'Once the network is back, Tailscale usually reconnects on its own. If it does not, click its icon and flip the toggle on.',
      'Stay on this page. It keeps checking and takes you to the app once the connection returns.',
    ],
  },
  appDown: {
    pill: 'Tailscale is connected',
    pillProbing: 'Tailscale is connected, reaching the app',
    pillConnected: 'Connected, taking you to the app',
    headline: 'The app is not responding yet',
    lede: 'Tailscale is connected, but {host} has not answered. The app may still be starting, or it may be down.',
    steps: [
      'Give it a few seconds. This page keeps retrying on its own.',
      'If it stays unavailable, the problem is the app rather than your connection.',
      'Report it using the button below if this carries on.',
    ],
  },
};

// Copy used on an unmanaged install, where naming a company would be a guess.
// Spread BRANDED first so a state added later inherits automatically. Enumerating states
// here by hand meant a new one rendered a literal "undefined" on unconfigured installs.
// Only the sentence that names the company differs, so only that is overridden.
const NEUTRAL = {
  ...BRANDED,
  tailscaleOff: {
    ...BRANDED.tailscaleOff,
    headline: 'This app is on a private network',
    steps: BRANDED.tailscaleOff.steps.map((step) =>
      step.replace('your {company} account', 'your work account')
    ),
  },
};

export function defaultStrings(hasCompany) {
  return hasCompany ? BRANDED : NEUTRAL;
}

// Substitutes {placeholders}. Callers assign the result with textContent, never innerHTML,
// so a policy value can carry markup harmlessly.
export function applyTokens(text, tokens) {
  if (typeof text !== 'string') return '';
  return text.replace(/\{(\w+)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(tokens, key) ? String(tokens[key] ?? '') : match
  );
}

// Policy values are administrator-controlled, but the guidance page is an extension page
// with privileged APIs. Everything below is treated as untrusted input.

const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
// Suffixes so broad that watching them would hijack unrelated browsing.
const TOO_BROAD = new Set(['co.uk', 'com.au', 'co.jp', 'co.nz', 'com.br', 'co.za']);

function cleanSuffixes(value) {
  if (!Array.isArray(value)) return null;
  const out = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const host = entry.trim().toLowerCase().replace(/^\.+/, '').replace(/\.+$/, '');
    if (!HOSTNAME.test(host)) continue;
    if (TOO_BROAD.has(host)) continue;
    if (!out.includes(host)) out.push(host);
  }
  return out.length ? out : null;
}

function cleanLink(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    // A javascript: URL here would be script execution on a privileged page.
    return ['https:', 'mailto:', 'slack:'].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

// A probe target, not a link. It must be fetchable, so the support-link schemes are wrong
// here: a mailto: in this field made every fetch throw, which the caller reads as "offline"
// and pins the whole tenant to the wrong state. Plain http is required rather than merely
// allowed, because a captive portal cannot answer an https probe without a valid
// certificate, so https can only ever report offline.
function cleanProbeUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

// Data URIs only, so the page never makes an outbound request for a logo. The delimiter
// after the subtype may be ';' (a parameter follows) or ',' (the data starts), and
// requiring ';' rejected the unparameterised form most SVG-to-data-URI tools emit.
const MAX_LOGO_BYTES = 256 * 1024;

function cleanImage(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length > MAX_LOGO_BYTES) return null;
  return /^data:image\/(png|jpeg|gif|webp|svg\+xml)[;,]/i.test(trimmed) ? trimmed : null;
}

function cleanInt(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function cleanText(value, maxLen = 400) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLen) : null;
}

function cleanStrings(value) {
  if (!value || typeof value !== 'object') return null;
  const out = {};
  for (const state of STATES) {
    const src = value[state];
    if (!src || typeof src !== 'object') continue;
    const dst = {};
    for (const field of ['pill', 'pillProbing', 'pillConnected', 'headline', 'lede']) {
      const text = cleanText(src[field]);
      if (text !== null) dst[field] = text;
    }
    if (Array.isArray(src.steps)) {
      const steps = src.steps.map((s) => cleanText(s, 600)).filter((s) => s !== null).slice(0, 8);
      if (steps.length) dst.steps = steps;
    }
    if (Object.keys(dst).length) out[state] = dst;
  }
  return Object.keys(out).length ? out : null;
}

export const CLEANERS = {
  enabled: (v) => (typeof v === 'boolean' ? v : null),
  companyName: (v) => cleanText(v, 80),
  watchedSuffixes: cleanSuffixes,
  tailnetName: (v) => cleanText(v, 80),
  emailDomain: (v) => cleanText(v, 120),
  supportUrl: cleanLink,
  supportLabel: (v) => cleanText(v, 40),
  tailscaleDownloadUrl: cleanLink,
  connectHelpUrl: cleanLink,
  controlUrl: cleanProbeUrl,
  portalUrl: cleanProbeUrl,
  logoDataUrl: cleanImage,
  probeTimeoutMs: (v) => cleanInt(v, 200, 30000),
  targetTimeoutMs: (v) => cleanInt(v, 200, 30000),
  pollIntervalMs: (v) => cleanInt(v, 500, 60000),
  // Floor of 1 rather than 0: zero reads as 'do not suppress' and silently reinstates
  // the Back-button bounce the map exists to prevent.
  suppressMs: (v) => cleanInt(v, 1, 120000),
  askItAfterAttempts: (v) => cleanInt(v, 1, 20),
  strings: cleanStrings,
};

function read(area) {
  return new Promise((resolve) => {
    try {
      chrome.storage[area].get(null, (items) => {
        // Reading managed storage throws on installs with no policy at all.
        resolve(chrome.runtime.lastError ? {} : items || {});
      });
    } catch {
      resolve({});
    }
  });
}

let cached = null;

export async function loadConfig({ force = false } = {}) {
  if (cached && !force) return cached;

  const [managed, sync] = await Promise.all([read('managed'), read('sync')]);
  const config = { ...DEFAULTS };
  const managedKeys = new Set();

  const rejected = [];

  for (const key of Object.keys(DEFAULTS)) {
    const clean = CLEANERS[key];
    if (Object.prototype.hasOwnProperty.call(managed, key)) {
      const value = clean(managed[key]);
      // The key is locked because policy set it, whether or not the value was usable.
      // Falling through to sync on a bad value would let an administrator's typo hand
      // control to whatever the user had typed, which is an enterprise control failing
      // open. A rejected value keeps the built-in default instead, and is reported.
      managedKeys.add(key);
      if (value !== null) config[key] = value;
      else rejected.push(key);
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(sync, key)) {
      const value = clean(sync[key]);
      if (value !== null) config[key] = value;
    }
  }

  if (rejected.length) {
    // The only signal an administrator gets. chrome://policy shows the value as applied,
    // because Chrome validated it against the schema and this extension's rules are
    // stricter, so without this the rejection is invisible everywhere.
    console.warn(
      '[tailnet-helper] policy values rejected, defaults used instead:',
      rejected.join(', ')
    );
  }

  cached = { config, managedKeys, rejected };
  return cached;
}

export function invalidateConfig() {
  cached = null;
}

// Policy and user changes apply without a browser restart.
export function watchConfig(onChange) {
  chrome.storage.onChanged.addListener((_changes, area) => {
    if (area !== 'managed' && area !== 'sync') return;
    invalidateConfig();
    if (onChange) loadConfig({ force: true }).then(onChange);
  });
}

export function matchesWatched(rawUrl, suffixes) {
  try {
    // Drop a trailing root dot. cleanSuffixes already strips it from the configured side,
    // and https://host.example./ is a valid FQDN users really do paste, precisely when
    // their DNS search domain is misbehaving, which is when this extension fires.
    const host = new URL(rawUrl).hostname.toLowerCase().replace(/\.$/, '');
    return suffixes.some((suffix) => host === suffix || host.endsWith('.' + suffix));
  } catch {
    return false;
  }
}
