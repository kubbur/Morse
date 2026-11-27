(async()=>{
  const {Receiver}=await import('./js/shack-radio.mjs');
  const {ArrivalTiming}=await import('./js/shack-live.mjs');
  async function check(wpm,jitter,receiveBuffer) {
    const unit=1200/wpm, rate=48000, audio=new OfflineAudioContext(1,rate*4,rate);
    const rx=new Receiver(()=>({tone:650,volume:65}));
    let now=0;
    rx.audio.context={state:'running',get currentTime(){return now;},destination:audio.destination,
      createGain:()=>audio.createGain(),createOscillator:()=>audio.createOscillator()};
    // A hand-sent R, including slight variation between the two dits.
    const source=[0,unit+2,2*unit+3,5*unit+1,6*unit+4,7*unit+3];
    for (const [i,offset] of source.entries()) {
      now=Math.max(now,(offset+jitter[i])/1000);
      rx.key({peer:'operator',stream:'R',edge:i%2?'up':'down',offset,receiveBuffer});
    }
    const pcm=(await audio.startRendering()).getChannelData(0), edges=[];
    let on=false;
    for (let i=0;i<pcm.length;i+=48) {
      let energy=0; for (let k=0;k<48;k++) energy+=pcm[i+k]**2;
      const audible=energy/48>.0004;
      if (audible!==on) edges.push(i/48);
      on=audible;
    }
    const first=jitter[0]+1000*(receiveBuffer ?? .055);
    if (edges.length!==source.length || Math.abs(edges[0]-first)>3) throw Error('Incorrect attack or extra tone at '+wpm+' WPM');
    for (let i=1;i<edges.length;i++) {
      if (Math.abs((edges[i]-edges[i-1])-(source[i]-source[i-1]))>3)
        throw Error('Received timing changed at '+wpm+' WPM: '+JSON.stringify(edges));
    }
  }
  for (const wpm of [8,12,20,30]) await check(wpm,[4,32,46,8,28,12]);
  const path=new ArrivalTiming();
  for (const [i,delay] of [5,125,5,5].entries()) path.observe(10+i+delay/1000,i);
  const measured=path.buffer(14);
  if (Math.abs(measured-.135)>.0001) throw Error('Incorrect measured receive buffer');
  await check(30,[5,125,5,5,125,5],measured);
  window.testComplete=true;
})().catch(e=>window.testFailure=e.message);
