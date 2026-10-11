import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalHost } from '../src/host/local.js';
import { createProfile, type ServerProfileInput } from '../src/model/profile.js';
import { ServerManager, type StatusInfo, ValidationFailedError } from '../src/supervisor/manager.js';
import { dueWarning, nextOccurrence } from '../src/supervisor/scheduler.js';
import type { Notifier } from '../src/notify/discord.js';
import { FakeRconServer } from './fakeRcon.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn: () => boolean | Promise<boolean>, timeoutMs = 10000, label = '') {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await sleep(100);
  }
  throw new Error(`zaman aşımı ${label}`);
}

/**
 * Arma sunucusu taklidi: argümanları yazar, kontrol dosyalarına göre kapanır/çöker.
 * - fatal.txt: içeriğini yazar (config hatası gibi), sonra Windows'taki hata penceresi gibi açık kalır
 * - noready.flag: "Host identity created" yazmaz (hazır olmaz)
 * - ignoreterm.flag: SIGTERM'i yok sayar (kibar kapatmaya cevap vermeyen hata penceresi)
 * - hcignoreterm.flag: headless client SIGTERM'i yok sayar (kapatılması uzun sürer)
 */
const FAKE_ARMA = `#!/bin/bash
echo "FAKE ARMA $*"
dir="$(pwd)"
trap 'echo "TERM"; exit 0' TERM
if [[ "$*" != *-client* ]]; then
  [ -f "$dir/ignoreterm.flag" ] && trap '' TERM
  [ -f "$dir/fatal.txt" ] && cat "$dir/fatal.txt"
  [ -f "$dir/noready.flag" ] || echo "12:00:01 Host identity created."
else
  [ -f "$dir/hcignoreterm.flag" ] && trap '' TERM
fi
while true; do
  if [ -f "$dir/crash.flag" ] && [[ "$*" != *-client* ]]; then rm -f "$dir/crash.flag"; echo "CRASH"; exit 1; fi
  if [ -f "$dir/shutdown.flag" ] && [[ "$*" != *-client* ]]; then rm -f "$dir/shutdown.flag"; echo "SHUTDOWN"; exit 0; fi
  sleep 0.1
done
`;

const managers: ServerManager[] = [];
const servers: FakeRconServer[] = [];
afterEach(async () => {
  for (const m of managers.splice(0)) {
    await m.stop().catch(() => undefined);
    m.dispose();
  }
  servers.splice(0).forEach((s) => s.close());
});

function makeServerDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oezi-mgr-'));
  fs.writeFileSync(path.join(dir, 'arma3server_x64'), FAKE_ARMA, { mode: 0o755 });
  return dir;
}

async function setup(input: ServerProfileInput = {}, notifier?: Notifier) {
  const dir = makeServerDir();
  const rcon = new FakeRconServer('RconSifresi123');
  const port = await rcon.start();
  servers.push(rcon);
  rcon.handlers.set('#shutdown', '');
  const profile = createProfile({
    name: 'Test',
    ...input,
    paths: { serverDir: dir, ...(input.paths ?? {}) },
    general: { passwordAdmin: 'uzun-admin-sifresi', ...(input.general ?? {}) },
    missions: { rotation: [{ template: 'test.altis' }] },
    rcon: { password: 'RconSifresi123', port, connectHost: '127.0.0.1', ...(input.rcon ?? {}) },
    supervisor: { restartDelaySec: 0, gracefulShutdownSec: 3, ...(input.supervisor ?? {}) },
  });
  const host = new LocalHost();
  const statuses: string[] = [];
  const mgr = new ServerManager({
    profile,
    host,
    notifier: notifier ?? null,
    timers: { monitorMs: 200, runningAfterMs: 300, rconDelayMs: 100, playersMs: 300, stopTimeoutMs: 3000, schedulerMs: 3_600_000 },
  });
  mgr.on('status', (s: StatusInfo) => statuses.push(s.status));
  managers.push(mgr);
  return { dir, rcon, mgr, statuses, profile };
}

