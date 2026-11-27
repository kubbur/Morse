(async () => {
  const el = id => document.getElementById(id);
  const tab = view => document.querySelector('.main-nav [data-view="' + view + '"]').click();
  const waitMs = ms => new Promise(resolve => setTimeout(resolve, ms));
  const check = (ok, label) => { if (!ok) throw Error(label); };
  const wait = async (check, label) => {
    for (let i = 0; i < 140; i++) { if (check()) return; await waitMs(20); }
    throw Error(label + ' · ' + el('send-feedback').textContent + ' · ' + el('send-instruction').textContent);
  };
  function change(id, value) {
    el(id).value = String(value);
    el(id).dispatchEvent(new Event('input', { bubbles: true }));
    el(id).dispatchEvent(new Event('change', { bubbles: true }));
  }
  function key(type, key, code, extra = {}, target = document.body) {
    const e = new KeyboardEvent(type, { key, code, ...extra, bubbles: true, cancelable: true });
    target.dispatchEvent(e);
    return e.defaultPrevented;
  }
  const tap = (char, code) => { key('keydown', char, code); key('keyup', char, code); };
  const current = () => { const s = testState(); return s.profiles.find(p => p.id === s.activeId); };
  if (el('callsign-intro-dialog').open) el('skip-callsign').click();
  if (el('guidance-dialog').open) el('guidance-close').click();
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true });
  window.dispatchEvent(new Event('focus'));
  check(el('nav-shack').hidden && el('progress-total').disabled,'The Shack is open below the XP threshold');
  location.hash='shack';
  await wait(()=>location.hash==='#journey' && !el('view-journey').hidden,'Locked Shack link did not return to Progress');
  check(document.querySelector('.shack-xp').disabled && !el('shack-station').children.length,'Locked Progress entry or station mounted');
  const { MorseAudio } = await import('/js/audio.mjs');
  const { KeyTone } = await import('/js/send-ui.mjs');
  const { loadKeyboardPaddles } = await import('/js/keyboard-paddles.mjs');
  const heard = [];
  MorseAudio.prototype.play = async text => { heard.push(text); return { completed: true }; };
  KeyTone.prototype.set = async () => {};

  tab('lab');
  if (fixture.mode.startsWith('mac')) await wait(() => el('sound-choices').textContent.includes('Use Paddle'), 'Native settings');
  el('sound-choices').firstElementChild.click();
  change('send-source', 'vband');
  check(el('keyboard-paddle-options').hidden, 'USB offered keyboard assignments');
  change('send-source', 'keyboard');
  check(!el('keyboard-paddle-options').hidden && el('paddle-dot-key').value === 'Z' && el('paddle-dash-key').value === 'X', 'Default keys');
  const savedNotice = el('paddle-keys-saved');
  el('paddle-dot-key').value = 'X';
  el('paddle-bindings').requestSubmit();
  check(!savedNotice.textContent && el('paddle-key-message').textContent.includes('different') && loadKeyboardPaddles().dit === 'z', 'Duplicate keys saved');
  el('paddle-dot-key').value = 'Ö'; el('paddle-dash-key').value = 'E';
  const setItem = Storage.prototype.setItem;
  try {
    Storage.prototype.setItem = function(key, value) {
      if (key === 'morse.keyboard-paddles.v1') throw new Error('Storage unavailable');
      return setItem.call(this, key, value);
    };
    el('paddle-bindings').requestSubmit();
    check(!savedNotice.textContent && el('paddle-key-message').textContent.includes('for this session'), 'Storage failure showed a successful save');
  } finally { Storage.prototype.setItem = setItem; }
  el('paddle-bindings').requestSubmit();
  check(savedNotice.textContent === 'Saved' && !el('paddle-key-message').textContent, 'Successful save did not replace the error');
  change('paddle-dot-key', 'Ö');
  check(!savedNotice.textContent, 'Editing a binding kept the previous save confirmation');
  el('show-paddle-buttons').click();
  check(!loadKeyboardPaddles().showButtons && loadKeyboardPaddles().dit === 'ö', 'Character or visibility lost');
  el('send-reverse').click();
  check(el('paddle-dot-key').value === 'E' && el('send-dah').querySelector('kbd').textContent === 'Ö', 'Reversed key labels');
  el('send-reverse').click();
  change('send-pause', 5.5); change('send-continue-mode', 'manual');
  check(el('send-pause-control').hidden && !el('send-manual-hint').hidden && current().sending.settings.pauseSeconds === 5.5, 'Saved manual mode');
  tab('send'); change('send-level', 1); change('send-wpm', 30); change('send-farnsworth', 30);
  check(el('send-key-controls').hidden && el('send-paddles').hidden && el('send-input-status').textContent.includes('Dot Ö'), 'Hidden paddle controls');
  el('send-listen').click(); await wait(() => heard.length === 1 && !el('send-listen').disabled, 'Heard E');
  const attempts = current().sending.attempts;
  for (const [char, code, modifiers] of [['x','KeyX',{}], ['z','KeyZ',{}], ['ö','KeyO',{ metaKey:true }], ['e','KeyE',{ isComposing:true }]]) {
    check(!key('keydown', char, code, modifiers), 'Unbound character or shortcut was consumed'); key('keyup', char, code, modifiers);
  }
  // The literal E is a dash during an answer, and a command after grading.
  const volume = el('send-volume');
  volume.focus();
  check(!key('keydown','ArrowRight','ArrowRight',{},volume), 'Sending stole a slider adjustment');
  check(key('keydown','e','KeyL',{},volume), 'Focused Send slider blocked the assigned paddle');
  key('keyup','e','KeyL',{},volume);
  await wait(() => el('send-capture').dataset.result === 'retry', 'Remapped dash was graded');
  check(heard.length === 1 && current().sending.attempts === attempts + 1, 'Retry ran early');
  check(!key('keydown','e','KeyL',{},el('send-level')), 'Continue stole keyboard input from a control');
  key('keydown','e','KeyL'); key('keydown','e','KeyL',{repeat:true}); key('keyup','e','KeyL');
  await wait(() => heard.length === 2 && !el('send-listen').disabled, 'E did not replay');
  check(heard[1] === heard[0] && !el('send-decoded').textContent && current().sending.attempts === attempts + 1, 'Command entered the retry');
  key('keydown','Ö','Semicolon',{shiftKey:true}); key('keyup','ö','Semicolon');
  await wait(() => el('send-capture').dataset.result === 'good', 'Layout-aware dot was graded');
  check(current().stats.xp>=5000 && !el('nav-shack').hidden,'Sending across the threshold did not reveal the tab');
  const xp = current().sending.earned;
  await waitMs(1300);
  check(heard.length === 2 && el('send-instruction').textContent.includes('Press E'), 'Manual result did not wait');
  window.dispatchEvent(new Event('blur')); window.dispatchEvent(new Event('focus'));
  tap('ö','Semicolon');
  await wait(() => heard.length === 3 && !el('send-listen').disabled, 'Single dit did not continue after focus returned');
  check(!el('send-decoded').textContent && current().sending.earned === xp, 'Continue dit affected the score');

  tab('lab'); el('show-paddle-buttons').click(); tab('send');
  check(!el('send-key-controls').hidden && !el('send-paddles').hidden, 'On-screen paddles did not return');
  if (fixture.mode === 'browser') {
    el('send-listen').click(); await wait(() => heard.length === 4 && !el('send-listen').disabled, 'On-screen listen');
    const button = el('send-dit');
    // Synthetic pointers in the offscreen host have no platform pointer to capture.
    button.setPointerCapture = () => {};
    const pointer = type => button.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, button: 0 }));
    pointer('pointerdown'); key('keydown','ö','Semicolon'); pointer('pointerup');
    await wait(() => el('send-trace').querySelectorAll('.trace-sent').length >= 2, 'Pointer release cut off the held keyboard paddle');
    key('keyup','ö','Semicolon');
    await wait(() => el('send-capture').dataset.result === 'retry', 'Mixed pointer and keyboard input');
    change('send-level', 2);
    el('send-listen').click(); await wait(() => heard.length === 5 && !el('send-listen').disabled, 'Manual level start');
    for (let i = 0; i < 3; i++) {
      tap('e','KeyL'); // configured dash sends T
      await wait(() => el('send-capture').dataset.result === 'good', 'Manual level answer');
      if (i === 2) check(current().sending.pendingLevel === 3 && current().sending.level === 2, 'Mastered level advanced before E');
      const n = heard.length;
      tap('e','KeyL'); // the same key now continues
      await wait(() => heard.length === n + 1 && !el('send-listen').disabled, 'Manual next signal or level');
    }
    check(current().sending.level === 3 && !current().sending.pendingLevel, 'Manual next level');
    tab('lab'); change('send-continue-mode','timed'); change('send-pause',0.8); tab('send');
    el('send-listen').click(); await wait(() => !el('send-listen').disabled, 'Timed keyboard listen');
    const n = heard.length, prior = current().sending.attempts;
    tap('ö','Semicolon'); await wait(() => el('send-decoded').textContent, 'Start incomplete input'); tab('lab');
    await waitMs(950);
    check(heard.length === n && current().sending.attempts === prior, 'Leaving Send played or graded an interrupted answer');
  } else {
    tab('lab'); change('send-source', 'paddle'); testPaddleReady(); tab('send'); await new Promise(resolve => setTimeout(resolve,20)); testPaddleElement(0,0);
    await wait(() => el('send-input-status').textContent.includes('Paddle ready'), 'Converter ready');
    el('send-listen').click();
    await wait(() => heard.length === 4 && !el('send-listen').disabled, 'Native listen');
    const nativeBefore = current().sending.attempts;
    testPaddleElement(0, 0); testPaddleElement(1, 100); testPaddleElement(2, 140); testPaddleElement(0, 1140);
    await wait(() => current().sending.attempts === nativeBefore + 1, 'Native manual grade');
    testPaddleElement(0, 16000);
    testPaddleElement(1, 16100); testPaddleElement(2, 16140); testPaddleElement(1, 16180); testPaddleElement(2, 16220); testPaddleElement(0, 16300);
    check(heard.length === 4, 'A timer or held paddle continued');
    testPaddleElement(1, 16400); testPaddleElement(2, 16440); testPaddleElement(0, 16520);
    await wait(() => heard.length === 5 && !el('send-listen').disabled, 'One generated dit did not continue');
    check(current().sending.attempts === nativeBefore + 1 && !el('send-decoded').textContent, 'Native command was graded');
    tab('lab'); change('send-continue-mode','timed'); change('send-pause', 3); tab('send');
    el('send-listen').click(); await wait(() => heard.length === 6 && !el('send-listen').disabled, 'Timed native listen');
    testPaddleElement(0, 20000); testPaddleElement(1, 20100); testPaddleElement(2, 20140); testPaddleElement(0, 23139);
    check(heard.length === 6 && current().sending.attempts === nativeBefore + 1, 'Native replay before the requested quiet interval');
    testPaddleElement(0, 23140);
    await wait(() => heard.length === 7, 'Native replay did not use the last mark and watermark');
  }
  window.testComplete = true;
})().catch(error => { window.testFailure = error.message; });
