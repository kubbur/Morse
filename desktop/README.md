# Morse for Mac

Morse includes the listening and sending trainer and a native paddle engine. Download the Apple Silicon or Intel app for macOS 13 or later. [Downloads and setup](https://github.com/kubbur/Morse/releases/latest) · [Release notes](RELEASE.md) · [Browser trainer](https://morse.kubbur.digital/)

## Run and build

Use Node.js 24. Run these commands from `desktop/` in the repository or `Morse/` in the source ZIP. Mac builds require the Xcode command-line tools.

```sh
npm ci
npm start
```

`npm start` and installed Dev builds use `https://morse-dev.kubbur.digital`. Installed Stable builds use `https://morse.kubbur.digital`. The installed build determines the host for rankings, private sync, pairing links and live CW. The update channel in Settings selects the next build from GitHub. For loopback testing, run `npm run staging` and `npm start -- --staging` in separate terminals. Development launches disable physical hardware. Packaged practice stays available offline.

The web server takes its proxy and edge addresses from `MORSE_TRUSTED_PROXY_IP` and `MORSE_EDGE_IP`. Configure a previous HTTPS origin through `MORSE_LEGACY_ORIGINS` when moving browser saves. If multiple origins are listed, select the source with `MORSE_MOVE_FROM_ORIGIN`.

To package the Dev website, run `python3 scripts/website-package.py /path/to/deployed-website --dev`. The image sets `MORSE_PUBLIC_ORIGIN=https://morse-dev.kubbur.digital`. Use the Dev container's own persistent data volume and database. Profiles, recovery codes, the leaderboard and live CW rooms belong to that deployment. Configure its reverse proxy to stream room feeds without buffering.

The first Mac Dev build using this hostname starts with a fresh local profile in `Morse Development/morse-dev.kubbur.digital`. Earlier Dev builds keep their saves in the parent directory. To restore existing Dev progress, use a pairing link or recovery code from the Dev service.

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

Morse checks GitHub for the matching product and architecture. The first build that uses Sparkle must be installed manually over 1.1.0. For subsequent updates, Sparkle checks the archive’s Ed25519 signature against the public key embedded in the installed app. An unconfigured development build offers **Download update**. Closing the last window leaves Morse running.

Choose **Settings → Updates → Channel** beside the installed version. **Stable** follows releases from `main`. **Dev** follows signed prereleases from `dev`. Switching checks immediately and opens the installer when a newer signed build is available. When Stable has a lower version, **Download Stable** opens the matching ZIP. The two builds keep their existing separate practice profiles, and the channel choice is remembered across relaunches. Morse 1.1.5 predates the selector. Early testers can start with a Dev download.

Every Mac workflow run on `dev` builds the next patch version with a numbered `-dev.N` suffix for Apple Silicon and Intel. After both jobs pass, run `node scripts/publish-dev.mjs RUN_ID` from `desktop/` on the publishing Mac. It downloads that run’s archives, verifies their hashes and versions, signs their update feeds with the existing Keychain key, and publishes a GitHub prerelease pinned to the tested commit. Testers receive the build once publication succeeds.

Stable builds embed the release public key in `assets/sparkle-public-key.txt`. The development and test builds can use `MORSE_UPDATE_PUBLIC_KEY_FILE` for a separate key. The optional `MORSE_SPARKLE_ARCHIVE` selects an offline copy of the pinned SDK.

The publisher’s Mac holds the private Ed25519 key in the login Keychain under the Sparkle service and account `digital.kubbur.morse`. Keep an encrypted recovery copy under the publisher’s control. After verifying the final arm64 and x64 ZIPs in `dist/`, run the following from `desktop/` on that Mac.

```sh
xcrun swiftc -O scripts/sparkle-key.swift -o build/MorseReleaseKey
node scripts/appcast.mjs --keychain
```

The helper returns the public key or an archive signature. The appcast tool verifies both signatures and checks the public key, version, bundle identifier and feed URL inside each ZIP. Attach both XML feeds and the exact ZIPs to the same stable GitHub release. The integration test `node tests/sparkle-upgrade.mjs` installs a signed update and checks the restored progress in an isolated macOS fixture.

## Website cutover

The existing site can return rankings to this Mac build. Private linking and score uploads activate when the same origin serves `GET /api/v2/capabilities` with protocol 2. Once available, open **Saved progress → Enable private sync → Pair another device** in the browser that has the desired progress. Paste the link in **Saved progress** on the Mac, join, compare the codes and approve in the browser. The browser can then generate a recovery code. Work lost before the server receives it cannot be recovered from the server.

Before switching the running site:

1. Build a separately tagged container with the existing deployment Dockerfile, replacing `server.mjs`, `lib/` and `public/` with this candidate. Keep the existing reverse proxy, hostname and original container image. The current deployment mounts its database at `/data/sync.sqlite`.
2. Identify the live database and its backup destination. Pause writes for the final copy. With Node 24, run `node scripts/backup.mjs snapshot DATABASE BACKUP_PARENT` and `node scripts/backup.mjs restore SNAPSHOT_DIRECTORY NEW_DIRECTORY`. Both steps validate SQLite and the restore verifies its checksum. Retain the original volume. Give the candidate its own writable volume containing the restored `trainer.sqlite` and set its `MORSE_SYNC_PATH` accordingly.
3. Check the restored profile and leaderboard counts and historical XP locally. In an isolated copy, pair a browser and Mac, earn distinct results on both, retry one submission, and recover into an empty profile. Once approved, switch traffic and check public rankings and the capabilities response. Previously open browser tabs need to reload. They keep unsent progress locally.
4. For rollback, stop new writes and snapshot the candidate volume. Switch traffic back to the original image and original volume. Keep both snapshots. Work accepted only by the candidate needs reconciliation before resuming writes on the old service. Keep public rankings disabled during rollback until the serving version filters hidden callsigns and honours the latest visibility choices.

A live backup still needs a host-specific schedule, retention and a restore from an off-host copy. The included restore tests use disposable databases.

Electron and Chromium license notices are inside the app. The trainer’s notices are in `website/THIRD-PARTY-LICENSES.md`.
