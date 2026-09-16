# Chrome Web Store listing

The answers to give in the Developer Dashboard, and why. Kept in the repo because the
dashboard is not version controlled and the reasoning behind a disclosure is exactly the
thing that gets lost.

## Single purpose

Detect failed navigations to Tailscale tailnet hosts and show connection guidance in place
of Chrome's error page.

## Permission justifications

| Permission | Justification |
|---|---|
| `webNavigation` | Detects that a navigation failed and reads the error code, which is the trigger for the whole extension. No host permissions are needed for this, which is why watched domains can live in policy instead of the manifest. |
| `storage` | Reads administrator configuration from managed storage, user settings from sync storage, and holds the optional local count. |
| `http://100.100.100.100/` | Reads Tailscale's local status page to confirm the client is running. The body is checked for the word Tailscale, because a captive portal can answer any address with a 200. |
| `http://connectivitycheck.gstatic.com/` | Distinguishes "no internet" from "a captive portal wants a sign-in". Plaintext because a portal cannot answer an encrypted request. Carries no identifiers. Configurable. |

There is no host permission for any website, so the extension cannot read page content,
cookies, or form data.

## Data disclosure

Tick **Web browsing activity**. Do not tick anything else.

This surprises people, so the reasoning is worth stating. Google defines that category as
"any information about the websites or other web resources a user requests or interacts
with, including the domains or URLs the browser interacts with", and defines handling as
"collecting, transmitting, using, or sharing user data". The extension is told the address
of every failed navigation and uses it, so the category applies on every install even with
every optional setting off and even though nothing is stored or sent by default.

The FAQ closes the obvious escape route directly: disclosure is required "even when data is
processed or stored locally on a user's device and is not transmitted to external servers
or third parties". So `recordUnwatchedHosts` being local-only does not exempt it either.

Certifications, all of which hold:

- Not being sold or transferred to third parties, outside the approved use cases. Nothing
  is transferred anywhere at all.
- Not being used or transferred for any purpose unrelated to the single purpose.
- Not being used or transferred to determine creditworthiness or for lending.

## Prominent disclosure

Policy states the disclosure "must not be located only in a privacy policy, terms of
service, or similar document". `docs/privacy.md` alone is therefore not sufficient, so the
extension carries it in the interface:

- The options page always shows what the extension handles, on every install.
- The guidance page shows a second line whenever `recordUnwatchedHosts` is on, because that
  is the only setting that writes anything down.

Both come from the `DISCLOSURE` constant in `src/config.js`, which is deliberately not a
configurable key and not part of `strings`. An administrator can reword every other string
on the page and cannot touch these. `tools/check.mjs` fails the build if that stops being
true.

## Privacy policy

Publish `docs/privacy.md`. It separates what is handled, what is stored and what is
transmitted, because collapsing those three into one sentence is how the previous version
of that file came to be wrong.

## Sources

- https://developer.chrome.com/docs/extensions/develop/concepts/network-requests
- https://developer.chrome.com/docs/webstore/program-policies/user-data-faq
