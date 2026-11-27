(async()=>{
  const q=s=>document.querySelector(s), qa=s=>[...document.querySelectorAll(s)];
  const check=(ok,m)=>{if(!ok)throw Error(m);};
  const click=s=>{const el=q(s);check(el && !el.disabled,'Unavailable control '+s);el.click();};
  const view=v=>!q('#view-'+v).hidden;
  const key=(kind,code,key)=>q('#shack-station').dispatchEvent(new KeyboardEvent(kind,{key,code,bubbles:true,cancelable:true}));
  const wait=async(cond,msg)=>{for(let i=0;i<90;i++){if(cond())return;await new Promise(r=>setTimeout(r,20));}throw Error(msg);};
  const go=v=>click('.main-nav [data-view="'+v+'"]');
  const tab=v=>click('#shack-station [data-act="tab"][data-id="'+v+'"]');
  const dialTo=f=>{
    const dial=q('[data-dial]'); dial.value=f; dial.dispatchEvent(new Event('input',{bubbles:true}));
  };
  const callOn=f=>click('.band [data-act="tune"][data-f="'+f+'"]');
  const drag=(id,selector)=>{
    const source=q('[data-gear="'+id+'"]'),target=q(selector);
    check(source && target,'Drag endpoints '+id+' → '+selector);
    const transfer={setData(){},dropEffect:'',effectAllowed:''};
    for(const [el,type] of [[source,'dragstart'],[target,'dragover'],[target,'drop']]){
      const event=new Event(type,{bubbles:true,cancelable:true});
      Object.defineProperty(event,'dataTransfer',{value:transfer}); el.dispatchEvent(event);
    }
  };
  let hidden=false,focused=true;
  Object.defineProperty(document,'hasFocus',{configurable:true,value:()=>focused});
  Object.defineProperty(document,'hidden',{configurable:true,get:()=>hidden});
  const background=(enabled,screenOff=false)=>{
    focused=!enabled; hidden=enabled && screenOff;
    window.dispatchEvent(new Event(enabled?'blur':'focus'));
    document.dispatchEvent(new Event('visibilitychange'));
  };
  window.dispatchEvent(new Event('focus'));
  if (fixture.mode==='browser') {
    go('shack');
    check(q('.radio-empty') && !q('.instrument, .radio-layout .shack-paddles, [data-dial]') && !testBandMembers.size,'Empty station showed a radio');
    click('.radio-empty [data-act="shop-radios"]');
    check(q('.shelf [data-id="1-0"]'),'Empty station did not open the radio shop');
    tab('air');
    const label=q('.profile-call small');
    label.scrollIntoView({block:'center'});
    const rect=label.getBoundingClientRect(), hit=document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2);
    check(hit?.closest('button')===label.closest('button') && label.closest('button').offsetHeight>=44,'My profile label missed its tap target');
    hit.click();
    check(q('#operator-profile-dialog').open && q('.operator-call').textContent==='TF3KBR','Tapping My profile did not open the operator');
    click('[data-close="operator-profile-dialog"]');
  }
  go('lab');if(!q('#sound-choice').hidden)q('#sound-choices').firstElementChild.click();
  const mac=fixture.mode.startsWith('mac'),choice=q('#send-source');choice.value=mac?'paddle':'straight';
  choice.dispatchEvent(new Event('change',{bubbles:true}));if(mac)testPaddleReady();
  check(!q('#nav-shack').hidden,'Returning operator has no Shack tab');
  go('shack');check(view('shack') && q('#nav-shack').getAttribute('aria-current')==='page','Top-bar Shack navigation');
  go('journey');click('.shack-xp');check(view('shack'),'XP did not open the Shack');
  tab('log');check(q('.empty').textContent.includes('first card'),'QSL wall');
  click('[data-act="progress"]');check(view('journey') && q('#progress-return').textContent.includes('The Shack'),'Missing return from Progress');
  click('#progress-return');check(view('shack') && q('.shack-nav [aria-current]').dataset.id==='log','Return lost the logbook');
  tab('shop');click('[data-act="bundle"]');
  check(q('.wallet strong').textContent===(8333).toLocaleString()+' XP','Checkout did not debit 5,000 XP');
  click('[data-act="progress"]');check(q('.shack-xp strong').textContent===(8333).toLocaleString()+' XP','Progress balance');
  click('#my-operator-profile');check(q('#operator-profile-dialog').open && q('.operator-xp').textContent.includes((13333).toLocaleString()),'Lifetime XP on My profile');
  check(q('.operator-milestones').textContent.includes('QSL cards') && q('.operator-awards h3').textContent.includes('earned'),'Missing operator achievements');
  click('[data-close="operator-profile-dialog"]');click('#progress-return');
  const learner=()=>testState().profiles[0], startCount=learner().sending.attempts;
  check(learner().stats.xp===13333,'Checkout changed lifetime XP');
  tab('air');check(q('.radio-empty') && !q('.instrument'),'Buying a radio equipped it automatically');
  click('.radio-empty [data-id="bench"]');check(qa('[data-inventory] [data-gear]').length===3 && !q('[data-act="buy"]'),'Purchased gear did not enter inventory');
  drag('0-0','.mount[data-slot="0"]');drag('1-0','.mount[data-slot="1"]');click('[data-act="equip"][data-id="2-0"]');
  tab('shop');click('[data-act="category"][data-slot="0"]');click('[data-act="buy"][data-id="0-1"]');tab('bench');drag('0-1','.mount[data-slot="0"]');
  check(q('[data-inventory] [data-gear="0-0"]'),'Swapped key was lost');
  drag('0-1','[data-inventory]');check(!q('.mount[data-slot="0"] [data-gear]'),'Unequip did not empty the mount');
  tab('air');
  check(q('[data-face="mode"]').textContent==='RX' && q('[data-face="note"]').textContent.includes('equip a Morse key'),'Radio and antenna must receive without a key');
  key('keydown','Space',' ');check(q('[data-face="mode"]').textContent==='RX','Unequipped key transmitted');key('keyup','Space',' ');
  const speed=q('#send-wpm'), lessonSettings=learner().sending.settings, listenWpm=learner().settings.wpm, preferred=lessonSettings.wpm;
  click('[data-act="settings"]');check(q('#shack-input-dialog').open && q('#shack-input-body #send-source')===choice,'Existing input controls in popup');
  check(q('#shack-input-body #send-wpm')===speed && speed.getClientRects().length,'Missing sending speed slider');
  check(!q('#send-continue-mode').getClientRects().length && !q('#send-pause').getClientRects().length,'Lesson controls visible in the Shack');
  check(speed.min==='8' && speed.max==='12' && Number(speed.value)===Math.min(12,Math.max(8,preferred)),'Slow channel slider limits');
  speed.value='10';speed.dispatchEvent(new Event('input',{bubbles:true}));
  check(q('#shack-input-body [data-value="sendWpm"]').textContent==='10','WPM readout while dragging');
  speed.dispatchEvent(new Event('change',{bubbles:true}));
  check(learner().settings.wpm===listenWpm && learner().sending.settings.wpm===preferred,'Slow channel changed training speed');
  click('[data-close="shack-input-dialog"]');await wait(()=>q('#view-lab #send-source')===choice,'Input settings did not return home');
  check(q('#send-setup #send-wpm')===speed && Number(speed.value)===preferred && speed.max==='80','Send lost its preferred speed');
  go('lab');check(q('#send-continue-mode').getClientRects().length && q('#send-pause-control').hidden===(lessonSettings.continueMode!=='timed') && learner().sending.settings.pauseSeconds===lessonSettings.pauseSeconds,'Lesson settings after closing the Shack popup');
  go('journey');click('.shack-xp');
  tab('bench');click('[data-act="equip"][data-id="0-0"]');tab('air');
  check(q('[data-face="frequency"]').textContent==='7.026' && q('[data-face="room"]').textContent==='Slow CW calling frequency','Default slow calling frequency');
  for (const f of [7024,7025,7027,7028,7026]) {
    dialTo(f);
    check([7024,7025,7027,7028].every(n=>!q('.band [data-f="'+n+'"]')) && q('.band [data-f="7026"]'),'Band activity exposed an open slow channel or hid the calling channel');
    check(q('[data-face="pace"]').textContent.includes('8–12') &&
      q('[data-face="room"]').textContent===(f===7026?'Slow CW calling frequency':'Slow CW open channel'),'Starter slow channel '+f);
  }
  const pitchBefore=learner().settings.tone, toneKnob=q('.pitch-knob');
  const minus=q('[data-act="pitch-step"][data-step="-50"]').getBoundingClientRect(), knobRect=toneKnob.getBoundingClientRect();
  check(minus.left-knobRect.right>=0 && minus.left-knobRect.right<=10 && minus.width>=44 && minus.height>=44,'Pitch step buttons too far from the dial or too small');
  click('[data-act="pitch-step"][data-step="50"]');
  check(q('[data-face="pitch"]').textContent===pitchBefore+50+' Hz' && learner().settings.tone===pitchBefore+50,'Radio pitch did not save to the profile');
  if(mac) await wait(()=>testSound()?.pitch===pitchBefore+50,'Radio pitch did not reach the native sidetone');
  toneKnob.setPointerCapture=()=>{};
  const dragPitch=(type,x)=>toneKnob.dispatchEvent(new PointerEvent(type,{pointerId:21,pointerType:'touch',clientX:x,button:0,bubbles:true}));
  dragPitch('pointerdown',10);dragPitch('pointermove',22);
  check(toneKnob.getAttribute('aria-valuenow')===String(pitchBefore+150) && learner().settings.tone===pitchBefore+50,'Pitch drag did not preview two 50 Hz steps');
  dragPitch('pointercancel',22);
  check(q('[data-face="pitch"]').textContent===pitchBefore+50+' Hz','Cancelling pitch drag changed the saved tone');
  dragPitch('pointerdown',10);dragPitch('pointermove',16);dragPitch('pointerup',16);
  check(learner().settings.tone===pitchBefore+100,'Releasing pitch drag did not save its 50 Hz step');
  const turnPitch=key=>toneKnob.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true}));
  turnPitch('Home');check(learner().settings.tone===200 && q('[data-step="-50"]').disabled,'Lower pitch limit');
  turnPitch('End');check(learner().settings.tone===2000 && q('[data-step="50"]').disabled,'Upper pitch limit');
  turnPitch('ArrowDown');check(learner().settings.tone===1950 && toneKnob.getAttribute('aria-valuetext')==='1950 Hz','Pitch keyboard step');
  go('send');
  const guide=q('#view-send > .paddle-guide');
  check(guide?.href==='https://github.com/kubbur/Morse/tree/main/docs/assembly' && guide.target==='_blank' &&
    guide.relList.contains('noopener') && guide.textContent.includes('Build your own Morse paddle'),'Send guide destination');
  check(guide.nextElementSibling===q('#sender') && guide.getBoundingClientRect().height>=44 &&
    parseFloat(getComputedStyle(guide).borderTopWidth)>0,'Send guide is missing its visible tap target above the exercise');
  const sharedPitch=q('#send-pitch');
  check(sharedPitch.value==='1950','Send pitch did not follow the radio');
  sharedPitch.value='600'; sharedPitch.dispatchEvent(new Event('change',{bubbles:true}));
  go('shack');check(q('[data-face="pitch"]').textContent==='600 Hz' && q('[data-face="frequency"]').textContent==='7.026','Shared pitch changed the tuned frequency');
  if (!mac) {
    const {BandRadio,Receiver}=await import('./js/shack-radio.mjs');
    const originalUnlock=Receiver.prototype.unlock;
    let rx;
    const testAudio=new OfflineAudioContext(1,48000,48000);
    Receiver.prototype.unlock=async function() { rx=this; this.audio.context=testAudio; };
    const hiss=()=>q('[data-act="hiss"]');
    check(hiss().getAttribute('aria-pressed')==='false','Hiss should start off');
    tab('bench'); tab('air');
    check(rx && !q('[data-act="monitor"]'),'On air did not start the receiver automatically');
    hiss().click();await wait(()=>rx.hissVoice,'No hiss on live entry');
    const voice=rx.hissVoice;
    let received;
    const keyEvent=rx.key.bind(rx);
    rx.key=e=>{received=e;keyEvent(e);};
    background(true,true);
    testBandEvents.push({type:'key',edge:'down',f:7026,peer:'TEST2',stream:'hidden',offset:0,wpm:10,duration:120});
    await wait(()=>received?.stream==='hidden','Screen lock discarded a live mark');
    check(rx.hissVoice===voice && testBandMembers.size===1,'Screen lock disconnected the receiver');
    background(false);
    click('[data-act="profile"] small');check(!rx.hissVoice,'Hiss leaked into My profile');
    click('[data-close="operator-profile-dialog"]');await wait(()=>rx.hissVoice && rx.hissVoice!==voice,'Hiss did not resume');
    window.testBandOnline=false;
    await wait(()=>!rx.hissVoice && q('[data-face="delay"]').textContent==='— ms','Disconnected room still has hiss or a delay reading');
    window.testBandOnline=true;
    await wait(()=>rx.hissVoice && /^\d+ ms$/.test(q('[data-face="delay"]').textContent),'Reconnect did not restore hiss and round-trip reading');
    hiss().click();check(localStorage.getItem('morse.shack.hiss')==='0','Hiss preference did not clear');
    Receiver.prototype.unlock=originalUnlock;
    const sendDit=q('#send-key-controls #send-dit');
    const marks=[], original=BandRadio.prototype.edge;
    BandRadio.prototype.edge=function(down,at,wpm,duration) {
      if (down) marks.push({wpm,duration});
      return original.call(this,down,at,wpm,duration);
    };
    const setSource=value=>{choice.value=value;choice.dispatchEvent(new Event('change',{bubbles:true}));};
    const closeInputs=async()=>{
      click('[data-close="shack-input-dialog"]');
      await wait(()=>q('#view-lab #send-source')===choice,'Input dialog did not close');
    };
    click('[data-act="settings"]');setSource('keyboard');
    if (!q('#show-paddle-buttons').checked) q('#show-paddle-buttons').click();
    const saveKeys=q('#shack-input-dialog #paddle-bindings button');
    const savedNotice=q('#paddle-keys-saved');
    const saveWidth=saveKeys.getBoundingClientRect().width;
    saveKeys.click();
    check(savedNotice.textContent==='Saved' && getComputedStyle(saveKeys.firstElementChild).opacity==='0' &&
      saveKeys.getBoundingClientRect().width===saveWidth,'Save confirmation did not replace the label in place');
    await new Promise(resolve=>setTimeout(resolve,1100));
    saveKeys.click();
    await new Promise(resolve=>setTimeout(resolve,1100));
    check(savedNotice.textContent==='Saved','A second save did not restart the confirmation');
    await wait(()=>!savedNotice.textContent && getComputedStyle(saveKeys.firstElementChild).opacity==='1','Save keys label did not return');
    await closeInputs();
    const dit=q('.instrument + .shack-paddles [data-shack-paddle="dit"]'),dah=q('.instrument + .shack-paddles [data-shack-paddle="dah"]');
    const radio=q('.instrument').getBoundingClientRect(), touchRect=dit.parentElement.getBoundingClientRect(), band=q('.band').getBoundingClientRect();
    check(touchRect.height>=44 && radio.bottom<=touchRect.top && touchRect.bottom<=band.top,'Phone paddles must sit below the equipped radio and above Band activity');
    for (const button of [dit,dah]) {
      const rect=button?.getBoundingClientRect();
      check(rect && rect.width>=44 && rect.height>=44 && rect.left>=0 && rect.right<=390,'Touch paddles do not fit the phone');
      button.setPointerCapture=()=>{}; // The offscreen host has no physical pointer.
    }
    const touch=(button,type,id)=>button.dispatchEvent(new PointerEvent(type,{pointerType:'touch',button:0,pointerId:id,bubbles:true,cancelable:true}));
    touch(dit,'pointerdown',7);touch(dah,'pointerdown',8);
    await wait(()=>marks.length>=3,'Two held touch paddles did not alternate');
    touch(dit,'pointercancel',7);touch(dah,'pointerup',8);
    const unit=1200/10;
    check(marks.slice(0,3).every((m,i)=>m.wpm===10 && Math.abs(m.duration-unit*(i===1?3:1))<.01),'Wrong touch paddle duration or speed');
    const count=marks.length;await new Promise(resolve=>setTimeout(resolve,280));
    check(marks.length===count && q('[data-face="mode"]').textContent==='RX','Cancelled touch kept sending');
    touch(dah,'pointerdown',9);touch(dah,'pointerup',9);
    check(marks.length===count+1 && Math.abs(marks.at(-1).duration-3*unit)<.01,'Touch dash after cancellation');
    await new Promise(resolve=>setTimeout(resolve,5*unit));
    dit.parentElement.scrollIntoView({block:'center'});
    const dot=dit.getBoundingClientRect(), dash=dah.getBoundingClientRect(), y=dot.top+dot.height/2;
    const slide=x=>dah.dispatchEvent(new PointerEvent('pointermove',{pointerType:'touch',pointerId:10,clientX:x,clientY:y,bubbles:true}));
    const begin=marks.length;
    touch(dah,'pointerdown',10);
    slide((dot.right+dash.left)/2); slide(dot.left+dot.width/2);
    check(dit.hasAttribute('data-held') && !dah.hasAttribute('data-held'),'Touch highlight stayed on Dash');
    slide(dash.left+dash.width/2);touch(dah,'pointerup',10);
    await wait(()=>marks.length>=begin+3,'One finger failed to send K');
    await new Promise(resolve=>setTimeout(resolve,5*unit));
    check(marks.slice(begin).map(m=>Math.round(m.duration/unit)).join(' ')==='3 1 3' && !dah.hasAttribute('data-held'),'Extra or missing marks in K');
    touch(dah,'pointerdown',10); touch(dit,'pointerdown',11);
    slide(dot.left+dot.width/2); touch(dit,'pointerup',11);
    check(dit.hasAttribute('data-held') && !dah.hasAttribute('data-held'),'Lifting the second finger released the first');
    touch(dah,'pointercancel',10);
    check(!dit.hasAttribute('data-held'),'Cancelled slide left a paddle held');
    click('[data-act="settings"]');q('#show-paddle-buttons').click();await closeInputs();
    check(!dit.getClientRects().length && !dah.getClientRects().length,'Unchecked paddles are still visible');
    go('send');check(q('#send-key-controls #send-dit')===sendDit && sendDit!==dit,'Send lost its independent touch controls');
    go('shack');click('[data-act="settings"]');setSource('straight');await closeInputs();
    BandRadio.prototype.edge=original;
  }
  check(!/Hold to key|Call CQ/.test(q('.transmit').textContent),'Synthetic key controls');
  if(mac){
    await wait(()=>testSound()?.wpm===10,'Native paddle did not receive the slow-channel speed');
    await wait(()=>testPaddleMuted()===false,'Paddle remained muted in the Shack');
    check(testShackRadio.listening && testShackRadio.keys===null,'Physical paddle unexpectedly armed background keyboard');
    background(true,true);
    testPaddleElement(0,0);testPaddleElement(1,100);
  } else key('keydown','Space',' ');
  check(q('[data-face="mode"]').textContent==='TX','First key down did not transmit');
  if(mac){testPaddleElement(2,180);testPaddleElement(0,600);}else key('keyup','Space',' ');
  check(q('[data-face="mode"]').textContent==='RX' && learner().sending.attempts===startCount,'Key release or lesson isolation');
  if (mac) {
    await wait(()=>testTransmissions.some(tx=>tx.f===7026),'Background hardware did not reach the relay');
    background(false);
    click('[data-act="settings"]');
    choice.value='straight'; choice.dispatchEvent(new Event('change',{bubbles:true}));
    const toggle=q('#shack-input-dialog #shack-background-keys');
    check(toggle.getClientRects().length && !toggle.checked,'Background key switch must default off in Shack Input settings');
    window.testKeyPermission={error:'Input Monitoring denied'};
    toggle.click(); await wait(()=>!toggle.disabled,'Permission result pending');
    check(!toggle.checked && q('#shack-background-hint').textContent.includes('denied'),'Denied permission enabled capture');
    window.testKeyPermission={}; toggle.click();
    await wait(()=>!toggle.disabled && localStorage.getItem('morse.shack.backgroundKeys')==='1','Key preference did not save');
    click('[data-close="shack-input-dialog"]');
    await wait(()=>testShackRadio.keys?.source==='straight','Selected Space key missing');
    const generation=testShackRadio.generation;
    background(true); testShackContact({generation,mask:1,at:4000});
    check(q('[data-face="mode"]').textContent==='TX','Background keystroke paddle did not send');
    testShackContact({generation,mask:0,at:4100});
    background(false);
    for (const id of ['bench','shop','log']) {
      tab(id);
      await wait(()=>!testShackRadio.listening && testBandMembers.size===0,'Radio stayed active in '+id);
      tab('air');
      await wait(()=>testShackRadio.listening && testBandMembers.size===1,'On air did not rejoin after '+id);
    }
    background(true); testShackContact({generation,mask:1,at:4200});
    check(q('[data-face="mode"]').textContent==='RX','An old contact keyed the new room');
    background(false); click('[data-act="settings"]');
    choice.value='keyboard'; choice.dispatchEvent(new Event('change',{bubbles:true}));
    click('[data-close="shack-input-dialog"]');
    await wait(()=>testShackRadio.keys?.source==='keyboard','Keyboard paddle choice did not reach Mac');
    const paddleState=testShackRadio, markCount=testTransmissions.length;
    background(true,true);
    testShackContact({generation:paddleState.generation,mask:2,at:5000});
    check(q('[data-face="mode"]').textContent==='TX','Background keyboard dash did not begin');
    testShackContact({generation:paddleState.generation,mask:0,at:5010});
    await wait(()=>testTransmissions.length>markCount,'Keyboard paddle did not finish a mark with the window hidden');
    check(testTransmissions.at(-1).audio[0][0]===360,'Background dash did not retain its 10 WPM duration');
    background(false); click('[data-act="settings"]');
    toggle.click(); await wait(()=>!toggle.disabled && !toggle.checked,'Disabling background keys');
    choice.value='paddle'; choice.dispatchEvent(new Event('change',{bubbles:true}));
    click('[data-close="shack-input-dialog"]');
    await wait(()=>testShackRadio.listening && testShackRadio.keys===null,'Hardware paddle restore');
  }
  callOn(7031);
  if(mac){testPaddleElement(0,700);testPaddleElement(1,800);}else key('keydown','Space',' ');
  check(q('[data-face="mode"]').textContent==='RX','Locked frequency transmitted');
  if(mac){testPaddleElement(2,880);testPaddleElement(0,1000);}else key('keyup','Space',' ');
  tab('shop');click('[data-act="bundle"]');
  check(!q('#nav-shack').hidden && q('.wallet strong').textContent==='0 XP','Spending all XP relocked the Shack');
  tab('bench');
  for(const slot of [0,1,2])click('[data-act="equip"][data-id="'+slot+'-1"]');
  tab('air');check(q('.instrument').dataset.rig==='1' && q('.facehead').textContent.includes('Club transceiver'),'Equipped radio face');
  if(mac){await wait(()=>testPaddleMuted()===false,'Club station paddle mute');testPaddleElement(0,1200);testPaddleElement(1,1300);}
  else key('keydown','Space',' ');
  check(q('[data-face="mode"]').textContent==='TX' && !q('#shack-check-dialog'),'Club station required a separate qualification');
  if(mac)testPaddleElement(2,1360);else key('keyup','Space',' ');
  const closeSpeed=async()=>{
    click('[data-close="shack-input-dialog"]');
    await wait(()=>q('#view-lab #send-source')===choice,'Shack speed control did not return home');
  };
  for (const [calling,name,pace,min,max,selected] of [[7031,'Medium CW','12–25 WPM',12,25,19],[7036,'Fast CW','25+ WPM',25,80,37]]) {
    callOn(calling);
    for (let f=calling-2;f<=calling+2;f++) {
      dialTo(f);
      check(q('[data-face="frequency"]').textContent===(f/1000).toFixed(3) && q('[data-face="pace"]').textContent===pace,'Dial or pace at '+f);
      check(q('[data-face="room"]').textContent===name+(f===calling?' calling frequency':' open channel'),'Wrong channel label at '+f);
      check(qa('.band [data-f]').map(el=>el.dataset.f).join(',')==='7026,7031,7036','Band activity exposed a working channel at '+f);
    }
    click('[data-act="settings"]');
    check(Number(speed.min)===min && Number(speed.max)===max && Number(speed.value)===Math.max(min,Math.min(max,preferred)),'Slider limits or default at '+calling);
    speed.value=selected; speed.dispatchEvent(new Event('input',{bubbles:true})); speed.dispatchEvent(new Event('change',{bubbles:true}));
    await closeSpeed();
    if (mac) await wait(()=>testSound()?.wpm===selected,'Native paddle speed on '+calling);
  }
  for (const [calling,selected] of [[7026,10],[7031,19],[7036,37]]) {
    callOn(calling); click('[data-act="settings"]');
    check(Number(speed.value)===selected,'Calling frequency lost its working-channel speed at '+calling);
    await closeSpeed();
  }
  dialTo(7039); click('[data-act="settings"]');
  check(speed.min==='5' && speed.max==='80' && Number(speed.value)===preferred,'Speed leaked onto an unrestricted frequency');
  check(learner().settings.wpm===listenWpm && learner().sending.settings.wpm===preferred,'Changing groups changed the lesson speeds');
  await closeSpeed(); callOn(7031);
  tab('bench');click('[data-act="equip"][data-id="1-0"]');tab('air');
  check(q('.instrument').dataset.rig==='0' && q('[data-face="note"]').textContent.includes((13333).toLocaleString()+' XP station'),'Downgrade must change face and frequencies');
  click('[data-act="progress"]');click('.progress-practice-actions [data-view="send"]');check(view('send'),'Practice sending route');
  go('journey');click('.progress-practice-actions [data-view="practice"]');check(view('practice'),'Practice listening route');
  window.testComplete=true;
})().catch(e=>window.testFailure=e.message);
