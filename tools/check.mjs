// Static checks that catch the drift this project is most likely to suffer: a config key
// that exists in code but not in the administrator-facing schema, or vice versa.

import { readFileSync } from 'node:fs';
import { DEFAULTS, STATES } from '../src/config.js';

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

// The permission set is the thing most likely to creep. Fail loudly if it grows.
const expectedPerms = ['webNavigation', 'storage'];
const expectedHosts = ['http://100.100.100.100/'];
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
