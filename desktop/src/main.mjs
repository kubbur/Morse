import { app, BrowserWindow, Menu, dialog, session, shell, ipcMain, powerMonitor, safeStorage, nativeImage } from 'electron';
import { fileURLToPath } from 'node:url';
import { join, isAbsolute, resolve } from 'node:path';
import { mkdirSync, realpathSync } from 'node:fs';
import { APP_ORIGIN, WEBSITE, appDocument, allowedRequest, allowedPermission, progressExport } from './policy.mjs';
import { mkdir, readFile } from 'node:fs/promises';
import { bundledTrainer } from './bundled-trainer.mjs';
import { PaddleService } from './paddle-service.mjs';
import { LearnerDB } from './learner-db.mjs';
import { websiteClient } from './website-client.mjs';
import { checkUpdate } from './updates.mjs';
import { channelPreference, macInstaller, UpdateManager } from './update-manager.mjs';

app.setName('Morse');
process.umask(0o077);
const icon = fileURLToPath(new URL('../assets/icon.png', import.meta.url));
let window, db, paddle, updates, updateTimer, exchange, closing = false, stopping = false;
const isolated = app.commandLine.hasSwitch('morse-isolated');
const staged = app.commandLine.hasSwitch('morse-staging');
const syncMode = staged ? 'staging' : isolated && !app.commandLine.hasSwitch('morse-website') ? 'offline' : 'website';
if (isolated || staged) {
  const path = app.commandLine.getSwitchValue('user-data-dir');
  const personal = resolve(app.getPath('appData'), 'Morse');
  if (!isAbsolute(path) || resolve(path) === personal) throw new Error('Supply a separate test profile directory.');
  mkdirSync(path,{recursive:true,mode:0o700});
  const directory = realpathSync(path);
  const inPersonal = directory === personal || directory.startsWith(personal+'/');
  if (inPersonal) throw new Error('Select a test directory outside the personal Morse profile.');
  app.setPath('userData',directory);
} else if (app.getVersion().includes('-dev.')) {
  app.setPath('userData', join(app.getPath('appData'),'Morse Development'));
}
function publish(channel, data) {
  const wc=window?.webContents;
  if (wc && !wc.isDestroyed() && appDocument(wc.getURL())) wc.send(channel,data);
}
function trusted(event) {
  return !!window && !window.isDestroyed() && event.sender===window.webContents &&
    event.senderFrame===event.sender.mainFrame && appDocument(event.senderFrame.url);
}
function registerIPC() {
  for (const [name, fn] of Object.entries({
    'learner-load': legacy=>db.load(legacy,syncMode === 'website'),
    'learner-save': (raw,rev)=>({revision:db.save(raw,rev)}),
  })) ipcMain.on(name,(event,...args)=>{
    try { if (!trusted(event)) throw Error(); event.returnValue=fn(...args); }
    catch { event.returnValue={error:'The learner save could not be opened or updated. The original was retained.'}; }
  });
  ipcMain.handle('paddle-command',(e,op,v)=>{
    if (!trusted(e) || (op==='arm' || (op==='vband' && v?.mask)) && !window.isFocused()) return {error:'Morse must be focused.'};
    return paddle?.command(op,v) || {error:'Paddle unavailable.'};
  });
  ipcMain.handle('learner-exchange',(e,action,payload)=>trusted(e) ? exchange(action,payload).catch(()=>({status:503,error:'Saved locally. Waiting to reconnect.'})) : {status:403});
  ipcMain.handle('mac-update', async (event, action, value) => {
    if (!trusted(event)) return;
    if (action === 'state') return updates.state();
    if (!window.isFocused() || stopping) return updates.state();
    if (action === 'check') void updates.check();
    if (action === 'channel' && await updates.setChannel(value) && window?.isFocused() && !stopping && updates.state().installable) {
      await updates.install(saveBeforeUpdate);
    }
    if (action === 'automatic') updates.setAutomatic(value);
    if (action === 'install') {
      if (updates.state().installable) await updates.install(saveBeforeUpdate);
      else if (updates.release) await shell.openExternal(updates.release.archive?.url || updates.release.url);
    }
    if (action === 'release' && updates.release) await shell.openExternal(updates.release.url);
    return updates.state();
  });
}
async function saveBeforeUpdate() {
  const contents = window?.webContents;
  if (!contents || contents.isDestroyed()) return true;
  if (!appDocument(contents.getURL()) || contents.isLoadingMainFrame() || contents.isCrashed()) return false;
  let timeout;
  try {
    return await Promise.race([
      contents.executeJavaScript("(() => { const event = new CustomEvent('morse-save-before-update', {detail:{saved:false}}); dispatchEvent(event); return event.detail.saved === true; })()"),
      new Promise(resolve => { timeout = setTimeout(() => resolve(false), 2000); }),
    ]);
  } finally { clearTimeout(timeout); }
}

