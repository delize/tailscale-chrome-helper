# Administrator guide

This extension is configured entirely through Chrome policy. There is no per-tenant
build, and nothing is hardcoded to any one organisation.

## What it does

It watches navigations that fail with a network error. When the host matches a domain you
have listed, it replaces Chrome's "This site can't be reached" page with guidance that
names your organisation and explains how to reconnect. It then rechecks on its own and
returns the user to the app once the connection is back.

It distinguishes four situations rather than assuming the first one:

| State | Meaning |
|---|---|
| `tailscaleOff` | Tailscale is not connected. The common case. |
| `captivePortal` | Something is intercepting traffic, so a wifi sign-in is pending. |
| `offline` | Nothing is reachable at all. |
| `appDown` | Tailscale is connected but the app itself did not answer. |

Telling these apart matters. Advising someone to flip the Tailscale toggle is wrong when
the real block is an unsigned-in hotel network.

## Deploying

1. In the Google Admin console, go to **Devices > Chrome > Apps & extensions > Users &
   browsers**, and select the organisational unit.
2. Add the extension by ID and set **Installation policy** to *Force install*.
3. Paste your configuration into the **Policy for extensions** field.

### Minimum useful configuration

```json
{
  "companyName": "Acme",
  "watchedSuffixes": ["acme.ts.net"],
  "tailnetName": "Acme",
  "emailDomain": "acme.com",
  "supportUrl": "https://help.acme.com/tailscale",
  "showInstallLink": false
}
```

`showInstallLink` is false here because a managed fleet already has Tailscale deployed.
Telling those users to go and install it sends them somewhere they cannot act, and the
support link is the useful route instead. Leave it true only if people install the client
themselves.

Use this flat shape. Some vendors document a wrapped form (`{"key": {"Value": "x"}}`)
carried over from the Windows registry. This extension expects the flat form, and the
wrapped form will be discarded.

## Deploying without the Admin console

If you push policy by MDM or by hand rather than through the Admin console, the structure
differs per platform. Getting it wrong fails silently: `chrome://policy` shows the
extension's section with **"No policies set"** and nothing anywhere reports an error.

**macOS.** Each extension gets its own preference domain named after its ID, with the
settings as top-level keys:

```
com.google.Chrome.extensions.EXTENSION_ID_HERE
```

macOS does **not** use the `3rdparty` key. That is a Windows and Linux convention, and a
`3rdparty` key in the `com.google.Chrome` domain is read by nobody. The symptom is
distinctive: ordinary Chrome policies in the same profile apply correctly while every
extension section stays empty.

A configuration profile payload looks like this:

```xml
<key>PayloadType</key>
<string>com.google.Chrome.extensions.EXTENSION_ID_HERE</string>
<key>companyName</key>
<string>Acme</string>
<key>watchedSuffixes</key>
<array><string>acme.ts.net</string></array>
```

**Windows.** Registry values under:

```
HKLM\Software\Policies\Google\Chrome\3rdparty\extensions\EXTENSION_ID_HERE\policy
```

**Linux.** A JSON file in `/etc/opt/chrome/policies/managed/`, using the `3rdparty`
wrapper:

```json
{ "3rdparty": { "extensions": { "EXTENSION_ID_HERE": { "companyName": "Acme" } } } }
```

`tools/dev_policy.py` in this repository generates the right shape for whichever platform
you run it on, and is the fastest way to test a configuration before rolling it out.

### Confirming it took

Chrome validates your JSON against the schema the extension ships and **silently discards
anything that does not conform**, including keys that are not defined. There is no error
message.

On a managed device, open `chrome://policy`, find the extension under its ID, and check
the values. A key showing **"Not set"** means your JSON reached the browser but failed
validation. The usual causes are a misspelled key, the wrapped shape above, or a value of
the wrong type.

Policy changes apply without a browser restart.

## Settings

