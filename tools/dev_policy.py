#!/usr/bin/env python3
"""Generate a real Chrome policy file so managed storage can be tested without a
Google Admin console.

There are two layers worth testing and they exercise different code:

  1. The options page writes to chrome.storage.sync. That covers rendering, validation
     and the guidance page, and needs nothing but a loaded extension.
  2. Actual policy writes to chrome.storage.managed. Only this covers precedence over
     user settings, the locked fields on the options page, and the rejected-value
     report. That is what this script sets up.

It never installs anything itself. It writes the file into the build directory and
prints the command for you to run, because installing a policy needs administrator
rights and that decision is yours.
"""

import argparse
import hashlib
import uuid
import json
import platform
import plistlib
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
BUNDLE = "com.google.Chrome"


def unpacked_extension_id(path: Path) -> str:
    """Chrome derives an unpacked extension's ID from its absolute path.

    SHA256 the path, take the first 16 bytes, and map each nibble onto 'a' through 'p'.
    Verify against chrome://extensions before trusting it: the path must match exactly,
    so a moved or renamed directory produces a different ID.
    """
    digest = hashlib.sha256(str(path).encode("utf-8")).digest()[:16]
    return "".join(chr(ord("a") + (b >> 4)) + chr(ord("a") + (b & 0xF)) for b in digest)


SAMPLE = {
    "companyName": "Acme",
    "watchedSuffixes": ["acme.ts.net"],
    "tailnetName": "Acme",
    "emailDomain": "acme.com",
    "supportUrl": "https://help.acme.com/tailscale",
}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dir",
        default=str(REPO / "dist"),
        help="the directory you loaded unpacked (default: dist/)",
    )
    parser.add_argument("--id", help="extension ID, if you would rather paste it from chrome://extensions")
    parser.add_argument("--config", help="JSON file of settings (default: a sample tenant)")
    args = parser.parse_args()

    ext_dir = Path(args.dir).resolve()
    ext_id = args.id or unpacked_extension_id(ext_dir)

    if args.config:
        config = json.loads(Path(args.config).read_text())
    else:
        config = SAMPLE

    system = platform.system()
    out_dir = REPO / "dist-policy"
    out_dir.mkdir(exist_ok=True)

    print(f"Extension directory : {ext_dir}")
    print(f"Extension ID        : {ext_id}")
    if not args.id:
        print("                      (derived from the path; confirm at chrome://extensions)")
    print(f"Settings            : {json.dumps(config, indent=2)}")
    print()

    if system == "Darwin":
        # A configuration profile is the supported route on current macOS. Hand-placing a
        # file in /Library/Managed Preferences works on older systems but that directory is
        # meant to be managed by profiles, and on a machine that has never had one it may
        # not exist at all and may be ignored if created by hand.
        payload_uuid = str(uuid.uuid4())
        profile_uuid = str(uuid.uuid4())
        profile = {
            "PayloadType": "Configuration",
            "PayloadVersion": 1,
            "PayloadIdentifier": "org.local.tailnet-helper.dev",
            "PayloadUUID": profile_uuid,
            "PayloadDisplayName": "Tailnet Connection Helper (local testing)",
            "PayloadDescription": "Local development policy. Remove when finished testing.",
            "PayloadOrganization": "Local testing",
            "PayloadScope": "System",
            "PayloadRemovalDisallowed": False,
            "PayloadContent": [
                {
                    "PayloadType": "com.google.Chrome",
                    "PayloadVersion": 1,
                    "PayloadIdentifier": "org.local.tailnet-helper.dev.chrome",
                    "PayloadUUID": payload_uuid,
                    "PayloadDisplayName": "Chrome extension policy",
                    "PayloadEnabled": True,
                    "3rdparty": {"extensions": {ext_id: config}},
                }
            ],
        }
        profile_path = out_dir / "tailnet-helper-dev.mobileconfig"
        profile_path.write_bytes(plistlib.dumps(profile))
        print(f"Wrote {profile_path}")
        print()
        print("RECOMMENDED. Install it as a configuration profile:")
        print(f'  open "{profile_path}"')
        print("  Then System Settings > General > Device Management, and approve it.")
        print("  Quit Chrome fully and reopen, then check chrome://policy.")
        print()
        print("  Remove it from that same Device Management pane when finished.")
        print()
        print("-" * 70)
        print("ALTERNATIVE, if you would rather not install a profile:")
        print()

        # Chrome reads managed-storage values from the 3rdparty key of its managed
        # preferences domain. Values must be the real JSON types, not strings.
        payload = {"3rdparty": {"extensions": {ext_id: config}}}
        target = out_dir / f"{BUNDLE}.plist"
        target.write_bytes(plistlib.dumps(payload))
        print(f"Wrote {target}")
        print()

        live = Path(f"/Library/Managed Preferences/{BUNDLE}.plist")
        if live.exists():
            print("STOP. Chrome already has a managed preferences file on this machine:")
            print(f"  {live}")
            print()
            print("That usually means your employer manages Chrome through MDM. Copying over")
            print("it would wipe those policies, and MDM would fight to put them back. Merge")
            print("the 3rdparty key into the existing file by hand, or test on a machine that")
            print("is not managed, rather than running the command below.")
            print()

        print("  The directory usually does not exist on a machine without MDM, so it has")
        print("  to be created first. Chrome may still ignore a hand-placed file.")
        print(f'  sudo mkdir -p "/Library/Managed Preferences"')
        print(f'  sudo cp "{target}" "/Library/Managed Preferences/{BUNDLE}.plist"')
        print("  sudo killall cfprefsd")
        print()
        print("Then fully quit and reopen Chrome, and check chrome://policy.")
        print("Look under 'Extension policies'. A value showing 'Not set' reached Chrome")
        print("but failed schema validation.")
        print()
        print("Remove it again:")
        print(f'  sudo rm "/Library/Managed Preferences/{BUNDLE}.plist"')
        print("  sudo killall cfprefsd")

    elif system == "Linux":
        target = out_dir / f"{ext_id}.json"
        target.write_text(json.dumps({ext_id: config}, indent=2) + "\n")
        print(f"Wrote {target}")
        print()
        print("Install it:")
        print("  sudo mkdir -p /etc/opt/chrome/policies/managed")
        print(f'  sudo cp "{target}" /etc/opt/chrome/policies/managed/')
        print()
        print("Restart Chrome and check chrome://policy.")
        print()
        print("Remove it again:")
        print(f"  sudo rm /etc/opt/chrome/policies/managed/{ext_id}.json")

    elif system == "Windows":
        target = out_dir / "policy.reg"
        key = rf"HKEY_LOCAL_MACHINE\SOFTWARE\Policies\Google\Chrome\3rdparty\extensions\{ext_id}\policy"
        lines = ["Windows Registry Editor Version 5.00", "", f"[{key}]"]
        for name, value in config.items():
            if isinstance(value, bool):
                lines.append(f'"{name}"=dword:{1 if value else 0:08x}')
            elif isinstance(value, int):
                lines.append(f'"{name}"=dword:{value:08x}')
            elif isinstance(value, str):
                lines.append(f'"{name}"="{value}"')
            else:
                # Lists and objects go in as JSON strings on Windows.
                encoded = json.dumps(value).replace("\\", "\\\\").replace('"', '\\"')
                lines.append(f'"{name}"="{encoded}"')
        target.write_text("\r\n".join(lines) + "\r\n", encoding="utf-16")
        print(f"Wrote {target}")
        print()
        print("Install it by running the .reg file as Administrator, then restart Chrome")
        print("and check chrome://policy.")

    else:
        print(f"Unsupported platform: {system}")
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
