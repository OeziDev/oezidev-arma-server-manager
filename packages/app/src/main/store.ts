import { safeStorage } from 'electron';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ServerProfileSchema, type ServerProfile } from '@oezi/arma-core';
import type { AppSettings, HostConfig } from '../shared/api.js';
import { UserError } from './errors.js';

/**
 * Kalıcı veri: profiller, SSH makineleri, ayarlar (data.json) ve şifreler (secrets.bin).
 * Şifreler Electron safeStorage ile şifrelenir: Windows'ta DPAPI (kullanıcı hesabına bağlı),
 * Linux'ta sistem anahtarlığı. Profil dosyasında şifre alanları boş tutulur.
 *
 * Dayanıklılık:
 *  - Yazma: geçici dosya + fsync + yeniden adlandırma; önceki geçerli dosya `.bak` olarak kalır.
 *  - Okuma: ana dosya boş/bozuksa `.bak`'tan yüklenir.
 *  - Şemaya uymayan profiller silinmez: karantinaya alınır ve olduğu gibi geri yazılır.
 *  - secrets.bin çözülemezse kenara kopyalanır ve kullanıcı yeni bir şifre girene kadar üzerine yazılmaz.
 */

const PROFILE_SECRET_PATHS = [
  'general.password',
  'general.passwordAdmin',
  'general.serverCommandPassword',
  'rcon.password',
  'steam.branchPassword',
  'notifications.discordWebhook',
  'backup.database.password',
  'discordStatus.webhook',
] as const;

type PublicSettings = Omit<AppSettings, 'steamPassword' | 'hasSteamPassword' | 'clearSteamPassword'>;

interface DataFile {
  version: 1;
  /** Dosyayı en son yazan uygulama sürümü */
  appVersion?: string;
  settings: PublicSettings;
  hosts: Omit<HostConfig, 'password' | 'passphrase' | 'hasPassword'>[];
  profiles: ServerProfile[];
}

const DEFAULT_SETTINGS: PublicSettings = {
  language: 'tr',
  minimizeToTray: true,
  launchAtLogin: false,
  localSteamcmdPath: '',
  steamUsername: '',
};

/** secrets.bin biçim başlıkları */
const HDR_ENC = Buffer.from('enc1:', 'utf8');
const HDR_B64 = Buffer.from('b64:', 'utf8');

export type StoreLog = (level: 'info' | 'warn' | 'error', message: string) => void;

export interface StoreOptions {
  /** Uygulama sürümü: sürüm değişince ilk yazmadan önce data.json yedeklenir */
  appVersion?: string;
  log?: StoreLog;
  /** Test için: yeniden adlandırma tekrar denemesi (varsayılan: sadece Windows) */
  retryRename?: boolean;
}

export interface QuarantinedProfile {
  id: string;
  name: string;
  reason: string;
}

function getPath(obj: Record<string, unknown>, p: string): unknown {
  return p.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
}
function setPath(obj: Record<string, unknown>, p: string, value: unknown) {
  const keys = p.split('.');
  let cur = obj;
  for (const k of keys.slice(0, -1)) {
    if (!cur[k] || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]!] = value;
}

function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

/** Windows'ta virüs tarayıcı / yedekleme programı dosyayı kısa süre kilitleyebilir: birkaç kez dene. */
export function renameWithRetry(from: string, to: string, retry = process.platform === 'win32', attempts = 5, delayMs = 100) {
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (!retry || i >= attempts - 1 || !code || !RETRY_CODES.has(code)) throw err;
      sleepSync(delayMs * (i + 1));
    }
  }
}

