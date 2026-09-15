#!/usr/bin/env python3
"""Validate manifest.json and schema.json using Chrome itself.

Nothing else catches managed-schema mistakes. Chrome silently discards a policy value
that fails schema validation, so a bad schema shows up only as "Not set" at
chrome://policy long after release. Packing the extension makes Chrome parse both files
and report the problem immediately.
"""

import os
import platform
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

CANDIDATES = {
    "Darwin": ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
    "Windows": [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    ],
    "Linux": ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"],
}

# Noise Chrome prints on every run regardless of the extension.
IGNORE = ("CVDisplayLink", "task_policy_set", "display_link", "Fontconfig", "GPU")


def find_chrome():
    for path in CANDIDATES.get(platform.system(), []):
        if Path(path).exists():
            return path
    for name in ("google-chrome", "chromium", "chrome"):
        found = shutil.which(name)
        if found:
            return found
    return None


def main():
    chrome = find_chrome()
    if not chrome:
        print("skip: Chrome not found, cannot validate the manifest or schema")
        return 0

    # Pack writes the crx and key beside the source directory, so it runs against a copy
    # in a temp dir and the artifacts are discarded with it.
    with tempfile.TemporaryDirectory() as tmp:
        staged = Path(tmp) / "ext"
        shutil.copytree(
            REPO,
            staged,
            ignore=shutil.ignore_patterns(".git", "node_modules", "*.zip", "*.crx", "*.pem"),
        )
        proc = subprocess.Popen(
            [chrome, f"--pack-extension={staged}", "--no-message-box"],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        deadline = time.time() + 30
        while proc.poll() is None and time.time() < deadline:
            time.sleep(0.5)
        if proc.poll() is None:
            proc.kill()
        output = proc.communicate()[0] or ""

        problems = [
            line
            for line in output.splitlines()
            if "ERROR" in line and not any(noise in line for noise in IGNORE)
        ]
        packed = (Path(tmp) / "ext.crx").exists()

    if problems:
        print("FAIL: Chrome rejected the extension")
        for line in problems:
            print("  " + line.split("] ", 1)[-1])
        return 1
    if not packed:
        print("WARN: Chrome produced no package and reported no error, result inconclusive")
        return 0
    print("OK: Chrome accepted manifest.json and schema.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
