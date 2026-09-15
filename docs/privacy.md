# Privacy policy

**Tailnet Connection Helper** collects nothing.

## Data collected

None. The extension has no analytics, no telemetry, no error reporting and no backend. It
does not create an account or identify the user.

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

Configuration only, in Chrome's extension storage:

- Settings an administrator applied through Chrome policy, which are read-only.
- Settings the user entered on the options page, in `chrome.storage.sync`.
- A per-tab count of failed attempts for a given address, in `sessionStorage`, which
  exists so a repeat failure can offer a support link. It is discarded when the tab closes.

## Permissions

`webNavigation` detects failed navigations. Chrome describes this permission to users as
"Read your browsing history", and that description is accurate: the extension is told the
address of every page you navigate to. It acts on none of them except navigations that
fail against a domain your administrator listed, and it stores and transmits none of them,
ever.

What it cannot do is read the pages themselves. It holds no host permissions for any
website, so it cannot see page content, cookies, form data or anything you type.

`storage` reads the configuration. The two host permissions,
`http://100.100.100.100/` and `http://connectivitycheck.gstatic.com/`, cover the local
Tailscale check and the captive portal probe respectively.

## Contact

Raise an issue on the project's repository.