function showWindow() {
  if (!window || window.isDestroyed()) return createWindow();
  if (window.isMinimized()) window.restore();
  window.show(); window.focus();
}

function createWindow() {
  window = new BrowserWindow({
    title: 'Morse', width: 1200, height: 900, minWidth: 440, minHeight: 620,
    backgroundColor: '#0d1713', show: false, icon,
    webPreferences: {
      preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)), partition: 'persist:morse', sandbox: true, contextIsolation: true,
      nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false,
      devTools: !app.isPackaged, additionalArguments: ['--morse-sync='+syncMode],
    },
  });
  const contents = window.webContents;
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  for (const name of ['will-navigate', 'will-redirect']) contents.on(name, (event, url) => { if (!appDocument(url)) event.preventDefault(); });
  contents.on('will-attach-webview', event => event.preventDefault());
  window.once('ready-to-show', () => window?.show());
  contents.on('did-finish-load',()=>{ if (paddle?.status) publish('paddle-event',paddle.status); });
  contents.on('did-start-navigation',(_e,_url,inPlace,main)=>{ if (main && !inPlace) paddle?.command('interrupt'); });
  window.on('blur', () => { if (paddle?.input==='vband') void paddle.command('vband-release'); });
  window.on('closed', () => { paddle?.command('interrupt'); window = null; });
  contents.on('render-process-gone', () => {
    paddle?.command('interrupt');
    if (!closing) dialog.showMessageBox({ type: 'error', title: 'Morse', message: 'The practice window stopped.', detail: 'Your saved progress is kept. Reopen the window to continue.', buttons: ['Reopen', 'Quit'] }).then(({ response }) => { if (response === 0) { window?.reload(); showWindow(); } else app.quit(); });
  });
  window.loadURL(APP_ORIGIN).catch(error => {
    dialog.showErrorBox('Morse could not open', error.message); app.quit();
  });
  return window;
}

function installSessionPolicy() {
  const browserSession = session.fromPartition('persist:morse');
  browserSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !allowedRequest(details.url, details.method) }));
  browserSession.setPermissionCheckHandler((contents, permission, origin) => allowedPermission(permission, origin, contents?.getURL()));
  browserSession.setPermissionRequestHandler((contents, permission, callback, details) => callback(allowedPermission(permission, details.requestingUrl || contents.getURL(), contents.getURL())));
  browserSession.setDevicePermissionHandler(() => false);
  browserSession.on('will-download', (event, item, contents) => {
    if (!appDocument(contents?.getURL()) || !progressExport(item.getURL()) || !/^morse-progress-[\d-]+\.json$/.test(item.getFilename())) event.preventDefault();
  });
}

async function openPageControl(script) {
  showWindow();
  const contents = window.webContents;
  if (contents.isLoadingMainFrame()) await new Promise(resolve => {
    contents.once('did-finish-load', resolve);
    contents.once('destroyed', resolve);
    contents.once('did-fail-load', resolve);
  });
  if (!contents.isDestroyed() && appDocument(contents.getURL())) await contents.executeJavaScript(script, true).catch(() => {});
}

