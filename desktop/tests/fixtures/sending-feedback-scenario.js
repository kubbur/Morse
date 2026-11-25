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
  function paint(target, times, paddle = false, complete = false, passed = false) {
    const edges = times.map((at,i) => ({at,down:i % 2 === 0}));
    const data = sendingTrace(target, {wpm:30,farnsworth:30}, edges, {keyerTimed:paddle});
    view.set(data, '', complete, passed);
    view.draw();
  }
  function expect(condition, message) { if (!condition) throw Error(message); }
  const call = () => get('.trace-call').textContent;
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
  expect(capture.querySelectorAll('.trace-sent.trace-perfect').length === 3 && capture.querySelectorAll('.trace-burst').length === 1, 'Batched releases lost hits or replayed all their effects');

  paint('A', [], true);
  paint('A', [0,40,80,200], true);
  expect(call() === 'Dah matched' && !get('.trace-perfect,.trace-spark'), 'Keyer-generated length earned a timing star');
  paint('A', [0,40,80,200], true, true, true);
  expect(call() === 'Clean send' && get('.trace-clean') && get('.trace-burst[data-kind="clean"]'), 'Correct paddle pattern missed its completion cue');
  paint('A', [], true);
  paint('', [0,40,80,200]);
  paint('A', [0,40,80,200], false, true, true);
  expect(call() === 'Perfect send' && get('.trace-burst[data-kind="perfect"]'), 'Perfect blind attempt missed its graded cue');

  view.reducedMotion = { matches:true };
  paint('E E', [], true);
  paint('E E', [0,40], true);
  expect(get('.trace-gap') && !get('.trace-burst'), 'Reduced-motion paddle gap cue');
  paint('E E', [0,40,320,360], true);
  expect(call() === 'Perfect gap' && get('.trace-at-press') && get('.trace-gap-hit') && !get('.trace-burst'), 'Reduced motion lost the static gap bracket and star or emitted particles');
  paint('E E', [0,40,320,360], true, true, true);
  expect(call() === 'Perfect spacing' && !get('.trace-burst'), 'Whole-attempt paddle spacing');
  paint('E E', [], true);
  expect(get('.trace-verdict').hidden && !get('.trace-clean,.trace-perfect,.trace-burst'), 'Clear retained a previous reward');
  window.testComplete = true;
})().catch(error => { window.testFailure = error.message; });
