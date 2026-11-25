import { actions, cookieNames } from '../website/lib/exchange.mjs';

export const siteOrigin = 'https://morse.kubbur.digital';
export const testOrigin = 'http://127.0.0.1:38764';

function publicRankings(data) {
  const validCount = n => Number.isSafeInteger(n) && n >= 0;
  if (!Array.isArray(data?.entries) || data.entries.length > 50) throw Error('Invalid leaderboard response.');
  const entries = data.entries.map(({rank,callsign,xp,streak})=>{
    if (!validCount(rank) || rank < 1 || typeof callsign !== 'string' || !/^[A-Z0-9/]{2,16}$/.test(callsign) ||
        !validCount(xp) || !validCount(streak)) throw Error('Invalid leaderboard entry.');
    return {rank,callsign,xp,streak};
  });
  return {status:200,entries,me:null};
}

export function websiteClient(db, safeStorage, mode, fetcher = fetch) {
  if (!['staging','offline','website'].includes(mode)) throw Error('Unknown Morse website mode.');
  const origin = mode === 'staging' ? testOrigin : siteOrigin;
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

  return async (action, {scope, body} = {}) => {
    if (action !== 'capabilities' && !actions.has(action)) return {status:400,error:'Unknown operation.'};
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
    // Credentials from the test server must never be sent to the website.
    const keyFor = name => mode === 'staging' ? name : 'website:'+name;
    if (!await safeStorage.isAsyncEncryptionAvailable()) return { status:503,error:'Private credential storage is unavailable.' };
    const cookies=[];
    const required = action === 'scores/consent' ? [names.scores,names.private] : [names[kind]];
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
}
