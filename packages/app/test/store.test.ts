/**
 * Store birim testleri: Electron safeStorage taklit edilir, gerçek dosya sistemi (geçici klasör) kullanılır.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const enc = vi.hoisted(() => ({ available: true, key: 'K1' }));

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => enc.available,
    encryptString: (s: string) => Buffer.from(`${enc.key}|${Buffer.from(s, 'utf8').toString('hex')}`, 'utf8'),
    decryptString: (b: Buffer) => {
      const t = b.toString('utf8');
      if (!t.startsWith(`${enc.key}|`)) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.');
      return Buffer.from(t.slice(enc.key.length + 1), 'hex').toString('utf8');
    },
  },
}));
// Çekirdeğin derlenmiş dist'i yerine kaynak şemayı kullan
vi.mock('@oezi/arma-core', async () => await import('../../core/src/model/profile.js'));

const { Store, writeAtomic, renameWithRetry } = await import('../src/main/store.js');
const { createProfile } = await import('../../core/src/model/profile.js');
const { isOwnFrame } = await import('../src/main/frameCheck.js');

let dir: string;
const quiet = () => undefined;
const newStore = (o: { appVersion?: string } = {}) => new Store(dir, { log: quiet, ...o });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oezi-store-'));
  enc.available = true;
  enc.key = 'K1';
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const profile = (name: string) => createProfile({ name, hostId: 'local' } as Parameters<typeof createProfile>[0]);

describe('ayarlar', () => {
  it('saveSettings birleştirir (eksik alanlar korunur) ve olay gönderir', () => {
    const s = newStore();
    s.saveSettings({ language: 'en', steamUsername: 'oezi', localSteamcmdPath: 'C:\\steamcmd\\steamcmd.exe' });
    const events: unknown[] = [];
    s.onSettingsChanged = (x) => events.push(x);
    const out = s.saveSettings({ minimizeToTray: false });
    expect(out).toMatchObject({ language: 'en', steamUsername: 'oezi', localSteamcmdPath: 'C:\\steamcmd\\steamcmd.exe', minimizeToTray: false });
    expect(events).toHaveLength(1);
    expect((events[0] as { steamPassword?: string }).steamPassword).toBe('');
    // diskten tekrar okununca da aynı
    expect(newStore().getSettings()).toMatchObject({ language: 'en', steamUsername: 'oezi', minimizeToTray: false });
  });

  it('şifre ayarlanır ve temizlenir; diğer alanlar etkilenmez', () => {
    const s = newStore();
    s.saveSettings({ steamUsername: 'a', steamPassword: 'gizli' });
    expect(newStore().steamPassword()).toBe('gizli');
    s.saveSettings({ clearSteamPassword: true });
    const r = newStore();
    expect(r.steamPassword()).toBe('');
    expect(r.getSettings().steamUsername).toBe('a');
  });
});

describe('secrets.bin', () => {
  it('başlıklı yazar (enc1: / b64:) ve geri okur', () => {
    newStore().saveSettings({ steamPassword: 'p1' });
    expect(fs.readFileSync(path.join(dir, 'secrets.bin')).subarray(0, 5).toString()).toBe('enc1:');
    expect(newStore().steamPassword()).toBe('p1');

    fs.rmSync(path.join(dir, 'secrets.bin'));
    fs.rmSync(path.join(dir, 'secrets.bin.bak'), { force: true });
    enc.available = false;
    const s = newStore();
    expect(s.insecureSecrets).toBe(true);
    s.saveSettings({ steamPassword: 'p2' });
    expect(fs.readFileSync(path.join(dir, 'secrets.bin')).subarray(0, 4).toString()).toBe('b64:');
    expect(newStore().steamPassword()).toBe('p2');
  });

  it('eski başlıksız dosyaları okur (şifreli ve base64)', () => {
    fs.writeFileSync(path.join(dir, 'secrets.bin'), Buffer.from(`K1|${Buffer.from(JSON.stringify({ 'steam:password': 'eski' })).toString('hex')}`));
    expect(newStore().steamPassword()).toBe('eski');
    fs.writeFileSync(path.join(dir, 'secrets.bin'), Buffer.from(JSON.stringify({ 'steam:password': 'b64eski' })).toString('base64'));
    enc.available = false;
    expect(newStore().steamPassword()).toBe('b64eski');
  });

  it('çözülemeyen dosya: kopyalanır, ilgisiz kayıtlar üzerine yazmaz, yeni şifre girilince değiştirilir', () => {
    const s1 = newStore();
    s1.saveSettings({ steamPassword: 'asil' });
    s1.saveHost({ id: 'h1', name: 'vps', host: '1.2.3.4', port: 22, username: 'root', authMethod: 'password', privateKeyPath: '', fingerprint: '', useSudo: false, useSystemd: true, serviceUser: '', steamcmdPath: '', password: 'sshpw' });
    const file = path.join(dir, 'secrets.bin');
    fs.rmSync(`${file}.bak`, { force: true });
    const original = fs.readFileSync(file);

    enc.key = 'K2'; // başka Windows hesabı / anahtarlık değişti
    const s2 = newStore();
    expect(s2.secretsUnreadable).toBe(true);
    expect(s2.secretsBackupFile).toBeTruthy();
    expect(fs.readFileSync(s2.secretsBackupFile!)).toEqual(original);

    // Şifre içermeyen kayıtlar dosyayı ezmez
    s2.saveSettings({ language: 'en' });
    s2.saveProfile({ ...profile('A'), rcon: { ...profile('A').rcon, password: '' } });
    s2.removeHost('h1');
    expect(fs.readFileSync(file)).toEqual(original);
    expect(s2.secretsUnreadable).toBe(true);

    // Anahtar geri gelirse eski şifreler duruyor
    enc.key = 'K1';
    expect(newStore().steamPassword()).toBe('asil');

    // Kullanıcı yeni şifre girince yeni dosya yazılır
    enc.key = 'K2';
    const s3 = newStore();
    s3.saveSettings({ steamPassword: 'yeni' });
    expect(s3.secretsUnreadable).toBe(false);
    expect(newStore().steamPassword()).toBe('yeni');
    // okunamayan eski dosya .bak'a da kopyalanmadı
    expect(fs.existsSync(`${file}.bak`)).toBe(false);
  });
});

describe('data.json dayanıklılığı', () => {
  it('şemaya uymayan profil karantinaya alınır ve olduğu gibi geri yazılır', () => {
    const good = profile('İyi');
    const bad = { id: 'bozuk-1', name: 'Bozuk', network: { port: 'yazı' } };
    fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify({ version: 1, settings: {}, hosts: [], profiles: [good, bad] }));
    const logs: string[] = [];
    const s = new Store(dir, { log: (_l, m) => logs.push(m) });
    expect(s.listProfiles().map((p) => p.name)).toEqual(['İyi']);
    expect(s.quarantinedProfiles()).toEqual([expect.objectContaining({ id: 'bozuk-1', name: 'Bozuk' })]);
    expect(logs.some((l) => l.includes('karantina') && l.includes('bozuk-1'))).toBe(true);

    s.saveProfile(profile('Yeni'));
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'data.json'), 'utf8')) as { profiles: unknown[] };
    expect(raw.profiles).toContainEqual(bad);
    expect(raw.profiles).toHaveLength(3);
  });

  it('sürüm değişince ilk yazmadan önce yedek alınır', () => {
    newStore({ appVersion: '1.0.0' }).saveSettings({ language: 'en' });
    const before = fs.readFileSync(path.join(dir, 'data.json'), 'utf8');
    const s = newStore({ appVersion: '1.1.0' });
    expect(fs.existsSync(path.join(dir, 'data.json.bak-1.0.0'))).toBe(false);
    s.saveSettings({ language: 'tr' });
    expect(fs.readFileSync(path.join(dir, 'data.json.bak-1.0.0'), 'utf8')).toBe(before);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'data.json'), 'utf8')).appVersion).toBe('1.1.0');
  });

  it('boş/bozuk data.json yerine .bak yüklenir', () => {
    const s = newStore();
    s.saveProfile(profile('Bir'));
    s.saveProfile(profile('İki')); // önceki hâl (sadece "Bir") .bak olur
    fs.writeFileSync(path.join(dir, 'data.json'), ''); // elektrik kesintisi
    expect(newStore().listProfiles().map((p) => p.name)).toEqual(['Bir']);

    fs.writeFileSync(path.join(dir, 'data.json'), '{"version":1,"profi');
    expect(newStore().listProfiles().map((p) => p.name)).toEqual(['Bir']);
    expect(fs.readdirSync(dir).some((n) => n.startsWith('data.json.broken-'))).toBe(true);
  });

  it('başlangıçta artık .tmp dosyaları temizlenir', () => {
    fs.writeFileSync(path.join(dir, 'data.json.0a1b2c3d.tmp'), 'x');
    fs.writeFileSync(path.join(dir, 'secrets.bin.deadbeef.tmp'), 'x');
    fs.writeFileSync(path.join(dir, 'baska.tmp'), 'x');
    newStore();
    expect(fs.readdirSync(dir).sort()).toEqual(['baska.tmp']);
  });

  it('yazma başarısız olursa bellekteki değişiklik geri alınır ve anlaşılır hata verilir', () => {
    const s = newStore();
    s.saveProfile(profile('Kalıcı'));
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    });
    expect(() => s.saveProfile(profile('Kaybolacak'))).toThrow(/kaydedilemedi.*geri alındı/);
    expect(s.listProfiles().map((p) => p.name)).toEqual(['Kalıcı']);
    spy.mockRestore();
    expect(newStore().listProfiles().map((p) => p.name)).toEqual(['Kalıcı']);
    expect(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });
});

describe('writeAtomic / renameWithRetry', () => {
  it('EPERM/EBUSY hatasında tekrar dener', () => {
    let calls = 0;
    const real = fs.renameSync;
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation((a, b) => {
      if (++calls < 3) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      return real(a, b);
    });
    const f = path.join(dir, 'x.json');
    writeAtomic(f, '{"a":1}', { retry: true });
    expect(calls).toBe(3);
    expect(fs.readFileSync(f, 'utf8')).toBe('{"a":1}');
    spy.mockRestore();
  });

  it('tekrar denemesi kapalıyken ya da başka hatada hemen fırlatır', () => {
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    expect(() => renameWithRetry('a', 'b', true)).toThrow('ENOENT');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('önceki geçerli dosyayı .bak olarak saklar', () => {
    const f = path.join(dir, 'y.json');
    writeAtomic(f, '{"v":1}');
    writeAtomic(f, '{"v":2}');
    expect(fs.readFileSync(`${f}.bak`, 'utf8')).toBe('{"v":1}');
  });
});

describe('isOwnFrame', () => {
  it('8.3 kısa yol ve özel karakterli yollarda kendi sayfasını tanır', () => {
    const win = 'C:\\Users\\HALITH~1\\AppData\\Local\\Temp\\2abc[1]\\resources\\app.asar\\dist\\renderer\\index.html';
    if (process.platform === 'win32') {
      expect(isOwnFrame(pathToFileURL(win).href, win, null)).toBe(true);
    }
    const posix = '/tmp/a~b/[x]/%y/dist/renderer/index.html';
    const encoded = pathToFileURL(posix).href;
    expect(isOwnFrame(encoded, posix, null, 'linux')).toBe(true);
    expect(isOwnFrame(`${encoded}#/server/1`, posix, null, 'linux')).toBe(true);
    // Chromium'un kodlamadığı ~ ve [ ] karakterleri
    expect(isOwnFrame('file:///tmp/a~b/%5Bx%5D/%25y/dist/renderer/index.html', posix, null, 'linux')).toBe(true);
    expect(isOwnFrame('file:///tmp/evil.html', posix, null, 'linux')).toBe(false);
    expect(isOwnFrame('https://example.com/', posix, null, 'linux')).toBe(false);
  });

  it('geliştirme sunucusu: sadece aynı origin', () => {
    expect(isOwnFrame('http://localhost:5173/#/x', '/x/index.html', 'http://localhost:5173/')).toBe(true);
    expect(isOwnFrame('http://localhost:5174/', '/x/index.html', 'http://localhost:5173/')).toBe(false);
    expect(isOwnFrame('http://localhost:5173.evil.com/', '/x/index.html', 'http://localhost:5173')).toBe(false);
  });
});
