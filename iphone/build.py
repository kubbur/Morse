#!/usr/bin/env python3
"""Build a sideloadable Morse IPA from a release source ZIP or repository checkout."""
import argparse
import math
import os
import plistlib
import re
import shutil
import stat
import struct
import subprocess
import sys
import tempfile
import wave
import zipfile
from pathlib import Path, PurePosixPath

KIT = Path(__file__).resolve().parent
MIN_IOS = "26.2"


def write_jack_reference(path):
    # Exactly 1,000 complete cycles in one second at 48 kHz. Only the left channel is driven.
    peak = 32767 * 10 ** (-18 / 20)
    cycle = b"".join(struct.pack("<hh", round(peak * math.sin(math.tau * n / 48)), 0)
                     for n in range(48))
    with wave.open(str(path), "wb") as output:
        output.setparams((2, 2, 48000, 0, "NONE", "not compressed"))
        output.writeframes(cycle * 1000)


def unpack(archive, destination):
    with zipfile.ZipFile(archive) as source:
        size = 0
        seen = set()
        for item in source.infolist():
            path = PurePosixPath(item.filename)
            size += item.file_size
            if (path.is_absolute() or ".." in path.parts or "\\" in item.filename
                    or stat.S_ISLNK(item.external_attr >> 16) or size > 256 * 1024 * 1024):
                raise ValueError("Expected a Morse source ZIP containing regular files.")
            if item.is_dir():
                continue
            key = str(path).casefold()
            if key in seen:
                raise ValueError(f"Duplicate source file: {path}")
            seen.add(key)
            target = destination / path
            target.parent.mkdir(parents=True, exist_ok=True)
            with source.open(item) as reader, target.open("xb") as writer:
                shutil.copyfileobj(reader, writer)


def layout(root):
    def detect(directory):
        native = directory / "Source"
        for desktop in [directory / "desktop", directory]:
            if (native / "MorseEngine.m").is_file() and (desktop / "website/public/js/app.mjs").is_file():
                return native, desktop
    here = detect(root)
    if here:
        return here
    matches = [result for child in root.iterdir() if child.is_dir() and (result := detect(child))]
    if len(matches) != 1:
        raise ValueError("Choose the Morse repository or its full source ZIP. Both Source and website/public are required.")
    return matches[0]


def section(source, start, end):
    if source.count(start) != 1 or source.count(end) != 1:
        raise ValueError(f"This release changed the native audio source near {start!r}. Update the builder before using it.")
    origin = source.index(start)
    return source[origin:source.index(end, origin)].strip()


def stage(source, work):
    import json
    if source.is_file():
        unpack(source, work / "source")
        source = work / "source"
    native, desktop = layout(source)
    version = json.loads((desktop / "package.json").read_text())["version"]
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?", version):
        raise ValueError("Invalid Morse release version.")
    core = work / "Core"
    core.mkdir()
    for name in ["Sidetone.h", "Sidetone.c", "MorseTyping.h", "MorseTyping.c", "MorseEngine.h", "ElementStream.h"]:
        shutil.copyfile(native / name, core / name)
    text = (native / "MorseEngine.m").read_text()
    common = [
        section(text, "enum { MaxBlock =", "static double monotonicSeconds("),
        section(text, "typedef struct { double phase[2], gain;", "static OSStatus speakerRender("),
        section(text, "typedef void (*ContactCallback)", "typedef struct {\n    Detector detector;"),
    ]
    # Expose the mark the release keyer already chose at its original key-down frame.
    down = "emitElement(k->stream,k->epoch,1,frame,k->rate);"
    if common[1].count(down) != 1:
        raise ValueError("The release key-down event changed. Update the iPhone keyer integration.")
    common[1] = common[1].replace(down, "emitElement(k->stream,k->epoch,k->last==1 ? DitStart : DahStart,frame,k->rate);")
    (core / "ReleaseDSP.inc").write_text("\n\n".join(common) + "\n")
    app = work / "Payload/Morse.app"
    web = app / "Trainer"
    shutil.copytree(desktop / "website/public", web)
    write_jack_reference(app / "JackReference.wav")
    for name in ["phone.js", "probe.html", "probe.js", "phone-audio.mjs"]:
        shutil.copyfile(KIT / name, web / name)
    # Both lesson modules import this adapter. Keep the original player for ordinary playback;
    # when the paddle owns the audio session, play the same release timeline on the speaker.
    original = web / "js/audio.mjs"
    original.rename(web / "js/website-audio.mjs")
    original.write_text("export { MorseAudio } from '../phone-audio.mjs';\nexport { renderOffline } from './website-audio.mjs';\n")
    appjs = web / "js/app.mjs"
    appjs.write_text(appjs.read_text().replace("saved on this Mac", "saved on this iPhone"))
    return version, core, app, desktop


def check(core, work):
    executable = work / "hardware-model"
    subprocess.run(["xcrun", "--sdk", "macosx", "clang", "-O2", "-fobjc-arc",
                    "-I", str(core), "-I", str(KIT), str(KIT/"check.c"), str(KIT/"Core.m"),
                    str(core/"MorseTyping.c"), str(core/"Sidetone.c"), "-framework", "Foundation",
                    "-o", str(executable)], check=True)
    subprocess.run([str(executable)], check=True)


