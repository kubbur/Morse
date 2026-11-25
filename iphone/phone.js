(() => {
  const post = body => window.webkit.messageHandlers.morse.postMessage(body);
  const listeners = new Set();
  const startListeners = new Map();
  let wired = false;
  const learner = body => {
    const reply = window.prompt('morse-learner', JSON.stringify(body));
    return reply ? JSON.parse(reply) : {error:'The iPhone learner file is unavailable.'};
  };
  window.morsePhoneEvents = rows => {
    for (const row of rows) {
      if (row.type === 'status') wired = row.source === 'paddle' && !!row.outputReady;
      if (row.type === 'reset' && row.epoch == null) wired = false;
      if (row.type === 'prompt-start') { startListeners.get(row.id)?.(row.elapsed); continue; }
      for (const listener of listeners) listener(row);
    }
  };
  window.morseMac = Object.freeze({
    syncMode:'website',
    loadSave:old => learner({op:'load',old}),
    save:(raw,revision) => learner({op:'save',raw,revision}),
    exchange:(action,payload = {}) => post({op:'exchange',action,payload}),
    onPaddle:listener => { listeners.add(listener); return () => listeners.delete(listener); },
    paddle:(name,value = null) => post({op:'paddle',name,value}),
  });
  window.morsePhone = Object.freeze({
    post, get wired() { return wired; },
    onPromptStart:(id,callback) => { startListeners.set(id,callback); return () => startListeners.delete(id); },
  });
  try {
    if (!localStorage.getItem('morse.send-input.v1')) localStorage.setItem('morse.send-input.v1','straight');
  } catch { /* The learner store reports storage failures independently. */ }
  // The release also offers a Mac-only keyboard-emulating USB adapter.
  document.addEventListener('DOMContentLoaded', () => {
    const source = document.querySelector('#send-source');
    if (!source) return;
    const option = source.querySelector('option[value="vband"]');
    if (source.value === 'vband') { source.value = 'straight'; source.dispatchEvent(new Event('change')); }
    option?.remove();
  });
})();
