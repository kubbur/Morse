# Morse Paddle

Move **Morse Paddle.app** into your Applications folder. Launch **Morse Paddle** from Spotlight, or select it in Shortcuts’ **Open App** action. Quit the old Terminal tester before starting the app. The first time the wired adapter is detected, allow microphone access and leave both paddles released for about 1.4 seconds.

Turn on **Swap dit and dah** beneath the paddle indicators to exchange the two sides. The indicators, sidetone, typing, and web trainer all use this choice. If you switch while holding a paddle, release both before starting with the new layout. The app saves the setting for the next launch.

The adapter carries the left 1 kHz and right 1.6 kHz sensing tones. The sidetone starts at 650 Hz and 30 WPM. **Automatic** follows the selected Mac speakers or Bluetooth output. When macOS switches its default to the wired adapter, Automatic prefers the last active Bluetooth output that is still connected, then connected AirPods, then the Mac speakers. You can also choose **Mac speakers** or a named Bluetooth device. Explicitly choosing disconnected headphones keeps the sidetone quiet until they return. Closing the window keeps the app running. Use ⌘Q to quit.

**Paddle volume** controls the sidetone from 0% to 100%. At 0% the paddle still senses contacts, sends them to the trainer and can type. To hear music and the paddle together, select the same speakers or AirPods for your music in macOS and for the sidetone in Morse Paddle.

## Connection and movement sensitivity

The top line shows **Adapter disconnected** or **Adapter connected** from the Mac’s wired input and output. Once a press and release has been seen on this connection, it also shows **paddle signal seen**. A passive paddle can be unplugged at the converter while the Mac still detects the adapter. Press and release either paddle to check its live indicator.

If moving the converter lights both indicators, or a tap appears to stay down, choose **Calibrate input…**. Each measurement lasts about two seconds.

1. Leave both paddles up, click **Measure**, and gently move the converter and cable as you normally would.
2. Hold either paddle alone and measure. Release it and measure the other paddle alone.
3. Hold both paddles together and measure. When the app confirms calibration, release both to resume.

The app measures movement, cross-talk, single presses and squeezes. It sets a separate press and release level for each switch. If movement produces the same signal as a real press, it asks you to repeat the measurements and keeps the previous calibration. Calibration suspends input to the trainer and typing until both paddles are released.

Start at the usual sensing level. For a weak return, the first step offers **Boost wired sensing tones by 6 dB**. It doubles the outgoing pilot amplitude on the wired adapter. **Paddle volume** still controls what you hear on speakers or AirPods. A boost can help against a fixed input noise floor. Leakage that rises with the pilots also gets louder.

Successful calibration saves both the thresholds and the selected sensing level for this wired audio device pair. Repeat calibration if you change the adapter or the Mac’s wired output level. **Use automatic levels** restores normal pilot drive and measures the released input again.

## Speed, pitch and envelope

| Control | Settings |
| --- | --- |
| Character speed | 5–60 WPM. This sets the duration of dits, dahs and gaps inside each character. |
| Farnsworth spacing | Turn this on to set a slower effective WPM. The decoder allows longer pauses between letters and words. At 30 character WPM and 12 effective WPM, a dit lasts 40 ms, the letter gap is 594 ms and the timed word gap is 1.39 s. |
| Sidetone pitch | Slide or enter 200–2,000 Hz. The wired sensing tones stay at 1 kHz and 1.6 kHz. |
| Tone envelope… | Set rise and fall independently from 1–30 ms. Crisp sets both to 2 ms, Balanced to 5 ms and Soft to 10 ms. Select a raised-cosine, linear or exponential curve and preview a dit or dah at the current speed. |

The default envelope is Crisp with a raised-cosine curve. A new tone takes the latest settings at its start. When a dit is too short for the requested rise and fall, the keyer shortens both ramps proportionally.

## Type in another app

1. Turn on **Type into focused app**. The first time, allow **Morse Paddle** in **System Settings → Privacy & Security → Accessibility**. The **Settings…** button opens that pane.
2. Click a text field in Notes, a browser or another app and release both paddles. Tap dit once. An `e` should appear. At 0% paddle volume you can do the same check while your music plays.
3. Turn the switch off to return to practice without typing. Typing starts off each time the app opens. When practicing in a trainer that already consumes paddle events, leave this switch off to avoid entering the same answer twice.

**Word spaces** defaults to **Manual**. Pause as long as you like between characters. To insert one space with the paddle, send `.-.-` (dit–dah–dit–dah) as one character. You can also press the keyboard’s Space bar after the previous letter appears. For example, send `....`, then `..`, then `.-.-`, then `-` to type `hi t`.

Choose **Automatic** to insert a space after a timed word gap. That space appears with the next valid character. Farnsworth adjusts these gap thresholds. The explicit paddle space works in either mode.

