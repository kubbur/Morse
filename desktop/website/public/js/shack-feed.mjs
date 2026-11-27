// Keep one response open per tuned station. Electron can read it one update at a time
// across its existing IPC bridge without opening another network request.
export class ShackFeed {
  constructor(fetcher=(...args)=>globalThis.fetch(...args),origin='') {
    this.fetcher=fetcher;
    this.origin=origin;
    this.sessions=new Map();
  }
  async next(body) {
    let feed=this.sessions.get(body.token);
    if (!feed) {
      const controller=new AbortController();
      feed={controller,packets:this.read(body,controller.signal)};
      this.sessions.set(body.token,feed);
    }
    const timeout=setTimeout(()=>feed.controller.abort(),12000);
    try {
      const packet=await feed.packets.next();
      if (packet.done) throw Error('The live receiver disconnected.');
      return packet.value;
    } catch (error) {
      if (this.sessions.get(body.token)===feed) this.close(body.token);
      throw error;
    } finally { clearTimeout(timeout); }
  }
  async *read(body,signal) {
    const headers={'Content-Type':'application/json','X-Morse-Sync':'2'};
    if (this.origin) headers.Origin=this.origin;
    const response=await this.fetcher(this.origin+'/api/v2/shack/feed',{method:'POST',headers,
      credentials:'omit',redirect:'error',cache:'no-store',signal,body:JSON.stringify({scope:'band',body})});
    if (!response.ok || !response.body || !response.headers.get('content-type')?.startsWith('application/x-ndjson'))
      throw Error('The live receiver is unavailable.');
    const reader=response.body.getReader(), decoder=new TextDecoder();
    let pending='';
    try {
      while (true) {
        const {done,value}=await reader.read();
        if (done) return;
        pending+=decoder.decode(value,{stream:true});
        let split;
        while ((split=pending.indexOf('\n'))!==-1) {
          const line=pending.slice(0,split);
          pending=pending.slice(split+1);
          yield JSON.parse(line);
        }
        if (pending.length>524288) throw Error('Invalid receiver update.');
      }
    } finally { reader.releaseLock(); }
  }
  close(token) {
    const feed=this.sessions.get(token);
    if (!feed) return;
    this.sessions.delete(token);
    feed.controller.abort();
    void feed.packets.return().catch(()=>{});
  }
}