describe('zamanlayıcı hesapları', () => {
  it('bir sonraki restart zamanı', () => {
    const now = new Date(2026, 9, 11, 13, 30);
    expect(nextOccurrence(['06:00', '18:00'], now)).toEqual(new Date(2026, 9, 11, 18, 0));
    expect(nextOccurrence(['06:00'], now)).toEqual(new Date(2026, 9, 12, 6, 0));
    expect(nextOccurrence([], now)).toBeNull();
  });
  it('kaçırılan uyarılardan sadece en yakını gönderilir', () => {
    const next = new Date(2026, 9, 11, 18, 0);
    const sent = new Set<number>();
    expect(dueWarning(next, new Date(2026, 9, 11, 17, 40), [15, 10, 5, 1], sent)).toBeNull();
    expect(dueWarning(next, new Date(2026, 9, 11, 17, 52, 30), [15, 10, 5, 1], sent)).toBe(8);
    expect(sent).toEqual(new Set([15, 10]));
    expect(dueWarning(next, new Date(2026, 9, 11, 17, 53), [15, 10, 5, 1], sent)).toBeNull();
    expect(dueWarning(next, new Date(2026, 9, 11, 17, 59, 30), [15, 10, 5, 1], sent)).toBe(1);
  });
});

describe('ServerManager (doğrudan mod, yerel)', () => {
  it('config dosyalarını yazar, başlatır, RCON\'a bağlanır, RCON ile nazikçe kapatır', async () => {
    const { dir, rcon, mgr, statuses } = await setup({
      launch: { mods: [{ path: '@cba_a3' }], serverMods: [{ path: '@extdb3' }] },
    });
    // RCON #shutdown gelince sunucu kapanır
    const origReply = rcon.handlers;
    origReply.set('#shutdown', '');
    const iv = setInterval(() => {
      if (rcon.received.includes('#shutdown') && !fs.existsSync(path.join(dir, 'shutdown.flag'))) {
        fs.writeFileSync(path.join(dir, 'shutdown.flag'), '');
        rcon.received.push('handled');
      }
    }, 50);
    try {
      await mgr.start();
      const rp = mgr.paths;
      expect(fs.readFileSync(rp.serverCfg, 'utf8')).toContain('hostname = "Arma 3 Sunucusu";');
      expect(fs.existsSync(rp.basicCfg)).toBe(true);
      expect(fs.existsSync(rp.arma3Profiles[0]!)).toBe(true);
      expect(fs.readFileSync(rp.beCfg, 'utf8')).toContain('RConPassword RconSifresi123');
      await waitFor(() => mgr.getStatus().status === 'running', 5000, 'running');
      await waitFor(() => mgr.getStatus().rcon === 'connected', 5000, 'rcon');
      await waitFor(() => mgr.getLogBuffer().some((l) => l.source === 'server' && l.line.startsWith('FAKE ARMA')), 5000, 'log');
      const first = mgr.getLogBuffer().find((l) => l.line.startsWith('FAKE ARMA'))!.line;
      expect(first).toContain('-mod=@cba_a3');
      expect(first).toContain('-serverMod=@extdb3');
      const pid = mgr.getStatus().pid!;
      await mgr.stop();
      expect(rcon.received).toContain('#shutdown');
      expect(mgr.getStatus().status).toBe('stopped');
      expect(fs.readFileSync(rp.stdoutLog, 'utf8')).toContain('SHUTDOWN');
      expect(await new LocalHost().processInfo(pid)).toMatchObject({ alive: false });
      expect(fs.existsSync(rp.stateFile)).toBe(false);
      expect(statuses.filter((x, i, a) => x !== a[i - 1])).toEqual(['starting', 'running', 'stopping', 'stopped']);
    } finally {
      clearInterval(iv);
    }
  });

  it('RCON yoksa süreci SIGTERM ile kapatır', async () => {
    const { mgr } = await setup({ rcon: { enabled: false } });
    await mgr.start();
    await waitFor(() => mgr.getStatus().status === 'running');
    await mgr.stop();
    expect(fs.readFileSync(mgr.paths.stdoutLog, 'utf8')).toContain('TERM');
  });

  it('çökünce otomatik yeniden başlatır ve Discord\'a bildirir', async () => {
    const events: string[] = [];
    const notifier: Notifier = { notify: async (e) => void events.push(e) };
    const { dir, mgr } = await setup({ notifications: { discordWebhook: 'x' } }, notifier);
    await mgr.start();
    await waitFor(() => mgr.getStatus().status === 'running');
    const firstPid = mgr.getStatus().pid;
    fs.writeFileSync(path.join(dir, 'crash.flag'), '');
    await waitFor(() => mgr.getStatus().autoRestarts === 1 && mgr.getStatus().status === 'running' && mgr.getStatus().pid !== firstPid, 8000, 'restart');
    expect(events).toEqual(['start', 'crash']);
  });

  it('saatte en fazla N çökme: sonra otomatik restart durur', async () => {
    const { dir, mgr } = await setup({ supervisor: { maxRestartsPerHour: 1 } });
    await mgr.start();
    await waitFor(() => mgr.getStatus().status === 'running');
    fs.writeFileSync(path.join(dir, 'crash.flag'), '');
    await waitFor(() => mgr.getStatus().autoRestarts === 1 && mgr.getStatus().status === 'running', 8000, 'restart1');
    fs.writeFileSync(path.join(dir, 'crash.flag'), '');
    await waitFor(() => mgr.getStatus().status === 'crashed', 8000, 'crashed');
    expect(mgr.getStatus().autoRestarts).toBe(1);
  });

  it('headless client\'ları gecikmeyle başlatır, sunucuyla birlikte kapatır', async () => {
    const { mgr } = await setup({ headless: { count: 2, startDelaySec: 0 }, general: { password: 'girissifresi' } });
    await mgr.start();
    await waitFor(() => mgr.getStatus().headless.every((h) => h.alive), 6000, 'hc');
    const hcLog = fs.readFileSync(mgr.paths.headlessStdoutLog(1), 'utf8');
    expect(hcLog).toContain('-client');
    expect(hcLog).toContain('-password=girissifresi');
    await mgr.stop();
    expect(mgr.getStatus().headless.every((h) => !h.alive)).toBe(true);
  });

  it('uygulama yeniden açılınca çalışan sunucuyu bulur (attach)', async () => {
    const { mgr, profile } = await setup({ rcon: { enabled: false } });
    await mgr.start();
    await waitFor(() => mgr.getStatus().status === 'running');
    const pid = mgr.getStatus().pid;
    mgr.dispose();
    managers.splice(managers.indexOf(mgr), 1);
    const mgr2 = new ServerManager({ profile, host: new LocalHost(), timers: { monitorMs: 200, stopTimeoutMs: 3000 } });
    managers.push(mgr2);
    await mgr2.attach();
    expect(mgr2.getStatus()).toMatchObject({ status: 'running', pid });
    await mgr2.stop();
    expect(mgr2.getStatus().status).toBe('stopped');
  });

  it('süreç sorgusu geçici olarak başarısız olursa çöktü sanmaz', async () => {
    const { mgr } = await setup({ rcon: { enabled: false } });
    await mgr.start();
    await waitFor(() => mgr.getStatus().status === 'running');
    const host = mgr.host as LocalHost & { processInfo: LocalHost['processInfo'] };
    const original = host.processInfo.bind(host);
    host.processInfo = async () => {
      throw new Error('tasklist başarısız');
    };
    await sleep(1200);
    expect(mgr.getStatus().status).toBe('running');
    expect(mgr.getStatus().autoRestarts).toBe(0);
    host.processInfo = original;
    await mgr.stop();
  });

  it('engelleyici doğrulama hatasında başlatmaz', async () => {
    const { mgr } = await setup({ rcon: { password: '', enabled: true } });
    await expect(mgr.start()).rejects.toBeInstanceOf(ValidationFailedError);
    expect(mgr.getStatus().status).toBe('stopped');
  });

  it('zamanlı restart: uyarı gönderir, sonra yeniden başlatır', async () => {
    const { mgr, rcon } = await setup({ supervisor: { scheduledRestarts: ['18:00'], warnMinutes: [5, 1], warnMessage: '{minutes} dk sonra restart' } });
    const iv = setInterval(() => {
      if (rcon.received.includes('#shutdown')) {
        rcon.received.splice(rcon.received.indexOf('#shutdown'), 1, '#shutdown-handled');
        fs.writeFileSync(path.join(mgr.paths.serverDir, 'shutdown.flag'), '');
      }
    }, 50);
    try {
      await mgr.start();
      await waitFor(() => mgr.getStatus().status === 'running' && mgr.getStatus().rcon === 'connected', 6000, 'ready');
      const pid = mgr.getStatus().pid;
      await mgr.runSchedulerTick(new Date(2026, 9, 11, 17, 56));
      expect(rcon.received).toContain('say -1 4 dk sonra restart');
      await mgr.runSchedulerTick(new Date(2026, 9, 11, 18, 0, 5));
      expect(rcon.received).toContain('#shutdown-handled');
      await waitFor(() => mgr.getStatus().status === 'running' && mgr.getStatus().pid !== pid, 8000, 'restarted');
    } finally {
      clearInterval(iv);
    }
  });
});

