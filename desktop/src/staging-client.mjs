import { actions, cookieNames } from '../website/lib/exchange.mjs';

// Destination and routes are fixed. The renderer cannot supply a URL, header,
// device credential or redirect target.
export function stagingClient(db, safeStorage, enabled, fetcher = fetch) {
  const origin='http://127.0.0.1:38764';
  return async (action, { scope, body } = {}) => {
    if (!enabled) return { status:503, error:'Saved on this Mac. The staging service is disconnected.' };
    if (!actions.has(action)) return { status:400,error:'Invalid operation.' };
    const names=cookieNames(scope), kind=action.split('/')[0];
    if (!await safeStorage.isAsyncEncryptionAvailable()) return { status:503,error:'Private credential storage is unavailable.' };
    const cookies=[];
    for (const name of Object.values(names)) {
      const row=db.prepare('SELECT encrypted FROM credentials WHERE id=?').get(name);
      if (row) { const {result}=await safeStorage.decryptStringAsync(Buffer.from(row.encrypted)); cookies.push(name+'='+result); }
    }
    const response=await fetcher(origin+'/api/v2/'+action,{ method:'POST',redirect:'error',signal:AbortSignal.timeout(8000),
      headers:{'Content-Type':'application/json','X-Morse-Sync':'2',Origin:origin,Cookie:cookies.join('; ')}, body:JSON.stringify({scope,body}) });
    if (response.ok) {
      const set=response.headers.get('set-cookie');
      if (set) {
        const [key, value]=set.split(';',1)[0].split('=');
        if (key!==names[kind] || (value && !/^[\w-]{43}$/.test(value))) throw new Error('Invalid device credential.');
        if (value) db.prepare('INSERT OR REPLACE INTO credentials VALUES(?,?)').run(key,await safeStorage.encryptStringAsync(value));
        else db.prepare('DELETE FROM credentials WHERE id=?').run(key);
      }
    }
    return { status:response.status, ...await response.json() };
  };
}
