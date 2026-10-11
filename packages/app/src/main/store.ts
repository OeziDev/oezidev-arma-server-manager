import { safeStorage } from 'electron';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ServerProfileSchema, type ServerProfile } from '@oezi/arma-core';
import type { AppSettings, HostConfig } from '../shared/api.js';

/**
 * Kalıcı veri: profiller, SSH makineleri, ayarlar (data.json) ve şifreler (secrets.bin).
 * Şifreler Electron safeStorage ile şifrelenir: Windows'ta DPAPI (kullanıcı hesabına bağlı),
 * Linux'ta sistem anahtarlığı. Profil dosyasında şifre alanları boş tutulur.
 */

const PROFILE_SECRET_PATHS = [
  'general.password',
  'general.passwordAdmin',
  'general.serverCommandPassword',
  'rcon.password',
  'steam.branchPassword',
  'notifications.discordWebhook',
] as const;

interface DataFile {
  version: 1;
  settings: Omit<AppSettings, 'steamPassword' | 'hasSteamPassword'>;
  hosts: Omit<HostConfig, 'password' | 'passphrase' | 'hasPassword'>[];
  profiles: ServerProfile[];
}

const DEFAULT_SETTINGS: DataFile['settings'] = {
  language: 'tr',
  minimizeToTray: true,
  localSteamcmdPath: '',
  steamUsername: '',
};

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

function writeAtomic(file: string, data: string | Buffer) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

export class Store {
  private data: DataFile;
  private secrets: Record<string, string> = {};
  readonly insecureSecrets: boolean;
  private readonly dataFile: string;
  private readonly secretsFile: string;

  constructor(readonly dir: string) {
    this.dataFile = path.join(dir, 'data.json');
    this.secretsFile = path.join(dir, 'secrets.bin');
    this.insecureSecrets = !safeStorage.isEncryptionAvailable();
    this.data = this.loadData();
    this.secrets = this.loadSecrets();
  }

  private loadData(): DataFile {
    try {
      const raw = JSON.parse(fs.readFileSync(this.dataFile, 'utf8')) as Partial<DataFile>;
      const profiles: ServerProfile[] = [];
      for (const p of raw.profiles ?? []) {
        const res = ServerProfileSchema.safeParse(p);
        if (res.success) profiles.push(res.data);
      }
      return {
        version: 1,
        settings: { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) },
        hosts: Array.isArray(raw.hosts) ? raw.hosts : [],
        profiles,
      };
    } catch (err) {
      if (fs.existsSync(this.dataFile)) {
        // Bozuk dosyayı kenara al, kaybetme
        fs.copyFileSync(this.dataFile, `${this.dataFile}.broken-${Date.now()}`);
        console.error('data.json okunamadı:', err);
      }
      return { version: 1, settings: { ...DEFAULT_SETTINGS }, hosts: [], profiles: [] };
    }
  }

  private loadSecrets(): Record<string, string> {
    try {
      const buf = fs.readFileSync(this.secretsFile);
      const text = this.insecureSecrets ? Buffer.from(buf.toString('utf8'), 'base64').toString('utf8') : safeStorage.decryptString(buf);
      const obj = JSON.parse(text) as Record<string, string>;
      return obj && typeof obj === 'object' ? obj : {};
    } catch {
      return {};
    }
  }

  private persist() {
    writeAtomic(this.dataFile, JSON.stringify(this.data, null, 2));
  }

  private persistSecrets() {
    const text = JSON.stringify(this.secrets);
    const buf = this.insecureSecrets ? Buffer.from(Buffer.from(text, 'utf8').toString('base64'), 'utf8') : safeStorage.encryptString(text);
    writeAtomic(this.secretsFile, buf);
  }

  private setSecret(key: string, value: string | undefined) {
    if (value) this.secrets[key] = value;
    else delete this.secrets[key];
  }

  getSecret(key: string): string {
    return this.secrets[key] ?? '';
  }

  /* ---------------- ayarlar ---------------- */

  getSettings(): AppSettings {
    return { ...this.data.settings, steamPassword: '', hasSteamPassword: !!this.secrets['steam:password'] };
  }

  saveSettings(s: AppSettings): AppSettings {
    const { steamPassword, hasSteamPassword: _h, clearSteamPassword, ...rest } = s;
    this.data.settings = {
      language: rest.language === 'en' ? 'en' : 'tr',
      minimizeToTray: !!rest.minimizeToTray,
      localSteamcmdPath: String(rest.localSteamcmdPath ?? ''),
      steamUsername: String(rest.steamUsername ?? ''),
    };
    if (steamPassword) this.setSecret('steam:password', steamPassword);
    if (clearSteamPassword) this.setSecret('steam:password', undefined);
    this.persist();
    this.persistSecrets();
    return this.getSettings();
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
    const { password, passphrase, hasPassword: _hp, ...rest } = h;
    const idx = this.data.hosts.findIndex((x) => x.id === h.id);
    if (idx >= 0) this.data.hosts[idx] = rest;
    else this.data.hosts.push(rest);
    if (password) this.setSecret(`host:${h.id}:password`, password);
    if (passphrase) this.setSecret(`host:${h.id}:passphrase`, passphrase);
    if (h.authMethod === 'key') this.setSecret(`host:${h.id}:password`, undefined);
    this.persist();
    this.persistSecrets();
    return this.getHost(h.id)!;
  }

  removeHost(id: string) {
    this.data.hosts = this.data.hosts.filter((h) => h.id !== id);
    this.setSecret(`host:${id}:password`, undefined);
    this.setSecret(`host:${id}:passphrase`, undefined);
    this.persist();
    this.persistSecrets();
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
    this.persist();
    this.persistSecrets();
    return this.getProfile(p.id)!;
  }

  removeProfile(id: string) {
    this.data.profiles = this.data.profiles.filter((p) => p.id !== id);
    for (const sp of PROFILE_SECRET_PATHS) this.setSecret(`profile:${id}:${sp}`, undefined);
    this.persist();
    this.persistSecrets();
  }

  /** Dışa aktarma: şifreler hariç */
  exportProfile(id: string): string {
    const p = this.data.profiles.find((x) => x.id === id);
    if (!p) throw new Error('Profil bulunamadı');
    return JSON.stringify({ format: 'oezi-arma-profile', version: 1, profile: p }, null, 2);
  }
}

export { PROFILE_SECRET_PATHS };
