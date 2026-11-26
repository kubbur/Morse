(async () => {
  const { sendingTrace, SendingTraceView } = await import('/js/send-trace.mjs');
  const capture = document.getElementById('send-capture').cloneNode(true);
  capture.removeAttribute('id');
  for (const el of capture.querySelectorAll('[id]')) el.removeAttribute('id');
  const get = selector => capture.querySelector(selector);
  get('.trace-plot').replaceChildren();
  document.body.append(capture);
  capture.style.width = '520px';
  const view = new SendingTraceView(get('.send-trace'), get('.trace-verdict'));
  view.reducedMotion = { matches:false };
  function paint(target, times, paddle = false, complete = false, passed = false, privateTarget = target) {
    const edges = times.map((at,i) => ({at,down:i % 2 === 0}));
    const data = sendingTrace(target, {wpm:30,farnsworth:30}, edges, {keyerTimed:paddle});
    view.set(data, complete, passed);
    if (!complete && times.length && times.length % 2 === 0) {
      const reference = privateTarget === target ? data : sendingTrace(privateTarget, {wpm:30,farnsworth:30}, edges, {keyerTimed:paddle});
      view.showMatchedSend(reference);
    }
    view.draw();
  }
  function expect(condition, message) { if (!condition) throw Error(message); }
  const call = () => get('.trace-call').textContent;
  const fireworks = () => get('.send-fireworks');
  paint('R', []);
  paint('R', [0,40]);
  const burst = get('.trace-burst[data-kind="perfect"]');
  expect(burst && burst.children.length === 5, 'Perfect release did not sparkle');
  paint('R', [0,40,80]);
  capture.style.width = '320px';
  view.draw();
  const dit = get('.trace-sent');
  expect(burst === get('.trace-burst') && Math.abs(parseFloat(burst.style.left) - parseFloat(dit.style.left) - parseFloat(dit.style.width)) < 0.1,
    'Next press or resize moved the sparkle off its measured release');
  burst.dispatchEvent(new Event('animationend'));
  view.draw();
  expect(!get('.trace-burst'), 'Drawing the same hit replayed its sparkle');
  paint('', [0,40]);
  expect(!get('.trace-next,.trace-gate,.trace-gap,.trace-perfect,.trace-burst'), 'Hidden target leaked feedback');
  paint('R', [0,40]);
  expect(!get('.trace-burst'), 'Showing a hint replayed a past release');

  paint('EE', []);
  paint('EE', [0,210]);
  const gap = get('.trace-gap'), next = get('.trace-next');
  const gateEnd = parseFloat(gap.style.left) + parseFloat(gap.style.width);
  const nextPress = parseFloat(next.style.left) + parseFloat(next.style.getPropertyValue('--press-offset'));
  expect(Math.abs(gateEnd - nextPress) < 0.1 && gateEnd < get('.trace-plot').clientWidth, 'After a late release the next press guide must follow the measured gap and stay on the scale');
  paint('S', []);
  paint('S', [0,40,80,120,160,200]);
  expect(capture.querySelectorAll('.trace-sent.trace-perfect').length === 3 && capture.querySelectorAll('.trace-burst').length === 1 && fireworks(), 'Batched final release missed its whole-answer celebration');
  const releaseFireworks = fireworks();
  paint('S', [0,40,80,120,160,200], false, true, true);
  const first = fireworks(), panelHeight = capture.offsetHeight;
  expect(first === releaseFireworks && first.dataset.kind === 'perfect' && first.children.length === 3 && call() === 'Perfect send', 'Grading replayed or lost the release fireworks');
  expect(first.parentElement === capture && getComputedStyle(first).pointerEvents === 'none' && first.getAttribute('aria-hidden') === 'true', 'Fireworks must stay on the visible panel and allow input');
  paint('S', [0,40,80,120,160,200], false, true, true);
  capture.style.width = '400px';
  view.draw();
  first.firstElementChild.dispatchEvent(new Event('animationend', {bubbles:true}));
  expect(fireworks() === first && capture.querySelectorAll('.send-fireworks').length === 1 && capture.offsetHeight === panelHeight, 'Redisplay, resize or one finished bloom cut off or duplicated the celebration');
  first.dispatchEvent(new Event('animationend'));
  view.draw();
  expect(!fireworks() && get('.trace-verdict').dataset.finish === 'perfect', 'A completed grade replayed its fireworks or lost the verdict');
  paint('EE', []);
  paint('EE', [0,40,160,200], false, true, true);
  expect(call() === 'Perfect send' && !fireworks(), 'Opening a previously graded comparison replayed its celebration');

  // A perfect final mark can follow a merely acceptable mark, a wrong pattern,
  // or an extra press. It cannot promote those attempts to a perfect send.
  for (const [target, times, passed] of [
    ['EE',[0,48,168,208],true], ['EE',[0,40],false], ['E',[0,40,80,120],false], ['E',[0,40,80],true], ['EE',[0,40,160,200],false],
  ]) {
    paint(target, []); paint(target, times); paint(target, times, false, true, passed);
    expect(!fireworks() && !get('.trace-verdict').dataset.finish, 'Awarded a whole-send celebration for ' + times);
  }

  paint('A', [], true);
  paint('A', [0,40,80,200], true);
  expect(call() === 'Clean send' && !get('.trace-perfect,.trace-spark') && fireworks()?.dataset.kind === 'clean', 'Keyer-generated length should only earn a clean-send cue');
  paint('A', [0,40,80,200], true, true, true);
  expect(call() === 'Clean send' && get('.trace-clean') && fireworks()?.dataset.kind === 'clean', 'Correct paddle pattern missed its mint completion cue');
  paint('A', [], true);
  expect(!fireworks(), 'Starting again left the previous fireworks running');
  paint('', [0,40], false, false, false, 'A');
  expect(!fireworks() && get('.trace-verdict').hidden && !get('.trace-target'), 'Blind exercise revealed a partial match');
  paint('', [0,40,80,200], false, false, false, 'A');
  expect(fireworks() && !get('.trace-target'), 'Blind full answer missed its release cue or revealed the target');
  paint('A', [0,40,80,200], false, true, true);
  expect(call() === 'Perfect send' && fireworks()?.dataset.kind === 'perfect', 'Perfect blind attempt missed its graded celebration');
  paint('E E', [], true);
  paint('E E', [0,40,320,360], true);
  paint('E E', [0,40,320,360], true, true, true);
  expect(call() === 'Perfect spacing' && fireworks()?.dataset.kind === 'perfect', 'Precisely hand-spaced paddle phrase missed its gold fireworks');

  view.reducedMotion = { matches:true };
  paint('E E', [], true);
  paint('E E', [0,40], true);
  expect(get('.trace-gap') && !get('.trace-burst'), 'Reduced-motion paddle gap cue');
  paint('E E', [0,40,320,360], true);
  expect(call() === 'Perfect spacing' && get('.trace-at-press') && get('.trace-gap-hit') && !get('.trace-burst'), 'Reduced motion lost the static gap bracket and star or emitted particles');
  paint('E E', [0,40,320,360], true, true, true);
  expect(call() === 'Perfect spacing' && get('.trace-verdict').dataset.finish === 'perfect' && !get('.trace-burst,.send-fireworks'), 'Reduced motion must retain the whole-attempt badge without animated particles');
  expect(getComputedStyle(get('.trace-call'),'::after').content !== 'none', 'Missing static finishing star');
  paint('E E', [], true);
  expect(get('.trace-verdict').hidden && !get('.trace-clean,.trace-perfect,.trace-burst,.send-fireworks'), 'Clear retained a previous reward');
  window.testComplete = true;
})().catch(error => { window.testFailure = error.message; });
