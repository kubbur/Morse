"""Check the installed app's native/web navigation on a disposable CI iPhone simulator."""
import json
import platform
import plistlib
import subprocess
import sys
import tempfile
import time
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from build import MIN_IOS, compile_app, stage


def sim(*args):
    return subprocess.check_output(["xcrun", "simctl", *args], text=True, timeout=240).strip()


def main():
    devices = json.loads(sim("list", "devices", "available", "-j"))["devices"]
    compatible = []
    for runtime, entries in devices.items():
        if ".iOS-" not in runtime:
            continue
        version = tuple(map(int, runtime.split(".iOS-")[1].split("-")))
        if version >= tuple(map(int, MIN_IOS.split("."))):
            compatible.extend((version, "Pro Max" in d["name"], d["udid"]) for d in entries if "iPhone" in d["name"])
    if not compatible:
        raise SystemExit("This runner has no compatible iPhone simulator.")
    device = max(compatible)[2]
    with tempfile.TemporaryDirectory() as temp:
        _, core, app, _ = stage(Path(sys.argv[1]).resolve(), Path(temp))
        with zipfile.ZipFile(sys.argv[2]) as ipa:
            info = plistlib.loads(ipa.read("Payload/Morse.app/Info.plist"))
        info.update(CFBundleSupportedPlatforms=["iPhoneSimulator"], DTPlatformName="iphonesimulator")
        info.pop("DTSDKName", None)
        (app / "Info.plist").write_bytes(plistlib.dumps(info))
        target = f"{platform.machine()}-apple-ios{MIN_IOS}-simulator"
        compile_app(app, core, "iphonesimulator", target, [Path(__file__).with_name("NavigationCheck.m")])
        subprocess.run(["codesign", "--force", "--sign", "-", str(app)], check=True)
        sim("bootstatus", device, "-b")
        sim("install", device, str(app))
        bundle = info["CFBundleIdentifier"]
        result = Path(sim("get_app_container", device, bundle, "data")) / "tmp/navigation-check.txt"
        sim("launch", device, bundle)
        deadline = time.monotonic() + 75
        while time.monotonic() < deadline:
            if result.is_file():
                message = result.read_text()
                print(message)
                return 0 if message.startswith("PASS ") else 1
            time.sleep(.5)
        raise SystemExit("The simulator did not complete the navigation check.")


if __name__ == "__main__":
    sys.exit(main())
