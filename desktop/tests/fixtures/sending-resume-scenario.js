(async () => {
  const el = id => document.getElementById(id);
  const tab = view => document.querySelector(`.main-nav [data-view="${view}"]`).click();
  const check = (ok, label) => { if (!ok) throw Error(label); };
  const wait = async (condition, label) => {
    for (let i = 0; i < 100; i++) {
      if (condition()) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw Error(label + ' · ' + el('send-target-label').textContent + ' · ' + el('send-feedback').textContent);
  };
  const change = (id, value) => {
    const input = el(id);
    input.value = String(value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const ready = () => el('send-target-label').textContent === 'SEND' && testPaddleMuted() === false;
  const attempts = () => {
    const state = testState();
    return state.profiles.find(p => p.id === state.activeId).sending.attempts;
  };
  let focused = true, hidden = false;
  Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => focused });
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  const focus = value => {
    focused = value;
    window.dispatchEvent(new Event(value ? 'focus' : 'blur'));
  };
  const visible = value => {
    hidden = !value;
    document.dispatchEvent(new Event('visibilitychange'));
  };
  let plays = 0, finishPlayback;
  const { MorseAudio } = await import('/js/audio.mjs');
  MorseAudio.prototype.play = () => {
    plays++;
    return new Promise(resolve => { finishPlayback = () => resolve({ completed: true }); });
  };
  if (el('callsign-intro-dialog').open) el('skip-callsign').click();
  if (el('guidance-dialog').open) el('guidance-close').click();
  focus(true);
  tab('lab');
  await wait(() => el('sound-choices').textContent.includes('Use Paddle'), 'Saved sound choices');
  el('sound-choices').firstElementChild.click();
  change('send-source', 'paddle');
  change('send-continue-mode', 'manual');
  testPaddleReady();
  tab('send');
  change('send-level', 1);
  const before = attempts();
  el('send-listen').click();
  await wait(() => plays === 1, 'First prompt started');
  focus(false);
  focus(true);
  finishPlayback();
  await new Promise(resolve => setTimeout(resolve, 0));
  check(el('send-target-label').textContent === 'LISTEN FIRST' && testPaddleMuted(), 'Interrupted first playback unlocked sending');
  el('send-listen').click();
  await wait(() => plays === 2, 'Second prompt started');
  change('send-wpm', 26);
  check(el('send-listen').disabled && testPaddleMuted(), 'Slider interrupted prompt playback');
  finishPlayback();
  await wait(ready, 'Finished prompt unlocked the paddle');

  testPaddleElement(0, 0); testPaddleElement(1, 100);
  check(el('sender').classList.contains('is-key-down'), 'First answer started');
  focus(false); visible(false);
  testPaddleElement(2, 140); testPaddleElement(0, 1500);
  const buffered = [[0,1510], [1,1520], [2,1560], [0,2800]].map(([kind, ms]) => testPaddleElement(kind, ms, true));
  visible(true); focus(true);
  await wait(ready, 'Returning to Morse muted a completed prompt');
  buffered.forEach(deliver => deliver());
  // The paddle was held outside Morse. Wait for neutral before accepting a new press.
  testPaddleElement(1, 2810); testPaddleElement(2, 2850); testPaddleElement(0, 3000);
  check(!el('send-decoded').textContent && attempts() === before && plays === 2, 'Background input entered the answer');

  for (const [id, field, value] of [['send-volume','volume',72], ['send-pitch','pitch',850], ['send-wpm','wpm',30], ['send-farnsworth','farnsworth',19]]) {
    el(id).focus();
    change(id, value);
    await wait(() => testSound()?.[field] === value && ready(), id + ' required another Play');
  }
  testPaddleElement(0, 3100); testPaddleElement(1, 3200);
  focus(true);
  check(el('sender').classList.contains('is-key-down'), 'Answer started at the new speed');
  change('send-wpm', 20);
  await wait(() => testSound()?.wpm === 20 && ready(), 'Speed change during an answer muted the paddle');
  testPaddleElement(2, 3250); testPaddleElement(0, 4500);
  check(!el('send-decoded').textContent && attempts() === before, 'Mixed-speed answer was graded');

  testPaddleElement(1, 4600);
  testPaddleReconnect();
  testPaddleReady();
  await wait(() => ready() && el('send-input-status').textContent.includes('Paddle ready'), 'Reconnected output required another Play');
  testPaddleElement(2, 10); testPaddleElement(0, 1400);
  check(!el('send-decoded').textContent && attempts() === before, 'Interrupted route was graded');
  testPaddleElement(1, 1500); testPaddleElement(2, 1560); testPaddleElement(0, 3000);
  await wait(() => attempts() === before + 1 && el('send-capture').dataset.result === 'good', 'Fresh answer after reconnect');
  focus(false); focus(true);
  check(el('send-target-label').textContent === 'ATTEMPT COMPLETE' && attempts() === before + 1 && plays === 2, 'Returning changed the graded result');

  tab('lab'); change('send-continue-mode', 'timed'); change('send-pause', 2); tab('send');
  change('send-level', 1); change('send-farnsworth', 20);
  el('send-listen').click();
  await wait(() => plays === 3, 'Timed prompt started');
  finishPlayback(); await wait(ready, 'Timed prompt finished');
  testPaddleElement(0, 8000); testPaddleElement(1, 8100); testPaddleElement(2, 8160);
  testPaddleElement(0, 10159);
  check(attempts() === before + 1 && plays === 3, 'Timed answer advanced early at 20 WPM');
  testPaddleElement(0, 10160);
  await wait(() => attempts() === before + 2 && plays === 4, '20 WPM did not advance at the selected two-second pause');
  window.testComplete = true;
})().catch(error => { window.testFailure = error.message; });
