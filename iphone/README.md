# Morse for iPhone

In **Actions → Build iPhone app → Run workflow**, enter a Morse source tag or commit. Download the **Morse-iPhone** artifact and unzip it. The IPA is built for arm64 iPhones on iOS 26.2 or later and is ready for signing with a sideloading tool such as AltStore Classic. The build uses no signing credentials. Keep the same Apple account and app identity when installing updates over a test build.

The builder also accepts a repository checkout, a GitHub source archive, or a Morse release source ZIP on a Mac with an iPhoneOS 26.2+ SDK:

```sh
python3 iphone/build.py Morse-1.1.3-source.zip --output Morse-iPhone.ipa
```

Use `--check` to exercise the selected release's detector, iambic keyer, sidetone PCM and scoring events using the macOS command line tools. Temporary staging is isolated from the input source. If the upstream native engine layout changes, the builder stops and identifies the integration point.

The manual workflow accepts any compatible source ref. A change to the builder on main can explicitly request the 1.1.3 build with `[build-iphone]` in its commit message.

## First phone test

1. Install the IPA, then disconnect the phone from the Mac. Attach the USB‑C headphone adapter, converter and paddle.
2. Open **Morse → Start adapter test**, allow microphone access and release both paddles during calibration.
3. Follow the prompts for left, release, right, release, both and release. The 1 kHz and 1.6 kHz sensing signals use the adapter’s stereo output. Its microphone contact carries the return. Confirm hearing the keyed sound from the phone speaker to record a full pass.
4. **Test paddle contacts only** is also available directly from the opening screen. It starts wired microphone capture, then loops the release's 1 kHz left and 1.6 kHz right sensing tones with the same native player used in **Compare jack output**. The contact lights and per-channel tone readings use that capture. **Retry with iPhone speaker** starts a fresh combined test.
5. Tap **Copy test report**. The report includes available and active inputs, the wired microphone request, outputs, captured frames, observed contacts and the speaker result. A contacts-only report also includes the previous speaker route attempt.
6. Open **Trainer** for the bundled Listen and Send lessons. In **Settings → Input**, select **Audio converter (3.5 mm)** to practise with the physical paddle. The native keyer drives the sidetone and the scorer from one audio-frame clock.

**Measure jack audio** shows live broadband RMS and peak levels for each wired input channel (up to two). The output display shows system volume, returned buffer counts and the digital peaks of the last returned tone buffer.
The audio queues size each buffer for the active iOS I/O cycle. The route display includes the queue size and the ratio of returned output frames to captured input frames after the first second.

Mark released, left, right and both in order. Hold each position until its measurement finishes. The app sends silence, then the 1 kHz left and 1.6 kHz right tones. After the output queue acknowledges each change, the meter discards the first 250 ms and measures the following 250 ms. **Copy test report** includes broadband and tone levels in dBFS for each channel. A null level represents digital zero. If stereo output is unavailable the probe can still measure incoming audio.

**Compare jack output** loops a one-second stereo PCM file through the native iOS player. The left channel carries a 1 kHz sine at −18 dBFS peak and the right channel is silent. With the converter attached to the phone, measure AC volts between tip and sleeve on the free paddle-end plug. Record the playback-only voltage, tap **Enable wired mic**, and measure again at the same iPhone volume. The second phase opens the wired microphone and counts captured frames. Each phase retains its route and system volume in **Copy test report**. The optional voltage fields accept readings from your meter. **Stop tone** ends playback and preserves both results on the screen.

The handset stores practice locally. The shared leaderboard uses the existing website. Score submission and private pairing follow the server's version 2 capabilities. Enable private sync from **Saved progress** to link it to another device. A server offering only the legacy API provides anonymous rankings.
