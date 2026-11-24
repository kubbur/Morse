"""Build a standalone universal macOS application with the Apple command line tools."""
from pathlib import Path
import shutil
import subprocess
import sys

root = Path(__file__).resolve().parent
destination = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else root / "build"
app = destination / "Morse Paddle.app"
contents = app / "Contents"
resources = contents / "Resources"
binary = contents / "MacOS" / "MorsePaddle"
binary.parent.mkdir(parents=True, exist_ok=True)
resources.mkdir(exist_ok=True)
shutil.copy2(root / "Info.plist", contents / "Info.plist")
shutil.copy2(root / "Paddle.icns", resources / "Paddle.icns")
shutil.copytree(root / "web", resources / "web", dirs_exist_ok=True)
command = ["/usr/bin/xcrun", "clang", "-arch", "arm64", "-arch", "x86_64", "-mmacosx-version-min=13.0",
           "-std=gnu11", "-fobjc-arc", "-fblocks", "-O2", "-Wall", "-Wextra", "-Werror",
           "-Wno-deprecated-declarations"]
for name in ["AppKit", "AVFoundation", "CoreAudio", "AudioToolbox", "AudioUnit", "CoreGraphics"]:
    command.extend(["-framework", name])
command.extend(str(root / name) for name in ["App.m", "MorseEngine.m", "MorseTyping.c", "TypingKeys.m",
                                            "PaddleBridge.m", "Sidetone.c", "TonePanel.m"])
subprocess.run([*command, "-o", str(binary)], check=True)
subprocess.run(["/usr/bin/codesign", "--force", "--sign", "-", "--timestamp=none", str(app)], check=True)
subprocess.run(["/usr/bin/codesign", "--verify", "--deep", "--strict", str(app)], check=True)
print(app)