function writeDurable(file: string, data: Buffer) {
  const fd = fs.openSync(file, 'w', 0o600);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function fsyncDir(dir: string) {
  if (process.platform === 'win32') return;
  try {
    const fd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    /* bazı dosya sistemleri desteklemez */
  }
}

/**
 * Atomik ve kalıcı yazma: geçici dosyaya yaz, fsync, önceki geçerli dosyayı `.bak` olarak sakla,
 * yeniden adlandır. Elektrik kesilirse ya eski ya yeni dosya kalır (boş dosya değil).
 */
export function writeAtomic(file: string, data: string | Buffer, opts: { retry?: boolean; isValid?: (prev: Buffer) => boolean } = {}) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeDurable(tmp, buf);
    let prev: Buffer | null = null;
    try {
      prev = fs.readFileSync(file);
    } catch {
      prev = null;
    }
    if (prev && prev.length > 0 && (!opts.isValid || opts.isValid(prev))) {
      try {
        writeDurable(`${file}.bak`, prev);
      } catch {
        /* yedek yazılamasa da asıl kayıt devam etsin */
      }
    }
    renameWithRetry(tmp, file, opts.retry);
    fsyncDir(dir);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* yok say */
    }
    throw err;
  }
}

function isJsonObject(buf: Buffer): boolean {
  try {
    const v = JSON.parse(buf.toString('utf8')) as unknown;
    return !!v && typeof v === 'object' && !Array.isArray(v);
  } catch {
    return false;
  }
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export class Store {
  private data: DataFile;
  /** Şemaya uymayan profiller (ham hâliyle, dokunulmadan geri yazılır) */
  private quarantine: unknown[] = [];
  private quarantineInfo: QuarantinedProfile[] = [];
  private secrets: Record<string, string> = {};
  readonly insecureSecrets: boolean;
  private _secretsUnreadable = false;
  /** Okunamayan secrets.bin'in kopyası */
  private _secretsBackup: string | null = null;
  /** Okunamayan dosya varken kullanıcı yeni bir şifre girdi mi (girdiyse yeni dosya yazılabilir) */
  private secretsTouched = false;
  private readonly dataFile: string;
  private readonly secretsFile: string;
  private readonly appVersion: string | undefined;
  private readonly logFn: StoreLog;
  private readonly retryRename: boolean | undefined;
  /** Sürüm değiştiyse ilk yazmadan önce yedeklenecek içerik */
  private versionBackup: { name: string; content: Buffer } | null = null;
  /** Ayarlar değişince (arayüze settings-changed göndermek için) */
  onSettingsChanged: ((s: AppSettings) => void) | null = null;

  constructor(
    readonly dir: string,
    opts: StoreOptions = {},
  ) {
    this.dataFile = path.join(dir, 'data.json');
    this.secretsFile = path.join(dir, 'secrets.bin');
    this.appVersion = opts.appVersion;
    this.retryRename = opts.retryRename;
    this.logFn = opts.log ?? ((level, msg) => (level === 'info' ? console.log(msg) : level === 'warn' ? console.warn(msg) : console.error(msg)));
    this.insecureSecrets = !safeStorage.isEncryptionAvailable();
    this.cleanStaleTemp();
    this.data = this.loadData();
    this.secrets = this.loadSecrets();
  }

  get secretsUnreadable(): boolean {
    return this._secretsUnreadable;
  }

  get secretsBackupFile(): string | null {
    return this._secretsBackup;
  }

  quarantinedProfiles(): QuarantinedProfile[] {
    return this.quarantineInfo.map((q) => ({ ...q }));
  }

  /* ---------------- yükleme ---------------- */

  private cleanStaleTemp() {
    try {
      for (const name of fs.readdirSync(this.dir)) {
        if (/^(data\.json|secrets\.bin)\.[0-9a-f]{8}\.tmp$/.test(name)) {
          fs.rmSync(path.join(this.dir, name), { force: true });
        }
      }
    } catch {
      /* klasör henüz yok */
    }
  }

  /**
   * Ana dosya, olmazsa .bak. Bozuk ana dosya `<ad>.<brokenSuffix>-<zaman>` olarak kenara kopyalanır.
   * state: 'ok' (buf dolu), 'none' (hiç dosya yok), 'broken' (dosya var ama okunamıyor, yedek de yok).
   */
  private readWithFallback(file: string, parse: (buf: Buffer) => boolean, brokenSuffix: string): { state: 'ok' | 'none' | 'broken'; buf?: Buffer; brokenCopy?: string } {
    let mainBuf: Buffer | null = null;
    try {
      mainBuf = fs.readFileSync(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.logFn('error', `${path.basename(file)} okunamadı: ${(err as Error).message}`);
    }
    if (mainBuf && mainBuf.length > 0 && parse(mainBuf)) return { state: 'ok', buf: mainBuf };
    let brokenCopy: string | undefined;
    if (mainBuf && mainBuf.length > 0) {
      const copy = `${file}.${brokenSuffix}-${stamp()}`;
      try {
        fs.copyFileSync(file, copy);
        brokenCopy = copy;
      } catch {
        /* yok say */
      }
    }
    let bakBuf: Buffer | null = null;
    try {
      bakBuf = fs.readFileSync(`${file}.bak`);
    } catch {
      bakBuf = null;
    }
    if (bakBuf && bakBuf.length > 0 && parse(bakBuf)) {
      this.logFn('warn', `${path.basename(file)} boş/bozuk ya da eksik; yedekten (.bak) yüklendi.${brokenCopy ? ` Bozuk dosya: ${brokenCopy}` : ''}`);
      return { state: 'ok', buf: bakBuf, ...(brokenCopy ? { brokenCopy } : {}) };
    }
    if (bakBuf === null && (mainBuf === null || mainBuf.length === 0)) {
      if (mainBuf) this.logFn('warn', `${path.basename(file)} boş ve yedeği yok; boş olarak başlanıyor.`);
      return { state: 'none' };
    }
    return { state: 'broken', ...(brokenCopy ? { brokenCopy } : {}) };
  }

  private loadData(): DataFile {
    const fresh = (): DataFile => ({ version: 1, settings: { ...DEFAULT_SETTINGS }, hosts: [], profiles: [] });
    const res = this.readWithFallback(this.dataFile, isJsonObject, 'broken');
    if (res.state === 'none' || !res.buf) {
      if (res.state === 'broken') this.logFn('error', `data.json okunamadı ve geçerli bir yedek yok; boş ayarlarla başlanıyor.${res.brokenCopy ? ` Bozuk dosya: ${res.brokenCopy}` : ''}`);
      return fresh();
    }
    const raw = JSON.parse(res.buf.toString('utf8')) as Partial<DataFile> & { profiles?: unknown };
    if (this.appVersion && raw.appVersion !== this.appVersion) {
      this.versionBackup = { name: `${this.dataFile}.bak-${raw.appVersion ?? 'legacy'}`, content: res.buf };
    }
    const profiles: ServerProfile[] = [];
    for (const p of Array.isArray(raw.profiles) ? raw.profiles : []) {
      const parsed = ServerProfileSchema.safeParse(p);
      if (parsed.success) {
        profiles.push(parsed.data);
      } else {
        const obj = (p && typeof p === 'object' ? p : {}) as { id?: unknown; name?: unknown };
        const info: QuarantinedProfile = {
          id: typeof obj.id === 'string' ? obj.id : '?',
          name: typeof obj.name === 'string' ? obj.name : '?',
          reason: parsed.error.issues
            .slice(0, 3)
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; '),
        };
        this.quarantine.push(p);
        this.quarantineInfo.push(info);
        this.logFn('warn', `Profil şemaya uymuyor, karantinaya alındı (silinmedi, dosyada korunuyor): ${info.name} [${info.id}] — ${info.reason}`);
      }
    }
    return {
      version: 1,
      ...(raw.appVersion ? { appVersion: raw.appVersion } : {}),
      settings: { ...DEFAULT_SETTINGS, ...(raw.settings && typeof raw.settings === 'object' ? raw.settings : {}) },
      hosts: Array.isArray(raw.hosts) ? raw.hosts : [],
      profiles,
    };
  }

  private decodeSecrets(buf: Buffer): Record<string, string> {
    let text: string;
    if (buf.subarray(0, HDR_ENC.length).equals(HDR_ENC)) {
      if (this.insecureSecrets) throw new Error('Şifreler şifreli kaydedilmiş ama sistem şifrelemesi şu an kullanılamıyor');
      text = safeStorage.decryptString(buf.subarray(HDR_ENC.length));
    } else if (buf.subarray(0, HDR_B64.length).equals(HDR_B64)) {
      text = Buffer.from(buf.subarray(HDR_B64.length).toString('utf8'), 'base64').toString('utf8');
    } else {
      // Eski (başlıksız) dosya: biçimi o anki şifreleme durumundan tahmin et, olmazsa diğerini dene
      const asB64 = () => Buffer.from(buf.toString('utf8'), 'base64').toString('utf8');
      const asEnc = () => safeStorage.decryptString(buf);
      const order = this.insecureSecrets ? [asB64, asEnc] : [asEnc, asB64];
      let lastErr: unknown;
      text = '';
      for (const f of order) {
        try {
          const t = f();
          JSON.parse(t);
          text = t;
          lastErr = undefined;
          break;
        } catch (err) {
          lastErr = err;
        }
      }
      if (lastErr) throw lastErr;
    }
    const obj = JSON.parse(text) as unknown;
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('Geçersiz şifre dosyası');
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) if (typeof v === 'string') out[k] = v;
    return out;
  }

  private loadSecrets(): Record<string, string> {
    let lastErr: unknown = null;
    const res = this.readWithFallback(
      this.secretsFile,
      (buf) => {
        try {
          this.decodeSecrets(buf);
          return true;
        } catch (err) {
          lastErr = err;
          return false;
        }
      },
      'unreadable',
    );
    if (res.state === 'ok' && res.buf) return this.decodeSecrets(res.buf);
    if (res.state === 'none') return {};
    // Dosyayı silme/üzerine yazma: kullanıcı yeni şifre girene kadar korunur (kopyası da alındı)
    this._secretsUnreadable = true;
    this._secretsBackup = res.brokenCopy ?? null;
    this.logFn(
      'error',
      `secrets.bin çözülemedi (${(lastErr as Error | null)?.message ?? 'boş dosya'}). Kayıtlı şifreler kullanılamıyor; dosya korunuyor${this._secretsBackup ? ` (kopya: ${this._secretsBackup})` : ''}. Yeni bir şifre kaydedilene kadar üzerine yazılmayacak.`,
    );
    return {};
  }

  /* ---------------- yazma ---------------- */

  private persistData() {
    if (this.versionBackup) {
      try {
        if (!fs.existsSync(this.versionBackup.name)) writeDurable(this.versionBackup.name, this.versionBackup.content);
        this.versionBackup = null;
      } catch (err) {
        this.logFn('warn', `Sürüm yedeği yazılamadı: ${(err as Error).message}`);
      }
    }
    const out: Omit<DataFile, 'profiles'> & { profiles: unknown[] } = {
      version: 1,
      ...(this.appVersion ? { appVersion: this.appVersion } : this.data.appVersion ? { appVersion: this.data.appVersion } : {}),
      settings: this.data.settings,
      hosts: this.data.hosts,
      // Karantinadaki profiller olduğu gibi geri yazılır (yeni bir sürüm okuyabilir / elle düzeltilebilir)
      profiles: [...this.data.profiles, ...this.quarantine],
    };
    writeAtomic(this.dataFile, JSON.stringify(out, null, 2), { isValid: isJsonObject, ...(this.retryRename !== undefined ? { retry: this.retryRename } : {}) });
  }

  private persistSecrets() {
    // Okunamayan dosya varken, kullanıcı yeni şifre girmediyse dokunma (boş içerikle ezilmesin)
    if (this._secretsUnreadable && !this.secretsTouched) return;
    const text = JSON.stringify(this.secrets);
    const buf = this.insecureSecrets
      ? Buffer.concat([HDR_B64, Buffer.from(Buffer.from(text, 'utf8').toString('base64'), 'utf8')])
      : Buffer.concat([HDR_ENC, safeStorage.encryptString(text)]);
    writeAtomic(this.secretsFile, buf, {
      // Okunamayan eski dosya .bak'a kopyalanmasın (kopyası zaten .unreadable-* olarak var)
      isValid: (prev) => {
        try {
          this.decodeSecrets(prev);
          return true;
        } catch {
          return false;
        }
      },
      ...(this.retryRename !== undefined ? { retry: this.retryRename } : {}),
    });
    if (this._secretsUnreadable) {
      this._secretsUnreadable = false;
      this.logFn('info', 'Yeni şifre kaydedildi; okunamayan secrets.bin yerine yeni dosya yazıldı.');
    }
  }

  /**
   * Bellekteki değişikliği uygula ve diske yaz. Yazma başarısız olursa bellekteki değişiklik geri alınır
   * (arayüz ile disk tutarsız kalmasın) ve anlaşılır bir hata fırlatılır.
   */
  private commit<T>(fn: () => T, what: { data?: boolean; secrets?: boolean } = { data: true, secrets: true }): T {
    const dataSnap = structuredClone(this.data);
    const secretsSnap = { ...this.secrets };
    const touchedSnap = this.secretsTouched;
    const unreadableSnap = this._secretsUnreadable;
    const rollback = () => {
      this.data = dataSnap;
      this.secrets = secretsSnap;
      this.secretsTouched = touchedSnap;
      this._secretsUnreadable = unreadableSnap;
    };
    let result: T;
    try {
      result = fn();
    } catch (err) {
      rollback();
      throw err;
    }
    let secretsWritten = false;
    try {
      if (what.secrets) {
        this.persistSecrets();
        secretsWritten = true;
      }
      if (what.data) this.persistData();
    } catch (err) {
      rollback();
      if (secretsWritten && !unreadableSnap) {
        // Şifreler yazılmış ama data.json yazılamamış: eski şifreleri geri yaz
        try {
          this.persistSecrets();
        } catch {
          /* yok say */
        }
      }
      const e = err as NodeJS.ErrnoException;
      this.logFn('error', `Kayıt diske yazılamadı: ${e.code ?? ''} ${e.message}`);
      const why =
        e.code === 'ENOSPC'
          ? 'diskte yer yok'
          : e.code === 'EPERM' || e.code === 'EACCES' || e.code === 'EBUSY'
            ? 'dosya başka bir program (virüs tarayıcı, yedekleme) tarafından kilitli ya da yazma izni yok'
            : e.message;
      throw new UserError(`Değişiklik kaydedilemedi (${why}). Değişiklik geri alındı; lütfen tekrar dene.`);
    }
    return result;
  }

  private setSecret(key: string, value: string | undefined) {
    if (value) {
      if (this.secrets[key] !== value) this.secretsTouched = true;
      this.secrets[key] = value;
    } else {
      delete this.secrets[key];
    }
  }

  getSecret(key: string): string {
    return this.secrets[key] ?? '';
  }

  /* ---------------- ayarlar ---------------- */

  getSettings(): AppSettings {
    return { ...this.data.settings, steamPassword: '', hasSteamPassword: !!this.secrets['steam:password'] };
  }

  /** Sadece verilen alanlar değişir; eksik alanlar korunur. */
  saveSettings(patch: Partial<AppSettings>): AppSettings {
    const touchesSecret = !!patch.steamPassword || !!patch.clearSteamPassword;
    this.commit(
      () => {
        const next: PublicSettings = { ...this.data.settings };
        if (patch.language !== undefined) next.language = patch.language === 'en' ? 'en' : 'tr';
        if (patch.minimizeToTray !== undefined) next.minimizeToTray = !!patch.minimizeToTray;
        if (patch.launchAtLogin !== undefined) next.launchAtLogin = !!patch.launchAtLogin;
        if (patch.localSteamcmdPath !== undefined) next.localSteamcmdPath = String(patch.localSteamcmdPath ?? '');
        if (patch.steamUsername !== undefined) next.steamUsername = String(patch.steamUsername ?? '');
        this.data.settings = next;
        if (patch.steamPassword) this.setSecret('steam:password', patch.steamPassword);
        if (patch.clearSteamPassword) this.setSecret('steam:password', undefined);
      },
      { data: true, secrets: touchesSecret },
    );
    const pub = this.getSettings();
    try {
      this.onSettingsChanged?.(pub);
    } catch (err) {
      this.logFn('error', `settings-changed bildirimi başarısız: ${(err as Error).message}`);
    }
    return pub;
  }

  steamPassword(): string {
    return this.getSecret('steam:password');
  }

  /* ---------------- makineler ---------------- */

  listHosts(): HostConfig[] {
    return this.data.hosts.map((h) => ({ ...h, hasPassword: !!this.secrets[`host:${h.id}:password`] || !!this.secrets[`host:${h.id}:passphrase`] }));
  }

  getHost(id: string): HostConfig | undefined {
    return this.listHosts().find((h) => h.id === id);
  }

  hostSecrets(id: string): { password: string; passphrase: string } {
    return { password: this.getSecret(`host:${id}:password`), passphrase: this.getSecret(`host:${id}:passphrase`) };
  }

  saveHost(h: HostConfig): HostConfig {
    this.commit(() => {
      const { password, passphrase, hasPassword: _hp, ...rest } = h;
      const idx = this.data.hosts.findIndex((x) => x.id === h.id);
      if (idx >= 0) this.data.hosts[idx] = rest;
      else this.data.hosts.push(rest);
      if (password) this.setSecret(`host:${h.id}:password`, password);
      if (passphrase) this.setSecret(`host:${h.id}:passphrase`, passphrase);
      if (h.authMethod === 'key') this.setSecret(`host:${h.id}:password`, undefined);
    });
    return this.getHost(h.id)!;
  }

  removeHost(id: string) {
    this.commit(() => {
      this.data.hosts = this.data.hosts.filter((h) => h.id !== id);
      this.setSecret(`host:${id}:password`, undefined);
      this.setSecret(`host:${id}:passphrase`, undefined);
    });
  }

  /* ---------------- profiller ---------------- */

  listProfiles(): ServerProfile[] {
    return this.data.profiles.map((p) => this.withSecrets(p));
  }

  getProfile(id: string): ServerProfile | undefined {
    const p = this.data.profiles.find((x) => x.id === id);
    return p ? this.withSecrets(p) : undefined;
  }

  private withSecrets(p: ServerProfile): ServerProfile {
    const copy = structuredClone(p) as unknown as Record<string, unknown>;
    for (const sp of PROFILE_SECRET_PATHS) {
      const s = this.secrets[`profile:${p.id}:${sp}`];
      if (s !== undefined) setPath(copy, sp, s);
    }
    return copy as unknown as ServerProfile;
  }

  saveProfile(p: ServerProfile): ServerProfile {
    this.commit(() => {
      const stripped = structuredClone(p) as unknown as Record<string, unknown>;
      for (const sp of PROFILE_SECRET_PATHS) {
        const value = getPath(stripped, sp);
        this.setSecret(`profile:${p.id}:${sp}`, typeof value === 'string' ? value : undefined);
        setPath(stripped, sp, '');
      }
      const clean = stripped as unknown as ServerProfile;
      const idx = this.data.profiles.findIndex((x) => x.id === p.id);
      if (idx >= 0) this.data.profiles[idx] = clean;
      else this.data.profiles.push(clean);
    });
    return this.getProfile(p.id)!;
  }

  removeProfile(id: string) {
    this.commit(() => {
      this.data.profiles = this.data.profiles.filter((p) => p.id !== id);
      for (const sp of PROFILE_SECRET_PATHS) this.setSecret(`profile:${id}:${sp}`, undefined);
    });
  }

  /** Dışa aktarma: şifreler hariç */
  exportProfile(id: string): string {
    const p = this.data.profiles.find((x) => x.id === id);
    if (!p) throw new Error('Profil bulunamadı');
    return JSON.stringify({ format: 'oezi-arma-profile', version: 1, profile: p }, null, 2);
  }
}

export { PROFILE_SECRET_PATHS };
