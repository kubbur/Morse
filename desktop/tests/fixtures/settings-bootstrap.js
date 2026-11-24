window.addEventListener('error', event => { window.testFailure = event.message || 'Page error'; });
window.addEventListener('unhandledrejection', event => { window.testFailure = event.reason?.message || 'Promise rejected'; });

const config = window.fixture;
// This offscreen WebView does not provide a foreground display clock.
window.requestAnimationFrame=fn=>setTimeout(()=>fn(performance.now()),10);
window.cancelAnimationFrame=clearTimeout;
// This private, single-view WebKit host does not provide a cross-tab lock manager.
if (!navigator.locks) Object.defineProperty(navigator,'locks',{value:{request:async(_name,fn)=>fn()}});
localStorage.setItem('morse.progress.v1',JSON.stringify(config.state));
let raw = null, revision = 0, serverProfile, lastSound;
const callbacks = [], commands = [], requests = [];
const hardware = { type:'status', source:'off', phase:'waiting', output:'auto', outputs:[], outputReady:false, session:1, epoch:1,
  wpm:33, spacing:20, pitch:725, volume:38, rise:3, fall:9, curve:2, hasTone:true, hasVolume:true, sharedSound:false };
function snapshot() { return { connected:true, profile:serverProfile, seq:0, revision:1, epoch:'fixture-epoch', devices:[] }; }
function exchange(action,body) {
  requests.push(action);
  if (action==='scores/leaderboard') return {entries:[]};
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
    automatic:false,available:'',notes:'',installable:false,ready:false,phase:'idle',message:''};
  let updateChanged;
  window.morseMac = {
    stagingEnabled: config.mode==='mac-staging', onUpdate(fn){updateChanged=fn;},
    async update(action,value){
      if (action==='check') Object.assign(update,{available:'2.0.0',phase:'checked',installable:true,notes:'New timing display\n<em>Release text</em>'});
      if (action==='automatic') update.automatic=value;
      if (action==='download') update.ready=true;
      if (action==='restart') window.testInstallRequested=true;
      if (action!=='state') updateChanged({...update});
      return {...update};
    },
    onPaddle(fn){ callbacks.push(fn); },
    loadSave(old){ raw ??= old; return {raw,revision}; },
    save(next,at){ if(at!==revision) throw Error('Unexpected test save revision'); raw=next;return {revision:++revision}; },
    async exchange(action,{body}){ return exchange(action,body); },
    async paddle(op,value){
      commands.push(op);
      if(op==='input') hardware.source=value;
      if(op==='arm' || op==='disarm') hardware.typing=op==='arm';
      if(op==='sound') {
        lastSound=value; Object.assign(hardware,{wpm:value.wpm,spacing:value.farnsworth,pitch:value.pitch,
          volume:value.volume,rise:value.rise,fall:value.fall,curve:value.curve,sharedSound:true});
      }
      if(['input','status','sound','arm','disarm'].includes(op)) queueMicrotask(()=>callbacks.forEach(fn=>fn({...hardware})));
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

window.testPaddleReady=()=>{ Object.assign(hardware,{phase:'ready',outputReady:true,canArm:true}); callbacks.forEach(fn=>fn({...hardware})); };
