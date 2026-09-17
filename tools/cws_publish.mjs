// Uploads and optionally publishes the extension through the Chrome Web Store API v2.
//
// Not curl in a YAML step, for one reason: an upload can return `uploadState:
// IN_PROGRESS`, and the API then expects you to poll `:fetchStatus` until
// `lastAsyncUploadState` settles. A workflow that treats the upload response as final
// reports success for an upload that later failed, and the first anyone knows is that the
// store still has the old version.
//
// The access token comes from the environment. In CI that is a short-lived token minted by
// Workload Identity Federation, so no key material exists anywhere to leak.

import { readFileSync, statSync } from 'node:fs';

// Overridable so the script can be exercised against a mock. Never set in CI.
const API = process.env.CWS_API || 'https://chromewebstore.googleapis.com';
const POLL_MS = Number(process.env.CWS_POLL_MS || 10000);

const {
  CWS_TOKEN,
  PUBLISHER_ID,
  EXTENSION_ID,
  CWS_ZIP,
  CWS_PUBLISH = 'false',
  CWS_PUBLISH_TYPE = 'DEFAULT_PUBLISH',
  CWS_DEPLOY_PERCENTAGE = '',
  CWS_TARGET = 'default',
} = process.env;

function need(name, value) {
  if (!value) {
    console.error(`missing ${name}`);
    process.exit(1);
  }
  return value;
}

need('CWS_TOKEN', CWS_TOKEN);
need('PUBLISHER_ID', PUBLISHER_ID);
need('EXTENSION_ID', EXTENSION_ID);
need('CWS_ZIP', CWS_ZIP);

const item = `publishers/${PUBLISHER_ID}/items/${EXTENSION_ID}`;
const auth = { Authorization: `Bearer ${CWS_TOKEN}` };

// Never print the token, and never print a header block that might contain it.
async function call(url, init = {}) {
  const res = await fetch(url, { ...init, headers: { ...auth, ...(init.headers || {}) } });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text.slice(0, 500) };
  }
  if (!res.ok) {
    console.error(`${init.method || 'GET'} ${url.replace(CWS_TOKEN, '')} -> ${res.status}`);
    console.error(JSON.stringify(body, null, 2));
    process.exit(1);
  }
  return body;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchStatus() {
  return call(`${API}/v2/${item}:fetchStatus`);
}

async function upload() {
  const size = statSync(CWS_ZIP).size;
  console.log(`uploading ${CWS_ZIP} (${(size / 1024).toFixed(1)} KB) to ${item}`);
  const body = await call(`${API}/upload/v2/${item}:upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/zip', 'Content-Length': String(size) },
    body: readFileSync(CWS_ZIP),
  });

  let state = body.uploadState;
  console.log(`  uploadState: ${state}${body.crxVersion ? `, version ${body.crxVersion}` : ''}`);

  // The async case. Poll rather than assume.
  const deadline = Date.now() + Number(process.env.CWS_TIMEOUT_MS || 10 * 60 * 1000);
  while (state === 'IN_PROGRESS' || state === 'UPLOAD_STATE_UNSPECIFIED') {
    if (Date.now() > deadline) {
      console.error('upload still in progress after 10 minutes, giving up');
      process.exit(1);
    }
    await sleep(POLL_MS);
    const status = await fetchStatus();
    state = status.lastAsyncUploadState;
    console.log(`  lastAsyncUploadState: ${state}`);
  }

  if (state !== 'SUCCEEDED') {
    console.error(`upload finished in state ${state}`);
    console.error(JSON.stringify(await fetchStatus(), null, 2));
    process.exit(1);
  }
  console.log('upload succeeded');
}

async function publish() {
  const request = { publishType: CWS_PUBLISH_TYPE };
  if (CWS_DEPLOY_PERCENTAGE) {
    request.deployInfos = [{ deployPercentage: Number(CWS_DEPLOY_PERCENTAGE) }];
  }
  console.log(`publishing: ${JSON.stringify(request)}`);
  const body = await call(`${API}/v2/${item}:publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });

  console.log(`  state: ${body.state}`);
  for (const w of body.warningInfo?.warnings || []) {
    console.log(`  warning: ${w.reason} — ${w.description}`);
  }

  // REJECTED is a real outcome of a successful HTTP call, so it has to be checked rather
  // than inferred from the status code.
  if (body.state === 'REJECTED' || body.state === 'CANCELLED') {
    console.error(`publish ended in ${body.state}`);
    process.exit(1);
  }
}

await upload();
if (CWS_PUBLISH === 'true') {
  await publish();
} else {
  console.log('publish not requested: the upload sits as a draft in the dashboard');
}

const final = await fetchStatus();
console.log(`\nitem ${final.itemId}`);
console.log(`  submitted: ${final.submittedItemRevisionStatus?.state ?? 'none'}`);
console.log(`  published: ${final.publishedItemRevisionStatus?.state ?? 'none'}`);
if (final.takenDown) console.log('  WARNING: this item is taken down');
if (final.warned) console.log('  WARNING: this item has a policy warning');
