import { afterAll, describe, expect, it } from 'vitest';
import { SshHost } from '../src/host/ssh.js';
import { createProfile } from '../src/model/profile.js';
import { ServerManager } from '../src/supervisor/manager.js';

/**
 * systemd modu: gerçek sshd üzerinden root ile bağlanır. Konteynerde systemd PID 1 olmadığı
 * için /usr/local/bin/systemctl yerine minimal bir taklit kullanılır (unit dosyalarını okuyup
 * ExecStart'ı çalıştırır). Böylece unit üretimi, tırnaklama, PartOf ve izleme akışı test edilir.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn: () => boolean | Promise<boolean>, timeoutMs = 10000, label = '') {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await sleep(150);
  }
  throw new Error(`zaman aşımı ${label}`);
}

const AVAILABLE = await (async () => {
  try {
    const h = new SshHost({ id: 'probe', host: '127.0.0.1', port: 2222, username: 'root', password: 'RootTest123!' });
    await h.connect();
    const ok = (await h.exec('sh', ['-c', 'command -v systemctl'])).stdout.includes('/usr/local/bin/systemctl');
    await h.close();
    return ok;
  } catch {
    return false;
  }
})();

const FAKE_ARMA = `#!/bin/bash
echo "FAKE ARMA $*"
[[ "$*" != *-client* ]] && echo "Host identity created."
trap 'echo TERM; exit 0' TERM
while true; do sleep 0.1; done
`;

describe.skipIf(!AVAILABLE)('ServerManager (systemd modu, SSH)', () => {
  const host = new SshHost({ id: 'sd', host: '127.0.0.1', port: 2222, username: 'root', password: 'RootTest123!' });
  const root = `/root/oezi-sd-${Date.now()}`;
  let mgr: ServerManager;

  afterAll(async () => {
    await mgr?.stop().catch(() => undefined);
    mgr?.dispose();
    for (const u of [mgr?.unitName, mgr?.hcUnitName(1), mgr?.hcUnitName(2)]) if (u) await host.remove(`/etc/systemd/system/${u}`).catch(() => undefined);
    await host.remove(root, { recursive: true }).catch(() => undefined);
    await host.close();
  });

  it('unit dosyalarını yazar, systemctl ile başlatır, izler ve PartOf ile birlikte durdurur', async () => {
    await host.connect();
    await host.writeFile(`${root}/server/arma3server_x64`, FAKE_ARMA);
    await host.exec('chmod', ['+x', `${root}/server/arma3server_x64`]);
    const profile = createProfile({
      name: 'Altis Life',
      paths: { serverDir: `${root}/server`, profilesDir: `${root}/profiles` },
      general: { passwordAdmin: 'uzun-admin-sifresi' },
      missions: { rotation: [{ template: 'altislife.altis' }] },
      rcon: { enabled: false },
      headless: { count: 2, startDelaySec: 0 },
      launch: { mods: [{ path: '@cba_a3' }, { path: '@my mod' }] },
    });
    mgr = new ServerManager({ profile, host, timers: { monitorMs: 300, runningAfterMs: 300 } });
    expect(mgr.mode).toBe('systemd');
    await mgr.start();

    const unit = await host.readText(`/etc/systemd/system/${mgr.unitName}`);
    expect(unit).toContain(`ExecStart=${root}/server/arma3server_x64 -port=2302`);
    expect(unit).toContain('"-mod=@cba_a3;@my mod"');
    expect(unit).toContain('Restart=on-failure');
    const hcUnit = await host.readText(`/etc/systemd/system/${mgr.hcUnitName(1)}`);
    expect(hcUnit).toContain(`PartOf=${mgr.unitName}`);
    expect(hcUnit).toContain('-client');

    await waitFor(() => mgr.getStatus().status === 'running', 8000, 'running');
    await waitFor(() => mgr.getStatus().headless.every((h) => h.alive), 8000, 'hc');
    await waitFor(() => mgr.getLogBuffer().some((l) => l.source === 'server' && l.line.includes('"-mod=@cba_a3;@my mod"') === false && l.line.includes('-mod=@cba_a3;@my mod')), 8000, 'log');

    await mgr.stop();
    expect(mgr.getStatus().status).toBe('stopped');
    const st = await host.systemd!.status(mgr.hcUnitName(1));
    expect(st.activeState).toBe('inactive');
  });

  it('headless sayısı azalınca fazla unit dosyasını kaldırır', async () => {
    mgr.updateProfile(createProfile({ ...mgr.getProfile(), headless: { ...mgr.getProfile().headless, count: 1 } }));
    await mgr.deploy();
    expect(await host.exists(`/etc/systemd/system/${mgr.hcUnitName(1)}`)).toBe(true);
    expect(await host.exists(`/etc/systemd/system/${mgr.hcUnitName(2)}`)).toBe(false);
  });

  it('uygulama yeniden açılınca systemd servisinden durumu alır', async () => {
    await mgr.start();
    await waitFor(() => mgr.getStatus().status === 'running', 8000, 'running');
    const m2 = new ServerManager({ profile: mgr.getProfile(), host, timers: { monitorMs: 300 } });
    await m2.attach();
    expect(m2.getStatus().status).toBe('running');
    m2.dispose();
    await mgr.stop();
  });
});
