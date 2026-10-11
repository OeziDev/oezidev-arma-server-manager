import { app } from 'electron';
import { autoUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater';
import type { AppEvent, Lang, UpdateState } from '../shared/api.js';
import { UserError } from './errors.js';
import { log } from './log.js';

/**
 * Otomatik güncelleme (GitHub Releases, electron-updater).
 * Sadece kurulu (NSIS) uygulamada çalışır; geliştirme ve portable sürümde devre dışıdır.
 * Hatalar kısa bir mesaj olarak durumda gösterilir; güncelleyici kendi penceresini açmaz.
 */

const FIRST_CHECK_MS = 10_000;
const INTERVAL_MS = 6 * 3600_000;

export interface UpdaterOptions {
  emit: (e: AppEvent) => void;
  lang: () => Lang;
  /** Kurulumdan önce: işleri kontrol et, yöneticileri bırak, SSH'ı kapat, çıkışa izin ver */
  beforeInstall: () => Promise<void>;
}

function shortError(err: unknown, lang: Lang): string {
  const raw = err instanceof Error ? err.message : String(err ?? '');
  const tr = lang === 'tr';
  if (/net::ERR_INTERNET_DISCONNECTED|net::ERR_NAME_NOT_RESOLVED|net::ERR_NETWORK_CHANGED|ENOTFOUND|EAI_AGAIN|ENETUNREACH/i.test(raw)) {
    return tr ? 'İnternet bağlantısı yok' : 'No internet connection';
  }
  if (/net::ERR_CONNECTION|net::ERR_TIMED_OUT|ETIMEDOUT|ECONNREFUSED|ECONNRESET|socket hang up/i.test(raw)) {
    return tr ? 'Güncelleme sunucusuna ulaşılamadı' : 'Could not reach the update server';
  }
  if (/\b404\b|latest\.yml|Cannot find .*release|No published versions/i.test(raw)) {
    return tr ? 'Yayınlanmış güncelleme bilgisi bulunamadı' : 'No published update information found';
  }
  if (/\b(403|429)\b|rate limit/i.test(raw)) {
    return tr ? 'GitHub isteği geçici olarak reddetti; daha sonra tekrar denenecek' : 'GitHub temporarily refused the request; will retry later';
  }
  if (/sha512 checksum mismatch|signature/i.test(raw)) {
    return tr ? 'İndirilen güncelleme doğrulanamadı' : 'The downloaded update could not be verified';
  }
  const first = raw.split(/\r?\n/)[0]?.trim() ?? '';
  const msg = first.length > 160 ? `${first.slice(0, 157)}...` : first;
  return msg || (tr ? 'Güncelleme hatası' : 'Update error');
}

export class Updater {
  private state: UpdateState;
  private readonly enabled: boolean;
  private timers: NodeJS.Timeout[] = [];
  private lastPercent = -1;
  private checking: Promise<void> | null = null;

  constructor(private readonly opts: UpdaterOptions) {
    if (!app.isPackaged) {
      this.state = { status: 'disabled', disabledReason: 'dev' };
      this.enabled = false;
    } else if (process.env.PORTABLE_EXECUTABLE_DIR) {
      this.state = { status: 'disabled', disabledReason: 'portable' };
      this.enabled = false;
    } else {
      this.state = { status: 'idle' };
      this.enabled = true;
    }
  }

  start() {
    if (!this.enabled) {
      log('info', `[güncelleme] devre dışı (${this.state.disabledReason})`);
      return;
    }
    autoUpdater.logger = {
      info: (m?: unknown) => log('info', '[güncelleme]', m),
      warn: (m?: unknown) => log('warn', '[güncelleme]', m),
      error: (m?: unknown) => log('error', '[güncelleme]', m),
    };
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = false;

    autoUpdater.on('checking-for-update', () => {
      if (this.state.status !== 'downloading' && this.state.status !== 'ready') this.set({ status: 'checking' });
    });
    autoUpdater.on('update-available', (info: UpdateInfo) => {
      this.lastPercent = -1;
      this.set({ status: 'available', version: info.version });
    });
    autoUpdater.on('update-not-available', () => this.set({ status: 'none' }));
    autoUpdater.on('download-progress', (p: ProgressInfo) => {
      const percent = Math.max(0, Math.min(100, Math.round(p.percent * 10) / 10));
      // Çok sık olay gönderme: tam yüzde değişince
      if (Math.floor(percent) === this.lastPercent && this.state.status === 'downloading') return;
      this.lastPercent = Math.floor(percent);
      this.set({ status: 'downloading', ...(this.state.version ? { version: this.state.version } : {}), percent });
    });
    autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
      log('info', `[güncelleme] ${info.version} indirildi; çıkışta veya "Kur" ile kurulacak`);
      this.set({ status: 'ready', version: info.version, percent: 100 });
    });
    autoUpdater.on('error', (err: Error) => {
      log('warn', '[güncelleme] hata:', err?.message ?? err);
      // İndirilmiş bir güncelleme varken sonraki kontrol hatası onu gizlemesin
      if (this.state.status === 'ready') return;
      this.set({ status: 'error', error: shortError(err, this.opts.lang()), ...(this.state.version ? { version: this.state.version } : {}) });
    });

    this.timers.push(setTimeout(() => void this.check(), FIRST_CHECK_MS));
    this.timers.push(setInterval(() => void this.check(), INTERVAL_MS));
  }

  stop() {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  getState(): UpdateState {
    return { ...this.state };
  }

  private set(s: UpdateState) {
    this.state = s;
    this.opts.emit({ type: 'update', update: { ...s } });
  }

  /** Güncelleme kontrolü (devre dışıysa / indiriliyorsa / hazırsa mevcut durumu döner) */
  async check(): Promise<UpdateState> {
    if (!this.enabled) return this.getState();
    if (this.state.status === 'downloading' || this.state.status === 'ready' || this.state.status === 'available') return this.getState();
    if (!this.checking) {
      this.checking = (async () => {
        try {
          const res = await autoUpdater.checkForUpdates();
          // İndirme hatası 'error' olayıyla bildirilir; burada yakalanmamış söz kalmasın
          void res?.downloadPromise?.catch(() => undefined);
        } catch (err) {
          if (this.state.status !== 'ready') this.set({ status: 'error', error: shortError(err, this.opts.lang()) });
        }
      })().finally(() => {
        this.checking = null;
      });
    }
    await this.checking;
    return this.getState();
  }

  /** İndirilen güncellemeyi kur ve uygulamayı yeniden başlat (Arma sunucuları çalışmaya devam eder). */
  async install(): Promise<void> {
    if (!this.enabled) throw new UserError(this.opts.lang() === 'tr' ? 'Bu sürümde otomatik güncelleme yok' : 'Automatic updates are not available in this build');
    if (this.state.status !== 'ready') throw new UserError(this.opts.lang() === 'tr' ? 'Kurulacak indirilmiş bir güncelleme yok' : 'No downloaded update to install');
    await this.opts.beforeInstall();
    this.stop();
    log('info', `[güncelleme] ${this.state.version ?? ''} kuruluyor, uygulama yeniden başlatılacak`);
    // Sessiz kurulum, bitince uygulamayı yeniden aç
    setImmediate(() => autoUpdater.quitAndInstall(true, true));
  }
}
