---
type: decision
id: 0002
status: accepted
date: 2026-09-16
domain: architecture
context: home
systems: [chrome-extension, chrome-web-store, tailscale]
source_repo: github.com/delize/tailscale-chrome-helper
project: tailscale-chrome-helper
---

# No reporting endpoint in the published extension

## Context

`recordUnwatchedHosts` keeps a local tally of failed navigations to tailnet hosts outside
the configured list, so an administrator can see that people keep trying to reach the wrong
tailnet. The original ask was for two halves: that local record, and a way to report it to
an endpoint the administrator runs. Only the local half was built.

The question was whether to finish the second half in the extension that gets published to
the Chrome Web Store.

## Options considered

**A. Ship `reportUrl` in the public extension.** The service worker periodically POSTs the
`unwatchedHosts` record to a collector the administrator runs. Off by default, admin-gated.

**B. Do not ship it.** Leave the local record readable by whatever fleet agent the
organisation already runs, and let an organisation that wants central reporting add it in
their own build.

## Decision

Option B.

The technical cost turned out to be nil, which is worth recording because it was the
expected blocker and it is not one. Chrome's documentation says a request to another origin
"will be treated as a cross-origin request unless the extension has host permissions", and
being treated as a cross-origin request means ordinary CORS applies rather than the request
being refused. So a collector can opt in with `Access-Control-Allow-Origin`, or accept a
fire-and-forget `no-cors` POST, and neither needs a host permission. The feared
`https://*/*` in the manifest, which would have changed the install warning to "Read and
change all your data on all websites", was never actually required.

The cost that decided it is policy, not permissions. Chrome Web Store rules require
disclosure of data handling, and the data disclosure is a property of the **listing**, not
of whether a given installation has the feature switched on. Shipping the capability would
change what every organisation sees at install time, including the ones that never enable
it. The rules also require prominent disclosure and consent in the extension's own
interface, which sits badly with a silent force-installed enterprise deployment and worse
on a page whose only job is unblocking someone who is already stuck.

Weighed against that, the feature is redundant for most of its audience. An organisation
that wants central host counts is almost certainly already running a fleet agent that can
read `chrome.storage.local`, which `docs/host-counts.md` documents as a stable contract.
The endpoint would duplicate that with a worse story for retry, authentication and queue
durability across service worker termination.

The privacy policy currently says nothing is transmitted, without qualification. That claim
is worth more than a feature most installations would leave off.

## Consequences

`docs/privacy.md` states there is deliberately no reporting endpoint, so the absence is a
promise rather than an omission someone might helpfully fix later.

An organisation that genuinely needs this has two routes, both already open. Read the local
record with the agent they already run, or rebuild from source with a `reportUrl` of their
own, which the project is open source to allow. Neither affects the public listing.

This decision is reversible but expensive to reverse. Adding transmission later means
changing the listing's data disclosure for every existing installation, so it should be
revisited only with a concrete user asking for it, not on the general principle that
reporting is useful.

Supersedes nothing. Closes #7.
