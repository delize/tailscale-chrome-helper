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
| `WIF_PROVIDER` | **secret** | `projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/github/providers/github-oidc` |
| `WIF_SERVICE_ACCOUNT` | **secret** | `cws-publisher@PROJECT_ID.iam.gserviceaccount.com` |
| `PUBLISHER_ID` | **secret** | The publisher ID from the dashboard URL |
| `EXTENSION_ID` | variable | The extension ID, 32 lowercase letters |

The split matters on a public repository, and for a reason that is not "these are
credentials", because they are not. None of them authenticates anything on its own.

Actions logs on a public repository are publicly readable, and variables appear in them
unmasked. The federation provider path and the service account address are precisely the two
strings an attacker needs to attempt impersonation, so they are only inert while the
federation binding stays correctly scoped to this repository. Publishing them would mean a
single future mistake in that binding turns into an exploitable one. Masking them is
defence in depth, not secrecy theatre.

`PUBLISHER_ID` is a secret for a weaker reason: it is an account identifier that is not
otherwise public, and there is no benefit to volunteering it.

`EXTENSION_ID` stays a variable because it is public by construction. It appears in every
store URL, on every user's `chrome://extensions` page, and in the policy examples in this
guide. Hiding it would buy nothing and make a failed run harder to read.

**Kind has to match the reference.** `${{ secrets.NAME }}` for a value stored as a variable
yields an empty string rather than an error, so the job fails at the auth step while the
value sits plainly visible in the variables list.

### 6. Signing, and what is actually signed

This item is opted in to **verified CRX uploads**, so the store accepts only a CRX signed
with the key registered against it. That is not the Chrome Web Store default, and it is
worth being clear about which of three keys does what, because they are easy to conflate:

| Key | Who holds it | What it decides |
|---|---|---|
| The item's own key | Google | The extension ID, `eopiofke…`. Shown under **Public key** in the dashboard. Not ours and not changeable |
| The verified-upload key | Us, `CRX_PRIVATE_KEY` | Nothing about identity. It proves an upload came from us |
| The `key` field in `manifest.json` | Us, public | The ID of an **unpacked local** build only |

The `manifest.json` `key` is the item's own public key, so a local unpacked load takes the
store's ID and one policy profile covers both the local build and the store install. It is
**stripped from the packaged build** by `tools/build.mjs`, deliberately: `--pack-extension`
derives the CRX's internal id from the key it signs with, which is the upload key, so
shipping both would have the package assert two different identities. The store re-signs
with its own key anyway.

Losing the verified-upload key means contacting CWS support, and replacement takes up to a
week. It exists in two places: the `CRX_PRIVATE_KEY` secret, and wherever you saved it.

#### Verifying provenance

`release.yml` attests the **CRX**, which is the artefact that reaches the store:

```sh
gh attestation verify tailnet-connection-helper-1.0.1.crx --repo OWNER/REPO
```

That is a stronger statement than a signing key alone makes. A key proves whoever holds it
signed the package; an attestation names the commit and the workflow that built it, so a
package uploaded by someone with dashboard access but not repository access fails.

### 7. An environment gate, recommended

The workflow targets an environment named `chrome-web-store`. Create it under Settings,
Environments and add yourself as a required reviewer. Every publish then waits for a human,
which matters because a publish reaches real users and is not easily taken back.

## Cutting a release

Two workflows, and the order is deliberate: beta first, always.

### 1. Cut a release

Actions → **Cut a release** → give it a version, e.g. `1.0.1`.

It refuses a version that is not higher than the current one, or whose tag already exists,
because the store rejects a version that does not increase and finding that out after review
wastes a cycle. Then it sets the version in `manifest.json` and `package.json`, commits,
tags, runs `npm run verify`, builds the zip, checks the archive with
`tools/check_package.mjs`, signs it with `attest-build-provenance`, publishes a GitHub
**prerelease** with the zip attached, and submits it to the store as **`STAGED_PUBLISH`**.

Staged means it goes through review and is then held. It does not reach users.

`skip_store` tags and builds without touching the store, which is how to rehearse the
mechanics.

### 2. Promote a release

Once review passes, Actions → **Promote a release** → the same version, typed twice.

It publishes the already-staged revision with `DEFAULT_PUBLISH` and flips the GitHub release
from prerelease to latest. **It uploads nothing.** The bytes that went through review are the
bytes that go live, which is the point of staging: what ships is what was reviewed, not a
rebuild that happens to carry the same version number.

The store skips review here, because the revision was submitted as `STAGED_PUBLISH`.

The confirmation field is not ceremony. There is no unpublish, so this is the irreversible
step.

### Staged or straight to users

`Cut a release` takes a `publish_type`:

- **`STAGED_PUBLISH`**, the default. Reviewed, then held. It does **not** reach users until
  you run `Promote a release`. If nobody comes back to promote it, it sits there
  indefinitely, which is the point but is also the trap: staging is only useful if someone
  is going to do the second step.
- **`DEFAULT_PUBLISH`**. Reviewed, then live. One step, no promotion.

Pick the second for a release nobody is going to babysit, and the first when you want to
see the reviewed build before users do.

### The signing key lives in CI, and what that costs

Releases are fully automated, so `CRX_PRIVATE_KEY` is a GitHub Actions secret and the
workflow signs with it.

This is a deliberate trade and worth understanding rather than inheriting. Verified CRX
uploads exist so that store access alone is not enough to ship an update: an attacker also
needs the signing key. Keeping the key in Actions puts it in the same place as the
federation credential that authorises uploads, so compromising this repository yields both
and the second factor stops being independent.

What it still protects against: a compromise of the store account or the Google Cloud
credential alone. What it no longer protects against: a compromise of this repository.

That is acceptable here because write access is one person, the environment requires an
approval, `can_admins_bypass` is off, and the environment only accepts deployments from
`main` and `v*` tags. If any of those loosen, revisit this. The alternative is signing
locally from a password manager and uploading by hand, which keeps the factors separate at
the cost of a manual step per release.

### What about a percentage rollout?

`items.setPublishedDeployPercentage` exists, but the API documents it as "only available to
items with over 10,000 seven-day active users". A new listing cannot ramp a rollout, so
staging is the available equivalent and the reason the flow is built around it.

### Trusted testers

The v2 API has no field for publishing to trusted testers. The state exists
(`PUBLISHED_TO_TESTERS`) but it follows from the item's visibility in the dashboard rather
than from anything the request can set. Configure it there if you want it.

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
