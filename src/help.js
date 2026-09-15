// Runs on the guidance page. Renders the configured copy, polls for connectivity, and
// sends the user back to the app they originally asked for as soon as it responds.

import { loadConfig, defaultStrings, applyTokens, matchesWatched, STATES } from './config.js';

const params = new URLSearchParams(location.search);

const PILL_TONE = {
  tailscaleOff: 'bad',
  captivePortal: 'warn',
  offline: 'bad',
  appDown: 'wait',
};

const el = (id) => document.getElementById(id);

// Only reachable by hand-editing the URL, since the worker always supplies a validated
// target. It still reaches the headline, so it is shaped and capped like anything else.
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

function cleanHostParam(value) {
  if (typeof value !== 'string') return '';
  const host = value.trim().toLowerCase().slice(0, 120).replace(/\.$/, '');
  return HOSTNAME.test(host) ? host : '';
}

// Only navigate back to URLs on a watched tailnet. The target arrives as a query
// parameter in a URL the user can edit, so it is validated rather than trusted.
function parseTarget(suffixes) {
  const raw = params.get('target');
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return matchesWatched(url.href, suffixes) ? url : null;
  } catch {
    return null;
  }
}

// Renders a template into a container, substituting {tokens}. Text goes in as text nodes
// and the host token becomes a <code> element, so a policy value carrying markup is
// rendered as the literal characters rather than parsed.
function renderTemplate(container, template, tokens) {
  container.textContent = '';
  const parts = String(template).split(/(\{\w+\})/g);
  for (const part of parts) {
    const match = /^\{(\w+)\}$/.exec(part);
    if (!match) {
      if (part) container.appendChild(document.createTextNode(part));
      continue;
    }
    const key = match[1];
    if (!Object.prototype.hasOwnProperty.call(tokens, key)) {
      container.appendChild(document.createTextNode(part));
      continue;
    }
    const value = String(tokens[key] ?? '');
    if (key === 'host') {
      const code = document.createElement('code');
      code.textContent = value;
      container.appendChild(code);
    } else {
      container.appendChild(document.createTextNode(value));
    }
  }
}

// Every link here opens in a new tab. The page tells the user to stay on it, and it
// takes them to the app by itself once the connection returns, so navigating away is
// the one thing that breaks the recovery it promises. mailto: is exempt because a new
// tab for a mail handler just leaves a blank one behind.
function setLink(anchor, wrap, href, label) {
  if (!href) {
    (wrap || anchor).hidden = true;
    return false;
  }
  anchor.href = href;
  if (label) anchor.textContent = label;
  if (href.startsWith('mailto:')) {
    anchor.removeAttribute('target');
    anchor.rel = 'noreferrer';
  } else {
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
  }
  (wrap || anchor).hidden = false;
  return true;
}

