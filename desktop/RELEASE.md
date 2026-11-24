## What’s new in Morse 1.1.0

- Practise listening and sending offline in one Mac app. Plug in the paddle and choose **Audio converter (3.5 mm)** or **VBand USB adapter** under **Settings → Input**. VBand uses left Control for dit and right Control for dah. You can swap them.
- One native keyer now drives the paddle sidetone, sending scores and typed characters. Choose iambic A or B. The wired audio path can detect clean contacts earlier. End-to-end latency depends on the adapter and output device.
- **Your sending** overlays your marks on the target on a millisecond scale. Correct exercises advance automatically. In unassisted lessons the target appears after grading or when you reveal it.
- Listen and Send share speed, spacing, pitch and volume. Adjust them in **Send → Input and speed**. Paddle calibration, output, envelope and the optional **Write in the focused app** switch are in Settings.
- **Settings → Updates** shows what’s new and checks GitHub for your Mac’s build. Automatic updates are off by default. If macOS cannot apply an update in the app, download the ZIP for your Mac from GitHub.

## Install or upgrade

Requires macOS 13 or later. Choose **arm64** for Apple Silicon or **x64** for Intel. Unzip the download, move **Morse.app** to Applications and open it. These builds use ad hoc signatures. Apple has not notarized them. If macOS asks for approval, follow [Apple’s instructions](https://support.apple.com/en-us/102445).

Before upgrading, open **Saved progress → Export progress** in your current app. Quit Morse and the old Morse Paddle companion before opening 1.1.0. Morse reuses the 1.0.0 desktop profile and imports compatible paddle settings. The audio converter may need Microphone permission and calibration. Enable Accessibility only if you want to type in other apps.

Development builds kept a separate practice profile. To bring that progress into 1.1.0, export it from the development build, then review the import in **Saved progress**. Import replaces the selected learner’s progress.

## Online features and rollback

Version 1.1.0 keeps practice and scores on your Mac. The desktop does not read or upload to the live website leaderboard. Private sync and recovery codes are available only in local testing. Keep a progress export on another device for recovery.

To return to 1.0.0, export any new work, quit Morse, reinstall the previous app and use your pre-upgrade export if needed. The original Mac downloads, separate Paddle app and assembly guide are in the [1.0.0 release](https://github.com/kubbur/Morse/releases/tag/morse-v1.0.0).
