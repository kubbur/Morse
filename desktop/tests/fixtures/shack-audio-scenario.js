(async()=>{
  const {Receiver}=await import('./js/shack-radio.mjs');
  async function check(wpm,manual) {
    const unit=1200/wpm, rate=48000, audio=new OfflineAudioContext(1,rate*4,rate);
    const rx=new Receiver(()=>({tone:650,volume:65,wpm:15}));
    let now=0;
    rx.audio.context={state:'running',get currentTime(){return now;},destination:audio.destination,
      createGain:()=>audio.createGain(),createOscillator:()=>audio.createOscillator()};
    // A hand-keyed R has its own fist. Paddle notes are available from key-down.
    const lengths=manual ? [unit+2,3*unit-2,unit-1] : [unit,3*unit,unit];
    const gaps=manual ? [unit+1,unit+3] : [unit,unit];
    const source=[];
    let offset=0;
    for (const [i,duration] of lengths.entries()) {
      const transit=[12,3,6][i];
      now=(offset+transit+(manual ? duration : 0))/1000;
      rx.key({peer:'operator',stream:'R',edge:'down',offset,duration,wpm,measured:manual});
      source.push(offset,offset+duration);
      offset+=duration+(gaps[i] || 0);
    }
    // The paddle's releases are deliberately absent from the audio path.
    const pcm=(await audio.startRendering()).getChannelData(0), edges=[];
    let on=false;
    for (let i=0;i<pcm.length;i+=48) {
      let energy=0; for (let k=0;k<48;k++) energy+=pcm[i+k]**2;
      const audible=energy/48>.0004;
      if (audible!==on) edges.push(i/48);
      on=audible;
    }
    const first=12+3*unit;
    if (edges.length!==source.length || edges.some((at,i)=>Math.abs(at-first-source[i])>3))
      throw Error('Rendered R changed at '+wpm+' WPM: '+JSON.stringify(edges));
  }
  for (const wpm of [5,8,12,20,30,80]) {
    await check(wpm,false);
    await check(wpm,true);
  }
  // Render hiss and a received mark into one PCM buffer, including both mute transitions.
  const rate=48000, offline=new OfflineAudioContext(1,rate,rate);
  let clock=0;
  const rx=new Receiver(()=>({tone:750,volume:70,wpm:30}));
  rx.audio.context={state:'running',sampleRate:rate,get currentTime(){return clock;},destination:offline.destination,
    createBuffer:(...args)=>offline.createBuffer(...args),createBufferSource:()=>offline.createBufferSource(),
    createBiquadFilter:()=>offline.createBiquadFilter(),createGain:()=>offline.createGain(),createOscillator:()=>offline.createOscillator()};
  clock=.05;rx.setHiss(true);
  const voice=rx.hissVoice;
  clock=.12;rx.setHiss(true);
  if(rx.hissVoice!==voice) throw Error('Refreshing the radio duplicated the noise source');
  rx.key({peer:'test',stream:'pitch',edge:'down',offset:0,duration:100,wpm:30});
  clock=.38;rx.setHiss(false);
  const pcm=(await offline.startRendering()).getChannelData(0);
  const samples=(start,end)=>pcm.subarray(Math.round(start*rate),Math.round(end*rate));
  const rms=data=>Math.sqrt(data.reduce((sum,x)=>sum+x*x,0)/data.length);
  const hiss=rms(samples(.11,.21)), tone=samples(.25,.33);
  let crossings=0;
  for(let i=1;i<tone.length;i++) if(tone[i-1]<0 && tone[i]>=0) crossings++;
  if(rms(samples(0,.04))!==0 || hiss<.0001 || hiss>rms(tone)/4 || rms(samples(.43,.55))!==0)
    throw Error('Receiver hiss did not respect its level or mute state');
  if(Math.abs(crossings/.08-750)>25) throw Error('Received tone did not use the selected pitch');
  window.testComplete=true;
})().catch(e=>window.testFailure=e.message);