Typing follows holds and squeezes and supports lowercase a–z, digits, and common punctuation. Switching apps clears unfinished letters. The adapter and the focused text field must be on the same Mac.

## Connect the trainer

1. Copy `Web/morse-paddle.js` beside the trainer’s HTML and include the markup below.
2. Enter the trainer’s HTTPS URL in the Mac app and click **Link**. A local development URL such as `http://localhost:5173` also works.
3. On the trainer page, click **Connect paddle**. In Chrome or Edge, allow access to the local app if the browser asks. The Mac app’s **Open connection test** button opens a working example on the same Mac.

```html
<script type="module" src="./morse-paddle.js"></script>
<morse-paddle-input id="paddle"></morse-paddle-input>
<script type="module">
  const paddle = document.querySelector("#paddle");
  paddle.addEventListener("paddlechange", ({detail}) => {
    const {dit, dah, status, timeMs, wpm, effectiveWpm} = detail;
    // Call the trainer's paddle input handler here. Both switches can be down.
    console.log({dit, dah, status, timeMs, wpm, effectiveWpm});
  });
</script>
```

The receiver reports both switches in one event. Dit alone gives `true, false`, dah alone gives `false, true`, a squeeze gives `true, true`, and release gives `false, false`. Only `status === "ready"` can carry a press. The native sidetone already sounds each element. A trainer that tracks held contacts can route them to its input handler without adding a second audible sidetone.

The receiver releases both contacts on a broken connection, a hidden page or a manual disconnect. Reopening the page connection receives the current state. Native events have a sequence number and a monotonic `timeMs` in milliseconds, suitable for subtracting two timestamps from the same run. Client-generated releases have null timestamps. Held contacts produce one press and one release, regardless of the number of tones the native keyer generates.

For an existing custom button, import `MorsePaddle` from the same module, create an instance, listen for `paddlechange`, and call its `connect()` on click and `disconnect()` on teardown. The element exposes `button` and `status` CSS parts.

The read-only event stream lives at `http://127.0.0.1:17373/events`. The native app accepts browser requests from its own test page and the exact linked origin. A hosted trainer with a Content Security Policy must include this endpoint’s origin in its `connect-src`. Use a top-level Chrome or Edge tab for the hosted trainer if another browser blocks HTTPS-to-loopback requests. The browser and companion run on the same Mac.

With a plain EventSource client, subscribe to the named `paddle` event. This payload shows a dit press.

```json
{"v":1,"seq":42,"status":"ready","dit":true,"dah":false,"timeMs":12345.6,"wpm":30,"effectiveWpm":12}
```

The stream includes `wpm` (character speed) and `effectiveWpm` (Farnsworth speed). Compare the two contact booleans to detect edges. The included receiver assumes 30 WPM for older companions and supplies both speeds on `paddlechange`.

In 1.2.1, connecting or reconnecting gives the current contact state stamped at subscription time, even if the paddle has been idle. A history reset also starts with a fresh snapshot. A speed change carries the time the setting changed. Subsequent contact edges carry their detection times on the same monotonic clock. A trainer can anchor playback to the first snapshot and use timestamp differences to preserve keying rhythm.

## Mute the Mac paddle from the trainer

Morse Paddle 1.3.0 accepts two commands from the linked website. Send an empty HTTP `PUT` to either address. A successful command returns `204 No Content`. Repeating a command is safe.

| Command | Address |
| --- | --- |
| Mute sidetone | `http://127.0.0.1:17373/sidetone/mute` |
| Unmute sidetone | `http://127.0.0.1:17373/sidetone/unmute` |

The included receiver exports `setSidetoneMuted(boolean)`. It sends commands in call order. For example, to let the website play a practice prompt:

```js
import {setSidetoneMuted} from "./morse-paddle.js";

async function playPrompt(playUntilFinished) {
  await setSidetoneMuted(true);
  try {
    await playUntilFinished();
  } finally {
    await setSidetoneMuted(false);
  }
}
```

For a custom receiver, use `await fetch(url, {method: "PUT"})` and check `response.ok`. The browser supplies the origin. Use the same loopback origin as the event stream in the trainer’s `connect-src` policy.

Muting silences the paddle on its selected speakers or headphones. The adapter keeps sensing contacts, the trainer keeps receiving them, and typing continues when enabled. Unmute uses the current **Paddle volume**, including adjustments made while muted. Click **Unmute** in the Mac app to take back control at any time.

The mute applies to the current app session. The Mac releases it when the muting website is unlinked or its last event stream disconnects. A website using commands without an event stream should always send an explicit unmute.

## Rebuild

The app uses only macOS frameworks. To rebuild from the included source on a Mac with Apple Command Line Tools, run `python3 build.py` inside `Source`. The app is written to `Source/build/Morse Paddle.app`.
