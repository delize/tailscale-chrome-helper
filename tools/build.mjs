// Stages the shippable files into dist/, which is both what you load unpacked during
// development and what gets zipped for the Web Store. Everything is an explicit
// allowlist: the preview harness, tests and tooling must never reach a user.
//
// Pass --zip to also produce the upload archive from the staged directory.

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(ROOT, 'dist');

const INCLUDE = [
  'manifest.json',
  'schema.json',
  'icons',
  'src/background.js',
  'src/config.js',
  'src/suppression.js',
  'src/help.html',
  'src/help.css',
  'src/help.js',
  'src/options.html',
  'src/options.css',
  'src/options.js',
];

const missing = INCLUDE.filter((entry) => !existsSync(join(ROOT, entry)));
if (missing.length) {
  console.error('FAIL: missing files\n  ' + missing.join('\n  '));
  process.exit(1);
}

// Clear only this script's own output directory, so a removed source file cannot linger
// in a build and quietly keep working.
if (existsSync(DIST)) rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

let files = 0;
let bytes = 0;
for (const entry of INCLUDE) {
  const from = join(ROOT, entry);
  const to = join(DIST, entry);
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
  if (statSync(from).isDirectory()) continue;
  files += 1;
  bytes += statSync(from).size;
}

// A stray dev file in a build is the failure this allowlist exists to prevent, so the
// build asserts rather than trusts.
for (const banned of ['tools', 'tests', 'node_modules', 'package.json', 'README.md', 'docs']) {
  if (existsSync(join(DIST, banned))) {
    console.error(`FAIL: ${banned} leaked into dist/`);
    process.exit(1);
  }
}

// An allowlist that silently omits a required file is worse than no allowlist: the build
// succeeds and the extension fails at load. Follow every relative import in the staged
// JavaScript and assert the target actually made it in.
const seen = new Set();
const queue = INCLUDE.filter((e) => e.endsWith('.js'));
while (queue.length) {
  const rel = queue.pop();
  if (seen.has(rel)) continue;
  seen.add(rel);
  const staged = join(DIST, rel);
  if (!existsSync(staged)) continue;
  const source = readFileSync(staged, 'utf8');
  for (const match of source.matchAll(/(?:^|\n)\s*import[^'"]*['"](\.[^'"]+)['"]/g)) {
    const target = join(dirname(rel), match[1]);
    if (!existsSync(join(DIST, target))) {
      console.error(`FAIL: ${rel} imports ${match[1]}, which is not in the build`);
      console.error(`       add "${target}" to INCLUDE in tools/build.mjs`);
      process.exit(1);
    }
    queue.push(target);
  }
}

// Same class of mistake in markup: a stylesheet or script the page needs but the build
// left out.
for (const rel of INCLUDE.filter((e) => e.endsWith('.html'))) {
  const source = readFileSync(join(DIST, rel), 'utf8');
  for (const match of source.matchAll(/(?:src|href)="([^"#:]+)"/g)) {
    const ref = match[1];
    if (ref.startsWith('/') || ref.startsWith('data:')) continue;
    const target = join(dirname(rel), ref);
    if (!existsSync(join(DIST, target))) {
      console.error(`FAIL: ${rel} references ${ref}, which is not in the build`);
      process.exit(1);
    }
  }
}

const { version } = JSON.parse(readFileSync(join(ROOT, 'manifest.json')));
console.log(`built dist/ — ${files} files, ${(bytes / 1024).toFixed(1)} KB, version ${version}`);

if (process.argv.includes('--zip')) {
  const out = `tailnet-connection-helper-${version}.zip`;
  const outPath = join(ROOT, out);
  if (existsSync(outPath)) rmSync(outPath);
  execFileSync('zip', ['-r', '-q', '-X', outPath, '.'], { cwd: DIST });
  console.log(`wrote ${out}`);
}

console.log('\nLoad it in Chrome:');
console.log('  1. Open chrome://extensions');
console.log('  2. Turn on Developer mode, top right');
console.log('  3. Click "Load unpacked" and choose:');
console.log(`     ${DIST}`);
