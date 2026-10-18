import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalHost } from '../src/host/local.js';
import type { UdpPortOwner } from '../src/host/ports.js';
import { createProfile, type ServerProfileInput } from '../src/model/profile.js';
import { type Notice, PortInUseError, ServerManager } from '../src/supervisor/manager.js';
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

/** Sahte Arma: warn.txt varsa içeriğini (Steam/BattlEye uyarıları) yazar, sonra hazır olur. */
const FAKE_ARMA = `#!/bin/bash
echo "FAKE ARMA $*"
dir="$(pwd)"
trap 'echo "TERM"; exit 0' TERM
[ -f "$dir/warn.txt" ] && cat "$dir/warn.txt"
echo "12:00:01 Host identity created."
while true; do sleep 0.1; done
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

type PortQuery = (ports: number[]) => Promise<UdpPortOwner[]>;

async function setup(query: PortQuery | null, input: ServerProfileInput = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oezi-ports-'));
  fs.writeFileSync(path.join(dir, 'arma3server_x64'), FAKE_ARMA, { mode: 0o755 });
  const rcon = new FakeRconServer('RconSifresi123');
  const port = await rcon.start();
  servers.push(rcon);
  rcon.handlers.set('#shutdown', '');
  const profile = createProfile({
    name: 'Test',
    ...input,
    paths: { serverDir: dir },
    general: { passwordAdmin: 'uzun-admin-sifresi' },
    missions: { rotation: [{ template: 'test.altis' }] },
    rcon: { password: 'RconSifresi123', port, connectHost: '127.0.0.1' },
    supervisor: { restartDelaySec: 0, gracefulShutdownSec: 0 },
  });
  const host = new LocalHost();
  const calls: number[][] = [];
  // Gerçek ss/netstat'a gitmesin: testte port sahiplerini biz veriyoruz
  (host as { udpPortOwners?: PortQuery }).udpPortOwners = query
    ? async (ports) => {
        calls.push(ports);
        return query(ports);
      }
    : undefined;
  const mgr = new ServerManager({
    profile,
    host,
    notifier: null,
    timers: {
      monitorMs: 200,
      runningAfterMs: 300,
      rconDelayMs: 100,
      playersMs: 300,
      stopTimeoutMs: 3000,
      schedulerMs: 3_600_000,
      portRecheckMs: 20,
      portRecheckCount: 2,
    },
  });
  const notices: Notice[] = [];
  mgr.on('notice', (n) => notices.push(n));
  managers.push(mgr);
  return { dir, mgr, notices, calls, profile, rconPort: port };
}

describe('başlatmadan önce port kontrolü', () => {
  it('portları başka bir arma3server tutuyorsa başlatmaz, açık bir hata verir (TR/EN)', async () => {
    const { dir, mgr, notices, calls, rconPort } = await setup(async () => [
      { port: 2302, pid: 4242, process: 'arma3server_x64.exe' },
      { port: 2306, pid: 4242, process: 'arma3server_x64.exe' },
    ]);
    const err = await mgr.start().catch((e) => e);
    expect(err).toBeInstanceOf(PortInUseError);
    expect((err as PortInUseError).code).toBe('PORT_IN_USE');
    expect(err.message).toContain('Portlar 2302, 2306 (UDP) kullanımda: arma3server_x64.exe (PID 4242)');
    expect(err.message).toContain('TADST');
    // Oyun portu..+4 ve RCON portu sorulur; çakışma kalırsa 2 kez daha denenir
    expect(calls[0]).toEqual([2302, 2303, 2304, 2305, 2306, rconPort]);
    expect(calls).toHaveLength(3);
    const st = mgr.getStatus();
    expect(st.status).toBe('stopped');
    expect(st.lastError).toContain('arma3server_x64.exe (PID 4242)');
    expect(st.lastErrorEn).toContain('Another Arma 3 server');
    const n = notices.find((x) => x.level === 'error')!;
    expect(n.message.tr).toContain('Sunucu başlatılamadı: Portlar 2302, 2306');
    expect(n.message.en).toContain('Server failed to start: Ports 2302, 2306 (UDP) are in use');
    // Sunucu hiç çalıştırılmadı
    expect(st.pid).toBeUndefined();
    expect(mgr.getLogBuffer().some((l) => l.line.startsWith('Başlatılıyor:'))).toBe(false);
    expect(fs.readdirSync(dir)).toEqual(['arma3server_x64']);
  });

  it('kısa süre sonra boşalan port (az önce kapanan süreç) başlatmayı engellemez', async () => {
    let n = 0;
    const { mgr } = await setup(async () => (n++ === 0 ? [{ port: 2302, pid: 99999 }] : []));
    await mgr.start();
    await waitFor(() => mgr.getStatus().status === 'running', 10000, 'running');
    expect(n).toBe(2);
  });

  it('sorgu başarısız olursa loglanır ve yine de başlatılır', async () => {
    const { mgr } = await setup(async () => {
      throw new Error('ss bulunamadı');
    });
    await mgr.start();
    await waitFor(() => mgr.getStatus().status === 'running', 10000, 'running');
    expect(mgr.getLogBuffer().some((l) => l.source === 'app' && l.line.includes('Port kontrolü yapılamadı') && l.line.includes('ss bulunamadı'))).toBe(true);
  });

  it('host desteklemiyorsa kontrol atlanır', async () => {
    const { mgr } = await setup(null);
    await mgr.start();
    await waitFor(() => mgr.getStatus().status === 'running', 10000, 'running');
  });

  it('restartta kendi (az önce kapatılan) sürecimiz çakışma sayılmaz', async () => {
    let owners: UdpPortOwner[] = [];
    const { mgr } = await setup(async () => owners);
    await mgr.start();
    await waitFor(() => mgr.getStatus().status === 'running', 10000, 'running');
    const oldPid = mgr.getStatus().pid!;
    owners = [{ port: 2302, pid: oldPid, process: 'arma3server_x64' }];
    await mgr.restart();
    await waitFor(() => mgr.getStatus().status === 'running', 10000, 'running after restart');
    expect(mgr.getStatus().pid).not.toBe(oldPid);
    // Uygulamanın kendi süreci (yerel) de sayılmaz
    owners = [{ port: 2302, pid: process.pid, process: 'node' }];
    await mgr.restart();
    await waitFor(() => mgr.getStatus().status === 'running', 10000, 'running after 2nd restart');
  });
});

describe('sunucu logundaki port / Steam uyarıları', () => {
  it('Steam başlatılamadı, BattlEye portu ve Steam sorgu taşması: her biri bir kez uyarılır, sunucu kapatılmaz', async () => {
    const { dir, mgr, notices } = await setup(async () => []);
    const lines = [
      '16:13:39 VoteThreshold must be in 0..1 range. Defaulting to 0.5',
      '16:13:39 Warning Message: Server failed to bind to BattlEye port on 2306, server instead bound to 2318. Clients may not be able to connect to BattlEye!',
      'Initializing Steam server failed',
      'Warning: Steam Query data overflow, Mods/Signatures will not be correctly received by clients. Remove unused mods or change your server configuration to allow for more data to be sent.',
      'Initializing Steam server failed',
      'Warning: Steam Query data overflow, Mods/Signatures will not be correctly received by clients.',
    ];
    fs.writeFileSync(path.join(dir, 'warn.txt'), lines.join('\n') + '\n');
    await mgr.start();
    await waitFor(() => mgr.getStatus().status === 'running', 10000, 'running');
    await waitFor(() => notices.filter((n) => n.level === 'warning').length >= 3, 5000, 'notices');
    await sleep(300);
    const warnings = notices.filter((n) => n.level === 'warning');
    expect(warnings).toHaveLength(3);
    const be = warnings.find((w) => w.message.tr.includes('BattlEye portu'))!;
    expect(be.message.tr).toContain('BattlEye portu 2306 kullanılamadı, sunucu 2318 portuna geçti');
    expect(be.message.en).toContain('BattlEye port 2306 was not available, the server bound to 2318 instead');
    const steam = warnings.find((w) => w.message.tr.includes('Initializing Steam server failed'))!;
    expect(steam.message.tr).toContain('Waiting');
    expect(steam.message.tr).toContain('TADST');
    expect(steam.message.en).toContain('firewall');
    const overflow = warnings.find((w) => w.message.tr.includes('Steam Query data overflow'))!;
    expect(overflow.message.tr).toContain('Steam sorgu veri boyutu');
    expect(overflow.message.tr).toContain('4096');
    expect(overflow.message.en).toContain('4096');
    // Görünür hata metni: son Steam/BattlEye uyarısı (taşma lastError'ı değiştirmez)
    const st = mgr.getStatus();
    expect(st.status).toBe('running');
    expect(st.lastError).toContain('Initializing Steam server failed');
    expect(st.lastErrorEn).toContain('Initializing Steam server failed');
    expect(st.pid).toBeTruthy();
    expect(notices.some((n) => n.level === 'error')).toBe(false);
  });
});
