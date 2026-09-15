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
   `https://www.gstatic.com/generate_204`. It is sent `no-cors` with no identifiers, no
   cookies of interest and no reference to the site the user was visiting. It exists only
   to tell "the VPN is off" apart from "this network wants a sign-in". An administrator
   can point this at their own endpoint.

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

`webNavigation` detects failed navigations. `storage` reads the configuration. The single
host permission for `http://100.100.100.100/` allows the local Tailscale check. The
extension requests no access to tailnet domains or any other website, so it cannot read
the pages a user visits.

## Contact

Raise an issue on the project's repository.
