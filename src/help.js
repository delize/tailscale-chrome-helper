// Runs on the guidance page. Renders the configured copy, polls for connectivity, and
// sends the user back to the app they originally asked for as soon as it responds.

import {
  loadConfig,
  defaultStrings,
  applyTokens,
  matchesWatched,
  STATES,
  DISCLOSURE,
} from './config.js';

const params = new URLSearchParams(location.search);

const PILL_TONE = {
  tailscaleOff: 'bad',
  captivePortal: 'warn',
  offline: 'bad',
  appDown: 'wait',
  nameNotFound: 'warn',
  wrongTailnet: 'warn',
};

// States that mean the Tailscale client is up. The illustration teaches how to connect,
// so showing it here would contradict the headline, and its 'Not Connected' menu would
// say the opposite of the pill.
const TAILSCALE_IS_UP = new Set(['appDown', 'nameNotFound']);

const el = (id) => document.getElementById(id);

// Only reachable by hand-editing the URL, since the worker always supplies a validated
// target. It still reaches the headline, so it is shaped and capped like anything else.
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

// Reject, never truncate. Slicing an over-long hostname does not sanitise it, it produces
// a DIFFERENT valid hostname at an offset the attacker chooses: pad a suggestion so the
// admin's own tailnet falls past the limit and it is cut off, leaving the attacker's
// domain as the result. Length is now a rejection, not a repair.
const MAX_HOST_LENGTH = 253; // RFC 1035 limit for a fully qualified name.

