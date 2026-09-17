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
// A CRX is a signed header followed by a ZIP, so unzip reads it directly. Checking the
// magic here means the Cr24 contract is defined once, in one language, rather than
// reimplemented in a workflow step that could drift.
const head = readFileSync(zip).subarray(0, 4).toString('latin1');
const isCrx = head === 'Cr24';
if (zip.endsWith('.crx') && !isCrx) {
  console.error(`${zip} is named .crx but does not start with Cr24`);
  process.exit(1);
}
if (isCrx) console.log(`  [PASS] signed CRX (Cr24 magic present)`);

// unzip exits 1 with "extra bytes at beginning" on a CRX, because the signed header sits in
// front of the archive. That is expected rather than an error, and it still lists every
// entry correctly, so the listing is taken from stdout either way. Treat an empty listing
// as the real failure.
function listEntries(path) {
  try {
    return execFileSync('unzip', ['-Z1', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (err) {
    if (err.stdout && err.stdout.trim()) return err.stdout;
    console.error(`cannot read ${path} as an archive`);
    console.error(err.stderr || err.message);
    process.exit(1);
  }
}

const names = listEntries(zip).trim().split('\n').filter((n) => n && !n.endsWith('/'));
const read = (name) => {
  try {
    return execFileSync('unzip', ['-p', zip, name], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (err) {
    if (err.stdout) return err.stdout;
    throw err;
  }
};

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