function menu() {
  const openSaved = () => openPageControl("document.getElementById('open-progress').click()");
  const template = [
    { label: 'Morse', submenu: [{ role: 'about' }, { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => openPageControl("document.querySelector('.main-nav [data-view=lab]').click()") }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
    { label: 'File', submenu: [{ label: 'Saved progress', accelerator: 'CmdOrCtrl+Shift+S', click: openSaved }, { type: 'separator' }, { role: 'close' }] },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ label: 'Listen', click: () => openPageControl("document.querySelector('[data-view=practice]').click()") }, { label: 'Send', click: () => openPageControl("document.querySelector('[data-view=send]').click()") }, { type: 'separator' }, { role: 'reload' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu' },
    { role: 'help', submenu: [
      { label: 'Paddle settings', click: () => openPageControl("document.querySelector('.main-nav [data-view=lab]').click(); document.getElementById('send-source').focus()") },
      { label: 'Open website', click: () => shell.openExternal(WEBSITE) },
    ] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => app.quit());
  app.on('second-instance', () => { if (db) showWindow(); });
  app.on('activate', () => { if (db) showWindow(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', async event => {
    if (!db || closing) return;
    event.preventDefault();
    if (stopping) return;
    stopping = true;
    if ((updates?.installRequested || updates?.automatic) && !await saveBeforeUpdate().catch(() => false)) {
      stopping = false; updates.saveFailed(); return;
    }
    clearInterval(updateTimer);
    try { await paddle?.stop(); } finally {
      closing = true;
      app.quit();
    }
  });
  // Keep SQLite available for the window's final pagehide save. A subsequent
  // before-quit from our own quit or the Mac updater must pass through.
  app.on('will-quit', () => { db?.close(); db = null; });
  app.whenReady().then(async () => {
    const dir=app.getPath('userData');
    await mkdir(dir,{recursive:true,mode:0o700});
    db=new LearnerDB(join(dir,'morse-learners-v2.sqlite'));
    const version = app.getVersion();
    const notes = await readFile(new URL('../assets/release-notes.json', import.meta.url), 'utf8').then(JSON.parse).catch(() => ({}));
    const updateEnabled = app.isPackaged && process.platform === 'darwin' && !isolated && !staged;
    const preference = channelPreference(join(app.getPath('appData'), 'Morse'));
    const defaultChannel = version.includes('-dev.') ? 'dev' : 'stable';
    updates = new UpdateManager({ version, installedNotes: notes?.[version] || '', enabled: updateEnabled,
      automatic: db.automaticUpdates, storeAutomatic: value => { db.automaticUpdates = value; },
      channel: updateEnabled ? preference.read(defaultChannel) : defaultChannel, storeChannel: value => preference.write(value),
      lookup: channel => checkUpdate(version, process.arch, fetch, channel), installer: updateEnabled ? await macInstaller(process.resourcesPath).catch(() => null) : null,
      changed: state => publish('update-state', state) });
    exchange=websiteClient(db.db,safeStorage,syncMode);
    const browserSession=session.fromPartition('persist:morse');
    browserSession.protocol.handle('http',await bundledTrainer(join(app.getAppPath(),'website/public')));
    installSessionPolicy(); registerIPC();
    if (process.platform==='darwin') {
      const helper=app.isPackaged ? join(process.resourcesPath,'../Helpers/MorseKeyer') : join(app.getAppPath(),'../native/MorseKeyer');
      paddle=new PaddleService(helper,join(dir,'paddle'),row=>publish('paddle-event',row),isolated);
      paddle.start();
      for (const signal of ['suspend','resume','lock-screen']) powerMonitor.on(signal,()=>{ paddle.command('interrupt'); publish('paddle-event',{type:'reset'}); });
      app.dock?.setIcon(nativeImage.createFromPath(icon));
    }
    menu(); createWindow();
    if (updates.enabled) { void updates.check(); updateTimer=setInterval(()=>updates.check(),6*3600000); updateTimer.unref(); }
  }).catch(error => {
    dialog.showErrorBox('Morse could not start', error.message);
    app.quit();
  });
}