function cleanHostParam(value) {
  if (typeof value !== 'string') return '';
  const host = value.trim().toLowerCase().replace(/\.$/, '');
  if (host.length > MAX_HOST_LENGTH) return '';
  if (host.split('.').some((label) => label.length > 63)) return '';
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
    if (matchesWatched(url.href, suffixes)) return url;
    // Only the wrongTailnet page may name a host outside the watched suffixes, because
    // that state exists precisely because the host is not on one. Everywhere else this
    // stays as narrow as the administrator configured it. The comment used to justify the
    // widening by that state while the code applied it unconditionally.
    if (params.get('state') !== 'wrongTailnet') return null;
    return matchesWatched(url.href, ['ts.net']) ? url : null;
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
  // Supplied by the worker for the wrongTailnet state. Validated the same way as the
  // target: it arrives in a URL the user can edit, and it becomes an href.
  const rawSuggestion = cleanHostParam(params.get('suggestion'));
  // Checking the shape of the suggestion was the original mistake. The thing that is true
  // of every legitimate suggestion is that it sits on a watched suffix, because that is
  // how the worker builds it. Anything else is not ours, however well formed it looks.
  const suggestion =
    rawSuggestion && matchesWatched(`https://${rawSuggestion}/`, config.watchedSuffixes)
      ? rawSuggestion
      : '';

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
    suggestion: suggestion || '',
  };

  const defaults = defaultStrings(Boolean(company));
  const copyFor = (name) => ({ ...defaults[name], ...(config.strings?.[name] || {}) });

  function paint(name) {
    const copy = copyFor(name);
    // Computed up front: the steps are rendered before the buttons are wired, and a step
    // must not survive the control it refers to.
    const suggesting = name === 'wrongTailnet' && Boolean(suggestion);
    const continueShown = suggesting && config.showContinueAnyway;
    el('pill').dataset.state = PILL_TONE[name] || 'bad';
    el('pillText').textContent = applyTokens(copy.pill, tokens);
    renderTemplate(el('headline'), copy.headline, tokens);
    renderTemplate(el('lede'), copy.lede, tokens);

    const steps = el('steps');
    steps.textContent = '';
    for (const rawStep of copy.steps || []) {
      // A step marked {continueOnly} is about the Continue anyway button, so it goes when
      // the button does. Pointing at a control that is not there is how the support link
      // used to behave, and it reads as a bug.
      // A step may be marked as belonging to a control. If that control is not on the page,
      // the step goes with it, so the copy never points at something that is not there.
      // Scoped to wrongTailnet: an admin who pastes this text into another state would
      // otherwise silently lose a step. replaceAll, because a duplicated marker used to
      // leak the literal text onto the page.
      if (name === 'wrongTailnet') {
        if (rawStep.includes('{continueOnly}') && !continueShown) continue;
        if (rawStep.includes('{suggestionOnly}') && !suggesting) continue;
      }
      const step = rawStep.replaceAll('{continueOnly}', '').replaceAll('{suggestionOnly}', '');
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
    const connected = TAILSCALE_IS_UP.has(name);
    // On the illustration rather than the menu, so the demo also drives the menu bar icon.
    const illustration = el('illustration');
    illustration.classList.toggle('connected', connected);
    illustration.classList.toggle('demo', !connected);
    el('menuToggle').classList.toggle('on', connected);

    // When Tailscale is already up, telling someone where to find its icon is noise.
    // The problem is the app, and nothing in the illustration helps them.
    el('illustration').hidden = connected;
    el('caption').hidden = connected;
    // With no illustration there is nothing to put beside the steps, so drop to one column
    // rather than leaving an empty half.
    el('columns').classList.toggle('single', connected);

    // Offering an installer to someone whose client is plainly running is worse than
    // useless, so the download route is tied to the one state that can warrant it.
    // appDown means Tailscale is up and the app is not answering, which is the one state
    // the user cannot fix themselves. Waiting for a second failure to offer the support
    // route just delays the only useful action, and the copy for that state points at the
    // button directly.
    const escalate = attemptsReached || name === 'appDown';
    setLink(el('askIt'), null, escalate ? config.supportUrl : '', config.supportLabel);
    // A button that appears out of nowhere reads as a glitch. Say why it is there.
    const askItNote = el('askItNote');
    // wrongTailnet excluded: nothing has failed there, the user typed an address on
    // another tailnet, which the page's own copy calls normal.
    const earned =
      config.supportUrl && attemptsReached && name !== 'appDown' && name !== 'wrongTailnet';
    // supportLabel is a button label, often imperative ("Contact the Service Desk"), so it
    // cannot be used as a noun. Count is spelled to avoid "1 times".
    askItNote.textContent = earned
      ? `This has not worked ${attempts === 1 ? 'once' : `${attempts} times`}, so it may be worth asking for help.`
      : '';
    askItNote.hidden = !earned;

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

    // On wrongTailnet the corrected address is the answer, so it leads. Continue anyway
    // sits beside it, because a suggestion the user cannot decline is an interception.
    setLink(
      el('goSuggested'),
      null,
      suggesting ? `https://${suggestion}/` : '',
      suggesting ? suggestion : ''
    );
    el('continueAnyway').hidden = !continueShown;
    // Nothing on this state is about the connection, so the illustration and the retry
    // would both be misleading.
    if (name === 'wrongTailnet') {
      el('illustration').hidden = true;
      el('caption').hidden = true;
      el('columns').classList.add('single');
      // Retry stays when there is no suggestion to offer, otherwise the page is two
      // instructions pointing at two buttons that do not exist, with nothing clickable.
      el('retry').hidden = suggesting;
      setLink(el('download'), null, '', '');
    } else {
      el('retry').hidden = false;
    }
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
  let attemptsReached = attempts >= config.askItAfterAttempts;

  paint(state);
  if (!resolved) {
    el('pill').dataset.state = 'wait';
    el('pillText').textContent = config.checkingLabel;
  }

  // Disclosure sits in the interface, not only in docs/privacy.md, because storing the
  // hostnames of failed navigations is handling web browsing activity even though it never
  // leaves the device. Rendered from a constant rather than config, so policy cannot blank
  // it, and shown only while the setting that stores anything is actually on.
  const disclosure = el('disclosure');
  disclosure.textContent = config.recordUnwatchedHosts ? DISCLOSURE.records : '';
  disclosure.hidden = !config.recordUnwatchedHosts;

  const detailBits = [];
  if (tokens.error) detailBits.push(tokens.error);
  if (target) detailBits.push(target.href);
  el('details').textContent = detailBits.length ? 'Details: ' + detailBits.join(' · ') : '';

  el('continueAnyway').addEventListener('click', async (event) => {
    event.preventDefault();
    // Tell the worker to stop interposing for this host, then go where the user asked.
    try {
      await chrome.runtime.sendMessage({
        type: 'dismiss-suggestion',
        host: target ? target.hostname : '',
      });
    } catch {
      // Worker asleep. Navigating anyway is still the user's stated intent.
    }
    redirecting = true;
    if (target) location.replace(target.href);
  });

  const retry = el('retry');
  retry.addEventListener('click', async () => {
    if (!target) {
      location.reload();
      return;
    }
    // Check first, navigate only on success. Navigating and hoping the worker catches the
    // failure and brings the user back is a gamble that loses: the re-show guard cannot
    // tell a deliberate retry from a Back-button bounce, so a failed retry could strand
    // the user on Chrome's error page with no way back. Probing from here cannot strand
    // anyone, because a failure never leaves the page.
    const originalLabel = retry.textContent;
    gaveUp = false;
    retry.disabled = true;
    retry.textContent = config.checkingLabel;
    el('pill').dataset.state = 'wait';
    el('pillText').textContent = config.checkingLabel;

    try {
      const now = await currentState();
      if (now) {
        state = now;
        resolved = true;
      }

      if (await appResponds()) {
        redirecting = true;
        el('pill').dataset.state = 'ok';
        const copy = copyFor('appDown');
        el('pillText').textContent = applyTokens(copy.pillConnected || copy.pill, tokens);
        try {
          sessionStorage.removeItem(attemptsKey);
        } catch {
          // Nothing to clean up if storage was unavailable.
        }
        // Clear the worker's guard so that if this navigation fails after all, the
        // guidance page still comes back rather than Chrome's error page.
        try {
          await chrome.runtime.sendMessage({ type: 'retrying', url: target.href });
        } catch {
          // Worker asleep. The navigation is still worth attempting.
        }
        location.replace(target.href);
        return;
      }

      // Still unreachable. Count it, so repeated manual retries surface the support route
      // the same way repeated visits do, and repaint in case the state changed.
      attempts += 1;
      try {
        sessionStorage.setItem(attemptsKey, String(attempts));
      } catch {
        // The counter is a nicety, not a need.
      }
      attemptsReached = attempts >= config.askItAfterAttempts;
      paint(state);
    } finally {
      if (!redirecting) {
        retry.disabled = false;
        retry.textContent = originalLabel;
      }
    }
  });
  if (!target) retry.disabled = true;

  // Ask the worker to classify. It holds the host permission for the Quad100 probe and
  // can read the response body, which this page cannot.
  async function currentState() {
    try {
      // Without the error the worker cannot tell a name that does not resolve from an app
      // that does not answer, so nameNotFound was unreachable. This was omitted once
      // already by an edit that silently did not apply; the test asserts it is sent.
      const result = await chrome.runtime.sendMessage({
        type: 'classify',
        error: tokens.error,
      });
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
  let gaveUp = false;

  async function tick() {
    if (ticking || redirecting || gaveUp) return;
    // Terminal. The worker asserts this state from the URL and cannot re-derive it, so a
    // poll would answer with an ordinary connectivity verdict, repaint the page, hide both
    // buttons, and then navigate the user to the foreign host with no click. Nothing here
    // is waiting on connectivity anyway: it is a naming problem.
    if (state === 'wrongTailnet') return;
    // Nobody is looking at a background tab, and a probe every few seconds there is pure
    // waste that also keeps the worker awake.
    if (document.hidden) return;
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
        // Long enough to read. At 600ms the handoff was invisible: the page appeared to
        // vanish on its own, which is unsettling when you did not ask for it.
        setTimeout(() => location.replace(target.href), 1500);
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

  if (state === 'wrongTailnet') return;

  tick();
  const poller = setInterval(tick, config.pollIntervalMs);

  // Stop checking eventually. Retrying forever kept the service worker resident and left
  // the page claiming the app was 'not responding yet', which promises a success it has no
  // reason to expect. Try again still works, so giving up is not a dead end.
  setTimeout(() => {
    if (redirecting) return;
    clearInterval(poller);
    gaveUp = true;
    const copy = copyFor(state);
    el('pill').dataset.state = 'bad';
    el('pillText').textContent = applyTokens(copy.pillGaveUp || copy.pill, tokens);
    // At this point it is worth reporting whatever the attempt count says.
    setLink(el('askIt'), null, config.supportUrl, config.supportLabel);
  }, config.pollTimeoutMs);
}

main();
