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
- Default to the navigate link on macOS only, hardcoded behind the single `openAppUrl` key. Tried first and dropped in review. The default was invisible to administrators, and a mixed fleet could not give each platform its own link.
- Default to the navigate link on macOS only, through per-platform settings. Chosen.

## Decision

The link gets one setting per platform, so the default is visible in the schema rather than hidden in code. `openAppUrlMac` defaults to `tailscale://navigate/main/devices`. `openAppUrlWindows` and `openAppUrlLinux` default to empty. The existing `openAppUrl` stays, since it shipped in v1.0, and now means "every platform without its own setting". The page uses the platform's own setting if an administrator set it, then `openAppUrl` if set, then the platform default. An empty string is a real value and hides the link instead of falling back to the default. `main/devices` was picked because it is the most neutral screen. The device, exit node and country forms need parameters that make no sense on a guidance page.

## Consequences

- macOS users get a working Open Tailscale link with no configuration.
- An empty `openAppUrl` changed meaning. It used to equal the default and now actively hides the link on every platform without its own setting. The full Admin console example sets every link key so that copying it shows the precedence instead of hiding the link by accident.
- Three new policy keys. Each is checked by the drift guards like any other setting.
- Platform detection reads `navigator.userAgentData.platform`, falling back to `navigator.platform`. ChromeOS and unrecognised platforms use only `openAppUrl`.
- Windows and Linux need testing on a real client, connected and disconnected. If a link works there, it becomes that platform's default with a one-line change.
- Chrome's permission prompt before launching the app still names the raw extension ID.
- Older clients that predate the navigate links may still show the signing error. The minimum client version is unknown.