async function main() {
  const { config } = await loadConfig();
  const target = parseTarget(config.watchedSuffixes);

  // The worker no longer classifies before showing this page, because its probes take
  // seconds when Tailscale is off. Without a state we render the common case immediately
  // and correct it as soon as the check comes back, which is the difference between the
  // page appearing at once and appearing after a two second stare at Chrome's error page.
  const declared = params.get('state');
  let state = STATES.includes(declared) ? declared : 'tailscaleOff';
  let resolved = STATES.includes(declared);

  const company = config.companyName;
  const tokens = {
    company: company || 'your organisation',
    host: target ? target.hostname : cleanHostParam(params.get('host')) || 'The app',
    error: params.get('error') || '',
    tailnetName: config.tailnetName || company || 'your tailnet',
    exampleEmail: config.emailDomain ? `you@${config.emailDomain}` : 'you@example.com',
  };

  const defaults = defaultStrings(Boolean(company));
  const copyFor = (name) => ({ ...defaults[name], ...(config.strings?.[name] || {}) });

  function paint(name) {
    const copy = copyFor(name);
    el('pill').dataset.state = PILL_TONE[name] || 'bad';
    el('pillText').textContent = applyTokens(copy.pill, tokens);
    renderTemplate(el('headline'), copy.headline, tokens);
    renderTemplate(el('lede'), copy.lede, tokens);

    const steps = el('steps');
    steps.textContent = '';
    for (const step of copy.steps || []) {
      const li = document.createElement('li');
      const text = applyTokens(step, tokens);
      // Two things get lifted out of the prose: "toggle", the one word users scan for,
      // and {openApp}, which becomes a real link so the page can launch the client rather
      // than describe where to find it.
      for (const part of text.split(/(\{openApp\}|\btoggle\b)/)) {
        if (part === 'toggle') {
          const strong = document.createElement('strong');
          strong.textContent = part;
          li.appendChild(strong);
        } else if (part === '{openApp}') {
          // Drops out entirely when unset, which is the default, leaving the sentence
          // before it to end the step cleanly.
          if (!config.openAppUrl) continue;
          const a = document.createElement('a');
          a.className = 'inline-action';
          a.href = config.openAppUrl;
          a.textContent = config.openAppLabel;
          // Chrome names the requesting origin in its prompt, and for an extension that is
          // the raw ID, which looks alarming without warning.
          a.title = 'Chrome will ask permission first and will show this extension\u2019s ID';
          li.appendChild(a);
        } else if (part) {
          li.appendChild(document.createTextNode(part));
        }
      }
      steps.appendChild(li);
    }

    // The illustration shows a connected client once we know Tailscale itself is up.
    // Otherwise it demonstrates the off-to-on gesture on a loop, because the toggle is
    // the single thing the user has to find and the page should not make them guess.
    const connected = name === 'appDown';
    // On the illustration rather than the menu, so the demo also drives the menu bar icon.
    const illustration = el('illustration');
    illustration.classList.toggle('connected', connected);
    illustration.classList.toggle('demo', !connected);
    el('menuToggle').classList.toggle('on', connected);

    // When Tailscale is already up, telling someone where to find its icon is noise.
    // The problem is the app, and nothing in the illustration helps them.
    el('illustration').hidden = connected;
    el('caption').hidden = connected;

    // Offering an installer to someone whose client is plainly running is worse than
    // useless, so the download route is tied to the one state that can warrant it.
    const canInstall = config.showInstallLink && name === 'tailscaleOff' && attemptsReached;
    setLink(el('download'), null, canInstall ? config.tailscaleDownloadUrl : '', 'Install Tailscale');

    // Loading any plaintext page is what forces a captive portal to show its sign-in
    // screen, so on that state the page offers one rather than describing the trick.
    setLink(
      el('portal'),
      null,
      name === 'captivePortal' ? config.portalUrl : '',
      'Open the sign-in page'
    );
  }

  // Illustration identity, from config rather than a baked-in screenshot.
  el('menuEmail').textContent = tokens.exampleEmail;
  // The client shows the account initial, so the illustration does too.
  el('menuAvatar').textContent = (company || tokens.exampleEmail).trim().charAt(0) || '?';
  el('menuTailnet').textContent = tokens.tailnetName;
  el('menuManaged').textContent = company ? `Managed by ${company}` : 'Managed by your organisation';

  // Accent is applied as a custom property so one value drives the button, links and
  // focus ring without any of them being restyled individually.
  if (config.accentColor) {
    document.documentElement.style.setProperty('--accent', config.accentColor);
  }

  if (config.bannerDataUrl) {
    const banner = el('banner');
    banner.src = config.bannerDataUrl;
    banner.alt = '';
    banner.hidden = false;
  }

  if (config.logoDataUrl) {
    const logo = el('logo');
    logo.src = config.logoDataUrl;
    logo.alt = company ? `${company} logo` : '';
    logo.hidden = false;
  }

  setLink(el('runbook'), el('runbookWrap'), config.connectHelpUrl);

  // Count visits per target in this tab so repeat failures surface the escalation route.
  // sessionStorage survives the round trip back to the app and returning here, because
  // this page keeps the same extension origin.
  const attemptsKey = 'attempts:' + (target ? target.href : 'unknown');
  let attempts = 0;
  try {
    attempts = Number(sessionStorage.getItem(attemptsKey) || '0') + 1;
    sessionStorage.setItem(attemptsKey, String(attempts));
  } catch {
    // sessionStorage can be unavailable. The hint is a nicety, not a need.
  }
  const attemptsReached = attempts >= config.askItAfterAttempts;
  if (attemptsReached) setLink(el('askIt'), null, config.supportUrl, config.supportLabel);

  paint(state);
  if (!resolved) {
    el('pill').dataset.state = 'wait';
    el('pillText').textContent = config.checkingLabel;
  }

  const detailBits = [];
  if (tokens.error) detailBits.push(tokens.error);
  if (target) detailBits.push(target.href);
  el('details').textContent = detailBits.length ? 'Details: ' + detailBits.join(' · ') : '';

  const retry = el('retry');
  retry.addEventListener('click', async () => {
    if (!target) {
      location.reload();
      return;
    }
    // Drop the worker's re-show guard for this tab and URL first. Without this a retry
    // that fails again is treated as a Back-button bounce and swallowed, leaving the user
    // stranded on Chrome's error page. Awaited so the worker has acted before we navigate,
    // and failure is not fatal: the worst case is the old behaviour.
    retry.disabled = true;
    try {
      await chrome.runtime.sendMessage({ type: 'retrying', url: target.href });
    } catch {
      // Worker asleep or unreachable. Navigate anyway.
    }
    location.replace(target.href);
  });
  if (!target) retry.disabled = true;

  // Ask the worker to classify. It holds the host permission for the Quad100 probe and
  // can read the response body, which this page cannot.
  async function currentState() {
    try {
      const result = await chrome.runtime.sendMessage({ type: 'classify' });
      if (STATES.includes(result)) return result;
    } catch {
      // Worker asleep or unreachable, fall through.
    }
    return null;
  }

  // Without a host permission for the tailnet host the status code is unreadable, so this
  // fetches no-cors and treats "did not throw" as reachable.
  //
  // redirect: 'follow' is deliberate. A tailnet app commonly answers by bouncing to an
  // identity provider on a completely different domain (Okta, Entra, Ping). That hop is
  // proof the app is up, not a failure, so the redirect chain is followed wherever it
  // leads and the opaque result is treated as success. Only the original ts.net URL is
  // ever navigated to; where it forwards the user afterwards is the browser's business,
  // not this extension's.
  async function appResponds() {
    if (!target) return false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.targetTimeoutMs);
    try {
      await fetch(target.href, {
        mode: 'no-cors',
        cache: 'no-store',
        redirect: 'follow',
        signal: controller.signal,
      });
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  let ticking = false;
  let redirecting = false;

  async function tick() {
    if (ticking || redirecting) return;
    ticking = true;
    try {
      const now = await currentState();
      if (now && (now !== state || !resolved)) {
        state = now;
        resolved = true;
        paint(state);
      } else if (!now && !resolved) {
        // The worker did not answer. Showing the most likely guidance beats leaving the
        // user on a status that never resolves, so stop waiting and commit to it.
        resolved = true;
        paint(state);
      }
      if (state !== 'appDown') return;
      if (!target) return;

      const copy = copyFor('appDown');
      el('pillText').textContent = applyTokens(copy.pillProbing || copy.pill, tokens);
      if (await appResponds()) {
        redirecting = true;
        el('pill').dataset.state = 'ok';
        el('pillText').textContent = applyTokens(copy.pillConnected || copy.pill, tokens);
        try {
          sessionStorage.removeItem(attemptsKey);
        } catch {
          // Nothing to clean up if storage was unavailable.
        }
        setTimeout(() => location.replace(target.href), 600);
      }
    } finally {
      ticking = false;
    }
  }

  // Preview mode renders the configured page and stops. An administrator checking their
  // settings should not have the page probe the network or navigate away underneath them.
  if (params.get('preview')) {
    el('details').textContent = 'Preview. This page is not checking your connection.';
    return;
  }

  tick();
  setInterval(tick, config.pollIntervalMs);
}

main();
