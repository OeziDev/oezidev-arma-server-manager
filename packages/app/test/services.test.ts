/**
 * AppServices birim testleri (Electron taklit; yerel makine + geçici klasörler).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
}));
vi.mock('@oezi/arma-core', async () => await import('../../core/src/index.js'));

const { Store } = await import('../src/main/store.js');
const { AppServices } = await import('../src/main/services.js');
const { LazySshHost } = await import('../src/main/lazyHost.js');

type Svc = InstanceType<typeof AppServices>;
type AnyEvent = { type: string; notice?: { level: string; message: { tr: string } } };

let dir: string;
let svc: Svc;
let events: AnyEvent[];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oezi-svc-'));
  events = [];
  svc = new AppServices(new Store(path.join(dir, 'data'), { log: () => undefined }), (e) => events.push(e as AnyEvent));
});
afterEach(async () => {
  await svc.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

const hostCfg = (keyPath: string) => ({
  id: '',
  name: 'vps',
  host: '127.0.0.1',
  port: 22,
  username: 'arma',
  authMethod: 'key' as const,
  privateKeyPath: keyPath,
  fingerprint: '',
  useSudo: false,
  useSystemd: true,
  serviceUser: '',
  steamcmdPath: '',
});

describe('SSH makinesi', () => {
  it('anahtar dosyası okunamazsa yerel makineye düşmez; dosya gelince yeniden kurulur', async () => {
    const key = path.join(dir, 'id_ed25519');
    const h = svc.saveHost(hostCfg(key));
    const p = svc.createProfile({ name: 'Uzak', hostId: h.id, paths: { serverDir: '/srv/arma' } });
    const m = svc.manager(p.id);
    expect(m.host.kind).toBe('ssh');
    expect(m.host).toBeInstanceOf(LazySshHost);
    await expect(m.host.connect()).rejects.toThrow(/anahtar dosyası okunamadı/);
    fs.writeFileSync(key, 'dummy');
    expect(() => (m.host as InstanceType<typeof LazySshHost>).get()).not.toThrow();
  });
});

describe('iş çakışmaları', () => {
  it('bir iş sürerken başlatma/dağıtma/güncelleme reddedilir; makine kaydı da', async () => {
    const serverDir = path.join(dir, 'server');
    const p = svc.createProfile({ name: 'A', hostId: 'local', paths: { serverDir } });
    const twin = svc.createProfile({ name: 'B', hostId: 'local', paths: { serverDir: serverDir + path.sep } });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const startJob = (svc as unknown as { startJob: (t: string, s: object, fn: () => Promise<void>) => string }).startJob.bind(svc);
    startJob('Test işi', { profileId: p.id, hostId: 'local', serverDir }, () => gate);

    await expect(svc.startServer(p.id)).rejects.toThrow(/devam eden bir iş/);
    await expect(svc.deployServer(p.id)).rejects.toThrow(/devam eden bir iş/);
    // aynı sunucu klasörünü kullanan diğer profil de
    await expect(svc.startServer(twin.id)).rejects.toThrow(/devam eden bir iş/);
    expect(() => svc.updateServerJob(p.id)).toThrow(/devam eden bir iş/);
    expect(() => svc.syncWorkshopJob(p.id)).toThrow(/devam eden bir iş/);
    await expect(svc.removeProfile(p.id)).rejects.toThrow(/devam eden bir iş/);
    expect(svc.activeWork().jobs).toEqual(['Test işi']);

    release();
    await svc.abortAllJobs(1000);
    expect(svc.activeWork().jobs).toEqual([]);
  });

  it('abortAllJobs işleri iptal eder ve bitmelerini bekler', async () => {
    const startJob = (svc as unknown as { startJob: (t: string, s: object, fn: (j: { abort: AbortController }) => Promise<void>) => string }).startJob.bind(svc);
    startJob('Uzun iş', {}, (job) => new Promise<void>((resolve) => job.abort.signal.addEventListener('abort', () => setTimeout(resolve, 50))));
    await svc.abortAllJobs(2000);
    expect(svc.listJobs()[0]?.status).toBe('cancelled');
  });

  it('SteamCMD kilidi aynı makine + steamcmd için çalıştırmaları sıraya koyar', async () => {
    const lock = (svc as unknown as { withSteamLock: <T>(k: string, s: AbortSignal | undefined, log: (l: string) => void, fn: () => Promise<T>) => Promise<T> }).withSteamLock.bind(svc);
    const order: string[] = [];
    const logs: string[] = [];
    const run = (name: string, ms: number) =>
      lock('local|/steamcmd.sh', undefined, (l) => logs.push(`${name}: ${l}`), async () => {
        order.push(`${name}+`);
        await new Promise((r) => setTimeout(r, ms));
        order.push(`${name}-`);
      });
    await Promise.all([run('a', 40), run('b', 5), run('c', 5)]);
    expect(order).toEqual(['a+', 'a-', 'b+', 'b-', 'c+', 'c-']);
    expect(logs.some((l) => l.startsWith('b:') && l.includes('bekleniyor'))).toBe(true);

    // beklerken iptal
    const ac = new AbortController();
    const first = run('d', 30);
    const second = lock('local|/steamcmd.sh', ac.signal, () => undefined, async () => 'çalışmamalı');
    ac.abort();
    await expect(second).rejects.toThrow(/İptal/);
    await first;
  });

  it('göreli SteamCMD kurulum klasörü ve boş sunucu klasörü reddedilir', async () => {
    expect(() => svc.installSteamCmdJob('local', 'steamcmd')).toThrow(/mutlak/);
    const p = svc.createProfile({ name: 'Boş', hostId: 'local' });
    await expect(svc.uploadMission(p.id, '/tmp/x.pbo')).rejects.toThrow(/sunucu klasörünü seç/);
  });
});

describe('profil kaydında kaldırılan Workshop modları', () => {
  const ws = (id: string, folder: string) => ({ path: folder, source: 'workshop' as const, workshopId: id, enabled: true, displayName: folder });

  it('bağlantı kaldırılır; başka profil kullanıyorsa bırakılır', async () => {
    if (process.platform === 'win32') return;
    const serverDir = path.join(dir, 'server');
    const content = path.join(dir, 'oezi-workshop', 'steamapps', 'workshop', 'content', '107410');
    for (const id of ['111', '222']) fs.mkdirSync(path.join(content, id), { recursive: true });
    fs.mkdirSync(serverDir, { recursive: true });
    fs.symlinkSync(path.join(content, '111'), path.join(serverDir, '@cba'));
    fs.symlinkSync(path.join(content, '222'), path.join(serverDir, '@ace'));

    const a = svc.createProfile({ name: 'A', hostId: 'local', paths: { serverDir } });
    let r = await svc.saveProfile({ ...a, launch: { ...a.launch, mods: [ws('111', '@cba'), ws('222', '@ace')] } });
    const b = svc.createProfile({ name: 'B', hostId: 'local', paths: { serverDir } });
    await svc.saveProfile({ ...svc.getProfile(b.id), launch: { ...b.launch, mods: [ws('222', '@ace')] } });

    r = await svc.saveProfile({ ...r.profile!, launch: { ...r.profile!.launch, mods: [] } });
    expect(r.errors).toEqual([]);
    expect(fs.existsSync(path.join(serverDir, '@cba'))).toBe(false);
    expect(fs.lstatSync(path.join(serverDir, '@ace')).isSymbolicLink()).toBe(true);
    const texts = events.filter((e) => e.type === 'notice').map((e) => e.notice!.message.tr);
    expect(texts.some((t) => t.includes('silindi') && t.includes('@cba'))).toBe(true);
    expect(texts.some((t) => t.includes('bırakıldı') && t.includes('@ace'))).toBe(true);
  });
});
