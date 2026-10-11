import { app, BrowserWindow, dialog, Menu, nativeImage, session, shell, Tray } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AppEvent, AppSettings } from '../shared/api.js';
import { EVENT_CHANNEL } from '../shared/api.js';
import { EXTERNAL_ALLOW, registerIpc } from './ipc.js';
import { initLog, log } from './log.js';
import { AppServices, UserError } from './services.js';
import { Store } from './store.js';
import { Updater } from './updater.js';

const APP_NAME = 'OeziDev Arma Server Manager';
app.setName(APP_NAME);
if (process.platform === 'win32') app.setAppUserModelId('dev.oezi.armamanager');
// Sadece geliştirme: Linux'ta root olarak test ederken (konteyner/CI)
if (!app.isPackaged && process.env.OEZI_NO_SANDBOX === '1') app.commandLine.appendSwitch('no-sandbox');
// Portable sürüm: veriler exe'nin yanında kalsın (başka bilgisayara taşınabilsin)
if (process.env.PORTABLE_EXECUTABLE_DIR) {
  const legacy = app.getPath('userData');
  const portableData = path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'OeziArmaManager-data');
  migratePortableData(legacy, portableData);
  app.setPath('userData', portableData);
}
if (process.env.OEZI_USER_DATA) app.setPath('userData', process.env.OEZI_USER_DATA);

// Yakalanmamış hatalar: Electron'un hata penceresi yerine günlüğe yaz, uygulama çalışmaya devam etsin
initLog(app.getPath('userData'));
process.on('uncaughtException', (err) => log('error', '[uncaughtException]', err));
process.on('unhandledRejection', (reason) => log('error', '[unhandledRejection]', reason));

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let services: AppServices | null = null;
let updater: Updater | null = null;
let settings: AppSettings | null = null;
/** Arayüzde kaydedilmemiş değişiklik var mı */
let dirty = false;
/** true: çıkış onaylandı / gerekmiyor, before-quit ve pencere kapatma engellenmez */
let allowQuit = false;
let quitFlow: Promise<void> | null = null;

const resourcesDir = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', '..', 'build');
const indexHtml = path.resolve(__dirname, '..', 'renderer', 'index.html');
// Vite geliştirme sunucusu sadece paketlenmemiş uygulamada kullanılabilir
const devUrl = !app.isPackaged && process.env.VITE_DEV_SERVER_URL ? process.env.VITE_DEV_SERVER_URL : null;

function iconPath(name: string) {
  return path.join(resourcesDir, name);
}

function send(e: AppEvent) {
  if (win && !win.isDestroyed()) win.webContents.send(EVENT_CHANNEL, e);
}

function isDevNavigation(url: string): boolean {
  if (!devUrl) return false;
  try {
    return new URL(url).origin === new URL(devUrl).origin;
  } catch {
    return false;
  }
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

  // Harici bağlantılar uygulama içinde açılmaz; sadece izinli adresler tarayıcıda açılır
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (EXTERNAL_ALLOW.some((re) => re.test(url))) void shell.openExternal(url);
    return { action: 'deny' };
  });
  // Uygulama tek sayfa: hiçbir gezinmeye izin verme (pencereye sürüklenen dosyalar dahil)
  win.webContents.on('will-navigate', (e, url) => {
    if (!isDevNavigation(url)) e.preventDefault();
  });
  win.webContents.on('will-redirect', (e) => e.preventDefault());

  win.on('close', (e) => {
    if (allowQuit) return;
    e.preventDefault();
    if (settings?.minimizeToTray && tray) win?.hide();
    else void requestQuit();
  });
  // Windows oturumu kapanırken / bilgisayar kapanırken kapanmayı engelleme
  win.on('session-end', () => {
    allowQuit = true;
  });
  win.on('closed', () => {
    win = null;
  });

  // loadFile yerine kodlanmış file:// URL: gönderen doğrulaması (ipc.ts) yol üzerinden yapılır
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadURL(pathToFileURL(indexHtml).href);
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
        click: () => void requestQuit(),
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

/** Çıkınca kaybolacak / yarıda kalacak şeyler */
function quitReasons(lang: 'tr' | 'en'): string[] {
  const tr = lang === 'tr';
  const out: string[] = [];
  if (dirty) out.push(tr ? '• Kaydedilmemiş değişiklikler kaybolacak.' : '• Unsaved changes will be lost.');
  const work = services?.activeWork() ?? { jobs: [], busy: [] };
  for (const j of work.jobs) out.push(tr ? `• Devam eden iş iptal edilecek: ${j}` : `• Running job will be cancelled: ${j}`);
  for (const b of work.busy) out.push(tr ? `• Süren işlem yarıda kalacak: ${b}` : `• Operation in progress will be interrupted: ${b}`);
  return out;
}

const withTimeout = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<void>((r) => setTimeout(r, ms))]);

/**
 * Çıkış: kaydedilmemiş değişiklik / süren iş varsa onay iste; onaylanırsa işleri iptal edip bitmelerini bekle,
 * bağlantıları kapat ve çık. Arma sunucuları kapanmaz.
 */
