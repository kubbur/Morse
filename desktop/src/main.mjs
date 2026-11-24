import { app, BrowserWindow, Menu, dialog, session, shell, clipboard, nativeImage } from 'electron';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { APP_ORIGIN, WEBSITE, appDocument, allowedRequest, allowedPermission, progressExport } from './policy.mjs';
import { startLocalServer } from './local-server.mjs';

app.setName('Morse');
process.umask(0o077);
const icon = fileURLToPath(new URL('../assets/icon.png', import.meta.url));
let window, server, closing = false, stopping = false;

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
      partition: 'persist:morse', sandbox: true, contextIsolation: true,
      nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false,
      devTools: !app.isPackaged,
    },
  });
  const contents = window.webContents;
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  for (const name of ['will-navigate', 'will-redirect']) contents.on(name, (event, url) => { if (!appDocument(url)) event.preventDefault(); });
  contents.on('will-attach-webview', event => event.preventDefault());
  window.once('ready-to-show', () => window?.show());
  window.on('closed', () => { window = null; });
  contents.on('render-process-gone', () => {
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
    { label: 'Morse', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
    { label: 'File', submenu: [{ label: 'Saved progress', accelerator: 'CmdOrCtrl+Shift+S', click: openSaved }, { type: 'separator' }, { role: 'close' }] },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ label: 'Practice', click: () => openPageControl("document.querySelector('[data-view=practice]').click()") }, { label: 'Send', click: () => openPageControl("document.querySelector('[data-view=send]').click()") }, { type: 'separator' }, { role: 'reload' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu' },
    { role: 'help', submenu: [
      { label: 'Morse Paddle setup', click: () => dialog.showMessageBox({ title: 'Morse Paddle', message: 'Connect your paddle', detail: `Open Morse Paddle on this Mac. Enter ${APP_ORIGIN}, click Link, then connect from the Send tab.`, buttons: ['Done'] }) },
      { label: 'Copy Morse Paddle address', click: () => clipboard.writeText(APP_ORIGIN) },
      { type: 'separator' },
      { label: 'Open website', click: () => shell.openExternal(WEBSITE) },
    ] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => app.quit());
  app.on('second-instance', () => { if (server) showWindow(); });
  app.on('activate', () => { if (server) showWindow(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', event => {
    closing = true;
    if (!server || stopping) return;
    event.preventDefault(); stopping = true;
    // Let the existing pagehide handlers release contacts and unmute the key.
    const release = window && !window.isDestroyed() ? window.webContents.executeJavaScript("window.dispatchEvent(new Event('pagehide'))").catch(() => {}) : Promise.resolve();
    Promise.race([release.then(() => new Promise(resolve => setTimeout(resolve, 250))), new Promise(resolve => setTimeout(resolve, 1000))])
      .then(() => { session.fromPartition('persist:morse').flushStorageData(); return server.close(); }).finally(() => app.quit());
  });
  app.whenReady().then(async () => {
    app.setAboutPanelOptions({ applicationName: 'Morse', applicationVersion: app.getVersion(), iconPath: icon, credits: 'Morse code listening and sending practice.' });
    if (process.platform === 'darwin') app.dock?.setIcon(nativeImage.createFromPath(icon));
    installSessionPolicy();
    server = await startLocalServer(join(app.getPath('userData'), 'save'));
    menu(); createWindow();
  }).catch(error => {
    dialog.showErrorBox('Morse could not start', error.code === 'EADDRINUSE' ? 'Another application is using the local Morse address. Quit other copies of Morse and try again.' : error.message);
    app.quit();
  });
}
