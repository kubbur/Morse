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

## iPhone paddle compatibility

With the tested USB-C headphone adapter and passive converter, build 6 of the `morse-v1.1.3` iPhone port detected all four paddle states (released, left, right and both). **With paddle input working, none of the tested routes produced audible sidetone on the iPhone speaker or AirPods Pro.**

The converter uses the headphone output to sense the paddles. The app sends a continuous 1 kHz tone on the left channel and a 1.6 kHz tone on the right. Pressing a paddle changes the signal returned to the wired microphone. The same keyer uses those contacts for scoring and for the 600 Hz dits and dahs.

- **iPhone speaker (builds 7–9).** Standard multiroute kept the wired mic and jack active. Dual route exposed the speaker and dropped the wired mic. The system-sound test and a later test using a saved speaker address both completed audio callbacks while the paddles worked. The tester heard no keyed sidetone from the speaker.
- **AirPods Pro (build 10).** After selecting AirPods, the USB mic kept recording and the jack disappeared from the active outputs. The meter reading at the paddle plug fell from 0.08 to 0.01 V AC, and both sensing tones fell by more than 35 dB in the mic capture. Only the released state registered after the switch, leaving the keyer with no dits or dahs to play.

A filtered tap from the headphone jack to a small external speaker is an untested option for keeping the sensing tones on the wired route. [Build 10 test procedure](https://github.com/kubbur/Morse/blob/da6474fe470523ac1a2cdf4cf29726c4bd94c907/iphone/README.md#first-phone-test)

## Hardware

[Printed parts (OBJ)](morsefull.obj) are included in this repository. The assembly PDF above covers the paddle, passive converter, wiring and checks. Test the converter before gluing the lid.

## Source

- [`desktop/`](desktop/) — trainer source, tests and Mac packaging. [Build instructions](desktop/README.md).
- [`Source/`](Source/) — native paddle engine and standalone companion. [Companion build instructions](Source/README.md).
- [Trainer source ZIP](https://github.com/kubbur/Morse/releases/download/morse-v1.1.3/Morse-1.1.3-source.zip) · [Website update ZIP](https://github.com/kubbur/Morse/releases/download/morse-v1.1.3/Morse-1.1.3-web.zip).
