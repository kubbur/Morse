const $ = id => document.getElementById(id);
const post = globalThis.morsePhone.post;
const steps = [
  [0,'Release both paddles.'],[1,'Hold only the left paddle.'],[0,'Release it.'],
  [2,'Hold only the right paddle.'],[0,'Release it.'],[3,'Hold both paddles together.'],[0,'Release both.'],
];
let index = 0, since = null, session = null, last = null, started = false, pending = false, generation = 0;
let switching = false, marking = false;
let advancing = false, advancedBaseline = null;
let audibleAtStart = 0, ditAtStart = 0, dahAtStart = 0, missedAtStart = 0, observations = [], probeEpoch = null;
const positions = ['released','left','right','both'];
const holds = ['Release both paddles','Hold only the left paddle','Hold only the right paddle','Hold both paddles'];
function reset() {
  index=0; since=null; observations=[]; audibleAtStart=ditAtStart=dahAtStart=missedAtStart=0;
  $('heard').checked=false; $('heard').disabled=true; $('result').textContent='';
}
function listeningTest(row) { return row?.testMode === 'airpods' || row?.testMode === 'speaker'; }
function destination(row) {
  return row.testMode === 'airpods' ? (row.sidetoneOutput?.name || 'AirPods') : 'the iPhone speaker';
}
function canConfirmSound() {
  if (last?.testMode === 'system-speaker') {
    const sound=last.systemSound;
    return !!(last.active && last.status.phase === 'ready' && last.contactPlayerRunning && last.capturedFrames &&
      sound?.ready && sound.allowedDuringRecording && index === steps.length &&
      sound.cues.dit.completedDuringCapture > ditAtStart && sound.cues.dah.completedDuringCapture > dahAtStart);
  }
  if (!listeningTest(last) || !last.active || last.status.phase !== 'ready' || !last.contactPlayerRunning ||
      !last.capturedFrames || !last.sidetoneOutput || !last.status.outputReady) return false;
  const attempt = last.outputAttempt;
  return attempt?.startStatus === 0 && last.capturedFrames > attempt.inputFramesBefore &&
    last.sidetoneDestination === last.testMode && index === steps.length && last.returnedSidetoneFrames > audibleAtStart;
}
function verdict() {
  if (last?.testMode === 'system-speaker') {
    if (last.systemSound?.error) return 'System speaker test unavailable.';
    if (index !== steps.length) return 'System speaker test incomplete.';
    if (!canConfirmSound()) return 'Contacts passed. Waiting for dit and dah completions during wired capture.';
    if (!$('heard').checked) return 'Contacts passed. Confirm whether the keyed dits and dahs came from the iPhone speaker.';
    const missed=last.systemSound.missedMarks-missedAtStart;
    return missed ? 'Wired paddles and iPhone speaker heard together. Missed keyed sounds: '+missed+'.' :
      'Passed. Wired paddles and keyed system sounds heard together on the iPhone speaker.';
  }
  if (last?.testMode === 'reference') return 'Jack output voltage comparison';
  if (last?.testMode === 'signal') {
    return last.jackAudio.measurements.length === positions.length ? 'Four labeled audio measurements collected' : 'Audio measurement incomplete';
  }
  if (listeningTest(last) && last.routesExhausted) return 'No simultaneous paddle and sidetone output to '+destination(last)+'.';
  if (index !== steps.length) return 'Incomplete';
  if (last?.testMode === 'contacts') return 'Contacts passed. Sidetone untested.';
  if (!canConfirmSound()) return 'Contacts passed. Waiting for keyed audio on '+destination(last)+'.';
  return $('heard').checked ? 'Passed. Wired paddles with sidetone on '+destination(last)+'.' : 'Contacts passed. Confirm where you heard the sidetone.';
}
function showTest(mode) {
  $('system-test').hidden = mode !== 'system-speaker';
  $('signal-test').hidden = mode !== 'signal';
  $('reference-test').hidden = mode !== 'reference';
  $('contact-test').hidden = mode === 'signal' || mode === 'reference';
  $('next-route').hidden = true;
}
function drawComparison(test) {
  const a = test.phases['reference-playback'], b = test.phases['reference-mic'];
  const names = ports => ports.map(p => p.name+' ('+p.type+')').join(', ') || 'none';
  for (const [id, reading] of [['playback-route',a], ['mic-route',b]]) {
    $(id).textContent = reading ? [
      reading.detail,
      'Output  '+names(reading.outputs)+' · Volume '+Math.round(reading.systemOutputVolume*100)+'%',
      'Input  '+names(reading.inputs),
      ...(id === 'mic-route' ? [reading.capturedFrames.toLocaleString()+' input frames captured'] : [])
    ].join('\n') : 'Awaiting test.';
  }
  $('reference-mic').disabled = switching || test.phase !== 'reference-playback';
  $('reference-stop').disabled = switching || test.stopped;
  $('mic-volts').disabled = !b;
  $('reference-volume').textContent = a && b && Math.abs(a.systemOutputVolume-b.systemOutputVolume) > .001 ?
    'Volume changed. Match the playback-only reading at '+Math.round(a.systemOutputVolume*100)+'% before comparing.' : '';
}
function meterVolts(id) {
  const value = $(id).value.trim().replace(',', '.');
  return /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) && Number.isFinite(Number(value)) ? Number(value) : null;
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
  if (row.wiredOutputBuffers) {
    $('routes').textContent += '\nWired output  '+row.wiredOutputBuffers+' buffers × '+row.queueBufferFrames+' frames'+
      '\niOS I/O cycle  '+(1000*row.ioBufferSeconds).toFixed(1)+' ms';
    if (row.capturedFrames >= row.rate)
      $('routes').textContent += '\nOutput / input frame count  '+Math.round(100*row.returnedWiredOutputFrames/row.capturedFrames)+'%';
  }
  const ready = row.active && status.phase === 'ready';
  $('left').classList.toggle('down',!!(ready && (row.mask & 1)));
  $('right').classList.toggle('down',!!(ready && (row.mask & 2)));
  if (!started) return;
  if (session !== status.session || ((listeningTest(row) || row.testMode === 'system-speaker') && probeEpoch !== status.epoch)) {
    reset(); session=status.session; probeEpoch=status.epoch;
    $('heard-reference').checked=false; $('system-note').textContent='';
  }
  $('state').textContent=status.detail;
  showTest(row.testMode);
  if (row.testMode === 'reference') { drawComparison(row.jackComparison); return; }
  if (row.testMode === 'signal') { drawMeter(row); return; }
  $('heard-label').textContent='I heard the keyed sidetone from '+destination(row)+'.';
  if (row.testMode === 'system-speaker') {
    const s=row.systemSound, c=s.cues;
    $('speaker-reference').disabled = !s.ready || !s.allowedDuringRecording || !!s.busy || switching;
    $('heard-reference').disabled = !c.reference.completed;
    $('system-cues').textContent = s.error || (!s.allowedDuringRecording && row.active ? 'iOS disabled system sounds during recording.' : '') || [
      'Wired capture  '+row.capturedFrames.toLocaleString()+' frames',
      'System sound completions during capture  ·  '+c.dit.completedDuringCapture+' dits  ·  '+c.dah.completedDuringCapture+' dahs',
      'Reference beeps  '+c.reference.completed+' completed  ·  Missed keyed sounds  '+s.missedMarks
    ].join('\n');
  }
  if (listeningTest(row)) {
    $('routes').textContent+='\nRouting mode  '+row.routeStrategy;
    if (row.sidetoneOutput) $('routes').textContent+='\nSidetone  '+row.sidetoneOutput.name;
    if (row.outputAttempt) {
      const a=row.outputAttempt;
      $('routes').textContent+='\nOutput address  '+a.target.name+(a.listedWhenAddressed ? ' (active route)' : ' (observed earlier)')+
        '\nWired input frames before request  '+a.inputFramesBefore.toLocaleString()+
        '\nWired input frames since request  '+Math.max(0,row.capturedFrames-a.inputFramesBefore).toLocaleString()+
        '\nSidetone buffers returned  '+row.returnedSidetoneBuffers.toLocaleString();
    }
    const next=$('next-route');
    next.hidden=!row.canAdvanceRoute;
    next.disabled=switching || advancing;
    next.textContent=row.sidetoneOutput ? 'No sidetone here · try next route' : 'Try next route';
  }
  const showSignals = row.testMode === 'contacts' || listeningTest(row);
  $('contact-signal').hidden = !showSignals;
  if (showSignals) {
    const levels = row.contactSignal?.channels;
    const db = n => n === null ? '−∞' : n.toFixed(1);
    $('contact-signal').textContent = [
      row.contactPlayerRunning ? 'Wired sensing player on · 1 kHz left and 1.6 kHz right.' : '',
      ...(levels || []).map(ch=>'Mic '+ch.channel+' · 1 kHz '+db(ch.hz1000DBFS)+' dBFS · 1.6 kHz '+db(ch.hz1600DBFS)+' dBFS')
    ].filter(Boolean).join('\n');
  }
  if (listeningTest(row) && row.routesExhausted) {
    reset();
    $('step').textContent=verdict();
    $('result').textContent=(row.testMode === 'airpods' ? 'If your AirPods are connected to this iPhone, copy the test report.' : 'Copy the test report.');
    return;
  }
  if (!ready) { reset(); $('step').textContent=''; return; }
  if (index < steps.length) {
    if (row.mask === steps[index][0]) {
      since ??= performance.now();
      if (performance.now()-since >= 250) {
        if (index === 0) {
          audibleAtStart = row.returnedSidetoneFrames;
          if (row.systemSound) {
            ditAtStart=row.systemSound.cues.dit.completedDuringCapture;
            dahAtStart=row.systemSound.cues.dah.completedDuringCapture;
            missedAtStart=row.systemSound.missedMarks;
          }
        }
        observations.push({mask:row.mask,time:new Date().toISOString(),audibleFrames:row.audibleFrames}); ++index; since=null;
      }
    } else since=null;
  }
  $('step').textContent = steps[index]?.[1] || 'All four electrical states observed.';
  $('heard').disabled=!canConfirmSound();
  $('result').textContent=index===steps.length ? verdict() : '';
  if (index === steps.length && row.wiredBaseline && advancedBaseline !== session) {
    advancedBaseline=session;
    void nextRoute(true);
  }
}
async function nextRoute(baseline) {
  if (advancing || switching || !last?.canAdvanceRoute) return;
  const run=generation, row=last;
  advancing=true; $('next-route').disabled=true;
  try {
    const reply=await post({op:'paddle',name:'next-route',value:{session:row.status.session,
      strategy:row.routeStrategy,baseline,unheard:!baseline && !!row.sidetoneOutput}});
    if (reply?.error && run===generation) $('result').textContent=reply.error;
  } catch { if (run===generation) $('result').textContent='Could not advance. Try the next route again.'; }
  finally { advancing=false; }
  await poll();
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
  ++generation; reset(); session=null; last=null; started=false; switching=true; advancedBaseline=null;
  $('system-start').disabled=true; $('speaker-reference').disabled=true; $('heard-reference').checked=false;
  $('heard-reference').disabled=true; $('system-cues').textContent=''; $('system-note').textContent='';
  $('state').textContent='Opening the wired audio route…'; $('step').textContent='';
  showTest(mode.startsWith('reference-') ? 'reference' : mode); $('levels').textContent='Waiting for samples.'; $('drive').textContent='';
  if (mode === 'reference-playback') {
    $('playback-volts').value=''; $('mic-volts').value='';
    $('playback-route').textContent='Opening playback…'; $('mic-route').textContent='Awaiting test.';
    $('reference-volume').textContent='';
  }
  $('reference').disabled=true; $('reference-mic').disabled=true; $('reference-stop').disabled=true;
  $('mark').disabled=true; $('signal-step').textContent=''; $('signal-note').textContent='';
  $('start').disabled=true; $('airpods').disabled=true; $('signal').disabled=true; $('contacts').disabled=true; $('copy').disabled=true;
  try {
    const reply=await post({op:'paddle',name:'probe',value:mode});
    if (reply?.error) throw new Error(reply.error);
    started=true;
  } catch (error) { $('state').textContent=error.message || 'Could not start the adapter test.'; }
  finally { switching=false; $('system-start').disabled=false; $('start').disabled=false; $('airpods').disabled=false; $('signal').disabled=false; $('reference').disabled=false; $('contacts').disabled=false; $('copy').disabled=false; }
  await poll();
}
$('system-start').onclick=()=>start('system-speaker');
$('speaker-reference').onclick=async () => {
  const run=generation, current=session;
  if (switching || last?.testMode !== 'system-speaker') return;
  $('speaker-reference').disabled=true; $('system-note').textContent='';
  try {
    const reply=await post({op:'paddle',name:'speaker-reference',value:current});
    if (reply?.error) throw new Error(reply.error);
  } catch (error) {
    if (run===generation && current===session) $('system-note').textContent=error.message || 'The reference beep was unavailable.';
  }
  await poll();
};
$('start').onclick=()=>start('speaker');
$('next-route').onclick=()=>nextRoute(false);
$('airpods').onclick=()=>start('airpods');
$('contacts').onclick=()=>start('contacts');
$('signal').onclick=()=>start('signal');
$('reference').onclick=()=>start('reference-playback');
$('reference-mic').onclick=()=>start('reference-mic');
$('reference-stop').onclick=()=>start('reference-stop');
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
$('heard').onchange=async () => {
  $('result').textContent=verdict();
  if (listeningTest(last) && $('heard').checked && canConfirmSound()) {
    const currentSession=session;
    try {
      const reply=await post({op:'paddle',name:'confirm-output',value:{destination:last.testMode,
        session:currentSession,epoch:last.status.epoch}});
      if (session!==currentSession || !canConfirmSound()) return;
      if (reply?.error) throw new Error(reply.error);
      localStorage.setItem('morse.send-input.v1','paddle');
    } catch (error) { $('result').textContent=error.message || 'Select the audio converter in Trainer settings.'; }
  }
};
$('copy').onclick=async () => {
  const run=generation;
  try {
    const row=await post({op:'snapshot'});
    if (run!==generation || document.hidden) return;
    draw(row);
    const report={at:new Date().toISOString(),verdict:verdict(),observations,
      heardFromSpeaker:!!(['speaker','system-speaker'].includes(last.testMode) && canConfirmSound() && $('heard').checked),
      heardFromBluetooth:!!(last.testMode==='airpods' && canConfirmSound() && $('heard').checked),route:last};
    if (row.testMode === 'system-speaker') report.heardReferenceFromSpeaker =
      !!(row.systemSound.cues.reference.completed && $('heard-reference').checked);
    if (row.testMode === 'reference') report.meterVoltsAC={
      playbackOnly:meterVolts('playback-volts'), withWiredMic:meterVolts('mic-volts')
    };
    const pretty=JSON.stringify(report,null,2);
    await post({op:'copy',text:pretty.length < 16000 ? pretty : JSON.stringify(report)}); $('copy').textContent='Copied';
  } catch { $('copy').textContent='Copy failed. Try again'; }
};
document.addEventListener('visibilitychange',()=>{ if(document.hidden){++generation;reset();session=null;} else void poll(); });
setInterval(poll,100); void poll();
