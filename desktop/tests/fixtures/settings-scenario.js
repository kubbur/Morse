(async()=>{
  const get=id=>document.getElementById(id);
  const tab=name=>document.querySelector(`.main-nav [data-view="${name}"]`).click();
  const tick=()=>new Promise(resolve=>setTimeout(resolve,20));
  const expect=(condition,message)=>{ if (!condition) throw Error(message); };
  const wait=async(check,message)=>{ for(let i=0;i<140;i++){if(check()) return;await tick();} throw Error([message,get('send-feedback').textContent,get('pair-message').textContent,get('progress-message').textContent,testRequests.join(',')].join(' · ')); };
  const change=(id,value)=>{
    const node=get(id); node.value=String(value);
    node.dispatchEvent(new Event('input',{bubbles:true})); node.dispatchEvent(new Event('change',{bubbles:true}));
  };
  const current=()=>{const state=testState();return state.profiles.find(p=>p.id===state.activeId);};
  if(get('callsign-intro-dialog').open) get('skip-callsign').click();
  if(get('guidance-dialog').open) get('guidance-close').click();
  expect(document.querySelector('.main-nav button').textContent==='Listen','Listen tab title');
  get('copy-pace').click(); await tick();
  expect(document.activeElement===get('lab-timing-mode'),'Response timing shortcut');
  const keys=[...document.querySelectorAll('[data-setting]')].map(n=>n.dataset.setting);
  expect(new Set(keys).size===keys.length,'Duplicate settings controls');
  expect(get('view-lab').contains(get('send-source')) && get('view-lab').contains(get('send-keyer')), 'Input settings placement');
  expect(!get('view-lab').contains(get('send-setup')) && !get('view-lab').querySelector('[data-view="practice"]'),'Settings still shows quick controls or forced return');
  expect(get('view-lab').textContent.includes('Listening material') && get('view-lab').textContent.includes('Copying and progression'),'Listening settings headings');
  expect(document.querySelector('label[for=lab-goal]').textContent==='Daily listening goal','Goal scope');
  expect(!get('sound-choice').hidden,'Legacy timing choice missing');
  const mac=fixture.mode.startsWith('mac');
  if(mac) {
    expect(get('update-notes-text').textContent==='Local release notes' && !get('update-auto').checked,'Installed release notes and update opt-in');
    get('update-check').click();
    await wait(()=>!get('morse-update').hidden,'Update available notice');
    get('morse-update').click();
    expect(get('update-notes').open && get('update-notes-text').textContent.includes('<em>') && !get('update-notes-text').children.length,'Release notes presentation');
    get('update-auto').click(); expect(get('update-auto').checked,'Automatic update choice');
    get('update-install').click(); expect(window.testInstallRequested,'Install action');
  } else expect(!get('mac-updates'),'Mac updater in browser');
  if(mac) await wait(()=>get('sound-choices').textContent.includes('Use Paddle'),'Native migration unavailable');
  const button=Array.from(get('sound-choices').children).find(b=>b.textContent.startsWith(mac?'Use Paddle':'Use Send'));
  button.click(); await tick();
  expect(current().settings.wpm===(mac?33:24) && !current().previousTiming,'Selected old sound did not persist');
  expect(get('sound-choice').hidden,'Resolved migration visible');
  if(mac) expect(current().settings.tone===750 && current().settings.volume===38,'Paddle sound conversion');
  change('send-source','vband'); await tick();
  expect(get('send-connection').textContent.includes('Right Control sends dah'),'Adapter mapping');
  if(mac) expect(get('view-lab').contains(get('native-start')) && get('native-start').hidden,'Calibration visible for USB');
  change('send-source','paddle');
  if(mac) {
    expect(!get('native-start').hidden && !get('native-target') && !get('native-targets'),'Converter or typing controls');
    window.testPaddleReady();
    expect(!get('native-write').checked && !get('native-write').disabled,'External typing must start off');
    get('native-write').click(); await wait(()=>get('native-write').checked && !get('native-write').disabled,'Enable external typing');
    get('native-write').click(); await wait(()=>!get('native-write').checked && !get('native-write').disabled,'Stop external typing');
  }
  tab('send'); const quick=get('send-setup'); quick.open=true;
  expect(!get('send-next') && get('send-decoded').textContent==='' && !get('send-marks'),'Redundant capture controls');
  expect([...quick.querySelectorAll('input,select,button')].map(n=>n.id).join(',')==='send-wpm,send-farnsworth,send-pitch,send-volume','Unexpected quick control');
  expect(get('send-pitch').step==='50' && get('send-pitch').type==='range','Pitch control');
  change('send-wpm',52);change('send-farnsworth',42);change('send-pitch',1150);change('send-volume',64);
  expect(get('spacing-max').textContent==='52' && get('send-farnsworth').max==='52','Spacing limit');
  expect(quick.querySelector('[data-value="volume"]').textContent==='64','Volume readout');
  change('send-wpm',32);
  expect(current().settings.farnsworth===32 && get('send-farnsworth').value==='32','Shared spacing clamp');
  tab('practice');
  expect(get('view-send').contains(quick) && get('summary-tone').textContent==='1150 Hz','Listening did not use the sending controls');
  tab('lab'); change('lab-curve','exponential'); change('lab-rise',8); change('lab-fall',11);
  expect(current().settings.curve==='exponential' && current().sending.settings.wpm===32,'Shared settings were not saved');
  if(mac) await wait(()=>{const n=testSound();return n?.pitch===1150 && n.volume===64 && n.curve===2 && n.rise===8 && n.fall===11 && n.wpm===32 && n.farnsworth===32;},'Helper missed shared settings');
  get('reset-audio').click();
  expect(current().settings.tone===1150 && current().settings.wpm===32 && current().settings.curve==='smooth','Reset envelope also changed quick controls');
  tab('journey');
  if(fixture.mode==='mac-local') expect(get('leaderboard-message').textContent==='Offline practice' && !testRequests.includes('scores/leaderboard'),'Live leaderboard claimed locally');
  else {
    await wait(()=>testRequests.includes('scores/leaderboard'),'Public ranking read');
    if(fixture.mode==='mac-staging') expect(get('leaderboard-title').textContent==='Local test leaderboard','Test board source missing');
  }
  expect(get('copying-styles').textContent.includes('No answers recorded') && !get('copying-styles').textContent.includes('Ready'),'Copying status');
  expect(!get('journey-recovery'),'Duplicate progress dialog button');
  get('open-progress').click();
  expect(!get('station-empty') && !get('saved-learner'),'Multiple learner controls');
  expect(!get('earlier-saves').hidden && get('earlier-exports').children.length===1,'Old learner export');
  let download;
  const createURL=URL.createObjectURL, clickLink=HTMLAnchorElement.prototype.click;
  try {
    URL.createObjectURL=blob=>{download=blob;return createURL.call(URL,blob);};
    HTMLAnchorElement.prototype.click=()=>{};
    get('earlier-saves').open=true;
    get('earlier-exports').firstElementChild.click();
  } finally { URL.createObjectURL=createURL; HTMLAnchorElement.prototype.click=clickLink; }
  const legacyExport=JSON.parse(await download.text());
  expect(legacyExport.profiles.length===1 && legacyExport.profiles[0].id===fixture.state.profiles[1].id && legacyExport.activeId===legacyExport.profiles[0].id,'Export included another learner');
  expect(!legacyExport.delivery,'Export included private delivery data');
  const selectFile=()=>{
    const selected=new DataTransfer();
    selected.items.add(new File([JSON.stringify(fixture.state)],'old.json',{type:'application/json'}));
    get('import-file').files=selected.files;
    get('import-file').dispatchEvent(new Event('change',{bubbles:true}));
  };
  selectFile();
  await wait(()=>!get('import-confirmation').hidden,'Missing import preview');
  expect(!get('import-selection').hidden,'Old file did not offer a learner choice');
  change('import-learner',legacyExport.activeId);
  expect(get('import-summary').textContent.includes('11 XP'),'Preview used the wrong earlier learner');
  get('cancel-import').click();
  expect(current().stats.xp===70 && testState().profiles.length===2,'Cancelled import altered saved learners');
  expect(get('storage-note').textContent.includes(mac?'this Mac':'this browser'),'Wrong storage description');
  expect(get('station-recovery').disabled,'Recovery enabled while unlinked');
  expect(!testRequests.includes('private/start'),'Setup implicitly linked');
  get('reset-progress').click();
  expect(get('confirm-reset-progress').textContent==='Reset listening levels','Listening reset label');
  get('confirm-reset-progress').click(); await tick();
  expect(current().settings.courseLevel===1 && current().sending.level===9 && current().stats.xp===70,'Reset changed other progress');
  expect(testState().profiles.length===2 && testState().profiles[1].stats.xp===11,'Earlier save changed');
  if(get('guidance-dialog').open) get('guidance-close').click();
  get('open-progress').click();
  if(['mac-local','mac-website'].includes(fixture.mode)) {
    expect(get('pair-devices').hidden && get('station-recovery').disabled && get('private-sync').hidden,'Local-build recovery instructions');
  } else {
    expect(get('pair-devices').textContent==='Enable private sync','Initial private link action');
    get('pair-devices').click();
    await wait(()=>!get('station-recovery').disabled,'Link did not enable code generation');
    expect(get('pair-offer').hidden && get('pair-devices').textContent==='Pair another device','Private sync opened an invitation');
    get('station-recovery').click();
    await wait(()=>!get('recovery-issued').hidden && get('recovery-output').textContent.length===32,'Missing code');
    expect(testRequests.includes('private/recovery-code'),'Wrong recovery path');
    get('progress-dialog').querySelector('[data-close]').click(); await tick();
    expect(get('recovery-issued').hidden && !get('recovery-output').textContent,'Code retained after close');
  }
  if(fixture.mode==='mac-local') {
    const active=current().id;
    for(let attempt=0;attempt<2;attempt++) {
      if(!get('progress-dialog').open) get('open-progress').click();
      selectFile();
      await wait(()=>!get('import-confirmation').hidden,'Repeat import preview '+attempt);
      change('import-learner',legacyExport.activeId);
      get('confirm-import').click();
      await wait(()=>get('import-confirmation').hidden && current().stats.xp===11,'Selected save was not restored');
      const state=testState();
      expect(state.activeId===active && state.profiles.length===2 && state.profiles[1].id===legacyExport.activeId,'Import created or removed a learner');
      expect(!state.delivery.learners[active].scores.length,'Import queued a public score');
    }
  }
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  // An offscreen WebView is hidden to WebKit. Exercise foreground Send with
  // that one lifecycle signal and its display clock supplied by the fixture.
  Object.defineProperty(document,'hidden',{configurable:true,value:false});
  window.dispatchEvent(new Event('focus'));
  const {MorseAudio}=await import('/js/audio.mjs');
  const {KeyTone}=await import('/js/send-ui.mjs');
  const heard=[];
  MorseAudio.prototype.play=async text=>{heard.push(text);return {completed:true};};
  KeyTone.prototype.set=async()=>{};
  change('send-source','straight'); tab('send');
  change('send-level',4); change('send-wpm',30);change('send-farnsworth',30);
  if (document.hidden || document.querySelector('dialog[open]') || get('send-listen').disabled) {
    throw Error('Send fixture state: '+JSON.stringify({visibility:document.visibilityState,hidden:document.hidden,
      dialogs:[...document.querySelectorAll('dialog[open]')].map(n=>n.id),disabled:get('send-listen').disabled}));
  }
  // Let the view change and any native dialog focus restoration finish before
  // measuring practice. Start where the player has scrolled to see their sending.
  await document.fonts?.ready;
  await tick(); await tick();
  window.scrollTo(0,Math.max(0,get('send-capture').getBoundingClientRect().top+scrollY-160));
  await tick();
  const positions = () => ['send-capture','send-feedback','send-metrics'].map(id => {
    const r=get(id).getBoundingClientRect();
    return [Math.round(r.top),Math.round(r.top+scrollY),Math.round(r.height)];
  });
  const above = () => ['send-title','sender','send-instruction','send-exercise','send-target','send-pattern','send-listen','send-input-status'].map(id=>{
    const r=get(id).getBoundingClientRect(); return [id,Math.round(r.top+scrollY),Math.round(r.height)];
  });
  const initialAbove = JSON.stringify(above());
  const initialPositions=JSON.stringify(positions());
  const stable=where=>expect(JSON.stringify(positions())===initialPositions,'Send layout moved '+where+' '+initialPositions+' '+JSON.stringify(positions())+' '+initialAbove+' '+JSON.stringify(above()));
  get('send-listen').click();
  await wait(()=>heard.length && get('send-feedback').textContent.includes('pause'),'Hear EE');
  stable('after playback');
  function key(down,time) {
    const event=new KeyboardEvent(down?'keydown':'keyup',{bubbles:true,cancelable:true,code:'Space',key:' '});
    Object.defineProperty(event,'timeStamp',{value:time}); document.body.dispatchEvent(event);
  }
  // At 30 WPM EE has two 40 ms marks with 120 ms between them.
  key(true,2000); key(false,2040); key(true,2180); key(false,2220);
  expect(get('send-decoded').textContent==='EE','Decoded first transmission: '+get('send-decoded').textContent);
  await wait(()=>document.querySelectorAll('#send-trace .trace-sent').length===2,'Timed marks at width '+get('send-trace').clientWidth);
  const targets=get('send-trace').querySelectorAll('.trace-target'), sent=get('send-trace').querySelectorAll('.trace-sent');
  expect(targets.length===2 && sent[0].style.left===targets[0].style.left && sent[0].style.width===targets[0].style.width,'Target and capture scale');
  expect(parseFloat(sent[1].style.left)>parseFloat(targets[1].style.left) && get('send-trace').textContent.includes('20 ms late'),'Late letter gap');
  stable('during input');
  await wait(()=>get('send-feedback').textContent.includes('Correct'),'Grade actual edges');
  stable('when graded');
  expect(!get('send-next'),'Next exercise appeared after grading');
  await wait(()=>heard.length===2 && get('send-trace').textContent.includes('Last attempt'),'Automatic next and retained comparison');
  stable('on automatic advance');
  key(true,6000);key(false,6120);
  await wait(()=>get('send-feedback').textContent.includes('Replaying'),'Missed exercise retry');
  await wait(()=>heard.length===3 && heard[2]===heard[1],'Automatic replay');
  stable('after a retry');
  if (fixture.mode==='browser') {
    function sendEE(start) { key(true,start); key(false,start+40); key(true,start+160); key(false,start+200); }
    sendEE(8000);
    await wait(()=>heard.length===4,'Replay recovered to the next exercise');
    sendEE(10000);
    await wait(()=>get('send-listen').textContent.includes('Next level'),'Level completion');
    expect(!get('send-next') && current().sending.pendingLevel===5,'Completed level boundary');
    key(true,12000);key(false,12040);
    await wait(()=>current().sending.level===5 && heard.length===5,'Start next level with the key');
    expect(!get('send-decoded').textContent,'Level-start tap entered the answer');
  }
  change('send-level',8); await tick();
  expect(get('send-trace').hidden && !get('send-decoded').textContent,'Blind exercise revealed its target or showed an empty dash');
  if (mac) {
    Object.defineProperty(document,'hasFocus',{configurable:true,value:()=>true});
    change('send-source','paddle'); testPaddleReady();
    await wait(()=>get('send-input-status').textContent.includes('Paddle ready'),'Native paddle status');
    await tick();
    get('send-listen').click();
    await wait(()=>get('send-feedback').textContent.includes('then pause'),'Native playback completed');
    const box = node => {
      const r=node.getBoundingClientRect();
      return [Math.round(r.top),Math.round(r.height),Math.round(r.width)];
    };
    const panel = () => JSON.stringify(['send-capture','send-decoded','send-feedback'].map(id=>box(get(id))));
    const empty = panel();
    expect(!get('send-decoded').textContent && get('send-decoded').offsetHeight>0,'Empty decoded line lost its reserved space');
    testPaddleElement(0,0);
    let graph;
    for (const [start,end,text] of [[1000,1040,'E'],[1080,1200,'A'],[1240,1280,'R']]) {
      testPaddleElement(1,start);testPaddleElement(2,end);
      await wait(()=>get('send-decoded').textContent===text && !get('send-trace').hidden,'Native decoded '+text);
      expect(panel()===empty,'White letter resized panel or shifted feedback for '+text);
      const plot=JSON.stringify(box(get('send-trace').querySelector('.trace-plot')).slice(0,2));
      if (graph) expect(plot===graph,'White letter shifted the graph for '+text);
      graph=plot;
    }
    get('send-retry').click(); await tick();
    expect(!get('send-decoded').textContent && panel()===empty,'Clearing the white R resized the panel');
  }
  get('send-help').click();
  await wait(()=>!get('send-trace').hidden && get('send-trace').querySelector('.trace-target'),'Revealed pattern timing guide');
  window.testComplete=true;
})().catch(error=>{window.testFailure=error.message;});
