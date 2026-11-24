# Morse for Mac

Morse 1.1.0 includes the listening and sending trainer and a native paddle engine. Download the Apple Silicon or Intel app for macOS 13 or later. [Downloads and setup](https://github.com/kubbur/Morse/releases/tag/morse-v1.1.0) · [Release notes](RELEASE.md) · [Browser trainer](https://morse.kubbur.digital/)

## Run and build

Use Node.js 24. Run these commands from `desktop/` in the repository or `Morse/` in the source ZIP. Mac builds require the Xcode command-line tools.

```sh
npm ci
npm start
```

`npm start` launches an isolated development profile with hardware disabled. To try private sync and score sharing locally, run `npm run staging` in another terminal. The packaged Mac app saves locally. It has no production leaderboard or private-sync connection.

The web server takes its proxy and edge addresses from `MORSE_TRUSTED_PROXY_IP` and `MORSE_EDGE_IP`. Configure a previous HTTPS origin through `MORSE_LEGACY_ORIGINS` when moving browser saves. If multiple origins are listed, select the source with `MORSE_MOVE_FROM_ORIGIN`.

```sh
npm test
npm run test:native
npm run package:mac
npm run test:smoke
npm run source
npm run verify:release
```

Mac packaging builds both architectures under `dist/`. The smoke test launches the packaged app with a disposable profile, completes lessons, imports and exports progress, and reopens the app. The native suite exercises the keyer and simulated adapter and audio input. Physical paddle response, Bluetooth latency and permission prompts require testing on a Mac with the relevant devices.

The app keeps its packaged trainer at the existing local origin, `http://127.0.0.1:37473`, in the `persist:morse` partition. Electron serves the bundled files directly. The native helper talks to the app over private pipes. The release uses the existing Morse application data directory. Development builds use a separate Morse Development profile. Automatic updates are an opt-in preference on each Mac.

The combined repository uses `.github/workflows/build-mac.yml` at its root. The standalone source ZIP includes its own build workflow. To refresh the bundled trainer, use `node scripts/snapshot.mjs /path/to/morse-website` and review the result.

## Signing

The default macOS build signs ad hoc. For a Developer ID build, configure a Developer ID Application identity and a notarization keychain profile on the build Mac. Set `MORSE_SIGN_IDENTITY` to the identity and `MORSE_NOTARY_PROFILE` to the keychain profile, then run `npm run package:mac`. The build reports the signing result in `dist/darwin-build.json`.

## Data and updates

Practice assets and course data are bundled. The renderer uses a sandbox and context isolation. Local progress and pending requests share a SQLite transaction. Progress exports contain learner data and exclude device credentials. Paddle settings and calibration stay on the Mac.

The running release checks GitHub for the matching product and architecture. An update download is checked against the size and SHA-256 reported by GitHub before the macOS updater verifies the application signature. Closing the last window leaves Morse running. Choose **Quit Morse** to exit.

Electron and Chromium license notices are inside the app. The trainer’s notices are in `website/THIRD-PARTY-LICENSES.md`.
