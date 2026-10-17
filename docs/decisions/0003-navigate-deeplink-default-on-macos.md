---
type: decision
id: 0003
status: accepted
date: 2026-10-17
domain: architecture
context: home
systems: [chrome-extension, tailscale]
source_repo: github.com/delize/tailscale-chrome-helper
project: tailscale-chrome-helper
---

# Default the Open Tailscale link to the navigate deeplink on macOS

## Context

The guidance page can offer a link that opens the Tailscale client, set by `openAppUrl`. It shipped empty because `tailscale://` and `tailscale://connect` launch the client and then fail with "The signing request could not be authenticated: Unable to verify deeplink". Those links are signed only, and the extension has no way to sign them.

Tailscale then pointed to an unsigned family of links that open the client on a given screen, such as `tailscale://navigate/main/devices`, `tailscale://navigate/main/exit-nodes` and `tailscale://navigate/settings`. On macOS with client 1.104.1, `tailscale://navigate/main/devices` opened with no error. With Tailscale disconnected it opens the Tailscale UI, which is the case the link exists for.

## Options considered

- Keep the empty default everywhere. Safe, but leaves users who cannot find the menu bar icon with nothing to click, even though a working link now exists.
- Default to the navigate link on every platform. Simplest, but Windows and Linux are untested, and an error dialog is worse than no link.
- Build a Native Messaging host. Works everywhere but needs an MDM-deployed binary and the `nativeMessaging` permission. Anything that can deploy it can deploy or repair Tailscale itself.
- Default to the navigate link on macOS only. Chosen.

## Decision

`openAppUrl` defaults to `tailscale://navigate/main/devices` when the browser reports a macOS platform and no value is set by policy or sync storage. Other platforms keep no default. A value an administrator sets applies on every platform, and an empty string now hides the link instead of falling back to the default. `main/devices` was picked because it is the most neutral screen. The device, exit node and country forms need parameters that make no sense on a guidance page.

## Consequences

- macOS users get a working Open Tailscale link with no configuration.
- An empty `openAppUrl` changed meaning. It used to equal the default and now actively hides the link. The full Admin console example was changed to a self-service URL so that copying it does not hide the link by accident.
- Platform detection reads `navigator.userAgentData.platform`, falling back to `navigator.platform`. An unrecognised platform gets no default.
- Windows and Linux need testing on a real client, connected and disconnected. If the link works there, the platform gate can be removed and the Native Messaging roadmap closed.
- Chrome's permission prompt before launching the app still names the raw extension ID.
- Older clients that predate the navigate links may still show the signing error. The minimum client version is unknown.
