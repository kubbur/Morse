# Morse

Morse code listening and sending practice, online or in an offline Mac app. Use the separate **Morse Paddle** companion to connect a physical paddle through the passive headset adapter.

**[Latest release — both Mac apps, source and PDF](https://github.com/kubbur/Morse/releases/latest) · [Project page](https://kubbur.github.io/Morse/) · [Open the online trainer](https://morse.kubbur.digital/)**

## Choose how to practise

| | What it does | Get it |
| --- | --- | --- |
| **Morse online** | Listening and sending practice in your browser. | [Open the trainer](https://morse.kubbur.digital/) |
| **Morse for Mac** | The trainer in **Morse.app**. Practice works offline; progress stays on your Mac, with import and export. | [Apple Silicon](https://github.com/kubbur/Morse/releases/latest/download/Morse-1.0.0-mac-arm64.zip) · [Intel](https://github.com/kubbur/Morse/releases/latest/download/Morse-1.0.0-mac-x64.zip) |
| **Morse Paddle for Mac** | A separate companion for a wired dual-lever paddle, sidetone, text entry and trainer input. | [Universal Mac download](https://github.com/kubbur/Morse/releases/latest/download/Morse-Paddle-Mac.zip) |

**[Assembly guide and full BOM (PDF)](https://github.com/kubbur/Morse/releases/latest/download/DIY-Morse-Paddle-and-Mac-Converter-Guide.pdf)** — also included in the latest release with both apps.

Both Mac apps require **macOS 13 or later**. In **Apple menu → About This Mac**, an Apple chip means Apple Silicon; an Intel processor means Intel. The desktop trainer is version 1.0.0; the companion is version 1.4.0.

## Install Morse for Mac

1. Download the ZIP for your Mac, unzip it and move **Morse.app** into **Applications**.
2. Open **Morse** and start practising.
3. Use **Saved progress → Export / Import** to back up a save or move it between the desktop app and the website.

The desktop app has its own local save. It does not automatically sync with the website, public leaderboard or device-pairing service. Closing the window leaves the app in the Dock; **Morse → Quit Morse** quits it.

The current downloads are **ad-hoc signed and not Apple-notarized**. See the [latest release notes and verification status](https://github.com/kubbur/Morse/releases/latest). If you trust the download and macOS blocks it, follow [Apple's Open Anyway instructions](https://support.apple.com/en-us/102445); keep system security protections enabled.

## Add a physical paddle

**Morse Paddle remains a separate app.** Install [Morse Paddle.app](https://github.com/kubbur/Morse/releases/latest/download/Morse-Paddle-Mac.zip), open it on the same Mac and connect the passive adapter. Allow Microphone access and release both paddles during calibration.

| Practise in | Address to enter in Morse Paddle |
| --- | --- |
| **Morse.app** | `http://127.0.0.1:37473` |
| **Online trainer** | `https://morse.kubbur.digital` |

Click **Link** in Morse Paddle, then connect from the trainer's **Send** view. The desktop app's Help menu can copy its paddle address. Choose Mac speakers or AirPods in Morse Paddle for sidetone. Optional **Type into focused app** needs Accessibility permission.

Read the [Morse Paddle user and integration guide](Source/Integration.md) for calibration, timing, sidetone and custom trainer integration.

## Build the paddle and converter

- **[Illustrated assembly guide and full BOM (PDF)](https://github.com/kubbur/Morse/releases/latest/download/DIY-Morse-Paddle-and-Mac-Converter-Guide.pdf)** — mechanical assembly, M3 × 10 pivots, wiring diagrams and tests. Test the converter before gluing its lid.
- **[Printable model (OBJ)](morsefull.obj)** — paddle and converter parts.

The guide documents the builder's prototype. Other audio hardware needs its own compatibility checks.

## Source and development

| Folder | Contents | Instructions |
| --- | --- | --- |
| [`desktop/`](desktop/) | Morse desktop app, bundled web trainer snapshot, tests and packaging scripts. | [Desktop development and Mac builds](desktop/README.md) |
| [`Source/`](Source/) | Native Morse Paddle companion and its browser receiver. Existing paths are preserved. | [Companion build and setup](Source/README.md) |
| [`docs/`](docs/) | GitHub Pages project page and assembly PDF. | Served at the [project page](https://kubbur.github.io/Morse/). |

For desktop development, use Node.js 24 and run from `desktop/`:

```sh
npm ci
npm test
npm start
```

The [Mac build workflow](.github/workflows/build-mac.yml) builds and tests both architectures and retains workflow artifacts. It does not automatically publish a release. Download the [supplied 1.0.0 source ZIP](https://github.com/kubbur/Morse/releases/latest/download/Morse-1.0.0-source.zip) for the standalone desktop source, or use this repository for the combined project.

The desktop source contains no saved learner data or server credentials. Generated builds, dependencies, local saves and credentials are excluded from version control. Third-party notices remain in the source and packaged apps.
