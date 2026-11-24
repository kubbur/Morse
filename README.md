# Morse Paddle for Mac

Use a dual-lever Morse paddle on a Mac with a passive TRRS headset adapter. Hear the sidetone through the Mac speakers or AirPods, send timed paddle contacts to a compatible web trainer, or type decoded Morse into the focused app.

**[Project page](https://kubbur.github.io/Morse/) · [Download 1.4.0 for Mac](https://github.com/kubbur/Morse/releases/download/v1.4.0/Morse-Paddle-Mac.zip) · [User and integration guide](Source/Integration.md)**

## Install

1. On an Intel or Apple silicon Mac running macOS 13 or later, expand the release ZIP and move **Morse Paddle.app** to **Applications**.
2. Open the app and connect the passive paddle adapter to the Mac’s headset jack. Grant **Microphone** access and release both paddles during calibration.
3. Choose the sidetone output. For typing, enable **Type into focused app** and grant **Accessibility** access. For a compatible web trainer, enter its address in the app, click **Link**, then connect from the trainer.

Version 1.4.0 is ad-hoc signed and has not been notarized by Apple. macOS may require **Open Anyway** under **System Settings → Privacy & Security** when you first open this download. [Apple’s Gatekeeper guidance](https://support.apple.com/en-us/102445)

## Paddle and audio controls

- Set 5–60 WPM, Farnsworth spacing, sidetone pitch, volume, and the tone envelope.
- Swap dit and dah, see presses and releases, and calibrate a movement-sensitive adapter.
- Use manual or timed word spacing when typing. The web bridge provides timestamped contacts and accepts sidetone mute and unmute commands.

This release supports the passive headset-jack adapter. The Mac app and a web trainer using its loopback connection run on the same computer.

## Build from source

With Apple Command Line Tools and Python 3 installed, run this from the repository root.

```sh
python3 Source/build.py
```

The universal app is built at `Source/build/Morse Paddle.app`. This local build uses ad-hoc signing. The [browser receiver](Source/web/morse-paddle.js) and the [event and control protocol](Source/Integration.md#connect-the-trainer) are included.
