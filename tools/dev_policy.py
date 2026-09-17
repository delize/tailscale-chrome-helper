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
    parser.add_argument(
        "--id",
        action="append",
        help=(
            "extension ID, from chrome://extensions or the Web Store console URL. Repeat or "
            "comma-separate to configure several IDs from one profile, which is what you want "
            "while the same extension exists as both an unpacked build and a store install: "
            "policy is keyed by ID, and those two IDs differ."
        ),
    )
    parser.add_argument("--config", help="JSON file of settings (default: a sample tenant)")
    parser.add_argument(
        "--probe",
        action="store_true",
        help=(
            "Also set ShowHomeButton, a harmless built-in Chrome policy, as a canary. If it "
            "appears at chrome://policy with source Platform then Chrome is reading this "
            "file and the problem is specific to extension policy. If it does not appear, "
            "Chrome is ignoring the file entirely."
        ),
    )
    args = parser.parse_args()

    ext_dir = Path(args.dir).resolve()
    if args.id:
        ext_ids = [i.strip() for entry in args.id for i in entry.split(",") if i.strip()]
    else:
        ext_ids = [unpacked_extension_id(ext_dir)]

    if args.config:
        config = json.loads(Path(args.config).read_text())
    else:
        config = SAMPLE

    system = platform.system()
    out_dir = REPO / "dist-policy"
    out_dir.mkdir(exist_ok=True)

    print(f"Extension directory : {ext_dir}")
    print("Extension IDs       : " + ", ".join(ext_ids))
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
        # macOS does NOT use the "3rdparty" key. That is the Windows registry and Linux
        # JSON convention. Chromium's macOS policy loader reads component policy from a
        # separate preference domain per extension, "com.google.Chrome.extensions.<id>",
        # with the policy keys at the top level of that domain. A 3rdparty key in the
        # Chrome domain is read by nobody and fails silently, which is exactly what it
        # looks like: real Chrome policies apply while every extension section stays empty.
        # One payload per extension ID. Each ID is its own preference domain, so the same
        # settings have to be stated once per ID rather than shared.
        payloads = [
            {
                "PayloadType": f"com.google.Chrome.extensions.{eid}",
                "PayloadVersion": 1,
                "PayloadIdentifier": f"org.local.tailnet-helper.dev.{eid}",
                "PayloadUUID": payload_uuid if i == 0 else str(uuid.uuid4()),
                "PayloadDisplayName": f"Tailnet Connection Helper settings ({eid[:8]}…)",
                "PayloadEnabled": True,
                **config,
            }
            for i, eid in enumerate(ext_ids)
        ]

        if args.probe:
            # Canary: a built-in Chrome policy, to confirm the profile is read at all.
            payloads.append(
                {
                    "PayloadType": "com.google.Chrome",
                    "PayloadVersion": 1,
                    "PayloadIdentifier": "org.local.tailnet-helper.dev.chrome",
                    "PayloadUUID": str(uuid.uuid4()),
                    "PayloadDisplayName": "Chrome canary policy",
                    "PayloadEnabled": True,
                    "ShowHomeButton": True,
                }
            )
            # A second extension would go here, as its own payload keyed by its own ID.
            # This shape was used as a control while working out that macOS wants a
            # preference domain per extension rather than the 3rdparty key, and it is left
            # as a worked example. Uncomment and substitute a real extension ID and one of
            # its documented settings to push policy to something else in the same profile.
            # Note it writes policy to an extension you may not own, so only do this
            # deliberately and on a machine you are testing on.
            #
            # payloads.append(
            #     {
            #         "PayloadType": "com.google.Chrome.extensions.EXTENSION_ID_HERE",
            #         "PayloadVersion": 1,
            #         "PayloadIdentifier": "org.local.tailnet-helper.dev.other",
            #         "PayloadUUID": str(uuid.uuid4()),
            #         "PayloadDisplayName": "Another extension",
            #         "PayloadEnabled": True,
            #         "someSettingFromItsSchema": True,
            #     }
            # )

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
            "PayloadContent": payloads,
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
        payload = {"3rdparty": {"extensions": {eid: config for eid in ext_ids}}}
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
        # Linux does use the 3rdparty wrapper, unlike macOS. Extension settings are not
        # top-level keys in the policy file.
        target = out_dir / f"{ext_ids[0]}.json"
        target.write_text(
            json.dumps(
                {"3rdparty": {"extensions": {eid: config for eid in ext_ids}}}, indent=2
            )
            + "\n"
        )
        print(f"Wrote {target}")
        print()
        print("Install it:")
        print("  sudo mkdir -p /etc/opt/chrome/policies/managed")
        print(f'  sudo cp "{target}" /etc/opt/chrome/policies/managed/')
        print()
        print("Restart Chrome and check chrome://policy.")
        print()
        print("Remove it again:")
        print(f"  sudo rm /etc/opt/chrome/policies/managed/{ext_ids[0]}.json")

    elif system == "Windows":
        target = out_dir / "policy.reg"
        lines = ["Windows Registry Editor Version 5.00", ""]
        # One key block per extension ID. This used to write only ext_ids[0] and drop the
        # rest with no warning, while the script had already printed every ID as
        # configured. A Windows contributor testing an unpacked build alongside a store
        # install got exactly the half-applied policy the flag exists to prevent.
        for eid in ext_ids:
            lines.extend(_reg_block(eid, config))
        target.write_text("\r\n".join(lines) + "\r\n", encoding="utf-16")
        print(f"Wrote {target}")
        print()
        print("Install it by double-clicking, or:")
        print(f'  reg import "{target}"')
        print()
        print("Restart Chrome and check chrome://policy.")
        print()
        print("Remove it again:")
        for eid in ext_ids:
            print(
                r"  reg delete "
                rf'"HKEY_LOCAL_MACHINE\SOFTWARE\Policies\Google\Chrome\3rdparty\extensions\{eid}" /f'
            )

    else:
        print(f"Unsupported platform: {system}")
        return 1

    return 0


def _reg_block(ext_id, config):
    """The registry lines for one extension ID. Windows does use the 3rdparty wrapper."""
    key = rf"HKEY_LOCAL_MACHINE\SOFTWARE\Policies\Google\Chrome\3rdparty\extensions\{ext_id}\policy"
    lines = [f"[{key}]"]
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
    lines.append("")
    return lines


if __name__ == "__main__":
    raise SystemExit(main())
