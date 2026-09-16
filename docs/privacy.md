# Privacy policy

**Tailnet Connection Helper** sends nothing anywhere. It has no analytics, no telemetry,
no error reporting and no backend, and it never creates an account or identifies the user.

It does handle information about your browsing, because that is the entire feature. The
sections below separate three different things, which are easy to confuse and are not the
same claim.

| | Default | With `recordUnwatchedHosts` on |
|---|---|---|
| **Handled**, meaning seen and acted on | Addresses of failed navigations | Same |
| **Stored** on your device | Nothing about where you went | Hostnames ending in `ts.net` that failed |
| **Transmitted** anywhere | Nothing | Nothing |

## What it handles

Chrome tells this extension the address of every navigation that fails, through the
`webNavigation` permission. It uses that address to decide whether the failure involves a
tailnet host worth explaining, and to render the address on the guidance page so you can
retry it.

Google's Chrome Web Store policy calls this web browsing activity, and requires it to be
disclosed whether or not anything is written down or sent. So it is disclosed here, on the
extension's options page, and on the guidance page itself whenever the extension is
storing anything.

It acts on almost none of what it is told. It ignores every navigation that succeeded,
every frame that is not the top one, and every host outside the configured list, with two
exceptions that are both off by default and both limited to `*.ts.net`:

- `suggestCorrectTailnet` lets it offer a correction when you land on a tailnet that is not
  your organisation's. That means looking at tailnet hosts outside the configured list. It
  stores nothing.
- `recordUnwatchedHosts` counts those same failures locally, described below.

What it cannot do is read the pages themselves. It holds no host permissions for any
website, so it cannot see page content, cookies, form data, or anything you type.

## What it stores

In Chrome's extension storage, on this device:

- Settings an administrator applied through Chrome policy, which are read-only.
- Settings you entered on the options page, in `chrome.storage.sync`.
- A per-tab count of failed attempts for a given address, in `sessionStorage`, so a repeat
  failure can offer a support link. It is discarded when the tab closes.

By default nothing about where you went is written down.

**If an administrator turns on `recordUnwatchedHosts`**, which is off by default, the
extension additionally keeps a count of failed navigations to tailnet hosts outside the
configured list, in `chrome.storage.local` under the key `unwatchedHosts`. Each entry is a
hostname, a count, and first-seen and last-seen timestamps.

Only `*.ts.net` hostnames are recorded, never ordinary browsing, and only navigations that
failed. At most 200 are kept, entries older than 90 days are discarded, and turning the
setting off deletes the record. It is never transmitted by this extension. It exists so a
fleet tool already running on the same machine can read it locally.

While that setting is on, the guidance page says so. That notice is built into the
extension and cannot be removed by policy.

## What it transmits

Three kinds of outbound request, none of them carrying user data:

1. **A local connectivity check** to `http://100.100.100.100/`, Tailscale's magic IP. This
   never leaves the device. The response is read only to confirm it is the Tailscale page
   rather than something else answering, because a captive portal can reply to any address.
2. **A captive portal check** to a public no-content endpoint, by default
   `http://connectivitycheck.gstatic.com/generate_204`. It carries no identifiers and no
   reference to the site you were visiting. It exists only to tell "the VPN is off" apart
   from "this network wants a sign-in", and it is plaintext because a captive portal cannot
   answer an encrypted one. An administrator can point it at their own endpoint.

   While a guidance page is open it repeats on the poll interval, 2.5 seconds by default,
   and stops when the page is closed or the poll timeout is reached.
3. **A second connectivity check**, by default `http://detectportal.firefox.com/success.txt`,
   made **only when the first one fails**. It carries no identifiers and no reference to the
   site you were visiting, and nothing is read from the response beyond whether anything
   answered at all.

   It exists so that a network blocking one endpoint is not reported to you as having no
   network. Without it, a firewall rule looked identical to an unplugged cable. An
   administrator can point it at their own endpoint, and it is never contacted when the
   first check succeeds.

The address of the site you failed to reach is handled entirely inside the browser. It is
passed to the extension's own guidance page so it can offer a retry, and it goes nowhere
else.

There is deliberately no reporting endpoint. Sending the stored counts to an administrator
was considered and declined, so that the claim above stays absolute rather than
conditional.

## Permissions

`webNavigation` detects failed navigations. Chrome describes this permission to users as
"Read your browsing history", and that description is fair: the extension is told the
address of every page you navigate to. It transmits none of them.

`storage` reads the configuration and holds the optional local count.

The two host permissions, `http://100.100.100.100/` and
`http://connectivitycheck.gstatic.com/`, cover the local Tailscale check and the captive
portal probe respectively. There is no host permission for any website.

## Contact

Raise an issue on the project's repository.
