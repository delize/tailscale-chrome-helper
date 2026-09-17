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
const TIMEOUT_MS = Number(process.env.CWS_TIMEOUT_MS || 10 * 60 * 1000);

const {
  CWS_TOKEN,
  PUBLISHER_ID,
  EXTENSION_ID,
  CWS_PACKAGE,
  CWS_ZIP,
  CWS_UPLOAD = 'true',
  CWS_PUBLISH = 'false',
  CWS_EXPECT_VERSION = '',
  CWS_PUBLISH_TYPE = 'DEFAULT_PUBLISH',
  CWS_DEPLOY_PERCENTAGE = '',
} = process.env;

function need(name, value) {
  if (!value) {
    console.error(`missing ${name}`);
    process.exit(1);
  }
  return value;
}

// Every boolean-ish input goes through this. They were compared with === 'true', so any
// other spelling silently meant false: CWS_PUBLISH=True published nothing and exited 0, and
// CWS_REQUIRE_CRX=True turned off the guard whose entire job is to be on. A flag that fails
// open on a typo is worse than no flag.
function flag(name, value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  console.error(`${name} must be exactly "true" or "false", got ${JSON.stringify(value)}`);
  process.exit(1);
}

need('CWS_TOKEN', CWS_TOKEN);
need('PUBLISHER_ID', PUBLISHER_ID);
need('EXTENSION_ID', EXTENSION_ID);
// Renamed: it holds a CRX, not a zip. The old name is still read so a stale caller
// fails loudly on the next line rather than mysteriously.
const pkg = CWS_PACKAGE || CWS_ZIP;

const shouldUpload = flag('CWS_UPLOAD', CWS_UPLOAD);
if (shouldUpload) need('CWS_PACKAGE', pkg);
const item = `publishers/${PUBLISHER_ID}/items/${EXTENSION_ID}`;
const auth = { Authorization: `Bearer ${CWS_TOKEN}` };

// Reports; it does not decide. It used to call process.exit(1) itself, which meant the
// lowest layer in the file ended the release: one 429 or 503 from the store during the
// ten-minute poll loop killed a run that only needed to wait, and the layer that saw the
// status code had already exited so nothing could retry. Callers now choose.
//
// Never prints headers or the init object, so the bearer token cannot reach a log. It only
// ever travels in the Authorization header, never in a URL.
async function call(url, init = {}) {
  const res = await fetch(url, { ...init, headers: { ...auth, ...(init.headers || {}) } });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text.slice(0, 500) };
  }
  return { ok: res.ok, status: res.status, body };
}

// 429 and 5xx are the store being busy, not the release being wrong.
const transient = (status) => status === 429 || status >= 500;

function fatal(what, status, body) {
  console.error(`${what} -> HTTP ${status}`);
  console.error(JSON.stringify(body, null, 2));
  process.exit(1);
}

