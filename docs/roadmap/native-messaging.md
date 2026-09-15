# Launching the Tailscale client from the guidance page

Status: **research, not committed.** Tracked in
[issue #1](https://github.com/delize/tailscale-chrome-helper/issues/1).

## The problem

Someone opens a tailnet app, Tailscale is disconnected, and the guidance page tells
them to find the client's icon in the menu bar or system tray. If they cannot find
it, that is where they stop. A button that opens the client would close the gap.

## What was tried, and why it failed

`tailscale://`. Tailscale registers the scheme, which makes it look like the obvious
answer. It is not: the scheme serves **signed deeplinks only**.

| URL | Result |
|---|---|
| `tailscale://connect` | App launches, then errors |
| `tailscale://` | App launches, then errors, identically |

Both produce:

> The signing request could not be authenticated: Unable to verify deeplink

Verified on macOS, both forms. There is no unsigned URL that simply opens the app.

Two smaller findings from the same attempt, worth keeping:

- Chrome's permission prompt names the **requesting origin**, and for an extension
  that is the raw extension ID rather than a friendly name. Users find that
  alarming, and there is no way to change it.
- The scheme is worth keeping supported anyway. `openAppUrl` accepts `tailscale:`
  and `https:`, so if a working URL turns up later it needs no code change.

## The only remaining mechanism

Native Messaging. Per Chrome's documentation, extensions **cannot launch arbitrary
programs** — they can only talk to a host that was installed and explicitly
authorised. That means all of:

- `nativeMessaging` permission in the manifest
- A host manifest installed per machine at platform-specific paths: registry keys on
  Windows, fixed directories on macOS and Linux
- A host binary or script that does the launching
- This extension's ID listed in the host's `allowed_origins`, which accepts no
  wildcards

It works, it needs no user prompt, and it is a lot of machinery.

## Why this is not obviously worth building

**The bootstrap problem is the strongest argument against.** Installing a native
messaging host requires MDM. Anything that can MDM-push a host can MDM-push or
repair Tailscale itself. The helper would be solving a problem the deployment
tooling already owns, and charging a second binary to sign, ship, version and
support for the privilege.

**The permission cost is the second.** The extension's current permission story is
three narrow entries, each obviously justified:

```
webNavigation, storage, http://100.100.100.100/, http://connectivitycheck.gstatic.com/
```

`nativeMessaging` is heavy by comparison, and a Chrome Web Store reviewer will
reasonably ask why a "show a better error page" extension wants to talk to a native
binary. That question has a good answer, but it is a question that does not currently
get asked.

## Ask before building

The error message implies a signing mechanism exists. Tailscale may already have a
supported signed-deeplink flow meant for this. If it does, `openAppUrl` accepts it
today with no code change and this document becomes a footnote.

**That question should be asked before any code is written.**

## What ships today instead

Step three of the guidance copy:

> Still nothing? Then Tailscale may not be installed. Look in Applications on macOS,
> or search the Start menu on Windows, and sign in with your {company} account when
> it asks.

Honest, works on every platform, needs no permission, cannot error.

`openAppUrl` remains available and unset. An organisation can point it at an MDM
self-service page, which launches *or repairs* the client and is strictly more useful
than a scheme that only opens it.

## If it is built anyway

Sketch, so the next person does not start cold:

1. Host is a small signed binary per platform, shipped by the same MDM that deploys
   Tailscale.
2. Extension sends one message, `{ "action": "launch" }`. The host launches the
   client and returns success or a reason. It should do nothing else: a host that
   accepts arbitrary commands from a browser extension is a much larger security
   surface than this feature deserves.
3. `openAppUrl` stays the fallback for organisations that will not deploy a host.
4. Gate the whole thing behind a config key that defaults off, the way `openAppUrl`
   already does, so the Web Store build does not carry a permission most installs
   never use.
