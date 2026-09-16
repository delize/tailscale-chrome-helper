// Static checks that catch the drift this project is most likely to suffer: a config key
// that exists in code but not in the administrator-facing schema, or vice versa.

import { readFileSync } from 'node:fs';
import { DEFAULTS, STATES, CLEANERS, defaultStrings, DISCLOSURE } from '../src/config.js';

const schema = JSON.parse(readFileSync(new URL('../schema.json', import.meta.url)));
const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url)));

const problems = [];

const schemaKeys = Object.keys(schema.properties);
const defaultKeys = Object.keys(DEFAULTS);

for (const key of defaultKeys) {
  if (!schemaKeys.includes(key)) problems.push(`DEFAULTS has "${key}" but schema.json does not`);
}
for (const key of schemaKeys) {
  if (!defaultKeys.includes(key)) problems.push(`schema.json has "${key}" but DEFAULTS does not`);
}

// Chrome rejects a schema whose top level is not an object or that allows extra keys.
if (schema.type !== 'object') problems.push('schema top-level type must be "object"');
if ('additionalProperties' in schema) problems.push('schema must not set additionalProperties at the top level');

for (const [key, value] of Object.entries(schema.properties)) {
  if (!value.type && !value.$ref) problems.push(`schema property "${key}" needs a type or $ref`);
  if (!value.description) problems.push(`schema property "${key}" needs a description, admins read it`);
}

for (const state of STATES) {
  if (!schema.properties.strings.properties[state]) {
    problems.push(`schema strings is missing state "${state}"`);
  }
}

// Every config key must have a validator. Without one, loadConfig calls undefined and
// throws inside the navigation listener, which kills the extension for exactly the tenant
// who set that key and for nobody else, so it never shows up in testing.
const cleanerKeys = Object.keys(CLEANERS);
for (const key of defaultKeys) {
  if (!cleanerKeys.includes(key)) problems.push(`DEFAULTS has "${key}" but CLEANERS does not`);
}
for (const key of cleanerKeys) {
  if (!defaultKeys.includes(key)) problems.push(`CLEANERS has "${key}" but DEFAULTS does not`);
}

// Default copy must cover every state in both modes. A state missing from the neutral set
// renders a literal "undefined" to users, and only on unconfigured installs.
for (const hasCompany of [true, false]) {
  const copy = defaultStrings(hasCompany);
  for (const state of STATES) {
    for (const field of ['pill', 'headline', 'lede', 'steps']) {
      if (!copy[state]?.[field]) {
        problems.push(`defaultStrings(${hasCompany}) is missing ${state}.${field}`);
      }
    }
  }
}

// Each inlined schema block must expose exactly the fields cleanStrings accepts.
const COPY_FIELDS = ['pill', 'headline', 'lede', 'steps'];
for (const state of STATES) {
  const block = schema.properties.strings.properties[state];
  if (!block) continue;
  const fields = Object.keys(block.properties || {});
  const missing = COPY_FIELDS.filter((f) => !fields.includes(f));
  if (missing.length) problems.push(`schema strings.${state} is missing ${missing.join(', ')}`);
}

// Every setting an administrator can set must be documented, or they cannot discover it.
// The schema descriptions cover someone who unpacks the CRX; the admin guide covers
// everyone else. This was drifting: checkingLabel and the transitional pills shipped
// undocumented because nothing compared the two.
const guide = readFileSync(new URL('../docs/admin-guide.md', import.meta.url), 'utf8');
const documented = new Set(
  [...guide.matchAll(/^\|\s*`([A-Za-z0-9_]+)`\s*\|/gm)].map((m) => m[1])
);
for (const key of defaultKeys) {
  if (!documented.has(key)) {
    problems.push(`DEFAULTS has "${key}" but docs/admin-guide.md does not document it`);
  }
}

// The same for the per-state copy fields, which are a second, separate surface.
const COPY_FIELDS_DOCUMENTED = ['pill', 'headline', 'lede', 'steps', 'pillProbing', 'pillConnected'];
for (const field of COPY_FIELDS_DOCUMENTED) {
  if (!documented.has(field)) {
    problems.push(`copy field "${field}" is not documented in docs/admin-guide.md`);
  }
}

