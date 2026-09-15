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
  "supportUrl": "https://help.acme.com/tailscale"
}
```

Use this flat shape. Some vendors document a wrapped form (`{"key": {"Value": "x"}}`)
carried over from the Windows registry. This extension expects the flat form, and the
wrapped form will be discarded.

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
| `tailscaleDownloadUrl` | string | Tailscale's download page | Offered only when Tailscale is not running. |
| `connectHelpUrl` | string | unset | Link to your own runbook. |
| `controlUrl` | string | `https://www.gstatic.com/generate_204` | Used to detect captive portals. Override if your network blocks it. |
| `logoDataUrl` | string | unset | `data:image/...` only. Remote URLs are rejected. |
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

Available placeholders: `{company}`, `{host}`, `{error}`, `{tailnetName}` and
`{exampleEmail}`. They are inserted as plain text, so markup in a value appears as
literal characters rather than being rendered.

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
| `webNavigation` | Detects the failed navigation. This permission alone delivers navigation events for all hosts, which is what lets your domain list live in policy instead of in the extension's manifest. |
| `storage` | Reads the configuration on this page. |
| `http://100.100.100.100/` | Tailscale's local magic IP. Read to confirm the client is actually running. |

There are no host permissions for `ts.net` or any tenant domain. The extension cannot read
the content of your internal apps, because it never has access to them.

## Privacy

No user data leaves the browser. The Tailscale check is a request to a local address. The
captive portal check is a `no-cors` request to a public no-content endpoint that carries
no identifiers and returns no body the extension can read. Nothing is logged or
transmitted anywhere.
