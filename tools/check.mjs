// Static checks that catch the drift this project is most likely to suffer: a config key
// that exists in code but not in the administrator-facing schema, or vice versa.

import { readFileSync } from 'node:fs';
import { DEFAULTS, STATES, CLEANERS, defaultStrings } from '../src/config.js';

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

// The four inlined schema blocks must expose exactly the fields cleanStrings accepts.
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

if (problems.length) {
  console.error('FAIL');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.log(`OK: ${defaultKeys.length} config keys, ${STATES.length} states, permissions unchanged`);
