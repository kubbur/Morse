# Morse for iPhone

In **Actions → Build iPhone app → Run workflow**, enter a Morse source tag or commit. Download the **Morse-iPhone** artifact and unzip it. The IPA is built for arm64 iPhones on iOS 26.2 or later and is ready for signing with a sideloading tool such as AltStore Classic. The build uses no signing credentials. Keep the same Apple account and app identity when installing updates over a test build.

The builder also accepts a repository checkout, a GitHub source archive, or a Morse release source ZIP on a Mac with an iPhoneOS 26.2+ SDK:

```sh
python3 iphone/build.py Morse-1.1.3-source.zip --output Morse-iPhone.ipa
```

Use `--check` to exercise the selected release's detector, iambic keyer, sidetone PCM and scoring events using the macOS command line tools. Temporary staging is isolated from the input source. If the upstream native engine layout changes, the builder stops and identifies the integration point.

The manual workflow accepts any compatible source ref. A builder commit on `iphone-port` or `main` can request a 1.1.3 build with `[build-iphone]` in its message.

## First phone test

**Keep jack active with AirPods** tests a manual switch in a single Play and Record session. Start with the adapter, converter and paddle connected and **Headphone** selected. Leave the paddles released during calibration. When wired capture is ready, pick your AirPods in Control Center and return to Morse. The app keeps the original sensing player and microphone queue open, records their identities and sample counts, and directs the existing keyer to the selected Bluetooth output. An interruption or backgrounding ends the trial and retains the report.

For an electrical comparison, measure AC voltage from tip to sleeve at the free paddle plug on the same meter range before and after the switch. Enter both readings under **Jack voltage (optional)** and reconnect the paddle. Follow the fresh left, right and squeeze prompts, confirm any keyed 600 Hz sidetone, then tap **Stop and keep report** and **Copy test report**. If steady sensing tones reach the AirPods, mark that separately and use Stop. The report includes the active ports, player channel assignments, retained mic queue, microphone samples after the switch and the returned keyed frames. This diagnostic is separate from the trainer’s saved output.

1. Install the IPA, then disconnect the phone from the Mac. Attach the USB‑C headphone adapter, converter and paddle.
2. Tap **Test iPhone speaker**. For a separate AirPods run, connect them first and tap **Test AirPods**. Allow microphone access. The player sends 1 kHz and 1.6 kHz to the jack while Morse reads the wired mic. Follow the prompts through release, left, release, right, release, both and release.
3. If iOS exposes the listening output, Morse attaches the sidetone queue after wired samples arrive. If only the jack is active, completing the contact sequence advances to dual route. Morse remembers any speaker or Bluetooth output it sees during this run. It can then reopen the wired pair and ask iOS to address that output by its saved identifier, even if the output has disappeared from the active route. **Try next route** skips a trial manually.
4. Repeat the contact prompts when the sidetone starts. Confirm hearing 600 Hz dits and dahs at 15 WPM from the selected destination to use it in the trainer. Use **No sidetone here · try next route** if the controls respond silently. **Copy test report** records the request result, input frames before and after the request, returned keyed frames, the observed contacts and the hearing confirmation. The final play-and-record fallback also checks the wired pair.
5. **Test paddle contacts only** isolates the wired contact lights and input levels. **Test system sounds** exercises the earlier iOS system sound probe with Silent Mode off. **Play reference beep** plays a 900 Hz control. A completed audio callback can occur even when iOS suppresses that sound.
6. Open **Trainer** for the bundled Listen and Send lessons. In **Settings → Input**, select **Audio converter (3.5 mm)** to practise with the physical paddle on a confirmed multiroute output. The native keyer drives the sidetone and scoring from one audio-frame clock.

**Measure jack audio** shows live broadband RMS and peak levels for each wired input channel (up to two). The output display shows system volume, returned buffer counts and the digital peaks of the last returned tone buffer.
The audio queues size each buffer for the active iOS I/O cycle. The route display includes the queue size and the ratio of returned output frames to captured input frames after the first second.

Mark released, left, right and both in order. Hold each position until its measurement finishes. The app sends silence, then the 1 kHz left and 1.6 kHz right tones. After the output queue acknowledges each change, the meter discards the first 250 ms and measures the following 250 ms. **Copy test report** includes broadband and tone levels in dBFS for each channel. A null level represents digital zero. If stereo output is unavailable the probe can still measure incoming audio.

**Compare jack output** loops a one-second stereo PCM file through the native iOS player. The left channel carries a 1 kHz sine at −18 dBFS peak and the right channel is silent. With the converter attached to the phone, measure AC volts between tip and sleeve on the free paddle-end plug. Record the playback-only voltage, tap **Enable wired mic**, and measure again at the same iPhone volume. The second phase opens the wired microphone and counts captured frames. Each phase retains its route and system volume in **Copy test report**. The optional voltage fields accept readings from your meter. **Stop tone** ends playback and preserves both results on the screen.

The handset stores practice locally. The shared leaderboard uses the existing website. Score submission and private pairing follow the server's version 2 capabilities. Enable private sync from **Saved progress** to link it to another device. A server offering only the legacy API provides anonymous rankings.
