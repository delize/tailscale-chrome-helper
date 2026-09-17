# Design notes

Why the extension is built the way it is. The README covers what it does; this covers the
decisions behind it, and the traps that are easy to walk back into.

Formal decision records live in [decisions/](decisions/).

## Domains come from policy, not the manifest

The `webNavigation` permission delivers navigation events for every host without any host
permission, so the watched domain list is a policy value rather than a manifest entry.

This is the keystone. It is what makes one published extension serve any organisation:
nothing is baked into the build and the extension requests no access to any tailnet
domain. A previous version derived its watched suffixes from manifest host permissions,
which meant every organisation needed its own fork.

## Six states, not two

Probing Tailscale's Quad100 address alone cannot tell "Tailscale is off" from "a captive
portal is intercepting everything". A second probe against a public no-content endpoint
separates them, so someone on a hotel network is told to sign in to the network rather
than to flip a toggle that would not help.

The states then split further by what the user can actually do about it. `appDown` and
`nameNotFound` both mean Tailscale is connected, but one is nobody's fault and one is a
typo, and telling a user to report a typo wastes their time and yours.

[ADR 0001](decisions/0001-classified-states-not-copy-variants.md) records why these are
distinct states rather than variants of one state with swapped copy.

## The Quad100 probe is content-verified

A captive portal can answer plain HTTP for any address, including `100.100.100.100`, so a
bare 200 proves nothing. The response body has to identify itself as Tailscale.

## Offline needs two failures, not one

`offline` used to be concluded from a single failed request to a single endpoint. A
firewall or DNS filter blocking just that endpoint fails identically to an unplugged
cable, so users with working wifi were told to check their cable while the real problem
was that Tailscale was off.

Now `navigator.onLine === false` short-circuits first, and a second independent endpoint
is consulted before offline is concluded. `navigator.onLine === true` decides nothing on
its own, because it is true on a wifi network with no upstream.

The two default endpoints are run by **different operators** on purpose. A network that
blocks one Google endpoint usually blocks the rest, which would make a second Google
endpoint worthless as a second opinion.

## The captive portal probe is plaintext on purpose

A captive portal cannot intercept an HTTPS request without presenting a certificate the
client rejects, so an HTTPS probe can only ever fail. Over plain HTTP the portal answers,
and that answer is the signal. An HTTPS probe would read every portal as "offline" and
tell a hotel guest to check their ethernet cable.

## The help page suppresses itself briefly

Pressing Back re-runs the same failing navigation instantly, and without suppression the
tab bounces straight forward again.

## The illustration is markup, not a screenshot

The account row carries the configured tenant, and overlaying live text on a raster needs
pixel-exact positioning that breaks across zoom, DPI and font fallback. It also keeps a
public listing clear of shipping a pixel copy of another vendor's interface.

The illustration is hidden on states where finding the Tailscale toggle is not the user's
next action. It is the largest element on the card, so the eye reaches it before the
steps, and on `offline` it used to contradict the page's own first instruction.

## Two traps worth naming

### Do not read `res.status` on the retry probe

Because there is no host permission for tailnet domains, the help page cannot read the
status code of the app it is retrying. It fetches `no-cors` and treats "did not throw" as
reachable. `res.status` is always `0` here, and an opaque response is a success. That also
covers the SSO bounce, where a redirect to an identity provider proves the app is up.

Do not reintroduce a `res.status < 500` check without adding host permissions back. That
permission would have to be `*://*.ts.net/*`, which cannot be scoped to one tailnet
without baking the tenant into the manifest, and which grants access to every Tailscale
customer's internal apps rather than just yours.

### Keep admin images in an `<img>`

`logoDataUrl` and `bannerDataUrl` accept `data:image/svg+xml`, and SVG can carry script.
Both are assigned to `<img>.src`, where SVG renders inertly and the script never runs.
Inlining either, or moving it to an `<object>` or a background built from `innerHTML`,
turns an administrator-supplied string into script execution on a privileged page that can
read managed storage.

## Not built, and why

[roadmap/native-messaging.md](roadmap/native-messaging.md) records why the page offers no
button that opens the Tailscale client. The `tailscale://` scheme serves signed deeplinks
only and rejects anything else, and Native Messaging, the only other mechanism, needs an
MDM-deployed host binary. Anything that can deploy that can deploy Tailscale itself.

[ADR 0002](decisions/0002-no-reporting-endpoint.md) records why there is no endpoint for
reporting the local host counts to an administrator.
