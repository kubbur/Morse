import { randomBytes } from 'node:crypto';
import { PrivateStore } from './private-store.mjs';
import { ScoreStore, digest } from './score-store.mjs';
import { SyncError, credential } from './sync-store.mjs';
import { parseProgressJson } from '../public/js/import-validation.mjs';

import { ShackBand } from './shack-band.mjs';

export const actions = new Set([
  ...['open','poll','feed','probe','edges','send','sign','leave'].map(a=>'shack/'+a),
  ...['status','start','join','approve','cancel','push','disconnect','recovery-code','recover','adopt'].map(a=>'private/'+a),
  ...['session','listing','visibility','total','station','consent','prepare','submit','leaderboard','history','history-preview'].map(a=>'scores/'+a),
]);
export function cookieNames(scope) {
  if (typeof scope !== 'string' || !/^[\w-]{1,80}$/.test(scope)) throw new SyncError(400,'Invalid learner.');
  const id=digest(scope).slice(0,32);
  return { private: 'morse_private_'+id, scores: 'morse_scores_'+id };
}
export class Exchange {
  constructor(path, options) {
    this.private = new PrivateStore(path,options); this.scores = new ScoreStore(this.private);
    this.band = new ShackBand();
    this.inflight=0; this.minute=-1; this.counts=new Map();
  }
  async handle(req,res) {
    const send=(status,data)=>{ res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'}); res.end(JSON.stringify(data)); };
    if (++this.inflight>8) { this.inflight--; return send(503,{ error:'Try again shortly.' }); }
    try {
      const route = req.url.slice('/api/v2/'.length);
      const [kind,action] = route.split('/');
      if (!actions.has(route)) throw new SyncError(404,'Unknown operation.');
      if (req.method!=='POST' || req.headers['x-morse-sync']!=='2' || req.headers['sec-fetch-site']==='cross-site') throw new SyncError(403,'Forbidden.');
      if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '')) throw new SyncError(415,'JSON required.');
      const limit=kind==='private' ? 3100000 : 16000;
      const length=Number(req.headers['content-length']);
      if (!Number.isSafeInteger(length) || length<2 || length>limit || req.headers['transfer-encoding']) throw new SyncError(413,'Invalid request size.');
      const chunks=[]; let size=0;
      for await(const chunk of req) { size+=chunk.length; if (size>limit) throw new SyncError(413,'Request too large.'); chunks.push(chunk); }
      const { scope, body }=parseProgressJson(Buffer.concat(chunks).toString('utf8'),{ maxBytes:limit,maxNodes:1500000 });
      if (kind === 'shack') {
        if (action === 'feed') {
          const feed=this.band.subscribe(body, packet=>{
            if (res.writableLength>262144) { res.destroy(); return; }
            res.write(JSON.stringify(packet)+'\n');
          },()=>{if (!res.destroyed && !res.writableEnded) res.end();});
          res.writeHead(200,{'Content-Type':'application/x-ndjson','Cache-Control':'no-store, no-transform','X-Accel-Buffering':'no'});
          const heartbeat=setInterval(feed.pulse,4000);
          heartbeat.unref();
          res.once('close',()=>{clearInterval(heartbeat); feed.disconnected();});
          feed.pulse();
          return;
        }
        if (action === 'open') {
          const minute = Math.floor(Date.now()/60000);
          if (minute !== this.openMinute) { this.openMinute = minute; this.opens = 0; }
          if (++this.opens > 300) throw new SyncError(429,'The band is busy. Try again shortly.');
        }
        return send(200,this.band.request(action,body));
      }
      const names=cookieNames(scope);
      const parts=(req.headers.cookie||'').split(';').map(p=>p.trim());
      const cookie=name=>{ const rows=parts.filter(p=>p.startsWith(name+'=')); return rows.length===1 && /^[\w-]{43}$/.test(rows[0].slice(name.length+1)) ? rows[0].slice(name.length+1) : null; };
      const token=cookie(names[kind]), owner=cookie(names.private);
      const legacy=credential(req,{mode:req.headers['x-forwarded-proto']==='https'?'production':'local'});
      const minute=Math.floor(Date.now()/60000);
      if (minute!==this.minute) { this.minute=minute; this.counts.clear(); }
      // Bound anonymous pairing attempts as well as requests with valid credentials.
      const budget=['recover','join','start','session','recovery-code'].includes(action) ? 'pairing' : 'all';
      const count=(this.counts.get(budget)||0)+1;
      this.counts.set(budget,count);
      if (count>(budget==='pairing'?180:2400)) throw new SyncError(429,'Please retry in a minute.');
      const result=route==='scores/session' ? { ready:true,...(!token ? {setToken:randomBytes(32).toString('base64url')} : {}) }
        : route==='private/adopt' ? this.private.adopt(token,legacy)
        : kind==='scores' ? this.scores.request(action,token,owner || legacy,body) : this.private.request(action,token,body);
      // Stable compares its entire saved profile with this acknowledgement.
      // Return the fields it understands while keeping the full save in the database.
      if (kind === 'private' && result.profile && body.profileVersion !== 2) {
        delete result.profile.shack;
        delete result.profile.settings.sendWpm;
        result.profile.sending.settings.wpm = result.profile.settings.wpm;
      }
      if (Object.hasOwn(result,'setToken')) {
        const value=result.setToken;
        res.setHeader('Set-Cookie',names[kind]+'='+value+'; Path=/api/v2/; HttpOnly; SameSite=Strict; Max-Age='+(value?31536000:0)+(req.headers['x-forwarded-proto']==='https'?'; Secure':''));
        delete result.setToken;
      }
      send(200,result);
    } catch(error) {
      send(error instanceof SyncError ? error.status : 400,{ error:error instanceof SyncError ? error.message : 'Request could not be processed.' });
    } finally { this.inflight--; }
  }
  close() {
    for (const feed of this.band.feeds.values()) feed.close();
    this.private.close();
  }
}