// For the calls where there is nothing to do but fail.
async function callOrDie(what, url, init = {}) {
  const { ok, status, body } = await call(url, init);
  if (!ok) fatal(what, status, body);
  return body;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchStatus() {
  return callOrDie('fetchStatus', `${API}/v2/${item}:fetchStatus`);
}

// A CRX is a ZIP with a signed header bolted on the front, so the two are told apart by
// the magic bytes rather than the file extension. Getting this wrong means uploading a
// signed package with the headers for an unsigned one, which the store rejects in a way
// that does not obviously name the cause.
function isCrx(bytes) {
  return bytes.length > 4 && bytes.subarray(0, 4).toString('latin1') === 'Cr24';
}

async function upload() {
  const bytes = readFileSync(pkg);
  const size = statSync(pkg).size;
  const crx = isCrx(bytes);
  const name = pkg.split('/').pop();

  // The item is opted in to verified CRX uploads, so a signed CRX is the only thing it
  // accepts. There is no ZIP branch and no flag to disable this: whether a CRX is required
  // is a property of the store item, not of the invocation, and a flag asking each caller
  // to restate it just created a way to turn the check off by typo.
  if (!crx) {
    console.error(`${pkg} is not a signed CRX.`);
    console.error('Expected the file to start with the magic bytes Cr24.');
    process.exit(1);
  }

  console.log(`uploading ${name} (${(size / 1024).toFixed(1)} KB, signed CRX) to ${item}`);
  // Exactly the two headers the docs specify, and nothing else. An earlier version also
  // sent Content-Type: application/x-chrome-extension, which was a guess: the documentation
  // names X-Goog-Upload-Protocol and X-Goog-Upload-File-Name and no media type. A guessed
  // content type on a raw upload gets rejected with a message that blames the body.
  const headers = {
    'Content-Length': String(size),
    'X-Goog-Upload-Protocol': 'raw',
    'X-Goog-Upload-File-Name': name,
  };

  const body = await callOrDie('upload', `${API}/upload/v2/${item}:upload`, {
    method: 'POST',
    headers,
    body: bytes,
  });

  let state = body.uploadState;
  console.log(`  uploadState: ${state}${body.crxVersion ? `, version ${body.crxVersion}` : ''}`);

  // The async case. Poll rather than assume.
  const deadline = Date.now() + TIMEOUT_MS;
  while (state === 'IN_PROGRESS' || state === 'UPLOAD_STATE_UNSPECIFIED') {
    if (Date.now() > deadline) {
      console.error(`upload still in progress after ${Math.round(TIMEOUT_MS / 1000)}s, giving up`);
      process.exit(1);
    }
    await sleep(POLL_MS);
    const { ok, status, body: status_ } = await call(`${API}/v2/${item}:fetchStatus`);
    if (!ok) {
      if (!transient(status)) fatal('fetchStatus while polling', status, status_);
      // Busy, not broken. Keep polling until the deadline, which is what it is for.
      console.log(`  fetchStatus -> HTTP ${status}, retrying`);
      continue;
    }
    state = status_.lastAsyncUploadState;
    console.log(`  lastAsyncUploadState: ${state}`);
  }

  if (state !== 'SUCCEEDED') {
    console.error(`upload finished in state ${state}`);
    console.error(JSON.stringify(await fetchStatus(), null, 2));
    process.exit(1);
  }
  console.log('upload succeeded');
}

// An allowlist, not a denylist. It used to reject exactly REJECTED and CANCELLED, so an
// unmodelled state, a missing state field, or a response shaped like the older v1.1 API all
// fell through and the script exited 0 on a publish that had failed. That is precisely the
// quiet success this file's header says it exists to prevent.
const PUBLISH_OK = new Set(['PENDING_REVIEW', 'PUBLISHED', 'PUBLISHED_TO_TESTERS', 'STAGED']);

// Refuses to publish a revision other than the one asked for.
//
// promote.yml takes a version, typed twice for confirmation, and then never sent it
// anywhere: the publish call carries only a publish type, so the store released whatever
// revision happened to be staged. Stage 1.0.1, stage 1.0.2, promote "1.0.1", and 1.0.2
// went live to every user while the wrong GitHub release was marked latest. Both
// confirmations passed, because both only checked that a tag existed.
async function assertStagedVersion(expected) {
  const status = await fetchStatus();
  const channels = status.submittedItemRevisionStatus?.distributionChannels ?? [];
  const versions = [...new Set(channels.map((c) => c.crxVersion).filter(Boolean))];

  if (versions.length === 0) {
    console.error(`cannot confirm the staged revision is ${expected}: the store reports no`);
    console.error('submitted revision. Nothing is staged, so there is nothing to promote.');
    process.exit(1);
  }
  if (!versions.includes(expected)) {
    console.error(`refusing to publish: asked for ${expected}, but the store has`);
    console.error(`${versions.join(', ')} staged. Publishing would release the wrong version.`);
    process.exit(1);
  }
  console.log(`  staged revision is ${expected}, as expected`);
}

async function publish() {
  if (CWS_EXPECT_VERSION) await assertStagedVersion(CWS_EXPECT_VERSION);
  const request = { publishType: CWS_PUBLISH_TYPE };
  if (CWS_DEPLOY_PERCENTAGE) {
    request.deployInfos = [{ deployPercentage: Number(CWS_DEPLOY_PERCENTAGE) }];
  }
  console.log(`publishing: ${JSON.stringify(request)}`);
  const body = await callOrDie('publish', `${API}/v2/${item}:publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });

  console.log(`  state: ${body.state}`);
  for (const w of body.warningInfo?.warnings || []) {
    console.log(`  warning: ${w.reason} — ${w.description}`);
  }

  // A real outcome arrives with HTTP 200, so it has to be read from the body. Anything not
  // recognised fails: a state this script has never heard of is a reason to stop, not a
  // reason to assume the best.
  if (!PUBLISH_OK.has(body.state)) {
    console.error(`publish ended in an unexpected state: ${body.state ?? '(no state field)'}`);
    console.error(JSON.stringify(body, null, 2));
    process.exit(1);
  }
}

// Promotion re-publishes an already-reviewed, staged revision. No new package is involved,
// so uploading one would submit something different for review and defeat the point.
if (shouldUpload) {
  await upload();
} else {
  console.log('skipping upload: promoting the revision already staged in the store');
}

if (flag('CWS_PUBLISH', CWS_PUBLISH)) {
  await publish();
} else {
  console.log('publish not requested: the upload sits as a draft in the dashboard');
}

const final = await fetchStatus();
const submitted = final.submittedItemRevisionStatus?.state ?? 'none';
const published = final.publishedItemRevisionStatus?.state ?? 'none';
console.log(`\nitem ${final.itemId}`);
console.log(`  submitted: ${submitted}`);
console.log(`  published: ${published}`);

// These were printed and then the script exited 0. A run that ends with the item taken
// down is not a successful release, and neither is one whose submitted revision was
// rejected while the publish call happened to answer politely.
const problems = [];
if (final.takenDown) problems.push('the item is taken down for a policy violation');
if (final.warned) problems.push('the item has a policy warning and will be taken down if unresolved');
if (shouldUpload && ['REJECTED', 'CANCELLED'].includes(submitted)) {
  problems.push(`the submitted revision is ${submitted}`);
}
if (problems.length) {
  console.error('\nthe store does not agree this worked:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
