import { afterEach, describe, expect, it } from 'vitest';
import type { Host, SystemdStatus } from '../src/host/types.js';
import { createProfile, type ServerProfileInput } from '../src/model/profile.js';
import { ServerManager } from '../src/supervisor/manager.js';

/**
 * systemd modu, sahte host ile (SSH/systemd gerekmez): hazır olma, journal --since,
 * ölümcül hata ve HC servislerinin enable/disable edilmesi.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn: () => boolean, timeoutMs = 5000, label = '') {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return;
    await sleep(25);
  }
  throw new Error(`zaman aşımı ${label}`);
}

interface Follow {
  args: string[];
  push: (lines: string[]) => void;
  stopped: boolean;
}

class FakeSystemdHost {
  readonly id = 'fake';
  readonly kind = 'ssh' as const;
  readonly label = 'fake';
  readonly os = 'linux' as const;
  generation = 1;
  files = new Map<string, { data: string; mode?: number }>();
  actions: string[][] = [];
  units = new Map<string, Pick<SystemdStatus, 'activeState' | 'subState' | 'startedAt'>>();
  follows: Follow[] = [];
  /** VPS saati bu bilgisayardan bu kadar ileride */
  remoteOffsetMs = 0;
  readonly systemd = {
    unitPath: (n: string) => `/etc/systemd/system/${n}`,
    writeUnit: async (n: string, c: string) => void this.files.set(`/etc/systemd/system/${n}`, { data: c }),
    removeUnit: async () => undefined,
    daemonReload: async () => undefined,
    action: async (a: string, ...units: string[]) => {
      this.actions.push([a, ...units]);
      for (const u of units) {
        if (a === 'start') this.units.set(u, { activeState: 'active', subState: 'running', startedAt: Date.now() });
        if (a === 'stop') this.units.set(u, { activeState: 'inactive', subState: 'dead', startedAt: 0 });
      }
    },
    startNoBlock: async (...units: string[]) => {
      this.actions.push(['start-no-block', ...units]);
      for (const u of units) this.units.set(u, { activeState: 'active', subState: 'running', startedAt: Date.now() });
    },
    status: async (n: string): Promise<SystemdStatus> => {
      const s = this.units.get(n) ?? { activeState: 'inactive', subState: 'dead', startedAt: 0 };
      return { ...s, mainPid: s.activeState === 'active' ? 1234 : 0, restarts: 0, exists: true };
    },
  };
  async connect() {}
  async close() {}
  isConnected() {
    return true;
  }
  async writeFile(p: string, data: string | Buffer, opts?: { mode?: number }) {
    this.files.set(p, { data: String(data), ...(opts?.mode !== undefined ? { mode: opts.mode } : {}) });
  }
  async mkdirp() {}
  async list() {
    return [];
  }
  async remove() {}
  async exists(p: string) {
    return this.files.has(p);
  }
  async stat() {
    return null;
  }
  async exec() {
    return { code: 1, stdout: '', stderr: 'yok' };
  }
  followCommand(_file: string, args: string[], onLines: (lines: string[]) => void): { stop(): void } {
    const f: Follow = { args, push: onLines, stopped: false };
    this.follows.push(f);
    return { stop: () => void (f.stopped = true) };
  }
  serverFollow(unit: string): Follow | undefined {
    return this.follows.filter((f) => !f.stopped && f.args[1] === unit).pop();
  }
}

class FakeHostWithClock extends FakeSystemdHost {
  async getRemoteTime() {
    return Date.now() + this.remoteOffsetMs;
  }
}

const managers: ServerManager[] = [];
afterEach(() => {
  managers.splice(0).forEach((m) => m.dispose());
});

function make(host: FakeSystemdHost, input: ServerProfileInput = {}) {
  const profile = createProfile({
    name: 'Altis Life',
    paths: { serverDir: '/srv/arma3' },
    general: { passwordAdmin: 'uzun-admin-sifresi' },
    missions: { rotation: [{ template: 'altislife.altis' }] },
    rcon: { enabled: false },
    headless: { count: 2, startDelaySec: 0 },
    ...input,
  });
  const mgr = new ServerManager({ profile, host: host as unknown as Host, timers: { monitorMs: 50, runningAfterMs: 200, schedulerMs: 3_600_000 } });
  managers.push(mgr);
  return mgr;
}

