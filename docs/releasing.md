# Releasing

Publishing runs from GitHub Actions through the Chrome Web Store API v2, authenticated with
Workload Identity Federation. **No service account key exists**, so there is no credential
in this repository to leak or rotate. The job mints a short-lived token per run.

## One-time setup

### 1. A service account, with no key

In Google Cloud, create a service account, for example `cws-publisher`. Do **not** create a
JSON key for it. The point of the setup below is that a key never exists.

### 2. Workload Identity Federation

Create a pool and an OIDC provider for GitHub, then allow this repository to impersonate the
service account. Restrict the binding to this repository, so another repository presenting a
GitHub token cannot use it:

```sh
gcloud iam service-accounts add-iam-policy-binding \
  cws-publisher@PROJECT_ID.iam.gserviceaccount.com \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/github/attribute.repository/OWNER/REPO"
```

Binding to the whole pool rather than to `attribute.repository` would let any repository on
GitHub mint this token. Scope it.

### 3. Enable the API

Enable the Chrome Web Store API in the same Google Cloud project.

### 4. Link the service account to the publisher

In the Chrome Web Store Developer Dashboard, under **Account**, add the service account's
email address. This is what authorises it to manage items owned by that publisher.

Two limits worth knowing before you plan around it. **A publisher can have only one service
account**, so pick one and reuse it. And the account section is per publisher, so a group
publisher and a personal publisher are configured separately.

### 5. Repository variables

None of these are secrets. They are identifiers, and keeping them as variables rather than
secrets means the logs stay readable when something goes wrong.

| Name | Kind | Value |
|---|---|---|
| `WIF_PROVIDER` | secret | `projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/github/providers/github-oidc` |
| `WIF_SERVICE_ACCOUNT` | secret | `cws-publisher@PROJECT_ID.iam.gserviceaccount.com` |
| `PUBLISHER_ID` | secret | The publisher ID from the dashboard URL |
| `EXTENSION_ID` | variable | The extension ID, 32 lowercase letters |

None of these four are sensitive in the cryptographic sense. A federation provider path, a
service account address and a pair of store identifiers all appear in URLs, logs and
manifests, and none of them grants anything on its own: access comes from the identity
federation binding, which is scoped to this repository. They are held as secrets because
that is the house style, at the cost of masked values making a failed run harder to read.
`EXTENSION_ID` stays a variable because it is the one you will want to see in a log.

### 6. Signing, and what is actually signed

The store takes a **ZIP**, not a signed CRX, and it does the CRX signing itself with its own
key. A developer private key is never uploaded and never needs to exist for store
distribution. The `.pem` that Chrome's **Pack extension** button produces belongs to a
different channel entirely: self-hosting a `.crx` on your own server, where you sign it
because no store is doing it for you.

So there is no private key to protect here, which removes a whole class of risk rather than
leaving it unmanaged. The two things that can be secured are the credential used to upload,
and the provenance of what gets uploaded.

The credential is handled by federation: no key exists, and the token lives minutes.

Provenance is handled by `actions/attest-build-provenance`, which signs the zip with this
workflow's own identity before it is uploaded. Anyone can then verify that the package came
from this repository, this commit and this workflow:

```sh
gh attestation verify tailnet-connection-helper-1.0.0.zip --repo OWNER/REPO
```

That is a stronger statement than a developer key would make. A `.pem` proves only that
whoever holds the file signed the package; an attestation names the source commit and the
workflow that built it.

### 7. An environment gate, recommended

The workflow targets an environment named `chrome-web-store`. Create it under Settings,
Environments and add yourself as a required reviewer. Every publish then waits for a human,
which matters because a publish reaches real users and is not easily taken back.

## Publishing

**On a release.** Publishing a GitHub Release runs the workflow, which verifies, checks that
the tag matches the manifest version, builds the zip, uploads it and submits it for review.

A tag of `v1.2.0` must match `"version": "1.2.0"` in `manifest.json`. The job fails if they
disagree, because a release that ships a different version than it claims is discovered much
later and by someone else.

**Manually.** Run the workflow from the Actions tab. It defaults to **uploading a draft and
stopping**, which is reviewable in the dashboard and costs nothing if it is wrong. Tick
`publish` to submit it.

`publish_type` chooses between `DEFAULT_PUBLISH`, which goes live once review approves, and
`STAGED_PUBLISH`, which waits for you to release it. `deploy_percentage` starts a partial
rollout.

## What the script checks that a plain curl would not

`tools/cws_publish.mjs` exists rather than a few `curl` lines because two of the API's
failure modes return HTTP 200.

An upload can answer `uploadState: IN_PROGRESS`, meaning the store accepted the bytes and is
still processing them. The result arrives later through `:fetchStatus` as
`lastAsyncUploadState`. A workflow that treats the upload response as final reports success
for an upload that then failed.

A publish can answer `state: REJECTED` or `CANCELLED` with a 200. Those are outcomes, not
transport errors, and they have to be read from the body.

The script also never prints the token, and prints the item's final submitted and published
states so the log says what actually happened.

## Rolling back

There is no unpublish through the API. If a release is bad, publish a corrected version with
a higher version number. For a staged rollout,
`items.setPublishedDeployPercentage` can reduce the percentage, which is the closest thing to
a brake. Plan releases on the assumption that forward is the only direction.
