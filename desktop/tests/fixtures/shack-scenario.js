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
  go('lab');if(!q('#sound-choice').hidden)q('#sound-choices').firstElementChild.click();
  const mac=fixture.mode.startsWith('mac'),choice=q('#send-source');choice.value=mac?'paddle':'straight';
  choice.dispatchEvent(new Event('change',{bubbles:true}));if(mac)testPaddleReady();
  go('journey');click('.shack-xp');check(view('shack'),'XP did not open the Shack');
  tab('log');check(q('.empty').textContent.includes('first card'),'QSL wall');
  click('[data-act="progress"]');check(view('journey') && q('#progress-return').textContent.includes('The Shack'),'Missing return from Progress');
  click('#progress-return');check(view('shack') && q('.shack-nav [aria-current]').dataset.id==='log','Return lost the logbook');
  tab('shop');click('[data-act="bundle"]');
  check(q('.wallet strong').textContent==='500 XP','Checkout did not debit 300 XP');
  click('[data-act="progress"]');check(q('.shack-xp strong').textContent==='500 XP','Progress balance');
  click('#my-operator-profile');check(q('#operator-profile-dialog').open && q('.operator-xp').textContent.includes('800'),'Lifetime XP on My profile');
  click('[data-close="operator-profile-dialog"]');click('#progress-return');
  const learner=()=>testState().profiles[0], startCount=learner().sending.attempts;
  check(learner().stats.xp===800,'Checkout changed lifetime XP');
  tab('bench');check(qa('[data-inventory] [data-gear]').length===3 && !q('[data-act="buy"]'),'Purchased gear did not enter inventory');
  drag('0-0','.mount[data-slot="0"]');drag('1-0','.mount[data-slot="1"]');click('[data-act="equip"][data-id="2-0"]');
  tab('shop');click('[data-act="buy"][data-id="0-1"]');tab('bench');drag('0-1','.mount[data-slot="0"]');
  check(q('[data-inventory] [data-gear="0-0"]'),'Swapped key was lost');
  drag('0-1','[data-inventory]');check(!q('.mount[data-slot="0"] [data-gear]'),'Unequip did not empty the mount');
  tab('air');
  check(q('[data-face="mode"]').textContent==='RX' && q('[data-face="note"]').textContent.includes('equip a Morse key'),'Radio and antenna must receive without a key');
  key('keydown','Space',' ');check(q('[data-face="mode"]').textContent==='RX','Unequipped key transmitted');key('keyup','Space',' ');
  click('[data-act="settings"]');check(q('#shack-input-dialog').open && q('#shack-input-body #send-source')===choice,'Existing input controls in popup');
  click('[data-close="shack-input-dialog"]');await wait(()=>q('#view-lab #send-source')===choice,'Input settings did not return home');
  tab('bench');click('[data-act="equip"][data-id="0-0"]');tab('air');
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
  tab('shop');click('[data-act="bundle"]');tab('bench');
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
  check(q('[data-act="open-check"]').hidden && learner().stats.xp===1100,'Qualification completion and one-time award');
  tab('bench');click('[data-act="equip"][data-id="1-0"]');tab('air');
  check(q('.instrument').dataset.rig==='0' && q('[data-face="note"]').textContent.includes('800 XP station'),'Downgrade must change face and frequencies');
  click('[data-act="progress"]');click('.progress-practice-actions [data-view="send"]');check(view('send'),'Practice sending route');
  go('journey');click('.progress-practice-actions [data-view="practice"]');check(view('practice'),'Practice listening route');
  window.testComplete=true;
})().catch(e=>window.testFailure=e.message);