describe('ServerManager (systemd modu, sahte host)', () => {
  it('hazır olana kadar "starting"; journal --since VPS saatiyle; HC\'ler hazır olunca başlar ve servisle birlikte enable edilir', async () => {
    const host = new FakeHostWithClock();
    host.remoteOffsetMs = 10 * 60_000; // VPS saati 10 dk ileride
    const mgr = make(host);
    expect(mgr.mode).toBe('systemd');
    await mgr.start();
    expect(mgr.getStatus().status).toBe('starting');
    expect(host.actions).toContainEqual(['enable', mgr.unitName, mgr.hcUnitName(1), mgr.hcUnitName(2)]);
    expect(host.actions.some((a) => a[0] === 'start-no-block')).toBe(false);
    await waitFor(() => !!host.serverFollow(mgr.unitName), 3000, 'follow');
    const args = host.serverFollow(mgr.unitName)!.args;
    const since = Number(args[args.indexOf('--since') + 1]!.slice(1));
    const expected = Math.floor((mgr.getStatus().startedAt! + host.remoteOffsetMs) / 1000);
    expect(Math.abs(since - expected)).toBeLessThanOrEqual(3);
    await sleep(400);
    expect(mgr.getStatus().status).toBe('starting');
    host.serverFollow(mgr.unitName)!.push(['16:00:00 Host identity created.']);
    expect(mgr.getStatus().status).toBe('running');
    await waitFor(() => host.actions.some((a) => a[0] === 'start-no-block'), 2000, 'hc');
    expect(host.actions.find((a) => a[0] === 'start-no-block')).toEqual(['start-no-block', mgr.hcUnitName(1), mgr.hcUnitName(2)]);
    // server.cfg ve beserver cfg sadece sahibi okuyabilsin
    expect(host.files.get(mgr.paths.serverCfg)?.mode).toBe(0o600);
    expect(host.files.get(mgr.paths.beCfg)?.mode).toBe(0o600);
    await mgr.stop();
    expect(host.actions).toContainEqual(['disable', mgr.unitName, mgr.hcUnitName(1), mgr.hcUnitName(2)]);
    expect(mgr.getStatus().status).toBe('stopped');
  });

  it('servis başka kullanıcıyla çalışıyorsa şifreli dosyalar 0600 yapılmaz', async () => {
    const host = new FakeHostWithClock();
    const profile = createProfile({ name: 'X', paths: { serverDir: '/srv/arma3' }, general: { passwordAdmin: 'uzun-admin-sifresi' }, missions: { rotation: [{ template: 'a.altis' }] }, rcon: { password: 'RconSifresi123' } });
    const mgr = new ServerManager({ profile, host: host as unknown as Host, serviceUser: 'arma', timers: { schedulerMs: 3_600_000 } });
    managers.push(mgr);
    await mgr.deploy();
    expect(host.files.get(mgr.paths.serverCfg)?.mode).toBeUndefined();
  });

  it('uzak saat bilinmiyorsa 120 sn geriden başlar', async () => {
    const host = new FakeSystemdHost();
    const mgr = make(host);
    await mgr.start();
    await waitFor(() => !!host.serverFollow(mgr.unitName), 3000, 'follow');
    const args = host.serverFollow(mgr.unitName)!.args;
    const since = Number(args[args.indexOf('--since') + 1]!.slice(1));
    expect(Math.floor(mgr.getStatus().startedAt! / 1000) - since).toBe(120);
  });

  it('journal\'da ölümcül hata: servisleri durdurur, crashed, otomatik restart yok', async () => {
    const host = new FakeHostWithClock();
    const mgr = make(host);
    await mgr.start();
    await waitFor(() => !!host.serverFollow(mgr.unitName), 3000, 'follow');
    host.serverFollow(mgr.unitName)!.push(['Reading config', 'File /srv/arma3/oezi-profiles/x/server.cfg, line 107: .regularCheck: Member already defined.']);
    await waitFor(() => mgr.getStatus().status === 'crashed', 3000, 'crashed');
    expect(mgr.getStatus().lastError).toBe('Reading config\nFile /srv/arma3/oezi-profiles/x/server.cfg, line 107: .regularCheck: Member already defined.');
    expect(host.actions).toContainEqual(['stop', mgr.unitName, mgr.hcUnitName(1), mgr.hcUnitName(2)]);
    const starts = host.actions.filter((a) => a[0] === 'start').length;
    await sleep(300);
    expect(host.actions.filter((a) => a[0] === 'start').length).toBe(starts);
    expect(mgr.getStatus().status).toBe('crashed');
  });

  it('servis "activating" iken takip edilirse hazır olunca "running" olur', async () => {
    const host = new FakeHostWithClock();
    const mgr = make(host);
    host.units.set(mgr.unitName, { activeState: 'activating', subState: 'start', startedAt: 0 });
    await mgr.attach();
    expect(mgr.getStatus().status).toBe('starting');
    host.units.set(mgr.unitName, { activeState: 'active', subState: 'running', startedAt: Date.now() });
    await sleep(300);
    expect(mgr.getStatus().status).toBe('starting');
    await waitFor(() => !!host.serverFollow(mgr.unitName), 3000, 'follow');
    // takipte --since + -n birlikte: sadece bu çalıştırmanın satırları
    expect(host.serverFollow(mgr.unitName)!.args).toEqual(expect.arrayContaining(['--since', '-n', '300']));
    host.serverFollow(mgr.unitName)!.push(['BattlEye Server: Initialized (v1.220)']);
    expect(mgr.getStatus().status).toBe('running');
  });

  it('RCON da log da yoksa (noLogs) "activating" takibi servis aktif olduktan sonra "running" olur', async () => {
    const host = new FakeHostWithClock();
    const mgr = make(host, { launch: { noLogs: true } });
    host.units.set(mgr.unitName, { activeState: 'activating', subState: 'start', startedAt: 0 });
    await mgr.attach();
    expect(mgr.getStatus().status).toBe('starting');
    host.units.set(mgr.unitName, { activeState: 'active', subState: 'running', startedAt: Date.now() });
    await waitFor(() => mgr.getStatus().status === 'running', 3000, 'running');
  });

  it('başlatma zaman aşımında servis durdurulur ve (açıksa) yeniden başlatılır', async () => {
    const host = new FakeHostWithClock();
    const mgr = make(host, { supervisor: { startTimeoutSec: 1, restartDelaySec: 0, maxRestartsPerHour: 1 } });
    await mgr.start();
    await waitFor(() => mgr.getStatus().autoRestarts === 1, 4000, 'restart');
    await waitFor(() => mgr.getStatus().status === 'crashed', 4000, 'crashed');
    expect(mgr.getStatus().lastError).toMatch(/^Sunucu hazır olmadan 1 sn boyunca log yazmadı/);
    expect(host.actions.filter((a) => a[0] === 'start' && a[1] === mgr.unitName)).toHaveLength(2);
    expect(host.units.get(mgr.unitName)?.activeState).toBe('inactive');
  });
});
