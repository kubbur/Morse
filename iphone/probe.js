const $ = id => document.getElementById(id);
const post = globalThis.morsePhone.post;
const steps = [
  [0,'Release both paddles.'],[1,'Hold only the left paddle.'],[0,'Release it.'],
  [2,'Hold only the right paddle.'],[0,'Release it.'],[3,'Hold both paddles together.'],[0,'Release both.'],
];
let index = 0, since = null, session = null, last = null, started = false, pending = false, generation = 0;
let audibleAtStart = 0, observations = [];
function reset() {
  index=0; since=null; observations=[]; audibleAtStart=0; $('heard').checked=false; $('heard').disabled=true; $('result').textContent='';
}
function verdict() {
  if (index !== steps.length) return 'Incomplete';
  if (!last?.active || last.audibleFrames <= audibleAtStart) return 'The speaker queue has produced no audible marks.';
  return $('heard').checked ? 'Passed on this iPhone' : 'Contacts passed. Confirm where you heard the sidetone.';
}
function draw(row) {
  last = row;
  const status=row.status, label = p => p.map(x => x.name+' ('+x.type+', '+x.channels+' ch)').join(', ') || 'none';
  $('routes').textContent = 'Input  '+label(row.inputs)+'\nOutput  '+label(row.outputs)+'\nSample rate  '+row.rate+' Hz';
  $('left').classList.toggle('down',!!(row.mask & 1)); $('right').classList.toggle('down',!!(row.mask & 2));
  if (!started) return;
  if (session !== status.session) { reset(); session=status.session; audibleAtStart=row.audibleFrames; }
  $('state').textContent=status.detail;
  if (!row.active || status.phase!=='ready') { reset(); $('step').textContent=''; return; }
  if (index < steps.length) {
    if (row.mask === steps[index][0]) {
      since ??= performance.now();
      if (performance.now()-since >= 250) {
        observations.push({mask:row.mask,time:new Date().toISOString(),audibleFrames:row.audibleFrames}); ++index; since=null;
      }
    } else since=null;
  }
  $('step').textContent = steps[index]?.[1] || 'All four electrical states observed.';
  $('heard').disabled=index!==steps.length || row.audibleFrames<=audibleAtStart;
  $('result').textContent=index===steps.length ? verdict() : '';
}
async function poll() {
  if (pending || document.hidden) return;
  pending=true;
  const run=generation;
  try { const row=await post({op:'snapshot'}); if(run===generation) draw(row); }
  catch { $('state').textContent='The audio session is unavailable.'; reset(); }
  finally { pending=false; }
}
$('start').onclick=async () => {
  ++generation; reset(); session=null; started=false; $('state').textContent='Opening the wired audio route…';
  $('start').disabled=true;
  try { await post({op:'paddle',name:'probe'}); started=true; $('start').textContent='Restart test'; await poll(); }
  finally { $('start').disabled=false; }
};
$('heard').onchange=() => {
  $('result').textContent=verdict();
  if ($('heard').checked && verdict()==='Passed on this iPhone') {
    try { localStorage.setItem('morse.send-input.v1','paddle'); } catch { /* The input can still be selected in Settings. */ }
  }
};
$('copy').onclick=async () => {
  const report={at:new Date().toISOString(),verdict:verdict(),observations,heardFromSpeaker:$('heard').checked,route:last};
  await post({op:'copy',text:JSON.stringify(report,null,2)}); $('copy').textContent='Copied';
};
document.addEventListener('visibilitychange',()=>{ if(document.hidden){++generation;reset();session=null;} else void poll(); });
setInterval(poll,100); void poll();
