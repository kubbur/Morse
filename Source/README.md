# Morse Paddle for Mac

**Morse Paddle.app** connects a dual-lever paddle and passive CTIA headset adapter to the browser trainer. [Morse for Mac](../desktop/) includes its own paddle engine from version 1.1.0.

**[Download Morse Paddle 1.4.0](https://github.com/kubbur/Morse/releases/download/morse-v1.0.0/Morse-Paddle-Mac.zip) · [User and integration guide](Integration.md) · [Assembly guide (PDF)](https://github.com/kubbur/Morse/releases/download/morse-v1.0.0/DIY-Morse-Paddle-and-Mac-Converter-Guide.pdf)**

## Install and connect

Requires macOS 13 or later on Apple Silicon or Intel. Unzip the download and move **Morse Paddle.app** into Applications. Open it, connect the passive headset adapter, allow Microphone access and leave both paddles released during calibration.

Enter the trainer address and click **Link**:

- **Morse for Mac 1.0.0 only:** `http://127.0.0.1:37473`
- **Online trainer:** `https://morse.kubbur.digital`
- **Custom trainer:** its HTTPS address, or a local development address such as `http://localhost:5173`.

Then connect from the trainer's Send view. The trainer and companion run on the same Mac. Choose Mac speakers or AirPods for sidetone. Optional **Type into focused app** needs Accessibility permission.

Version 1.4.0 is ad-hoc signed and not Apple-notarized. If macOS requires approval, use [Apple's Open Anyway instructions](https://support.apple.com/en-us/102445).

## Build

With Apple Command Line Tools and Python 3 installed, run from the **repository root**:

```sh
python3 Source/build.py
```

The universal app is written to `Source/build/Morse Paddle.app` and signed ad-hoc.

## Integrate a trainer

The browser receiver is [`web/morse-paddle.js`](web/morse-paddle.js). The [integration guide](Integration.md#connect-the-trainer) covers timestamped paddle contacts, linked origins and sidetone mute/unmute. The loopback connection at `http://127.0.0.1:17373` is local to this Mac.