/** Komut satırında verilen metni içeren süreç sayısı */
function countProcs(needle: string): number {
  let n = 0;
  for (const pid of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      if (stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) === 'Z') continue;
      const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ');
      if (cmd.includes(needle) && cmd.includes('arma3server')) n++;
    } catch {
      /* süreç gitti */
    }
  }
  return n;
}

describe('ServerManager: hazır olma, ölümcül hata ve yarış durumları', () => {
  it('config hatasında ("Member already defined") süreç açık kalsa bile çöktü sayar, zorla kapatır, otomatik restart yapmaz', async () => {
    const events: { e: string; d: string }[] = [];
    const notifier: Notifier = { notify: async (e, _t, d = '') => void events.push({ e, d }) };
    const { dir, mgr } = await setup({ rcon: { enabled: false }, notifications: { discordWebhook: 'x' } }, notifier);
    fs.writeFileSync(
      path.join(dir, 'fatal.txt'),
      ['12:00:00 Reading server.cfg', '12:00:00 Loading mission list', `12:00:00 File ${dir}/server.cfg, line 107: .regularCheck: Member already defined.`, ''].join('\n'),
    );
    fs.writeFileSync(path.join(dir, 'noready.flag'), '');
    fs.writeFileSync(path.join(dir, 'ignoreterm.flag'), '');
    const notices: string[] = [];
    mgr.on('notice', (n) => notices.push(n.message.tr));
    await mgr.start();
    const pid = mgr.getStatus().pid!;
    await waitFor(() => mgr.getStatus().status === 'crashed', 8000, 'crashed');
    const st = mgr.getStatus();
    expect(st.lastError).toContain('line 107: .regularCheck: Member already defined.');
    expect(st.lastError).toContain('Reading server.cfg');
    expect(st.autoRestarts).toBe(0);
    expect(await new LocalHost().processInfo(pid)).toMatchObject({ alive: false });
    expect(notices.some((n) => n.includes('Member already defined'))).toBe(true);
    expect(events.map((x) => x.e)).toEqual(['crash']);
    expect(events[0]!.d).toContain('Member already defined');
    await sleep(1000);
    expect(mgr.getStatus().status).toBe('crashed');
    expect(fs.existsSync(mgr.paths.stateFile)).toBe(false);
  });

  it('startTimeoutSec içinde hazır olmazsa kapatır (otomatik restart kapalı: crashed)', async () => {
    const { dir, mgr } = await setup({ rcon: { enabled: false }, supervisor: { startTimeoutSec: 1, autoRestart: false } });
    fs.writeFileSync(path.join(dir, 'noready.flag'), '');
    fs.writeFileSync(path.join(dir, 'ignoreterm.flag'), '');
    await mgr.start();
    const pid = mgr.getStatus().pid!;
    expect(mgr.getStatus().status).toBe('starting');
    await waitFor(() => mgr.getStatus().status === 'crashed', 8000, 'crashed');
    expect(mgr.getStatus().lastError).toMatch(/^Sunucu 1 sn içinde hazır olmadı\nFAKE ARMA/);
    expect(await new LocalHost().processInfo(pid)).toMatchObject({ alive: false });
  });

  it('başlatma zaman aşımı saatlik restart sınırına sayılır', async () => {
    const { dir, mgr } = await setup({ rcon: { enabled: false }, supervisor: { startTimeoutSec: 1, maxRestartsPerHour: 1 } });
    fs.writeFileSync(path.join(dir, 'noready.flag'), '');
    await mgr.start();
    const firstPid = mgr.getStatus().pid;
    await waitFor(() => mgr.getStatus().autoRestarts === 1 && mgr.getStatus().status === 'starting' && mgr.getStatus().pid !== firstPid, 8000, 'restart');
    await waitFor(() => mgr.getStatus().status === 'crashed', 8000, 'crashed');
    expect(mgr.getStatus().autoRestarts).toBe(1);
  });

  it('RCON da log da yoksa eski sabit süreyle "running" olur', async () => {
    const { dir, mgr } = await setup({ rcon: { enabled: false }, launch: { noLogs: true } });
    fs.writeFileSync(path.join(dir, 'noready.flag'), '');
    await mgr.start();
    await waitFor(() => mgr.getStatus().status === 'running', 5000, 'running');
  });

  it('hazır olmadan Discord "başladı" gönderilmez ve HC başlatılmaz', async () => {
    const events: string[] = [];
    const notifier: Notifier = { notify: async (e) => void events.push(e) };
    const { dir, mgr } = await setup(
      { rcon: { enabled: false }, headless: { count: 1, startDelaySec: 0 }, general: { password: 'girissifresi' }, notifications: { discordWebhook: 'x' } },
      notifier,
    );
    fs.writeFileSync(path.join(dir, 'noready.flag'), '');
    await mgr.start();
    await sleep(1500);
    expect(mgr.getStatus().status).toBe('starting');
    expect(events).toEqual([]);
    expect(countProcs(`-profiles=${mgr.paths.headlessProfilesDir(1)}`)).toBe(0);
    // Logda hazır satırı görünce
    fs.appendFileSync(mgr.paths.stdoutLog, '12:00:05 BattlEye Server: Initialized (v1.220)\n');
    await waitFor(() => mgr.getStatus().status === 'running', 5000, 'running');
    expect(events).toEqual(['start']);
    await waitFor(() => mgr.getStatus().headless[0]!.alive, 5000, 'hc');
  });

  it('çökme sonrası bekleme sırasında Durdur basılırsa yeniden başlatmaz', async () => {
    const { dir, mgr } = await setup({ rcon: { enabled: false }, supervisor: { restartDelaySec: 2 } });
    await mgr.start();
    await waitFor(() => mgr.getStatus().status === 'running', 5000, 'running');
    fs.writeFileSync(path.join(dir, 'crash.flag'), '');
    await waitFor(() => mgr.getStatus().status === 'restarting', 5000, 'restarting');
    await mgr.stop();
    expect(mgr.getStatus().status).toBe('stopped');
    await sleep(3000);
    expect(mgr.getStatus().status).toBe('stopped');
    expect(mgr.getStatus().pid).toBeUndefined();
    expect(countProcs(`-profiles=${mgr.paths.profilesDir} `)).toBe(0);
  });

  it('çökme işlenirken (HC kapatılırken) Durdur basılırsa yeniden başlatmaz', async () => {
    const { dir, mgr } = await setup({ rcon: { enabled: false }, headless: { count: 1, startDelaySec: 0 }, general: { password: 'girissifresi' } });
    fs.writeFileSync(path.join(dir, 'hcignoreterm.flag'), '');
    await mgr.start();
    await waitFor(() => mgr.getStatus().headless[0]!.alive, 6000, 'hc');
    fs.writeFileSync(path.join(dir, 'crash.flag'), '');
    // Çökme algılandı, HC kapatılıyor (SIGTERM'e cevap vermediği için stopTimeoutMs kadar sürer)
    await waitFor(() => mgr.getLogBuffer().some((l) => l.line.includes('beklenmedik şekilde kapandı')), 5000, 'crash');
    await mgr.stop();
    expect(mgr.getStatus().status).toBe('stopped');
    await sleep(4000);
    expect(mgr.getStatus().status).toBe('stopped');
    expect(mgr.getStatus().autoRestarts).toBe(0);
    expect(countProcs(`-profiles=${mgr.paths.profilesDir} `)).toBe(0);
  });

  it('HC gecikmesi sırasında çökme: eski zamanlayıcı iptal edilir, çift HC olmaz', async () => {
    const { dir, mgr } = await setup({ rcon: { enabled: false }, headless: { count: 1, startDelaySec: 2 }, general: { password: 'girissifresi' } });
    await mgr.start();
    await waitFor(() => mgr.getStatus().status === 'running', 5000, 'running');
    fs.writeFileSync(path.join(dir, 'crash.flag'), '');
    await waitFor(() => mgr.getStatus().autoRestarts === 1 && mgr.getStatus().status === 'running', 8000, 'restart');
    await waitFor(() => mgr.getStatus().headless[0]!.alive, 6000, 'hc');
    await sleep(2500);
    expect(countProcs(`-profiles=${mgr.paths.headlessProfilesDir(1)}`)).toBe(1);
  });

  it('HC işareti durum dosyasında saklanır; profil yolu değişse de Durdur HC\'yi kapatır', async () => {
    const { dir, mgr, profile } = await setup({ rcon: { enabled: false }, headless: { count: 1, startDelaySec: 0 }, general: { password: 'girissifresi' } });
    await mgr.start();
    await waitFor(() => mgr.getStatus().headless[0]!.alive, 6000, 'hc');
    const state = JSON.parse(fs.readFileSync(mgr.paths.stateFile, 'utf8'));
    const hcDir = mgr.paths.headlessProfilesDir(1);
    expect(state.headless[0]).toMatchObject({ index: 1, marker: `-profiles=${hcDir}` });
    mgr.updateProfile({ ...profile, paths: { ...profile.paths, profilesDir: path.join(dir, 'baska-profil') } });
    await mgr.stop();
    expect(await new LocalHost().processInfo(state.headless[0].pid)).toMatchObject({ alive: false });
    expect(countProcs(`-profiles=${hcDir}`)).toBe(0);
  });

  it('durdururken süreç sorgulanamazsa "durdu" göstermez, durum dosyasını korur', async () => {
    const { mgr } = await setup({ rcon: { enabled: false } });
    await mgr.start();
    await waitFor(() => mgr.getStatus().status === 'running', 5000, 'running');
    const host = mgr.host as LocalHost;
    const original = host.processInfo.bind(host);
    host.processInfo = async () => {
      throw new Error('tasklist başarısız');
    };
    const notices: string[] = [];
    mgr.on('notice', (n) => notices.push(n.message.tr));
    await expect(mgr.stop()).rejects.toThrow(/doğrulanamadı/);
    expect(mgr.getStatus().status).toBe('running');
    expect(mgr.getStatus().pid).toBeDefined();
    expect(fs.existsSync(mgr.paths.stateFile)).toBe(true);
    expect(notices.some((n) => n.includes('doğrulanamadı'))).toBe(true);
    host.processInfo = original;
    await mgr.stop();
    expect(mgr.getStatus().status).toBe('stopped');
  });

  it('makineye ulaşılamıyorsa zamanlı restart ertelenir; restart() önce bağlantıyı doğrular', async () => {
    const { mgr, rcon } = await setup({ supervisor: { scheduledRestarts: ['18:00'], warnMinutes: [5] } });
    await mgr.start();
    await waitFor(() => mgr.getStatus().status === 'running' && mgr.getStatus().rcon === 'connected', 6000, 'ready');
    (mgr as unknown as { unreachable: boolean }).unreachable = true;
    await mgr.runSchedulerTick(new Date(2026, 9, 11, 17, 50));
    await mgr.runSchedulerTick(new Date(2026, 9, 11, 18, 0, 5));
    expect(rcon.received).not.toContain('#shutdown');
    expect(mgr.getLogBuffer().some((l) => l.line.includes('erteleniyor'))).toBe(true);
    expect(mgr.getStatus().status).toBe('running');
    // Bir dakikadan fazla geçti: kaçırıldı olarak loglanır ve sıradakine geçilir
    await mgr.runSchedulerTick(new Date(2026, 9, 11, 18, 2));
    expect(mgr.getLogBuffer().some((l) => l.line.includes('kaçırıldı'))).toBe(true);
    expect(mgr.getStatus().nextScheduledRestart).toBe(new Date(2026, 9, 12, 18, 0).getTime());
    (mgr as unknown as { unreachable: boolean }).unreachable = false;

    const host = mgr.host as LocalHost;
    const connect = host.connect.bind(host);
    host.connect = async () => {
      throw new Error('SSH koptu');
    };
    await expect(mgr.restart({ reason: 'test' })).rejects.toThrow('SSH koptu');
    host.connect = connect;
    expect(rcon.received).not.toContain('#shutdown');
    expect(mgr.getStatus().status).toBe('running');
  });

  it('restart uyarısı gönderilemezse işaretlenmez, sonraki turda tekrar denenir; profil kaydı uyarıları sıfırlamaz', async () => {
    const { mgr, rcon, profile } = await setup({ supervisor: { scheduledRestarts: ['18:00'], warnMinutes: [5], warnMessage: '{minutes} dk' } });
    await mgr.start();
    await waitFor(() => mgr.getStatus().status === 'running' && mgr.getStatus().rcon === 'connected', 6000, 'ready');
    const r = mgr.rcon as unknown as { say: (m: string) => Promise<string> };
    r.say = () => Promise.reject(new Error('RCON yeniden bağlanıyor'));
    await mgr.runSchedulerTick(new Date(2026, 9, 11, 17, 56));
    expect(rcon.received.filter((c) => c.startsWith('say'))).toEqual([]);
    delete (r as { say?: unknown }).say;
    await mgr.runSchedulerTick(new Date(2026, 9, 11, 17, 56, 20));
    expect(rcon.received.filter((c) => c.startsWith('say'))).toEqual(['say -1 4 dk']);
    mgr.updateProfile({ ...profile, name: 'Yeni ad', supervisor: { ...profile.supervisor, warnMessage: 'X {minutes}' } });
    await mgr.runSchedulerTick(new Date(2026, 9, 11, 17, 57));
    expect(rcon.received.filter((c) => c.startsWith('say'))).toEqual(['say -1 4 dk']);
    // Saat değişince sıfırlanır
    mgr.updateProfile({ ...profile, supervisor: { ...profile.supervisor, scheduledRestarts: ['18:01'] } });
    await mgr.runSchedulerTick(new Date(2026, 9, 11, 17, 57));
    expect(rcon.received.filter((c) => c.startsWith('say'))).toEqual(['say -1 4 dk', 'say -1 4 dk']);
  });

  it('çalışırken RCON şifresi değişirse eski şifreyle bağlı kalır, kullanıcıya bildirilir, kapatma nazik olur', async () => {
    const { mgr, rcon, profile, dir } = await setup();
    await mgr.start();
    await waitFor(() => mgr.getStatus().status === 'running' && mgr.getStatus().rcon === 'connected', 6000, 'ready');
    const notices: string[] = [];
    mgr.on('notice', (n) => notices.push(n.message.en));
    mgr.updateProfile({ ...profile, rcon: { ...profile.rcon, password: 'YeniSifre456' } });
    expect(notices.some((n) => n.includes('after the server is restarted'))).toBe(true);
    await sleep(500);
    expect(mgr.getStatus().rcon).toBe('connected');
    const iv = setInterval(() => {
      if (rcon.received.includes('#shutdown')) fs.writeFileSync(path.join(dir, 'shutdown.flag'), '');
    }, 50);
    try {
      await mgr.stop();
    } finally {
      clearInterval(iv);
    }
    expect(rcon.received).toContain('#shutdown');
  });

  it('attach, başlatma sürerken bir şey yapmaz', async () => {
    const { mgr } = await setup({ rcon: { enabled: false } });
    const p = mgr.start();
    await mgr.attach();
    await p;
    await waitFor(() => mgr.getStatus().status === 'running', 5000, 'running');
    await mgr.attach();
    expect(mgr.getStatus().status).toBe('running');
  });

  it('dispose başlatmayı yarıda keser', async () => {
    const { mgr } = await setup({ rcon: { enabled: false } });
    const p = mgr.start();
    mgr.dispose();
    await p;
    await sleep(500);
    const internal = mgr as unknown as { monitorTimer: unknown; direct: unknown };
    expect(internal.monitorTimer).toBeNull();
    expect(internal.direct).toBeNull();
    expect(fs.existsSync(mgr.paths.stateFile)).toBe(false);
  });

  it('Discord bildirimi asılı kalsa da başlat/durdur beklemez', async () => {
    const notifier: Notifier = { notify: () => new Promise<void>(() => undefined) };
    const { mgr } = await setup({ rcon: { enabled: false }, notifications: { discordWebhook: 'x', onStop: true } }, notifier);
    await mgr.start();
    await waitFor(() => mgr.getStatus().status === 'running', 5000, 'running');
    const t0 = Date.now();
    await mgr.stop();
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(mgr.getStatus().status).toBe('stopped');
  });

  it('BattlEye kütüphanesini -bepath klasörüne kopyalar, şifreli dosyaları 0600 yazar', async () => {
    const { dir, mgr } = await setup();
    fs.mkdirSync(path.join(dir, 'battleye'));
    fs.writeFileSync(path.join(dir, 'battleye', 'BEServer_x64.so'), 'be-lib');
    await mgr.deploy();
    const rp = mgr.paths;
    expect(fs.readFileSync(path.join(rp.beDir, 'BEServer_x64.so'), 'utf8')).toBe('be-lib');
    expect(fs.statSync(rp.serverCfg).mode & 0o777).toBe(0o600);
    expect(fs.statSync(rp.beCfg).mode & 0o777).toBe(0o600);
    const copies = () => mgr.getLogBuffer().filter((l) => l.line.startsWith('BattlEye kütüphanesi kopyalandı')).length;
    expect(copies()).toBe(1);
    await mgr.deploy();
    expect(copies()).toBe(1);
  });
});
