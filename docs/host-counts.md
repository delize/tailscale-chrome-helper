# Reading the unwatched-host counts

With `recordUnwatchedHosts` on, the extension keeps a local tally of failed navigations to
tailnet hosts that are **not** on your watched suffixes. It is how you find out that people
keep trying to reach the wrong tailnet.

This extension never transmits it. The counts sit in the browser profile for your own
fleet tooling to read.

## What is recorded, and what is not

Only hosts matching `*.ts.net`. Ordinary browsing is never recorded, and neither are hosts
on your watched suffixes.

Only navigations that **failed**. Chrome reports errors to this extension, not successes,
so a successful visit to another tailnet is invisible here. The counts answer "how often
did someone try to reach another tailnet and it broke", never "how often do people go
there". Do not read them as the latter.

At most 200 hosts are kept. Past that the least recently seen are dropped.

## Storage shape

This is a **contract**. External readers depend on it, so the key and record shape will not
change without the `version` field changing too.

Key: `unwatchedHosts` in `chrome.storage.local`.

```json
{
  "version": 1,
  "hosts": {
    "dashboard.contoso.ts.net": { "count": 4, "firstSeen": 1757900000000, "lastSeen": 1757986400000 },
    "wiki.fabrikam.ts.net":     { "count": 1, "firstSeen": 1757930000000, "lastSeen": 1757930000000 }
  }
}
```

Timestamps are milliseconds since the epoch, from `Date.now()` on the device.

## Where it lives on disk

`chrome.storage.local` is a **LevelDB** store inside the Chrome profile:

```
<profile>/Local Extension Settings/<extension-id>/
```

On macOS the profile is typically
`~/Library/Application Support/Google/Chrome/<Profile>/`.

## Reading it with osquery

osquery cannot read this out of the box. Automatic Table Construction handles SQLite
only, and the `chrome_extensions` table lists installed extensions rather than their
storage. Reading it needs a **custom osquery extension** using the plugin API, which can
register a table backed by anything you can parse, LevelDB included.

Two things to know, neither of them dangerous:

**Copy the directory and read the copy.** LevelDB takes an exclusive lock while Chrome is
running, so a second process cannot open the live store, even to read. Copying is safe and
touches nothing Chrome relies on. The only cost is freshness: the copy may land mid-write
and be a beat behind, so treat a parse failure as "no data this run" rather than an error
worth alerting on.

**The values are JSON, but the store is not.** You need a LevelDB reader, then parse the
value for the `unwatchedHosts` key.

Nothing here writes to the profile. A reader that only copies and parses cannot affect
Chrome or the extension.

If you would rather not write and maintain that, the alternative is a native messaging
host writing a plain SQLite file that ATC can read directly. That needs the same
MDM-deployed binary discussed in issue #1, which is a larger commitment than a read-only
osquery extension.

## Privacy

Turning this on means the browser profile holds a record of tailnet hosts someone tried to
reach and failed. That is a modest amount of data, and it is still a record of intent.
It is off by default for that reason, and it is worth saying so wherever you disclose
monitoring to staff.
