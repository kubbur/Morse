# Morse

Morse code listening and sending practice for Mac and the web.

[Open the web app](https://morse.kubbur.digital/) · [Latest release](https://github.com/kubbur/Morse/releases/latest) · [Project page](https://kubbur.github.io/Morse/)

## Downloads

| App or guide | Download |
| --- | --- |
| **Morse for Mac 1.0.0** | [Apple Silicon](https://github.com/kubbur/Morse/releases/latest/download/Morse-1.0.0-mac-arm64.zip) · [Intel](https://github.com/kubbur/Morse/releases/latest/download/Morse-1.0.0-mac-x64.zip) |
| **Morse Paddle 1.4.0** | [Universal Mac app](https://github.com/kubbur/Morse/releases/latest/download/Morse-Paddle-Mac.zip) |
| **Paddle and converter assembly guide** | [PDF with BOM and wiring diagrams](https://github.com/kubbur/Morse/releases/latest/download/DIY-Morse-Paddle-and-Mac-Converter-Guide.pdf) |

Both apps require macOS 13 or later. Unzip the download and move the app into **Applications**.

Morse works offline and saves progress locally. Use **Saved progress → Export / Import** to move a save between the Mac app and website.

The apps are not notarized by Apple. If macOS blocks them, follow [Apple’s instructions for opening the app](https://support.apple.com/en-us/102445).

## Using a paddle

Morse Paddle is a separate app that connects a physical paddle to the trainer.

1. Connect the paddle and passive adapter to the Mac. Open Morse Paddle, allow Microphone access and leave both paddles released during calibration.
2. Enter the trainer address below in Morse Paddle and click **Link**.
3. Open **Send** in the trainer and connect.

| Trainer | Address |
| --- | --- |
| Morse.app | `http://127.0.0.1:37473` |
| Web app | `https://morse.kubbur.digital` |

See the [Morse Paddle guide](Source/Integration.md) for calibration, sidetone and text entry settings.

## Hardware

[Printed parts (OBJ)](morsefull.obj) are included in this repository. The assembly PDF above covers the paddle, passive converter, wiring and checks. Test the converter before gluing the lid.

## Source

- [`desktop/`](desktop/) — trainer source, tests and Mac packaging. [Build instructions](desktop/README.md).
- [`Source/`](Source/) — Morse Paddle companion. [Build and integration instructions](Source/README.md).
- [Trainer source ZIP](https://github.com/kubbur/Morse/releases/latest/download/Morse-1.0.0-source.zip).
