# Policy examples

Ready-to-use configuration for each deployment path. Every file uses the same fictional
tenant, so you can diff them against each other to see what changes per platform.

Replace `EXTENSION_ID_HERE` with the real extension ID from `chrome://extensions`.

| File | Use it for |
|---|---|
| `admin-console-minimal.json` | Google Admin console, **Policy for extensions**. Start here. |
| `admin-console-full.json` | Same field, every setting present, so you can see what exists and delete the rest. |
| `macos-profile.mobileconfig` | macOS MDM. Note the payload type is a per-extension preference domain. |
| `windows-policy.reg` | Windows, under the `3rdparty` registry path. |
| `linux-managed-policy.json` | Linux, `/etc/opt/chrome/policies/managed/`. |

## The shape differs per platform, and getting it wrong is silent

The Admin console and Linux use a `3rdparty` wrapper. **macOS does not.** It reads
extension policy from a preference domain named after the extension:

```
com.google.Chrome.extensions.EXTENSION_ID_HERE
```

A `3rdparty` key in the `com.google.Chrome` domain is read by nobody on macOS. The symptom
is distinctive: ordinary Chrome policies in the same profile apply correctly, while the
extension's section at `chrome://policy` stays empty. No error appears anywhere.

## Verifying

After applying any of these, open `chrome://policy` and find the extension by name.

- Values listed → applied.
- **"Not set"** → the JSON reached Chrome but failed schema validation. Usually a
  misspelled key, or a value of the wrong type such as `"false"` as a string instead of
  a boolean.
- Section present but empty → on macOS, almost always the `3rdparty` mistake above.

A value Chrome accepted but the extension rejected, such as a malformed hostname in
`watchedSuffixes`, shows as applied here. The extension's own options page reports those
separately.

## Full key reference

`admin-console-full.json` carries every supported key. For what each one does, see
[../docs/admin-guide.md](../docs/admin-guide.md), or read `schema.json` in the extension,
which documents every setting and is what Chrome validates against.
