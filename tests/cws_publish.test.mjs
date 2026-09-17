// The publish script, exercised against a mock of the Chrome Web Store API.
//
// Worth testing because the failure modes are quiet. An upload can answer HTTP 200 with
// `uploadState: IN_PROGRESS`, and a publish can answer HTTP 200 with `state: REJECTED`. A
// script that trusts the status code reports success in both cases, and the first anyone
// knows is that the store still has the old version.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = new URL('../tools/cws_publish.mjs', import.meta.url).pathname;
const zip = join(mkdtempSync(join(tmpdir(), 'cws-')), 'ext.zip');
writeFileSync(zip, 'not a real zip, the mock does not open it');

// `script` decides what each endpoint returns, so each test states its own scenario.
function mockStore(script) {
  const seen = [];
  let statusCalls = 0;
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url.split('?')[0]}`);
    req.resume();
    req.on('end', () => {
      const send = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.url.endsWith(':upload')) return send(script.uploadCode || 200, script.upload);
      if (req.url.endsWith(':fetchStatus')) {
        const r = Array.isArray(script.status)
          ? script.status[Math.min(statusCalls, script.status.length - 1)]
          : script.status;
        statusCalls += 1;
        return send(200, r);
      }
      if (req.url.endsWith(':publish')) return send(script.publishCode || 200, script.publish ?? {});
      send(404, { error: 'unexpected path' });
    });
  });
  return { server, seen };
}

function run(base, env = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SCRIPT],
      {
        env: {
          ...process.env,
          CWS_API: base,
          CWS_POLL_MS: '5',
          CWS_TIMEOUT_MS: '3000',
          CWS_TOKEN: 'test-token-must-not-be-logged',
          PUBLISHER_ID: 'pub123',
          EXTENSION_ID: 'item456',
          CWS_ZIP: zip,
          CWS_PUBLISH: 'false',
          ...env,
        },
      },
      (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr })
    );
  });
}

async function withStore(script, fn) {
  const { server, seen } = mockStore(script);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base, seen);
  } finally {
    server.close();
  }
}

const OK_STATUS = {
  itemId: 'item456',
  submittedItemRevisionStatus: { state: 'PENDING_REVIEW' },
  publishedItemRevisionStatus: { state: 'PUBLISHED' },
};

test('a synchronous upload succeeds, and leaves a draft by default', async () => {
  await withStore(
    { upload: { uploadState: 'SUCCEEDED', crxVersion: '1.0.0' }, status: OK_STATUS },
    async (base, seen) => {
      const r = await run(base);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /upload succeeded/);
      assert.match(r.stdout, /publish not requested/);
      assert.ok(!seen.some((s) => s.endsWith(':publish')), 'nothing reached the store');
    }
  );
});

test('an async upload is polled until it settles', async () => {
  await withStore(
    {
      upload: { uploadState: 'IN_PROGRESS' },
      status: [
        { lastAsyncUploadState: 'IN_PROGRESS' },
        { lastAsyncUploadState: 'IN_PROGRESS' },
        { lastAsyncUploadState: 'SUCCEEDED' },
        OK_STATUS,
      ],
    },
    async (base, seen) => {
      const r = await run(base);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /upload succeeded/);
      const polls = seen.filter((s) => s.endsWith(':fetchStatus')).length;
      assert.ok(polls >= 3, `expected repeated polling, saw ${polls}`);
    }
  );
});

test('an upload that fails asynchronously is not reported as success', async () => {
  await withStore(
    { upload: { uploadState: 'IN_PROGRESS' }, status: { lastAsyncUploadState: 'FAILED' } },
    async (base) => {
      const r = await run(base);
      assert.equal(r.code, 1, 'must exit non-zero');
      assert.match(r.stderr, /FAILED/);
    }
  );
});

test('an upload stuck in progress times out rather than hanging the job', async () => {
  await withStore(
    { upload: { uploadState: 'IN_PROGRESS' }, status: { lastAsyncUploadState: 'IN_PROGRESS' } },
    async (base) => {
      const r = await run(base);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /still in progress/);
    }
  );
});

test('a publish rejected with HTTP 200 still fails the job', async () => {
  await withStore(
    {
      upload: { uploadState: 'SUCCEEDED' },
      status: OK_STATUS,
      publish: { state: 'REJECTED', itemId: 'item456' },
    },
    async (base) => {
      const r = await run(base, { CWS_PUBLISH: 'true' });
      assert.equal(r.code, 1, 'REJECTED is a failure even though the call returned 200');
      assert.match(r.stderr, /REJECTED/);
    }
  );
});

test('publish warnings are surfaced without failing a successful publish', async () => {
  await withStore(
    {
      upload: { uploadState: 'SUCCEEDED' },
      status: OK_STATUS,
      publish: {
        state: 'PENDING_REVIEW',
        warningInfo: { warnings: [{ reason: 'PERMISSIONS', description: 'broad host permissions' }] },
      },
    },
    async (base) => {
      const r = await run(base, { CWS_PUBLISH: 'true' });
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /warning: PERMISSIONS/);
    }
  );
});

test('an HTTP error fails the job and never echoes the token', async () => {
  await withStore(
    {
      upload: { uploadState: 'SUCCEEDED' },
      status: OK_STATUS,
      publishCode: 403,
      publish: { error: { message: 'caller does not have permission' } },
    },
    async (base) => {
      const r = await run(base, { CWS_PUBLISH: 'true' });
      assert.equal(r.code, 1);
      assert.ok(
        !`${r.stdout}${r.stderr}`.includes('test-token-must-not-be-logged'),
        'the access token must never reach the log'
      );
    }
  );
});

test('a missing setting fails before any network call', async () => {
  // Port 1 would refuse a connection, so reaching the network at all would look different.
  const r = await run('http://127.0.0.1:1', { EXTENSION_ID: '' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /missing EXTENSION_ID/);
});

test('a deploy percentage is sent as deployInfos, not invented', async () => {
  await withStore(
    { upload: { uploadState: 'SUCCEEDED' }, status: OK_STATUS, publish: { state: 'PENDING_REVIEW' } },
    async (base) => {
      const r = await run(base, { CWS_PUBLISH: 'true', CWS_DEPLOY_PERCENTAGE: '10' });
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /"deployInfos":\[\{"deployPercentage":10\}\]/);
    }
  );
});

test('promoting publishes the staged revision without re-uploading', async () => {
  await withStore(
    { upload: { uploadState: 'SUCCEEDED' }, status: OK_STATUS, publish: { state: 'PUBLISHED' } },
    async (base, seen) => {
      const r = await run(base, {
        CWS_UPLOAD: 'false',
        CWS_PUBLISH: 'true',
        CWS_PUBLISH_TYPE: 'DEFAULT_PUBLISH',
        CWS_ZIP: '',
      });
      assert.equal(r.code, 0, r.stderr);
      assert.ok(
        !seen.some((s) => s.endsWith(':upload')),
        'uploading here would submit different bytes than the ones reviewed'
      );
      assert.ok(seen.some((s) => s.endsWith(':publish')), 'but it does publish');
      assert.match(r.stdout, /skipping upload/);
    }
  );
});

test('a staged publish asks for STAGED_PUBLISH, not the default', async () => {
  await withStore(
    { upload: { uploadState: 'SUCCEEDED' }, status: OK_STATUS, publish: { state: 'STAGED' } },
    async (base) => {
      const r = await run(base, { CWS_PUBLISH: 'true', CWS_PUBLISH_TYPE: 'STAGED_PUBLISH' });
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /"publishType":"STAGED_PUBLISH"/);
    }
  );
});

test('a CRX upload sends exactly the two documented headers', async () => {
  // The docs name X-Goog-Upload-Protocol and X-Goog-Upload-File-Name. An invented
  // Content-Type on a raw upload is the kind of guess that gets rejected with a message
  // about the body rather than the header, so this asserts we send neither more nor less.
  const seenHeaders = {};
  const server = createServer((req, res) => {
    if (req.url.endsWith(':upload')) Object.assign(seenHeaders, req.headers);
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(req.url.endsWith(':upload') ? { uploadState: 'SUCCEEDED' } : OK_STATUS));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  // A minimal but genuine CRX3: the magic is what the script keys off.
  const crx = join(mkdtempSync(join(tmpdir(), 'cws-')), 'ext.crx');
  writeFileSync(crx, Buffer.concat([Buffer.from('Cr24'), Buffer.alloc(32)]));
  try {
    const r = await run(base, { CWS_ZIP: crx, CWS_REQUIRE_CRX: 'true' });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(seenHeaders['x-goog-upload-protocol'], 'raw');
    assert.equal(seenHeaders['x-goog-upload-file-name'], 'ext.crx');
    assert.ok(!seenHeaders['content-type'], 'no invented media type on a raw upload');
    assert.match(r.stdout, /signed CRX/);
  } finally {
    server.close();
  }
});

test('a ZIP is refused when the item requires a signed CRX', async () => {
  await withStore({ upload: { uploadState: 'SUCCEEDED' }, status: OK_STATUS }, async (base, seen) => {
    const r = await run(base, { CWS_REQUIRE_CRX: 'true' });
    assert.equal(r.code, 1, 'must not silently upload an unsigned package');
    assert.match(r.stderr, /not a signed CRX/);
    assert.ok(!seen.some((s) => s.endsWith(':upload')), 'and must not attempt the upload');
  });
});