def compile_app(app, core, platform, target, extra_sources=()):
    sdk = subprocess.check_output(["xcrun", "--sdk", platform, "--show-sdk-path"], text=True).strip()
    sources = [KIT / name for name in ["App.m","PaddleAudio.m","Website.m","Core.m"]]
    sources += [core / "Sidetone.c", core / "MorseTyping.c", *extra_sources]
    subprocess.run(["xcrun", "--sdk", platform, "clang", "-isysroot", sdk, "-target", target,
                    "-O2", "-fobjc-arc", "-fblocks", "-I", str(core), *map(str,sources),
                    "-framework","UIKit","-framework","CoreGraphics","-framework","Foundation","-framework","AVFoundation",
                    "-framework","AudioToolbox","-framework","WebKit","-framework","Security",
                    "-o", str(app / "Morse")], check=True)


def build(app, core, desktop, version, output):
    sdk_version = subprocess.check_output(["xcrun", "--sdk", "iphoneos", "--show-sdk-version"], text=True).strip()
    if tuple(map(int, sdk_version.split(".")[:2])) < (26, 2):
        raise ValueError("The paddle test requires an iPhoneOS SDK of 26.2 or later.")
    build_version = os.environ.get("GITHUB_RUN_NUMBER", "1")
    info = {"CFBundleDisplayName":"Morse", "CFBundleName":"Morse", "CFBundleExecutable":"Morse",
            "CFBundleIdentifier":"digital.kubbur.morse.iphone", "CFBundlePackageType":"APPL",
            "CFBundleInfoDictionaryVersion":"6.0", "CFBundleShortVersionString":version.split("-")[0],
            "CFBundleVersion":build_version, "MinimumOSVersion":MIN_IOS, "LSRequiresIPhoneOS":True,
            "UIDeviceFamily":[1], "UIRequiredDeviceCapabilities":["arm64"], "UILaunchScreen":{},
            "CFBundleSupportedPlatforms":["iPhoneOS"], "DTPlatformName":"iphoneos", "DTSDKName":"iphoneos"+sdk_version,
            "NSAppTransportSecurity":{"NSAllowsLocalNetworking":True},
            "UISupportedInterfaceOrientations":["UIInterfaceOrientationPortrait","UIInterfaceOrientationLandscapeLeft","UIInterfaceOrientationLandscapeRight"],
            "UIApplicationSceneManifest":{"UIApplicationSupportsMultipleScenes":False,"UISceneConfigurations":{
                "UIWindowSceneSessionRoleApplication":[{"UISceneConfigurationName":"Morse","UISceneDelegateClassName":"MorseScene"}]}},
            "NSMicrophoneUsageDescription":"Morse reads the two electrical paddle tones through your wired adapter.",
            "CFBundleIcons":{"CFBundlePrimaryIcon":{"CFBundleIconFiles":["Icon60"]}}}
    for scale, pixels in [(2,120),(3,180)]:
        subprocess.run(["sips", "-z", str(pixels), str(pixels), str(desktop / "assets/icon.png"),
                        "--out", str(app / f"Icon60@{scale}x.png")], check=True, stdout=subprocess.DEVNULL)
    (app / "Info.plist").write_bytes(plistlib.dumps(info))
    compile_app(app, core, "iphoneos", "arm64-apple-ios"+MIN_IOS)
    # The installer supplies the user's development identity and device provisioning profile.
    subprocess.run(["codesign", "--force", "--sign", "-", str(app)], check=True)
    subprocess.run(["codesign", "--verify", "--strict", str(app)], check=True)
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=output.parent, suffix=".ipa", delete=False) as temp:
        pending = Path(temp.name)
    try:
        with zipfile.ZipFile(pending, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for file in sorted(app.rglob("*")):
                if file.is_file():
                    archive.write(file, file.relative_to(app.parent.parent))
        with zipfile.ZipFile(pending) as archive:
            if archive.testzip() or not {"Payload/Morse.app/Morse","Payload/Morse.app/Trainer/index.html",
                                         "Payload/Morse.app/Trainer/probe.html",
                                         "Payload/Morse.app/JackReference.wav"} <= set(archive.namelist()):
                raise ValueError("IPA validation failed.")
        os.replace(pending, output)
    finally:
        pending.unlink(missing_ok=True)
    print(output)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="Morse checkout, tag source ZIP, or release source ZIP")
    parser.add_argument("--output", type=Path, help="IPA path (default: Morse-VERSION-iPhone.ipa)")
    parser.add_argument("--check", action="store_true", help="stage and run the model test only, using Mac command line tools")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="morse-iphone-") as tmp:
        work = Path(tmp)
        version, core, app, desktop = stage(args.source.resolve(strict=True), work)
        check(core, work)
        if not args.check:
            output = (args.output or Path(f"Morse-{version}-iPhone.ipa")).resolve()
            if output.suffix.lower() != ".ipa" or output == args.source.resolve():
                raise ValueError("Use a separate .ipa output file.")
            build(app, core, desktop, version, output)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, zipfile.BadZipFile, subprocess.CalledProcessError) as error:
        sys.exit(str(error))
