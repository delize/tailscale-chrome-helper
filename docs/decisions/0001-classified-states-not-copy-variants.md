---
type: decision
id: 0001
status: accepted
date: 2026-09-16
domain: architecture
context: home
systems: [chrome-extension, tailscale]
source_repo: github.com/delize/tailscale-chrome-helper
project: tailscale-chrome-helper
---

# Distinct classified states, not copy variants

## Context

The extension classifies a failed navigation and renders a guidance page from a per-state
block of copy: a pill, a headline, a lede and a list of steps, every one of them
overridable by an administrator through the `strings` object in policy. Before this change
there were four states: `tailscaleOff`, `captivePortal`, `offline`, `appDown`.

`appDown` means Tailscale is connected but the app did not answer. Its copy tells the user
that nothing they do will help and points them at the support route. That is right when a
host is genuinely down. It is wrong when the user typed a name that does not exist on
their tailnet, because it tells them to report a problem that is theirs to fix, and it
sends a ticket to IT that should never have been raised.

Issue #2 asked for that case to be separated, and left the shape open: a new state, or a
variant of the existing one.

## Options considered

**A. A copy variant of `appDown`.** Keep four states and swap some strings based on the
error code. No new entry in `STATES`, no schema change, no documentation churn. Cheapest
by a wide margin if the difference really is only wording.

**B. Distinct states.** Add `nameNotFound`, and `wrongTailnet` alongside it for the
related case in issue #3. Each costs an entry in `STATES`, a block in `schema.json`, a row
in the admin guide, an entry in the full policy example, a `PILL_TONE` mapping and a slot
in the options preview list. All six are enforced by drift guards in `tools/check.mjs`, so
the cost is real and recurring.

## Decision

Option B.

The difference is not wording. `nameNotFound` hides the illustration, because showing
someone how to connect Tailscale directly contradicts a headline telling them Tailscale is
already connected. It changes which controls appear. It changes escalation, since
`appDown` offers the support link immediately while `nameNotFound` deliberately does not,
the user being the one who can fix it. A variant would have needed conditionals on every
one of those, scattered through the render path, which is exactly the shotgun surgery the
state table exists to prevent.

The deciding argument is the admin contract. `strings` is a declared schema, and Chrome
silently discards anything that does not conform, so every overridable string must have
its own declared home. A variant would have shared `appDown`'s schema block, which means
an administrator could not reword the name-not-found copy without also rewording the
app-is-down copy. Separate states give separate, declared override points. That is the
entire reason the copy layer is shaped this way, so collapsing two situations into one
block would have undermined the thing the design is for.

## Consequences

Six states, and a seventh costs edits in six places. That is accepted deliberately: the
drift guards turn a missed edit into a build failure rather than a page that renders
`undefined`, and `NEUTRAL` spreads `BRANDED` so a new state cannot render empty copy even
if someone forgets.

The same reasoning produced a later change on this branch. `offline` was still showing the
Tailscale illustration, contradicting its own first instruction to check the network,
because three separate places decided whether to show it and none of them decided for
`offline`. That is now a single `ILLUSTRATION_HELPS` allow list. The lesson generalises:
when states differ structurally rather than textually, encode the difference once, in a
table, rather than as conditionals spread across the render path.

Closes #2 and #3.