function requestQuit(): Promise<void> {
  if (allowQuit) {
    app.quit();
    return Promise.resolve();
  }
  if (quitFlow) return quitFlow;
  quitFlow = (async () => {
    const lang = settings?.language ?? 'tr';
    const tr = lang === 'tr';
    const reasons = quitReasons(lang);
    if (reasons.length) {
      if (win && !win.isDestroyed() && !win.isVisible()) showWindow();
      const parent = win && !win.isDestroyed() ? win : null;
      const box = {
        type: 'warning' as const,
        buttons: tr ? ['Çık', 'Vazgeç'] : ['Quit', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
        title: APP_NAME,
        message: tr ? 'Uygulamadan çıkılsın mı?' : 'Quit the application?',
        detail:
          reasons.join('\n') +
          '\n\n' +
          (tr ? 'Çalışan Arma sunucuları kapanmaz, çalışmaya devam eder.' : 'Running Arma servers are not stopped; they keep running.'),
      };
      const res = parent ? await dialog.showMessageBox(parent, box) : await dialog.showMessageBox(box);
      if (res.response !== 0) return;
      dirty = false;
    }
    const s = services;
    if (s) {
      await s.abortAllJobs(10_000);
      await withTimeout(s.shutdown(), 5_000);
    }
    updater?.stop();
    allowQuit = true;
    app.quit();
    // Bir şey çıkışı engellerse yine de kapan
    setTimeout(() => app.exit(0), 3_000).unref();
  })()
    .catch((err) => {
      log('error', 'Çıkış sırasında hata:', err);
      allowQuit = true;
      app.exit(0);
    })
    .finally(() => {
      quitFlow = null;
    });
  return quitFlow;
}

function warnUnreadableSecrets(store: Store) {
  if (!store.secretsUnreadable) return;
  const tr = (settings?.language ?? 'tr') === 'tr';
  const backup = store.secretsBackupFile;
  const opts = {
    type: 'warning' as const,
    title: APP_NAME,
    message: tr ? 'Kayıtlı şifreler okunamadı' : 'Saved passwords could not be read',
    detail: tr
      ? `Şifre dosyası (secrets.bin) çözülemedi; Windows kullanıcı hesabı / anahtarlık değişmiş olabilir. Dosya silinmedi${backup ? ` ve kopyası alındı:\n${backup}` : ''}.\n\nŞifreleri (SSH, Steam, RCON, sunucu şifreleri) yeniden girip kaydettiğinde yeni bir dosya oluşturulur.`
      : `The password file (secrets.bin) could not be decrypted; the Windows user account / keyring may have changed. The file was not deleted${backup ? ` and a copy was made:\n${backup}` : ''}.\n\nRe-enter and save your passwords (SSH, Steam, RCON, server passwords) to create a new file.`,
  };
  const parent = win && !win.isDestroyed() ? win : null;
  void (parent ? dialog.showMessageBox(parent, opts) : dialog.showMessageBox(opts));
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

    const store = new Store(app.getPath('userData'), { appVersion: app.getVersion(), log: (level, msg) => log(level, msg) });
    settings = store.getSettings();
    store.onSettingsChanged = (s) => {
      const langChanged = settings?.language !== s.language;
      settings = s;
      if (langChanged) {
        tray?.destroy();
        createTray();
      }
      send({ type: 'settings-changed', settings: { ...s, steamPassword: '' } });
    };
    services = new AppServices(store, send);
    const svc = services;
    updater = new Updater({
      emit: send,
      lang: () => settings?.language ?? 'tr',
      beforeInstall: async () => {
        if (dirty) {
          throw new UserError(
            (settings?.language ?? 'tr') === 'tr' ? 'Kaydedilmemiş değişiklikler var. Önce kaydet veya vazgeç.' : 'There are unsaved changes. Save or discard them first.',
          );
        }
        await svc.prepareForUpdate();
        allowQuit = true;
      },
      onInstallFailed: async () => {
        // Uygulama kapanmadı: sunucu takibini geri getir, çıkışta yine sorulsun
        allowQuit = false;
        await svc.init();
      },
    });
    registerIpc({
      services: svc,
      store,
      getWindow: () => win,
      version: app.getVersion(),
      indexHtml,
      devUrl,
      updater,
      setDirty: (d) => {
        dirty = d;
      },
    });
    createWindow();
    createTray();
    warnUnreadableSecrets(store);
    const q = store.quarantinedProfiles();
    if (q.length) log('warn', `Karantinadaki profiller (silinmedi): ${q.map((x) => `${x.name} [${x.id}]`).join(', ')}`);
    updater.start();
    await services.init();
  });

  app.on('before-quit', (e) => {
    if (allowQuit) return;
    e.preventDefault();
    void requestQuit();
  });

  app.on('window-all-closed', () => {
    if (allowQuit) return;
    if (!settings?.minimizeToTray || !tray) void requestQuit();
  });

  app.on('will-quit', () => {
    // Sunucular ayrı süreç / systemd servisi olarak çalıştığı için kapanmaz; sadece bağlantılar kapanır.
    void services?.shutdown();
  });
}

/**
 * 1.0.0 portable sürümü verisini %APPDATA%'da tutuyordu; 1.0.1'den itibaren exe'nin yanında.
 * Yeni klasörde veri yoksa eskisini bir kez kopyala (silmeden), kullanıcı sunucularını kaybolmuş sanmasın.
 */
function migratePortableData(from: string, to: string): void {
  try {
    if (fs.existsSync(path.join(to, 'data.json')) || !fs.existsSync(path.join(from, 'data.json'))) return;
    fs.mkdirSync(to, { recursive: true });
    for (const name of fs.readdirSync(from)) {
      if (/^(data\.json|secrets\.bin)(\.bak.*)?$/.test(name)) fs.copyFileSync(path.join(from, name), path.join(to, name));
    }
  } catch {
    // Kopyalanamazsa boş başla; eski veri yerinde duruyor
  }
}

