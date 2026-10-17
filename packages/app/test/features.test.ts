/**
 * Yeni ana süreç özellikleri: performans geçmişi kalıcılığı, oyuncu geçmişi bağlantısı,
 * zamanlı yedek tekrar engeli, her yerde banla doğrulaması (Electron taklit).
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
const { AppServices, isBanTarget } = await import('../src/main/services.js');
const { loadMetrics, saveMetrics, metricsFile, historyFile, JsonlHistoryStorage } = await import('../src/main/perProfileFiles.js');
const { BackupScheduleTracker } = await import('../src/main/backupSchedule.js');

type Svc = InstanceType<typeof AppServices>;
type AnyEvent = { type: string; profileId?: string; sample?: unknown };

let dir: string;
let dataDir: string;
let svc: Svc;
let events: AnyEvent[];

const makeSvc = () => new AppServices(new Store(dataDir, { log: () => undefined }), (e) => events.push(e as AnyEvent));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oezi-feat-'));
  dataDir = path.join(dir, 'data');
  events = [];
  svc = makeSvc();
});
afterEach(async () => {
  await svc.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('performans geçmişi', () => {
  it('dosyaya yazılır, yeni yöneticiye geri yüklenir, profil silinince dosya da silinir', async () => {
    const p = svc.createProfile({ name: 'M', hostId: 'local', paths: { serverDir: path.join(dir, 'srv') } });
    const now = Date.now();
    const samples = [
      { t: now - 120_000, fps: 40, players: 3 },
      { t: now - 60_000, fps: 45, players: 4, cpu: 12.5, memMB: 2048 },
    ];
    await svc.shutdown();
    saveMetrics(dataDir, p.id, { v: 1, samples });
    expect(loadMetrics(dataDir, p.id)?.samples).toHaveLength(2);

    // Yeni servis: kayıtlı geçmişle başlar
    svc = makeSvc();
    (svc as unknown as { createManager: (x: unknown) => void }).createManager((svc as unknown as { store: { getProfile: (id: string) => unknown } }).store.getProfile(p.id));
    const got = svc.metrics(p.id);
    expect(got.map((s) => s.fps)).toEqual([40, 45]);
    expect(svc.metrics(p.id, now - 90_000).map((s) => s.fps)).toEqual([45]);

    // 'metrics' olayı arayüze iletilir
    const sample = { t: now, fps: 50 };
    svc.manager(p.id).emit('metrics', sample);
    expect(events).toContainEqual({ type: 'metrics', profileId: p.id, sample });

    // Kapanışta kaydedilir (bozuk dosya yerine yenisi)
    fs.writeFileSync(metricsFile(dataDir, p.id), '{bozuk');
    svc.saveAllMetrics();
    expect(loadMetrics(dataDir, p.id)?.samples.map((s) => s.fps)).toEqual([40, 45]);

    await svc.removeProfile(p.id);
    expect(fs.existsSync(metricsFile(dataDir, p.id))).toBe(false);
  });

  it('boş geçmiş için dosya oluşturulmaz; bozuk dosya null döner', () => {
    saveMetrics(dataDir, 'x', { v: 1, samples: [] });
    expect(fs.existsSync(metricsFile(dataDir, 'x'))).toBe(false);
    fs.mkdirSync(path.dirname(metricsFile(dataDir, 'y')), { recursive: true });
    fs.writeFileSync(metricsFile(dataDir, 'y'), 'nope');
    expect(loadMetrics(dataDir, 'y')).toBeNull();
    expect(metricsFile(dataDir, '../evil')).toBe(path.join(dataDir, 'metrics', '___evil.json'));
  });
});

describe('oyuncu geçmişi', () => {
  it('RCON mesajları, oyuncu listesi ve durma geçmişe işlenir; olay kısılır; dosya kalıcı', async () => {
    const p = svc.createProfile({ name: 'H', hostId: 'local', paths: { serverDir: path.join(dir, 'srv') } });
    const m = svc.manager(p.id);
    const guid = 'ABCDEF0123456789abcdef0123456789';
    m.emit('rconMessage', 'Player #0 Ali Veli (1.2.3.4:2304) connected');
    m.emit('rconMessage', `Verified GUID (${guid}) of player #0 Ali Veli`);
    m.emit('rconMessage', '(Global) Ali Veli: selam'); // sohbet: değişiklik yok
    await wait(50);
    let found = await svc.historySearch(p.id, { text: 'ali' });
    expect(found).toHaveLength(1);
    expect(found[0]!.guid).toBe(guid.toLowerCase());
    expect(found[0]!.online).toBe(true);
    expect(found[0]!.ips).toEqual(['1.2.3.4']);
    // İlk değişiklik hemen, sonrakiler 2 sn içinde tek olay
    expect(events.filter((e) => e.type === 'history-changed')).toHaveLength(1);

    // Oyuncu listesi: yeni oyuncu eklenir
    m.emit('players', [
      { id: 0, ip: '1.2.3.4', port: 2304, ping: 30, guid: guid.toLowerCase(), verified: true, name: 'Ali Veli', lobby: false },
      { id: 1, ip: '5.6.7.8', port: 2304, ping: 40, guid: 'f'.repeat(32), verified: true, name: 'Ayşe', lobby: false },
    ] as never);
    await wait(20);
    expect((await svc.historySearch(p.id, {})).map((x) => x.name).sort()).toEqual(['Ali Veli', 'Ayşe']);

    // Not
    await svc.historySetNote(p.id, guid, 'şüpheli');
    expect((await svc.historySearch(p.id, { text: 'SUPHELI' }))[0]?.guid).toBe(guid.toLowerCase());

    // Çalışıyor -> durdu: açık oturumlar kapanır
    m.emit('status', { status: 'running', mode: 'direct', autoRestarts: 0, headless: [], rcon: 'connected', players: 2 });
    m.emit('status', { status: 'stopped', mode: 'direct', autoRestarts: 0, headless: [], rcon: 'disconnected', players: 0 });
    await wait(20);
    found = await svc.historySearch(p.id, {});
    expect(found.every((x) => !x.online)).toBe(true);
    const sessions = await svc.historySessions(p.id, guid);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.leaveAt).toBeDefined();
    expect((await svc.historyStats(p.id, 0)).uniquePlayers).toBe(2);

    // Kısılmış olay en geç 2 sn sonra gelir
    await wait(2100);
    expect(events.filter((e) => e.type === 'history-changed').length).toBe(2);

    // Kapanışta flush; yeni servis dosyadan okur
    await svc.shutdown();
    const file = historyFile(dataDir, p.id);
    expect(fs.readFileSync(file, 'utf8').trim().split('\n').length).toBeGreaterThan(3);
    svc = makeSvc();
    const again = await svc.historySearch(p.id, { text: guid });
    expect(again[0]?.note).toBe('şüpheli');
    expect(again[0]?.sessionCount).toBe(1);

    await svc.removeProfile(p.id);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('JSONL depo: yarım satır yok sayılır, yeniden yazma atomik', async () => {
    const file = path.join(dir, 'h', 'x.jsonl');
    const st = new JsonlHistoryStorage(file);
    expect(await st.readAll()).toEqual([]);
    await st.append('{"a":1}');
    await st.append('{"b":2}');
    fs.appendFileSync(file, '\r\n\n');
    expect(await st.readAll()).toEqual(['{"a":1}', '{"b":2}']);
    st.rewrite(['{"c":3}']);
    expect(await st.readAll()).toEqual(['{"c":3}']);
  });
});

describe('zamanlı yedek', () => {
  it('aynı gün + saat için bir kez; başka saat / gün tekrar', () => {
    const t = new BackupScheduleTracker();
    const at = (h: number, m: number, s = 0, d = 17) => new Date(2026, 9, d, h, m, s);
    expect(t.due('p', ['04:30', '16:00'], at(4, 29, 50))).toEqual([]);
    expect(t.due('p', ['04:30', '16:00'], at(4, 30, 5))).toEqual(['04:30']);
    expect(t.due('p', ['04:30', '16:00'], at(4, 30, 35))).toEqual([]);
    expect(t.due('q', ['04:30'], at(4, 30, 40))).toEqual(['04:30']);
    // Kaçırılan dakika telafi edilmez
    expect(t.due('p', ['04:30', '16:00'], at(4, 31, 0))).toEqual([]);
    expect(t.due('p', ['04:30', '16:00'], at(16, 0, 1))).toEqual(['16:00']);
    expect(t.due('p', ['04:30'], at(4, 30, 5, 18))).toEqual(['04:30']);
    t.forget('p');
    expect(t.due('p', ['04:30'], at(4, 30, 20, 18))).toEqual(['04:30']);
  });

  it('servis zamanlayıcısı yedeği bir kez başlatır; kapalı profil atlanır; sıradaki zaman', () => {
    const on = svc.createProfile({ name: 'B1', hostId: 'local', paths: { serverDir: path.join(dir, 'a') }, backup: { enabled: true, times: ['04:30'] } });
    svc.createProfile({ name: 'B2', hostId: 'local', paths: { serverDir: path.join(dir, 'b') }, backup: { enabled: false, times: ['04:30'] } });
    const spy = vi.spyOn(svc, 'backupJob').mockReturnValue('job');
    svc.backupTick(new Date(2026, 9, 17, 4, 30, 1));
    svc.backupTick(new Date(2026, 9, 17, 4, 30, 31));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(on.id, true);
    expect(svc.nextBackup(on.id, new Date(2026, 9, 17, 4, 31))).toBe(new Date(2026, 9, 18, 4, 30).getTime());
  });

  it('aynı profil için ikinci yedek reddedilir; uzak makinede klasör açılmaz', async () => {
    const p = svc.createProfile({ name: 'B3', hostId: 'local', paths: { serverDir: path.join(dir, 'c') } });
    const startJob = (svc as unknown as { startJob: (t: string, s: object, fn: () => Promise<void>) => string }).startJob.bind(svc);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const id = startJob('Yedek: B3', { profileId: p.id, nonBlocking: true }, () => gate);
    (svc as unknown as { backupJobs: Map<string, string> }).backupJobs.set(p.id, id);
    expect(() => svc.backupJob(p.id)).toThrow(/zaten bir yedekleme/);
    // Yedek sunucu başlatmayı engellemez ama silmeyi engeller
    await expect(svc.removeProfile(p.id)).rejects.toThrow(/yedekleme sürüyor/);
    release();
    await wait(10);
    expect(svc.localBackupDir(p.id)).toBe(path.join(dir, 'oezi-backups', p.id.replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toLowerCase()));
  });
});

describe('her yerde banla', () => {
  it('GUID / IPv4 doğrulaması', () => {
    expect(isBanTarget('0123456789abcdef0123456789ABCDEF')).toBe(true);
    expect(isBanTarget('1.2.3.4')).toBe(true);
    expect(isBanTarget('255.255.255.255')).toBe(true);
    expect(isBanTarget('256.1.1.1')).toBe(false);
    expect(isBanTarget('1.2.3')).toBe(false);
    expect(isBanTarget('0123456789abcdef0123456789abcde')).toBe(false);
    expect(isBanTarget('g123456789abcdef0123456789abcdef')).toBe(false);
    expect(isBanTarget('1.2.3.4; #shutdown')).toBe(false);
  });

  it('sadece RCON bağlı sunucularda banlar, sonuçları döner', async () => {
    const a = svc.createProfile({ name: 'A', hostId: 'local' });
    const b = svc.createProfile({ name: 'B', hostId: 'local' });
    svc.createProfile({ name: 'C', hostId: 'local' }); // RCON yok
    const calls: string[] = [];
    (svc.manager(a.id) as unknown as { rcon: unknown }).rcon = { state: 'connected', addBan: async (v: string, m: number, r: string) => void calls.push(`${v} ${m} ${r}`) };
    (svc.manager(b.id) as unknown as { rcon: unknown }).rcon = {
      state: 'connected',
      addBan: async () => {
        throw new Error('zaman aşımı');
      },
    };
    await expect(svc.banEverywhere('kötü', 0, '')).rejects.toThrow(/Geçersiz hedef/);
    const res = await svc.banEverywhere('ABCDEF0123456789ABCDEF0123456789', 60, 'hile');
    expect(calls).toEqual(['abcdef0123456789abcdef0123456789 60 hile']);
    expect(res).toEqual([
      { profileId: a.id, name: 'A', ok: true },
      { profileId: b.id, name: 'B', ok: false, error: 'zaman aşımı' },
    ]);
    (svc.manager(a.id) as unknown as { rcon: unknown }).rcon = null;
    (svc.manager(b.id) as unknown as { rcon: unknown }).rcon = null;
  });
});

describe('Discord mesaj kimliği', () => {
  it('kimlik kaydedilir; kullanıcı kaydı kimliği ezmez; kopyada sıfırlanır', async () => {
    const p = svc.createProfile({ name: 'D', hostId: 'local' });
    (svc as unknown as { persistDiscordMessageId: (id: string, m: string) => void }).persistDiscordMessageId(p.id, '123456789');
    await wait(10);
    expect(svc.getProfile(p.id).discordStatus.messageId).toBe('123456789');
    expect(svc.manager(p.id).getProfile().discordStatus.messageId).toBe('123456789');
    expect(events.some((e) => e.type === 'profiles-changed')).toBe(true);
    const stale = { ...svc.getProfile(p.id), discordStatus: { ...svc.getProfile(p.id).discordStatus, messageId: '' } };
    await svc.saveProfile(stale);
    expect(svc.getProfile(p.id).discordStatus.messageId).toBe('123456789');
    expect(svc.duplicateProfile(p.id).discordStatus.messageId).toBe('');
    await expect(svc.refreshDiscordStatus(p.id)).rejects.toThrow(/kapalı/);
  });
});

describe('açılışta otomatik başlatma', () => {
  it('sadece işaretli ve kapalı sunucular, servis başlatma yolu üzerinden', async () => {
    const a = svc.createProfile({ name: 'Oto', hostId: 'local', paths: { serverDir: path.join(dir, 'oa') }, autoStartOnLaunch: true });
    svc.createProfile({ name: 'Elle', hostId: 'local', paths: { serverDir: path.join(dir, 'ob') } });
    await svc.shutdown();
    svc = makeSvc();
    await svc.init();
    const spy = vi.spyOn(svc, 'startServer').mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('x'));
    await svc.autoStartOnLaunch(0);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(a.id);
  });
});
