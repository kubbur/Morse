const { contextBridge, ipcRenderer } = require('electron');
if (process.isMainFrame) {
  const subscribe = (channel, handler) => {
    const listener = (_event, row) => handler(row);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
  contextBridge.exposeInMainWorld('morseMac', {
    buildChannel: process.argv.includes('--morse-build=dev') ? 'dev' : 'stable',
    syncMode: process.argv.includes('--morse-sync=staging') ? 'staging' : process.argv.includes('--morse-sync=website') ? 'website' : 'offline',
    paddle: (op, value) => ipcRenderer.invoke('paddle-command', op, value),
    onPaddle: handler => subscribe('paddle-event', handler),
    ...(process.platform==='darwin' ? {
      setShackRadio: state=>ipcRenderer.send('shack-radio',state),
      requestShackKeys: ()=>ipcRenderer.invoke('shack-key-access'),
      onShackKeys: handler=>subscribe('shack-contacts',handler),
    } : {}),
    onUpdate: handler => subscribe('update-state', handler),
    update: (action, value) => ipcRenderer.invoke('mac-update', action, value),
    loadSave: legacy => ipcRenderer.sendSync('learner-load', legacy),
    save: (raw, revision) => ipcRenderer.sendSync('learner-save', raw, revision),
    eraseLearner: (id, raw, revision) => ipcRenderer.sendSync('learner-erase', id, raw, revision),
    exchange: (action, body) => ipcRenderer.invoke('learner-exchange', action, body),
  });
}
