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

/** Arma sunucusu taklidi: argümanları yazar, kontrol dosyalarına göre kapanır/çöker. */
const FAKE_ARMA = `#!/bin/bash
echo "FAKE ARMA $*"
dir="$(pwd)"
trap 'echo "TERM"; exit 0' TERM
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
