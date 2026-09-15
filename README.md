# Tailnet Connection Helper

A Chrome extension that replaces the browser's "This site can't be reached" page with
guidance when someone opens a Tailscale tailnet app and the tunnel is not up.

Without it, a user who opens `back-office.acme.ts.net` with Tailscale disconnected sees
`DNS_PROBE_FINISHED_NXDOMAIN` and nothing else. Nothing on that page names Tailscale, so
the ticket lands on IT. This extension names the cause, shows where the client lives on
the machine, and sends the user back to the app on its own once the connection returns.

It is configured entirely through Chrome policy, so one published extension serves any
organisation. See [docs/admin-guide.md](docs/admin-guide.md).

## Design notes

**Domains come from policy, not the manifest.** The `webNavigation` permission delivers
navigation events for all hosts without host permissions, so the watched domain list is a
policy value rather than a manifest entry. Nothing is baked into the build, and the
extension requests no access to any tailnet domain.

**Four states, not two.** Probing Tailscale's Quad100 address alone cannot tell "Tailscale
is off" from "a captive portal is intercepting everything". A second `no-cors` probe
against a public no-content endpoint separates them, so a user on a hotel network is told
to sign in to the network rather than to flip a toggle that would not help.

**The Quad100 probe is content-verified.** A captive portal can answer plain HTTP for any
address, including `100.100.100.100`, so a bare 200 proves nothing. The response body has
to identify itself as Tailscale.

**The help page suppresses itself briefly.** Pressing Back re-runs the same failing
navigation instantly, and without suppression the tab bounces straight forward again. The
record is in memory on purpose: a worker restart forgets it, which at worst shows one
extra help page and never misses one.

**The client illustration is markup, not a screenshot.** The account row carries the
configured tenant, and overlaying live text on a raster would need pixel-exact positioning
that breaks across zoom, DPI and font fallback.

### A consequence worth knowing

Because there is no host permission for tailnet domains, the help page cannot read the
status code of the app it is retrying. It fetches `no-cors` and treats "did not throw" as
reachable. `res.status` is always `0` here, and an opaque response is a success. That also
covers the SSO bounce, where a redirect to the identity provider proves the app is up.

Do not reintroduce a `res.status < 500` check without also adding the host permissions
back, which would undo the point of the permission model.

## Permissions

```
permissions:      webNavigation, storage
host_permissions: http://100.100.100.100/
```

That is the whole list. `webNavigation` detects the failed navigation, `storage` reads
configuration, and the single host entry allows the local Tailscale check.

## Development

```sh
npm run verify    # drift check, tests, then Chrome-side manifest validation
npm test          # logic tests only
npm run validate  # ask Chrome to parse manifest.json and schema.json
npm run package   # build the upload zip
```

`npm run validate` matters more than it looks. Chrome silently discards any policy value
that fails schema validation, with no error anywhere, so a malformed `schema.json` shows
up only as "Not set" at `chrome://policy` after release. Packing the extension makes
Chrome parse the schema and say what is wrong. This caught a `$ref` that Chrome does not
resolve, which would have broken every copy override while appearing to work.

To see the guidance page without loading the extension, serve the repo and open the
preview harness, which stubs the extension APIs with a sample tenant:

```sh
npm run preview
# http://127.0.0.1:8731/tools/preview.html?state=tailscaleOff
```

The harness defaults to an **unconfigured** install, because that is the path where
missing copy surfaces as a literal `undefined` and where the neutral wording applies. Pass
config explicitly to see a configured tenant:

| Parameter | Effect |
|---|---|
| `state` | `tailscaleOff`, `captivePortal`, `offline`, `appDown` |
| `company` | sets `companyName`, switching to the branded copy |
| `tailnet` | sets `tailnetName` in the illustration |
| `domain` | sets `emailDomain`, rendering `you@domain` |
| `support` | sets `supportUrl`, revealing the escalation button |
| `suffixes` | comma-separated `watchedSuffixes` |
| `target` | the failed URL. Its host is trusted as a suffix so any host previews |
| `error` | the error string in the details footer |

No organisation is hardcoded in the harness. Nothing under `tools/` is packaged.

To test the real extension, load the repository as an unpacked extension from
`chrome://extensions` with developer mode on.

`tools/check.mjs` fails the build if a config key exists in code but not in the
administrator-facing schema, or if the permission set changes. Both are drift that would
otherwise be noticed only after a release.

## Layout

```
manifest.json      MV3 manifest
schema.json        managed storage schema, the administrator contract
src/config.js      config resolution and validation, shared by all surfaces
src/background.js  service worker: detect, classify, redirect
src/help.*         the guidance page
src/options.*      settings for unmanaged installs
tools/             checks, packaging, preview harness (never packaged)
tests/             logic tests
```
