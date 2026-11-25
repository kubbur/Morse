## What’s new in Morse 1.1.1

- In **Settings → Input**, choose when the next sending signal plays. **Play after a pause** waits 0.5–15 seconds from your last mark, with a 2-second default. At slow spacing speeds, Morse gives you time to finish a word gap. **Wait for E to continue** keeps the result on screen until you press **E** or send one dit. A correct answer advances and a missed answer replays.
- Under **Key input → Paddles · keyboard**, choose the dot and dash keys and show or hide the on-screen paddles. The defaults are **Z** for dot and **X** for dash.
- The **Your sending** display keeps its height as letters and timing feedback appear. **Saved progress** brings the pairing and recovery controls together.
- The Mac can display rankings from the website. Private pairing and score uploads require the site's version 2 service. Offline practice and local progress exports remain available.
- **Settings → Updates** shows what’s new. After this manual upgrade from 1.1.0, Morse can install future updates signed with the Morse release key. Automatic updates are off by default.

## Install or upgrade

Choose **arm64** for Apple Silicon or **x64** for Intel. Both require macOS 13 or later. In your current app, use **Saved progress → Export progress**, then quit Morse. Unzip the download and move **Morse.app** to Applications. Install 1.1.1 manually when upgrading from 1.1.0. These downloads use ad hoc signatures. If macOS asks for approval, follow [Apple’s instructions](https://support.apple.com/en-us/102445).

The release opens your existing Morse profile. Preview builds use a separate profile. To move preview progress, export it there and review the replacement shown under **Saved progress → Import progress**.

## Website package and rollback

The web ZIP contains the browser trainer, server and Docker build files. The live service needs its own deployment. Only progress that reached the server can be recovered from it.

To return to 1.1.0, first export any new progress, then quit Morse and reinstall your previous Mac build. Keep the pre-upgrade export in case you need to restore it. [Morse 1.1.0 downloads](https://github.com/kubbur/Morse/releases/tag/morse-v1.1.0)
