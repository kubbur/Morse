window.addEventListener('error', event => { window.testFailure = event.message || 'Page error'; });
window.addEventListener('unhandledrejection', event => { window.testFailure = event.reason?.message || 'Promise rejected'; });

const config = window.fixture;
// This offscreen WebView does not provide a foreground display clock.
window.requestAnimationFrame=fn=>setTimeout(()=>fn(performance.now()),10);
window.cancelAnimationFrame=clearTimeout;
// This private, single-view WebKit host does not provide a cross-tab lock manager.
if (!navigator.locks) Object.defineProperty(navigator,'locks',{value:{request:async(_name,fn)=>fn()}});
localStorage.setItem('morse.progress.v1',JSON.stringify(config.state));
let raw = null, revision = 0, serverProfile, lastSound, paddleMuted;
const callbacks = [], commands = [], requests = [];
window.testBandEvents=[];
window.testBandMembers=new Set();
window.testTransmissions=[];
let roomNumber=0;
const hardware = { type:'status', source:'off', phase:'waiting', output:'auto', outputs:[], outputReady:false, session:1, epoch:1,
  wpm:33, spacing:20, pitch:725, volume:38, rise:3, fall:9, curve:2, hasTone:true, hasVolume:true, sharedSound:false };
function snapshot() { return { connected:true, profile:serverProfile, seq:0, revision:1, epoch:'fixture-epoch', devices:[] }; }
const listing = { visible:null, revision:0, xp:30 };
function exchange(action,body) {
  requests.push(action);
  if (action==='shack/open' || action==='shack/poll') {
    if (window.testBandOnline===false) return {status:503,error:'Test relay offline'};
    const token=action==='shack/open'?'room-'+(++roomNumber):body.token;
    if (action==='shack/open') testBandMembers.add(token);
    return {token,live:false,cursor:0,activity:{[body.f]:1},events:action==='shack/poll'?testBandEvents.splice(0):[]};
  }
  if (action==='shack/leave') {testBandMembers.delete(body.token);return {};}
  if (action==='shack/send') {testTransmissions.push(body);return {ack:body.seq};}
  if (action==='capabilities') {
    const v2 = ['mac-staging','mac-dev'].includes(config.mode);
    return {status:200, privateSync:v2, scores:v2, leaderboard:config.mode!=='mac-local'};
  }
  if (config.listing && action.startsWith('scores/')) {
    if (action==='scores/leaderboard') return {entries:listing.visible===false ? [] : [{rank:1,callsign:'TEST1',xp:listing.xp,streak:1}],me:null};
    if (action==='scores/session') return {ready:true};
    if (action==='scores/listing') return {...listing};
    if (action==='scores/visibility') {
      if (body.revision!==listing.revision) return {status:409,error:'Listing changed.'};
      if (body.visible!==listing.visible) listing.revision++;
      listing.visible=body.visible;
      if (body.visible) listing.xp=Math.max(listing.xp,body.xp);
      return {...listing};
    }
    if (action==='scores/total') return {...listing,acknowledged:body.results.map(r=>r.id)};
    if (action==='scores/achievements') return {achievements:body.achievements};
  }
  if (action==='scores/leaderboard') return {entries:[{rank:1,callsign:'TEST1',xp:30,streak:1}],me:null};
  if (action==='private/adopt') return {status:403,error:'No earlier browser credential.'};
  if (action==='private/start') {
    serverProfile=body.profile;
    return body.invite===false ? snapshot() : {...snapshot(),invitation:'i'.repeat(43),invite:{expiresAt:Date.now()+300000}};
  }
  if (action==='private/status') return serverProfile ? snapshot() : {connected:false};
  if (action==='private/recovery-code' && serverProfile) return {code:'r'.repeat(32)};
  return {status:503,error:'Fixture service unavailable'};
}
if (config.mode.startsWith('mac')) {
  const update = {version:'1.1.0-dev.5',installedNotes:'Local release notes',enabled:true,
    channel:'stable',automatic:false,automaticSupported:true,available:'',notes:'',installable:false,ready:false,phase:'idle',message:''};
  let updateChanged;
  window.morseMac = {
    buildChannel: config.mode==='mac-dev' ? 'dev' : 'stable',
    syncMode: config.mode==='mac-staging' ? 'staging' : ['mac-website','mac-dev'].includes(config.mode) ? 'website' : 'offline', onUpdate(fn){updateChanged=fn;},
    async update(action,value){
      if (action==='check') Object.assign(update,{available:'2.0.0',phase:'checked',installable:true,notes:'New timing display\n<em>Release text</em>'});
      if (action==='automatic') update.automatic=value;
      if (action==='channel') Object.assign(update,{channel:value,available:value==='dev'?'2.0.1-dev.10':'',phase:'checked',installable:value==='dev'});
      if (action==='install') window.testInstallRequested=true;
      if (action!=='state') updateChanged({...update});
      return {...update};
    },
    onPaddle(fn){ callbacks.push(fn); },
    onShackKeys(fn){ window.testShackContact=fn; },
    setShackRadio(state){ window.testShackRadio=state; },
    async requestShackKeys(){return window.testKeyPermission || {};},
    loadSave(old){ raw ??= old; return {raw,revision}; },
    save(next,at){ if(at!==revision) throw Error('Unexpected test save revision'); raw=next;return {revision:++revision}; },
    async exchange(action,{body}={}){ return exchange(action,body); },
    async paddle(op,value){
      commands.push(op);
      if(op==='mute') paddleMuted=value;
      if(op==='input') hardware.source=value;
      if(op==='arm' || op==='disarm') hardware.typing=op==='arm';
      if(op==='sound') {
        const clockChanged=hardware.outputReady && lastSound && ['wpm','farnsworth','keyer'].some(key=>lastSound[key]!==value[key]);
        lastSound=value; Object.assign(hardware,{wpm:value.wpm,spacing:value.farnsworth,pitch:value.pitch,
          volume:value.volume,rise:value.rise,fall:value.fall,curve:value.curve,sharedSound:true});
        if(clockChanged) {
          const reset={type:'reset',epoch:++hardware.epoch,session:hardware.session};
          queueMicrotask(()=>callbacks.forEach(fn=>fn(reset)));
        }
      }
      if(['input','status','sound','arm','disarm'].includes(op)) queueMicrotask(()=>callbacks.forEach(fn=>fn({...hardware})));
      if(op==='capture-position' || op==='sound') return {sequence:fixtureSequence};
      return {};
    }
  };
} else {
  const localFetch = window.fetch.bind(window);
  window.fetch = (url,opts) => {
    if (typeof url !== 'string' || !url.startsWith('/api/v2/')) return localFetch(url,opts);
    const response = exchange(url.slice('/api/v2/'.length),JSON.parse(opts.body).body);
    return Promise.resolve(new Response(JSON.stringify(response),{status:response.status || 200}));
  };
}
window.testState=()=>JSON.parse(config.mode.startsWith('mac') ? raw : localStorage.getItem('morse.progress.v1'));
window.testRequests=requests;
window.testSound=()=>lastSound;
window.testPaddleMuted=()=>paddleMuted;

window.testPaddleReady=()=>{ Object.assign(hardware,{phase:'ready',outputReady:true,canArm:true}); callbacks.forEach(fn=>fn({...hardware})); };
window.testPaddleReconnect=()=>{
  Object.assign(hardware,{epoch:hardware.epoch+1,phase:'waiting',outputReady:false});
  callbacks.forEach(fn=>fn({type:'reset',epoch:hardware.epoch,session:hardware.session}));
  callbacks.forEach(fn=>fn({...hardware}));
};

let fixtureSequence = 0;
window.testPaddleElement = (kind, milliseconds, defer = false) => {
  const row={type:'element',kind,seq:++fixtureSequence,epoch:hardware.epoch,session:hardware.session,rate:48000,frame:milliseconds*48};
  const deliver=()=>callbacks.forEach(fn=>fn(row));
  if (defer) return deliver;
  deliver();
};
