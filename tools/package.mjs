// Builds the upload zip. Only the files the extension actually needs go in: the preview
// harness, tests and this script stay out, so nothing dev-only ships to users.

import { execFileSync } from 'node:child_process';
import { rmSync, existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';

const INCLUDE = [
  'manifest.json',
  'schema.json',
  'icons',
  'src/background.js',
  'src/config.js',
  'src/help.html',
  'src/help.css',
  'src/help.js',
  'src/options.html',
  'src/options.css',
  'src/options.js',
];

const { version } = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url)));
const out = `tailnet-connection-helper-${version}.zip`;
const root = new URL('..', import.meta.url).pathname;

for (const entry of INCLUDE) {
  if (!existsSync(root + entry)) {
    console.error(`missing ${entry}`);
    process.exit(1);
  }
}

if (existsSync(root + out)) rmSync(root + out);
execFileSync('zip', ['-r', '-q', '-X', out, ...INCLUDE], { cwd: root });
console.log(`wrote ${out}`);
