# Privacy policy

**Tailnet Connection Helper** collects nothing.

## Data collected

None is sent anywhere. The extension has no analytics, no telemetry, no error reporting
and no backend. It does not create an account or identify the user, and it makes no
request that carries anything about you.

One optional setting stores data locally, on your own device, and never sends it. See
**Data stored** below.

## Data transmitted

The extension makes exactly two kinds of outbound request, neither of which carries user
data:

1. **A local connectivity check** to `http://100.100.100.100/`, Tailscale's magic IP. This
   never leaves the device. The response is read only to confirm it is the Tailscale page
   rather than something else answering, because a captive portal can reply to any
   address.
2. **A captive portal check** to a public no-content endpoint, by default
   `http://connectivitycheck.gstatic.com/generate_204`. It carries no identifiers and no
   reference to the site the user was visiting. It exists only to tell "the VPN is off"
   apart from "this network wants a sign-in", and it is plaintext because a captive portal
   cannot answer an encrypted one. An administrator can point it at their own endpoint.

   While a guidance page is open it repeats on the poll interval, 2.5 seconds by default,
   for as long as that page stays open. It stops when the page is closed.

The address of the site a user failed to reach is handled entirely inside the browser. It
is passed to the extension's own guidance page so it can offer a retry link, and it is
never sent anywhere.

## Data stored

In Chrome's extension storage, on this device:

- Settings an administrator applied through Chrome policy, which are read-only.
- Settings the user entered on the options page, in `chrome.storage.sync`.
- A per-tab count of failed attempts for a given address, in `sessionStorage`, which
  exists so a repeat failure can offer a support link. It is discarded when the tab closes.
- **If an administrator turns on `recordUnwatchedHosts`**, which is off by default: a count
  of failed navigations to tailnet hosts outside the configured list, in
  `chrome.storage.local` under the key `unwatchedHosts`. Each entry is a hostname, a count,
  and first-seen and last-seen timestamps. Only `*.ts.net` hostnames are recorded, never
  ordinary browsing, and only navigations that failed. At most 200 are kept, entries older
  than 90 days are discarded, and turning the setting off deletes the record. It is never
  transmitted anywhere by this extension; it exists so a fleet tool on the same machine can
  read it locally.

## Permissions

`webNavigation` detects failed navigations. Chrome describes this permission to users as
"Read your browsing history", and that description is accurate: the extension is told the
address of every page you navigate to. It **transmits none of them, ever.**

It acts on almost none of them. The exceptions, both off by default and both limited to
navigations that failed against a `*.ts.net` host:

- `suggestCorrectTailnet` lets it offer a correction when you land on a tailnet that is not
  your organisation's. That means looking at tailnet hosts outside the configured list.
- `recordUnwatchedHosts` counts those same failures locally, as described above. This is
  the only setting that causes any address to be stored.

What it cannot do is read the pages themselves. It holds no host permissions for any
website, so it cannot see page content, cookies, form data or anything you type.

`storage` reads the configuration. The two host permissions,
`http://100.100.100.100/` and `http://connectivitycheck.gstatic.com/`, cover the local
Tailscale check and the captive portal probe respectively.

## Contact

Raise an issue on the project's repository.
