// Node 24 with --experimental-eventsource. The transport is the real loopback server.
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {createInterface} from "node:readline";
import {readFile} from "node:fs/promises";
import {setTimeout as wait} from "node:timers/promises";

class Element extends EventTarget {
  children = [];
  setAttribute() {}
  append(...items) { this.children.push(...items); }
  attachShadow() { this.shadowRoot = new Element(); return this.shadowRoot; }
  querySelector(tag) { return this.children.find(x => x.tag === tag); }
}
globalThis.HTMLElement = Element;
globalThis.document = Object.assign(new EventTarget(), {
  hidden: false, createElement(tag) { return Object.assign(new Element(),{tag}); }, createTextNode(s) { return s; }
});
globalThis.window = new EventTarget();
const elements = new Map();
globalThis.customElements = {get: name => elements.get(name), define: (name, value) => elements.set(name,value)};
const moduleURL = new URL("../web/morse-paddle.js",import.meta.url);
const {setSidetoneMuted}=await import(moduleURL);

const bin=process.argv[2], resources=process.argv[3];
const child=spawn(bin,["--test-server",resources],{stdio:["pipe","pipe","inherit"]});
const output=createInterface({input:child.stdout});
const lines=output[Symbol.asyncIterator]();
function withTimeout(promise,label) {
  let timer;
  const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error("Timeout: "+label)),7000);});
  return Promise.race([promise,timeout]).finally(()=>clearTimeout(timer));
}
async function readLine(prefix) {
  for (;;) {
    const {value,done}=await lines.next();
    if (done) throw new Error("Native test server closed before "+prefix);
    if (value.startsWith(prefix)) return value.slice(prefix.length);
  }
}
const app=new (elements.get("morse-paddle-input"))();
const button=app.shadowRoot.querySelector("button");
const states=[];
app.addEventListener("paddlechange",e=>states.push(e.detail));
async function observe(trigger, status, mask) {
  const expected = new Promise(resolve=>{
    function watch({detail}) {
      if (detail.status===status && (Number(detail.dit)|Number(detail.dah)<<1)===mask) {
        app.removeEventListener("paddlechange",watch); resolve(detail);
      }
    }
    app.addEventListener("paddlechange",watch);
  });
  trigger();
  return withTimeout(expected,status+" "+mask);
}
const command=value=>child.stdin.write(value+"\n");
async function audioLevel() {
  command("level");
  return withTimeout(readLine("SIDETONE "),"read native sidetone state");
}
try {
  const base=new URL(await withTimeout(readLine("LISTENING "),"listen")).origin;
  const trainer="https://trainer.example", appOrigin="http://127.0.0.1:17373";
  assert.notEqual(base,appOrigin);
  const realFetch=globalThis.fetch;
  // Route every request to the test instance, including the helper's production URL.
  globalThis.fetch=(input,options={})=>{
    const url=new URL(input);
    if (url.origin===appOrigin) {
      assert.match(url.pathname,/^\/sidetone\/(un)?mute$/);
      return realFetch(base+url.pathname,{...options,headers:{Origin:trainer}});
    }
    assert.equal(url.origin,base);
    return realFetch(input,options);
  };
  const read=path=>fetch(base+path);
  const NativeEventSource=globalThis.EventSource;
  globalThis.EventSource=class extends NativeEventSource {
    constructor(url) {
      assert.equal(url,"http://127.0.0.1:17373/events");
      super(base+"/events");
    }
  };
  assert.match(await (await read("/")).text(),/<morse-paddle-input>/);
  assert.equal(await (await read("/morse-paddle.js")).text(),await readFile(moduleURL,"utf8"));
  const port=base+"/events";
  const allowed=await fetch(port,{method:"OPTIONS",headers:{Origin:"https://trainer.example"}});
  assert.equal(allowed.status,204);
  assert.equal(allowed.headers.get("access-control-allow-origin"),"https://trainer.example");
  for (const origin of ["https://another.example","null"]) {
    const denied=await fetch(port,{headers:{Origin:origin}});
    assert.equal(denied.status,403); assert.equal(denied.headers.get("access-control-allow-origin"),null);
  }
  const put=(name,origin,options={})=>fetch(base+"/sidetone/"+name,
    {method:"PUT",headers:origin ? {Origin:origin} : {},...options});
  const preflight=await put("mute",trainer,{method:"OPTIONS",headers:{
    Origin:trainer,"Access-Control-Request-Method":"PUT","Access-Control-Request-Private-Network":"true"
  }});
  assert.equal(preflight.status,204); assert.equal(preflight.headers.get("access-control-allow-origin"),trainer);
  assert.match(preflight.headers.get("access-control-allow-methods"),/\bPUT\b/);
  assert.equal(preflight.headers.get("access-control-allow-private-network"),"true");
  assert.equal(await audioLevel(),"0 64");
  await assert.rejects(setSidetoneMuted("false"),TypeError);
  await setSidetoneMuted(true); await setSidetoneMuted(true);
  for (const origin of [null,"null","https://another.example"]) {
    const denied=await put("unmute",origin);
    assert.equal(denied.status,403); assert.equal(denied.headers.get("access-control-allow-origin"),null);
  }
  assert.equal((await put("unmute",trainer,{method:"GET"})).status,405);
  assert.equal((await put("unmute",trainer,{method:"POST"})).status,405);
  assert.equal((await put("unmute",trainer,{body:"false"})).status,400);
  assert.equal(await audioLevel(),"1 64");
  await observe(()=>button.dispatchEvent(new Event("click")),"waiting",0);
  await observe(()=>command("calibrate"),"ready",0);
  const sequence=[];
  for (const mask of [1,3,2,0,1]) sequence.push(await observe(()=>command(mask),"ready",mask));
  for (let i=1;i<sequence.length;i++) {
    assert.ok(sequence[i].timeMs>=sequence[i-1].timeMs); assert.ok(sequence[i].seq>sequence[i-1].seq);
  }
  assert.equal(await audioLevel(),"1 64","All contact edges must arrive with the sidetone muted");
  await Promise.all([setSidetoneMuted(false),setSidetoneMuted(true),setSidetoneMuted(false)]);
  assert.equal(await audioLevel(),"0 64");
  assert.equal((await put("mute",base)).status,204);
  command("local-unmute"); assert.equal(await audioLevel(),"0 64");
  await setSidetoneMuted(true);
  command("revoke"); assert.equal(await audioLevel(),"0 64");
  await assert.rejects(setSidetoneMuted(true),/HTTP 403/);
  command("relink"); assert.equal(await audioLevel(),"0 64");
  // Closing the muting origin's last stream restores sound, even with the local test page connected.
  const controller=new AbortController();
  const trainerStream=await fetch(port,{headers:{Origin:trainer},signal:controller.signal});
  assert.equal(trainerStream.status,200);
  const streamReader=trainerStream.body.getReader();
  await withTimeout(streamReader.read(),"trainer stream data");
  await setSidetoneMuted(true); assert.equal(await audioLevel(),"1 64");
  controller.abort();
  await withTimeout((async()=>{
    while (await audioLevel()==="1 64") await wait(100);
  })(),"restore on trainer disconnect");
  assert.equal(await audioLevel(),"0 64");
  await observe(()=>{document.hidden=true;document.dispatchEvent(new Event("visibilitychange"));},"paused",0);
  await wait(250);
  const reconnected=await observe(()=>{document.hidden=false;document.dispatchEvent(new Event("visibilitychange"));},"ready",1);
  assert.equal(reconnected.seq,sequence.at(-1).seq);
  assert.ok(reconnected.timeMs-sequence.at(-1).timeMs>=200,"An idle reconnect needs a fresh clock anchor.");
  await wait(200);
  const setting=await observe(()=>command("speed 24 10"),"ready",1);
  assert.equal(setting.wpm,24); assert.equal(setting.effectiveWpm,10);
  assert.equal(setting.seq,reconnected.seq+1);
  assert.ok(setting.timeMs-reconnected.timeMs>=150,"A speed change must carry the current time.");
  // A second subscriber receives its own fresh snapshot. It cannot duplicate an edge for the first.
  const count=states.length, probe=new NativeEventSource(base+"/events");
  const newSnapshot=await withTimeout(once(probe,"paddle"),"second subscriber");
  probe.close();
  const current=JSON.parse(newSnapshot[0].data);
  assert.equal(current.seq,setting.seq); assert.equal(current.dit,true); assert.equal(current.dah,false);
  assert.ok(current.timeMs>=setting.timeMs); assert.equal(states.length,count);
  command("swap");
  await observe(()=>command(3),"ready",3); await observe(()=>command(2),"ready",2);
  await observe(()=>command(0),"ready",0);
  await observe(()=>command(1),"ready",2); await observe(()=>command(3),"ready",3);
  await observe(()=>command(2),"ready",1); await observe(()=>command(0),"ready",0);
  await observe(()=>command("speed 30 30"),"ready",0);
  const late=await observe(()=>command("queued"),"ready",3);
  assert.ok(late.timeMs>=setting.timeMs,"An earlier-captured edge cannot send the subscriber clock backwards.");
  await observe(()=>command("offline"),"disconnected",0);
  await observe(()=>command(2),"ready",1);
  await observe(()=>child.stdin.end(),"reconnecting",0);
  button.dispatchEvent(new Event("click"));
  assert.equal(app.receiver.state.status,"disconnected"); assert.equal(app.receiver.state.dah,false);
  let legacy;
  globalThis.EventSource=class extends EventTarget {
    constructor() { super(); legacy=this; }
    close() {}
  };
  app.receiver.connect();
  legacy.dispatchEvent(new MessageEvent("paddle",{data:JSON.stringify({
    v:1,seq:1,status:"ready",dit:true,dah:false,timeMs:1000
  })}));
  assert.equal(app.receiver.state.dit,true); assert.equal(app.receiver.state.wpm,30); assert.equal(app.receiver.state.effectiveWpm,30);
  app.receiver.disconnect(); globalThis.EventSource=NativeEventSource;
  console.log("Web checks passed: native mute/unmute, contact delivery while muted, origin checks, disconnect recovery, raw/reversed contacts, live timing, reconnects and legacy clients.");
} finally {
  app.disconnectedCallback(); output.close();
  if (child.exitCode===null && child.signalCode===null) {
    const ended=once(child,"exit"); child.kill("SIGTERM"); await ended;
  }
}
