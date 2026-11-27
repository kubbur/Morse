import { equipment } from '../website/public/js/shack-model.mjs';
import { validAchievements } from '../website/public/js/operator-achievements.mjs';
import { ShackFeed } from '../website/public/js/shack-feed.mjs';
import { devOrigin, serviceOrigin } from '../website/public/js/service-origin.mjs';
import { actions, cookieNames } from '../website/lib/exchange.mjs';

export { stableOrigin as siteOrigin, stagingOrigin as testOrigin } from '../website/public/js/service-origin.mjs';

function publicRankings(data) {
  const validCount = n => Number.isSafeInteger(n) && n >= 0;
  if (!Array.isArray(data?.entries) || data.entries.length > 50) throw Error('Invalid leaderboard response.');
  const entries = data.entries.map(({rank,callsign,xp,streak,lifetimeXP,equipped,achievements})=>{
    if (!validCount(rank) || rank < 1 || typeof callsign !== 'string' || !/^[A-Z0-9/]{2,16}$/.test(callsign) ||
        !validCount(xp) || !validCount(streak)) throw Error('Invalid leaderboard entry.');
    const profile=Array.isArray(equipped) && equipped.length===3 && equipped.every((id,i)=>id===null || equipment(id)?.slot===i) && validCount(lifetimeXP) && lifetimeXP>=xp;
    return {rank,callsign,xp,streak,...(profile ? {lifetimeXP,equipped} : {}),...(validAchievements(achievements) ? {achievements} : {})};
  });
  return {status:200,entries,me:null};
}

export const websiteCredentialPrefix = (mode,channel) => mode === 'staging' ? '' : serviceOrigin(mode,channel) === devOrigin ? 'dev-website:' : 'website:';
export function websiteClient(db, safeStorage, mode, fetcher = fetch, channel = 'stable') {
  if (!['staging','offline','website'].includes(mode)) throw Error('Unknown Morse website mode.');
  const origin = serviceOrigin(mode, channel);
  // Preserve historical Stable and loopback IDs. Each host has its own device credentials.
  const credentialPrefix = websiteCredentialPrefix(mode,channel);
  const bandFeed=new ShackFeed(fetcher,origin);
  let cached, pending;
  async function capabilities() {
    if (mode === 'offline') return { privateSync:false, scores:false, leaderboard:false };
    if (mode === 'staging') return { privateSync:true, scores:true, leaderboard:true };
    if (cached && cached.until > Date.now()) return cached.value;
    if (pending) return pending;
    pending = (async () => {
      const response = await fetcher(origin+'/api/v2/capabilities', {
        redirect:'error', credentials:'omit', cache:'no-store', signal:AbortSignal.timeout(5000)
      });
      let v2 = false;
      if (response.ok) {
        const info = await response.json();
        v2 = info.application === 'morse' && info.protocol === 2 && info.privateSync === true && info.scores === true;
      } else if (response.status !== 404) throw Error('The website could not be reached.');
      const value = {privateSync:v2, scores:v2, leaderboard:true};
      cached = { value, until:Date.now()+60000 };
      return value;
    })();
    try { return await pending; } finally { pending=null; }
  }

  const request = async (action, {scope, body} = {}) => {
    if (action !== 'capabilities' && !actions.has(action)) return {status:400,error:'Unknown operation.'};
    if (action.startsWith('shack/')) {
      if (mode === 'offline') return {status:503,error:'The live band is offline.'};
      if (action==='shack/leave') bandFeed.close(body.token);
      if (action==='shack/poll' && body.live) return bandFeed.next(body);
      const response = await fetcher(origin+'/api/v2/'+action,{method:'POST',redirect:'error',credentials:'omit',cache:'no-store',
        signal:AbortSignal.timeout(8000),headers:{'Content-Type':'application/json','X-Morse-Sync':'2',Origin:origin},
        body:JSON.stringify({scope:'band',body})});
      const data = await response.json().catch(()=>({error:'The live band is unavailable.'}));
      return {...data,status:response.status};
    }
    let capabilitiesNow;
    try { capabilitiesNow = await capabilities(); }
    catch { return {status:503,error:'Could not reach the Morse website. Progress is saved on this Mac.'}; }
    if (action === 'capabilities') return {status:200,...capabilitiesNow};
    if (!capabilitiesNow.scores) {
      if (action !== 'scores/leaderboard' || !capabilitiesNow.leaderboard)
        return {status:503,error:'Saved on this Mac.',localOnly:true};
      // The running v1 service exposes anonymous rankings. Never send a learner, a
      // cookie, consent or a score to its identity/whole-profile routes.
      const response = await fetcher(origin+'/api/sync/leaderboard',{method:'POST',redirect:'error',credentials:'omit',
        cache:'no-store',signal:AbortSignal.timeout(8000),headers:{'Content-Type':'application/json','X-Morse-Sync':'1',Origin:origin},body:'{}'});
      if (!response.ok) return {status:response.status,error:'The website leaderboard is unavailable.'};
      return publicRankings(await response.json());
    }
    if (action === 'scores/leaderboard') {
      const response = await fetcher(origin+'/api/v2/scores/leaderboard', {method:'POST',redirect:'error',credentials:'omit',
        cache:'no-store',signal:AbortSignal.timeout(8000),headers:{'Content-Type':'application/json','X-Morse-Sync':'2',Origin:origin},
        body:JSON.stringify({scope:'public',body:{}})});
      if (!response.ok) return {status:response.status,error:'The website leaderboard is unavailable.'};
      return publicRankings(await response.json());
    }
    const names=cookieNames(scope), kind=action.split('/')[0];
    const keyFor = name => credentialPrefix + name;
    if (!await safeStorage.isAsyncEncryptionAvailable()) return { status:503,error:'Private credential storage is unavailable.' };
    const cookies=[];
    const needsBoth = ['scores/consent','scores/listing','scores/visibility','scores/total','scores/station','scores/achievements',
      'private/erase','private/start','private/approve','private/recover','private/status'].includes(action);
    const required = needsBoth ? [names.scores,names.private] : [names[kind]];
    for (const name of required) {
      const row=db.prepare('SELECT encrypted FROM credentials WHERE id=?').get(keyFor(name));
      if (row) { const {result}=await safeStorage.decryptStringAsync(Buffer.from(row.encrypted)); cookies.push(name+'='+result); }
    }
    const response=await fetcher(origin+'/api/v2/'+action,{method:'POST',redirect:'error',credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(8000),
      headers:{'Content-Type':'application/json','X-Morse-Sync':'2',Origin:origin,Cookie:cookies.join('; ')},body:JSON.stringify({scope,body})});
    if (response.ok) {
      const set=response.headers.get('set-cookie');
      if (set) {
        const [key,value]=set.split(';',1)[0].split('=');
        if (key!==names[kind] || (value && !/^[\w-]{43}$/.test(value))) throw Error('Invalid device credential.');
        if (value) db.prepare('INSERT OR REPLACE INTO credentials VALUES(?,?)').run(keyFor(key),await safeStorage.encryptStringAsync(value));
        else db.prepare('DELETE FROM credentials WHERE id=?').run(keyFor(key));
      }
    }
    if (!response.headers.get('content-type')?.includes('application/json'))
      return {status:503,error:'The website is unavailable. Progress is saved on this Mac.'};
    return {...await response.json(),status:response.status};
  };
  // The main process can outlive a reloaded, closed or crashed practice window.
  request.closeBand = () => {
    for (const token of bandFeed.sessions.keys()) bandFeed.close(token);
  };
  return request;
}
