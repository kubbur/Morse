const $ = id => document.getElementById(id);
const api=window.morseMac;
if (api) {
  $('send-keyer-help').textContent='Sending speed and keyer mode also control the paddle sidetone.';
  const panel=document.createElement('section');
  panel.className='field';
  panel.innerHTML=`<div id="native-hardware" class="field">
    <label for="native-output">Sidetone output</label><select id="native-output"></select><small id="native-playing"></small>
    <label><input type="checkbox" id="native-words"> Use timed word spaces when typing</label>
    <button type="button" id="native-start">Calibrate input</button>
    <div id="native-cal" hidden><p id="native-step" role="status"></p>
      <label><input type="checkbox" id="native-boost"> Boost wired sensing signal</label>
      <button type="button" id="native-measure">Measure</button><button type="button" id="native-auto">Automatic levels</button><button type="button" id="native-cancel">Close calibration</button></div>
    <label for="native-write"><input type="checkbox" id="native-write" aria-describedby="native-write-help"> Write in the focused app</label>
    <small id="native-write-help">Switch to a text field. After each app switch, release both paddles and start a new letter.</small>
    <small id="native-write-state" role="status"></small><small id="native-feedback" role="status"></small></div>`;
  $('paddle-settings').append(panel);
  const send=async(op,value)=>{ const r=await api.paddle(op,value); $('native-feedback').textContent=r?.error || ''; return r; };
  const instructions=['','Release both paddles. Click Measure and gently move the cable.','Hold either paddle and click Measure.','Hold only the other paddle and click Measure.','Hold both paddles and click Measure.','Calibration saved for this adapter. Release the paddles.','The measurements overlapped. Start calibration again.','Connect the wired adapter before measuring.'];
  let latest, changingTyping=false;
  const showInput = () => {
    const source=$('send-source').value, converter=source==='paddle';
    $('native-hardware').hidden=!converter && source!=='vband';
    $('native-start').hidden=!converter;
    if (!converter) $('native-cal').hidden=true;
    const write=$('native-write');
    write.checked=!!latest?.typing;
    write.disabled=changingTyping || !write.checked && (latest?.source!==source || !latest?.canArm);
    $('native-write-state').textContent=latest?.typingIssue || (write.checked ? 'Typing is on. Switch this off to use the paddle in Morse.' : '');
  };
  $('send-source').addEventListener('change',()=>{
    $('native-feedback').textContent=''; showInput();
  });
  showInput();
  api.onPaddle(row=>{
    if (row.type!=='status') return;
    latest=row; showInput();
    if (!row.output) return;
    const outputs=[{id:'auto',name:'Automatic'},{id:'speakers',name:'Mac speakers'},...(row.outputs || [])];
    if (!outputs.some(o=>o.id===row.output)) outputs.push({id:row.output,name:'Selected Bluetooth output (disconnected)'});
    $('native-output').replaceChildren(...outputs.map(o=>new Option(o.name,o.id)));
    $('native-output').value=row.output; $('native-playing').textContent=row.playing;
    $('native-words').checked=row.wordSpaces;
    $('native-step').textContent=(row.sampling?'Measuring… ':'' )+(instructions[row.calibration] || '');
    $('native-measure').disabled=row.sampling || ![1,2,3,4].includes(row.calibration);
    $('native-boost').disabled=row.calibration!==1;
  });
  $('native-output').onchange=e=>send('output',e.target.value);
  $('native-words').onchange=e=>send('word-spaces',e.target.checked);
  $('native-start').onclick=()=>{ $('native-cal').hidden=false; send('calibrate'); };
  $('native-measure').onclick=()=>send('sample',$('native-boost').checked);
  $('native-auto').onclick=()=>{ $('native-cal').hidden=true; send('automatic'); };
  $('native-cancel').onclick=()=>{ $('native-cal').hidden=true; send('cancelCalibration'); };
  $('native-write').onchange=async event=>{
    const enable=event.currentTarget.checked;
    if (enable && !$('sound-choice').hidden) {
      $('native-feedback').textContent='Choose the shared sound settings first.'; showInput(); return;
    }
    changingTyping=true; showInput();
    try { await send(enable ? 'arm' : 'disarm'); }
    catch { $('native-feedback').textContent='The paddle engine is unavailable.'; }
    finally { changingTyping=false; showInput(); }
  };
  const updates = document.createElement('section');
  updates.className='card update-bar'; updates.id='mac-updates';
  updates.innerHTML=`<div class="update-version"><h2>Updates</h2><span id="mac-version" class="muted small-copy"></span></div>
    <p id="update-status" role="status"></p>
    <div class="pair-actions"><button type="button" class="button secondary" id="update-check">Check for updates</button>
    <button type="button" class="button primary" id="update-install" hidden>Install update</button>
    <button type="button" class="text-button" id="update-release" hidden>Open GitHub release</button></div>
    <label class="update-auto"><input type="checkbox" id="update-auto"> Automatically update</label>
    <details id="update-notes"><summary>What’s new</summary><p class="update-notes small-copy" id="update-notes-text"></p></details>`;
  document.querySelector('#view-lab .page-intro').after(updates);
  const notice=document.createElement('button');
  notice.id='morse-update'; notice.hidden=true; notice.className='text-button'; notice.type='button';
  document.querySelector('.header-actions').prepend(notice);
  notice.onclick=()=>{
    document.querySelector('.main-nav [data-view="lab"]').click();
    $('update-notes').open=true; updates.scrollIntoView({block:'center'}); $('update-notes').querySelector('summary').focus({preventScroll:true});
  };
  let updateState;
  function drawUpdate(state) {
    if (!state) return;
    updateState=state;
    const busy=state.phase==='checking';
    $('mac-version').textContent='Installed version '+state.version;
    $('update-status').textContent=state.message || (busy ? 'Checking GitHub…' : state.available ? 'Morse '+state.available+' is available.' :
        !state.enabled ? 'Update checks are disabled in this test session.' : state.phase==='checked' ? 'You’re up to date.' : '');
    $('update-check').disabled=!state.enabled || busy;
    $('update-auto').checked=state.automatic; $('update-auto').disabled=!state.automaticSupported;
    $('update-release').hidden=!state.available;
    $('update-install').hidden=!state.available; $('update-install').disabled=busy;
    $('update-install').textContent=state.installable ? 'Install update' : 'Download update';
    notice.hidden=!state.available; notice.textContent='Update available';
    $('update-notes-text').textContent=(state.available ? state.notes : state.installedNotes) || 'No release notes were provided for this version.';
  }
  const action=(name,value)=>api.update(name,value).catch(()=>{
    if (updateState) drawUpdate(updateState);
    $('update-status').textContent='The update settings could not be accessed.';
  });
  $('update-check').onclick=()=>action('check');
  $('update-auto').onchange=e=>action('automatic',e.target.checked);
  $('update-install').onclick=()=>action('install');
  $('update-release').onclick=()=>action('release');
  api.onUpdate(drawUpdate);
  void action('state').then(drawUpdate);
}
