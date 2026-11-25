const $ = id => document.getElementById(id);
const post = globalThis.morsePhone.post;
const steps = [
  [0,'Release both paddles.'],[1,'Hold only the left paddle.'],[0,'Release it.'],
  [2,'Hold only the right paddle.'],[0,'Release it.'],[3,'Hold both paddles together.'],[0,'Release both.'],
];
let index = 0, since = null, session = null, last = null, started = false, pending = false, generation = 0;
let switching = false, marking = false;
let audibleAtStart = 0, observations = [];
const positions = ['released','left','right','both'];
const holds = ['Release both paddles','Hold only the left paddle','Hold only the right paddle','Hold both paddles'];
function reset() {
  index=0; since=null; observations=[]; audibleAtStart=0; $('heard').checked=false; $('heard').disabled=true; $('result').textContent='';
}
function canConfirmSpeaker() {
  return index === steps.length && last?.active && last.status.phase === 'ready' &&
    last.testMode === 'speaker' && last.speakerActive && last.audibleFrames > audibleAtStart;
}
function verdict() {
  if (last?.testMode === 'signal') {
    return last.jackAudio.measurements.length === positions.length ? 'Four labeled audio measurements collected' : 'Audio measurement incomplete';
  }
  if (index !== steps.length) return 'Incomplete';
  if (last?.testMode === 'contacts') return 'Contacts passed. iPhone speaker untested.';
  if (!canConfirmSpeaker()) return 'Contacts passed. No keyed speaker audio was measured.';
  return $('heard').checked ? 'Passed on this iPhone' : 'Contacts passed. Confirm where you heard the sidetone.';
}
function showMeter(enabled) {
  $('signal-test').hidden = !enabled;
  $('contact-test').hidden = enabled;
}
function drawMeter(row) {
  const m = row.jackAudio;
  const fmt = db => db === null ? '−∞' : db.toFixed(1);
  $('levels').textContent = m.live ? m.live.channels.map(ch =>
    'Channel '+ch.channel+'   '+(ch.peakDBFS === null ? 'Digital silence' :
    'RMS '+fmt(ch.rmsDBFS)+'   Peak '+fmt(ch.peakDBFS)+' dBFS')).join('\n') : 'Waiting for samples.';
  const volume = Math.round(m.systemOutputVolume*100);
  $('drive').textContent = m.wiredOutputQueue ?
    'Left 1 kHz · Right 1.6 kHz · Volume '+volume+'%\n'+
    m.toneFramesReturned.toLocaleString()+' tone frames and '+m.silentFramesReturned.toLocaleString()+' silent frames returned by iOS.'+
    (m.toneFramesReturned ? '\nTone buffer peak   L '+fmt(m.returnedTonePeakDBFS[0])+'   R '+fmt(m.returnedTonePeakDBFS[1])+' dBFS' : '') :
    (m.outputIssue || 'Waiting for the wired output.');
  const i = m.measurements.length;
  const complete = i === positions.length;
  $('signal-step').textContent = complete ? 'All four positions measured.' : m.measuringPosition ?
    'Keep the paddles steady until this reading finishes.' : holds[i]+', then tap below.';
  $('mark').hidden = complete;
  $('mark').disabled = marking || !m.live || !!m.measuringPosition || complete;
  if (!complete) $('mark').textContent = m.measuringPosition ? 'Measuring…' : 'Mark '+positions[i];
  $('signal-note').textContent = m.note;
  $('result').textContent = complete ? 'Copy the report to compare the input levels for each position.' : '';
}
function draw(row) {
  last = row;
  const status=row.status, label = p => p.map(x => x.name+' ('+x.type+', '+x.channels+' ch)').join(', ') || 'none';
  $('routes').textContent = 'Active input  '+label(row.inputs)+'\nActive output  '+label(row.outputs)+
    '\nAvailable inputs  '+label(row.availableInputs)+'\nSample rate  '+row.rate+' Hz';
  const ready = row.active && status.phase === 'ready';
  $('left').classList.toggle('down',!!(ready && (row.mask & 1)));
  $('right').classList.toggle('down',!!(ready && (row.mask & 2)));
  if (!started) return;
  if (session !== status.session) { reset(); session=status.session; }
  $('state').textContent=status.detail;
  showMeter(row.testMode === 'signal');
  if (row.testMode === 'signal') { drawMeter(row); return; }
  $('contacts').hidden = !row.canTestContacts;
  if (!ready) { reset(); $('step').textContent=''; return; }
  if (index < steps.length) {
    if (row.mask === steps[index][0]) {
      since ??= performance.now();
      if (performance.now()-since >= 250) {
        if (index === 0) audibleAtStart = row.audibleFrames;
        observations.push({mask:row.mask,time:new Date().toISOString(),audibleFrames:row.audibleFrames}); ++index; since=null;
      }
    } else since=null;
  }
  $('step').textContent = steps[index]?.[1] || 'All four electrical states observed.';
  $('heard').disabled=!canConfirmSpeaker();
  $('result').textContent=index===steps.length ? verdict() : '';
}
async function poll() {
  if (pending || switching || document.hidden) return;
  pending=true;
  const run=generation;
  try { const row=await post({op:'snapshot'}); if(run===generation) draw(row); }
  catch { if (run===generation) { last=null; reset(); $('state').textContent='The audio session is unavailable.'; } }
  finally { pending=false; }
}
async function start(mode) {
  if (switching) return;
  ++generation; reset(); session=null; last=null; started=false; switching=true;
  $('state').textContent='Opening the wired audio route…'; $('step').textContent='';
  showMeter(mode === 'signal'); $('levels').textContent='Waiting for samples.'; $('drive').textContent='';
  $('mark').disabled=true; $('signal-step').textContent=''; $('signal-note').textContent='';
  $('start').disabled=true; $('signal').disabled=true; $('contacts').hidden=true; $('copy').disabled=true;
  try {
    await post({op:'paddle',name:'probe',value:mode});
    started=true; $('start').textContent='Retry with iPhone speaker';
  } catch { $('state').textContent='Could not start the adapter test.'; }
  finally { switching=false; $('start').disabled=false; $('signal').disabled=false; $('copy').disabled=false; }
  await poll();
}
$('start').onclick=()=>start('speaker');
$('contacts').onclick=()=>start('contacts');
$('signal').onclick=()=>start('signal');
$('mark').onclick=async () => {
  const m=last?.jackAudio, run=generation;
  if (!m?.live || switching || marking || m.measuringPosition || m.measurements.length >= positions.length) return;
  marking=true; $('mark').disabled=true;
  try {
    const reply=await post({op:'paddle',name:'mark-signal',
      value:{session:last.status.session,position:positions[m.measurements.length]}});
    if (run===generation && reply?.error) $('signal-note').textContent=reply.error;
  } catch { if (run===generation) $('signal-note').textContent='Could not start this measurement.'; }
  finally { marking=false; }
  await poll();
};
$('heard').onchange=() => {
  $('result').textContent=verdict();
  if ($('heard').checked && canConfirmSpeaker()) {
    try { localStorage.setItem('morse.send-input.v1','paddle'); } catch { /* The input can still be selected in Settings. */ }
  }
};
$('copy').onclick=async () => {
  const run=generation;
  try {
    const row=await post({op:'snapshot'});
    if (run!==generation || document.hidden) return;
    draw(row);
    const report={at:new Date().toISOString(),verdict:verdict(),observations,
      heardFromSpeaker:!!(canConfirmSpeaker() && $('heard').checked),route:last};
    const pretty=JSON.stringify(report,null,2);
    await post({op:'copy',text:pretty.length < 16000 ? pretty : JSON.stringify(report)}); $('copy').textContent='Copied';
  } catch { $('copy').textContent='Copy failed. Try again'; }
};
document.addEventListener('visibilitychange',()=>{ if(document.hidden){++generation;reset();session=null;} else void poll(); });
setInterval(poll,100); void poll();
