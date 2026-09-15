// Settings for an unmanaged install. Anything an administrator has set through policy
// wins and is shown locked, which is the whole point of enrolling an extension.

import { loadConfig, invalidateConfig, STATES, defaultStrings } from './config.js';

const BOOL_FIELDS = ['enabled', 'showInstallLink'];

const TEXT_FIELDS = [
  'companyName',
  'tailnetName',
  'emailDomain',
  'supportUrl',
  'connectHelpUrl',
];

const el = (id) => document.getElementById(id);

function lock(input, isManaged) {
  if (!isManaged) return;
  input.disabled = true;
  const label = input.closest('label');
  if (!label || label.querySelector('.locked')) return;
  const tag = document.createElement('span');
  tag.className = 'locked';
  tag.textContent = 'Set by your administrator';
  // On the checkbox the label text sits in a span, elsewhere it is the label itself.
  (label.querySelector('span') || label).prepend(tag);
}

// One option per state, labelled with that state's own headline so the list cannot drift
// from the states that actually exist.
function fillPreviewStates(config) {
  const select = el('previewState');
  if (select.options.length) return;
  const copy = defaultStrings(Boolean(config.companyName));
  for (const state of STATES) {
    const option = document.createElement('option');
    option.value = state;
    option.textContent = (copy[state]?.headline || state).replace('{company}', 'your company');
    select.appendChild(option);
  }
}

async function render() {
  const { config, managedKeys, rejected } = await loadConfig({ force: true });

  for (const key of BOOL_FIELDS) {
    el(key).checked = config[key];
    lock(el(key), managedKeys.has(key));
  }

  for (const key of TEXT_FIELDS) {
    el(key).value = config[key] || '';
    lock(el(key), managedKeys.has(key));
  }

  el('watchedSuffixes').value = (config.watchedSuffixes || []).join('\n');
  lock(el('watchedSuffixes'), managedKeys.has('watchedSuffixes'));

  fillPreviewStates(config);

  if (managedKeys.size) el('managedNote').hidden = false;

  // chrome://policy shows a value as applied even when this extension rejected it, because
  // Chrome only validates it against the schema. This is the one place an admin finds out.
  if (rejected?.length) {
    const note = el('rejectedNote');
    note.textContent =
      'Your administrator set these, but the values could not be used, so defaults apply: ' +
      rejected.join(', ');
    note.hidden = false;
  }
}

el('form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const status = el('status');
  const { managedKeys } = await loadConfig();

  const patch = {};
  const remove = [];

  for (const key of BOOL_FIELDS) {
    if (!managedKeys.has(key)) patch[key] = el(key).checked;
  }

  for (const key of TEXT_FIELDS) {
    if (managedKeys.has(key)) continue;
    const value = el(key).value.trim();
    // Clearing a field should fall back to the default rather than store an empty string.
    if (value) patch[key] = value;
    else remove.push(key);
  }

  if (!managedKeys.has('watchedSuffixes')) {
    const list = el('watchedSuffixes')
      .value.split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (list.length) patch.watchedSuffixes = list;
    else remove.push('watchedSuffixes');
  }

  // chrome.storage reports failure through lastError rather than by throwing, so without
  // this a quota or sync failure produced a cheerful "Saved" over a form that had silently
  // reverted to its old values.
  const write = (fn, arg) =>
    new Promise((resolve, reject) =>
      fn(arg, () => (chrome.runtime.lastError ? reject(chrome.runtime.lastError) : resolve()))
    );

  try {
    await write(chrome.storage.sync.set.bind(chrome.storage.sync), patch);
    if (remove.length) {
      await write(chrome.storage.sync.remove.bind(chrome.storage.sync), remove);
    }
  } catch (error) {
    status.textContent = `Could not save: ${error.message || 'storage error'}`;
    return;
  }

  invalidateConfig();
  await // Opens the real guidance page with the settings as they stand, so an administrator can
// see what a user will see without having to disconnect anything.
el('previewBtn').addEventListener('click', async () => {
  const { config } = await loadConfig({ force: true });
  const state = el('previewState').value;
  const hint = el('previewHint');

  if (!chrome?.runtime?.getURL) {
    hint.textContent =
      'Preview needs the installed extension. Open this page from chrome://extensions rather than over http.';
    return;
  }

  // A representative host on the first watched domain, so the page shows a realistic
  // address without needing one to actually exist.
  const suffix = config.watchedSuffixes[0];
  const url = new URL(chrome.runtime.getURL('src/help.html'));
  url.searchParams.set('target', `https://app.${suffix}/`);
  url.searchParams.set('error', 'net::ERR_NAME_NOT_RESOLVED');
  url.searchParams.set('state', state);
  url.searchParams.set('preview', '1');

  hint.textContent = '';
  if (chrome.tabs?.create) chrome.tabs.create({ url: url.toString() });
  else window.open(url.toString(), '_blank');
});

render();

  // Values that failed validation are dropped on load, so re-rendering shows the user
  // what was actually kept rather than what they typed.
  status.textContent = 'Saved';
  setTimeout(() => {
    status.textContent = '';
  }, 2000);
});

// Opens the real guidance page with the settings as they stand, so an administrator can
// see what a user will see without having to disconnect anything.
el('previewBtn').addEventListener('click', async () => {
  const { config } = await loadConfig({ force: true });
  const state = el('previewState').value;
  const hint = el('previewHint');

  if (!chrome?.runtime?.getURL) {
    hint.textContent =
      'Preview needs the installed extension. Open this page from chrome://extensions rather than over http.';
    return;
  }

  // A representative host on the first watched domain, so the page shows a realistic
  // address without needing one to actually exist.
  const suffix = config.watchedSuffixes[0];
  const url = new URL(chrome.runtime.getURL('src/help.html'));
  url.searchParams.set('target', `https://app.${suffix}/`);
  url.searchParams.set('error', 'net::ERR_NAME_NOT_RESOLVED');
  url.searchParams.set('state', state);
  url.searchParams.set('preview', '1');

  hint.textContent = '';
  if (chrome.tabs?.create) chrome.tabs.create({ url: url.toString() });
  else window.open(url.toString(), '_blank');
});

render();
