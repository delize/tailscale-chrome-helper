// Settings for an unmanaged install. Anything an administrator has set through policy
// wins and is shown locked, which is the whole point of enrolling an extension.

import { loadConfig, invalidateConfig } from './config.js';

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

async function render() {
  const { config, managedKeys } = await loadConfig({ force: true });

  el('enabled').checked = config.enabled;
  lock(el('enabled'), managedKeys.has('enabled'));

  for (const key of TEXT_FIELDS) {
    el(key).value = config[key] || '';
    lock(el(key), managedKeys.has(key));
  }

  el('watchedSuffixes').value = (config.watchedSuffixes || []).join('\n');
  lock(el('watchedSuffixes'), managedKeys.has('watchedSuffixes'));

  if (managedKeys.size) el('managedNote').hidden = false;
}

el('form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const status = el('status');
  const { managedKeys } = await loadConfig();

  const patch = {};
  const remove = [];

  if (!managedKeys.has('enabled')) patch.enabled = el('enabled').checked;

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

  await new Promise((resolve) => chrome.storage.sync.set(patch, resolve));
  if (remove.length) await new Promise((resolve) => chrome.storage.sync.remove(remove, resolve));

  invalidateConfig();
  await render();

  // Values that failed validation are dropped on load, so re-rendering shows the user
  // what was actually kept rather than what they typed.
  status.textContent = 'Saved';
  setTimeout(() => {
    status.textContent = '';
  }, 2000);
});

render();