| Key | Type | Default | Notes |
|---|---|---|---|
| `enabled` | boolean | `true` | Set false to leave Chrome's error page alone without uninstalling. |
| `companyName` | string | unset | Used in the heading, the steps and the illustration. |
| `watchedSuffixes` | array | `["ts.net"]` | Domains to act on. Anything else is ignored. |
| `tailnetName` | string | unset | Shown under the account row in the illustration. |
| `emailDomain` | string | unset | Renders the example account as `you@acme.com`. Illustrative only. |
| `supportUrl` | string | unset | Escalation link. `https`, `mailto` or `slack` only. Hidden when unset. |
| `supportLabel` | string | `Ask IT` | Text on the escalation button. |
| `checkingLabel` | string | `Checking your connection` | Status shown while the first connection check is still running. |
| `showInstallLink` | boolean | `true` | Set false where Tailscale is deployed by MDM, so users are not told to install it themselves. |
| `tailscaleDownloadUrl` | string | Tailscale's download page | Offered only when Tailscale is not running, and only if `showInstallLink` is true. |
| `openAppUrl` | string | unset | Link offered when the icon cannot be found. Accepts `tailscale:` or `https:`. Off by default, see below. |
| `openAppLabel` | string | `Open Tailscale` | Text of that link. |
| `connectHelpUrl` | string | unset | Link to your own runbook. |
| `controlUrl` | string | `http://connectivitycheck.gstatic.com/generate_204` | Captive portal probe. Must be **http**, see below. |
| `portalUrl` | string | `http://neverssl.com/` | Plaintext page offered as a button to force a portal sign-in screen. |
| `logoDataUrl` | string | unset | `data:image/...` only, max 256 KB. Remote URLs are rejected. |
| `bannerDataUrl` | string | unset | Banner across the top of the card. `data:image/...` only, max 1 MB. |
| `accentColor` | string | unset | Button and link colour, 3 or 6 digit hex such as `#4a63d8`. |
| `probeTimeoutMs` | integer | `1500` | Clamped to 200 to 30000. |
| `targetTimeoutMs` | integer | `4000` | Clamped to 200 to 30000. |
| `pollIntervalMs` | integer | `2500` | Clamped to 500 to 60000. |
| `suppressMs` | integer | `8000` | Clamped to 0 to 120000. |
| `askItAfterAttempts` | integer | `2` | Clamped to 1 to 20. |
| `strings` | object | unset | Copy overrides, see below. |

### Watched domains

`watchedSuffixes` matches a host exactly or as a parent domain. With `acme.ts.net` set,
`acme.ts.net` and `back-office.acme.ts.net` both match. `other.ts.net` does not, and
neither does `evilacme.ts.net`.

Entries must be real hostnames with at least two labels. Values like `localhost` or
`co.uk` are rejected as too broad. If every entry is rejected the default is kept, so a
typo never leaves the extension watching nothing silently.

Leaving this unset watches all of `ts.net`, which is reasonable for a small deployment but
means the page also appears for tailnets that are not yours.

### Branding

Three keys control appearance. All of them are optional and the page looks deliberate
without any of them.

```json
{
  "accentColor": "#4a63d8",
  "logoDataUrl": "data:image/png;base64,iVBORw0KGgo...",
  "bannerDataUrl": "data:image/png;base64,iVBORw0KGgo..."
}
```

Images must be `data:` URIs rather than URLs. That is not an arbitrary restriction: this
page is shown to someone whose network is already failing, so anything it had to fetch
would be the thing most likely to be missing. Encode the file rather than linking it.

```sh
# macOS or Linux
printf 'data:image/png;base64,%s' "$(base64 -i logo.png | tr -d '\n')"
```

`accentColor` accepts plain hex only, not `rgb()` or named colours. The page is dark, so
pick something that reads against a dark background. The rest of the palette is fixed,
which keeps a mis-set colour from producing an unreadable page.

### Identity providers and SSO

A tailnet app usually answers by redirecting to an identity provider on a different
domain, such as Okta, Entra or Ping. That is expected and needs no configuration. This
extension only ever navigates back to the original `ts.net` address the user asked for,
and where the app forwards them afterwards is the browser's business. A redirect to your
IdP is treated as proof the app is reachable, not as a failure.

One case does need a setting. If your identity provider is itself only reachable over the
tailnet, add its hostname to `watchedSuffixes` alongside your tailnet:

```json
{ "watchedSuffixes": ["acme.ts.net", "login.internal.acme.com"] }
```

Without that, a failed navigation to the IdP falls outside the watch list and the user
gets Chrome's plain error page. Do not add a public IdP such as `okta.com` this way. It is
reachable without Tailscale, so a failure there is a real outage and the guidance would be
wrong.

### Launching the client, and why it is off by default

`openAppUrl` can put a link in the first step for users who cannot find the Tailscale icon.
It is **unset by default**, and that is deliberate.

Tailscale registers the `tailscale://` scheme, so it looks like an obvious way to open the
client. It is not. The scheme serves signed deeplinks only. Both `tailscale://` and
`tailscale://connect` launch the app, which then rejects them with:

> The signing request could not be authenticated: Unable to verify deeplink

