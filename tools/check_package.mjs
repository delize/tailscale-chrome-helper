// Inspects the built zip the way the store will, before anything is uploaded.
//
// A rejected upload costs a review cycle, and some of these are silent rather than loud: a
// manifest that references an icon the zip does not contain installs fine from a local
// directory, because the file is sitting there on disk, and fails only once packaged.
//
// Usage: node tools/check_package.mjs <zip>

import { readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const zip = process.argv[2];
if (!zip) {
  console.error('usage: node tools/check_package.mjs <zip>');
  process.exit(1);
}

// unzip -Z1 lists entries without extracting, and is present on every runner.
const names = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' }).trim().split('\n');
const read = (name) =>
  execFileSync('unzip', ['-p', zip, name], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const problems = [];
const checks = [];

function check(label, ok, detail = '') {
  checks.push({ label, ok, detail });
  if (!ok) problems.push(label + (detail ? `: ${detail}` : ''));
}

const size = statSync(zip).size;
// The store's documented ceiling. Nowhere near it, but a bundled asset could change that.
check('under the 2 GB store limit', size < 2 * 1024 ** 3, `${(size / 1024).toFixed(1)} KB`);
check('manifest.json at the archive root', names.includes('manifest.json'));
if (problems.length) {
  console.error('cannot inspect further:', problems.join('; '));
  process.exit(1);
}

const m = JSON.parse(read('manifest.json'));
check('manifest_version is 3', m.manifest_version === 3, String(m.manifest_version));
check('has a name', Boolean(m.name), m.name);
check('version is 1 to 4 dot-separated integers', /^\d+(\.\d+){0,3}$/.test(String(m.version)), m.version);
// The store truncates a longer description in the listing rather than rejecting it, so this
// is about the listing reading correctly, not about the upload succeeding.
check(
  'description is present and at most 132 characters',
  m.description?.length > 0 && m.description.length <= 132,
  `${m.description?.length ?? 0} chars`
);
check('a 128px icon is declared', Boolean(m.icons?.['128']));

// Every local path the manifest names must actually be in the archive. This is the check
// that catches what local testing cannot.
const referenced = [
  ...Object.values(m.icons ?? {}),
  m.background?.service_worker,
  m.options_page,
  m.storage?.managed_schema,
  ...(m.web_accessible_resources ?? []).flatMap((r) => r.resources ?? []),
].filter(Boolean);

for (const ref of referenced) {
  check(`referenced file is packaged: ${ref}`, names.includes(ref));
}

// Nothing that only matters during development should reach a user.
const devOnly = names.filter(
  (n) =>
    n.startsWith('tools/') ||
    n.startsWith('tests/') ||
    n.startsWith('docs/') ||
    n.startsWith('.github/') ||
    n.startsWith('.') ||
    n.endsWith('.md') ||
    n.endsWith('.map')
);
check('no tooling, tests, docs or dotfiles packaged', devOnly.length === 0, devOnly.slice(0, 5).join(', '));

for (const { label, ok, detail } of checks) {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
}
console.log(`\n  ${names.length} entries, ${(size / 1024).toFixed(1)} KB`);

if (problems.length) {
  console.error(`\n${problems.length} problem(s) would reach the store:`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('\npackage is well formed for upload');
