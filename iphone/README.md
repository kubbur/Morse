# Morse for iPhone

In **Actions → Build iPhone app → Run workflow**, enter a Morse source tag or commit. Download the **Morse-iPhone** artifact and unzip it. The IPA is built for arm64 iPhones on iOS 26.2 or later and is ready for signing with a sideloading tool such as AltStore Classic. The build uses no signing credentials. Keep the same Apple account and app identity when installing updates over a test build.

The builder also accepts a repository checkout, a GitHub source archive, or a Morse release source ZIP on a Mac with an iPhoneOS 26.2+ SDK:

```sh
python3 iphone/build.py Morse-1.1.3-source.zip --output Morse-iPhone.ipa
```

Use `--check` to exercise the selected release's detector, iambic keyer, sidetone PCM and scoring events using the macOS command line tools. Temporary staging is isolated from the input source. If the upstream native engine layout changes, the builder stops and identifies the integration point.

The manual workflow accepts any compatible source ref. A change to the builder on main can explicitly request the 1.1.3 build with `[build-iphone]` in its commit message.

## iPhone paddle compatibility

With the tested USB-C headphone adapter and passive converter, build 6 of the `morse-v1.1.3` iPhone port detected all four paddle states (released, left, right and both). **With paddle input working, none of the tested routes produced audible sidetone on the iPhone speaker or AirPods Pro.**

The converter uses the headphone output to sense the paddles. The app sends a continuous 1 kHz tone on the left channel and a 1.6 kHz tone on the right. Pressing a paddle changes the signal returned to the wired microphone. The same keyer uses those contacts for scoring and for the 600 Hz dits and dahs.

- **iPhone speaker (builds 7–9).** Standard multiroute kept the wired mic and jack active. Dual route exposed the speaker and dropped the wired mic. The system-sound test and a later test using a saved speaker address both completed audio callbacks while the paddles worked. The tester heard no keyed sidetone from the speaker.
- **AirPods Pro (build 10).** After selecting AirPods, the USB mic kept recording and the jack disappeared from the active outputs. The meter reading at the paddle plug fell from 0.08 to 0.01 V AC, and both sensing tones fell by more than 35 dB in the mic capture. Only the released state registered after the switch, leaving the keyer with no dits or dahs to play.

A filtered tap from the headphone jack to a small external speaker is an untested option for keeping the sensing tones on the wired route. [Build 10 test procedure](https://github.com/kubbur/Morse/blob/da6474fe470523ac1a2cdf4cf29726c4bd94c907/iphone/README.md#first-phone-test)

## First phone test

1. Install the IPA, then disconnect the phone from the Mac. Attach the USB‑C headphone adapter, converter and paddle.
2. Tap **Test iPhone speaker**, or connect AirPods to the iPhone and tap **Test AirPods**. Allow microphone access and release both paddles during calibration. Morse checks standard multiroute, then dual route if needed. If both lack the requested combination, it checks play-and-record and keeps the wired contacts active when possible.
3. Follow the prompts for left, release, right, release, both and release. The wired microphone captures the converter return while the native stereo player drives 1 kHz and 1.6 kHz into the jack. On a combined route, the keyer sends its audio to the selected listening output. Confirm hearing it there to use that destination in the trainer.
4. **Test paddle contacts only** starts the wired microphone and sensing tones independently of the sidetone test. The contact lights and per-channel tone readings use that capture.
5. Tap **Copy test report**. It includes the routes iOS offered, the wired microphone and stereo output, the listening destination and keyed frames returned by the output queue. If iOS offers only one output, the report identifies the missing combination.
6. Open **Trainer** for the bundled Listen and Send lessons. In **Settings → Input**, select **Audio converter (3.5 mm)** to practise with the physical paddle. The native keyer drives the sidetone and the scorer from one audio-frame clock.

**Measure jack audio** shows live broadband RMS and peak levels for each wired input channel (up to two). The output display shows system volume, returned buffer counts and the digital peaks of the last returned tone buffer.
The audio queues size each buffer for the active iOS I/O cycle. The route display includes the queue size and the ratio of returned output frames to captured input frames after the first second.

Mark released, left, right and both in order. Hold each position until its measurement finishes. The app sends silence, then the 1 kHz left and 1.6 kHz right tones. After the output queue acknowledges each change, the meter discards the first 250 ms and measures the following 250 ms. **Copy test report** includes broadband and tone levels in dBFS for each channel. A null level represents digital zero. If stereo output is unavailable the probe can still measure incoming audio.

**Compare jack output** loops a one-second stereo PCM file through the native iOS player. The left channel carries a 1 kHz sine at −18 dBFS peak and the right channel is silent. With the converter attached to the phone, measure AC volts between tip and sleeve on the free paddle-end plug. Record the playback-only voltage, tap **Enable wired mic**, and measure again at the same iPhone volume. The second phase opens the wired microphone and counts captured frames. Each phase retains its route and system volume in **Copy test report**. The optional voltage fields accept readings from your meter. **Stop tone** ends playback and preserves both results on the screen.

The handset stores practice locally. The shared leaderboard uses the existing website. Score submission and private pairing follow the server's version 2 capabilities. Enable private sync from **Saved progress** to link it to another device. A server offering only the legacy API provides anonymous rankings.