// The full policy example has to stay complete, or an administrator copying it silently
// inherits a config missing the newest settings.
const fullExample = JSON.parse(
  readFileSync(new URL('../examples/admin-console-full.json', import.meta.url), 'utf8')
);
for (const key of defaultKeys) {
  if (!(key in fullExample)) {
    problems.push(`examples/admin-console-full.json is missing "${key}"`);
  }
}
for (const key of Object.keys(fullExample)) {
  if (!defaultKeys.includes(key)) {
    problems.push(`examples/admin-console-full.json has "${key}", which is not a setting`);
  }
}

// Per-state maps that fail silently when a state is missing: a wrong pill colour, or the
// connect-the-toggle illustration shown on a state where Tailscale is already up. Both
// were missed when the two newest states were added.
const helpSource = readFileSync(new URL('../src/help.js', import.meta.url), 'utf8');
const pillTone = helpSource.slice(helpSource.indexOf('const PILL_TONE'), helpSource.indexOf('};', helpSource.indexOf('const PILL_TONE')));
for (const state of STATES) {
  if (!pillTone.includes(`${state}:`)) {
    problems.push(`PILL_TONE in src/help.js has no entry for "${state}"`);
  }
}

// ILLUSTRATION_HELPS is an allow list, so a typo silently hides the illustration on the one
// state that needs it rather than failing loudly. Every name in it must be a real state.
const illustrationSet = helpSource.slice(
  helpSource.indexOf('const ILLUSTRATION_HELPS'),
  helpSource.indexOf(']);', helpSource.indexOf('const ILLUSTRATION_HELPS'))
);
for (const name of illustrationSet.match(/'([a-zA-Z]+)'/g) || []) {
  const state = name.slice(1, -1);
  if (!STATES.includes(state)) {
    problems.push(`ILLUSTRATION_HELPS names "${state}", which is not a state`);
  }
}
if (!/ILLUSTRATION_HELPS = new Set\(\['tailscaleOff'/.test(helpSource)) {
  problems.push('tailscaleOff must keep the illustration: it is the state the page exists for');
}

// The options page preview must be able to render every state, since it is the only place
// an administrator can check their copy overrides before users see them.
const optionsSource = readFileSync(new URL('../src/options.js', import.meta.url), 'utf8');
if (!optionsSource.includes('for (const state of STATES)')) {
  problems.push('src/options.js must build the preview list from STATES, not a fixed list');
}

// Exposing the guidance page to the web would turn it into a ready-made phishing template:
// extension origin, tenant branding, attacker-chosen hostname and "sign in" copy.
if ('web_accessible_resources' in manifest) {
  problems.push('web_accessible_resources would expose help.html to any web page');
}

// The permission set is the thing most likely to creep. Fail loudly if it grows.
const expectedPerms = ['webNavigation', 'storage'];
const expectedHosts = ['http://100.100.100.100/', 'http://connectivitycheck.gstatic.com/'];
if (manifest.permissions.join() !== expectedPerms.join()) {
  problems.push(`permissions changed to [${manifest.permissions}], expected [${expectedPerms}]`);
}
if (manifest.host_permissions.join() !== expectedHosts.join()) {
  problems.push(`host_permissions changed to [${manifest.host_permissions}], expected [${expectedHosts}]`);
}

// The data-handling disclosure must stay non-configurable. Chrome Web Store policy says it
// "must not be located only in a privacy policy", so it ships in the interface, and an
// administrator who could blank it through policy would defeat the point. Fail if it ever
// becomes a config key, or if either page stops rendering it.
if ('disclosure' in DEFAULTS || 'disclosure' in CLEANERS || 'disclosure' in schema.properties) {
  problems.push('disclosure became a configurable key: policy could then suppress it');
}
for (const part of ['handles', 'records']) {
  if (typeof DISCLOSURE[part] !== 'string' || DISCLOSURE[part].length < 40) {
    problems.push(`DISCLOSURE.${part} is missing or too short to be a real disclosure`);
  }
}
if (!helpSource.includes('DISCLOSURE.records')) {
  problems.push('help.js no longer renders DISCLOSURE.records');
}
if (!optionsSource.includes('DISCLOSURE.handles')) {
  problems.push('options.js no longer renders DISCLOSURE.handles');
}
const storeListing = readFileSync(new URL('../docs/store-listing.md', import.meta.url), 'utf8');
if (!/Web browsing activity/.test(storeListing)) {
  problems.push('docs/store-listing.md no longer names the Web browsing activity disclosure');
}

if (problems.length) {
  console.error('FAIL');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.log(`OK: ${defaultKeys.length} config keys, ${STATES.length} states, permissions unchanged`);
