# Morse

Morse code listening and sending practice for Mac and the web.

[Open the web app](https://morse.kubbur.digital/) · [Latest release](https://github.com/kubbur/Morse/releases/latest) · [Project page](https://kubbur.github.io/Morse/)

## Downloads

| File | Download |
| --- | --- |
| **Morse for Mac 1.1.3** | [Apple Silicon](https://github.com/kubbur/Morse/releases/download/morse-v1.1.3/Morse-1.1.3-mac-arm64.zip) · [Intel](https://github.com/kubbur/Morse/releases/download/morse-v1.1.3/Morse-1.1.3-mac-x64.zip) |
| **Paddle and converter assembly guide** | [PDF with BOM and wiring diagrams](https://github.com/kubbur/Morse/releases/download/morse-v1.0.0/DIY-Morse-Paddle-and-Mac-Converter-Guide.pdf) |

Requires macOS 13 or later. Unzip the download and move **Morse.app** to **Applications**. These builds are signed ad hoc. If macOS asks for approval, follow [Apple’s instructions](https://support.apple.com/en-us/102445).

Morse saves progress on your Mac and works offline. Open **Saved progress** to export or import a save. The Mac can display the website leaderboard. Private pairing and score uploads require the website’s version 2 service. [Release notes](desktop/RELEASE.md)

## Using a paddle

Open Morse and go to **Settings → Input**. Choose your adapter.

- **Audio converter (3.5 mm)** uses the Mac’s headset input. Quit the old Morse Paddle app if it is running, allow Microphone access and release both paddles during calibration.
- **VBand USB adapter** uses left Control for dit and right Control for dah. Use **Swap dot and dash contacts** if needed.

Open **Send** to practise. Enable **Write in the focused app** in Settings if you want to type in other applications.

The separate Morse Paddle companion is still available for the browser trainer. [Morse Paddle 1.4.0](https://github.com/kubbur/Morse/releases/download/morse-v1.0.0/Morse-Paddle-Mac.zip) · [Companion setup](Source/Integration.md)

## Hardware

[Printed parts (OBJ)](morsefull.obj) are included in this repository. The assembly PDF above covers the paddle, passive converter, wiring and checks. Test the converter before gluing the lid.

## Source

- [`desktop/`](desktop/) — trainer source, tests and Mac packaging. [Build instructions](desktop/README.md).
- [`Source/`](Source/) — native paddle engine and standalone companion. [Companion build instructions](Source/README.md).
- [Trainer source ZIP](https://github.com/kubbur/Morse/releases/download/morse-v1.1.3/Morse-1.1.3-source.zip) · [Website update ZIP](https://github.com/kubbur/Morse/releases/download/morse-v1.1.3/Morse-1.1.3-web.zip).
