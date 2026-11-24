import { STORAGE_KEY } from './progress.mjs';
import { DeviceSync } from './device-sync.mjs';
import { syncProfile } from './sync-data.mjs';
import { MOVED_KEY, BACKUP_KEY,
  validMessage, readProgress, fingerprint, summary, receipts, recoverJournal, commitMove, applyShared } from './origin-move.mjs';

const OLD_ORIGIN = decodeURIComponent(document.documentElement.dataset.moveFrom || '');
const NEW_ORIGIN = decodeURIComponent(document.documentElement.dataset.moveTo || '');
const $ = id => document.getElementById(id);
const noncePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
let storage, exportRaw = null;
function say(message, error = false) { $('status').textContent = message; $('status').dataset.error = String(error); }
function download(raw) {
  const url = URL.createObjectURL(new Blob([raw], { type: 'application/json' }));
  const link = document.createElement('a');link.href = url;link.download = `morse-progress-${new Date().toISOString().slice(0, 10)}.json`;link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('download').onclick = () => { if (exportRaw) download(exportRaw); };
function showExport(raw) { exportRaw = raw; $('download').hidden = !raw; }
async function api(action, body = {}) {
  const r = await fetch(`/api/sync/${action}`, { method: 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: { 'Content-Type': 'application/json', 'X-Morse-Sync': '1' }, body: JSON.stringify(body), signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error((await r.text()).slice(0, 250) || 'Could not complete device pairing. Your original progress is retained.');
  return r.json();
}
async function syncStatus() {
  const result = await api('status');
  if (typeof result.connected !== 'boolean') throw new Error('Could not verify device pairing. Please retry.');
  if (result.connected) readProgress(JSON.stringify(stateFromSync(result)));
  return result;
}
function stateFromSync(result) {
  const p = { ...result.profile, id: 'moved-listener', name: 'Listener' };
  return { version: 1, activeId: p.id, profiles: [p], theme: 'dark' };
}
function targetURL() {
  // The trainer's views and pairing links live in the fragment. Fixed origin
  // and path prevent a crafted legacy URL from becoming an open redirect.
  return NEW_ORIGIN + '/' + location.hash;
}
function send(peer, origin, nonce, type, rest = {}) { peer.postMessage({ version: 1, nonce, type, ...rest }, origin); }

async function source() {
  let raw = storage.getItem(STORAGE_KEY);
  showExport(raw);
  $('recover').hidden = false;
  let sync = null;
  if (!raw) {
    // Backups are data too: never bypass them just because the primary key is absent.
    for (const key of [`${STORAGE_KEY}.backup`, `${STORAGE_KEY}.pairing-backup`, `${STORAGE_KEY}.before-audio-course`, `${STORAGE_KEY}.recovery`]) {
      const candidate = storage.getItem(key);
      if (candidate) { readProgress(candidate); raw = candidate; say('A recovery save was found. Move it before continuing.'); break; }
    }
    if (!raw) {
      sync = await syncStatus();
      if (sync.connected) raw = JSON.stringify(stateFromSync(sync));
      else { location.replace(targetURL()); return; }
    }
  }
  let state = readProgress(raw);
  const selected = document.cookie.split(';').map(v => v.trim()).find(v => v.startsWith('morse_learner='))?.slice(14);
  if (selected && state.profiles.some(p => p.id === selected)) state.activeId = selected;
  let payload = JSON.stringify(state), digest = await fingerprint(payload);
  showExport(payload);
  const moved = storage.getItem(MOVED_KEY);
  if (!new URL(location.href).searchParams.has('move') && moved) {
    try {
      const receipt = JSON.parse(moved);
      if (receipt.version === 1 && receipt.fingerprint === digest && ['copied', 'kept-current'].includes(receipt.decision)) {
        location.replace(targetURL());return;
      }
    } catch { /* A damaged marker never discards a save. */ }
  }
  say(summary(state));
  $('move').hidden = false;
  $('pairing-note').hidden = false;
  let peer = null, nonce = null, timeout = null, preparing = false, offering = false, offerNonce = null;
  const sourceSync = new DeviceSync({ storage, getProfile: () => state.profiles.find(p => p.id === state.activeId),
    ready: () => true, backup: () => {
      if (!storage.getItem(BACKUP_KEY)) storage.setItem(BACKUP_KEY, JSON.stringify(state));
    }, applyProfile: shared => {
      state = applyShared(state, shared);raw = JSON.stringify(state);storage.setItem(STORAGE_KEY, raw);
      if (storage.getItem(STORAGE_KEY) !== raw) throw new Error('Could not verify the updated original save.');
    }, onStatus: () => {} });
  window.addEventListener('message', async event => {
    if (validMessage(event, peer, NEW_ORIGIN, nonce, 'ready')) {
      if (preparing) return;preparing = true;clearTimeout(timeout);
      try {
        // Finish already-queued work using the existing three-way sync journal.
        if (sourceSync.meta()) await sourceSync.flush();
        sync = await syncStatus();
        payload = JSON.stringify(state);digest = await fingerprint(payload);showExport(payload);
        send(peer, NEW_ORIGIN, nonce, 'progress', { raw: payload, fingerprint: digest, destination: targetURL(),
          owner: sync.connected ? sync.devices.find(d => d.current)?.id : null });
        say('Choose your save in the new tab. This tab will continue after the save is verified.');
      } catch (error) { say(error.message, true);send(peer, NEW_ORIGIN, nonce, 'error', { message: error.message }); }
      finally { preparing = false; }
    } else if (validMessage(event, peer, NEW_ORIGIN, nonce, 'pair-request')) {
      if (offering || offerNonce || event.data.fingerprint !== digest) return;offering = true;
      try {
        const current = await syncStatus();
        if (!current.connected) throw new Error('The old save is no longer paired. Retry the move.');
        if (current.invite || current.waiting) throw new Error('Finish or cancel the existing device pairing in the original saved progress, then retry the move.');
        const offer = await sourceSync.start('Browser address move');offerNonce = nonce;
        send(peer, NEW_ORIGIN, nonce, 'offer', { invitation: offer.invitation });
      } catch (error) { send(peer, NEW_ORIGIN, nonce, 'error', { message: error.message }); }
      finally { offering = false; }
    } else if (validMessage(event, peer, NEW_ORIGIN, nonce, 'claim')) {
      if (offering || offerNonce !== nonce) return;offering = true;
      try {
        const current = await syncStatus();
        if (!event.data.claim || current.invite?.claim !== event.data.claim) throw new Error('The new tab could not be verified for device pairing.');
        await sourceSync.approve(event.data.claim);sourceSync.dispose();
        // approve() may download newer progress, which is now safely at both
        // origins. The receipt refers to the original offered snapshot.
        raw = storage.getItem(STORAGE_KEY) || raw;
        send(peer, NEW_ORIGIN, nonce, 'linked');
      } catch (error) { send(peer, NEW_ORIGIN, nonce, 'error', { message: error.message }); }
      finally { offering = false; }
    } else if (validMessage(event, peer, NEW_ORIGIN, nonce, 'pair-cancel')) {
      if (offerNonce === nonce) {
        try { await sourceSync.cancel(); } catch { /* The existing invite also expires automatically. */ }
        sourceSync.dispose();offerNonce = null;
      }
    } else if (validMessage(event, peer, NEW_ORIGIN, nonce, 'saved')) {
      if (event.data.fingerprint !== digest || !['copied', 'kept-current'].includes(event.data.decision)) return;
      // If a still-open old trainer tab saved new work while the move was open,
      // keep this page instead of marking that newer data as moved.
      const current = storage.getItem(STORAGE_KEY);
      if (current && JSON.stringify(readProgress(current)) !== JSON.stringify(readProgress(raw))) {
        say('Another old Morse tab saved more progress. Close it and reload this page to move the latest save.', true);return;
      }
      try { storage.setItem(MOVED_KEY, JSON.stringify({ version: 1, fingerprint: await fingerprint(JSON.stringify(state)), decision: event.data.decision, at: new Date().toISOString() })); }
      catch { /* Verified destination is saved; old data is still retained. */ }
      send(peer, NEW_ORIGIN, nonce, 'finish');
      sourceSync.dispose();
      location.replace(targetURL());
    }
  });
  $('move').onclick = () => {
    if (offering || offerNonce) { say('Finish the move in the new tab before retrying.', true);return; }
    if (peer && !peer.closed) peer.close();
    nonce = crypto.randomUUID();
    peer = window.open(`${NEW_ORIGIN}/move-progress#${nonce}`, `morse-move-${nonce}`);
    if (!peer) { say('Allow this site to open the move tab, then press Move progress again. Your original save is untouched.', true);return; }
    say('Opening the new address…');
    clearTimeout(timeout);
    timeout = setTimeout(() => say('The new tab has not connected yet. Check that it opened and can access Morse, then retry if needed. Your original save is untouched.', true), 15000);
  };
}

async function destination() {
  $('title').textContent = 'Bring your progress with you.';
  recoverJournal(storage);
  const nonce = location.hash.slice(1), peer = window.opener;
  history.replaceState(null, '', '/move-progress');
  $('recover').href = OLD_ORIGIN + '/?move=1';$('recover').hidden = false;
  if (!peer || !noncePattern.test(nonce)) {
    say('Start the move from the old address in this browser. That is where your original progress is stored.');
    try {
      const previous = JSON.parse(storage.getItem(BACKUP_KEY) || 'null')?.values?.[STORAGE_KEY];
      if (previous) {
        readProgress(previous);showExport(previous);
        $('download').textContent = 'Download the previous new-address save';
        $('continue').hidden = false;
        $('help').textContent = 'This backup is the save that was at the new address before the move. Import the downloaded file from Saved progress if you want to restore it.';
      }
    } catch { /* An unreadable backup does not replace or delete any save. */ }
    $('recover').textContent = 'Start from the old address';return;
  }
  let accepting = false, receiving = false, finished = false, pending = null, latestRaw = null, sync = null;
  const waiters = new Map();
  function waitFor(type) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiters.delete(type);reject(new Error('The old tab did not finish pairing. Keep it open and retry.')); }, 30000);
      waiters.set(type, { resolve: value => { clearTimeout(timer);resolve(value); }, reject: error => { clearTimeout(timer);reject(error); } });
    });
  }
  const acknowledge = decision => {
    finished = true;$('choices').hidden = true;$('help').textContent = 'Your progress was verified at the new address. The old copy has been kept.';
    say('Saved and verified. Returning to Morse…');
    send(peer, OLD_ORIGIN, nonce, 'saved', { fingerprint: pending.fingerprint, decision });
    // A retained fallback helps if the old tab was closed after the save.
    $('continue').hidden = false;$('continue').href = pending.destination;
  };
  const apply = async decision => {
    if (accepting || !pending || finished) return;
    accepting = true;$('use-old').disabled = $('keep-new').disabled = true;
    try {
      if (!navigator.locks) throw new Error('This move needs an updated browser with secure storage support. Download a backup from the old tab and use Saved progress to import it.');
      await navigator.locks.request('morse-device-sync', async () => {
        // Re-read the server sequence under the same lock as normal sync writes.
        const fresh = await syncStatus();
        if (fresh.connected !== sync.connected || fresh.connected && (fresh.epoch !== sync.epoch || fresh.revision !== sync.revision || fresh.seq !== sync.seq))
          throw new Error('Paired progress changed while this page was open. Close other Morse tabs and retry the move.');
        let shared = fresh, incomingRaw = pending.raw, aligned = false, createdDevice = false;
        try {
          if (decision === 'copied' && pending.owner && !fresh.connected) {
            // Back up before creating the new origin's device credential.
            storage.setItem(BACKUP_KEY, JSON.stringify({ version: 1, at: new Date().toISOString(),
              values: Object.fromEntries([STORAGE_KEY, 'morse.devices.v1', 'morse.callsign-intro.v1'].map(key => [key, storage.getItem(key)])) }));
            say('Keeping your saved scores and paired devices connected…');
            const offered = waitFor('offer');send(peer, OLD_ORIGIN, nonce, 'pair-request', { fingerprint: pending.fingerprint });
            const offer = await offered;
            const state = readProgress(pending.raw), active = state.profiles.find(p => p.id === state.activeId);
            const joined = await api('join', { invitation: offer.invitation, profile: syncProfile(active), label: 'Browser at new address' });
            createdDevice = true;
            const claim = joined.devices?.find(d => d.current)?.id;
            if (!claim) throw new Error('Could not verify the new browser device.');
            const linked = waitFor('linked');send(peer, OLD_ORIGIN, nonce, 'claim', { claim });await linked;
            shared = await syncStatus();
            if (!shared.connected || !shared.devices.some(d => d.id === pending.owner) || !shared.devices.some(d => d.id === claim && d.current))
              throw new Error('The new address could not verify access to the original paired save.');
            incomingRaw = JSON.stringify(applyShared(state, shared.profile));aligned = true;
          }
          const result = commitMove(storage, { raw: incomingRaw, digest: pending.fingerprint, expectedRaw: latestRaw,
            currentRaw: pending.currentRaw, sync: shared, aligned, decision, nonce });
          document.cookie = `morse_learner=${result.state.activeId}; Path=/; Max-Age=31536000; SameSite=Strict; Secure`;
        } catch (error) {
          // Only the device created by this move is disconnected. Never erase
          // a shared save or disconnect a pre-existing new-origin cookie.
          if (createdDevice) {
            try { await api('disconnect'); } catch { throw new Error('The move stopped after linking. Your saves are retained. Open original progress before retrying.'); }
          }
          send(peer, OLD_ORIGIN, nonce, 'pair-cancel');throw error;
        }
      });
      acknowledge(decision);
    } catch (error) { say(error.message, true); }
    finally { accepting = false;$('use-old').disabled = $('keep-new').disabled = false; }
  };
  $('use-old').onclick = () => apply('copied');
  $('keep-new').onclick = () => apply('kept-current');
  window.addEventListener('message', async event => {
    if (validMessage(event, peer, OLD_ORIGIN, nonce, 'error')) {
      const error = new Error(typeof event.data.message === 'string' ? event.data.message.slice(0, 250) : 'The old tab could not complete the move.');
      for (const waiter of waiters.values()) waiter.reject(error);waiters.clear();say(error.message, true);return;
    }
    for (const type of ['offer', 'linked']) {
      if (validMessage(event, peer, OLD_ORIGIN, nonce, type)) {
        const waiter = waiters.get(type);waiters.delete(type);if (waiter) waiter.resolve(event.data);return;
      }
    }
    if (validMessage(event, peer, OLD_ORIGIN, nonce, 'finish') && finished) { window.close();return; }
    if (!validMessage(event, peer, OLD_ORIGIN, nonce, 'progress') || pending || accepting || receiving || finished) return;
    receiving = true;
    try {
      const { raw, fingerprint: digest, destination, owner } = event.data;
      const incoming = readProgress(raw);
      if (typeof digest !== 'string' || await fingerprint(raw) !== digest) throw new Error('Progress verification failed. Please restart the move.');
      const target = new URL(destination);
      if (target.origin !== NEW_ORIGIN || target.pathname !== '/' || target.search) throw new Error('Unexpected move destination.');
      recoverJournal(storage);
      latestRaw = storage.getItem(STORAGE_KEY);
      if (receipts(storage).some(r => r.fingerprint === digest) && latestRaw) {
        readProgress(latestRaw);pending = { raw, fingerprint: digest, destination };
        acknowledge(receipts(storage).find(r => r.fingerprint === digest).decision);return;
      }
      sync = await syncStatus();
      const currentRaw = latestRaw || (sync.connected ? JSON.stringify(stateFromSync(sync)) : null);
      const current = currentRaw ? readProgress(currentRaw) : null;
      pending = { raw, fingerprint: digest, destination, currentRaw, owner };
      $('old-summary').textContent = summary(incoming);
      $('pairing-note').hidden = false;
      if (current && JSON.stringify(current) !== JSON.stringify(incoming)) {
        $('new-summary').textContent = summary(current);
        $('choices').hidden = false;
        $('sync-warning').textContent = sync.connected
          ? 'The new address is paired with other devices. Choosing the old save replaces its current progress and will sync that choice to those devices. Both browser saves are backed up first.'
          : 'Choose the save you want to continue with. The current save is backed up first, and the original remains at the old address.';
        showExport(currentRaw);
        say('There is already progress at the new address. Choose which save to continue with.');
      } else await apply('copied');
    } catch (error) { say(error.message, true); }
    finally { receiving = false; }
  });
  send(peer, OLD_ORIGIN, nonce, 'ready');
}

try {
  if (!OLD_ORIGIN || !NEW_ORIGIN) throw new Error('A progress move is unavailable at this address.');
  document.querySelector('.brand').href = NEW_ORIGIN;
  $('continue').href = NEW_ORIGIN;
  $('description').querySelector('strong').textContent = new URL(NEW_ORIGIN).host;
  storage = window.localStorage;
  // Read access is needed even for the empty-browser redirect.
  storage.getItem(STORAGE_KEY);
  if (location.origin === OLD_ORIGIN) await source();
  else if (location.origin === NEW_ORIGIN) await destination();
  else throw new Error('Open the move page using the official Morse addresses.');
} catch (error) {
  say(error.message || 'Browser storage is unavailable. Your original progress has not been moved.', true);
  try { showExport(storage.getItem(STORAGE_KEY)); } catch { /* Keep the original storage untouched. */ }
  $('recover').hidden = false;
}
