import { app, BrowserWindow, Menu, nativeImage, session, shell, Tray } from 'electron';
import path from 'node:path';
import type { AppEvent, AppSettings } from '../shared/api.js';
import { EVENT_CHANNEL } from '../shared/api.js';
import { registerIpc } from './ipc.js';
import { AppServices } from './services.js';
import { Store } from './store.js';

const APP_NAME = 'OeziDev Arma Server Manager';
app.setName(APP_NAME);
if (process.platform === 'win32') app.setAppUserModelId('dev.oezi.armamanager');
// Sadece Linux'ta root olarak test ederken (konteyner/CI)
if (process.env.OEZI_NO_SANDBOX === '1') app.commandLine.appendSwitch('no-sandbox');
if (process.env.OEZI_USER_DATA) app.setPath('userData', process.env.OEZI_USER_DATA);

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let services: AppServices | null = null;
let settings: AppSettings | null = null;

const resourcesDir = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', '..', 'build');

function iconPath(name: string) {
  return path.join(resourcesDir, name);
}

function send(e: AppEvent) {
  if (win && !win.isDestroyed()) win.webContents.send(EVENT_CHANNEL, e);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1040,
    minHeight: 680,
    title: APP_NAME,
    backgroundColor: '#171a16',
    show: false,
    icon: iconPath(process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      devTools: !app.isPackaged || process.env.OEZI_DEVTOOLS === '1',
    },
  });
  win.once('ready-to-show', () => win?.show());

  // Harici bağlantılar uygulama içinde açılmaz
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://') && !url.startsWith(process.env.VITE_DEV_SERVER_URL ?? '\0')) e.preventDefault();
  });

  win.on('close', (e) => {
    if (!quitting && settings?.minimizeToTray && tray) {
      e.preventDefault();
      win?.hide();
    }
  });
  win.on('closed', () => {
    win = null;
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

function createTray() {
  const img = nativeImage.createFromPath(iconPath('tray.png'));
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
  tray.setToolTip(APP_NAME);
  const lang = settings?.language ?? 'tr';
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: lang === 'tr' ? 'Pencereyi göster' : 'Show window', click: () => showWindow() },
      { type: 'separator' },
      {
        label: lang === 'tr' ? 'Çıkış (sunucular çalışmaya devam eder)' : 'Quit (servers keep running)',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on('click', () => showWindow());
}

function showWindow() {
  if (!win) createWindow();
  else {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    // Sıkı içerik güvenliği: sadece uygulamanın kendi dosyaları
    session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
      cb({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' ws://localhost:*",
          ],
        },
      });
    });
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));

    const store = new Store(app.getPath('userData'));
    settings = store.getSettings();
    services = new AppServices(store, send);
    registerIpc({
      services,
      store,
      getWindow: () => win,
      version: app.getVersion(),
      onSettingsChanged: (s) => {
        settings = s;
        tray?.destroy();
        createTray();
      },
    });
    createWindow();
    createTray();
    await services.init();
  });

  app.on('before-quit', () => {
    quitting = true;
  });

  app.on('window-all-closed', () => {
    if (!settings?.minimizeToTray || !tray) app.quit();
  });

  app.on('will-quit', () => {
    // Sunucular ayrı süreç / systemd servisi olarak çalıştığı için kapanmaz; sadece bağlantılar kapanır.
    void services?.shutdown();
  });
}