Tested on macOS, both forms. There is no unsigned URL that simply opens the app, so the
default is no link rather than a button that produces an error dialog.

Set it only if you have something that works in your environment, such as an MDM
self-service page that launches or repairs the client. An `https:` URL is usually the
right shape. If you do set a `tailscale:` URL, test the whole path on a real device first.

Worth knowing either way: Chrome's permission prompt names the requesting origin, and for
an extension that is the raw extension ID rather than a friendly name. Users find that
alarming without warning.

### Captive portals, and why the probe is plaintext

`controlUrl` must be an `http://` URL. This is not an oversight. A captive portal cannot
intercept an `https://` request without presenting a certificate the browser rejects, so
an https probe can only ever fail, and a failure is indistinguishable from being offline.
Over plaintext the portal answers, and that answer is the signal.

The default endpoint returns `204 No Content`. Anything else, a redirect or a login page
served with a 200, is read as interception. If you override it, use a plaintext endpoint
that returns 204 and nothing else. Pointing it at a URL that redirects, such as an
internal health check behind SSO, will report every user as being behind a portal.

`portalUrl` is the page offered to the user as a button when a portal is detected. Loading
any plaintext page is what makes the sign-in screen appear, which is what
`http://neverssl.com/` exists for. Point it at your own plaintext page if you prefer.

### Rewriting the copy

`strings` replaces wording per state. Override only what you need, the rest keeps its
default.

```json
{
  "strings": {
    "tailscaleOff": {
      "pill": "VPN not connected",
      "headline": "{company} apps need the VPN",
      "lede": "{host} could not be reached from this device.",
      "steps": [
        "Open the Tailscale icon in your menu bar and switch it on.",
        "Still stuck? Contact the service desk."
      ]
    }
  }
}
```

Each state accepts these fields. All are optional; anything you leave out keeps its
default.

| Field | Shown |
|---|---|
| `pill` | The status chip at the top of the page. |
| `headline` | The main heading. |
| `lede` | The sentence under the heading. |
| `steps` | The numbered instructions, as an array of strings. |
| `pillProbing` | Status while the page is checking whether the app answers. `appDown` only. |
| `pillConnected` | Status shown just before the user is returned to the app. `appDown` only. |

Available placeholders: `{company}`, `{host}`, `{error}`, `{tailnetName}`,
`{exampleEmail}` and `{openApp}`. They are inserted as plain text, so markup in a value
appears as literal characters rather than being rendered. `{openApp}` becomes the link
described above, and disappears entirely when `openAppUrl` is unset.

One field is emphasised automatically: the word **toggle** anywhere in a step is bolded,
because it is the word users scan for. That is an English-language assumption, so if you
translate the copy the emphasis will not follow.

The default heading reads "This app is on {company}'s private network". That possessive
reads badly for a name ending in s, and does not translate. Override `headline` in that
case rather than fighting the default.

## Restricting it further

The **Blocked hosts** and **Allowed hosts** fields under *Permissions and URL access* can
narrow what any extension may touch, but they only subtract from what the extension
already declared. They cannot grant access to a host the manifest never requested, so
they are not how you configure watched domains. Use `watchedSuffixes` for that.

They are not needed here in any case. This extension requests no host permissions for
tailnet domains at all.

## Permissions, and why each one exists

| Permission | Reason |
|---|---|
| `webNavigation` | Detects the failed navigation. This permission alone delivers navigation events for all hosts, which is what lets your domain list live in policy instead of in the extension's manifest. Chrome shows it to users as "Read your browsing history". |
| `storage` | Reads the configuration on this page. |
| `http://100.100.100.100/` | Tailscale's local magic IP. Read to confirm the client is actually running. |
| `http://connectivitycheck.gstatic.com/` | The captive portal probe. Plaintext by necessity, see above. Carries no user data. |

There are no host permissions for `ts.net` or any tenant domain. The extension cannot read
the content of your internal apps, because it never has access to them.

## Requirements

Chrome 106 or later. The extension filters prerendered navigations using a field added in
that version.

Tailscale 1.64 or later on the device, because the `appDown` state depends on the client
serving its web interface at `100.100.100.100`. On older clients that check always fails,
so a user whose app is genuinely down is told Tailscale is not connected. Detection of the
other three states is unaffected.

## Privacy

No user data leaves the browser. The Tailscale check is a request to a local address. The
captive portal check is a `no-cors` request to a public no-content endpoint that carries
no identifiers and returns no body the extension can read. Nothing is logged or
transmitted anywhere.
