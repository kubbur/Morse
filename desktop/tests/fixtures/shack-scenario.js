(async()=>{
  const q=s=>document.querySelector(s), qa=s=>[...document.querySelectorAll(s)];
  const check=(ok,m)=>{if(!ok)throw Error(m);};
  const click=s=>{const el=q(s);check(el && !el.disabled,'Unavailable control '+s);el.click();};
  const view=v=>!q('#view-'+v).hidden;
  const key=(kind,code,key)=>q('#shack-station').dispatchEvent(new KeyboardEvent(kind,{key,code,bubbles:true,cancelable:true}));
  const wait=async(cond,msg)=>{for(let i=0;i<90;i++){if(cond())return;await new Promise(r=>setTimeout(r,20));}throw Error(msg);};
  const go=v=>click('.main-nav [data-view="'+v+'"]');
  const tab=v=>click('#shack-station [data-act="tab"][data-id="'+v+'"]');
  const drag=(id,selector)=>{
    const source=q('[data-gear="'+id+'"]'),target=q(selector);
    check(source && target,'Drag endpoints '+id+' → '+selector);
    const transfer={setData(){},dropEffect:'',effectAllowed:''};
    for(const [el,type] of [[source,'dragstart'],[target,'dragover'],[target,'drop']]){
      const event=new Event(type,{bubbles:true,cancelable:true});
      Object.defineProperty(event,'dataTransfer',{value:transfer}); el.dispatchEvent(event);
    }
  };
  Object.defineProperty(document,'hasFocus',{configurable:true,value:()=>true});
  Object.defineProperty(document,'hidden',{configurable:true,get:()=>false});
  window.dispatchEvent(new Event('focus'));
  if (fixture.mode==='browser') {
    go('shack');
    const pair=q('.instrument + .shack-paddles'), keys=q('#send-key-controls #send-paddles');
    check(pair && !pair.hidden && pair.children.length===2 && keys,'Returning keyboard operator lost the radio paddles');
    const radio=q('.instrument').getBoundingClientRect(), touch=pair.getBoundingClientRect(), band=q('.band').getBoundingClientRect();
    check(touch.height>=44 && radio.bottom<=touch.top && touch.bottom<=band.top,'Phone paddles must sit below the radio and above Band activity');
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
  click('[data-close="operator-profile-dialog"]');click('#progress-return');
  const learner=()=>testState().profiles[0], startCount=learner().sending.attempts;
  check(learner().stats.xp===13333,'Checkout changed lifetime XP');
  tab('bench');check(qa('[data-inventory] [data-gear]').length===3 && !q('[data-act="buy"]'),'Purchased gear did not enter inventory');
  drag('0-0','.mount[data-slot="0"]');drag('1-0','.mount[data-slot="1"]');click('[data-act="equip"][data-id="2-0"]');
  tab('shop');click('[data-act="buy"][data-id="0-1"]');tab('bench');drag('0-1','.mount[data-slot="0"]');
  check(q('[data-inventory] [data-gear="0-0"]'),'Swapped key was lost');
  drag('0-1','[data-inventory]');check(!q('.mount[data-slot="0"] [data-gear]'),'Unequip did not empty the mount');
  tab('air');
  check(q('[data-face="mode"]').textContent==='RX' && q('[data-face="note"]').textContent.includes('equip a Morse key'),'Radio and antenna must receive without a key');
  key('keydown','Space',' ');check(q('[data-face="mode"]').textContent==='RX','Unequipped key transmitted');key('keyup','Space',' ');
  const speed=q('#send-wpm'), lessonSettings=learner().sending.settings, listenWpm=learner().settings.wpm;
  click('[data-act="settings"]');check(q('#shack-input-dialog').open && q('#shack-input-body #send-source')===choice,'Existing input controls in popup');
  check(q('#shack-input-body #send-wpm')===speed && speed.getClientRects().length,'Missing sending speed slider');
  check(!q('#send-continue-mode').getClientRects().length && !q('#send-pause').getClientRects().length,'Lesson controls visible in the Shack');
  speed.value='18';speed.dispatchEvent(new Event('input',{bubbles:true}));
  check(q('#shack-input-body [data-value="sendWpm"]').textContent==='18','WPM readout while dragging');
  speed.dispatchEvent(new Event('change',{bubbles:true}));
  check(learner().settings.wpm===listenWpm && learner().sending.settings.wpm===18,'Shack keyer or listening speed after adjustment');
  if(mac) await wait(()=>testSound()?.wpm===18,'Native paddle did not receive Shack speed');
  click('[data-close="shack-input-dialog"]');await wait(()=>q('#view-lab #send-source')===choice,'Input settings did not return home');
  check(q('#send-setup #send-wpm')===speed && speed.value==='18','Send lost the shared speed slider');
  go('lab');check(q('#send-continue-mode').getClientRects().length && q('#send-pause-control').hidden===(lessonSettings.continueMode!=='timed') && learner().sending.settings.pauseSeconds===lessonSettings.pauseSeconds,'Lesson settings after closing the Shack popup');
  go('journey');click('.shack-xp');
  tab('bench');click('[data-act="equip"][data-id="0-0"]');tab('air');
  check(q('[data-face="frequency"]').textContent==='7.026' && q('[data-face="room"]').textContent==='Slow CW calling frequency','Default slow calling frequency');
  for (const f of [7024,7025,7027,7028,7026]) {
    click('[data-act="tune"][data-f="'+f+'"]');
    check(q('[data-act="open-check"]').hidden && q('[data-face="pace"]').textContent.includes('8–12') &&
      q('[data-face="room"]').textContent===(f===7026?'Slow CW calling frequency':'Slow CW open channel'),'Starter slow channel '+f);
  }
  const pitchBefore=learner().settings.tone, toneKnob=q('.pitch-knob');
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
  const sharedPitch=q('#send-pitch');
  check(sharedPitch.value==='1950','Send pitch did not follow the radio');
  sharedPitch.value='600'; sharedPitch.dispatchEvent(new Event('change',{bubbles:true}));
  go('shack');check(q('[data-face="pitch"]').textContent==='600 Hz' && q('[data-face="frequency"]').textContent==='7.026','Shared pitch changed the tuned frequency');
  if (!mac) {
    const {BandRadio,Receiver}=await import('./js/shack-radio.mjs');
    const originalUnlock=Receiver.prototype.unlock;
    let rx;
    Receiver.prototype.unlock=async function() {
      rx=this; this.audio.context=new OfflineAudioContext(1,48000,48000);
    };
    const hiss=()=>q('[data-act="hiss"]');
    check(hiss().getAttribute('aria-pressed')==='false','Hiss should start off');
    hiss().click();check(localStorage.getItem('morse.shack.hiss')==='1' && !rx,'Hiss preference started a stopped receiver');
    click('[data-act="monitor"]');await wait(()=>rx?.hissVoice,'No hiss while listening');
    const voice=rx.hissVoice;
    click('[data-act="profile"] small');check(!rx.hissVoice,'Hiss leaked into My profile');
    click('[data-close="operator-profile-dialog"]');await wait(()=>rx.hissVoice && rx.hissVoice!==voice,'Hiss did not resume');
    click('[data-act="monitor"]');check(!rx.hissVoice,'Receiver still hissing after Stop listening');
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
    await closeInputs();
    const dit=q('.instrument + .shack-paddles [data-shack-paddle="dit"]'),dah=q('.instrument + .shack-paddles [data-shack-paddle="dah"]');
    for (const button of [dit,dah]) {
      const rect=button?.getBoundingClientRect();
      check(rect && rect.width>=44 && rect.height>=44 && rect.left>=0 && rect.right<=390,'Touch paddles do not fit the phone');
      button.setPointerCapture=()=>{}; // The offscreen host has no physical pointer.
    }
    const touch=(button,type,id)=>button.dispatchEvent(new PointerEvent(type,{pointerType:'touch',button:0,pointerId:id,bubbles:true,cancelable:true}));
    touch(dit,'pointerdown',7);touch(dah,'pointerdown',8);
    await wait(()=>marks.length>=3,'Two held touch paddles did not alternate');
    touch(dit,'pointercancel',7);touch(dah,'pointerup',8);
    const unit=1200/18;
    check(marks.slice(0,3).every((m,i)=>m.wpm===18 && Math.abs(m.duration-unit*(i===1?3:1))<.01),'Wrong touch paddle duration or speed');
    const count=marks.length;await new Promise(resolve=>setTimeout(resolve,280));
    check(marks.length===count && q('[data-face="mode"]').textContent==='RX','Cancelled touch kept sending');
    touch(dah,'pointerdown',9);touch(dah,'pointerup',9);
    check(marks.length===count+1 && Math.abs(marks.at(-1).duration-3*unit)<.01,'Touch dash after cancellation');
    click('[data-act="settings"]');q('#show-paddle-buttons').click();await closeInputs();
    check(!dit.getClientRects().length && !dah.getClientRects().length,'Unchecked paddles are still visible');
    go('send');check(q('#send-key-controls #send-dit')===sendDit && sendDit!==dit,'Send lost its independent touch controls');
    go('shack');click('[data-act="settings"]');setSource('straight');await closeInputs();
    BandRadio.prototype.edge=original;
  }
  check(!/Hold to key|Call CQ/.test(q('.transmit').textContent),'Synthetic key controls');
  if(mac){
    await wait(()=>testPaddleMuted()===false,'Paddle remained muted in the Shack');
    testPaddleElement(0,0);testPaddleElement(1,100);
  } else key('keydown','Space',' ');
  check(q('[data-face="mode"]').textContent==='TX','First key down did not transmit');
  if(mac){testPaddleElement(2,180);testPaddleElement(0,600);}else key('keyup','Space',' ');
  check(q('[data-face="mode"]').textContent==='RX' && learner().sending.attempts===startCount,'Key release or lesson isolation');
  click('[data-act="tune"][data-f="7030"]');
  if(mac){testPaddleElement(0,700);testPaddleElement(1,800);}else key('keydown','Space',' ');
  check(q('[data-face="mode"]').textContent==='RX','Locked frequency transmitted');
  if(mac){testPaddleElement(2,880);testPaddleElement(0,1000);}else key('keyup','Space',' ');
  tab('shop');click('[data-act="bundle"]');
  check(!q('#nav-shack').hidden && q('.wallet strong').textContent==='0 XP','Spending all XP relocked the Shack');
  tab('bench');
  for(const slot of [0,1,2])click('[data-act="equip"][data-id="'+slot+'-1"]');
  tab('air');check(q('.instrument').dataset.rig==='1' && q('.facehead').textContent.includes('Club transceiver'),'Equipped radio face');
  check(!q('#shack-station .check') && !q('#shack-check-dialog').open,'Training prompt should wait for a TX attempt');
  if(mac){await wait(()=>testPaddleMuted()===false,'Qualification trigger mute');testPaddleElement(0,1200);testPaddleElement(1,1300);testPaddleElement(2,1360);}
  else {key('keydown','Space',' ');key('keyup','Space',' ');}
  check(q('#shack-check-dialog').open,'Key on a training-locked frequency must open the check');
  click('#shack-check-dialog [data-act="check"]');
  check(q('#shack-check-dialog .challenge-char').textContent==='E','Only the missing character');
  const unit=Math.round(1200/learner().sending.settings.wpm);
  if(mac) {await wait(()=>testPaddleMuted()===false,'Check paddle mute');testPaddleElement(0,1600);testPaddleElement(1,1700);testPaddleElement(2,1700+unit);}
  else {
    for(const [type,at] of [['keydown',1800],['keyup',1800+unit]]) {
      const event=new KeyboardEvent(type,{code:'Space',key:' ',bubbles:true,cancelable:true});
      Object.defineProperty(event,'timeStamp',{value:at});document.activeElement.dispatchEvent(event);
    }
  }
  await wait(()=>!q('#shack-check-dialog').open,'Completing the qualification popup');
  check(q('[data-act="open-check"]').hidden && learner().stats.xp===13633,'Qualification completion and one-time award');
  tab('bench');click('[data-act="equip"][data-id="1-0"]');tab('air');
  check(q('.instrument').dataset.rig==='0' && q('[data-face="note"]').textContent.includes((13333).toLocaleString()+' XP station'),'Downgrade must change face and frequencies');
  click('[data-act="progress"]');click('.progress-practice-actions [data-view="send"]');check(view('send'),'Practice sending route');
  go('journey');click('.progress-practice-actions [data-view="practice"]');check(view('practice'),'Practice listening route');
  window.testComplete=true;
})().catch(e=>window.testFailure=e.message);
