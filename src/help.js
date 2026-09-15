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

function setLink(anchor, wrap, href, label) {
  if (!href) {
    (wrap || anchor).hidden = true;
    return false;
  }
  anchor.href = href;
  if (label) anchor.textContent = label;
  (wrap || anchor).hidden = false;
  return true;
}

async function main() {
  const { config } = await loadConfig();
  const target = parseTarget(config.watchedSuffixes);

  let state = params.get('state');
  if (!STATES.includes(state)) state = 'tailscaleOff';

  const company = config.companyName;
  const tokens = {
    company: company || 'your organisation',
    host: target ? target.hostname : params.get('host') || 'The app',
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
      // "toggle" is the one word users hunt for, so it stays emphasised.
      const text = applyTokens(step, tokens);
      const parts = text.split(/\b(toggle)\b/);
      parts.forEach((part, i) => {
        if (i % 2 === 1) {
          const strong = document.createElement('strong');
          strong.textContent = part;
          li.appendChild(strong);
        } else if (part) {
          li.appendChild(document.createTextNode(part));
        }
      });
      steps.appendChild(li);
    }

    // The illustration shows a connected client once we know Tailscale itself is up.
    const connected = name === 'appDown';
    el('menuToggle').classList.toggle('on', connected);
    el('menuState').textContent = connected ? 'Connected' : 'Not Connected';

    // When Tailscale is already up, telling someone where to find its icon is noise.
    // The problem is the app, and nothing in the illustration helps them.
    el('illustration').hidden = connected;
    el('caption').hidden = connected;

    // Offering an installer to someone whose client is plainly running is worse than
    // useless, so the download route is tied to the one state that can warrant it.
    const canInstall = name === 'tailscaleOff' && attemptsReached;
    setLink(el('download'), null, canInstall ? config.tailscaleDownloadUrl : '', 'Install Tailscale');
  }

  // Illustration identity, from config rather than a baked-in screenshot.
  el('menuEmail').textContent = tokens.exampleEmail;
  el('menuTailnet').textContent = tokens.tailnetName;
  el('menuManaged').textContent = company ? `Managed by ${company}` : 'Managed by your organisation';

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

  const detailBits = [];
  if (tokens.error) detailBits.push(tokens.error);
  if (target) detailBits.push(target.href);
  el('details').textContent = detailBits.length ? 'Details: ' + detailBits.join(' · ') : '';

  const retry = el('retry');
  retry.addEventListener('click', () => {
    if (target) location.replace(target.href);
    else location.reload();
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
  // fetches no-cors and treats "did not throw" as reachable. An opaque response also
  // covers the SSO bounce, where a redirect to the identity provider proves the app is up.
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
      if (now && now !== state) {
        state = now;
        paint(state);
      }
      if (state !== 'appDown') return;
      if (!target) return;

      el('pillText').textContent = 'Tailscale is connected, reaching the app';
      if (await appResponds()) {
        redirecting = true;
        el('pill').dataset.state = 'ok';
        el('pillText').textContent = 'Connected, taking you to the app';
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

  tick();
  setInterval(tick, config.pollIntervalMs);
}

main();
