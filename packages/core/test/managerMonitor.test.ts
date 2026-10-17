import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalHost } from '../src/host/local.js';
import { createProfile, type ServerProfileInput } from '../src/model/profile.js';
import { parsePbo } from '../src/monitor/pbo.js';
import type { MetricSample } from '../src/monitor/metrics.js';
import type { Notifier, NotifyEvent } from '../src/notify/discord.js';
import { type Notice, ServerManager } from '../src/supervisor/manager.js';
import { FakeRconServer } from './fakeRcon.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn: () => boolean | Promise<boolean>, timeoutMs = 10000, label = '') {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await sleep(50);
  }
  throw new Error(`zaman aşımı ${label}`);
}

/** Arma taklidi: hazır olunca @oezi_monitor gibi [OEZI-PERF] satırları yazar (fps.txt varsa oradaki FPS ile). */
const FAKE_ARMA = `#!/bin/bash
echo "FAKE ARMA $*"
dir="$(pwd)"
trap 'echo "TERM"; exit 0' TERM
echo "12:00:01 Host identity created."
while true; do
  fps=48.5
  [ -f "$dir/fps.txt" ] && fps=$(cat "$dir/fps.txt")
  echo '12:00:02 [OEZI-PERF] {"fps":'$fps',"fpsMin":30.0,"players":3,"ai":120,"groups":14,"vehicles":9,"objects":2,"time":61,"mission":"Op \\"Kızıl\\" Şafak","world":"Altis"}'
  sleep 0.2
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

async function setup(input: ServerProfileInput = {}, extra: { notifier?: Notifier } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oezi-mon-mgr-'));
  fs.writeFileSync(path.join(dir, 'arma3server_x64'), FAKE_ARMA, { mode: 0o755 });
  const rcon = new FakeRconServer('RconSifresi123');
  const port = await rcon.start();
  servers.push(rcon);
  const profile = createProfile({
    name: 'Test',
    ...input,
    paths: { serverDir: dir },
    general: { passwordAdmin: 'uzun-admin-sifresi' },
    missions: { rotation: [{ template: 'test.altis' }] },
    rcon: { password: 'RconSifresi123', port, connectHost: '127.0.0.1' },
    supervisor: { restartDelaySec: 0, gracefulShutdownSec: 0 },
  });
  const mgr = new ServerManager({
    profile,
    host: new LocalHost(),
    notifier: extra.notifier ?? null,
    timers: { monitorMs: 200, runningAfterMs: 300, rconDelayMs: 100, playersMs: 300, stopTimeoutMs: 3000, schedulerMs: 3_600_000, perfMs: 300, announceMs: 250 },
  });
  managers.push(mgr);
  return { dir, rcon, mgr };
}

describe('ServerManager performans izleme', () => {
  it('@oezi_monitor yazılır ve -serverMod sonuna eklenir; [OEZI-PERF] satırları loga düşmez, metrics olayı ve status.perf dolar', async () => {
    const { dir, mgr } = await setup({ launch: { serverMods: [{ path: '@extdb3' }] } });
    const samples: MetricSample[] = [];
    mgr.on('metrics', (s) => samples.push(s));
    await mgr.start();
    const pbo = path.join(dir, '@oezi_monitor', 'addons', 'oezi_monitor.pbo');
    expect(parsePbo(fs.readFileSync(pbo)).props.prefix).toBe('oezi_monitor');
    await waitFor(() => mgr.getLogBuffer().some((l) => l.line.startsWith('FAKE ARMA')), 5000, 'log');
    expect(mgr.getLogBuffer().find((l) => l.line.startsWith('FAKE ARMA'))!.line).toContain('-serverMod=@extdb3;@oezi_monitor');
    await waitFor(() => samples.some((s) => s.fps !== undefined && s.cpu !== undefined), 8000, 'metrics');
    const s = samples.find((x) => x.fps !== undefined)!;
    expect(s).toMatchObject({ fps: 48.5, fpsMin: 30, players: 3, ai: 120, groups: 14, vehicles: 9 });
    expect(s.memMB).toBeGreaterThanOrEqual(0);
    expect(mgr.getLastPerf()).toMatchObject({ mission: 'Op "Kızıl" Şafak', world: 'Altis', objects: 2, time: 61 });
    expect(mgr.getStatus().perf).toMatchObject({ fps: 48.5, ai: 120 });
    expect(mgr.getMetrics().length).toBe(samples.length);
    expect(mgr.getMetrics(Date.now() + 1000)).toEqual([]);
    expect(mgr.getLogBuffer().some((l) => l.line.includes('[OEZI-PERF]'))).toBe(false);
    // Kaydet / geri yükle
    const snap = JSON.parse(JSON.stringify(mgr.metricsSnapshot()));
    const m2 = new ServerManager({ profile: mgr.getProfile(), host: new LocalHost(), metrics: snap, timers: { schedulerMs: 3_600_000 } });
    expect(m2.getMetrics().length).toBe(snap.samples.length);
    m2.dispose();
    await mgr.stop();
    expect(mgr.getStatus().perf).toBeUndefined();
  });

  it('kullanıcı listesinde zaten varsa tekrar eklenmez; izleme kapalıysa hiç eklenmez', async () => {
    const a = await setup({ launch: { serverMods: [{ path: '@oezi_monitor' }] } });
    await a.mgr.start();
    await waitFor(() => a.mgr.getLogBuffer().some((l) => l.line.startsWith('FAKE ARMA')), 5000, 'log a');
    expect(a.mgr.getLogBuffer().find((l) => l.line.startsWith('FAKE ARMA'))!.line).toMatch(/-serverMod=@oezi_monitor(\s|$)/);
    const b = await setup({ monitoring: { enabled: false } });
    await b.mgr.start();
    await waitFor(() => b.mgr.getLogBuffer().some((l) => l.line.startsWith('FAKE ARMA')), 5000, 'log b');
    expect(b.mgr.getLogBuffer().find((l) => l.line.startsWith('FAKE ARMA'))!.line).not.toContain('oezi_monitor');
    expect(fs.existsSync(path.join(b.dir, '@oezi_monitor'))).toBe(false);
  });

  it('FPS uyarısı: bildirim (onPerformance) bir kez, düzelince yeniden kurulur', async () => {
    const events: { event: NotifyEvent; title: string }[] = [];
    const notifier: Notifier = { notify: async (event, title) => void events.push({ event, title }) };
    const { mgr } = await setup({ monitoring: { fpsAlertBelow: 15, fpsAlertMinutes: 1 } }, { notifier });
    const notices: Notice[] = [];
    mgr.on('notice', (n) => notices.push(n));
    const check = (t: number, fps: number) => (mgr as unknown as { checkFps(t: number, fps: number): void }).checkFps(t, fps);
    for (let t = 0; t <= 120_000; t += 10_000) check(t, 8);
    const warn = notices.filter((n) => n.level === 'warning');
    expect(warn).toHaveLength(1);
    expect(warn[0]!.message.tr).toContain("FPS'i 1 dakikadır 15 altında");
    expect(warn[0]!.message.en).toContain('below 15 for 1 minutes');
    await sleep(20);
    expect(events).toEqual([{ event: 'performance', title: 'Düşük sunucu FPS' }]);
    for (let t = 130_000; t <= 260_000; t += 10_000) check(t, 40);
    for (let t = 270_000; t <= 340_000; t += 10_000) check(t, 8);
    expect(notices.filter((n) => n.level === 'warning')).toHaveLength(2);
    // onPerformance kapalıysa Discord'a gitmez
    mgr.updateProfile(createProfile({ ...mgr.getProfile(), notifications: { onPerformance: false } }));
    for (let t = 350_000; t <= 480_000; t += 10_000) check(t, 40);
    for (let t = 490_000; t <= 560_000; t += 10_000) check(t, 8);
    await sleep(20);
    expect(notices.filter((n) => n.level === 'warning')).toHaveLength(3);
    expect(events).toHaveLength(2);
  });
});

describe('ServerManager duyurular', () => {
  it('RCON bağlı ve çalışırken sırayla (boşları atlayarak) say -1 gönderir; profil değişince baştan başlar', async () => {
    const { rcon, mgr } = await setup({ announcements: { enabled: true, intervalMin: 1, messages: ['Bir', '  ', 'İki', 'Üç'] } });
    await mgr.start();
    await waitFor(() => mgr.getStatus().rcon === 'connected' && mgr.getStatus().status === 'running', 5000, 'rcon');
    const says = () => rcon.received.filter((c) => c.startsWith('say -1 '));
    await waitFor(() => says().length >= 4, 5000, 'duyurular');
    expect(says().slice(0, 4)).toEqual(['say -1 Bir', 'say -1 İki', 'say -1 Üç', 'say -1 Bir']);
    mgr.updateProfile(createProfile({ ...mgr.getProfile(), announcements: { enabled: true, intervalMin: 1, messages: ['Yeni', 'Diğer'] } }));
    const n = says().length;
    await waitFor(() => says().length >= n + 2, 5000, 'yeni duyurular');
    expect(says().slice(n, n + 2)).toEqual(['say -1 Yeni', 'say -1 Diğer']);
    mgr.updateProfile(createProfile({ ...mgr.getProfile(), announcements: { enabled: false, messages: ['Yeni'] } }));
    await sleep(100);
    const m = says().length;
    await sleep(700);
    expect(says().length).toBe(m);
  });
});
