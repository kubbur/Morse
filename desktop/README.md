# Morse for Mac

Morse code listening and sending practice for Mac. Works offline and saves progress locally.

**[Downloads and project overview](../README.md) · [Online trainer](https://morse.kubbur.digital/) · [Morse Paddle companion](../Source/README.md)**

This directory is the desktop project root. Run commands from `desktop/` in the combined repository, or `Morse/` in the standalone source ZIP. The active combined-repository workflow is [`../.github/workflows/build-mac.yml`](../.github/workflows/build-mac.yml). The nested workflow is retained for standalone source exports.

## Install

Requires macOS 13 or later. Download the Apple Silicon (`arm64`) or Intel (`x64`) zip, extract it and move **Morse.app** to **Applications**. Open Morse to start.

For paddle input, install and open the separate **Morse Paddle** companion on the same Mac. Enter **http://127.0.0.1:37473** in Morse Paddle, click **Link**, then connect from **Send**. The app's Help menu can copy this address.

The desktop app saves progress on this Mac. It does not connect to the website's public leaderboard or device-pairing service. Use **Saved progress → Export / Import** to move a save between the desktop app and [the website](https://morse.kubbur.digital/). Closing the window keeps the app available in the Dock; **Morse → Quit Morse** closes it completely.

The current downloads are ad-hoc signed and not Apple-notarized. If macOS blocks them, use **System Settings → Privacy & Security → Open Anyway**. Signing and notarization instructions are below.

## Develop

Requires Node.js 24. The repository includes a trainer snapshot under `website/`; no private server configuration or learner data is needed.

```sh
npm ci
npm start
```

```sh
npm test
npm run package:mac
```

Mac packaging creates both architecture builds in `dist/`. By default a Mac host signs them ad-hoc. The included GitHub workflow builds and tests the app on macOS and retains the zip files, build metadata and checksums as workflow artifacts. It does not publish a release automatically.

`npm run test:smoke` tests the packaged app with a temporary save and a simulated Morse Paddle companion. Quit Morse and Morse Paddle before running it; the test deliberately refuses to share their local addresses. It checks playback, grading, export JSON, confirmed import, saving across a full restart, paddle events and sidetone commands. Native save/open dialogs, Finder/Dock behaviour and a physical paddle still need a Mac acceptance test. See the [release notes](https://github.com/kubbur/Morse/releases/latest) for test results and remaining checks.

Run `npm run source` to prepare the GitHub source zip, followed by `npm run verify:release` to check app contents, signatures' structure, architecture, file modes, framework links and checksums. Keep `dist/` out of source control and attach app zips to the corresponding desktop release. Do not replace the combined repository root with a standalone source export. To refresh the included trainer snapshot, run `node scripts/snapshot.mjs /path/to/morse-website` before rebuilding.

## Sign a public Mac release

Use a Mac with a **Developer ID Application** certificate in its keychain. Store notarization credentials with Apple's `notarytool` under a keychain profile; never commit credentials or certificates.

```sh
export MORSE_SIGN_IDENTITY='Developer ID Application: Your Name (TEAMID)'
export MORSE_NOTARY_PROFILE='morse-notarization'
npm run package:mac
```

The build signs nested code, enables the hardened runtime, submits notarization and staples the ticket. `darwin-build.json` reports `developer-id-notarized` only after these steps succeed. Test both architecture builds on Macs before publishing them as a GitHub release.

## Security and data

The app uses a sandboxed renderer with Node integration disabled, context isolation enabled, strict content policy and explicit permission handling. Network requests are restricted to its own loopback server and the three Morse Paddle endpoints. New windows, foreign navigation and device/microphone/camera access are denied. Only locally generated progress JSON files may download. Executable fuses disable Node environment options, Node inspector flags and execution as a general-purpose Node runtime; packaged code must load from ASAR.

The server binds only to `127.0.0.1:37473` and retains the trainer's Host, Origin, import validation and API authentication checks. An occupied port causes a clear startup error; it never adopts an unknown server or silently moves to a different origin. On macOS the persistent save and browser storage live under `~/Library/Application Support/Morse/`. Updating the app does not replace this directory. The existing Delete all my data action removes the application's learning data.

There are no application telemetry, ads, updater downloads or account requirements. The Help menu opens the website only when selected. `website-manifest.json` records the source snapshot; runtime and build dependencies are pinned in `package-lock.json`. Electron's license and Chromium notices are retained in the packaged app, with the trainer's additional notices in `website/THIRD-PARTY-LICENSES.md`.
